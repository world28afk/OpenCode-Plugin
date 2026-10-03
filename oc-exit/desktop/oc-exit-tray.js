/**
 * oc-exit — 主进程托盘注入片段（由 scripts/patch-desktop.mjs 追加到 out/main/index.js）。
 *
 * 行为：
 *   • 系统托盘（任务栏右下角通知区域）新增 OpenCode 图标
 *   • 右键菜单：显示 OpenCode / 退出 OpenCode
 *   • 关闭主窗口 → 收进托盘（不再直接退出），从而托盘常驻、可随时彻底退出
 *   • 「退出 OpenCode」= 结束后台服务（opencode-cli.exe，含子进程）+ 关闭界面
 *
 * 说明：主进程为 ESM，这里用动态 import；不依赖打包后的压缩变量名。
 */
;(async () => {
  try {
    if (globalThis.__ocExitTrayInstalled) return
    globalThis.__ocExitTrayInstalled = true

    const electron = await import("electron")
    const cp = await import("node:child_process")
    const pathMod = await import("node:path")
    const { app, Tray, Menu, nativeImage, BrowserWindow } = electron

    let quitting = false

    // 关闭窗口 → 收进托盘（保留主进程与托盘）
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

    const quitAll = () => {
      quitting = true
      try {
        const script =
          "Start-Sleep -Milliseconds 300; taskkill /IM opencode-cli.exe /T /F 2>$null | Out-Null; taskkill /IM OpenCode.exe /T /F 2>$null | Out-Null"
        const child = cp.spawn(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script],
          { detached: true, stdio: "ignore", windowsHide: true },
        )
        child.unref()
      } catch {
        // ignore
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
      }, 150)
    }

    const resolveIcon = () => {
      const candidates = []
      try {
        const appPath = app.getAppPath()
        candidates.push(pathMod.join(appPath, "resources", "icons", "icon.ico"))
        candidates.push(pathMod.join(appPath, "out", "renderer", "favicon.ico"))
      } catch {
        // ignore
      }
      try {
        candidates.push(pathMod.join(process.resourcesPath, "icons", "icon.ico"))
      } catch {
        // ignore
      }
      for (const candidate of candidates) {
        try {
          const image = nativeImage.createFromPath(candidate)
          if (!image.isEmpty()) return image.resize({ width: 16, height: 16 })
        } catch {
          // try next
        }
      }
      return nativeImage.createEmpty()
    }

    await app.whenReady()

    const tray = new Tray(resolveIcon())
    tray.setToolTip("OpenCode")
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "显示 OpenCode", click: showWindow },
        { type: "separator" },
        { label: "退出 OpenCode", click: quitAll },
      ]),
    )
    tray.on("click", showWindow)
    // 双击也唤出
    tray.on("double-click", showWindow)
    globalThis.__ocExitTray = { tray, showWindow, quitAll }
    console.info("[oc-exit] tray installed")
  } catch (error) {
    try {
      console.error("[oc-exit] tray injection failed:", error)
    } catch {
      // ignore
    }
  }
})()
