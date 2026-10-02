// 运行引擎 — 顺序步骤 + 并行任务 + 暂停/恢复/停止 + 预算 + 确定性缓存。
//
// 设计要点（移植自 dsh_workflow 的执行模型, 独立实现）:
//   • 每个任务通过子会话运行（Bridge 注入, 可测试）
//   • pause 阻断尚未发布的任务（含信号量队列中的）; stop 中断活动子会话
//   • results/<指纹>.json 是只存“已完成”的 effect cache, resume-run 按缓存续跑
//   • agent 预算硬限制（超出即失败, 不静默降级）

import { spawnSync } from "node:child_process"
import type { AgentHandle, AgentTask, SessionBridge } from "./agents"
import type { Capsule } from "./capsule"
import { resolveInputs } from "./capsule"
import { interpolate, type InterpolationScope } from "./interpolate"
import type { RunRecord, StepState } from "./store"
import { RunStore } from "./store"
import { Semaphore, runId, shortHash, truncate } from "./util"

export type BridgeFactory = (input: { parentSessionID?: string }) => SessionBridge

export interface EngineOptions {
  readonly directory: string
  readonly store: RunStore
  readonly bridge: BridgeFactory
  readonly log?: (message: string) => void
  readonly maxAgents?: number
  readonly maxConcurrency?: number
  readonly onUpdate?: (record: RunRecord) => void
}

export interface StartOptions {
  readonly inputs?: Record<string, unknown>
  readonly parentSessionID?: string
  readonly wait?: boolean
  readonly runId?: string
  readonly cacheFrom?: string
}

interface Runtime {
  record: RunRecord
  paused: boolean
  stopped: boolean
  waiters: Array<() => void>
  active: Set<AgentHandle>
  cacheFrom?: string
  done?: Promise<RunRecord>
}

export function initializeSteps(capsule: Capsule): Record<string, StepState> {
  const steps: Record<string, StepState> = {}
  for (const step of capsule.steps) {
    if (step.type === "agent" || step.type === "synthesize" || step.type === "capture") {
      steps[step.id] = { id: step.id, type: step.type, status: "pending" }
    } else if (step.type === "parallel") {
      for (const task of step.tasks) steps[task.id] = { id: task.id, type: "agent", status: "pending" }
    } else if (step.type === "artifact") {
      steps[`artifact:${step.name}`] = { id: `artifact:${step.name}`, type: "artifact", status: "pending" }
    }
  }
  return steps
}

export function runCapture(command: string, directory: string, maxLength: number): { ok: boolean; output: string | null; error?: string } {
  if (!/^git(\s|$)/.test(command)) return { ok: false, output: null, error: "capture 仅允许 git 命令" }
  const [bin, ...args] = command.split(/\s+/)
  const result = spawnSync(bin as string, args, { cwd: directory, encoding: "utf8", timeout: 30000, windowsHide: true })
  if (result.error) return { ok: false, output: null, error: result.error.message }
  const output = `${result.stdout ?? ""}${result.stderr ? `\n[stderr]\n${result.stderr}` : ""}`.trim()
  if ((result.status ?? 1) !== 0) {
    return { ok: false, output: truncate(output || "(无输出)", maxLength), error: `退出码 ${result.status}` }
  }
  return { ok: true, output: truncate(output || "(空)", maxLength) }
}

export class WorkflowEngine {
  private readonly runtimes = new Map<string, Runtime>()

  constructor(private readonly options: EngineOptions) {}

  private touch(runtime: Runtime): void {
    runtime.record.updatedAt = Date.now()
    this.options.store.save(runtime.record)
    this.options.onUpdate?.(runtime.record)
  }

  private event(runtime: Runtime, event: Record<string, unknown>): void {
    this.options.store.event(runtime.record.id, event)
  }

  private scope(runtime: Runtime): InterpolationScope {
    const steps: Record<string, { output?: string | null }> = {}
    for (const [id, state] of Object.entries(runtime.record.steps)) steps[id] = { output: state.output ?? null }
    return { inputs: runtime.record.inputs, steps }
  }

  private warnMissing(runtime: Runtime, id: string, missing: string[]): void {
    if (!missing.length) return
    this.event(runtime, { type: "task.template-missing", id, refs: missing })
    this.options.log?.(`task ${id} 存在未解析模板: ${missing.join(", ")}`)
  }

  private gate(runtime: Runtime): Promise<void> {
    if (!runtime.paused || runtime.stopped) return Promise.resolve()
    return new Promise<void>((resolve) => runtime.waiters.push(resolve))
  }

  private drain(runtime: Runtime): void {
    runtime.waiters.splice(0).forEach((resolve) => resolve())
  }

  private markPending(runtime: Runtime): void {
    for (const state of Object.values(runtime.record.steps)) {
      if (state.status === "pending") state.status = "skipped"
      else if (state.status === "running") state.status = "failed"
    }
  }

  private summaryOf(record: RunRecord): string | null {
    const order = record.capsule.steps
      .map((step) => (step.type === "agent" || step.type === "synthesize" ? step.id : step.type === "parallel" ? step.tasks[step.tasks.length - 1]?.id : null))
      .filter((value): value is string => typeof value === "string")
    for (const id of [...order].reverse()) {
      const output = record.steps[id]?.output
      if (output) return truncate(output, 6000)
    }
    return null
  }

  async start(capsule: Capsule, options: StartOptions = {}): Promise<RunRecord> {
    const resolution = resolveInputs(capsule, options.inputs)
    if (resolution.errors.length) throw new Error(`输入校验失败: ${resolution.errors.join("; ")}`)
    const id = options.runId ?? runId()
    const record: RunRecord = {
      id,
      name: capsule.name,
      status: "running",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      directory: this.options.directory,
      parentSessionID: options.parentSessionID,
      inputs: resolution.values,
      capsule,
      phases: [],
      steps: initializeSteps(capsule),
      summary: null,
      error: null,
      agentsUsed: 0,
    }
    const runtime: Runtime = { record, paused: false, stopped: false, waiters: [], active: new Set(), cacheFrom: options.cacheFrom }
    this.options.store.create(record)
    this.runtimes.set(id, runtime)
    this.event(runtime, { type: "run.started", name: record.name })
    runtime.done = this.execute(runtime)
    if (options.wait) return runtime.done
    return record
  }

  private async execute(runtime: Runtime): Promise<RunRecord> {
    const capsule = runtime.record.capsule
    const log = this.options.log ?? (() => {})
    const concurrency = capsule.limits?.maxConcurrency ?? this.options.maxConcurrency ?? 4
    const semaphore = new Semaphore(concurrency)
    try {
      for (const step of capsule.steps) {
        if (runtime.stopped) break
        await this.gate(runtime)
        if (runtime.stopped) break
        switch (step.type) {
          case "phase": {
            runtime.record.phases.push({ name: step.name, startedAt: Date.now() })
            this.event(runtime, { type: "phase.started", name: step.name })
            this.touch(runtime)
            break
          }
          case "log": {
            const id = `log:${runtime.record.phases.length}:${shortHash(step.message)}`
            runtime.record.steps[id] = { id, type: "log", status: "completed", output: step.message, startedAt: Date.now(), endedAt: Date.now() }
            this.touch(runtime)
            break
          }
          case "capture": {
            const state = (runtime.record.steps[step.id] ??= { id: step.id, type: "capture", status: "pending" })
            state.status = "running"
            state.startedAt = Date.now()
            this.touch(runtime)
            const result = runCapture(step.command, this.options.directory, step.maxLength ?? 30000)
            state.endedAt = Date.now()
            state.output = result.output
            state.status = result.ok ? "completed" : "failed"
            if (!result.ok) state.error = result.error
            this.event(runtime, { type: "capture.finished", id: step.id, ok: result.ok })
            this.touch(runtime)
            if (!result.ok) throw new Error(`capture 失败 (${step.id}): ${result.error ?? "unknown"}`)
            break
          }
          case "agent": {
            const resolved = interpolate(step.prompt, this.scope(runtime))
            this.warnMissing(runtime, step.id, resolved.missing)
            await this.runTask(runtime, semaphore, {
              id: step.id,
              prompt: resolved.text,
              agent: step.agent,
              model: step.model,
              readOnly: step.readOnly,
            })
            break
          }
          case "parallel": {
            const scope = this.scope(runtime)
            const tasks: AgentTask[] = step.tasks.map((task) => {
              const resolved = interpolate(task.prompt, scope)
              this.warnMissing(runtime, task.id, resolved.missing)
              return { id: task.id, prompt: resolved.text, agent: task.agent, model: task.model, readOnly: task.readOnly, title: task.title }
            })
            const local = new Semaphore(step.concurrency ?? concurrency)
            const results = await Promise.all(
              tasks.map(async (task) => {
                const release = await local.acquire()
                try {
                  return await this.runTask(runtime, semaphore, task)
                } finally {
                  release()
                }
              }),
            )
            const failed = results.find((state) => state.status === "failed")
            if (failed && !runtime.stopped) throw new Error(`并行任务失败: ${failed.id} (${failed.error ?? "unknown"})`)
            break
          }
          case "synthesize": {
            let prompt = step.prompt
            if (step.from?.length && !step.prompt.includes("{{steps.")) {
              const chunks: string[] = []
              for (const fromId of step.from) {
                const source = runtime.record.steps[fromId]
                if (source?.output) chunks.push(`=== ${fromId} ===\n${source.output}`)
              }
              if (chunks.length) prompt += `\n\n${chunks.join("\n\n")}`
            }
            const resolved = interpolate(prompt, this.scope(runtime))
            this.warnMissing(runtime, step.id, resolved.missing)
            await this.runTask(runtime, semaphore, { id: step.id, prompt: resolved.text, agent: step.agent, model: step.model })
            break
          }
          case "artifact": {
            const state = (runtime.record.steps[`artifact:${step.name}`] ??= {
              id: `artifact:${step.name}`,
              type: "artifact",
              status: "pending",
            })
            const source = runtime.record.steps[step.from]
            if (!source?.output) {
              state.status = "skipped"
              state.error = `来源步骤无输出: ${step.from}`
              this.touch(runtime)
              break
            }
            const path = this.options.store.writeArtifact(runtime.record.id, step.name, source.output)
            state.status = "completed"
            state.output = path
            state.startedAt = Date.now()
            state.endedAt = state.startedAt
            this.event(runtime, { type: "artifact.written", name: step.name, path })
            this.touch(runtime)
            break
          }
        }
      }

      if (runtime.stopped) {
        runtime.record.status = "stopped"
        this.markPending(runtime)
        this.event(runtime, { type: "run.stopped" })
      } else {
        runtime.record.status = "completed"
        runtime.record.summary = this.summaryOf(runtime.record)
        this.event(runtime, { type: "run.completed" })
        log(`run ${runtime.record.id} 完成 (agents=${runtime.record.agentsUsed})`)
      }
      this.touch(runtime)
    } catch (error) {
      if (runtime.stopped) {
        runtime.record.status = "stopped"
        this.markPending(runtime)
      } else {
        runtime.record.status = "failed"
        runtime.record.error = error instanceof Error ? error.message : String(error)
        this.markPending(runtime)
        this.event(runtime, { type: "run.failed", error: runtime.record.error })
      }
      this.touch(runtime)
    } finally {
      this.drain(runtime)
    }
    return runtime.record
  }

  private async runTask(runtime: Runtime, semaphore: Semaphore, task: AgentTask): Promise<StepState> {
    const state = (runtime.record.steps[task.id] ??= { id: task.id, type: "agent", status: "pending" })
    await this.gate(runtime)
    if (runtime.stopped) {
      if (state.status === "pending") state.status = "skipped"
      this.touch(runtime)
      return state
    }
    if (state.status === "completed" || state.status === "cached") return state

    const key = shortHash({ prompt: task.prompt, agent: task.agent ?? null, model: task.model ?? null })
    if (runtime.cacheFrom) {
      const cached = this.options.store.readResult(runtime.cacheFrom, key)
      if (cached) {
        state.status = "cached"
        state.cached = true
        state.output = cached.output
        state.startedAt = Date.now()
        state.endedAt = state.startedAt
        this.touch(runtime)
        return state
      }
    }

    const budget = this.options.maxAgents ?? 32
    if (runtime.record.agentsUsed >= budget) throw new Error(`超出 agent 预算 (${budget})`)

    const release = await semaphore.acquire()
    try {
      runtime.record.agentsUsed += 1
      state.status = "running"
      state.startedAt = Date.now()
      this.touch(runtime)
      this.event(runtime, { type: "task.started", id: task.id })

      const bridge = this.options.bridge({ parentSessionID: runtime.record.parentSessionID })
      const handle = await bridge.spawn(task)
      state.sessionID = handle.sessionID
      runtime.active.add(handle)
      this.touch(runtime)

      const result = await handle.wait()
      runtime.active.delete(handle)
      state.endedAt = Date.now()
      state.output = result.output
      if (result.status === "completed") {
        state.status = "completed"
        this.options.store.writeResult(runtime.record.id, key, { output: result.output })
      } else {
        state.status = "failed"
        state.error = "子代理失败或中断"
      }
      this.event(runtime, { type: "task.finished", id: task.id, status: state.status })
      this.touch(runtime)
      return state
    } finally {
      release()
    }
  }

  pause(id: string): boolean {
    const runtime = this.runtimes.get(id)
    if (!runtime || runtime.record.status === "completed" || runtime.record.status === "failed" || runtime.record.status === "stopped") return false
    runtime.paused = true
    runtime.record.status = "paused"
    this.event(runtime, { type: "run.paused" })
    this.touch(runtime)
    return true
  }

  resume(id: string): boolean {
    const runtime = this.runtimes.get(id)
    if (!runtime || !runtime.paused) return false
    runtime.paused = false
    runtime.record.status = "running"
    this.event(runtime, { type: "run.resumed" })
    this.touch(runtime)
    this.drain(runtime)
    return true
  }

  stop(id: string): boolean {
    const runtime = this.runtimes.get(id)
    if (!runtime) return false
    runtime.stopped = true
    runtime.paused = false
    this.event(runtime, { type: "run.stop-requested" })
    for (const handle of runtime.active) void handle.interrupt()
    this.drain(runtime)
    return true
  }

  show(id: string): RunRecord | null {
    return this.runtimes.get(id)?.record ?? this.options.store.load(id)
  }

  latest(): RunRecord | null {
    return this.options.store.list(1)[0] ?? null
  }

  async wait(id: string): Promise<RunRecord | null> {
    const runtime = this.runtimes.get(id)
    if (runtime?.done) return runtime.done
    return this.options.store.load(id)
  }

  async rerun(input: { runId?: string; inputs?: Record<string, unknown>; wait?: boolean }): Promise<RunRecord> {
    const source = input.runId ? this.show(input.runId) : this.latest()
    if (!source) throw new Error("找不到可重跑的 run")
    return this.start(source.capsule, { inputs: input.inputs ?? source.inputs, wait: input.wait })
  }

  async resumeRun(input: { runId: string; wait?: boolean }): Promise<RunRecord> {
    const source = this.show(input.runId)
    if (!source) throw new Error(`找不到 run: ${input.runId}`)
    return this.start(source.capsule, { inputs: source.inputs, cacheFrom: source.id, wait: input.wait })
  }

  async startByName(catalogEntries: readonly { name: string; capsule: Capsule }[], name: string, options: StartOptions = {}): Promise<RunRecord> {
    const entry = catalogEntries.find((item) => item.name === name)
    if (!entry) throw new Error(`未知 workflow: ${name}`)
    return this.start(entry.capsule, options)
  }
}

export function summarizeRun(record: RunRecord): Record<string, unknown> {
  return {
    id: record.id,
    name: record.name,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    agentsUsed: record.agentsUsed,
    phases: record.phases.map((phase) => phase.name),
    steps: Object.fromEntries(Object.entries(record.steps).map(([id, state]) => [id, { status: state.status, cached: state.cached ?? false, error: state.error }])),
    summary: record.summary,
    error: record.error,
  }
}
