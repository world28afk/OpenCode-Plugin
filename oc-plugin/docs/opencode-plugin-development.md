# OpenCode V2 插件开发完整指南

> 目标运行时：**OpenCode V2**（`@opencode/cli` 2.x / `opencode-desktop-*` 2.x）。
> 插件包：`@opencode/plugin`（npm 2.x）。本文中的 API 形状均来自该包的类型定义与真实运行验证。

---

## 1. 概览

OpenCode 插件是一个 **TypeScript/JavaScript 模块**，通过默认导出向宿主注册能力。存在两个运行时半体：

| 半体 | 入口 | 能力 |
| :--- | :--- | :--- |
| **服务端插件** | `@opencode/plugin`（默认导出 `{ id, setup }`） | 工具、会话钩子、RPC、存储、模型/Provider/Agent/Command/Skill/MCP/权限/VCS 等域的变换 |
| **TUI 插件** | 包导出 `./tui`（`@opencode/plugin/tui`） | 终端 UI：状态条、面板、路由、对话框、命令与键位 |
| 桌面端 / Web UI | **无官方插件 UI 接口** | 只能通过 DOM 注入 + `app.asar` 补丁扩展（见 §9） |

插件的定位是「宿主进程内的扩展」：
- 服务端插件运行在 OpenCode 后台服务中（拥有 fs/网络/工具执行能力）；
- TUI 插件运行在终端客户端中；
- 桌面端是 Electron + Web UI，服务端插件对桌面端**同样生效**（同一服务端），但界面扩展需要 §9 的方法。

### 1.1 版本边界（重要）

- 使用 **V2**（2.x）。V2 文档：<https://opencode.ai/v2/docs/>。
- `opencode-ai` 1.18.x 是 V1 线：其插件引擎能加载 `{ id, setup }` 模块，但 Context 缺少 `session`/`tool`/`rpc` 等域，
  遇到这类插件会执行 `setup` 并抛错或无事发生。**健壮的插件必须做能力探测降级**（§3.3）。
- V1 → V2 迁移参考：<https://opencode.ai/v2/docs/migrate-v1>。

---

## 2. 快速开始

### 2.1 目录布局（本地插件）

```
my-plugin/                              # 你的仓库
└── .opencode/plugins/my-plugin/        # 插件包（自动发现）
    ├── package.json                    # 包元数据与 exports
    ├── index.ts                        # 默认导出 { id, setup }（目录解析兜底入口）
    └── src/
        ├── index.ts                    # 实际入口
        ├── mount.ts                    # 挂载逻辑（可单测）
        └── ...
```

加载方式（任选其一）：

1. **自动发现**：把插件包目录放在 `<项目>/.opencode/plugins/<name>/`，或全局 `~/.config/opencode/plugins/<name>/`。
2. **配置引用**（发布到 npm 后）：`opencode.jsonc` 中 `"plugins": ["opencode-acme-plugin"]`，
   或对象形式 `{ "package": "...", "options": { ... } }`。

> 实测注意：2.0.x 对**本地路径**的 `plugins: ["./…"]` 支持不稳定；本地目录优先用 `.opencode/plugins/` 自动发现。

### 2.2 最小服务端插件

```ts
// src/index.ts
import type { Plugin } from "@opencode/plugin"
import { mount, PLUGIN_ID } from "./mount"

export default { id: PLUGIN_ID, setup: mount } satisfies Plugin.Plugin
```

```ts
// src/mount.ts
import type { Plugin } from "@opencode/plugin"

export const PLUGIN_ID = "acme-plugin"
export const PLUGIN_VERSION = "0.1.0"

export async function mount(ctx: Plugin.Context) {
  const off = await ctx.session.hook("context", (event) => {
    event.system.push({ type: "text", text: "You are running with ACME enabled." })
  })
  return async () => {
    await off.dispose()
  }
}
```

要点：
- `Plugin.define({...})` 在运行时是 **identity**（仅类型辅助）。为了兼容性，也可以直接导出 `{ id, setup }` 纯对象。
- `setup` 返回清理函数；卸载时宿主也会自动 dispose 已注册的 hook/工具/RPC。
- `@opencode/plugin` 建议只作为 **`import type`** 使用（编译期擦除），运行时零外部依赖，
  这样在旧运行时/不同打包方式下都能加载（配合 §3.3 降级）。

### 2.3 最小 TUI 插件

```tsx
// tui.tsx
/** @jsxImportSource @opentui/solid */
import { Plugin, usePlugin } from "@opencode/plugin/tui"

function Badge() {
  const context = usePlugin()
  return <text fg={context.theme.text.feedback.success.base}>ACME 运行中</text>
}

export default Plugin.define({
  id: "acme-plugin.tui",
  setup(context) {
    return context.ui.slot({ append: "prompt.footer.status", render: () => <Badge /> })
  },
})
```

### 2.4 package.json

```json
{
  "name": "opencode-acme-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts",
    "./rpc": "./src/rpc.ts",
    "./tui": "./src/tui.tsx",
    "./package.json": "./package.json"
  },
  "files": ["src", "index.ts", "tui.tsx"],
  "engines": { "opencode": ">=2.0.0" },
  "devDependencies": { "@opencode/plugin": "^2.0.22" },
  "peerDependencies": {
    "@opentui/core": ">=0.5.14",
    "@opentui/solid": ">=0.5.14",
    "solid-js": ">=1.9.0"
  },
  "peerDependenciesMeta": {
    "@opentui/core": { "optional": true },
    "@opentui/solid": { "optional": true },
    "solid-js": { "optional": true }
  }
}
```

- `exports."."` 服务端入口；`exports."./tui"` TUI 半体（自动加载）；`exports."./rpc"` 可选（供其它插件/客户端只导入 RPC 契约）。
- 运行时零依赖的插件不需要把 `@opencode/plugin` 放进 `dependencies`；放 `devDependencies` 供类型检查即可。

---

## 3. 服务端插件 API

### 3.1 Context 一览

`setup(ctx)` 中的 `ctx` 是「服务端客户端 + 插件专用能力」：

| 域 | 用途 |
| :--- | :--- |
| `ctx.app` / `ctx.location` / `ctx.options` | 应用元数据、当前 location（`directory`/`project`）、插件选项 |
| `ctx.session` | 会话读写 + **会话钩子**（context/prompt/compaction/title/…） |
| `ctx.tool` | 工具注册（transform）+ `execute.before/after` 钩子 |
| `ctx.rpc` | 注册 RPC 方法/事件（可经 HTTP 调用） |
| `ctx.storage` | 插件私有持久化 JSON |
| `ctx.event` | 订阅服务端事件流 |
| `ctx.agent` `ctx.command` `ctx.model` `ctx.provider` `ctx.skill` `ctx.reference` `ctx.mcp` | 注册/修改对应域（transform + reload） |
| `ctx.integration` | 集成与凭据（key/oauth/command） |
| `ctx.permission` | 权限规则与 evaluate 钩子 |
| `ctx.shell` | shell 命令修改钩子（create.before） |
| `ctx.vcs` `ctx.worktree` `ctx.websearch` `ctx.aisdk` `ctx.experimental` | 其它扩展面 |

> 完整类型以 `@opencode/plugin` 的 `.d.ts` 为准（`dist/promise/*.d.ts`）。

### 3.2 生命周期

```ts
export default Plugin.define({
  id: "acme",
  async setup(ctx) {
    const registration = await ctx.session.hook("context", () => {})
    // 可选：返回清理函数（卸载时调用；注册对象也会被自动 dispose）
    return async () => {
      await registration.dispose()
    }
  },
})
```

### 3.3 能力探测与降级（强烈建议）

不同运行时（尤其是 V1 线的预览内核）提供的域不同。挂载前检测所需能力，缺失时静默降级：

```ts
function hasFunction(value: unknown, key: string): boolean {
  return !!value && typeof (value as Record<string, unknown>)[key] === "function"
}

export async function mount(ctx: Plugin.Context) {
  const canHook = hasFunction(ctx.session, "hook")
  const canTool = hasFunction(ctx.tool, "transform")
  const canRpc = hasFunction(ctx.rpc, "register")

  if (canHook) {
    /* 注册会话钩子 */
  }
  if (canTool) {
    /* 注册工具 */
  }
  if (canRpc) {
    try {
      /* 注册 RPC */
    } catch (error) {
      console.warn("[acme] rpc register failed:", error) // 一次告警, 便于诊断
    }
  }
  return async () => {
    /* 依次 dispose */
  }
}
```

### 3.4 工具（Tools）

```ts
await ctx.tool.transform((editor) => {
  editor.add({
    name: "acme_balance",                     // 有效名: 可带 namespace (ns 工具会成为 ns_name)
    description: "查询 ACME 账户余额",
    input: {
      type: "object",
      properties: { refresh: { type: "boolean", description: "强制刷新" } },
      additionalProperties: false,
    },
    execute: async (input, context) => {
      await context.progress({ status: "查询中" })   // 可选: 进度
      const data = await doWork(input, { signal: context.signal }) // 传入 signal, 支持取消
      return { content: JSON.stringify(data, null, 2), metadata: { ok: true } }
    },
    // options: { namespace: "acme", codemode: true }  // 可选
  })
})
```

- 返回 `{ content }`（字符串或 `Tool.Content[]` 数组）、可选 `metadata`、`output`。
- `input` 支持 JSON Schema；如需 Zod/Effect Schema 也可（Standard Schema 兼容）。
- 更新/删除：`editor.update("acme_balance", (t) => { t.description = "..." })`、`editor.remove("acme_balance")`。
- 同名工具后注册者覆盖；新模型请求才会看到变更（快照语义）。
- 钩子：`ctx.tool.hook("execute.before", (e) => { ... })` / `"execute.after"`。

### 3.5 会话钩子（Session hooks）

各请求类型有独立钩子：`context`（主循环）、`compaction`（总结）、`generate`（`ctx.session.generate`）、`title`（标题生成）、
`prompt`（用户提交入场）、`model.request` / `http.request` / `http.response`（请求/响应改写）、`retry`（重试策略）。

**注入系统提示词（最常用）**：

```ts
await ctx.session.hook("context", (event) => {
  // event.system: Array<SystemPart>，每次模型调用重新组装
  event.system.push({ type: "text", text: "SYSTEM KERNEL ...", metadata: { source: "acme", slot: "core" } })
  event.options.temperature = 0.2          // 生成参数覆盖
  delete event.tools.write                  // 可屏蔽工具
})
```

- 钩子每次请求都会运行（含工具续跑）；只影响本次出站请求，不改持久化历史。
- `compaction` 可用 `event.result = { summary }` 直接提供总结跳过模型调用；`title` 同理 `event.result = "标题"`。
- `prompt` 钩子用于改写用户输入（附件/技能/交付模式），不能重定向会话。

### 3.6 RPC（插件自定义 HTTP 接口）

**这是把数据暴露给 TUI / 桌面注入脚本 / 其它客户端的标准方式。**

```ts
// src/rpc.ts — Rpc.define 同样是 identity, 可纯对象定义
export const RPC_ID = "acme.balance.v1"        // ⚠️ 不要包含 "/" (见 §10)
const looseObject = { type: "object", additionalProperties: true } as const

export const AcmeBalance = {
  id: RPC_ID,
  methods: {
    get: {
      input: { type: "object", additionalProperties: false, properties: { refresh: { type: "boolean" } } },
      output: looseObject,
    },
  },
  events: { updated: { schema: looseObject } },   // 事件 schema 必须是 object 类型
} as const
```

```ts
// 注册
const registration = await ctx.rpc.register(AcmeBalance, {
  get: async (input, context) => {
    // context.signal / context.error("not_found", "...", data)
    return snapshot
  },
})
// 广播事件
await registration.events.emit("updated", snapshot)
```

**HTTP 调用**（已实测）：

```text
POST /api/rpc/{rpcID}/{method}
Content-Type: application/json
{ "input": { ... } }                       # 输入必须包在 input 字段里
→ 200 { "output": { ... } }                # 输出在 output 字段里
```

```bash
curl -u "opencode:<service-password>" --json '{"input":{}}' \
  http://127.0.0.1:<port>/api/rpc/acme.balance.v1/get
```

- `service-password` 位于 `~/.config/opencode/service.json`；`opencode api` 命令自动处理认证。
- 客户端 SDK 用法：`client.rpc(AcmeBalance).get({...})`；事件：`events.on("updated", cb)`。
- 客户端调用时建议带 `location`（query `location`），服务端会按 location 解析插件。

### 3.7 存储

```ts
await ctx.storage.set("snapshot", value)   // 任意 JSON
const cached = await ctx.storage.get("snapshot")
await ctx.storage.remove("snapshot")
const page = await ctx.storage.scan({ prefix: "cache/", limit: 100 })
```

用途：缓存（TTL 数据）、插件设置、跨调用的状态。

### 3.8 其它域（速查）

- `ctx.model.transform` / `ctx.provider.transform`：模型/Provider 列表与参数（含自定义 Provider）。
- `ctx.agent.transform`、`ctx.command.transform`、`ctx.skill.transform`、`ctx.reference.transform`、`ctx.mcp.transform`：
  注册或修改对应资源；改动后调用对应 `reload()`。
- `ctx.integration.*`：连接外部服务（API key / OAuth / 命令行）。
- `ctx.permission.hook("evaluate", ...)`：在权限决策后复查（可改 effect）。
- `ctx.websearch.transform`：自定义搜索 Provider。

---

## 4. 事件

```ts
const controller = new AbortController()
void (async () => {
  for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
    if (event.type === "session.idle") { /* ... */ }
  }
})()
return () => controller.abort()
```

- 事件是「服务端事件流」（`GET /api/event`）。常见事件：`session.*`、`message` 相关、`permission.asked`、`mcp.status.changed` 等。
- TUI 侧用 `context.data.listen(...)` / `context.data.on(type, cb)` 订阅（含本地缓存失效）。

---

## 5. 插件选项

配置对象形式传入：

```jsonc
{
  "plugins": [
    { "package": "opencode-acme-plugin", "options": { "dualLayer": true, "ttlMs": 60000 } }
  ]
}
```

```ts
const options = ctx.options ?? {}
const ttlMs = typeof options.ttlMs === "number" ? options.ttlMs : 60_000
```

目录发现加载时使用默认值。

---

## 6. 打包与发布

```bash
npm publish            # 或私有 registry / git 包
opencode plugin add opencode-acme-plugin@1.0.0
opencode plugin list / check / update / remove
```

- 也可以 `opencode plugin add github:user/repo#main` 或 `'github:user/mono#main::path:packages/plugin'`。
- 发布包包含 `exports` 与 `files`；`engines.opencode` 声明兼容版本。
- 桌面端内置 CLI：`%APPDATA%\ai.opencode.desktop\cli\<ver>\opencode-cli.exe`（可用其 `plugin`/`service`/`api` 子命令）。

---

## 7. 测试与验证

### 7.1 假 Context 冒烟（bun test）

不需要宿主，直接构造一个最小假 `ctx` 驱动 `mount()`：

```ts
import { test, expect } from "bun:test"
import { mount } from "../src/mount"

function makeContext(options = {}) {
  const hooks: any[] = []
  const tools: any[] = []
  const ctx = {
    options,
    session: { hook: async (name, cb) => { const e = { name, cb, disposed: false }; hooks.push(e); return { dispose: async () => { e.disposed = true } } } },
    tool: { transform: async (cb) => { cb({ add: (t) => tools.push(t), list: () => tools, get: () => undefined, namespace() {}, update() {}, remove() {} }); return { dispose: async () => {} } } },
    rpc: { register: async () => ({ dispose: async () => {}, events: { emit: async () => {} } }) },
  }
  return { ctx: ctx as any, hooks, tools }
}

test("mount registers hook + tool", async () => {
  const { ctx, hooks, tools } = makeContext()
  await mount(ctx)
  expect(hooks).toHaveLength(1)
  expect(tools.map((t) => t.name)).toEqual(["acme_balance"])
})
```

网络请用假 `fetch`（保存并在 afterAll 还原 `globalThis.fetch`）。

### 7.2 确定性回归脚本（verify.mjs）

推荐组合（两个真实插件都在用）：
1. 文件/哈希断言（如内核载荷逐字一致）；
2. `bun build` 语法构建（`--external` 掉宿主依赖）；
3. 纯函数单测（评分器、解析器）；
4. 假 Context 冒烟；
5. 静态挂点检查（`ctx.session.hook` / `ctx.tool.transform` / `ctx.rpc.register` 是否在源码中）。

### 7.3 真实服务器验证

```bash
# 列出插件（需认证; 见 §3.6）
curl -u "opencode:<pwd>" http://127.0.0.1:<port>/api/plugin
# 调用你的 RPC
curl -u "opencode:<pwd>" --json '{"input":{}}' http://127.0.0.1:<port>/api/rpc/<id>/get
```

桌面端场景还可以用「远程调试 + CDP」在真实渲染进程里做端到端断言（见 §9.6）。

---

## 8. TUI 插件

入口：包 `exports["./tui"]`（`@opencode/plugin/tui`，OpenTUI + SolidJS）。

```tsx
/** @jsxImportSource @opentui/solid */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { createMemo, createSignal, onCleanup } from "solid-js"

export default Plugin.define({
  id: "acme.tui",
  setup(context) {
    const [value, setValue] = createSignal<string | null>(null)
    const timer = setInterval(async () => setValue(await pull(context)), 60_000)
    onCleanup(() => clearInterval(timer))

    const offSlot = context.ui.slot({
      append: "prompt.footer.status",
      render: () => <text fg={context.theme.text.base}>{value() ?? "…"}</text>,
    })

    const offKeys = context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            { id: "acme.refresh", title: "刷新 ACME", slash: { name: "acme" },
              run: async () => context.ui.toast.show({ message: "已刷新" }) },
          ],
        }))
        return null
      },
    })

    const offPanel = context.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <Show when={panel.name === "acme.panel"}>…面板内容…</Show>
      ),
    })

    return () => { offSlot(); offKeys(); offPanel() }
  },
})
```

常用面：
- 槽位：`app`、`home.footer(.status)`、`prompt.footer(.status/.file)`、`session.composer.top`、`session.panel`、`sidebar.content/footer`。
- 主题 token：`context.theme.text.base / muted / feedback.success|error|warning.base`。
- 面板：`context.ui.panel.open("acme.panel")`；`PanelInput` 提供 `name/sessionID/width/focus/close`。
- 数据：`context.data.session.message.list(sessionID)`、`context.client`（可用 `client.rpc(...)` 调自己的 RPC）。
- 持久化：`context.storage.store(key, { initial })` / `context.storage.memory(...)`。

---

## 9. 桌面端 / Web UI 注入（无官方 UI 插件接口时的做法）

### 9.1 官方边界

`@opencode/plugin` 的 `Host.Entrypoints` 仅有 `server` / `tui` / `rpc` —— **没有桌面/Web UI 扩展面**。
Desktop 是 Electron + Web UI（SolidJS），界面资源打包在 `resources/app.asar`，通过自定义协议 `oc://renderer/` 加载。

### 9.2 关键机制（实测）

1. **认证自动注入**：Electron main 对「顶层 frame 发往当前服务 origin（`http://127.0.0.1:<port>`）的请求」
   自动附加 `Authorization: Basic opencode:<password>`，并对所有响应强制 CORS 放行。
   → 页面内 `fetch("http://127.0.0.1:<port>/api/rpc/...")` **无需自己处理密钥**。
2. **端口探测**：注入脚本启动时并行探测候选端口（`49374` 为通道默认；可含应用 bootstrap 里的 URL），
   端点用 `GET /api/info`；**401/403 也视为“找到了服务”**（认证可能稍后就绪），失败每 5 秒重试。
3. **页面 CSP**：`connect-src *` 放行外部请求；`script-src 'self'` 允许同源外部脚本（asar 内自带文件），
   但 **禁止页面内 `eval`** —— 注入持久化必须走 §9.4 的脚本文件 + `<script>` 标签。

### 9.3 注入脚本骨架

```js
;(() => {
  if (window.__acmeInjected) return
  const RPC_ID = "acme.balance.v1"
  const MARK = "data-acme-badge"
  let basePromise = null

  async function probeBase() {
    const candidates = ["http://127.0.0.1:49374", "http://127.0.0.1:4096"]
    const attempt = async (base) => {
      const c = new AbortController()
      const t = setTimeout(() => c.abort(), 1500)
      try {
        const r = await fetch(`${base}/api/info`, { cache: "no-store", signal: c.signal })
        return r.ok || r.status === 401 || r.status === 403 ? base : null
      } catch { return null } finally { clearTimeout(t) }
    }
    const hit = (await Promise.all(candidates.map(attempt))).find(Boolean)
    return hit ?? null
  }

  const baseURL = () => (basePromise ??= probeBase())

  async function pull() {
    const base = await baseURL()
    if (!base) { basePromise = null; return null }         // 失败不缓存, 稍后重试
    const r = await fetch(`${base}/api/rpc/${RPC_ID}/get`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: {} }),
    })
    return r.ok ? (await r.json()).output : null
  }

  const render = () => { /* 找到锚点 → 幂等插入/更新 DOM */ }
  const observer = new MutationObserver(() => requestAnimationFrame(render))
  observer.observe(document.body, { childList: true, subtree: true })
  setInterval(async () => { await pull(); render() }, 30_000)
})()
```

要点：
- **幂等**：用标记属性（如 `data-acme-badge`）避免重复插入。
- **重挂**：页面路由切换会重建 DOM，用 `MutationObserver` 自动恢复。
- **多插件共存**：每个插件只加自己的文件与标签，互不干扰。
- **锚点选择**：优先用 `data-component` 属性（如本指南实测的
  `form[data-component="composer"]` = 输入框容器；`[data-component="composer-editor"]` = 可编辑区）。
  找不到时再退化为 class 结构匹配。

### 9.4 app.asar 补丁工具链（持久化）

每个插件自带一个补丁器（Node 脚本），流程：

```text
1. 检测应用是否在运行（默认目标不强制；--app 指定副本时可跳过）
2. npx @electron/asar extract <app.asar> <临时目录>
3. 把注入脚本复制到 out/renderer/，在 out/renderer/index.html 的 </body> 前插入
   <script src="./<插件>.js"></script>（幂等）
4. 首次注入前备份 app.asar → app.asar.<插件>.bak
5. npx @electron/asar pack <临时目录> <app.asar>
6. 校验 asar 列表包含注入文件
```

支持模式：`--dry-run`（打包到临时文件）、`--force`（跳过运行检测）、`--app <path>`（目标副本）、
`--unpatch`（只移除本插件内容）、`--restore`（回滚到备份）。

**自动应用**（关闭 → 打补丁 → 重启）：写一个 PowerShell 脚本，用 `CloseMainWindow()` 优雅关闭
（必要时 `Stop-Process -Force`），调用自己仓库的 `patch-desktop.mjs`，再 `Start-Process` 重启。
建议用 WMI（`Invoke-CimMethod -ClassName Win32_Process -MethodName Create`）以脱离父子关系，
避免宿主进程退出导致脚本中断。

注意事项：
- Windows 下 `app.asar` 被运行中的应用独占，必须先关闭。
- 桌面端**自动更新会覆盖 app.asar**，升级后需重新执行补丁。
- 安装包资源路径：`%LOCALAPPDATA%\Programs\@opencodedesktop\resources\app.asar`。

### 9.5 卸载与还原

- `--unpatch`：移除本插件的 `<script>` 行与脚本文件（**不影响其它插件**）。
- `--restore`：回滚到首次注入前备份（会一并丢弃之后其它插件的注入，慎用）。
- 控制台注入（临时方案）：`Ctrl+Shift+I` → Console → 粘贴脚本；刷新后失效。

### 9.6 验证方法（CDP）

1. 复制一份应用目录，用**测试专用 main 补丁**（自定义 `userData` + 强制 `--remote-debugging-port`）打包测试 asar。
2. 以种子 userData 启动测试副本，`GET http://127.0.0.1:<debugPort>/json/list` 找到 `oc://` 页面。
3. 用 Node 内置 `WebSocket` 发 `Runtime.evaluate`（`awaitPromise: true`）跑断言：
   徽章是否存在/文本/颜色、RPC 状态、注入节点数量。
4. 结束 `taskkill /PID <pid> /T /F`。

> 测试副本必须与真实应用隔离：`userData` 路径不同（否则单实例锁会直接退出），
> 且不要动正式安装目录。

---

## 10. 常见坑与排错

| 症状 | 原因 | 处理 |
| :--- | :--- | :--- |
| RPC 404 `Not Found` | **rpcID 含 `/`**（路径段被拆分） | rpcID 用点号：`acme.balance.v1` |
| RPC 注册静默失效 | register 抛错被 catch | catch 里至少 `console.warn` 一条 |
| 插件加载报 `Plugin must export a default definition with an id and an effect or setup` | 模块没有默认导出或形状不对 | 默认导出 `{ id, setup }` |
| `ctx.session.hook is not a function` | 旧运行时（V1 预览内核）缺少域 | 能力探测降级（§3.3） |
| 热加载不触发 | 文件监视未覆盖/新增文件未订阅 | `touch` 插件文件、`POST /api/location/reload`，或重启服务/应用 |
| 桌面端注入无数据 | 端口探测失败/认证未就绪 | 401 视为找到 + 5s 重试；`setServerBase(...)` 手动指定 |
| 桌面端脚本无法在页面 eval | 页面 CSP 禁 eval | 走 asar `<script src>` 文件方式 |
| 修改 app.asar 失败 | 应用运行中文件被锁 | 先退出应用，或用自动 apply 脚本 |
| 桌面端升级后失效 | 自动更新覆盖 asar | 重新执行补丁（可做成快捷方式/脚本） |
| PowerShell 管道里 `node -e` 转义炸裂 | 引号/反斜杠多层转义 | 把脚本写成文件再执行 |

---

## 11. 参考资料

- V2 文档索引：<https://opencode.ai/v2/llms.txt>
- 插件总览：<https://opencode.ai/v2/docs/build/plugins>
- CLI/TUI 插件：<https://opencode.ai/v2/docs/build/plugins/cli>
- RPC：<https://opencode.ai/v2/docs/build/plugins/rpc>
- 客户端：<https://opencode.ai/v2/docs/build/client>
- `@opencode/plugin`（npm，类型定义最权威）
- OpenAPI（运行中的服务自带）：`GET /openapi.json`（注意有的构建对未知路径回退 SPA）
