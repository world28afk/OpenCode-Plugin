// 配置解析 — 默认档位表 + 文件/选项合并。
//
// 合并顺序（后者覆盖前者）:
//   内置默认  <  ~/.config/opencode/router-laya.json  <  <项目>/.opencode/router-laya.json  <  插件 options
//
// 多模型适配: 每个档位是任意 { providerID, id, variant? }。
//   - 同一模型用 variants 区分档位（deepseek-flash 的 low/high/max）
//   - 或跨模型/跨 provider 路由（low→便宜快模型, max→最强模型）
//   - variant 省略时按档位名自动从目标模型 variants 解析（low 命中 minimal/none; max 命中 xhigh 等）

import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { TIERS, type Tier } from "./tiers"

export interface ModelRefLike {
  readonly id: string
  readonly providerID: string
  readonly variant?: string
}

export interface RouterConfig {
  readonly mode: "auto" | "manual"
  readonly judge: "heuristic" | "model" | "off"
  readonly judgeModel?: ModelRefLike
  readonly respectExplicit: boolean
  readonly escalateOnRegenerate: boolean
  readonly fallback: Tier
  readonly tiers: Partial<Record<Tier, ModelRefLike>>
  /** 档位表是否来自用户配置（文件/options）。false 表示内置自动挑选。 */
  readonly tiersConfigured: boolean
  /** true: 档位只作用于「当前会话模型」的 variant, 不跨 provider/model（默认, 除非用户写了 tiers）。 */
  readonly followSessionModel: boolean
  readonly historyLimit: number
  readonly sources: string[]
}

export interface ModelInfoLike {
  readonly id?: string
  readonly modelID?: string
  readonly providerID?: string
  readonly name?: string
  readonly variants?: ReadonlyArray<{ id?: string; settings?: Record<string, unknown> }>
}

const VARIANT_ALIASES: Record<Tier, string[]> = {
  low: ["low", "minimal", "none"],
  high: ["high", "medium"],
  max: ["max", "xhigh", "high"],
}

export function normalizeModelId(model: ModelInfoLike): string {
  return String(model.modelID ?? model.id ?? "")
}

export function variantFor(model: ModelInfoLike | undefined, tier: Tier): string | undefined {
  const variants = (model?.variants ?? []).map((variant) => String(variant.id ?? "")).filter(Boolean)
  if (!variants.length) return undefined
  for (const candidate of VARIANT_ALIASES[tier]) {
    if (variants.includes(candidate)) return candidate
  }
  return undefined
}

export function findModel(models: readonly ModelInfoLike[], providerID: string, id: string): ModelInfoLike | undefined {
  return models.find((model) => String(model.providerID) === providerID && normalizeModelId(model) === id)
}

/** 默认档位: 首选 deepseek 的 deepseek-flash（三档 variants 齐全）, 否则任意具备三档 variants 的模型。 */
export function pickDefaultTiers(models: readonly ModelInfoLike[]): Partial<Record<Tier, ModelRefLike>> {
  const candidates: Array<{ providerID: string; id: string }> = [{ providerID: "deepseek", id: "deepseek-flash" }]
  for (const model of models) {
    const providerID = String(model.providerID ?? "")
    const id = normalizeModelId(model)
    if (providerID && id) candidates.push({ providerID, id })
  }
  for (const candidate of candidates) {
    const model = findModel(models, candidate.providerID, candidate.id)
    if (!model) continue
    const tiers: Partial<Record<Tier, ModelRefLike>> = {}
    let complete = true
    for (const tier of TIERS) {
      const variant = variantFor(model, tier)
      if (!variant) {
        complete = false
        break
      }
      tiers[tier] = { providerID: candidate.providerID, id: candidate.id, variant }
    }
    if (complete) return tiers
  }
  return {}
}

export interface LoadOptions {
  readonly directory: string
  readonly models: readonly ModelInfoLike[]
  readonly pluginOptions?: Record<string, unknown>
  readonly home?: string
}

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

export function resolveRoute(
  tiers: Partial<Record<Tier, ModelRefLike>>,
  tier: Tier,
  models: readonly ModelInfoLike[],
): ModelRefLike | null {
  const configured = tiers[tier]
  if (!configured?.providerID || !configured.id) return null
  if (configured.variant) return configured
  const model = findModel(models, configured.providerID, configured.id)
  const variant = variantFor(model, tier)
  return variant ? { ...configured, variant } : { ...configured }
}

/**
 * 档位解析（带「锚定当前会话模型」）。
 *
 * anchor 存在时**只在同一 provider/model 内切换 variant**, 绝不跨到档位表里的其它模型
 * （这是 "切换思考等级却跳到别的分组" 的根因修复）:
 *   - 当前模型有该档位的 variant → 返回同一模型 + 对应 variant
 *   - 当前模型没有该档位 variant → 返回 null（调用方应保持不动, 而不是跨模型回退）
 * 未提供 anchor 时退回静态档位表（保留原有跨模型路由能力）。
 */
export function resolveTierRoute(
  tiers: Partial<Record<Tier, ModelRefLike>>,
  tier: Tier,
  models: readonly ModelInfoLike[],
  anchor?: ModelRefLike | null,
): ModelRefLike | null {
  if (anchor?.providerID && anchor.id) {
    const model = findModel(models, anchor.providerID, anchor.id)
    const variant = variantFor(model, tier)
    return variant ? { providerID: anchor.providerID, id: anchor.id, variant } : null
  }
  return resolveRoute(tiers, tier, models)
}

function asModelRef(value: unknown): ModelRefLike | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  const providerID = typeof record.providerID === "string" ? record.providerID : undefined
  const id = typeof record.id === "string" ? record.id : typeof record.modelID === "string" ? record.modelID : undefined
  if (!providerID || !id) return undefined
  return { providerID, id, ...(typeof record.variant === "string" && record.variant ? { variant: record.variant } : {}) }
}

export function loadConfig(options: LoadOptions): RouterConfig {
  const home = options.home ?? homedir()
  const sources: string[] = []
  const merged: Record<string, unknown> = {}
  const applyFile = (path: string) => {
    const value = readJsonCached(path)
    if (value) {
      sources.push(path)
      Object.assign(merged, value)
    }
  }
  applyFile(join(home, ".config", "opencode", "router-laya.json"))
  applyFile(join(options.directory, ".opencode", "router-laya.json"))
  if (options.pluginOptions) {
    sources.push("plugin options")
    Object.assign(merged, options.pluginOptions)
  }

  const tiersFromFile = (merged.tiers ?? {}) as Record<string, unknown>
  const defaults = pickDefaultTiers(options.models)
  const tiers: Partial<Record<Tier, ModelRefLike>> = { ...defaults }
  let tiersConfigured = false
  for (const tier of TIERS) {
    const resolved = asModelRef(tiersFromFile[tier])
    if (resolved) {
      tiers[tier] = resolved
      tiersConfigured = true
    }
  }

  const mode = merged.mode === "manual" ? "manual" : "auto"
  const judge = merged.judge === "model" ? "model" : merged.judge === "off" ? "off" : "heuristic"
  const judgeModel = asModelRef(merged.judgeModel)
  const fallback = TIERS.includes(merged.fallback as Tier) ? (merged.fallback as Tier) : "low"
  // 默认锚定当前会话模型: 只在同一模型内切 variant, 不跨 provider。
  // 用户显式写了 tiers 就是想跨模型路由 → 默认关掉锚定, 除非显式 followSessionModel。
  const followSessionModel =
    typeof merged.followSessionModel === "boolean" ? merged.followSessionModel : !tiersConfigured

  return {
    mode,
    judge,
    ...(judgeModel ? { judgeModel } : {}),
    respectExplicit: merged.respectExplicit !== false,
    escalateOnRegenerate: merged.escalateOnRegenerate !== false,
    fallback,
    tiers,
    tiersConfigured,
    followSessionModel,
    historyLimit: typeof merged.historyLimit === "number" && merged.historyLimit > 0 ? Math.min(200, merged.historyLimit) : 50,
    sources,
  }
}
