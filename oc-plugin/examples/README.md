# examples — 最小骨架

| 文件 | 说明 |
| :--- | :--- |
| [server-minimal.ts](server-minimal.ts) | 最小服务端插件：会话上下文注入 + 工具 + RPC + 存储（单文件） |
| [tui-minimal.tsx](tui-minimal.tsx) | 最小 TUI 插件：状态条 + 斜杠命令 + 会话面板 |
| [desktop-inject-minimal.js](desktop-inject-minimal.js) | 桌面/Web 注入脚本骨架：端口探测 + RPC 取数 + 幂等 DOM 徽章 |
| [patch-desktop-skeleton.mjs](patch-desktop-skeleton.mjs) | app.asar 补丁器骨架（注入/校验/备份思路） |

完整可运行实现请参考：

- [world28afk/oc-infinite-gen-4](https://github.com/world28afk/oc-infinite-gen-4) — 服务端（hook/tool/rpc）+ TUI + 桌面徽章 + 完整补丁器（`--dry-run/--unpatch/--restore`）与自动应用脚本
- [world28afk/oc-deepseek-banlance](https://github.com/world28afk/oc-deepseek-banlance) — 服务端工具/RPC/缓存 + TUI 面板 + 桌面上下文提示与审查页注入

> 使用前请把示例里的 `acme` 前缀替换为你的插件名。
