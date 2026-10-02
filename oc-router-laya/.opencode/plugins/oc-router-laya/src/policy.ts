// 决策管线 — 四层依序执行（移植自 dsh-router-laya 的 judge() 流程）:
//
//   Phase 0  词典意图: force 直接定档 / inherit 保持上轮 / exclude 记约束
//   Phase 1  judge 标签 → compute_tier → base_tier
//   C3       复利升级: 本轮是上轮的重试 → 沿阶梯升一级
//   融合     约束过滤（exclude 最后统一执行, 压住升级结果）

import { applyConstraints, parseIntent, type Intent } from "./lexicon"
import { judgeHeuristic, type HeuristicJudgeResult } from "./heuristic"
import { computeTier, escalate, floorTier, isTier, type QId, type Tier } from "./tiers"

export type TriggeredBy = "intent_force" | "intent_inherit" | "intent_exclude" | "escalate_regenerate" | "laya" | "one_shot"

export type JudgeKind = "heuristic" | "model" | "off"

export interface DecideInput {
  readonly text: string
  readonly prevTier?: string
  readonly prevTask?: string
  /** 会话内累积的排除约束（"别用 max"）。 */
  readonly constraints?: readonly string[]
  /** 一次性强制档位（/router tier high）。 */
  readonly oneShot?: Tier
  readonly judge: JudgeKind
  /** judge=model 时的标签提供者（由 mount 注入, 失败时回退启发式）。 */
  readonly modelLabels?: (text: string) => Promise<Partial<Record<QId, boolean>> | null>
}

export interface Decision {
  readonly at: number
  readonly tier: Tier
  readonly baseTier: Tier
  readonly labels: Partial<Record<QId, boolean>>
  readonly signals: Record<string, string[]>
  readonly density: number
  readonly triggeredBy: TriggeredBy
  readonly regenerate: boolean
  readonly intent: Intent
  readonly escalated: boolean
  readonly constrained: boolean
  readonly judgeMs: number
  readonly text: string
}

const REGENERATE_WORDS = ["重发", "再来", "重新", "重试", "再试", "重做", "again", "regenerate", "redo", "retry"]
const REGENERATE_CORRECTIONS = ["不对", "不是这"]

/** 本轮是否重试上一轮任务（保守触发: 相等/前缀, 或句首重试词; 纠正词必须带明确重试动词）。 */
export function isRegenerate(text: string, prevTask: string | undefined): boolean {
  if (!text || !prevTask) return false
  const norm = (value: string) => value.slice(0, 2000).toLowerCase().split(/\s+/).join("")
  const current = norm(text)
  const previous = norm(prevTask)
  if (!current || !previous) return false
  if (current === previous || current.startsWith(previous)) return true
  const head = current.slice(0, 12)
  if (REGENERATE_WORDS.some((word) => head.startsWith(word.toLowerCase()))) return true
  if (
    REGENERATE_CORRECTIONS.some((word) => head.startsWith(word)) &&
    REGENERATE_WORDS.some((word) => current.includes(word.toLowerCase()))
  ) {
    return true
  }
  return false
}

export async function decide(input: DecideInput): Promise<Decision> {
  const started = Date.now()
  const text = input.text ?? ""
  const constraints = input.constraints ?? []
  const intent = parseIntent(text)

  const base = (
    tier: Tier,
    triggeredBy: TriggeredBy,
    extra?: Partial<Decision> & { labels?: Partial<Record<QId, boolean>> },
  ): Decision => ({
    at: Date.now(),
    tier,
    baseTier: tier,
    labels: {},
    signals: {},
    density: 0,
    triggeredBy,
    regenerate: false,
    intent,
    escalated: false,
    constrained: false,
    judgeMs: Date.now() - started,
    text: text.slice(0, 500),
    ...extra,
  })

  // 一次性强制（最高优先级, 来自 /router tier 命令）
  if (input.oneShot) return base(input.oneShot, "one_shot")

  // Phase 0: force / inherit
  if (intent.op === "force" && isTier(intent.tier)) {
    return base(intent.tier, "intent_force")
  }
  if (intent.op === "inherit") {
    const tier = isTier(input.prevTier) ? input.prevTier : "low"
    return base(tier, "intent_inherit")
  }

  // Phase 1: 判定标签
  let result: HeuristicJudgeResult = { labels: {} as HeuristicJudgeResult["labels"], signals: {}, density: 0 }
  if (input.judge !== "off") {
    let labels: Partial<Record<QId, boolean>> | null = null
    if (input.judge === "model" && input.modelLabels) {
      try {
        labels = await input.modelLabels(text)
      } catch {
        labels = null
      }
    }
    if (labels) {
      result = { labels: labels as HeuristicJudgeResult["labels"], signals: {}, density: 0 }
    } else {
      result = judgeHeuristic(text)
    }
  }
  let baseTier = computeTier(result.labels)

  // C3: 复利升级（先于约束过滤）
  const regenerate = input.prevTier !== undefined && isRegenerate(text, input.prevTask)
  let escalated = false
  if (regenerate && input.prevTier !== undefined) {
    const floored = floorTier(baseTier, escalate(input.prevTier))
    escalated = floored !== baseTier
    baseTier = floored
  }

  // 融合: 约束过滤
  const constrainedResult = applyConstraints(baseTier, constraints)
  const finalTier = constrainedResult.tier
  const constrained = finalTier !== baseTier

  const triggeredBy: TriggeredBy = escalated
    ? "escalate_regenerate"
    : intent.op === "exclude"
      ? "intent_exclude"
      : "laya"

  return {
    at: Date.now(),
    tier: finalTier,
    baseTier,
    labels: result.labels,
    signals: result.signals,
    density: result.density,
    triggeredBy,
    regenerate,
    intent,
    escalated,
    constrained,
    judgeMs: Date.now() - started,
    text: text.slice(0, 500),
  }
}
