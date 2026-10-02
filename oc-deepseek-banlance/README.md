# oc-deepseek-banlance

**OpenCode DeepSeek 余额插件** — 在 OpenCode Desktop / Web / TUI / Agent 工具中查看当前 DeepSeek API Key 的账户余额。

基于 [DeepSeek 查询余额 API](https://api-docs.deepseek.com/zh-cn/api/get-user-balance)：`GET https://api.deepseek.com/user/balance`。

## 展示位置

| 位置 | 实现 | 验证 |
| :--- | :--- | :--- |
| **桌面端右上角「上下文小圆圈」悬浮提示** | `desktop/oc-balance-inject.js`（DOM 注入，追加「余额 ¥xx.xx」行） | ✅ 桌面端 2.0.22 实测（自动探测端口 + Electron main 自动认证） |
| **审查页（Review）「上下文」页** | 同上（统计网格追加「余额」卡片 + 明细卡） | ✅ 桌面端实测显示「余额 ¥15.xx」+ 明细卡 |
| TUI 状态条「💠 余额 ¥xx.xx」 | `tui.tsx` → `prompt.footer.status` 槽位 | ✅ |
| TUI `/balance` 命令 + 余额面板 | `tui.tsx` → keymap + `session.panel` | ✅ |
| Agent 工具 `deepseek_balance` | `src/mount.ts` → `tool.transform` | ✅ 实测返回真实余额 |
| RPC（供任意客户端） | `POST /api/rpc/deepseek.balance.v1/{get\|refresh}` | ✅ 实测 |
| 实时事件 | SSE `rpc.deepseek.balance.v1.updated` | ✅ |

> 桌面端说明: OpenCode Desktop 是 Electron + Web UI，官方插件 API（`@opencode/plugin` 2.x）没有桌面/Web UI 注入面（`Host.Entrypoints` 仅 server/tui/rpc）。
> 本插件采用「服务端插件 + 轻量 DOM 注入脚本」双轨：数据逻辑全部在服务端插件中（Key 不出服务端）；
> 桌面端渲染进程为 `oc://renderer`，Electron main 会对顶层 frame 发往本机服务地址的请求自动附加 Basic 认证，
> 注入脚本只需自动探测服务端口即可取得数据（探测失败自动重试）。

## 数据流

```
DeepSeek GET /user/balance
        ▲ (Bearer key, 服务端进程内)
┌───────┴──────────────────────────────────────────────┐
│ 服务端插件 src/mount.ts                               │
│  • 60s TTL 缓存 + 并发去重 + 15min 后台刷新            │
│  • deepseek_balance 工具                              │
│  • RPC deepseek.balance.v1 (get/refresh + updated 事件)│
│  • 可选: contextLine 注入一行余额到 system 上下文      │
└───────┬──────────────────────────────────────────────┘
        │ 同源 HTTP (登录态复用, 不暴露 Key)
   ┌────┴─────────────┬───────────────┐
   │ Desktop/Web 注入  │ TUI 插件       │ 其它客户端 (RPC)
   │ 圆圈提示+上下文页  │ 状态条+面板     │
   └──────────────────┴───────────────┘
```

Key 解析优先级（服务端）：插件选项 `apiKey` → 环境变量 `DEEPSEEK_API_KEY` → `~/.local/share/opencode/auth.json`（`deepseek.key`）→ `opencode.json` 中 `provider.ds` / `provider.deepseek` 的 `options.apiKey`（项目 → 全局）。

## 安装

### 1. 服务端插件（必须）

```powershell
# 全局（推荐，所有项目可用）
Copy-Item -Recurse .opencode\plugins\oc-deepseek-banlance "$env:USERPROFILE\.config\opencode\plugins\"

# 或仅当前项目
Copy-Item -Recurse .opencode\plugins\oc-deepseek-banlance "<项目>\.opencode\plugins\"
```

重启（或等待 OpenCode 热加载）后生效。

### 2. 桌面端 UI（可选）

**方式 A — 开发者工具（零风险，立即生效）**：桌面端按 `Ctrl+Shift+I` → Console → 粘贴 `desktop/oc-balance-inject.js` 全部内容 → 回车。
未配置 Key 时执行 `ocDeepSeekBalance.setKey("sk-...")`（一般无需，优先走服务端 RPC）。

**方式 B — 持久化注入（可还原）**：

```powershell
node scripts/patch-desktop.mjs --dry-run   # 先验证（不改动安装）
# 完全退出 OpenCode Desktop（含托盘）后:
node scripts/patch-desktop.mjs             # 注入 app.asar（自动备份 .oc-balance.bak）
node scripts/patch-desktop.mjs --restore   # 一键还原
```

## 插件选项

| 选项 | 默认 | 说明 |
| :--- | :--- | :--- |
| `apiKey` | — | 显式指定 Key（覆盖其它来源） |
| `baseURL` | `https://api.deepseek.com` | 兼容代理/自建端点（自动去 `/v1`） |
| `timeoutMs` | `8000` | 单次请求超时 |
| `ttlMs` | `60000` | 缓存有效期 |
| `refreshMs` | `900000` | 后台刷新间隔（0 = 关闭） |
| `contextLine` | `false` | 每次模型调用向 system 注入一行余额 |
| `tool` | `true` | 是否注册 `deepseek_balance` 工具 |

## 回归校验

```powershell
bun scripts/verify.mjs        # 37 项（布局/静态检查/构建/注入脚本语法/冒烟）
bun test scripts/smoke.test.ts  # 15 项（key 解析/余额解析/缓存/事件/挂载/降级）
```

## 目录结构

```
oc-deepseek-banlance/
├── .opencode/plugins/oc-deepseek-banlance/   # 服务端 + TUI 插件包
│   ├── package.json      # exports "." "."/rpc" "./tui"
│   ├── index.ts          # 目录解析兜底
│   ├── src/
│   │   ├── index.ts      # { id, setup }（运行时零外部依赖）
│   │   ├── mount.ts      # 缓存/工具/RPC/后台刷新/contextLine/降级
│   │   ├── rpc.ts        # RPC 契约 deepseek.balance.v1
│   │   ├── deepseek.ts   # /user/balance 客户端 + 响应解析
│   │   ├── key.ts        # Key 解析（options/env/auth.json/opencode.json + JSONC 解析）
│   │   ├── service.ts    # TTL 缓存 + 去重 + 事件 + seed
│   │   └── format.ts     # 紧凑/详细/上下文行格式化
│   └── tui.tsx           # TUI 状态条 + /balance + 余额面板
├── desktop/oc-balance-inject.js   # 桌面/Web DOM 注入脚本
├── scripts/patch-desktop.mjs      # app.asar 注入/还原
├── scripts/verify.mjs · scripts/smoke.test.ts
└── README.md · LICENSE (MIT)
```

## 参考与致谢

- [CMBill/opencode-provider-balance](https://github.com/CMBill/opencode-provider-balance) — OpenCode TUI 余额插件，参考了其 Key 解析顺序（auth.json → env）与「CNY 优先」的余额选择逻辑。
- [xinkeZhou-byte/dsh-context-ring](https://github.com/xinkeZhou-byte/dsh-context-ring) — DeepSeek Harness 上下文圆环 + 余额插件，参考了「余额常驻上下文圆环/面板」的交互形态（本项目的 OpenCode 版实现）。
- [DeepSeek 查询余额 API 文档](https://api-docs.deepseek.com/zh-cn/api/get-user-balance)。

本仓库为独立实现（MIT），未复制上述项目的代码。

## 许可

本插件代码 MIT（见 [LICENSE](LICENSE)）。DeepSeek 余额接口归 DeepSeek 所有，使用须遵守其服务条款；注入脚本仅读取余额信息并向 DeepSeek 官方端点/本地服务发起请求。
