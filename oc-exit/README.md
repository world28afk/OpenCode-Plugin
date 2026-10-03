# oc-exit

**OpenCode 彻底退出（系统托盘）** — 在 **Windows 任务栏右下角通知区域**（系统托盘）为 OpenCode Desktop 增加一个托盘图标，右键菜单两项：

| 选项 | 行为 |
| :--- | :--- |
| **显示 OpenCode** | 显示并激活 OpenCode 主窗口 |
| **退出 OpenCode** | **彻底退出**：结束后台服务 `opencode-cli.exe`（含其子进程）+ 关闭界面 |

## 为什么需要它

OpenCode 桌面端右上角的 **X 只关闭界面**，后台服务/守护进程仍常驻（`~/.config/opencode/service.json` 对应的 `opencode-cli.exe`）。想彻底关闭只能重启电脑或在任务管理器里手动结束，很麻烦。

本插件把「显示 / 彻底退出」做进系统托盘，一键完成；并让**关闭主窗口时收进托盘**（而不是退出），因此托盘常驻、随时可彻底退出。

## 结构

```
oc-exit/
├── .opencode/plugins/oc-exit/        # 服务端插件（RPC / TUI, 可选）
│   ├── src/{index,mount,rpc,processes,quit}.ts
│   └── tui.tsx                       # TUI: /exit-app
├── desktop/oc-exit-tray.js           # 主进程托盘注入片段（追加到 out/main/index.js）
├── scripts/patch-desktop.mjs · apply-desktop.ps1
├── scripts/verify.mjs · smoke.test.ts
└── README.md · LICENSE (MIT)
```

## 安装

### 1. 服务端插件（可选，提供 RPC 与 TUI `/exit-app`）

```powershell
Copy-Item -Recurse .opencode\plugins\oc-exit "$env:USERPROFILE\.config\opencode\plugins\"
```

RPC：`POST /api/rpc/exit.control/{status|focus|quit}`。

### 2. 托盘注入（核心，需改主进程）

**必须先完全退出 OpenCode Desktop**（含托盘），否则 `app.asar` 被占用无法写入。

```powershell
node scripts/patch-desktop.mjs --dry-run    # 先验证（不改动安装）
node scripts/patch-desktop.mjs              # 注入（备份 app.asar.oc-exit.bak）
node scripts/patch-desktop.mjs --unpatch    # 只移除本插件注入
node scripts/patch-desktop.mjs --restore    # 还原备份

# 一键（关闭→打补丁→重启）：
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/apply-desktop.ps1
```

注入内容：向 `out/main/index.js` 追加一段创建 `Tray` 的片段（标记 `/* oc-exit:tray:start */ … end */`，幂等），并清理早期版本的渲染层角标注入。与其它桌面注入插件（渲染层）**互不影响**。

树中的角标：`oc-exit-tray.js`；卸载：`--unpatch`。

## 行为与边界

- 关闭主窗口 → **收进托盘**（主进程与托盘保持存活），从托盘再「显示」或「退出」。
- 「退出 OpenCode」通过**独立延迟脚本**结束 `opencode-cli.exe`（`/T` 含子进程）后退出界面，避免界面重启守护进程。
- 托盘图标取自 asar 内 `resources/icons/icon.ico`；主进程为 ESM，注入片段用动态 `import()`，不依赖压缩变量名。
- 仅 Windows 托盘（`Tray`）；桌面端自动更新会覆盖 `app.asar`，升级后重新执行注入。

## 回归校验

```powershell
bun scripts/verify.mjs
bun test scripts/smoke.test.ts
```
