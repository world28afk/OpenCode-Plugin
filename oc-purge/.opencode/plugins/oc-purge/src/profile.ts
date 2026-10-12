// purge_status 工具 / RPC 返回的运行时元数据 (框架无关, 可单测)。
// 对齐上游 dsh-purge 的状态输出 (surface / 补丁清单), 换成 OpenCode 的等价面。

import { BUNDLED_SKILLS } from "./skills"
import { DEFAULT_PROMPT, DEFAULT_PROMPT_SHA256 } from "./prompts"
import { CAPABILITY_SLOT, GLOBAL_PROMPT_ORDER, INJECT_SLOT, POST_SLOT, type PurgeState, type ResolvedInject } from "./config"

export interface ProfileInput {
  readonly version: string
  readonly state: PurgeState
  readonly resolved: ResolvedInject
  readonly hostFeatures: readonly string[]
  readonly injectActive: boolean
  readonly installedSkills?: readonly string[]
  readonly servers?: readonly string[]
  readonly cwd?: readonly { path: string; scope: string; size: number }[]
  readonly lastModel?: string | null
  readonly lastAgent?: string | null
  readonly directory?: string | null
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
      'PromptInject: session.hook("context") 每次模型调用注入（等价 systemPrompt.section）',
      "PromptSchemes: 提示词方案一键切换 + 模型/agent 绑定（不同模型换不同提示词）",
      "CapabilityProtocol: oc-purge:capabilities 段（官方/红队 lead/红队 executor 三态）",
      "WorkspacePolicy: fallback / strict / always",
      "CWD Rules: 扫描当前目录/祖先的 AGENTS.md / CLAUDE.md 并勾选注入",
      "OwnServers: 白名单（等价 $DSH_HOME/net-scope-allow.txt）",
      "PurgeTools: purge_status/apply/revert/inject/rules/skills/servers/cwd",
      "PurgeCommands: /purge /rules /skills（无 command API 时自动省略）",
      "PurgeRpc: POST /api/rpc/purge.status/{get,set,apply,revert,rules,skills,servers,cwd}",
      "BundledSkills: skills/redteam/*.md 内置并可按需导出到 .opencode/skills/",
      "DesktopDock: 输入框上方破甲面板（Clean/Drill 双页 + Light/Ink）",
      "NoHostPatch: 删除 cordis.patch.yml / patcher.js（V2 无此面，卸载即净）",
    ],
    enabled: state.enabled,
    injectActive: input.injectActive,
    injection: [
      {
        hook: "session.context",
        slot: INJECT_SLOT,
        order: GLOBAL_PROMPT_ORDER,
        source: resolved.source,
        enabled: live && Boolean(resolved.text.trim()),
      },
      {
        hook: "session.context",
        slot: CAPABILITY_SLOT,
        order: GLOBAL_PROMPT_ORDER + 1,
        enabled: live && state.capabilityProtocol,
      },
      {
        hook: "session.context",
        slot: POST_SLOT,
        order: state.postPromptOrder,
        enabled: live && Boolean(state.postPrompt.trim()),
      },
    ],
    promptSource: resolved.source,
    schemeId: resolved.schemeId,
    defaultPromptSha256: DEFAULT_PROMPT_SHA256,
    defaultPromptBytes: DEFAULT_PROMPT.length,
    defaultPromptText: DEFAULT_PROMPT,
    customTextBytes: state.customText ? state.customText.length : 0,
    activeScheme: activeRule ? { id: activeRule.id, name: activeRule.name, bytes: activeRule.content.length } : null,
    activeSchemeText: activeRule ? activeRule.content : "",
    ruleCount: state.rules.length,
    schemes: state.rules.map((rule) => ({
      id: rule.id,
      name: rule.name,
      bytes: rule.content.length,
      preview: rule.content.replace(/\s+/g, " ").trim().slice(0, 90),
    })),
    bindings: state.bindings,
    lastModel: input.lastModel ?? null,
    lastAgent: input.lastAgent ?? null,
    directory: input.directory ?? null,
    policy: state.policy,
    capabilityProtocol: state.capabilityProtocol,
    servers: {
      hosts: input.servers ?? [],
      lines: state.serversText ? state.serversText.trim().split(/\r?\n/).length : 0,
    },
    cwd: {
      selections: state.cwdSelections,
      scanned: input.cwd ?? [],
    },
    noticeAck: state.noticeAck,
    customText: state.customText ?? "",
    postPrompt: state.postPrompt,
    skills: {
      bundled: BUNDLED_SKILLS.length,
      ids: BUNDLED_SKILLS.map((skill) => skill.id),
      installed: input.installedSkills ?? [],
    },
    hostFeatures: input.hostFeatures,
  }
}
