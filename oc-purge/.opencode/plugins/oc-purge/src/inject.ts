// 注入槽位组装（框架无关, 可单测）。
//
// 上游 DSH 用 ctx.systemPrompt.section({ name, order, text }) 注册三个系统段:
//   1. dsh-purge                (order GLOBAL_PROMPT_ORDER)
//   2. dshpg-capabilities       (order GLOBAL_PROMPT_ORDER + 1)
//   3. dsh-purge:post           (order postPromptOrder)
// OpenCode V2 没有 section API, 等价面是 session "context" hook:
// 每次模型调用组装 system 数组时注入。槽位名与 order 保留在 metadata 便于审计。

import { CAPABILITY_PROTOCOL } from "./prompts"
import {
  CAPABILITY_ORDER,
  CAPABILITY_SLOT,
  GLOBAL_PROMPT_ORDER,
  INJECT_SLOT,
  POST_SLOT,
  type PurgeState,
  type ResolvedInject,
} from "./config"

const CHATML_LINE = "<|im_start|>system:"
const PROJECT_OPEN = "<project_instructions>"
const PROJECT_CLOSE = "</project_instructions>"

/**
 * 逐字移植上游 normalizeChatmlLayout / peelChatmlEnvelope:
 * 保留 ChatML 外壳与 project 标签, 只整理行与补闭合。
 * （上游还用 escapeDshInterpolation 拆 DSH 模板变量；OpenCode 无模板层, 故删除该步。）
 */
export function normalizeInjectLayout(text: string): string {
  let out = String(text ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
  if (!out) return out
  out = out.replace(
    /<\|im_start\|>\s*system\s*:\s*<project_instructions>/gi,
    `${CHATML_LINE}\n${PROJECT_OPEN}`,
  )
  out = out.replace(/<\|im_start\|>\s*system\s*:(?!\s*\n)/gi, `${CHATML_LINE}\n`)
  out = out.replace(
    /<\|im_start\|>system:\n+<project_instructions>/i,
    `${CHATML_LINE}\n${PROJECT_OPEN}`,
  )
  if (/<project_instructions>/i.test(out) && !/<\/project_instructions>/i.test(out)) {
    out = `${out.replace(/\s+$/, "")}\n${PROJECT_CLOSE}`
  }
  return out
    .replace(/[ \t]+$/gm, "")
    .replace(/^\s+/, "")
    .replace(/\s+$/, "")
}

/** 注入到 OpenCode system 数组的最小结构 (对齐 @opencode/ai SystemPart)。 */
export interface SystemTextPart {
  readonly type: "text"
  readonly text: string
  readonly metadata?: Record<string, unknown>
}

export interface BuildInjectOptions {
  readonly state: PurgeState
  readonly resolved: ResolvedInject
  readonly redteam?: boolean
  readonly redteamChild?: boolean
  readonly pluginID?: string
}

/** 生成本次模型调用要追加的 system 段列表。 */
export function buildSystemParts(options: BuildInjectOptions): SystemTextPart[] {
  const { state, resolved } = options
  const pluginID = options.pluginID ?? "oc-purge"
  if (!state.enabled) return []

  const parts: SystemTextPart[] = []

  if (resolved.text.trim()) {
    parts.push({
      type: "text",
      text: normalizeInjectLayout(resolved.text),
      metadata: { source: pluginID, slot: INJECT_SLOT, order: GLOBAL_PROMPT_ORDER, origin: resolved.source },
    })
  }

  if (state.capabilityProtocol) {
    const role = options.redteamChild ? "redteamChild" : options.redteam ? "redteamLead" : "official"
    parts.push({
      type: "text",
      text: CAPABILITY_PROTOCOL[role],
      metadata: { source: pluginID, slot: CAPABILITY_SLOT, order: CAPABILITY_ORDER, role },
    })
  }

  const post = state.postPrompt.trim()
  if (post && state.postPromptOrder > GLOBAL_PROMPT_ORDER) {
    parts.push({
      type: "text",
      text: post,
      metadata: { source: pluginID, slot: POST_SLOT, order: state.postPromptOrder },
    })
  }

  return parts
}
