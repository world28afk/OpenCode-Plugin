// purge_status 工具 / RPC 返回的运行时元数据 (框架无关, 可单测)。
// 对齐上游 dsh-purge 的状态输出 (surface / 补丁清单), 换成 OpenCode 的等价面。

import { BUNDLED_SKILLS } from "./skills"
import { DEFAULT_PROMPT_SHA256 } from "./prompts"
import { GLOBAL_PROMPT_ORDER, type PurgeState, type ResolvedInject } from "./config"

export interface ProfileInput {
  readonly version: string
  readonly state: PurgeState
  readonly resolved: ResolvedInject
  readonly hostFeatures: readonly string[]
  readonly injectActive: boolean
}

export function buildProfile(input: ProfileInput): Record<string, unknown> {
  const { state, resolved } = input
  const activeRule = state.activeRule ? state.rules.find((rule) => rule.id === state.activeRule) : undefined
  const live = input.injectActive && state.enabled
  return {
    plugin: "oc-purge",
    pluginVersion: input.version,
    pluginDisplayName: "破甲 dsh-purge (OpenCode 移植版)",
    upstream: {
      repo: "YuJunZhiXue/dsh-purge",
      version: "1.1.71",
      license: "MIT",
    },
    host: "opencode",
    surface: "opencode",
    // 上游补丁清单在 OpenCode 无宿主补丁面（迁移指南 §4.5），此处列出等价能力。
    capabilities: [
      "PromptInject: session.hook(\"context\") 每次模型调用注入（等价 systemPrompt.section）",
      "CapabilityProtocol: dshpg-capabilities 段（官方/红队 lead/红队 executor 三态）",
      "RulesLibrary: 多规则集启用/删除（等价 rules/ + /rules 命令）",
      "WorkspacePolicy: fallback / strict / always（等价 workspace baseline 策略）",
      "PurgeTools: purge_status / purge_inject / purge_rules / purge_skills",
      "PurgeRpc: POST /api/rpc/dsh.purge.status/get（桌面 dock 数据源）",
      "BundledSkills: skills/redteam/*.md 内置并可按需导出到 .opencode/skills/",
      "DesktopDock: 会话标题旁破甲面板（desktop/oc-purge-dock.js）",
      "Removed: 宿主补丁 / cordis.patch.yml / patcher.js（V2 无此面，卸载即净）",
    ],
    enabled: state.enabled,
    injectActive: input.injectActive,
    injection: [
      {
        hook: "session.context",
        slot: "dshpg-inject",
        order: GLOBAL_PROMPT_ORDER,
        source: resolved.source,
        enabled: live && Boolean(resolved.text.trim()),
      },
      {
        hook: "session.context",
        slot: "dshpg-capabilities",
        order: GLOBAL_PROMPT_ORDER + 1,
        enabled: live && state.capabilityProtocol,
      },
      {
        hook: "session.context",
        slot: "dsh-purge:post",
        order: state.postPromptOrder,
        enabled: live && Boolean(state.postPrompt.trim()),
      },
    ],
    promptSource: resolved.source,
    defaultPromptSha256: DEFAULT_PROMPT_SHA256,
    customTextBytes: state.customText ? state.customText.length : 0,
    activeRule: activeRule ? { id: activeRule.id, name: activeRule.name, bytes: activeRule.content.length } : null,
    ruleCount: state.rules.length,
    rules: state.rules.map((rule) => ({ id: rule.id, name: rule.name, bytes: rule.content.length })),
    policy: state.policy,
    capabilityProtocol: state.capabilityProtocol,
    skills: {
      bundled: BUNDLED_SKILLS.length,
      ids: BUNDLED_SKILLS.map((skill) => skill.id),
    },
    hostFeatures: input.hostFeatures,
  }
}
