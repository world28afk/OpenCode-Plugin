# oc-infinite-gen-4

**无限四代（Infinite Generation Four）v0.4.1 — OpenCode 插件移植版**（内核载荷保持上游 v0.4.0，逐字一致）

上游项目: [`Minglink/dsh-infinite-gen-4`](https://github.com/Minglink/dsh-infinite-gen-4)（DeepSeek Harness / Cordis 架构）。
本仓库将其移植为 OpenCode 插件，内核载荷与上游逐字一致
（SHA256 `d3de9ade65c7fb9d3964ea2cab6239bf947e8511f8eec874da693eb7d0ac5d2b`）。
v0.4.1 新增：桌面端输入框上方运行徽章 + Profile RPC（仅供状态确认，不参与注入）。

## 已验证的兼容矩阵

| 运行时 | 加载 | 注入（Order 100/200） | profile 工具 / RPC | TUI 状态条 | 桌面徽章 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **OpenCode V2**（`@opencode/cli` 2.x，实测 2.0.6） | ✅ `.opencode/plugins/` 自动发现 | ✅ `session.hook("context")` | ✅ `infinite_gen4_profile` + RPC | ✅ 包 `./tui` 导出 | —（需桌面端安装注入，见下） |
| OpenCode Desktop V2（实测 2.0.22） | ✅（同一服务端插件体系） | ✅ | ✅（含 Profile RPC） | —（状态条为 TUI 专属） | ✅ 输入框正上方绿框「运行中」 |
| opencode-ai 1.18.x（V1 线，其预览内核缺少 session/tool 域） | ✅ 加载不报错 | ⛔ 自动降级为空操作 | ⛔ | ⛔ | ⛔ |

> 结论: 请使用 **OpenCode V2**（`npm i -g @opencode/cli`，或 Windows 独立 CLI/桌面端安装包）。
> Windows 上 V2 的 npm 安装如遇 postinstall 限制，可直接使用官方独立 zip / 桌面端 exe。

## 开箱即用（本目录）

`.opencode/plugins/oc-infinite-gen-4/` 已是完整、自包含的插件包。在本目录启动 OpenCode V2 即自动加载，
无需任何配置。

```powershell
# 在本目录启动 OpenCode V2（示例: 独立 CLI）
opencode
# 或使用桌面端: opencode-desktop-win-x64.exe
```

验证:

1. 让模型调用 `infinite_gen4_profile`，返回 JSON 中 `injection[].enabled` 应为 `true`；
2. 新建会话提问，检查回答是否符合注入内核的输出契约（首行 `##` / 代码块命名交付物）；
3. TUI 输入区状态栏应出现「⚫ 无限四代 v0.4.1」及 `✓ 通过 · <域> · 载荷xN` / `✗ <拒绝标记>`；
4. 桌面端输入框上方应出现绿框「● 无限四代 v0.4.1 · 运行中」（安装方式见下文）。

## 安装到其它项目

```powershell
# 整个插件包复制到目标项目的 .opencode/plugins/ 下即可（推荐，V2.0.6 实测路径）
Copy-Item -Recurse D:\OpenCode-Plugin\oc-infinite-gen-4\.opencode\plugins\oc-infinite-gen-4 `
  <你的项目>\.opencode\plugins\
```

重启 OpenCode 后生效。卸载 = 删除该目录，无任何宿主文件改动。

发布到 npm 后也可按 V2 文档以包名配置（供参考）:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{ "package": "oc-infinite-gen-4", "options": { "dualLayer": true } }]
}
```

## 插件选项

| 选项 | 默认 | 说明 |
| :--- | :--- | :--- |
| `dualLayer` | `true` | `true` = Order 100 + Order 200 双段注入；`false` = 单段注入（省重复 token，行为等价） |
| `inject` | `true` | `false` = 不注入系统提示词，仅保留 profile 工具 |
| `profileTool` | `true` | `false` = 不注册 `infinite_gen4_profile` 工具（纯零工具面） |

目录发现加载时使用默认值（全部开启）；选项通过配置对象形式传入。

## 目录结构

```
oc-infinite-gen-4/
├── .opencode/plugins/oc-infinite-gen-4/   # ← 自包含插件包 (可直接整包复制)
│   ├── package.json         # 包导出: "." / "./rpc" / "./tui"
│   ├── index.ts             # 目录解析兜底入口
│   ├── src/
│   │   ├── index.ts         # 默认导出 { id, setup } (运行时零外部依赖)
│   │   ├── mount.ts         # 挂载: 双层注入 + 工具 + RPC + 能力探测降级
│   │   ├── rpc.ts           # RPC 契约 infinite.gen4.profile (桌面徽章状态来源)
│   │   ├── tui.tsx          # TUI 状态条 (prompt.footer.status 槽位)
│   │   ├── prompts.ts       # 自动生成的内联内核载荷 (勿手改)
│   │   ├── inject.ts        # 双层槽位组装 (Order 100/200)
│   │   ├── armor.ts         # 开头窗口(160)判拒/域分类评分器 + 消息投影
│   │   └── profile.ts       # profile 元数据
│   ├── prompts/             # 内核载荷人类可读源 (三个文件 SHA256 一致)
│   └── LICENSE              # CC BY-NC-SA 4.0 (与根目录一致)
├── desktop/                  # 桌面端徽章注入 (独立插件工具链)
│   ├── oc-infinite-gen-4-inject.js
│   └── README.md
├── scripts/
│   ├── sync-prompts.mjs      # 由 prompts/*.md 重新生成 src/prompts.ts
│   ├── patch-desktop.mjs     # app.asar 注入/移除/还原 (仅本插件)
│   ├── apply-desktop.ps1     # 关闭→打补丁→重启 (自动应用)
│   ├── smoke.test.ts         # 假 Context 端到端冒烟 (bun test)
│   └── verify.mjs            # 确定性回归校验
└── LICENSE
```

## 桌面端运行徽章（v0.4.1 新增）

在 OpenCode Desktop / Web UI 的**输入框正上方**显示运行状态绿框（与 dsh-infinite-gen-4 的客户端状态条等位）：

- 运行中：`● 无限四代 v0.4.1 · 运行中`（绿色，悬停显示注入槽位详情）
- 未运行：`● 无限四代 · 未运行`（灰色；服务端插件未加载或未连接时）

安装（独立工具链，`desktop/oc-infinite-gen-4-inject.js` + `scripts/patch-desktop.mjs`）：

```powershell
# 方式 A（临时，零风险）: 桌面端 Ctrl+Shift+I → Console → 粘贴 desktop/oc-infinite-gen-4-inject.js 全部内容
# 方式 B（持久化）:
node scripts/patch-desktop.mjs --dry-run    # 验证（不改动安装）
# 完全退出桌面端（含托盘）后:
node scripts/patch-desktop.mjs              # 注入（自动备份 app.asar.oc-infinite-gen-4.bak）
node scripts/patch-desktop.mjs --unpatch    # 只移除本插件注入（不影响其它插件）
node scripts/patch-desktop.mjs --restore    # 还原到首次注入前的备份

# 方式 C（自动关闭→打补丁→重启, 适合脚本化）:
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/apply-desktop.ps1
```

数据通道：`POST /api/rpc/infinite.gen4.profile/get` —— 桌面端（`oc://renderer`）自动探测本机服务端口
（`/api/info`，401 也视为已找到；失败每 5 秒重试），Electron main 会给顶层 frame 的本机请求自动附加认证。
卸载徽章 = `--unpatch`（本插件独立，不影响其它插件注入）。

## 回归校验

```powershell
node scripts/sync-prompts.mjs   # 修改 prompts/*.md 后重新生成内联载荷
bun scripts/verify.mjs          # 全量校验;  node scripts/verify.mjs 会自动转用 bun
bun test scripts/smoke.test.ts  # 端到端冒烟 (注入/工具/RPC/清理/降级)
```

## 与上游的行为映射（移植说明）

| 上游（DeepSeek Harness / Cordis） | 本移植（OpenCode V2） | 说明 |
| :--- | :--- | :--- |
| `ctx.systemPrompt.section({ name, order, text })` ×2 | `ctx.session.hook("context", e => e.system.push(...))` ×2 | 每次模型调用重新注入；槽位名与 order 保留在 `SystemPart.metadata` |
| `ctx.tools.register(profileTool)` | `ctx.tool.transform(editor => editor.add(...))` | Promise 工具 API，返回 `{ content }` |
| `sessionProjections.register(armorDef)` | `src/armor.ts` + TUI 消息缓存 | 评分逻辑逐条移植，输入形状改为 V2 `Session.Message.Info` |
| `client.js` → `conversation.input.dock` 状态条 | `src/tui.tsx`（TUI）+ `desktop/oc-infinite-gen-4-inject.js`（桌面） | 桌面端为 DOM 注入的输入框上方绿框；运行状态经 Profile RPC 确认 |
| `scripts/lib/patcher.js`（宿主补丁引擎） | **不需要** | 上游需放行被宿主 Phase-1 过滤的注入段并改 `cordis.patch.yml`；V2 context hook 每次调用都生效，无对应过滤面 |
| `{{...}}` 模板转义 | **不需要** | OpenCode system 段不做模板插值，载荷按原文注入 |
| `cordis.patch.yml` / profile 安装 | `.opencode/plugins/` 自动发现 | 卸载 = 删除插件目录，不改动任何宿主文件 |

### 实现取舍

- **运行时零外部依赖**: 入口默认导出 `{ id, setup }` 纯对象。`Plugin.define` 仅为类型辅助（identity），
  宿主旧运行时对 `@opencode/plugin` 的解析并不稳定，因此只保留 `import type`（编译期擦除）。
- **能力探测降级**: `session.hook` / `tool.transform` 缺失时（旧运行时）静默空操作，不污染宿主日志。
- **内联载荷**: `src/prompts.ts` 由 `prompts/*.md` 生成，避免打包/搬迁后文件路径失效；md 仍是人类可读源。

## 许可与归属

- 内核载荷、评审逻辑与能力清单源自 **Minglink/dsh-infinite-gen-4 v0.4.0**，
  采用 [CC BY-NC-SA 4.0](LICENSE)（署名 — 非商业性使用 — 相同方式共享），**严禁商用与二开商用**。
- 本移植仅做插件架构适配；`prompts/` 与上游逐字一致，未增删注入内容。
- 使用须遵守上游 README 中的授权范围与法律声明，仅限合法授权的安全研究场景。
