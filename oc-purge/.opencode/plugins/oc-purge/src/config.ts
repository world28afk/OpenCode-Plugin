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

/** 模型/agent → 方案 的绑定（键为 `provider/model`、`model` 或 `agentId`）。 */
export interface PurgeBindings {
  readonly model: Readonly<Record<string, string>>
  readonly agent: Readonly<Record<string, string>>
}

export interface PurgeState {
  readonly enabled: boolean
  /** 等价 prompt-inject.md 的「手写」模式：无方案启用时使用。 */
  readonly customText: string | null
  /** 当前启用的方案 id（等价 rules/ 的 active）。 */
  readonly activeRule: string | null
  /** 提示词方案库（等价 rules/ 规则集；一键切换）。 */
  readonly rules: readonly PurgeRule[]
  readonly bindings: PurgeBindings
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
  /** 最近一次模型调用看到的模型（`provider/model`），用于面板显示与绑定校验。 */
  readonly lastModel: string | null
}

export const DEFAULT_STATE: PurgeState = {
  enabled: true,
  customText: null,
  activeRule: null,
  rules: [],
  bindings: { model: {}, agent: {} },
  policy: "fallback",
  capabilityProtocol: true,
  postPrompt: "",
  postPromptOrder: DEFAULT_POST_PROMPT_ORDER,
  serversText: "",
  cwdSelections: [],
  noticeAck: false,
  lastModel: null,
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

function normalizeBindings(raw: unknown): PurgeBindings {
  const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
  const pick = (value: unknown): Record<string, string> => {
    const out: Record<string, string> = {}
    if (value && typeof value === "object") {
      for (const [key, target] of Object.entries(value as Record<string, unknown>)) {
        const k = String(key).trim()
        const v = typeof target === "string" ? target.trim() : ""
        if (k && v) out[k] = v
      }
    }
    return out
  }
  return { model: pick(input.model), agent: pick(input.agent) }
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
    bindings: normalizeBindings(input.bindings),
    policy,
    capabilityProtocol: input.capabilityProtocol === false ? false : true,
    postPrompt: typeof input.postPrompt === "string" ? input.postPrompt : "",
    postPromptOrder: order,
    serversText: typeof input.serversText === "string" ? input.serversText : "",
    cwdSelections: normalizeSelections(input.cwdSelections),
    noticeAck: input.noticeAck === true,
    lastModel: typeof input.lastModel === "string" && input.lastModel.trim() ? input.lastModel.trim() : null,
  }
}

export interface InjectSelector {
  /** `provider/model` 或纯 model id。 */
  readonly model?: string
  readonly provider?: string
  readonly agent?: string
}

/** 按选择器找命中的绑定方案 id（provider/model 精确 > model > agent）。 */
export function boundSchemeId(state: PurgeState, selector: InjectSelector = {}): string | null {
  const known = (id: string | undefined): string | null => (id && state.rules.some((r) => r.id === id) ? id : null)
  if (selector.model) {
    if (selector.provider) {
      const full = known(state.bindings.model[`${selector.provider}/${selector.model}`])
      if (full) return full
    }
    const byModel = known(state.bindings.model[selector.model])
    if (byModel) return byModel
  }
  if (selector.agent) {
    const byAgent = known(state.bindings.agent[selector.agent])
    if (byAgent) return byAgent
  }
  return null
}

export type InjectSource = "custom" | "rule" | "binding" | "cwd" | "default" | "always" | "none"

export interface ResolvedInject {
  /** 实际要注入的正文（可能为空字符串 = 本次不注入）。 */
  readonly text: string
  /** 来源标记, 便于审计/profile。 */
  readonly source: InjectSource
  /** 命中的方案 id（若有）。 */
  readonly schemeId: string | null
}

/**
 * 解析本次要注入的正文。
 * 优先级（与上游 A→B→D + 策略 C 等价, 并新增「按模型绑定方案」）：
 *   模型/agent 绑定方案 → 当前启用方案 → 手写文本 → 勾选本地规则 → 内置默认
 */
export function resolveInjectText(
  state: PurgeState,
  defaultText: string,
  cwdText = "",
  selector: InjectSelector = {},
): ResolvedInject {
  const find = (id: string | null | undefined) => (id ? state.rules.find((item) => item.id === id) : undefined)
  const binding = boundSchemeId(state, selector)
  const rule = find(binding) ?? find(state.activeRule)
  const user = asText(rule?.content) ?? asText(state.customText) ?? asText(cwdText)
  const source: InjectSource = binding
    ? "binding"
    : rule
      ? "rule"
      : asText(state.customText)
        ? "custom"
        : asText(cwdText)
          ? "cwd"
          : "none"
  const schemeId = rule?.id ?? null

  if (state.policy === "strict") {
    if (user) return { text: user, source, schemeId }
    return { text: "", source: "none", schemeId: null }
  }

  if (state.policy === "always") {
    const merged = user ? `${user}\n\n${defaultText}` : defaultText
    return { text: merged, source: "always", schemeId }
  }

  if (user) return { text: user, source, schemeId }
  return { text: defaultText, source: "default", schemeId: null }
}
