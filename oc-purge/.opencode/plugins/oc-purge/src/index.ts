// oc-purge — OpenCode 服务端插件入口。
//
// 上游: YuJunZhiXue/dsh-purge v1.1.71 (DeepSeek Harness / Cordis 架构, MIT)
// 移植映射 (见 oc-plugin/docs/dsh-to-opencode-migration.md):
//   export const name / inject + apply(ctx, config)   → 默认导出 { id, setup }
//   ctx.systemPrompt.section({ name, order, text })    → ctx.session.hook("context", ...) 注入 SystemPart
//   ctx.tools.register(purge_status/apply/revert)      → ctx.tool.transform(editor => editor.add(...))
//   lib/redteam HTTP 桥 POST /redteam/api              → ctx.rpc.register("dsh.purge.status")
//   prompt-inject.md + rules/ (文件落盘 $DSH_HOME)     → ctx.storage 私有 JSON (rules/customText/policy)
//   skills/redteam/*.md 官方 skills 目录导入           → 内置技能目录 + 工具导出到 .opencode/skills/
//   cordis.patch.yml + scripts/lib/patcher.js (宿主补丁) → 删除: OpenCode 无宿主补丁面, session hook 每次请求生效
//   client.js (会话标题旁 dock)                        → src/tui.tsx (TUI) + desktop/oc-purge-dock.js (桌面 DOM 注入)
//
// 运行时自包含: 入口仅 import type 宿主包; "@opencode/plugin" 在编译期擦除,
// 旧运行时缺少 session/tool/rpc/skill 域时 mount() 自动降级为空操作。

import type { Plugin } from "@opencode/plugin"
import { mount, PLUGIN_ID } from "./mount"

export { PLUGIN_ID, PLUGIN_VERSION } from "./mount"
export { PurgeStatus, RPC_ID } from "./rpc"

export default { id: PLUGIN_ID, setup: mount } satisfies Plugin.Plugin
