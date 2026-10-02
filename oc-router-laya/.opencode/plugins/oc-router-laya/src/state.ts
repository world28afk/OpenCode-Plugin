// 会话状态与决策历史（内存主存, 供 hook/工具/RPC/TUI 共享）。

import type { Decision } from "./policy"
import type { Tier } from "./tiers"

export interface RouteRef {
  readonly providerID: string
  readonly id: string
  readonly variant?: string
}

export interface SessionState {
  prevTier?: string
  prevTask?: string
  constraints: string[]
  oneShot?: Tier
  lastApplied?: RouteRef
  appliedAt?: number
  judgeCache: Map<string, Record<string, boolean>>
}

export interface HistoryEntry extends Decision {
  readonly sessionID: string
  applied: RouteRef | null
  appliedReason?: string
}

export function emptySession(): SessionState {
  return { constraints: [], judgeCache: new Map() }
}

export function hashText(text: string): string {
  let hash = 5381
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0
  }
  return `h${(hash >>> 0).toString(36)}`
}

export function sameRef(a: RouteRef | undefined, b: RouteRef | undefined): boolean {
  if (!a || !b) return false
  return a.providerID === b.providerID && a.id === b.id && (a.variant ?? "") === (b.variant ?? "")
}

export class RouterState {
  readonly sessions = new Map<string, SessionState>()
  readonly history: HistoryEntry[] = []
  modeOverride: "auto" | "manual" | null = null

  session(id: string): SessionState {
    let value = this.sessions.get(id)
    if (!value) {
      value = emptySession()
      this.sessions.set(id, value)
    }
    return value
  }

  push(entry: HistoryEntry, limit = 50): void {
    this.history.unshift(entry)
    if (this.history.length > limit) this.history.length = limit
  }
}
