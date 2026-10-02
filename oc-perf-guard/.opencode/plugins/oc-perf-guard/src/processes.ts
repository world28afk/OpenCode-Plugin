// 进程快照、归因与清理计划（纯逻辑 + 可注入执行器, 便于单测）。
//
// Windows: PowerShell Get-CimInstance Win32_Process（wmic 在新系统已移除）。
// 归因: MCP 服务器进程通常挂在 opencode-cli 服务下的 cmd/npx/uvx 包装链里,
//       按命令行特征分类, 并沿父链判断“仍连接服务 / 已成孤儿”。

import { execFileSync } from "node:child_process"

export interface ProcInfo {
  readonly pid: number
  readonly ppid: number
  readonly name: string
  readonly mb: number
  readonly cmd: string
  /** 累计 CPU 时间（ms, 内核+用户态）; 采集不到时 undefined。 */
  readonly cpuTimeMs?: number
  /** 进程启动时间（epoch ms）; 采集不到时 undefined。 */
  readonly startMs?: number
}

export interface Category {
  readonly name: string
  readonly count: number
  readonly mb: number
  readonly pids: readonly number[]
}

export interface ProcAnchor {
  readonly pid: number
  readonly name: string
  readonly mb: number
  readonly cmd: string
}

export interface KillPlan {
  readonly target: string
  /** 需要整树终止的根（服务进程的直接子进程） */
  readonly roots: readonly ProcAnchor[]
  /** 已成孤儿的进程（父链中断, 可直接终止） */
  readonly orphans: readonly ProcAnchor[]
  readonly note: string
}

const CATEGORY_PATTERNS: ReadonlyArray<{ name: string; test: RegExp }> = [
  { name: "exa (mcp-remote)", test: /mcp-remote/i },
  { name: "cyberchef", test: /cyberchef/i },
  { name: "fetch (uvx)", test: /mcp-server-fetch/i },
  { name: "ida-mcp", test: /ida-mcp/i },
  { name: "jshook", test: /jshook/i },
  { name: "memory", test: /server-memory/i },
  { name: "roxybrowser", test: /roxybrowser/i },
  { name: "sequential-thinking", test: /sequential-thinking/i },
]

const RUNTIME_RE = /^(node|python|python3|bun)(\.exe)?$/i
const SERVICE_RE = /^opencode.*cli(\.exe)?$/i

export function isRuntime(name: string): boolean {
  return RUNTIME_RE.test(name)
}

export function isService(name: string): boolean {
  return SERVICE_RE.test(name)
}

export function categoryOf(cmd: string): string | null {
  const hit = CATEGORY_PATTERNS.find((pattern) => pattern.test.test(cmd))
  if (hit) return hit.name
  if (/mcp/i.test(cmd)) return "mcp (other)"
  return null
}

export function categorize(procs: readonly ProcInfo[]): Category[] {
  const map = new Map<string, { count: number; mb: number; pids: number[] }>()
  for (const proc of procs) {
    if (!isRuntime(proc.name)) continue
    const name = categoryOf(proc.cmd) ?? "other"
    const bucket = map.get(name) ?? { count: 0, mb: 0, pids: [] }
    bucket.count += 1
    bucket.mb += proc.mb
    bucket.pids.push(proc.pid)
    map.set(name, bucket)
  }
  return [...map.entries()]
    .map(([name, value]) => ({ name, count: value.count, mb: Math.round(value.mb * 10) / 10, pids: value.pids }))
    .sort((a, b) => b.mb - a.mb || b.count - a.count)
}

export function buildIndex(procs: readonly ProcInfo[]): { byPid: Map<number, ProcInfo>; children: Map<number, ProcInfo[]> } {
  const byPid = new Map<number, ProcInfo>()
  const children = new Map<number, ProcInfo[]>()
  for (const proc of procs) byPid.set(proc.pid, proc)
  for (const proc of procs) {
    const list = children.get(proc.ppid) ?? []
    list.push(proc)
    children.set(proc.ppid, list)
  }
  return { byPid, children }
}

export type LinkState = "service" | "dead" | "outside"

/** 沿父链上行: 到达服务进程 → service; 中途父 PID 不存在 → dead; 循环/超出 → outside */
export function linkState(procs: readonly ProcInfo[], pid: number): LinkState {
  const { byPid } = buildIndex(procs)
  let current = byPid.get(pid)
  const seen = new Set<number>()
  while (current && seen.size < 64) {
    if (seen.has(current.pid)) return "outside"
    seen.add(current.pid)
    const parent = byPid.get(current.ppid)
    if (!parent) return "dead"
    if (isService(parent.name)) return "service"
    current = parent
  }
  return "outside"
}

export function servicePids(procs: readonly ProcInfo[]): number[] {
  return procs.filter((proc) => isService(proc.name)).map((proc) => proc.pid)
}

/** 找到为某个被匹配进程“接管”的顶层锚点（服务进程的直接子进程） */
export function anchorFor(procs: readonly ProcInfo[], pid: number): ProcAnchor | null {
  const { byPid } = buildIndex(procs)
  let current = byPid.get(pid)
  let guard = 0
  while (current && guard < 64) {
    const parent = byPid.get(current.ppid)
    if (!parent) return null
    if (isService(parent.name)) {
      return { pid: current.pid, name: current.name, mb: current.mb, cmd: current.cmd }
    }
    current = parent
    guard += 1
  }
  return null
}

export function planCleanup(procs: readonly ProcInfo[], target: string): KillPlan {
  const wanted = target === "all-mcp"
  const matched = procs.filter((proc) => {
    if (!isRuntime(proc.name)) return false
    const category = categoryOf(proc.cmd)
    if (!category) return false
    if (wanted) return true
    return category.toLowerCase().includes(target.toLowerCase())
  })

  const roots = new Map<number, ProcAnchor>()
  const orphans = new Map<number, ProcAnchor>()

  for (const proc of matched) {
    const state = linkState(procs, proc.pid)
    if (state === "dead") {
      orphans.set(proc.pid, { pid: proc.pid, name: proc.name, mb: proc.mb, cmd: proc.cmd })
      continue
    }
    if (state !== "service") continue
    const anchor = anchorFor(procs, proc.pid)
    if (anchor) roots.set(anchor.pid, anchor)
  }

  const note =
    target === "all-mcp"
      ? "将终止全部 MCP 服务器进程树（服务会在下次需要时重新拉起）"
      : target === "orphans"
        ? "仅清理父进程已退出的孤儿 MCP 进程"
        : `将终止分类包含“${target}”的 MCP 进程树`

  if (target === "orphans") {
    return { target, roots: [], orphans: [...orphans.values()], note: "仅清理父进程已退出的孤儿 MCP 进程" }
  }
  return { target, roots: [...roots.values()], orphans: [...orphans.values()], note }
}

export type KillRunner = (pid: number, tree: boolean) => { ok: boolean; output: string }

export const taskkillRunner: KillRunner = (pid, tree) => {
  try {
    const output = execFileSync("taskkill", tree ? ["/PID", String(pid), "/T", "/F"] : ["/PID", String(pid), "/F"], {
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
    })
    return { ok: true, output: output.trim() }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, output: message }
  }
}

export interface CleanupResult {
  readonly target: string
  readonly dryRun: boolean
  readonly note: string
  readonly planned: { roots: number; orphans: number }
  readonly killed: Array<{ pid: number; name: string; ok: boolean; output: string }>
}

export function executeCleanup(plan: KillPlan, dryRun: boolean, runner: KillRunner = taskkillRunner): CleanupResult {
  const killed: Array<{ pid: number; name: string; ok: boolean; output: string }> = []
  if (!dryRun) {
    for (const anchor of plan.roots) {
      const result = runner(anchor.pid, true)
      killed.push({ pid: anchor.pid, name: anchor.name, ok: result.ok, output: result.output.split("\n")[0] ?? "" })
    }
    for (const orphan of plan.orphans) {
      const result = runner(orphan.pid, true)
      killed.push({ pid: orphan.pid, name: orphan.name, ok: result.ok, output: result.output.split("\n")[0] ?? "" })
    }
  }
  return {
    target: plan.target,
    dryRun,
    note: plan.note,
    planned: { roots: plan.roots.length, orphans: plan.orphans.length },
    killed,
  }
}

// ── 快照采集 ────────────────────────────────────────────────────────────────

export interface Snapshot {
  readonly at: number
  readonly service: { readonly pids: readonly number[]; readonly mb: number; readonly count: number }
  readonly runtimes: { readonly count: number; readonly mb: number }
  readonly categories: readonly Category[]
  readonly warn: boolean
  readonly warnings: readonly string[]
}

const SNAPSHOT_CACHE_MS = 10_000
let cache: { at: number; value: Snapshot } | null = null

export function collectProcsWindows(): ProcInfo[] {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,CommandLine,KernelModeTime,UserModeTime,@{n='StartMs';e={ try { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } catch { 0 } }} | ConvertTo-Json -Compress -Depth 2",
  ].join("; ")
  const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout: 30000,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  })
  const parsed = JSON.parse(output || "[]")
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  return rows.map((row) => ({
    pid: Number(row.ProcessId),
    ppid: Number(row.ParentProcessId),
    name: String(row.Name ?? ""),
    mb: Math.round(((Number(row.WorkingSetSize) || 0) / 1048576) * 10) / 10,
    cmd: String(row.CommandLine ?? ""),
    cpuTimeMs: (Number(row.KernelModeTime) || 0) / 10000 + (Number(row.UserModeTime) || 0) / 10000,
    startMs: Number(row.StartMs) || 0,
  }))
}

export interface SnapshotOptions {
  readonly warnAt: number
  readonly serviceWarnMB: number
  readonly force?: boolean
  readonly procs?: readonly ProcInfo[]
}

export function snapshot(options: SnapshotOptions): Snapshot {
  if (!options.force && options.procs === undefined && cache && Date.now() - cache.at < SNAPSHOT_CACHE_MS) {
    return cache.value
  }
  const procs = options.procs ?? collectProcsWindows()
  const serviceProcs = procs.filter((proc) => isService(proc.name))
  const runtimes = procs.filter((proc) => isRuntime(proc.name))
  const categories = categorize(procs)
  const warnings: string[] = []
  if (runtimes.length > options.warnAt) {
    warnings.push(`node/python/bun 进程 ${runtimes.length} 个（阈值 ${options.warnAt}）`)
  }
  const serviceMB = Math.round(serviceProcs.reduce((sum, proc) => sum + proc.mb, 0) * 10) / 10
  if (serviceMB > options.serviceWarnMB) {
    warnings.push(`服务进程内存 ${serviceMB}MB（阈值 ${options.serviceWarnMB}MB）`)
  }
  const value: Snapshot = {
    at: Date.now(),
    service: { pids: serviceProcs.map((proc) => proc.pid), mb: serviceMB, count: serviceProcs.length },
    runtimes: { count: runtimes.length, mb: Math.round(runtimes.reduce((sum, proc) => sum + proc.mb, 0) * 10) / 10 },
    categories,
    warn: warnings.length > 0,
    warnings,
  }
  if (options.procs === undefined) cache = { at: value.at, value }
  return value
}

export function resetSnapshotCache(): void {
  cache = null
}
