# DSH 插件 → OpenCode 插件迁移指南

> 适用对象：DeepSeek Harness（DSH，Cordis 架构）插件 → OpenCode V2 插件。
> 本文基于两个真实移植项目：
> - [`world28afk/oc-infinite-gen-4`](https://github.com/world28afk/oc-infinite-gen-4)（上游 `Minglink/dsh-infinite-gen-4`）
> - [`world28afk/oc-deepseek-banlance`](https://github.com/world28afk/oc-deepseek-banlance)
>
> 开发 API 细节见 [opencode-plugin-development.md](opencode-plugin-development.md)。

---

## 1. 两种插件模型对比

| 维度 | DSH（Cordis） | OpenCode V2 |
| :--- | :--- | :--- |
| 模块形状 | `export function apply(ctx, config)` + `export const name/inject` | 默认导出 `{ id, setup(ctx) }`（`Plugin.define` 为类型辅助） |
| 宿主交互 | `ctx.systemPrompt` / `ctx.tools` / `ctx.effect` / `ctx.inject` / 服务名注入 | `ctx.session` / `ctx.tool` / `ctx.rpc` / `ctx.storage` 等域 + `transform`/`hook`/`register` |
| 系统提示词 | `ctx.systemPrompt.section({ name, order, text })` 静态注册 | `ctx.session.hook("context", e => e.system.push(...))` 每次请求注入 |
| 工具 | `ctx.tools.register(tool)` | `ctx.tool.transform(editor => editor.add(tool))` |
| 客户端 UI | `client.js` 通过宿主 slots（如 `conversation.input.dock`）注入 | TUI：`context.ui.slot(...)`；**桌面/Web：无官方接口 → DOM 注入**（§4.4） |
| 数据投影 | `sessionProjections.register(def)` | 纯函数模块（如 `src/armor.ts`）+ TUI/注入脚本自行读取 |
| 宿主补丁 | `cordis.patch.yml` + `scripts/lib/patcher.js`（改宿主文件） | **不需要**（V2 的 hook 每次调用都生效；配置走 `opencode.json(c)`） |
| 模块内插值 | `{{cwd}}` 等模板变量，需转义非法 `{{` | 无模板层，原文注入 |
| 安装 | profile `bundles`/`dependencies` + 重启 Harness | `.opencode/plugins/` 自动发现；或 npm 包 + `plugins` 配置 |
| 权限/声明 | `inject` 服务名数组 | 不需要；按能力探测域是否存在 |

---

## 2. 概念映射表（逐项）

| DSH | OpenCode V2 | 备注 |
| :--- | :--- | :--- |
| `ctx.effect(() => ctx.systemPrompt.section({ name, order, text }))` | `const reg = await ctx.session.hook("context", e => e.system.push({ type: "text", text, metadata: { slot: name, order } }))` | order 保留在 metadata；hook 每次请求运行 |
| `ctx.effect(() => ctx.tools.register(profileTool))` | `await ctx.tool.transform(editor => editor.add({...}))` | 输出 `{ content, metadata }`；工具名生效规则不同（namespace） |
| `ctx.get("sessionProjections")` + `projections.register(def)` | 独立模块（评分器函数）+ 消费方（TUI/注入脚本/工具） | 不再依赖宿主投影总线 |
| `client.js`（浏览器模块加载器 + slots） | `./tui` 导出（TUI）+ `desktop/*-inject.js`（桌面 DOM 注入） | 桌面端需自带补丁工具链 |
| `ctx.inject(["tools"], cb)` | 能力探测 `typeof ctx.tool?.transform === "function"` | 缺失即降级 |
| `cordis.patch.yml`（挂载/覆盖宿主配置） | `opencode.json(c)` 的 `plugins` 配置 | 插件本身不需要改宿主文件 |
| `scripts/lib/patcher.js`（放行/改写宿主源码） | **删除**，不需要 | V2 无 Phase-1 过滤面 |
| `{{...}}` 转义 | **删除** | OpenCode 不做模板插值 |
| `dsh://plugin/install?...` 一键协议 | `opencode plugin add <pkg>` / `.opencode/plugins/` 目录 / 配置引用 | |
| profile `package.json` 的 `bundles`/`dependencies` | `.opencode/plugins/<name>/` 自包含包；或 npm 包 | |
| `package.json` 中的 `dsh` 字段 | 删除；保留 `name/version/exports/files/engines` | |
| 服务端元数据工具（如 `profileTool`） | `tool.transform` + 可选 `ctx.rpc.register` | RPC 可直接被客户端 HTTP 调用 |
| 会话/状态投影的 `wire.viewSchema` | 无对应概念；改为 RPC/工具输出 | |

---

## 3. 迁移流程（7 步）

1. **通读上游插件**，列出三类内容：
   - 内核载荷/文案（纯资产）；
   - 宿主交互点（systemPrompt/tools/projections/config patch…）；
   - 客户端 UI（slots/样式/DOM）。
2. **资产原样保留**：把提示词、词表、评分器常量拷为人类可读文件，
   在其上建立「生成的内联 TS 模块」（避免打包后路径失效）+ 哈希校验。
3. **逐项找 OpenCode 等价面**（用 §2 映射表）；找不到等价面的，设计替代通道：
   - 数据 → 工具 / RPC / storage；
   - UI → TUI slot / 桌面 DOM 注入；
   - 宿主补丁 → 删除。
4. **写成自包含插件包**：
   - 默认导出 `{ id, setup }`；入口只 `import type` 宿主包（运行时零依赖）；
   - `setup` 里做能力探测，缺失域静默降级（兼容旧运行时/其它打包方式）。
5. **客户端半体**：
   - TUI：`./tui`（状态条 / 面板 / 命令）；
   - 桌面：`desktop/<name>-inject.js` + `scripts/patch-desktop.mjs`（独立工具链）。
6. **测试**：
   - 纯函数单测（评分器/解析器）；
   - 假 Context 冒烟（hook/tool/RPC 注册与清理）；
   - 真实服务验证（curl RPC）；桌面注入用测试副本 + CDP 断言（开发指南 §9.6）。
7. **文档与许可**：保留上游署名与协议（如 CC BY-NC-SA 4.0），注明移植差异。

---

## 4. 代码对照（真实示例）

### 4.1 系统提示词注入

```js
// DSH (index.js)
const PROMPT_TEXT = readFileSync(PROMPT_URL, "utf8").replace(/\{\{(?!(?:cwd|model|provider)\}\})/g, "{ {")
ctx.effect(() => ctx.systemPrompt.section({ name: "kernel:core", order: 100, text: PROMPT_TEXT }))
if (DUAL_LAYER_INJECTION) {
  ctx.effect(() => ctx.systemPrompt.section({ name: "kernel:reinforce", order: 200, text: PROMPT41_TEXT }))
}
```

```ts
// OpenCode V2 (src/mount.ts)
export async function mount(ctx: Plugin.Context) {
  const prompts = loadKernelPrompts()
  if (hasFunction(ctx.session, "hook")) {
    await ctx.session.hook("context", (event) => {
      for (const part of buildSystemParts(prompts, { dualLayer, pluginID: PLUGIN_ID })) {
        event.system.push(part)   // SystemPart { type:"text", text, metadata? }
      }
    })
  }
}
```

差异：DSH 的 `order` 是全局 section 排序；OpenCode 无系统段排序概念，push 顺序即拼接顺序，
把 `slot/order` 写进 `metadata` 便于审计。

### 4.2 工具注册

```js
// DSH
ctx.effect(() => { ctx.tools.register(profileTool) })
```

```ts
// OpenCode V2
await ctx.tool.transform((editor) => {
  editor.add({
    name: "infinite_gen4_profile",
    description: "...",
    input: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => ({ content: JSON.stringify(profile(), null, 2) }),
  })
})
```

### 4.3 数据投影（评分器）

```js
// DSH：投影注册
const armorDef = { key: "armor", stateSchema: anySchema, init, apply: armorProjectionApply, wire: {...} }
p.register(armorDef, "infinite-gen-4: armor projection")
```

```ts
// OpenCode：把 apply/init 变成纯函数模块 (src/armor.ts)，
// TUI 状态条与（可选）注入脚本按需读取会话消息并调用 armorScore()/projectMessages()。
export function projectMessages(messages: readonly LooseMessage[]): ArmorState
```

### 4.4 客户端状态条

```js
// DSH client.js：注册到宿主 slot（输入框上方）
ctx.slots.register({ name: "conversation.input.dock", id: "armor", order: 30 }, ArmorDock)
```

```tsx
// OpenCode TUI（./tui 导出）
context.ui.slot({ append: "prompt.footer.status", render: () => <text fg={green}>⚫ 无限四代 v0.4.1</text> })
```

```js
// OpenCode Desktop：无 UI 插件接口 → DOM 注入（锚点来自真实渲染进程实测）
const composer = document.querySelector('[data-component="composer"]')  // 输入框容器
host.insertBefore(badge, composer)                                      // 输入框正上方
// 运行状态经插件 RPC 确认: POST /api/rpc/infinite.gen4.profile/get
```

### 4.5 宿主补丁

```js
// DSH: scripts/lib/patcher.js（把宿主 Phase-1 过滤放行、改 cordis.patch.yml…）
```

```text
// OpenCode：整节删除。
//  - 注入面：session.hook("context") 每次请求生效，无需放行；
//  - 配置面：opencode.json(c) 原生支持插件选项，无需改宿主文件；
//  - 副作用：卸载干净（删除插件目录即可），不会因宿主升级而失效。
```

---

## 5. 案例研究

### 5.1 oc-infinite-gen-4（内核注入 + 桌面徽章）

| 上游（DSH） | 移植（OpenCode V2） | 实测结果 |
| :--- | :--- | :--- |
| `systemPrompt.section` ×2（Order 100/200） | `session.hook("context")` push ×2 | 注入生效，`infinite_gen4_profile` 可见 `injection[].enabled=true` |
| `tools.register(profileTool)` | `tool.transform` | 工具可调用 |
| `client.js` 状态条 | `tui.tsx`（TUI）+ `desktop/oc-infinite-gen-4-inject.js`（桌面） | 桌面端输入框上方绿框「无限四代 v0.4.1 · 运行中」（真实 Electron 验证） |
| （新增）运行状态查询 | RPC `infinite.gen4.profile` | `POST /api/rpc/infinite.gen4.profile/get` → 200 |
| `patcher.js` / `cordis.patch.yml` | 删除 | 无宿主文件改动 |

### 5.2 oc-deepseek-banlance（余额查看）

| 需求 | 实现 | 实测 |
| :--- | :--- | :--- |
| 查询 DeepSeek 余额 | 服务端工具 + RPC + TTL 缓存 + 后台刷新 | 工具与 RPC 均返回真实余额 |
| 桌面右上角上下文圆圈提示 | 注入脚本（`w-[120px]` 工具提示容器追加一行） | 上下文页实测显示「余额 ¥15.17」 |
| 审查页「上下文」页 | 注入脚本（`@[32rem]:grid-cols-2` 统计网格追加卡片） | 同上 |
| Key 安全 | Key 只在服务端解析（options → env → `auth.json` → `opencode.json`） | 前端不接触 Key |
| 桌面数据通道 | 注入脚本探测 `http://127.0.0.1:49374` + main 自动认证 | RPC 从渲染进程返回 200 |

### 5.3 实测踩坑清单

1. **RPC id 不能含 `/`**：`acme.foo/bar` 会被路径拆段导致 404；使用点号 `acme.foo.bar`。
2. **桌面端认证是逐步就绪的**：注入脚本首刷可能 401；把 401/403 视为“已找到服务”，并 5s 重试直至就绪。
3. **页面 CSP 禁 eval**：持久注入必须用 asar 内的同源脚本文件；控制台粘贴仅临时有效。
4. **单实例锁**：测试副本必须改 `userData`（真实应用在 `setPath` 里覆盖了 `--user-data-dir`，需在 main 打测试补丁）。
5. **热加载不可靠**：编辑插件文件后若未重载，`POST /api/location/reload` 或退出重开应用。
6. **app.asar 被锁**：打补丁前必须完全退出桌面端；自动 apply 脚本用 `CloseMainWindow` + `Stop-Process`。
7. **自动更新覆盖补丁**：桌面端升级后重新打补丁（把命令做成快捷脚本）。
8. **旧运行时降级**：1.18.x 会加载插件但缺少域 —— 不要假设 `ctx.session/ctx.tool/ctx.rpc` 一定存在。

---

## 6. 迁移检查清单

- [ ] 上游资产（提示词/词表/常量）逐字保留并做哈希校验
- [ ] 默认导出 `{ id, setup }`；入口仅 `import type` 宿主包
- [ ] 能力探测：`session.hook` / `tool.transform` / `rpc.register` 缺失时降级
- [ ] 工具/ RPC 注册均返回可释放的 registration，并在 cleanup 中 dispose
- [ ] RPC id 使用点号；curl 实测 `{input}` → `{output}`
- [ ] TUI 半体（如需要）：`./tui` 导出 + 槽位/命令实现
- [ ] 桌面注入（如需要）：独立脚本 + 独立补丁器（`--dry-run/--unpatch/--restore`）
- [ ] 删除宿主补丁/模板转义等 DSH 专属逻辑
- [ ] 测试：单测 + 假 Context 冒烟 + 真实 RPC 验证（+ 桌面 CDP 验证）
- [ ] 文档与许可：署名上游、注明协议与移植差异
