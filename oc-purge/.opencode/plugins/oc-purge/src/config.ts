// 注入状态与解析（框架无关, 可单测）。
//
// 上游 dsh-purge 把状态落在 $DSH_HOME: prompt-inject.md (用户覆盖文本) + rules/
// (多规则集) + workspace policy。OpenCode 移植后统一放进插件私有存储 (ctx.storage),
// 结构如下 —— 解析优先级与上游 readInjectFallback / resolveInjectText 一致:
//
//   customText (等价 prompt-inject.md, 用户覆盖)
//     → activeRule 的正文 (等价规则集)
//       → 内置默认提示词 (等价插件加密默认)
// 再由 policy 决定是否整段注入:
//   fallback (默认): 有用户文本用用户文本; 否则用内置默认
//   strict          : 只用用户文本; 没有就不注入 (丢弃内置默认)
//   always          : 用户文本之后**再追加**内置默认

export const PLUGIN_ID = "oc-purge"

/** 上游 GLOBAL_PROMPT_ORDER = -100000 (越靠前越优先)。 */
export const GLOBAL_PROMPT_ORDER = -100_000
/** 上游 CAPABILITY_SECTION order = GLOBAL_PROMPT_ORDER + 1。 */
export const CAPABILITY_ORDER = GLOBAL_PROMPT_ORDER + 1
/** 上游 postPromptOrder 默认 5100。 */
export const DEFAULT_POST_PROMPT_ORDER = 5100

export const INJECT_SLOT = "oc-purge:inject"
export const CAPABILITY_SLOT = "oc-purge:capabilities"
export const POST_SLOT = "oc-purge:post"

export const WORKSPACE_POLICIES = ["fallback", "strict", "always"] as const
export type WorkspacePolicy = (typeof WORKSPACE_POLICIES)[number]

export interface PurgeRule {
  readonly id: string
  readonly name: string
  readonly content: string
  readonly updatedAt: number
}

export interface PurgeState {
  readonly enabled: boolean
  /** 等价 prompt-inject.md: 用户自定义注入正文。 */
  readonly customText: string | null
  /** 当前启用的规则集 id。 */
  readonly activeRule: string | null
  readonly rules: readonly PurgeRule[]
  readonly policy: WorkspacePolicy
  readonly capabilityProtocol: boolean
  readonly postPrompt: string
  readonly postPromptOrder: number
  /** 等价 $DSH_HOME/net-scope-allow.txt: 「自己的服务器」白名单原文（已规范化）。 */
  readonly serversText: string
  /** 勾选的本地指令文件绝对路径（CWD rules）。 */
  readonly cwdSelections: readonly string[]
  /** 首次使用告知是否已确认（等价上游 welcome notice）。 */
  readonly noticeAck: boolean
}

export const DEFAULT_STATE: PurgeState = {
  enabled: true,
  customText: null,
  activeRule: null,
  rules: [],
  policy: "fallback",
  capabilityProtocol: true,
  postPrompt: "",
  postPromptOrder: DEFAULT_POST_PROMPT_ORDER,
  serversText: "",
  cwdSelections: [],
  noticeAck: false,
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null
}

function normalizeRules(raw: unknown): PurgeRule[] {
  if (!Array.isArray(raw)) return []
  const out: PurgeRule[] = []
  for (const item of raw) {
    if (!item || typeof item !== "object") continue
    const row = item as Record<string, unknown>
    const id = typeof row.id === "string" ? row.id.trim() : ""
    if (!id) continue
    out.push({
      id,
      name: typeof row.name === "string" && row.name.trim() ? row.name.trim() : id,
      content: typeof row.content === "string" ? row.content : "",
      updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : 0,
    })
  }
  return out
}

function normalizeSelections(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== "string") continue
    const trimmed = item.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

/** 把任意持久化数据规整成合法状态（缺字段回退默认）。 */
export function normalizeState(raw: unknown): PurgeState {
  const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
  const policy = WORKSPACE_POLICIES.includes(input.policy as WorkspacePolicy)
    ? (input.policy as WorkspacePolicy)
    : DEFAULT_STATE.policy
  const order =
    typeof input.postPromptOrder === "number" && Number.isFinite(input.postPromptOrder)
      ? input.postPromptOrder
      : DEFAULT_STATE.postPromptOrder
  return {
    enabled: input.enabled === false ? false : true,
    customText: asText(input.customText),
    activeRule: typeof input.activeRule === "string" && input.activeRule.trim() ? input.activeRule.trim() : null,
    rules: normalizeRules(input.rules),
    policy,
    capabilityProtocol: input.capabilityProtocol === false ? false : true,
    postPrompt: typeof input.postPrompt === "string" ? input.postPrompt : "",
    postPromptOrder: order,
    serversText: typeof input.serversText === "string" ? input.serversText : "",
    cwdSelections: normalizeSelections(input.cwdSelections),
    noticeAck: input.noticeAck === true,
  }
}

export interface ResolvedInject {
  /** 实际要注入的正文（可能为空字符串 = 本次不注入）。 */
  readonly text: string
  /** 来源标记, 便于审计/profile。 */
  readonly source: "custom" | "rule" | "cwd" | "default" | "always" | "none"
}

/**
 * 解析本次要注入的正文。defaultText 是内置默认提示词（由 src/prompts.ts 提供），
 * cwdText 是勾选的本地规则文件内容（CWD rules）。
 * 与上游注入决策等价: A 用户文本(prompt-inject/规则集) → B 本地 md → D 插件默认 (+ 策略)。
 */
export function resolveInjectText(state: PurgeState, defaultText: string, cwdText = ""): ResolvedInject {
  const rule = state.activeRule ? state.rules.find((item) => item.id === state.activeRule) : undefined
  const user = asText(state.customText) ?? asText(rule?.content) ?? asText(cwdText)
  const source: ResolvedInject["source"] = state.customText
    ? "custom"
    : asText(rule?.content)
      ? "rule"
      : asText(cwdText)
        ? "cwd"
        : "none"

  if (state.policy === "strict") {
    if (user) return { text: user, source }
    return { text: "", source: "none" }
  }

  if (state.policy === "always") {
    const merged = user ? `${user}\n\n${defaultText}` : defaultText
    return { text: merged, source: "always" }
  }

  if (user) return { text: user, source }
  return { text: defaultText, source: "default" }
}
