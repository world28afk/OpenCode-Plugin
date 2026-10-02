// 服务端挂载 — 性能守卫（v0.2）:
//   A. MCP 进程治理: perf_processes / perf_cleanup（服务子锚点整树终止, dryRun 默认）
//   B. 运行期脚本治理: 工具 hook 归属 (sessionID, command) → 周期采样 CPU/内存/时长
//      → 超阈值时**向会话内的模型提问**（还用吗？不用就 script_kill；要用就 script_nice + 优化建议）
//   C. 周期监视: MCP 阈值告警 + 脚本告警事件（RPC 推送）
//
// 依赖注入: createMount(deps) 允许测试替换采集器/终止器/提问通道/时钟。

import { execFileSync } from "node:child_process"
import { cpus } from "node:os"
import type { Plugin } from "@opencode/plugin"
import { ScriptGovernor, type KillResult } from "./governor"
import {
  collectProcsWindows,
  executeCleanup,
  planCleanup,
  resetSnapshotCache,
  snapshot,
  taskkillRunner,
  type KillRunner,
  type ProcInfo,
  type SnapshotOptions,
} from "./processes"
import { PerfGuard } from "./rpc"
import { computeCpuPercents, DEFAULT_SCRIPT_THRESHOLDS, findCandidates, type CommandRecord, type ScriptThresholds } from "./scripts"

export const PLUGIN_ID = "oc-perf-guard"
export const PLUGIN_VERSION = "0.2.0"

export interface PerfDeps {
  /** 采集进程列表（默认 PowerShell CIM; 测试注入 fixture） */
  readonly collect?: () => readonly ProcInfo[]
  /** 终止执行器（默认 taskkill; 测试注入记录器） */
  readonly runner?: KillRunner
  /** 治理通知通道（默认 ctx.session.synthetic, 不依赖会话空闲; 可选再补一条 prompt） */
  readonly notify?: (sessionID: string, text: string, level: "action" | "notify") => Promise<void>
  /** 调整进程优先级（默认 PowerShell PriorityClass） */
  readonly nice?: (pid: number, level: string) => KillResult
  readonly now?: () => number
}

interface ScriptsOptions {
  enabled?: boolean
  intervalMs?: number
  /** auto = Laya 式判定并执行; notify = 只通知。 */
  mode?: "auto" | "notify"
  cpuPercent?: number
  memoryMB?: number
  maxRuntimeMs?: number
  minAgeMs?: number
  askCooldownMs?: number
  keepMs?: number
  /** 兼容旧配置: ask:false 等价于 mode:"notify"。 */
  ask?: boolean
  /** 除 synthetic 通知外, 再尽力发一条 prompt（会话忙碌时可能排队不达）。 */
  notifyPrompt?: boolean
  maxAsksPerHour?: number
  maxActionsPerHour?: number
  /** kill 前的宽限期（先降优先级）。 */
  graceMs?: number
  /** 内存硬线。 */
  memoryKillMB?: number
  /** 低于该 CPU 视为空闲。 */
  idleCpuPercent?: number
  /** 同 PID 两次动作的最小间隔。 */
  actionCooldownMs?: number
}

function hasFunction(value: unknown, key: string): boolean {
  return !!value && typeof (value as Record<string, unknown>)[key] === "function"
}

/** 从工具输入里提取命令行（shell/bash/exec 类工具的 command/cmd/script 字段）。 */
export function extractCommand(input: unknown): string | null {
  if (!input || typeof input !== "object") return null
  const record = input as Record<string, unknown>
  for (const key of ["command", "cmd", "script"]) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) return value
    if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string")) return value.join(" ")
  }
  return null
}

const NICE_LEVELS: Record<string, string> = {
  idle: "Idle",
  "below-normal": "BelowNormal",
  normal: "Normal",
  "above-normal": "AboveNormal",
  high: "High",
}

export function createMount(deps: PerfDeps = {}) {
  return async function mount(ctx: Plugin.Context): Promise<() => Promise<void> | void> {
    const options = (ctx.options ?? {}) as {
      warnAt?: number
      serviceWarnMB?: number
      intervalMs?: number
      scripts?: ScriptsOptions
    }
    const warnAt = typeof options.warnAt === "number" ? options.warnAt : 60
    const serviceWarnMB = typeof options.serviceWarnMB === "number" ? options.serviceWarnMB : 1200
    const intervalMs = typeof options.intervalMs === "number" ? options.intervalMs : 120_000

    const scriptOptions = options.scripts ?? {}
    const scriptsEnabled = scriptOptions.enabled !== false
    const scriptIntervalMs = typeof scriptOptions.intervalMs === "number" ? Math.max(5_000, scriptOptions.intervalMs) : 30_000
    const scriptMode: "auto" | "notify" = scriptOptions.mode === "notify" || scriptOptions.ask === false ? "notify" : "auto"
    const notifyPrompt = scriptOptions.notifyPrompt === true
    const scriptGraceMs = typeof scriptOptions.graceMs === "number" ? Math.max(1_000, scriptOptions.graceMs) : 120_000
    const scriptMemoryKillMB = typeof scriptOptions.memoryKillMB === "number" ? scriptOptions.memoryKillMB : undefined
    const scriptIdleCpu = typeof scriptOptions.idleCpuPercent === "number" ? scriptOptions.idleCpuPercent : 5
    const thresholds: ScriptThresholds = {
      cpuPercent: typeof scriptOptions.cpuPercent === "number" ? scriptOptions.cpuPercent : DEFAULT_SCRIPT_THRESHOLDS.cpuPercent,
      memoryMB: typeof scriptOptions.memoryMB === "number" ? scriptOptions.memoryMB : DEFAULT_SCRIPT_THRESHOLDS.memoryMB,
      maxRuntimeMs: typeof scriptOptions.maxRuntimeMs === "number" ? scriptOptions.maxRuntimeMs : DEFAULT_SCRIPT_THRESHOLDS.maxRuntimeMs,
      minAgeMs: typeof scriptOptions.minAgeMs === "number" ? scriptOptions.minAgeMs : DEFAULT_SCRIPT_THRESHOLDS.minAgeMs,
      askCooldownMs: typeof scriptOptions.askCooldownMs === "number" ? scriptOptions.askCooldownMs : DEFAULT_SCRIPT_THRESHOLDS.askCooldownMs,
      keepMs: typeof scriptOptions.keepMs === "number" ? scriptOptions.keepMs : DEFAULT_SCRIPT_THRESHOLDS.keepMs,
    }

    const base: SnapshotOptions = { warnAt, serviceWarnMB }
    const getProcs = (): readonly ProcInfo[] => (deps.collect ? deps.collect() : collectProcsWindows())
    const status = (force = false) => snapshot({ ...base, force, procs: deps.collect ? getProcs() : undefined })

    const json = <T,>(value: T): T => JSON.parse(JSON.stringify(value))
    const log = (message: string) => console.info(`[${PLUGIN_ID}] ${message}`)
    const registrations: Array<{ dispose: () => Promise<void> }> = []
    let rpcRegistration: { events?: { emit?: (name: string, data: unknown) => Promise<void> } } | null = null
    let warnTimer: ReturnType<typeof setInterval> | null = null
    let scriptTimer: ReturnType<typeof setInterval> | null = null

    const emitWarning = (data: unknown) => {
      try {
        void rpcRegistration?.events?.emit?.("warning", json(data)).catch?.(() => {})
      } catch {
        // ignore
      }
    }

    // ── A. MCP 清理 ──────────────────────────────────────────────────────────

    const cleanup = (target: string, dryRun: boolean) => {
      const procs = getProcs()
      const plan = planCleanup(procs, target)
      const result = executeCleanup(plan, dryRun, deps.runner)
      if (!dryRun) resetSnapshotCache()
      return result
    }

    // ── B. 脚本治理 ─────────────────────────────────────────────────────────

    const commands: CommandRecord[] = []
    let previousProcs: readonly ProcInfo[] = []
    let previousAt = 0
    const cores = Math.max(1, cpus().length)

    const notifyModel =
      deps.notify ??
      (async (sessionID: string, text: string, level: "action" | "notify") => {
        // synthetic 消息是持久化写入, 不依赖会话空闲（会话忙碌时 prompt 投递可能到不了模型）
        await ctx.session.synthetic({ sessionID, text, description: `perf-guard:${level}` })
        if (notifyPrompt) {
          try {
            await ctx.session.prompt({ sessionID, text, delivery: "queue" })
          } catch {
            // 会话忙碌/不可达: 已有 synthetic 兜底
          }
        }
      })

    const niceRunner =
      deps.nice ??
      ((pid: number, level: string): KillResult => {
        const priority = NICE_LEVELS[level] ?? "Idle"
        try {
          const output = execFileSync(
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-Command", `$p=Get-Process -Id ${pid} -ErrorAction Stop; $p.PriorityClass='${priority}'; Write-Output $p.PriorityClass`],
            { encoding: "utf8", timeout: 15000, windowsHide: true },
          )
          return { ok: true, output: output.trim() }
        } catch (error) {
          return { ok: false, output: error instanceof Error ? error.message : String(error) }
        }
      })

    const killRunner = deps.runner ?? taskkillRunner
    const governor = new ScriptGovernor({
      thresholds,
      mode: scriptMode,
      graceMs: scriptGraceMs,
      memoryKillMB: scriptMemoryKillMB ?? thresholds.memoryMB * 2,
      idleCpuPercent: scriptIdleCpu,
      ...(deps.now ? { now: deps.now } : {}),
      log,
      notify: notifyModel,
      kill: (pid) => {
        const result = killRunner(pid, true)
        return { ok: result.ok, output: result.output }
      },
      nice: niceRunner,
      onAction: (record) => emitWarning(json({ type: "script.action", record })),
      ...(typeof scriptOptions.actionCooldownMs === "number" ? { actionCooldownMs: scriptOptions.actionCooldownMs } : {}),
      maxActionsPerHour:
        typeof scriptOptions.maxActionsPerHour === "number"
          ? scriptOptions.maxActionsPerHour
          : typeof scriptOptions.maxAsksPerHour === "number"
            ? scriptOptions.maxAsksPerHour
            : 10,
    })

    const evaluateScripts = () => {
      const sampledAt = Date.now()
      const procs = getProcs()
      const elapsed = previousAt > 0 ? sampledAt - previousAt : 0
      const cpu = previousAt > 0 ? computeCpuPercents(previousProcs, procs, elapsed, cores) : new Map<number, number>()
      previousProcs = procs
      previousAt = sampledAt
      const candidates = findCandidates(procs, { commands, cpu, thresholds, now: sampledAt })
      const result = governor.observe(candidates)
      return { candidates, result, sampledAt }
    }

    const scriptPayload = () => ({
      enabled: scriptsEnabled,
      mode: scriptMode,
      graceMs: scriptGraceMs,
      thresholds,
      memoryKillMB: scriptMemoryKillMB ?? thresholds.memoryMB * 2,
      commandsTracked: commands.length,
      tracking: governor.list().map((entry) => ({
        pid: entry.pid,
        name: entry.name,
        cmd: entry.cmd,
        mb: entry.mb,
        cpuPercent: entry.cpuPercent,
        ageMs: entry.ageMs,
        reason: entry.reason,
        link: entry.link,
        toolFinished: entry.toolFinished ?? null,
        state: entry.state,
        sessionID: entry.sessionID ?? null,
        tool: entry.tool ?? null,
        alerts: entry.alerts,
        verdict: entry.verdict ? { action: entry.verdict.action, severity: entry.verdict.severity, kind: entry.verdict.kind, reasons: entry.verdict.reasons } : null,
        graceUntil: entry.graceUntil ?? null,
        keepUntil: entry.keepUntil ?? null,
      })),
      actions: governor.listActions(10),
      actionsLastHour: governor.actionCount,
    })

    // 工具 hook: 记录 (sessionID, command) 供脚本归因
    if (ctx.tool && hasFunction(ctx.tool, "hook")) {
      try {
        registrations.push(
          await ctx.tool.hook("execute.before", async (input) => {
            const command = extractCommand(input?.input)
            if (!command) return
            commands.unshift({ sessionID: input.sessionID, tool: input.tool, command, at: Date.now(), callID: input.id })
            if (commands.length > 100) commands.length = 100
          }),
        )
        registrations.push(
          await ctx.tool.hook("execute.after", async (input) => {
            const callID = input?.id
            if (!callID) return
            const record = commands.find((entry) => entry.callID === callID)
            if (record) record.endedAt = Date.now()
          }),
        )
      } catch (error) {
        log(`tool hook register failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    // ── 工具 ────────────────────────────────────────────────────────────────

    if (hasFunction(ctx.tool, "transform")) {
      registrations.push(
        await ctx.tool.transform((editor) => {
          editor.add({
            name: "perf_processes",
            description:
              "OpenCode 性能快照: 按 MCP 服务器归因 node/python/bun 子进程数量与内存, 并给出阈值告警。",
            input: {
              type: "object",
              properties: { force: { type: "boolean", description: "跳过 10s 缓存强制重新采集" } },
              additionalProperties: false,
            },
            execute: async (input) => ({ content: JSON.stringify(status(!!(input as { force?: boolean })?.force), null, 2) }),
          })
          editor.add({
            name: "perf_cleanup",
            description:
              "清理 MCP 子进程树（默认 dryRun:true 只预演）。target: all-mcp | orphans | 分类名（jshook/memory/roxybrowser/ida-mcp/cyberchef/fetch/exa/sequential-thinking）。",
            input: {
              type: "object",
              properties: {
                target: { type: "string", description: "all-mcp | orphans | 分类名" },
                dryRun: { type: "boolean", description: "默认 true; 传 false 才会真正终止" },
              },
              additionalProperties: false,
            },
            execute: async (input) => {
              const value = (input ?? {}) as { target?: string; dryRun?: boolean }
              return { content: JSON.stringify(cleanup(value.target ?? "orphans", value.dryRun === false ? false : true), null, 2) }
            },
          })
          editor.add({
            name: "script_list",
            description:
              "列出正在跑的脚本进程（模型经 shell 启动的 node/python/bun/pwsh）及 CPU/内存/时长/告警原因, 并给出 Laya 式判定与已执行动作（降优先级/终止/保留）。会触发一次实时采样与治理评估。",
            input: { type: "object", properties: {}, additionalProperties: false },
            execute: async () => {
              if (!scriptsEnabled) return { content: JSON.stringify({ enabled: false }, null, 2) }
              const { candidates, result } = evaluateScripts()
              return {
                content: JSON.stringify(
                  {
                    enabled: true,
                    mode: scriptMode,
                    thresholds,
                    alerts: result.alerts.map((alert) => ({
                      pid: alert.pid,
                      reason: alert.reason,
                      cpuPercent: alert.cpuPercent,
                      mb: alert.mb,
                      ageMs: alert.ageMs,
                      verdict: result.tracked.find((entry) => entry.pid === alert.pid)?.verdict ?? null,
                    })),
                    candidates: candidates.map((candidate) => ({
                      pid: candidate.pid,
                      name: candidate.name,
                      cmd: candidate.cmd,
                      mb: candidate.mb,
                      cpuPercent: candidate.cpuPercent,
                      ageMs: candidate.ageMs,
                      reason: candidate.reason,
                      link: candidate.link,
                      toolFinished: candidate.toolFinished ?? null,
                      sessionID: candidate.sessionID ?? null,
                    })),
                    tracking: scriptPayload().tracking,
                    actions: scriptPayload().actions,
                  },
                  null,
                  2,
                ),
              }
            },
          })
          editor.add({
            name: "script_kill",
            description: "终止指定脚本进程树（资源治理询问后的动作）。",
            input: { type: "object", properties: { pid: { type: "number" } }, required: ["pid"], additionalProperties: false },
            execute: async (input) => {
              const pid = Number((input as { pid: number }).pid)
              const result = governor.kill(pid)
              emitWarning({ type: "script.killed", pid, ok: result.ok })
              return { content: JSON.stringify(result, null, 2) }
            },
          })
          editor.add({
            name: "script_keep",
            description: "确认保留脚本: 在 N 分钟内不再对其发起资源治理询问（默认 30 分钟）。",
            input: {
              type: "object",
              properties: { pid: { type: "number" }, minutes: { type: "number" } },
              required: ["pid"],
              additionalProperties: false,
            },
            execute: async (input) => {
              const value = input as { pid: number; minutes?: number }
              return { content: JSON.stringify(governor.keep(Number(value.pid), value.minutes), null, 2) }
            },
          })
          editor.add({
            name: "script_nice",
            description: '把脚本进程优先级下调以减少抢占（level: idle | below-normal | normal，默认 idle）。用于"需要保留但要降低占用"的场景。',
            input: {
              type: "object",
              properties: { pid: { type: "number" }, level: { type: "string" } },
              required: ["pid"],
              additionalProperties: false,
            },
            execute: async (input) => {
              const value = input as { pid: number; level?: string }
              return { content: JSON.stringify(governor.nice(Number(value.pid), value.level ?? "idle"), null, 2) }
            },
          })
        }),
      )
    }

    // ── RPC ─────────────────────────────────────────────────────────────────

    if (hasFunction(ctx.rpc, "register")) {
      try {
        rpcRegistration = (await ctx.rpc.register(PerfGuard, {
          status: async (input: unknown) =>
            json({
              ...status(!!(input as { force?: boolean })?.force),
              scripts: scriptsEnabled ? scriptPayload() : { enabled: false },
            }),
          cleanup: async (input: unknown) => {
            const value = (input ?? {}) as { target?: string; dryRun?: boolean }
            return json(cleanup(value.target ?? "orphans", value.dryRun === false ? false : true))
          },
          scripts: async (input: unknown) => {
            if (!scriptsEnabled) return json({ enabled: false })
            const evaluate = (input as { evaluate?: boolean })?.evaluate !== false
            const payload = evaluate ? evaluateScripts() : { candidates: [], result: { alerts: [], tracked: governor.list() }, sampledAt: Date.now() }
            return json({
              enabled: true,
              sampledAt: payload.sampledAt,
              thresholds,
              alerts: payload.result.alerts,
              candidates: payload.candidates,
              tracking: scriptPayload().tracking,
            })
          },
          scriptKill: async (input: unknown) => json(governor.kill(Number((input as { pid: number }).pid))),
          scriptKeep: async (input: unknown) => {
            const value = input as { pid: number; minutes?: number }
            return json(governor.keep(Number(value.pid), value.minutes))
          },
          scriptNice: async (input: unknown) => {
            const value = input as { pid: number; level?: string }
            return json(governor.nice(Number(value.pid), value.level ?? "idle"))
          },
        })) as typeof rpcRegistration
        if (rpcRegistration) registrations.push(rpcRegistration as unknown as { dispose: () => Promise<void> })
      } catch (error) {
        console.warn(`[${PLUGIN_ID}] rpc register failed:`, error instanceof Error ? error.message : String(error))
      }
    }

    // ── C. 周期监视 ─────────────────────────────────────────────────────────

    warnTimer = setInterval(() => {
      try {
        const value = status()
        if (value.warn) {
          console.warn(`[${PLUGIN_ID}] ${value.warnings.join("; ")} (进程 ${value.runtimes.count} 个 / ${value.runtimes.mb}MB)`)
          emitWarning(value)
        }
      } catch (error) {
        console.warn(`[${PLUGIN_ID}] monitor tick failed:`, error instanceof Error ? error.message : String(error))
      }
    }, intervalMs)

    if (scriptsEnabled) {
      scriptTimer = setInterval(() => {
        void (async () => {
          try {
            const { result } = evaluateScripts()
            for (const alert of result.alerts) await governor.enforce(alert)
          } catch (error) {
            console.warn(`[${PLUGIN_ID}] script tick failed:`, error instanceof Error ? error.message : String(error))
          }
        })()
      }, scriptIntervalMs)
    }

    for (const timer of [warnTimer, scriptTimer]) {
      if (timer && typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") timer.unref()
    }

    return Object.assign(
      async () => {
        if (warnTimer) clearInterval(warnTimer)
        if (scriptTimer) clearInterval(scriptTimer)
        for (const registration of registrations.reverse()) {
          await registration.dispose()
        }
      },
      {
        /** 测试用: 手动触发一次脚本评估 + 治理（生产环境由定时器驱动）。 */
        tickScripts: async () => {
          const { result } = evaluateScripts()
          for (const alert of result.alerts) await governor.enforce(alert)
          return result
        },
      },
    )
  }
}

export default { id: PLUGIN_ID, setup: createMount() }
