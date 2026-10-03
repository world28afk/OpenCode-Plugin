// 自动派发 — 策略注入 + 重任务识别 + 后台 workflow 触发。
//
// 目标: 让模型主动把「耗时耗力」的任务（大范围探索/定位、调查/根因分析、
// 多方案评估/审查、机械性重复操作）交给子代理并行执行，而不是串行硬做，
// 也不需要用户手动 /workflow run。
//
// 配置合并顺序（后者覆盖前者）:
//   内置默认 < ~/.config/opencode/workflow-auto.json < <项目>/.opencode/workflow-auto.json
//     < 插件 options.auto < 运行期 override（/workflow auto on|off|suggest）
//
// mode:
//   "auto"    策略注入 + 自动触发（默认）
//   "suggest" 仅策略注入，由模型自行决定何时 run_workflow
//   "off"     关闭

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

export type AutoMode = "auto" | "suggest" | "off"
export type AutoExecution = "background" | "workflow"
export type AutoCategory = "explore" | "investigate" | "review" | "mechanical"

export interface AutoConfig {
  readonly enabled: boolean
  readonly mode: AutoMode
  /** 是否向模型注入「重任务派发」策略 */
  readonly injectPolicy: boolean
  /** 触发阈值（各项信号加权求和 >= threshold 视为重任务） */
  readonly threshold: number
  /** 参与识别的任务类别 */
  readonly categories: readonly AutoCategory[]
  /** 自动触发时运行的 workflow 名称 */
  readonly workflow: string
  /** 把用户原始请求写入该输入字段 */
  readonly inputField: string
  /**
   * 执行方式:
   *   background = 用内置 subagent 工具起「OpenCode 后台任务」（默认, 不阻塞、不新开项目窗口）
   *   workflow   = 走 oc-workflow 引擎（并行 + 汇总 + 落盘 + 缓存续跑）
   */
  readonly execution: AutoExecution
  /** background 模式使用的 agent（general / explore 等） */
  readonly agent: string
  /** 同一会话两次自动触发的最小间隔（毫秒） */
  readonly cooldownMs: number
  /** 同一会话自动触发次数上限 */
  readonly maxPerSession: number
  /** 低于该长度的请求不触发 */
  readonly minPromptLength: number
  readonly sources: string[]
}

export const AUTO_DEFAULTS: AutoConfig = {
  enabled: true,
  mode: "auto",
  injectPolicy: true,
  threshold: 2,
  categories: ["explore", "investigate", "review", "mechanical"],
  workflow: "parallel-investigation",
  inputField: "question",
  execution: "background",
  agent: "general",
  cooldownMs: 120_000,
  maxPerSession: 3,
  minPromptLength: 6,
  sources: [],
}

export const AUTO_CONFIG_FILE = "workflow-auto.json"

const KEYWORDS: Record<AutoCategory, { weight: number; re: RegExp }> = {
  explore: {
    weight: 2,
    re: /(探索|调研|梳理|盘点|遍历|找出所有|找出全部|涉及哪些|涉及所有|全局|整体架构|架构梳理|调用链|调用关系|影响面|依赖关系|哪些文件|哪里(被|用|定义|实现)|代码地图|explore|map out|trace|architecture|call chain|impact analys|find all|across the codebase)/i,
  },
  investigate: {
    weight: 2,
    re: /(调查|排查|根因|根本原因|为什么|为何|原因是什么|复现|定位问题|间歇|偶发|不稳定|flaky|root cause|investigat|diagnos|debug why|why (does|is|did)|reproduce|narrow down)/i,
  },
  review: {
    weight: 2,
    re: /(审查|评审|复核|风险评估|回归风险|安全审计|重构方案|方案评估|方案对比|技术选型|权衡|取舍|利弊|review|audit|trade.?off|risk assess|evaluate (the )?options?|compare .* (approach|design))/i,
  },
  mechanical: {
    weight: 2,
    re: /(批量|所有文件|每个文件|逐个|逐一|每一个|全量(改|替换|检查)|across all files|batch|bulk|every file|rename .* all|one by one)/i,
  },
}

/** 明显的寒暄/确认/继续 —— 不作为重任务。 */
const NEGATIVE = /^\s*(?:\/|你好|您好|hi\b|hello\b|hey\b|谢谢|多谢|thanks?\b|thx\b|ok(ay)?\b|好的|收到|继续|go on|是的|对的|嗯|没问题|辛苦)[\s!。.，,]*$/i
/** 用户显式要求不派发。 */
const OPT_OUT = /(不要派发|不用派发|无需派发|别派发|不要子代理|不用子代理|别用子代理|直接(做|改|回答|写|说)|简单(说|讲|答)|一句话|先别派发)/i

export interface Detection {
  readonly heavy: boolean
  readonly score: number
  readonly categories: readonly AutoCategory[]
  readonly signals: readonly string[]
}

/** 启发式重任务识别（纯函数, 可单测）。 */
export function detectHeavy(text: string, config: AutoConfig = AUTO_DEFAULTS): Detection {
  const value = (text ?? "").trim()
  const signals: string[] = []
  const categories: AutoCategory[] = []
  if (!value) return { heavy: false, score: 0, categories, signals }
  if (NEGATIVE.test(value) || OPT_OUT.test(value)) return { heavy: false, score: 0, categories, signals }

  let score = 0
  for (const category of config.categories) {
    const entry = KEYWORDS[category]
    if (entry && entry.re.test(value)) {
      score += entry.weight
      categories.push(category)
      signals.push(`kw:${category}`)
    }
  }

  const questions = (value.match(/[?？]/g) ?? []).length
  if (questions >= 2) {
    score += 1
    signals.push("multi-question")
  }
  if (value.length >= 240) {
    score += 1
    signals.push("long")
  }
  if (/(^|\n)\s*(?:[-*]|\d+[.)])\s+/.test(value)) {
    score += 1
    signals.push("enumerated")
  }
  if (value.split("\n").length >= 4) {
    score += 1
    signals.push("multiline")
  }

  const eligible = value.length >= config.minPromptLength && config.categories.length > 0
  return { heavy: eligible && score >= config.threshold, score, categories, signals }
}

/** 向模型注入的「重任务派发」策略文本。 */
export function policyText(config: AutoConfig, pending: readonly { name: string; runId: string }[] = []): string {
  const lines = [
    "[oc-workflow 自动派发策略]",
    "对于下列「耗时耗力」的任务，优先并行派发子代理（run_workflow），不要串行逐个硬做：",
    "- 大范围代码探索/定位: 跨多文件/多模块检索、架构梳理、调用链/影响面分析",
    "- 调查/根因分析: bug 根因、为什么失败、不确定性问题、间歇性/flaky",
    "- 多方案评估/审查: 代码评审、方案对比、风险与回归评估、安全审计",
    "- 机械性重复操作: 批量改写/替换/验证、逐文件处理",
    "做法:",
    "1. 优先 run_workflow：内置 parallel-investigation（并行调查→汇总）、scoped-review（git diff 双评审）、fan-out-and-synthesize（通用扇出汇总）；也可内联 capsule 自定义步骤。",
    "2. 3 条以上相互独立的子任务用 parallel 并发；最后用 synthesize 汇总，不要只罗列。",
    "3. 只读探索/调查任务设 readOnly:true（走 explore agent），避免子代理改动仓库。",
    "4. 直接派发并把汇总结果用于回答；不要只口述“我会拆分”。",
  ]
  if (config.mode === "suggest") lines.push("（当前为 suggest 模式: 由你决定是否派发；用户可 /workflow auto on 切换为自动触发。）")
  if (pending.length) {
    lines.push("")
    lines.push(`本会话已有自动派发的后台调查进行中: ${pending.map((item) => `${item.name}(runId=${item.runId})`).join(", ")}。完成后其结果会回注本会话，可优先等待/结合它作答。`)
  }
  return lines.join("\n")
}

/** background 模式派发用的调查提示词。 */
export function backgroundPrompt(question: string, intent?: string): string {
  const goal = intent?.trim() || "对下述任务做并行式调查并给出可复核结论。"
  return [
    "你是被自动派发的后台调查员（OpenCode background subagent）。",
    goal,
    "",
    "任务:",
    `"""${question}"""`,
    "",
    "只输出:",
    "1. 结论清单（按可信度排序）",
    "2. 关键证据（文件:行号 / 命令输出 / 引用）",
    "3. 反例与边界条件",
    "4. 影响面与回归风险",
    "5. 未决问题与下一步验证建议",
    "不要臆测；无证据的推断请显式标注。",
  ].join("\n")
}

// ── 配置读写 ────────────────────────────────────────────────────────────────

interface FileCacheEntry {
  mtime: number
  value: Record<string, unknown>
}

const fileCache = new Map<string, FileCacheEntry>()

function readJsonCached(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null
    const mtime = statSync(path).mtimeMs
    const cached = fileCache.get(path)
    if (cached && cached.mtime === mtime) return cached.value
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
    fileCache.set(path, { mtime, value: raw })
    return raw
  } catch {
    return null
  }
}

export function autoConfigPath(home: string): string {
  return join(home, ".config", "opencode", AUTO_CONFIG_FILE)
}

export interface LoadAutoOptions {
  readonly directory: string
  readonly home: string
  readonly pluginOptions?: Record<string, unknown>
  readonly override?: { mode?: AutoMode; enabled?: boolean }
}

const MODES = new Set<AutoMode>(["auto", "suggest", "off"])

export function loadAutoConfig(options: LoadAutoOptions): AutoConfig {
  const sources: string[] = []
  const merged: Record<string, unknown> = {}
  const applyFile = (path: string) => {
    const value = readJsonCached(path)
    if (value) {
      sources.push(path)
      Object.assign(merged, value)
    }
  }
  applyFile(autoConfigPath(options.home))
  applyFile(join(options.directory, ".opencode", AUTO_CONFIG_FILE))
  const pluginAuto = options.pluginOptions?.auto
  if (pluginAuto && typeof pluginAuto === "object") {
    sources.push("plugin options")
    Object.assign(merged, pluginAuto as Record<string, unknown>)
  }
  if (options.override) {
    sources.push("runtime override")
    Object.assign(merged, options.override)
  }

  const mode: AutoMode = MODES.has(merged.mode as AutoMode) ? (merged.mode as AutoMode) : AUTO_DEFAULTS.mode
  const categories = (Array.isArray(merged.categories) ? merged.categories : AUTO_DEFAULTS.categories).filter(
    (item): item is AutoCategory => item === "explore" || item === "investigate" || item === "review" || item === "mechanical",
  )
  const num = (value: unknown, fallback: number, min = 0) =>
    typeof value === "number" && Number.isFinite(value) && value >= min ? value : fallback

  return {
    enabled: merged.enabled !== false && mode !== "off",
    mode,
    injectPolicy: merged.injectPolicy !== false,
    threshold: num(merged.threshold, AUTO_DEFAULTS.threshold, 0),
    categories: categories.length ? categories : AUTO_DEFAULTS.categories,
    workflow: typeof merged.workflow === "string" && merged.workflow.trim() ? merged.workflow : AUTO_DEFAULTS.workflow,
    inputField: typeof merged.inputField === "string" && merged.inputField.trim() ? merged.inputField : AUTO_DEFAULTS.inputField,
    execution: merged.execution === "workflow" ? "workflow" : "background",
    agent: typeof merged.agent === "string" && merged.agent.trim() ? merged.agent : AUTO_DEFAULTS.agent,
    cooldownMs: num(merged.cooldownMs, AUTO_DEFAULTS.cooldownMs, 0),
    maxPerSession: num(merged.maxPerSession, AUTO_DEFAULTS.maxPerSession, 0),
    minPromptLength: num(merged.minPromptLength, AUTO_DEFAULTS.minPromptLength, 0),
    sources,
  }
}

/** 把 mode 持久化到 ~/.config/opencode/workflow-auto.json（保留其它字段）。 */
export function persistAutoMode(home: string, mode: AutoMode): string {
  const path = autoConfigPath(home)
  let current: Record<string, unknown> = {}
  try {
    if (existsSync(path)) current = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
  } catch {
    current = {}
  }
  const next = { ...current, mode, enabled: mode !== "off" }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8")
  fileCache.delete(path)
  return path
}
