// 脚本治理 — 识别"模型跑起来的小脚本"并判定是否越界。
//
// 与 MCP 归因的区别:
//   • MCP: 已知启动模式的服务器进程树 → 由 perf_cleanup 处理
//   • 脚本: 模型经 shell 工具跑出来的 node/python/bun/pwsh, 可能:
//       - 占用过高（CPU/内存）把机器拖卡
//       - 工具调用早已结束、进程还在跑（模型忘了）
//
// 归因方式: 工具 hook 记录 (sessionID, command) → 与进程命令行做 token 匹配。

import { categoryOf, isRuntime, isService, linkState, type ProcInfo } from "./processes"

export interface ScriptThresholds {
  /** 单采样周期内平均 CPU 占用（% of 单核）超过即告警。 */
  readonly cpuPercent: number
  /** 常驻内存（MB）超过即告警。 */
  readonly memoryMB: number
  /** 运行时长（ms）超过即视为"忘了"。 */
  readonly maxRuntimeMs: number
  /** 小于该年龄的进程忽略（避免误伤刚启动的任务）。 */
  readonly minAgeMs: number
  /** 同一 PID 两次询问的最小间隔。 */
  readonly askCooldownMs: number
  /** script_keep 的默认静默时长。 */
  readonly keepMs: number
}

export const DEFAULT_SCRIPT_THRESHOLDS: ScriptThresholds = {
  cpuPercent: 70,
  memoryMB: 1200,
  maxRuntimeMs: 10 * 60_000,
  minAgeMs: 10_000,
  askCooldownMs: 10 * 60_000,
  keepMs: 30 * 60_000,
}

export interface CommandRecord {
  readonly sessionID: string
  readonly tool: string
  readonly command: string
  readonly at: number
  /** 工具调用结束时间（execute.after 写入）。 */
  endedAt?: number
  /** 工具调用 id（execute.before/after 关联）。 */
  readonly callID?: string
}

export interface ScriptCandidate {
  readonly pid: number
  readonly ppid: number
  readonly name: string
  readonly cmd: string
  readonly mb: number
  readonly cpuPercent: number
  readonly ageMs: number
  readonly link: "service" | "dead"
  readonly reason: readonly string[]
  readonly sessionID?: string
  readonly tool?: string
  readonly command?: string
  /** 发起它的工具调用是否已结束（true = 脱离工具调用的后台残留）。 */
  readonly toolFinished?: boolean
}

const COLLECTOR_RE = /Win32_Process|Get-CimInstance/i

/** 采集器自身（我们每轮跑的 PowerShell CIM 命令）不参与治理。 */
export function isCollectorProcess(proc: ProcInfo): boolean {
  return /^(powershell|pwsh)(\.exe)?$/i.test(proc.name) && COLLECTOR_RE.test(proc.cmd)
}

/** 两次采样 → 每 PID 的 CPU 占用（单核为 100%; 多线程脚本可超过 100%）。 */
export function computeCpuPercents(
  previous: readonly ProcInfo[],
  current: readonly ProcInfo[],
  elapsedMs: number,
  cores: number,
): Map<number, number> {
  const out = new Map<number, number>()
  if (elapsedMs <= 0 || cores <= 0) return out
  const before = new Map(previous.map((proc) => [proc.pid, proc]))
  for (const proc of current) {
    const prior = before.get(proc.pid)
    if (prior?.cpuTimeMs === undefined || proc.cpuTimeMs === undefined) continue
    const delta = proc.cpuTimeMs - prior.cpuTimeMs
    if (delta < 0) continue
    const percent = (delta / elapsedMs) * 100
    out.set(proc.pid, Math.round(Math.min(100 * cores, Math.max(0, percent)) * 10) / 10)
  }
  return out
}

const TOKEN_SKIP = new Set([
  "node", "node.exe", "python", "python.exe", "python3", "bun", "bun.exe", "pwsh", "powershell", "cmd", "cmd.exe",
  "script", "filepath", "argumentlist", "start-process", "pass", "thru", "true", "false", "select", "object",
  "const", "while", "push", "array", "string", "null", "undefined", "return", "print", "import", "from", "export",
])

export function commandTokens(command: string): string[] {
  return command
    .split(/[\s"']+/)
    .map((token) => token.replace(/^[^A-Za-z0-9_./\\-]+/, "").replace(/[^A-Za-z0-9_./\\-]+$/, ""))
    .filter((token) => token.length >= 4 && !token.startsWith("-") && !TOKEN_SKIP.has(token.toLowerCase()))
}

/** 进程命令行与"最近执行的命令"做 token 匹配, 命中更新者优先。 */
export function matchCommand(proc: ProcInfo, commands: readonly CommandRecord[]): CommandRecord | undefined {
  const haystack = proc.cmd.toLowerCase()
  if (!haystack) return undefined
  const ordered = [...commands].sort((a, b) => b.at - a.at)
  for (const record of ordered) {
    for (const token of commandTokens(record.command)) {
      if (haystack.includes(token.toLowerCase())) return record
    }
  }
  return undefined
}

export interface FindOptions {
  readonly commands?: readonly CommandRecord[]
  readonly cpu?: ReadonlyMap<number, number>
  readonly thresholds?: ScriptThresholds
  readonly now?: number
}

/** 找出需要治理的脚本进程（服务子进程 / 孤儿 + 非 MCP + 非采集器 + 匹配到命令或明显是脚本）。 */
export function findCandidates(procs: readonly ProcInfo[], options: FindOptions = {}): ScriptCandidate[] {
  const thresholds = options.thresholds ?? DEFAULT_SCRIPT_THRESHOLDS
  const now = options.now ?? Date.now()
  const commands = options.commands ?? []
  const cpu = options.cpu ?? new Map<number, number>()
  const out: ScriptCandidate[] = []

  for (const proc of procs) {
    if (!isRuntime(proc.name) && !/^(pwsh)(\.exe)?$/i.test(proc.name)) continue
    if (isService(proc.name) || isCollectorProcess(proc)) continue
    if (categoryOf(proc.cmd)) continue // MCP 交给 perf_cleanup
    if (/opencode-cli|opencode\.exe/i.test(proc.cmd)) continue

    const link = linkState(procs, proc.pid)
    if (link !== "service" && link !== "dead") continue

    const matched = matchCommand(proc, commands)
    // 孤儿进程必须能匹配到命令（否则可能是别的工具留下的, 不主动管）
    if (link === "dead" && !matched) continue

    const ageMs = proc.startMs && proc.startMs > 0 ? Math.max(0, now - proc.startMs) : 0
    if (ageMs < thresholds.minAgeMs) continue

    const cpuPercent = cpu.get(proc.pid) ?? 0
    const reason: string[] = []
    if (cpuPercent >= thresholds.cpuPercent) reason.push("cpu")
    if (proc.mb >= thresholds.memoryMB) reason.push("memory")
    if (ageMs >= thresholds.maxRuntimeMs) reason.push("age")
    if (!reason.length) continue

    out.push({
      pid: proc.pid,
      ppid: proc.ppid,
      name: proc.name,
      cmd: truncateCmd(proc.cmd),
      mb: proc.mb,
      cpuPercent,
      ageMs,
      link: link === "dead" ? "dead" : "service",
      reason,
      ...(matched ? { sessionID: matched.sessionID, tool: matched.tool, command: truncateCmd(matched.command), toolFinished: matched.endedAt !== undefined } : {}),
    })
  }
  return out.sort((a, b) => b.cpuPercent - a.cpuPercent || b.mb - a.mb)
}

function truncateCmd(value: string): string {
  return value.length > 300 ? `${value.slice(0, 300)}…` : value
}

export function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  return `${Math.round(ms / 3_600_000)}h`
}

export function buildAskMessage(script: ScriptCandidate): string {
  const reasons = script.reason
    .map((reason) => (reason === "cpu" ? `CPU ${script.cpuPercent}%` : reason === "memory" ? `内存 ${script.mb}MB` : `已运行 ${formatAge(script.ageMs)}`))
    .join(" / ")
  const lines = [
    "⚠️ oc-perf-guard 资源告警：之前由你启动的脚本还在运行且占用偏高。",
    "",
    `- PID ${script.pid}  ${script.name}  ${reasons}`,
    `- 命令行: ${script.cmd}`,
    ...(script.command ? [`- 关联命令: ${script.command}`] : []),
    ...(script.link === "dead" ? ["- 注意: 发起它的 shell 已经结束（可能是忘了收尾的后台脚本）"] : []),
    "",
    "请判断这个脚本是否还需要：",
    `- 不需要 → 调用 script_kill(pid=${script.pid}) 关掉它（会终止整棵进程树）`,
    `- 需要但占用太高 → 先调用 script_nice(pid=${script.pid}, level=\"idle\") 降优先级，并给出降低占用/分片运行的优化建议（例如减小 batch、限制线程数、加限速或改为增量执行）`,
    `- 确认长期保留 → 调用 script_keep(pid=${script.pid}, minutes=30) 让我在 30 分钟内不再打扰`,
    "",
    "（本条为自动资源治理询问，无需回复客套话，直接处理即可。）",
  ]
  return lines.join("\n")
}
