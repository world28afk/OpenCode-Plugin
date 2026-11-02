/**
 * oc-exit — 桌面端托盘注入片段（由 scripts/patch-desktop.mjs 追加到 out/main/index.js）。
 *
 * 作用:
 *   · 系统托盘：常驻托盘图标 + 菜单（显示 OpenCode / 退出 OpenCode）
 *   · 关闭窗口（X）→ 收进托盘，不杀进程
 *   · 「退出 OpenCode」= 桌面端本体 + 后台服务 opencode-cli.exe + 其子进程一起收掉
 *
 * 终止策略（2.2.x 修正）:
 *   1) 不再用 taskkill /T。本脚本自身就是被终止进程树的子孙，
 *      /T 会把脚本自己一起杀掉，导致后面的清理逻辑全部丢失。
 *   2) 改为「按镜像名取 PID → Stop-Process -Id 精确终止 → 轮询复查」，
 *      桌面端先关、sidecar 后关，避免桌面端把刚被杀掉的 sidecar 重新拉起。
 *   3) 退出前把终止脚本写成临时 .ps1 再 detached 拉起，主进程先退出也不影响清理。
 *
 * 说明：本文件为 ESM，使用动态 import，避免打包器把 node 内置模块内联。
 */
;(async () => {
  try {
    if (globalThis.__ocExitTrayInstalled) return
    globalThis.__ocExitTrayInstalled = true

    const electron = await import("electron")
    const cp = await import("node:child_process")
    const fs = await import("node:fs")
    const os = await import("node:os")
    const pathMod = await import("node:path")
    const { app, Tray, Menu, nativeImage, BrowserWindow } = electron

    let quitting = false

    // 关闭窗口 → 收进托盘（不结束进程）
    const hookWindow = (win) => {
      try {
        win.on("close", (event) => {
          if (quitting) return
          if (win.isDestroyed && win.isDestroyed()) return
          event.preventDefault()
          try {
            win.hide()
          } catch {
            // ignore
          }
        })
      } catch {
        // ignore
      }
    }
    app.on("browser-window-created", (_event, win) => hookWindow(win))
    try {
      for (const win of BrowserWindow.getAllWindows()) hookWindow(win)
    } catch {
      // ignore
    }

    // 正常退出路径 (应用菜单退出 / 系统关机 / app.quit) 必须先放行,
    // 否则 close 钩子会把窗口藏起来, 应用永远退不掉。
    app.on("before-quit", () => {
      quitting = true
    })
    // 窗口被销毁时不跟随默认行为退出: 托盘要常驻
    app.on("window-all-closed", (event) => {
      if (quitting) return
      try {
        event.preventDefault()
      } catch {
        // ignore
      }
    })

    const showWindow = () => {
      try {
        const wins = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed())
        const win = wins.find((item) => item.isVisible()) ?? wins[0]
        if (!win) return
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      } catch {
        // ignore
      }
    }

    /**
     * 与 .opencode/plugins/oc-exit/src/quit.ts 保持同一套策略。
     * 注意：字符串里一律用正斜杠，避免模板转义问题（PowerShell 接受正斜杠路径）。
     */
    const buildKillerScript = () =>
      [
        "$ErrorActionPreference = 'SilentlyContinue'",
        "$LogPath = Join-Path $env:TEMP 'oc-exit-quit.log'",
        "function Write-OcLog([string]$Message) { try { Add-Content -LiteralPath $LogPath -Value ('[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss.fff'), $Message) -Encoding UTF8 } catch {} }",
        "function Get-OcProc([string[]]$Names) {",
        "  $items = @()",
        "  foreach ($name in $Names) {",
        "    $filter = \"Name='\" + $name + \"'\"",
        "    $items += @(Get-CimInstance Win32_Process -Filter $filter -ErrorAction SilentlyContinue | Select-Object ProcessId, Name)",
        "  }",
        "  return $items",
        "}",
        "$desktopNames = @('OpenCode.exe')",
        "$serviceNames = @('opencode-cli.exe')",
        "Write-OcLog 'quit requested (tray)'",
        "# 给主进程/界面留出收尾时间",
        "Start-Sleep -Milliseconds 400",
        "for ($round = 1; $round -le 20; $round++) {",
        "  $desktop = @(Get-OcProc $desktopNames)",
        "  $service = @(Get-OcProc $serviceNames)",
        "  if ($desktop.Count -eq 0 -and $service.Count -eq 0) { break }",
        "  foreach ($p in $desktop) {",
        "    Write-OcLog ('kill {0} pid={1}' -f $p.Name, $p.ProcessId)",
        "    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue",
        "  }",
        "  Start-Sleep -Milliseconds 300",
        "  foreach ($p in @(Get-OcProc $serviceNames)) {",
        "    Write-OcLog ('kill {0} pid={1}' -f $p.Name, $p.ProcessId)",
        "    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue",
        "  }",
        "  Start-Sleep -Milliseconds 400",
        "}",
        "# 兜底：按镜像名再扫一遍；刻意不用 /T，避免把本脚本自身一起带走",
        "taskkill /IM OpenCode.exe /F 2>$null | Out-Null",
        "taskkill /IM opencode-cli.exe /F 2>$null | Out-Null",
        "# 清掉指向已死进程的 service.json，避免下次启动复用幽灵服务",
        "$statePath = Join-Path $env:USERPROFILE '.local/state/opencode/service.json'",
        "if ((Test-Path -LiteralPath $statePath) -and (@(Get-OcProc $serviceNames).Count -eq 0)) {",
        "  Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue",
        "  Write-OcLog 'removed stale service.json'",
        "}",
        "$leftDesktop = @(Get-OcProc $desktopNames).Count",
        "$leftService = @(Get-OcProc $serviceNames).Count",
        "Write-OcLog ('done; left desktop={0} service={1}' -f $leftDesktop, $leftService)",
        "Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue",
      ].join("\n")

    const quitAll = async () => {
      if (quitting) return
      quitting = true
      try {
        const scriptPath = pathMod.join(os.tmpdir(), `oc-exit-tray-${Date.now()}.ps1`)
        // PowerShell 5.1 对无 BOM 的 UTF-8 按 ANSI 解析，加 BOM 保证注释不乱码
        fs.writeFileSync(scriptPath, "\uFEFF" + buildKillerScript(), "utf8")
        const child = cp.spawn(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            scriptPath,
          ],
          { detached: true, stdio: "ignore", windowsHide: true },
        )
        child.unref()
      } catch (error) {
        try {
          console.error("[oc-exit] failed to spawn quit helper:", error)
        } catch {
          // ignore
        }
      }
      setTimeout(() => {
        try {
          app.exit(0)
        } catch {
          try {
            process.exit(0)
          } catch {
            // ignore
          }
        }
      }, 600)
    }

    const resolveIcon = () => {
      const candidates = []
      try {
        const appPath = app.getAppPath()
        candidates.push(pathMod.join(appPath, "resources", "icons", "icon.ico"))
        candidates.push(pathMod.join(appPath, "out", "renderer", "favicon.ico"))
        candidates.push(pathMod.join(appPath, "out", "renderer", "favicon-v3.ico"))
        candidates.push(pathMod.join(appPath, "out", "renderer", "web-app-manifest-192x192.png"))
        candidates.push(pathMod.join(appPath, "out", "renderer", "favicon-96x96.png"))
      } catch {
        // ignore
      }
      try {
        candidates.push(pathMod.join(process.resourcesPath, "icons", "icon.ico"))
        candidates.push(pathMod.join(process.resourcesPath, "icon.ico"))
        candidates.push(pathMod.join(process.resourcesPath, "..", "icon.ico"))
      } catch {
        // ignore
      }
      try {
        const exeIcon = app.getPath("exe")
        if (exeIcon) candidates.push(exeIcon)
      } catch {
        // ignore
      }
      for (const candidate of candidates) {
        try {
          const image = nativeImage.createFromPath(candidate)
          if (image.isEmpty()) continue
          const sized = image.resize({ width: 16, height: 16 })
          if (!sized.isEmpty()) return sized
          return image
        } catch {
          // try next
        }
      }
      return nativeImage.createEmpty()
    }

    await app.whenReady()

    const icon = resolveIcon()
    // 图标为空时 Electron 仍会创建托盘, 只是不可见; 这里补一个最小占位符避免“看起来没生效”。
    const tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
    tray.setToolTip("OpenCode")
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "显示 OpenCode", click: showWindow },
        { type: "separator" },
        { label: "退出 OpenCode", click: () => void quitAll() },
      ]),
    )
    tray.on("click", showWindow)
    // 双击也能唤醒
    tray.on("double-click", showWindow)
    globalThis.__ocExitTray = { tray, showWindow, quitAll }
    console.info("[oc-exit] tray installed", { iconEmpty: icon.isEmpty() })
  } catch (error) {
    try {
      console.error("[oc-exit] tray injection failed:", error)
    } catch {
      // ignore
    }
  }
})()
