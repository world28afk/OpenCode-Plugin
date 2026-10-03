# Desktop 系统托盘注入（右下角通知区域）

`oc-exit-tray.js` 由 `scripts/patch-desktop.mjs` 追加到主进程 `out/main/index.js`，在 **Windows 任务栏右下角通知区域**创建 OpenCode 托盘图标：

- **右键菜单**：
  - `显示 OpenCode` — 显示并激活主窗口
  - `退出 OpenCode` — 彻底退出（结束 `opencode-cli.exe` 含子进程 + 关闭界面）
- **左键 / 双击** — 唤出主窗口
- **关闭主窗口（X）** — 收进托盘（主进程与托盘保留），不再直接退出

## 注入位置

`out/main/index.js`（`package.json` 的 `main`），追加块：

```js
;/* oc-exit:tray:start */
// …创建 Tray / Menu 的片段（desktop/oc-exit-tray.js 内容）…
;/* oc-exit:tray:end */
```

幂等：重复注入会先移除旧块。卸载 `--unpatch` 只移除该块；同时清理早期版本注入到 `out/renderer/index.html` 的角标。

## 用法

```powershell
node scripts/patch-desktop.mjs --dry-run   # 先验证（不改动安装）
# 完全退出 OpenCode Desktop 后:
node scripts/patch-desktop.mjs             # 注入（自动备份 app.asar.oc-exit.bak）
node scripts/patch-desktop.mjs --unpatch   # 只移除本插件注入
node scripts/patch-desktop.mjs --restore   # 还原备份
```

桌面端自动更新会覆盖 app.asar，重新执行注入即可。

## 说明

- 主进程是 ESM，注入片段用动态 `import("electron")`，不依赖打包后的压缩变量名。
- 托盘图标取 asar 内 `resources/icons/icon.ico`（回退 `out/renderer/favicon.ico`），统一缩放到 16×16。
- 退出用独立 `powershell -Command "taskkill /IM opencode-cli.exe /T /F …"`（`detached + unref`），确保后台服务与 MCP 子进程一并结束。
