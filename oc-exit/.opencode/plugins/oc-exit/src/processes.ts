// 进程快照与归类（Windows）— 用于「彻底退出」前的预览与命名目标。
//
// Windows: PowerShell Get-CimInstance Win32_Process（wmic 在新系统已移除）。
// 目标分类:
//   • desktop: OpenCode.exe（Electron 桌面界面, 含 GPU/renderer 子进程）
//   • service: opencode-cli.exe（常驻后台服务/守护进程）
//   • mcp:     node/python/bun 运行的 MCP 服务器（服务进程的子进程, 通常随 /T 一并结束）

import { execFileSync } from "node:child_process"

export interface ProcInfo {
  readonly pid: number
  readonly ppid: number
  readonly name: string
  readonly mb: number
  readonly cmd: string
}

export interface ProcAnchor {
  readonly pid: number
  readonly name: string
  readonly mb: number
}

const MCP_HINT = /mcp|@modelcontextprotocol|jshook|cyberchef|mcp-server|roxybrowser|ida-mcp|sequential-thinking|deepwiki/i
const RUNTIME_RE = /^(node|python|python3|bun)(\.exe)?$/i

export function isDesktop(name: string): boolean {
  return /^OpenCode(\.exe)?$/i.test(name)
}

export function isService(name: string): boolean {
  return /^opencode.*cli(\.exe)?$/i.test(name)
}

export function isRuntime(name: string): boolean {
  return RUNTIME_RE.test(name)
}

export function isMcpCmd(cmd: string): boolean {
  return MCP_HINT.test(cmd)
}

export interface ExitTargets {
  readonly desktop: ProcAnchor[]
  readonly service: ProcAnchor[]
  readonly mcp: ProcAnchor[]
}

export function classify(procs: readonly ProcInfo[]): ExitTargets {
  const anchor = (proc: ProcInfo): ProcAnchor => ({ pid: proc.pid, name: proc.name, mb: proc.mb })
  return {
    desktop: procs.filter((proc) => isDesktop(proc.name)).map(anchor),
    service: procs.filter((proc) => isService(proc.name)).map(anchor),
    mcp: procs.filter((proc) => isRuntime(proc.name) && isMcpCmd(proc.cmd)).map(anchor),
  }
}

export function collectProcsWindows(): ProcInfo[] {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,CommandLine | ConvertTo-Json -Compress -Depth 2",
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
  }))
}

const CACHE_MS = 5_000
let cache: { at: number; value: ExitTargets } | null = null

export function targets(options: { force?: boolean; procs?: readonly ProcInfo[] } = {}): ExitTargets {
  if (!options.force && options.procs === undefined && cache && Date.now() - cache.at < CACHE_MS) return cache.value
  const procs = options.procs ?? collectProcsWindows()
  const value = classify(procs)
  if (options.procs === undefined) cache = { at: Date.now(), value }
  return value
}

export function resetCache(): void {
  cache = null
}
