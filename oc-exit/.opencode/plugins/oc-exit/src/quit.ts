// 彻底退出控制器（进程编排 + 兜底清理）。
//
// 关键点: 关闭窗口(X) 只隐藏渲染层, 后台服务 opencode-cli.exe 依旧常驻。
// 本模块构造一个**不依赖父进程存活**的延迟终止脚本, 先关桌面端、再关后台,
// 并反复确认直到两类进程都不存在, 从而把界面 + 守护服务 + MCP 子进程一起收掉。
//
// 为什么不用 taskkill /T:
//   1) /T 按父进程树递归, 而终止脚本自身就在被终止的树里 -> 脚本会自杀, 后续清理全部丢失;
//   2) 新版桌面端会按 service.json 复用/重启 sidecar, 只杀一次容易漏;
//   3) /T 不校验结果, 失败静默。
// 因此这里改为: 按镜像名取 PID -> Stop-Process -Id 精确终止 -> 轮询复查 -> 兜底按名再扫。

import { execFileSync, spawn } from "node:child_process"
import { writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export interface QuitOptions {
  /** 关闭桌面端本体 (OpenCode.exe, 含 GPU/renderer 子进程) */
  readonly desktop: boolean
  /** 关闭后台服务 opencode-cli.exe (守护进程/服务端) */
  readonly service: boolean
  /** 额外按命令行匹配收掉 MCP 子进程 */
  readonly mcp: boolean
}

export const DEFAULT_QUIT: QuitOptions = { desktop: true, service: true, mcp: false }

/** 终止脚本的轮询上限: 每轮约 0.7s, 20 轮 ≈ 14s 足够覆盖重启竞态 */
const MAX_ROUNDS = 20

export function normalizeQuit(input: unknown): QuitOptions {
  const value = (input ?? {}) as Record<string, unknown>
  return {
    desktop: value.desktop !== false,
    service: value.service !== false,
    mcp: value.mcp === true,
  }
}

/** PowerShell 延迟终止脚本: 先桌面端、再后台服务, 轮询确认直至干净。 */
export function buildQuitScript(options: QuitOptions = DEFAULT_QUIT): string {
  const desktopNames = options.desktop ? "@('OpenCode.exe')" : "@()"
  const serviceNames = options.service ? "@('opencode-cli.exe')" : "@()"
  const fallback: string[] = []
  if (options.desktop) fallback.push("taskkill /IM OpenCode.exe /F 2>$null | Out-Null")
  if (options.service) fallback.push("taskkill /IM opencode-cli.exe /F 2>$null | Out-Null")
  if (options.mcp) {
    fallback.push(
      "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'mcp|@modelcontextprotocol|jshook|cyberchef|mcp-server|roxybrowser|ida-mcp|sequential-thinking|deepwiki' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>$null | Out-Null }",
    )
  }

  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$LogPath = Join-Path $env:TEMP 'oc-exit-quit.log'",
    "",
    "function Write-OcLog([string]$Message) {",
    "  try { Add-Content -LiteralPath $LogPath -Value ('[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss.fff'), $Message) -Encoding UTF8 } catch {}",
    "}",
    "",
    "function Get-OcProc([string[]]$Names) {",
    "  $items = @()",
    "  foreach ($name in $Names) {",
    "    $filter = \"Name='\" + $name + \"'\"",
    "    $items += @(Get-CimInstance Win32_Process -Filter $filter -ErrorAction SilentlyContinue | Select-Object ProcessId, Name)",
    "  }",
    "  return $items",
    "}",
    "",
    `$desktopNames = ${desktopNames}`,
    `$serviceNames = ${serviceNames}`,
    "",
    "Write-OcLog 'quit requested'",
    "",
    "# 让 RPC 响应先回到界面, 再开始收进程",
    "Start-Sleep -Milliseconds 900",
    "",
    `for ($round = 1; $round -le ${MAX_ROUNDS}; $round++) {`,
    "  $desktop = @(Get-OcProc $desktopNames)",
    "  $service = @(Get-OcProc $serviceNames)",
    "  if ($desktop.Count -eq 0 -and $service.Count -eq 0) { break }",
    "",
    "  # 先关桌面端: 否则它会把刚被杀掉的 sidecar 重新拉起来",
    "  foreach ($p in $desktop) {",
    "    Write-OcLog ('kill {0} pid={1}' -f $p.Name, $p.ProcessId)",
    "    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue",
    "  }",
    "  Start-Sleep -Milliseconds 300",
    "",
    "  foreach ($p in @(Get-OcProc $serviceNames)) {",
    "    Write-OcLog ('kill {0} pid={1}' -f $p.Name, $p.ProcessId)",
    "    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue",
    "  }",
    "  Start-Sleep -Milliseconds 400",
    "}",
    "",
    "# 兜底: 按镜像名再扫一遍; 刻意不用 /T, 避免把本脚本自身一起带走",
    ...fallback,
    "",
    "# 清掉指向已死进程的 service.json, 避免下次启动复用幽灵服务",
    "$statePath = Join-Path $env:USERPROFILE '.local/state/opencode/service.json'",
    "if ((Test-Path -LiteralPath $statePath) -and (@(Get-OcProc $serviceNames).Count -eq 0)) {",
    "  Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue",
    "  Write-OcLog 'removed stale service.json'",
    "}",
    "",
    "$leftDesktop = @(Get-OcProc $desktopNames).Count",
    "$leftService = @(Get-OcProc $serviceNames).Count",
    "Write-OcLog ('done; left desktop={0} service={1}' -f $leftDesktop, $leftService)",
    "",
    "Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue",
  ].join("\n")
}

/** 把延迟终止脚本写到临时 .ps1 并返回路径。 */
export function writeQuitScriptFile(options: QuitOptions, dir: string = tmpdir()): string {
  const path = join(dir, `oc-exit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ps1`)
  const body = [
    "# oc-exit - delayed true-exit",
    "Start-Sleep -Milliseconds 800",
    buildQuitScript(options),
  ].join("\n")
  // PowerShell 5.1 对无 BOM 的 UTF-8 按 ANSI 解析, 注释里的中文会乱码; 加 BOM 保证一致
  writeFileSync(path, "\uFEFF" + body, "utf8")
  return path
}

export interface LaunchResult {
  readonly ok: boolean
  readonly platform: string
  readonly command: string
  readonly script?: string
  readonly error?: string
}

/** 后台拉起终止脚本 (detached + unref), 不受当前进程退出影响。 */
export function launchQuit(options: QuitOptions = DEFAULT_QUIT): LaunchResult {
  try {
    if (process.platform === "win32") {
      const scriptPath = writeQuitScriptFile(options)
      const args = [
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
      ]
      const child = spawn("powershell.exe", args, { detached: true, stdio: "ignore", windowsHide: true })
      child.unref()
      return { ok: true, platform: process.platform, command: `powershell.exe ${args.join(" ")}`, script: scriptPath }
    }
    const targets = [options.desktop ? "OpenCode" : null, options.service ? "opencode-cli" : null].filter(Boolean).join("|")
    const sh = `sleep 0.8; pkill -f '${targets}' || true`
    const child = spawn("sh", ["-c", sh], { detached: true, stdio: "ignore" })
    child.unref()
    return { ok: true, platform: process.platform, command: sh }
  } catch (error) {
    return { ok: false, platform: process.platform, command: "", error: error instanceof Error ? error.message : String(error) }
  }
}

/** 把 OpenCode 主窗口显示并带到前台。 */
export function buildFocusScript(): string {
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    "Add-Type -Namespace OcExit -Name Win -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd); [DllImport(\"user32.dll\")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);'",
    "$p = Get-Process -Name OpenCode -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1",
    "if ($p) { [OcExit.Win]::ShowWindowAsync($p.MainWindowHandle, 9) | Out-Null; [OcExit.Win]::SetForegroundWindow($p.MainWindowHandle) | Out-Null; Write-Output 'focused' } else { Write-Output 'no-window' }",
  ].join("\n")
}

export function focusWindow(): { ok: boolean; output: string } {
  try {
    if (process.platform !== "win32") return { ok: false, output: "focus 仅支持 Windows" }
    const output = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", buildFocusScript()],
      { encoding: "utf8", timeout: 10000, windowsHide: true },
    )
    return { ok: output.includes("focused"), output: output.trim() }
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error) }
  }
}
