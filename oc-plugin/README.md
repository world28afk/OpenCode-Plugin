# oc-plugin — OpenCode 插件开发与 DSH 迁移文档

本目录是 **OpenCode 插件开发文档中心**，包含两份主文档与配套示例：

| 文档 | 内容 |
| :--- | :--- |
| [docs/opencode-plugin-development.md](docs/opencode-plugin-development.md) | OpenCode V2 插件开发完整指南：加载机制、服务端插件 API、TUI 插件 API、RPC、工具、会话钩子、桌面端 UI 注入、打包发布、测试与排错 |
| [docs/dsh-to-opencode-migration.md](docs/dsh-to-opencode-migration.md) | DeepSeek Harness（DSH / Cordis）插件 → OpenCode 插件迁移指南：概念映射表、逐项改造步骤、真实移植案例（oc-infinite-gen-4 / oc-deepseek-banlance） |
| [examples/](examples/) | 可复制的骨架与最小示例（服务端插件 / TUI 插件 / 桌面注入脚本 / 补丁器） |

## 版本基线

- 目标运行时：**OpenCode V2**（`@opencode/cli` 2.x；桌面端 `opencode-desktop-*` 2.x）。
- 插件包：`@opencode/plugin`（npm，2.x）。
- 本目录文档基于对以下真实环境的实测：
  - OpenCode V2.0.6 独立 CLI 服务器
  - OpenCode Desktop 2.0.22（Electron，`oc://renderer` 自定义协议）
  - opencode-ai 1.18.x（V1 线）的兼容性边界

## 快速导航

- 想开发服务端插件（工具 / 会话钩子 / RPC）→ 开发指南 §3–§7
- 想开发 TUI 界面（状态条 / 面板 / 命令）→ 开发指南 §8
- 想把界面放进 **OpenCode Desktop**（输入框徽章、上下文提示等）→ 开发指南 §9（DOM 注入 + app.asar 补丁工具链）
- 手上有 DSH / Cordis 插件要移植 → 迁移指南（含映射表与检查清单）
- 想看真实成品 → 迁移指南 §5 案例与 `examples/`

## 相关仓库

| 仓库 | 说明 |
| :--- | :--- |
| [world28afk/oc-infinite-gen-4](https://github.com/world28afk/oc-infinite-gen-4) | 案例：DSH 插件移植 + 桌面端输入框运行徽章 |
| [world28afk/oc-deepseek-banlance](https://github.com/world28afk/oc-deepseek-banlance) | 案例：服务端工具/RPC + TUI + 桌面端上下文提示与审查页注入 |
| [Minglink/dsh-infinite-gen-4](https://github.com/Minglink/dsh-infinite-gen-4) | 上游 DSH 插件示例（CC BY-NC-SA 4.0） |

## 许可

文档采用 MIT。文中引用的上游项目内容遵循其各自许可（见对应仓库）。
