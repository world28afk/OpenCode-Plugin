// 词典意图层（Phase 0）— 移植自 dsh-router-laya 的 intent_parser.py 的核心语义。
//
//   force   : 明确指定档位（"用最高档" / "省点" / "认真点" …）
//   inherit : 保持上一轮（"继续" / "接着" …）
//   exclude : 排除某档（"别用 max" / "不要最高档" …），最终统一执行
//
// 否定优先于肯定: "别用最高档" 必须判为 exclude(max) 而不是 force(max)。

import { capTier, isTier, type Tier } from "./tiers"

export interface Intent {
  readonly op: "force" | "inherit" | "exclude" | "none"
  readonly tier?: Tier
  readonly span?: string
}

const EXCLUDE_MAX = /(?:别|不要?|不用|勿|avoid|don'?t|stop)\s*(?:再用?|要|使用)?\s*(?:最高档?|最大档?|用?\s*max|max\s*档|拉满|全力|全开)/i
const EXCLUDE_HIGH = /(?:别|不要?|不用|勿|avoid|don'?t)\s*(?:再用?|要|使用)?\s*(?:高档?|high|用力)/i
const NEGATE_LOW = /(?:别|不要?|不用)\s*(?:省|省点|低档?|low|偷懒)/i

const FORCE_MAX = /(?:最高档?|最大档?|拉满|全开|全力(?:以)?赴?|尽(?:最(?:大|高))?力|拼(?:尽)?全力|用\s*max|max\s*档|开\s*max|最强(?:模型|档)|超强|think\s*deeper|最大努力)/i
const FORCE_HIGH = /(?:高档?|认真(?:点|思考)|仔细(?:点|分析)|深入(?:思考|分析)|高质量|(?:做|想)好一点|用\s*high|high\s*档|think\s*hard(?:er)?|加把劲|努力点)/i
const FORCE_LOW = /(?:省点|省心|省钱|节省|简单(?:点|回答)|最低档?|低档?|用\s*low|low\s*档|别想太多|想少点|快速(?:回答|处理)|quick(?:ly)?\s*(?:answer|reply)?)/i
const INHERIT_HEAD = /^(?:继续|接着|保持|维持|沿用|照旧|go\s*on|continue|keep(?:\s*going)?)/i

export function parseIntent(text: string): Intent {
  const head = text.slice(0, 16)
  const excludeMaxMatch = EXCLUDE_MAX.exec(text)
  if (excludeMaxMatch) return { op: "exclude", tier: "max", span: excludeMaxMatch[0] }
  const excludeHighMatch = EXCLUDE_HIGH.exec(text)
  if (excludeHighMatch) return { op: "exclude", tier: "high", span: excludeHighMatch[0] }
  if (NEGATE_LOW.test(text)) return { op: "force", tier: "max", span: "negated-low" }

  const maxMatch = FORCE_MAX.exec(text)
  if (maxMatch) return { op: "force", tier: "max", span: maxMatch[0] }
  const highMatch = FORCE_HIGH.exec(text)
  if (highMatch) return { op: "force", tier: "high", span: highMatch[0] }
  const lowMatch = FORCE_LOW.exec(text)
  if (lowMatch) return { op: "force", tier: "low", span: lowMatch[0] }

  const inheritMatch = INHERIT_HEAD.exec(text.trim())
  if (inheritMatch) return { op: "inherit", span: inheritMatch[0] }

  return { op: "none" }
}

export interface ConstraintResult {
  readonly tier: Tier
  readonly applied: readonly string[]
}

export function applyConstraints(tier: Tier, excluded: readonly string[]): ConstraintResult {
  if (!excluded.length) return { tier, applied: [] }
  const next = capTier(tier, excluded)
  return { tier: next, applied: next === tier ? [] : [...excluded] }
}

export function intentTierOrNull(intent: Intent): Tier | null {
  return intent.op === "force" && isTier(intent.tier) ? intent.tier : null
}
