// oc-infinite-gen-4 — OpenCode 服务端插件入口。
//
// 上游: Minglink/dsh-infinite-gen-4 v0.4.0 (DeepSeek Harness / Cordis 架构)
// 移植映射:
//   ctx.systemPrompt.section(...)      → ctx.session.hook("context", ...) 注入 SystemPart
//   ctx.tools.register(profileTool)    → ctx.tool.transform(editor => editor.add(...))
//   sessionProjections.register(armor) → src/armor.ts (TUI 状态条复用)
//   scripts/lib/patcher.js (宿主补丁)   → 不需要: V2 context hook 每次模型调用都生效
//
// 运行时自包含设计:
//   加载器只要求默认导出包含 { id, setup } 的定义, Plugin.define 仅是类型辅助
//   (identity)。因此入口不 import 任何宿主包的运行时值 —— "@opencode/plugin"
//   只作为 import type 使用, 编译期擦除。注入与工具注册依赖 OpenCode V2 的
//   session/tool 插件 API; 旧运行时缺少这些域时 mount() 自动降级为空操作。
//
// 加载方式 (OpenCode V2, 已在 2.0.6 验证):
//   作为插件包目录放在 <项目>/.opencode/plugins/oc-infinite-gen-4/ 自动发现。

import type { Plugin } from "@opencode/plugin"
import { mount, PLUGIN_ID } from "./mount"

export { PLUGIN_ID, PLUGIN_VERSION } from "./mount"
export { InfiniteGen4Profile, RPC_ID } from "./rpc"

export default { id: PLUGIN_ID, setup: mount } satisfies Plugin.Plugin
