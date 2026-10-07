// 脚本治理状态机 — Laya 式判定 + 分级执行。
//
// 流程（每轮监视）:
//   observe(candidates) → 逐个判定 verdict → enforce(candidate)
//     kill 目标:  第一阶段 降优先级 + 宽限（默认 120s）+ 通知; 宽限后仍越界 → 终止 + 通知
//     nice 目标:  降优先级 + 保留 keepMs（长驻服务/长任务）
//     keep 目标:  直接静默
//     observe:    仅记录
//   全程不依赖"把问题发给模型"（会话忙碌时投递不可靠）; 通知走 synthetic 消息 + RPC 事件。
//
// 保护: 同 PID 动作冷却、每小时动作上限、script_keep 可撤销待终止。

import {
  buildKillMessage,
  buildNotifyMessage,
  buildStageMessage,
  judgeScript,
  type JudgeOptions,
  type JudgeVerdict,
  type ScriptAction,
} from "./judge"
import type { ScriptCandidate, ScriptThresholds } from "./scripts"

export interface TrackedScript extends ScriptCandidate {
  state: "detected" | "nudged" | "kept" | "killed"
  alerts: number
  lastActionAt?: number
  notifiedAt?: number
  keepUntil?: number
  graceUntil?: number
  verdict?: JudgeVerdict
}

export interface KillResult {
  readonly ok: boolean
  readonly output: string
}

export interface ActionRecord {
  readonly at: number
  readonly pid: number
  readonly action: ScriptAction | "notify"
  readonly applied: boolean
  readonly detail?: string
}

export interface GovernorDeps {
  readonly thresholds: ScriptThresholds
  /** auto = 判定并执行; notify = 只通知不动作。 */
  readonly mode: "auto" | "notify"
  /** kill 前的宽限期（先降优先级, 到时仍未恢复才终止）。 */
  readonly graceMs: number
  /** 内存硬线: 达到即判定终止。 */
  readonly memoryKillMB: number
  /** 低于该 CPU 视为空闲（识别卡住/被遗忘）。 */
  readonly idleCpuPercent: number
  readonly now?: () => number
  readonly log?: (message: string) => void
  readonly notify?: (sessionID: string, text: string, level: "action" | "notify") => Promise<void>
  readonly kill?: (pid: number) => KillResult
  readonly nice?: (pid: number, level: string) => KillResult
  readonly onAction?: (record: ActionRecord) => void
  readonly maxActionsPerHour?: number
  /** 同 PID 两次动作的最小间隔。 */
  readonly actionCooldownMs?: number
  /** 跨重启/热载恢复的保留记录（script_keep 持久化; 到期自动失效）。 */
  readonly keeps?: ReadonlyArray<{ pid: number; until: number }>
}

export interface ObserveResult {
  readonly alerts: ScriptCandidate[]
  readonly tracked: TrackedScript[]
}

export interface EnforceResult {
  readonly action: ScriptAction | "notify" | "none"
  readonly applied: boolean
  readonly reason?: string
  readonly verdict?: JudgeVerdict
}

export class ScriptGovernor {
  private readonly tracked = new Map<number, TrackedScript>()
  private readonly actions: ActionRecord[] = []
  private readonly now: () => number
  /** pid → keepUntil: 独立于 tracked 存续, 热载/重检测后仍生效。 */
  private readonly pendingKeeps = new Map<number, number>()

  constructor(private readonly deps: GovernorDeps) {
    this.now = deps.now ?? (() => Date.now())
    for (const keep of deps.keeps ?? []) {
      if (keep.until > this.now()) this.pendingKeeps.set(keep.pid, keep.until)
    }
  }

  /** 记录一条保留（用于持久化前载入/撤销待终止）。 */
  seedKeep(pid: number, until: number): void {
    if (until > this.now()) this.pendingKeeps.set(pid, until)
  }

  /** 当前有效的保留记录（供持久化）。 */
  listKeeps(): Array<{ pid: number; until: number }> {
    const now = this.now()
    const keeps: Array<{ pid: number; until: number }> = []
    for (const [pid, until] of this.pendingKeeps) {
      if (until > now) keeps.push({ pid, until })
      else this.pendingKeeps.delete(pid)
    }
    return keeps
  }

  private judgeOptions(): JudgeOptions {
    return {
      thresholds: this.deps.thresholds,
      memoryKillMB: this.deps.memoryKillMB,
      idleCpuPercent: this.deps.idleCpuPercent,
    }
  }

  observe(candidates: readonly ScriptCandidate[]): ObserveResult {
    const now = this.now()
    const seen = new Set<number>()
    const alerts: ScriptCandidate[] = []

    for (const candidate of candidates) {
      seen.add(candidate.pid)
      const verdict = judgeScript(candidate, this.judgeOptions())
      const existing = this.tracked.get(candidate.pid)
      if (!existing) {
        const entry: TrackedScript = { ...candidate, state: "detected", alerts: 1, verdict }
        // 热载前持久化的 script_keep: 新条目直接进入 kept, 不产生告警/动作
        const seededUntil = this.pendingKeeps.get(candidate.pid)
        if (seededUntil !== undefined && seededUntil > now) {
          entry.state = "kept"
          entry.keepUntil = seededUntil
        }
        this.tracked.set(candidate.pid, entry)
        if (entry.state !== "kept") alerts.push(candidate)
        continue
      }
      Object.assign(existing, candidate, { alerts: existing.alerts + 1, verdict })
      if (existing.state === "killed") continue
      if (existing.state === "kept" && existing.keepUntil !== undefined && existing.keepUntil > now) continue
      if (existing.lastActionAt !== undefined && now - existing.lastActionAt < (this.deps.actionCooldownMs ?? 30_000)) continue
      alerts.push(candidate)
    }

    for (const pid of [...this.tracked.keys()]) {
      if (!seen.has(pid)) this.tracked.delete(pid)
    }
    return { alerts, tracked: this.list() }
  }

  private rateLimited(now: number): boolean {
    const max = this.deps.maxActionsPerHour ?? 10
    const recent = this.actions.filter((record) => record.action !== "notify" && now - record.at < 3_600_000)
    return recent.length >= max
  }

  private record(record: ActionRecord): void {
    this.actions.unshift(record)
    if (this.actions.length > 100) this.actions.length = 100
    this.deps.onAction?.(record)
  }

  private async notifySession(candidate: ScriptCandidate, text: string, level: "action" | "notify"): Promise<void> {
    if (!candidate.sessionID || !this.deps.notify) {
      this.deps.log?.(text.split("\n").slice(0, 3).join(" | "))
      return
    }
    try {
      await this.deps.notify(candidate.sessionID, text, level)
      this.deps.log?.(`已通知会话 ${candidate.sessionID}: ${text.split("\n")[0]}`)
    } catch (error) {
      this.deps.log?.(`通知失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 判定并执行一次治理动作（每次监视 tick 或按需调用）。 */
  async enforce(candidate: ScriptCandidate): Promise<EnforceResult> {
    const now = this.now()
    const entry = this.tracked.get(candidate.pid)
    if (!entry) return { action: "none", applied: false, reason: "untracked" }
    const verdict = entry.verdict ?? judgeScript(candidate, this.judgeOptions())
    entry.verdict = verdict

    if (entry.state === "kept" && entry.keepUntil !== undefined && entry.keepUntil > now) {
      return { action: "keep", applied: false, reason: "kept", verdict }
    }
    if (verdict.action === "observe") return { action: "observe", applied: false, verdict }

    if (this.deps.mode === "notify") {
      if (entry.notifiedAt === undefined || now - entry.notifiedAt > this.deps.thresholds.askCooldownMs) {
        entry.notifiedAt = now
        await this.notifySession(candidate, buildNotifyMessage(candidate, verdict), "notify")
      }
      return { action: "notify", applied: false, verdict }
    }

    if (this.rateLimited(now)) {
      this.deps.log?.(`处置限流, 跳过 pid=${candidate.pid}`)
      return { action: verdict.action, applied: false, reason: "rate-limited", verdict }
    }

    if (verdict.action === "keep") {
      entry.state = "kept"
      entry.keepUntil = now + this.deps.thresholds.keepMs
      this.record({ at: now, pid: candidate.pid, action: "keep", applied: true })
      return { action: "keep", applied: true, verdict }
    }

    if (verdict.action === "nice") {
      const result = this.deps.nice?.(candidate.pid, "idle") ?? { ok: false, output: "no nice runner" }
      entry.state = "nudged"
      entry.lastActionAt = now
      entry.keepUntil = now + this.deps.thresholds.keepMs
      this.record({ at: now, pid: candidate.pid, action: "nice", applied: result.ok, detail: result.output.split("\n")[0] })
      await this.notifySession(candidate, buildStageMessage(candidate, verdict, this.deps.thresholds.keepMs), "action")
      return { action: "nice", applied: result.ok, verdict }
    }

    // verdict.action === "kill": 两阶段（降优先级 → 宽限 → 终止）
    if (entry.graceUntil === undefined) {
      const niceResult = this.deps.nice?.(candidate.pid, "idle") ?? { ok: false, output: "no nice runner" }
      entry.state = "nudged"
      entry.graceUntil = now + this.deps.graceMs
      entry.lastActionAt = now
      this.record({ at: now, pid: candidate.pid, action: "nice", applied: niceResult.ok, detail: "staged before kill" })
      await this.notifySession(candidate, buildStageMessage(candidate, verdict, this.deps.graceMs), "action")
      return { action: "nice", applied: niceResult.ok, reason: "grace", verdict }
    }
    if (now < entry.graceUntil) return { action: "kill", applied: false, reason: "grace", verdict }

    const result = this.deps.kill?.(candidate.pid) ?? { ok: false, output: "no kill runner" }
    entry.state = "killed"
    entry.lastActionAt = now
    this.record({ at: now, pid: candidate.pid, action: "kill", applied: result.ok, detail: result.output.split("\n")[0] })
    await this.notifySession(candidate, buildKillMessage(candidate, verdict, result.ok), "action")
    if (result.ok) this.tracked.delete(candidate.pid)
    return { action: "kill", applied: result.ok, verdict }
  }

  /** 确认保留（撤销待终止; 热载/重检测后仍生效, 直至到期）。 */
  keep(pid: number, minutes?: number): { ok: boolean; until?: number; error?: string } {
    const entry = this.tracked.get(pid)
    if (!entry) return { ok: false, error: `未跟踪的 pid: ${pid}` }
    const keepMs = minutes && minutes > 0 ? minutes * 60_000 : this.deps.thresholds.keepMs
    entry.state = "kept"
    entry.keepUntil = this.now() + keepMs
    entry.graceUntil = undefined
    this.pendingKeeps.set(pid, entry.keepUntil)
    return { ok: true, until: entry.keepUntil }
  }

  kill(pid: number): KillResult & { tracked: boolean } {
    if (!this.deps.kill) return { ok: false, output: "no kill runner", tracked: this.tracked.has(pid) }
    const result = this.deps.kill(pid)
    if (result.ok) this.tracked.delete(pid)
    return { ...result, tracked: this.tracked.has(pid) }
  }

  nice(pid: number, level: string): KillResult {
    if (!this.deps.nice) return { ok: false, output: "no nice runner" }
    return this.deps.nice(pid, level)
  }

  list(): TrackedScript[] {
    return [...this.tracked.values()].sort((a, b) => b.cpuPercent - a.cpuPercent || b.mb - a.mb)
  }

  listActions(limit = 20): ActionRecord[] {
    return this.actions.slice(0, limit)
  }

  clear(pid?: number): void {
    if (pid === undefined) this.tracked.clear()
    else this.tracked.delete(pid)
  }

  get actionCount(): number {
    const now = this.now()
    return this.actions.filter((record) => record.action !== "notify" && now - record.at < 3_600_000).length
  }
}
