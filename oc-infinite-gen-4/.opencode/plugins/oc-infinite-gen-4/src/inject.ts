// 双层协同注入槽位组装 (框架无关, 可单测)。
//
// 上游 DSH 版本通过 ctx.systemPrompt.section({ name, order, text }) 注册两个
// 系统提示词段 (Order 100 / Order 200)。OpenCode V2 没有 section API,
// 等价面是 session "context" hook: 每次模型调用组装 system 数组时注入。
// 槽位名与 order 通过 SystemPart.metadata 保留, 便于审计与 profile 自描述。

import type { KernelPrompts } from "./prompts"

export const CORE_SLOT = "infinite-gen-4:global-system-prompt"
export const REINFORCE_SLOT = "infinite-gen-4:dual-layer-reinforce"

export const CORE_ORDER = 100
export const REINFORCE_ORDER = 200

/** 注入到 OpenCode system 数组的最小结构 (对齐 @opencode/ai SystemPart)。 */
export interface SystemTextPart {
  readonly type: "text"
  readonly text: string
  readonly metadata?: Record<string, unknown>
}

export interface InjectionOptions {
  /** false = 单段注入 (仅 Order 100), 行为等价且省重复 token。默认 true。 */
  readonly dualLayer?: boolean
  /** 写入 metadata.source 的插件标识。 */
  readonly pluginID?: string
}

/** 生成本次模型调用要追加的 system 段列表。 */
export function buildSystemParts(prompts: KernelPrompts, options: InjectionOptions = {}): SystemTextPart[] {
  const pluginID = options.pluginID ?? "oc-infinite-gen-4"
  const parts: SystemTextPart[] = [
    {
      type: "text",
      text: prompts.core,
      metadata: { source: pluginID, slot: CORE_SLOT, order: CORE_ORDER },
    },
  ]

  if (options.dualLayer !== false) {
    parts.push({
      type: "text",
      text: prompts.reinforce,
      metadata: { source: pluginID, slot: REINFORCE_SLOT, order: REINFORCE_ORDER },
    })
  }

  return parts
}
