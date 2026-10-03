// 「彻底退出」命令构造与启动（纯构造器可单测, 启动器副作用隔离）。
//
// 关键点: 关闭界面(X) 只结束渲染进程, 后台服务 opencode-cli.exe 仍常驻。
// 本模块构造一个**独立于服务进程树**的延迟终止脚本, 先关桌面、再结束后台,
// 从而把界面 + 守护进程 + 其 MCP 子进程一并终止。

import { execFileSync, spawn } from "node:child_process"
import { writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export interface QuitOptions {
  /** 关闭桌面界面 OpenCode.exe（含 GPU/renderer 子进程） */
  readonly desktop: boolean
  /** 结束后台服务 opencode-cli.exe（含其子进程树） */
  readonly service: boolean
  /** 额外按命令行清理残留 MCP 进程（/T 通常已覆盖） */
  readonly mcp: boolean
}

export const DEFAULT_QUIT: QuitOptions = { desktop: true, service: true, mcp: false }

export function normalizeQuit(input: unknown): QuitOptions {
  const value = (input ?? {}) as Record<string, unknown>
  return {
    desktop: value.desktop !== false,
    service: value.service !== false,
    mcp: value.mcp === true,
  }
}

/** PowerShell：终止桌面界面与后台服务。先桌面后服务, 顺序避免桌面重启守护进程。 */
export function buildQuitScript(options: QuitOptions = DEFAULT_QUIT): string {
  const lines = ["$ErrorActionPreference='SilentlyContinue'"]
  if (options.desktop) lines.push("taskkill /IM OpenCode.exe /T /F | Out-Null")
  if (options.desktop) lines.push("Start-Sleep -Milliseconds 400")
  if (options.service) lines.push("taskkill /IM opencode-cli.exe /T /F | Out-Null")
  if (options.mcp) {
    lines.push(
      "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'mcp|@modelcontextprotocol|jshook|cyberchef|mcp-server|roxybrowser|ida-mcp|sequential-thinking|deepwiki' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F | Out-Null }",
    )
  }
  lines.push("exit 0")
  return lines.join("\n")
}

/** 把带延迟的终止脚本写入临时 .ps1（避免命令行转义地狱）。 */
export function writeQuitScriptFile(options: QuitOptions, dir: string = tmpdir()): string {
  const path = join(dir, `oc-exit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ps1`)
  const body = [
    "# oc-exit — delayed true-exit",
    "Start-Sleep -Milliseconds 800",
    buildQuitScript(options),
    "Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue",
  ].join("\n")
  writeFileSync(path, body, "utf8")
  return path
}

export interface LaunchResult {
  readonly ok: boolean
  readonly platform: string
  readonly command: string
  readonly error?: string
}

/** 后台启动终止脚本（detached + unref, 不受当前服务进程生命周期约束）。 */
export function launchQuit(options: QuitOptions = DEFAULT_QUIT): LaunchResult {
  try {
    if (process.platform === "win32") {
      const scriptPath = writeQuitScriptFile(options)
      const args = ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", scriptPath]
      const child = spawn("powershell.exe", args, { detached: true, stdio: "ignore", windowsHide: true })
      child.unref()
      return { ok: true, platform: process.platform, command: `powershell.exe ${args.join(" ")}` }
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

/** 把 OpenCode 主窗口显示并激活到前台。 */
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
    const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", buildFocusScript()], {
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
    })
    return { ok: output.includes("focused"), output: output.trim() }
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error) }
  }
}
