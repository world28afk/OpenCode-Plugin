# oc-exit

**OpenCode 彻底退出角标** — 在 OpenCode Desktop / Web UI **右下角**显示一个电源角标，**右键**弹出两个选项：

| 选项 | 行为 |
| :--- | :--- |
| **显示 OpenCode** | 把主窗口显示并激活到前台 |
| **退出 OpenCode** | **彻底退出**：关闭桌面界面（`OpenCode.exe`）+ 结束后台服务（`opencode-cli.exe`）及其子进程 |

## 为什么需要它

OpenCode 桌面端右上角的 **X 只关闭界面**，后台服务进程（`opencode-cli.exe`）仍常驻，且会拉起一批 MCP 子进程。想彻底关闭时，要么重启电脑、要么在任务管理器里手动结束一串进程，很麻烦。

本插件把「显示 / 彻底退出」做成一键：右键角标即可，无需任务管理器。

## 结构

```
oc-exit/
├── .opencode/plugins/oc-exit/
│   ├── package.json           # exports "." / "./rpc" / "./tui"
│   ├── index.ts               # 目录解析兜底入口
│   ├── src/index.ts           # 默认导出 { id, setup }
│   ├── src/mount.ts           # RPC 注册（status / focus / quit）
│   ├── src/rpc.ts             # RPC 契约 exit.control
│   ├── src/processes.ts       # 进程快照与归类（desktop / service / mcp）
│   ├── src/quit.ts            # 退出/聚焦命令构造 + 独立启动
│   └── tui.tsx                # TUI: /exit-app 命令
├── desktop/oc-exit-inject.js  # 右下角角标 + 右键菜单注入
├── scripts/patch-desktop.mjs · scripts/apply-desktop.ps1
├── scripts/verify.mjs · scripts/smoke.test.ts
└── README.md · LICENSE (MIT)
```

## 安装

### 1. 服务端插件（必须，提供 RPC）

```powershell
# 全局（推荐）
Copy-Item -Recurse .opencode\plugins\oc-exit "$env:USERPROFILE\.config\opencode\plugins\"

# 或仅当前项目
Copy-Item -Recurse .opencode\plugins\oc-exit "<项目>\.opencode\plugins\"
```

重启（或热加载）后 RPC 可用：`POST /api/rpc/exit.control/{status|focus|quit}`。

### 2. 桌面角标（二选一）

```powershell
# 方式 A（临时）: 桌面端 Ctrl+Shift+I → Console → 粘贴 desktop/oc-exit-inject.js
# 方式 B（持久化）: 完全退出 OpenCode Desktop 后：
node scripts/patch-desktop.mjs --dry-run    # 先验证（不改动安装）
node scripts/patch-desktop.mjs              # 注入（自动备份 app.asar.oc-exit.bak）
node scripts/patch-desktop.mjs --unpatch    # 只移除本插件注入
node scripts/patch-desktop.mjs --restore    # 还原为注入前备份

# 一键（关闭→打补丁→重启）：
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/apply-desktop.ps1
```

与其它桌面注入插件（如 `oc-plugin-manager` / `oc-infinite-gen-4` / `oc-deepseek-banlance`）**可叠加共存**，各自独立文件与标签，互不影响。

## RPC

| 方法 | 入参 | 说明 |
| :--- | :--- | :--- |
| `exit.control/status` | `{ force? }` | 返回当前 `desktop` / `service` / `mcp` 进程清单与数量 |
| `exit.control/focus` | `{}` | 显示并激活 OpenCode 主窗口（Windows Win32） |
| `exit.control/quit` | `{ dryRun?, desktop?, service?, mcp? }` | 彻底退出；`dryRun:true` 只返回计划。`desktop/service` 默认 true，`mcp` 默认 false（`/T` 通常已覆盖） |

退出由**独立于服务进程树的延迟脚本**执行（`detached + unref`）：先关桌面界面，再结束后台服务，避免界面重启守护进程。

## 选项 / 边界

- `focus` 与 `quit` 依赖 Windows（`taskkill` / `user32.dll`）；非 Windows 平台 `quit` 回退为 `pkill`，`focus` 返回不支持。
- 角标需服务端 RPC 在线才能「彻底退出」；服务未连接时角标呈灰色。
- 桌面端自动更新会覆盖 `app.asar`，升级后重新执行注入即可。

## 回归校验

```powershell
bun scripts/verify.mjs
bun test scripts/smoke.test.ts
```

## 注入后可用 API（控制台）

```js
ocExit.show()                     // 显示/激活窗口
ocExit.quit()                     // 彻底退出
ocExit.refresh()                  // 刷新连接状态
ocExit.setServerBase("http://127.0.0.1:49374")  // 端口探测失败时手动指定
ocExit.destroy()                  // 移除注入
```
