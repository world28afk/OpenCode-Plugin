// 运行存储 — 文件系统持久化（项目 .opencode/workflow-runs/<runId>/）。
//
//   run.json        运行记录（状态机 / 步骤状态 / 成本）
//   events.jsonl    append-only 事件流
//   results/        确定性 effect cache（按任务指纹命中, 支持 resume-run）
//   artifacts/      workflow 命名的证据文件

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Capsule } from "./capsule"

export type RunStatus = "running" | "paused" | "completed" | "failed" | "stopped"
export type StepStatus = "pending" | "running" | "completed" | "failed" | "skipped" | "cached"

export interface StepState {
  id: string
  type: string
  status: StepStatus
  startedAt?: number
  endedAt?: number
  output?: string | null
  error?: string
  sessionID?: string
  cached?: boolean
}

export interface RunRecord {
  id: string
  name: string
  status: RunStatus
  createdAt: number
  updatedAt: number
  directory: string
  parentSessionID?: string
  inputs: Record<string, unknown>
  capsule: Capsule
  phases: Array<{ name: string; startedAt: number }>
  steps: Record<string, StepState>
  summary?: string | null
  error?: string | null
  agentsUsed: number
}

export class RunStore {
  constructor(private readonly root: string) {}

  ensure(): void {
    mkdirSync(this.root, { recursive: true })
  }

  dir(runId: string): string {
    return join(this.root, runId)
  }

  create(record: RunRecord): void {
    const dir = this.dir(record.id)
    mkdirSync(join(dir, "results"), { recursive: true })
    mkdirSync(join(dir, "artifacts"), { recursive: true })
    this.save(record)
    this.event(record.id, { type: "run.created", name: record.name, at: record.createdAt })
  }

  save(record: RunRecord): void {
    const dir = this.dir(record.id)
    mkdirSync(dir, { recursive: true })
    const target = join(dir, "run.json")
    const tmp = `${target}.tmp`
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8")
    renameSync(tmp, target)
  }

  load(runId: string): RunRecord | null {
    const path = join(this.dir(runId), "run.json")
    if (!existsSync(path)) return null
    try {
      return JSON.parse(readFileSync(path, "utf8")) as RunRecord
    } catch {
      return null
    }
  }

  list(limit = 100): RunRecord[] {
    if (!existsSync(this.root)) return []
    const records: RunRecord[] = []
    for (const name of readdirSync(this.root)) {
      if (!name.startsWith("wf_")) continue
      const record = this.load(name)
      if (record) records.push(record)
    }
    return records.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit)
  }

  event(runId: string, event: Record<string, unknown>): void {
    const dir = this.dir(runId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "events.jsonl"), `${JSON.stringify({ at: Date.now(), ...event })}\n`, { encoding: "utf8", flag: "a" })
  }

  readResult(sourceRunId: string, key: string): { output: string | null } | null {
    const path = join(this.dir(sourceRunId), "results", `${key}.json`)
    if (!existsSync(path)) return null
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { output?: string | null }
      return { output: parsed.output ?? null }
    } catch {
      return null
    }
  }

  writeResult(runId: string, key: string, value: { output: string | null }): void {
    const dir = join(this.dir(runId), "results")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${key}.json`), `${JSON.stringify(value, null, 2)}\n`, "utf8")
  }

  writeArtifact(runId: string, name: string, content: string): string {
    const dir = join(this.dir(runId), "artifacts")
    mkdirSync(dir, { recursive: true })
    const safe = name.replace(/[^a-zA-Z0-9._-]+/g, "-")
    const path = join(dir, safe)
    writeFileSync(path, content, "utf8")
    return path
  }

  prune(options: { keep?: number }): string[] {
    const keep = options.keep ?? 50
    const records = this.list(10_000)
    const removed: string[] = []
    records.slice(Math.max(0, keep)).forEach((record) => {
      rmSync(this.dir(record.id), { recursive: true, force: true })
      removed.push(record.id)
    })
    return removed
  }

  summary(): { runs: number; bytes: number } {
    let bytes = 0
    let runs = 0
    if (!existsSync(this.root)) return { runs, bytes }
    for (const name of readdirSync(this.root)) {
      const path = this.dir(name)
      try {
        if (statSync(path).isDirectory()) runs += 1
      } catch {
        continue
      }
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name)
          if (entry.isDirectory()) walk(full)
          else {
            try {
              bytes += statSync(full).size
            } catch {
              // ignore
            }
          }
        }
      }
      try {
        walk(path)
      } catch {
        // ignore
      }
    }
    return { runs, bytes }
  }
}
