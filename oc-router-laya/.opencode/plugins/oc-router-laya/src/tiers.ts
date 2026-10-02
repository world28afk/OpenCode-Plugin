// 档位与规则引擎 — 移植自 dsh-router-laya 的 finetuned_judge.py（规则语义逐条对应, 独立实现）。
//
// 7 问协议（Q1-Q7）答案 → compute_tier → low | high | max。
//   Rule 0: Q7（会话复利）→ high, 永不给 max
//   Rule 1: Q4 且非 Q1 → max
//   Rule 2: Q2 且 Q3 → max
//   Rule 3: Q1 且 Q4 且 Q5 且非 Q2 → high
//   Rule 4: Q2 且非 Q3 → high
//   Rule 5: Q1 → 加权分 >= 0.60 ? max : high
//   Rule 6: 加权分 >= 0.40 ? high : low

export const TIERS = ["low", "high", "max"] as const
export type Tier = (typeof TIERS)[number]

export type QId = "Q1" | "Q2" | "Q3" | "Q4" | "Q5" | "Q6" | "Q7"
export const QIDS: readonly QId[] = ["Q1", "Q2", "Q3", "Q4", "Q5", "Q6", "Q7"]

export const QUESTIONS: Record<QId, string> = {
  Q1: "需要修改对话以外的东西吗（改文件、跑代码、调服务）？",
  Q2: "是否涉及跨多个模块/服务/阶段的集成或架构级改动？",
  Q3: "前序步骤出错是否会影响后续（步骤间存在先决与验证依赖）？",
  Q4: "是否需要多步推理/非平凡约束求解/没有明确验收标准的开放式排查与优化（数学、逻辑、规划、算法、性能调试）？",
  Q5: "是否涉及读写或修改源码文件？",
  Q6: "是否需要生成新内容（代码、分析、报告、设计）而不是检索/总结既有信息？",
  Q7: "成功是否依赖多个相互独立的子结果全部正确（批量改动、多文件编辑、逐项检查的长序列），任一子项出错即整体失败？",
}

/** Q1-Q6 权重（Q7 是硬闸, 不参与加权）。 */
export const WEIGHTS: Record<Exclude<QId, "Q7">, number> = { Q1: 0.18, Q2: 0.18, Q3: 0.12, Q4: 0.29, Q5: 0.09, Q6: 0.14 }

export function computeTier(labels: Partial<Record<QId, boolean>>): Tier {
  const q1 = !!labels.Q1
  const q2 = !!labels.Q2
  const q3 = !!labels.Q3
  const q4 = !!labels.Q4
  const q5 = !!labels.Q5
  const q6 = !!labels.Q6
  const scoreOf = () => (Object.keys(WEIGHTS) as Array<Exclude<QId, "Q7">>).reduce((sum, q) => sum + (labels[q] ? WEIGHTS[q] : 0), 0)

  if (labels.Q7) return "high" // Rule 0
  if (q4 && !q1) return "max" // Rule 1
  if (q2 && q3) return "max" // Rule 2
  if (q1 && q4 && q5 && !q2) return "high" // Rule 3
  if (q2 && !q3) return "high" // Rule 4
  if (q1) return scoreOf() >= 0.6 ? "max" : "high" // Rule 5
  void q6
  return scoreOf() >= 0.4 ? "high" : "low" // Rule 6
}

/** 升级一档（上限 max）；非本梯成员（如 medium）映射到最近档, 未知值原样返回。 */
export function escalate(tier: string): string {
  return ({ low: "high", high: "max", max: "max", medium: "high" } as Record<string, string>)[tier] ?? tier
}

/** 两档取高者；off-ladder 的 b 忽略。 */
export function floorTier(a: Tier, b: string): Tier {
  const index = (TIERS as readonly string[]).indexOf(b)
  if (index >= 0 && index > TIERS.indexOf(a)) return b as Tier
  return a
}

/** 约束过滤: 排除某档即压到该档以下（可叠加）。 */
export function capTier(tier: Tier, excluded: readonly string[]): Tier {
  let current: Tier = tier
  let changed = true
  while (changed) {
    changed = false
    for (const exclude of excluded) {
      const index = (TIERS as readonly string[]).indexOf(exclude)
      if (index < 0) continue
      if (TIERS.indexOf(current) >= index) {
        const next = TIERS[Math.max(0, index - 1)] as Tier
        if (next !== current) {
          current = next
          changed = true
        }
      }
    }
  }
  return current
}

export function isTier(value: unknown): value is Tier {
  return typeof value === "string" && (TIERS as readonly string[]).includes(value)
}
