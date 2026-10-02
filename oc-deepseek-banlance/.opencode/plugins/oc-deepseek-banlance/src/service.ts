// 余额查询服务 — 带 TTL 缓存、并发去重、错误保留与变更订阅。
// 与宿主 API 解耦, 可用假 loader 单测。

import type { BalanceInfo } from "./deepseek"

export interface BalanceSnapshot {
  readonly ok: boolean
  readonly noKey: boolean
  readonly error: string | null
  readonly source: string
  readonly isAvailable: boolean | null
  readonly infos: readonly BalanceInfo[]
  readonly primary: BalanceInfo | null
  /** 本次查询完成时间 (ms)。 */
  readonly updatedAt: number
  /** 最近一次成功查询时间 (ms), 失败时用于说明数据新鲜度。 */
  readonly lastGoodAt: number | null
}

export interface BalanceLoaderResult {
  readonly ok: boolean
  readonly noKey: boolean
  readonly error: string | null
  readonly source: string
  readonly isAvailable: boolean | null
  readonly infos: readonly BalanceInfo[]
  readonly primary: BalanceInfo | null
}

export interface BalanceServiceOptions {
  readonly load: () => Promise<BalanceLoaderResult>
  /** 缓存有效期, 默认 60s。 */
  readonly ttlMs?: number
  readonly now?: () => number
}

export interface BalanceService {
  /** 读取快照; 未过期直接返回缓存, force=true 强制刷新。 */
  get(force?: boolean): Promise<BalanceSnapshot>
  snapshot(): BalanceSnapshot | null
  /** 用持久化数据预热 (仅接受 JSON 形状匹配的快照)。 */
  seed(value: unknown): void
  onChange(listener: (snapshot: BalanceSnapshot) => void): () => void
}

function hydrate(value: unknown): BalanceSnapshot | null {
  if (!value || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  if (typeof record.updatedAt !== "number") return null
  const infos = Array.isArray(record.infos) ? (record.infos as BalanceInfo[]) : []
  const primary = record.primary && typeof record.primary === "object" ? (record.primary as BalanceInfo) : null
  return {
    ok: record.ok === true,
    noKey: record.noKey === true,
    error: typeof record.error === "string" ? record.error : null,
    source: typeof record.source === "string" ? record.source : "cache",
    isAvailable: typeof record.isAvailable === "boolean" ? record.isAvailable : null,
    infos,
    primary,
    updatedAt: record.updatedAt,
    lastGoodAt: typeof record.lastGoodAt === "number" ? record.lastGoodAt : null,
  }
}

export function createBalanceService(options: BalanceServiceOptions): BalanceService {
  const ttlMs = options.ttlMs ?? 60_000
  const now = options.now ?? Date.now
  const listeners = new Set<(snapshot: BalanceSnapshot) => void>()

  let current: BalanceSnapshot | null = null
  let inflight: Promise<BalanceSnapshot> | null = null

  const emit = (snapshot: BalanceSnapshot) => {
    for (const listener of listeners) {
      try {
        listener(snapshot)
      } catch {
        // 订阅者异常不影响查询流程
      }
    }
  }

  const run = async (force: boolean): Promise<BalanceSnapshot> => {
    const cached = current
    if (!force && cached && now() - cached.updatedAt < ttlMs) return cached
    if (inflight) return inflight

    inflight = (async () => {
      const startedAt = now()
      try {
        const result = await options.load()
        const snapshot: BalanceSnapshot = {
          ok: result.ok,
          noKey: result.noKey,
          error: result.error,
          source: result.source,
          isAvailable: result.isAvailable,
          infos: result.infos,
          primary: result.primary,
          updatedAt: now(),
          lastGoodAt: result.ok ? now() : (cached?.lastGoodAt ?? null),
        }
        current = snapshot
        emit(snapshot)
        return snapshot
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const snapshot: BalanceSnapshot = {
          ok: false,
          noKey: false,
          error: message,
          source: cached?.source ?? "none",
          isAvailable: cached?.isAvailable ?? null,
          infos: cached?.infos ?? [],
          primary: cached?.primary ?? null,
          updatedAt: now(),
          lastGoodAt: cached?.lastGoodAt ?? null,
        }
        // 保留最近一次成功数据, 但记录失败时间与错误
        current = snapshot
        emit(current)
        return current
      } finally {
        inflight = null
      }
    })()

    return inflight
  }

  return {
    get: (force = false) => run(force),
    snapshot: () => current,
    seed: (value) => {
      const hydrated = hydrate(value)
      if (hydrated && (!current || hydrated.updatedAt > current.updatedAt)) current = hydrated
    },
    onChange: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
