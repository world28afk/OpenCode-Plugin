// 脚本处置判定 — Laya 式本地规则（照 oc-router-laya 的思路：不依赖"问模型"）。
//
// 输入: 脚本候选（CPU/内存/运行时长/命令/是否已脱离工具调用）
// 输出: 目标动作 kill | nice | keep | observe + 依据 + 优化建议
//
// 分层规则（先匹配先赢）:
//   R0 server（serve/dev/watch/bridge/proxy/tail -f/…）  → nice（长驻服务是正当的, 只降优先级）
//   R1 memory ≥ memoryKillMB                          → kill（避免 OOM）
//   R2 cpu ≥ cpuPercent 且非长任务型                   → kill（死循环/高占用脚本）
//   R3 long-job（build/test/train/install/…）          → nice（正当长任务, 不终止）
//   R4 运行 ≥ maxRuntimeMs 且 cpu < idleCpuPercent     → kill（卡住/被遗忘）
//   R5 运行 ≥ maxRuntimeMs 且仍高占用                  → nice
//   否则                                               → observe
//
// 执行策略（governor）: kill 目标先降优先级 + 宽限期, 仍未恢复才真正终止,
// 期间模型/用户可用 script_keep 撤销。

import { formatAge, type ScriptCandidate, type ScriptThresholds } from "./scripts"

export type ScriptAction = "kill" | "nice" | "keep" | "observe"
export type CommandKind = "server" | "long-job" | "interactive" | "one-shot" | "unknown"

const SERVER_RE =
  /(?:^|[\s/\\])(?:serve|server|dev|nodemon|vite|webpack|uvicorn|gunicorn|jupyter|tensorboard|ngrok|pm2|supervisor|mongod|redis-server)\b|(?:^|[\s/\\-])(?:bridge|proxy|tunnel)\b|next\s+dev|flask\s+run|http\.server|docker\s+compose\s+up|--watch\b|tail\s+-f/i
const LONG_JOB_RE =
  /\b(build|compile|test|pytest|jest|vitest|cargo|mvn|gradle|make|install|pip\s+install|conda\s+install|train|finetune|download|wget|curl\s+-O|crawl|scrape|ffmpeg|zip|tar|backup|dump|export|migrate|benchmark|index)\b/i
const INTERACTIVE_RE = /\b(read\s+-p|pause|less|more|vim|nano|top|htop)\b/i
const ONE_SHOT_RE = /(?:^|\s)(?:-e|-c|--eval)\b|\b\w+\.(?:py|js|mjs|cjs|ts|ps1|sh|bat|exe)\b/i

export function classifyCommand(command: string): CommandKind {
  if (!command) return "unknown"
  if (SERVER_RE.test(command)) return "server"
  if (LONG_JOB_RE.test(command)) return "long-job"
  if (INTERACTIVE_RE.test(command)) return "interactive"
  if (ONE_SHOT_RE.test(command)) return "one-shot"
  return "unknown"
}

export interface JudgeOptions {
  readonly thresholds: ScriptThresholds
  /** 内存硬线（超过直接判定终止）。 */
  readonly memoryKillMB: number
  /** 低于该 CPU 视为空闲（识别"卡住/被遗忘"）。 */
  readonly idleCpuPercent: number
}

export interface JudgeVerdict {
  readonly action: ScriptAction
  readonly severity: "high" | "medium" | "low"
  readonly kind: CommandKind
  readonly reasons: readonly string[]
  readonly suggestions: readonly string[]
}

export function judgeScript(candidate: ScriptCandidate, options: JudgeOptions): JudgeVerdict {
  const kind = classifyCommand(candidate.command ?? candidate.cmd)
  const cpu = candidate.cpuPercent
  const mem = candidate.mb
  const age = candidate.ageMs
  const reasons: string[] = []
  const suggestions: string[] = []

  // R0: 长驻服务/watch —— 正当, 只降优先级
  if (kind === "server") {
    reasons.push("长驻型命令（serve/dev/watch/bridge/proxy）→ 仅降优先级, 不终止")
    suggestions.push("长驻服务可缩小监视范围/降低轮询频率, 或改为按需启动")
    return { action: "nice", severity: "low", kind, reasons, suggestions }
  }

  // R1: 内存硬线
  if (mem >= options.memoryKillMB) {
    reasons.push(`内存 ${mem}MB ≥ 硬线 ${options.memoryKillMB}MB`)
    suggestions.push("限制内存: Node 加 --max-old-space-size; Python 改分批/流式处理; 避免一次性载入大文件")
    return { action: "kill", severity: "high", kind, reasons, suggestions }
  }

  // R2: CPU 高占用且非长任务
  if (cpu >= options.thresholds.cpuPercent && kind !== "long-job") {
    reasons.push(`CPU ${cpu}%（≥${options.thresholds.cpuPercent}%）且非长任务型`)
    suggestions.push("降低占用: 分片/分批执行、限制并发线程数、加 sleep 节流、避免忙等死循环")
    return { action: "kill", severity: "high", kind, reasons, suggestions }
  }

  // R3: 长任务 —— 正当, 只降优先级
  if (kind === "long-job") {
    reasons.push("长任务型命令（build/test/train/install）→ 视为正当任务, 仅降优先级")
    suggestions.push("可为其设置并行度上限（如 make -j2 / pytest -n2）或挪到低峰执行")
    return { action: "nice", severity: "low", kind, reasons, suggestions }
  }

  // R4: 长时间空闲 —— 疑似卡住/被遗忘
  if (age >= options.thresholds.maxRuntimeMs && cpu < options.idleCpuPercent) {
    reasons.push(`已运行 ${formatAge(age)} 但 CPU 仅 ${cpu}%（疑似卡住或被遗忘）`)
    suggestions.push("检查是否在等待输入/死锁; 改为带超时的任务或加日志确认进度")
    return { action: "kill", severity: "medium", kind, reasons, suggestions }
  }

  // R5: 长时间仍占用
  if (age >= options.thresholds.maxRuntimeMs) {
    reasons.push(`已运行 ${formatAge(age)} 且仍占用 CPU ${cpu}%`)
    suggestions.push("如果不需要了请终止; 需要则考虑分片以缩短单次运行时长")
    return { action: "nice", severity: "low", kind, reasons, suggestions }
  }

  return { action: "observe", severity: "low", kind, reasons: ["未达处置条件"], suggestions: [] }
}

export function describeCandidate(candidate: ScriptCandidate): string {
  const parts = [`CPU ${candidate.cpuPercent}%`, `内存 ${candidate.mb}MB`, `已运行 ${formatAge(candidate.ageMs)}`]
  return `PID ${candidate.pid} ${candidate.name} · ${parts.join(" · ")}`
}

function suggestionBlock(verdict: JudgeVerdict): string {
  return verdict.suggestions.length ? `\n优化建议: ${verdict.suggestions.join("；")}` : ""
}

/** 第一阶段（降优先级/保留）通知。 */
export function buildStageMessage(candidate: ScriptCandidate, verdict: JudgeVerdict, graceMs: number): string {
  const staged = verdict.action === "kill"
  return [
    "⚠️ oc-perf-guard 已自动处置脚本（Laya 式规则判定）",
    "",
    `- ${describeCandidate(candidate)}`,
    `- 命令: ${candidate.cmd}`,
    `- 判定: ${verdict.action}（${verdict.kind}）— ${verdict.reasons.join("；")}`,
    staged
      ? `- 已执行: 优先级降到 Idle；若 ${Math.round(graceMs / 1000)}s 后仍超阈值将自动终止（需要保留请调用 script_keep(pid=${candidate.pid})）`
      : `- 已执行: 优先级降到 Idle, 并保留 ${Math.round(graceMs / 1000)}s 内不再处理`,
    suggestionBlock(verdict),
    "（自动资源治理, 无需回复。）",
  ].join("\n")
}

/** 第二阶段（真正终止）通知。 */
export function buildKillMessage(candidate: ScriptCandidate, verdict: JudgeVerdict, ok: boolean): string {
  return [
    ok ? "⛔ oc-perf-guard 已终止占用过高的脚本" : "⚠️ oc-perf-guard 尝试终止脚本失败",
    "",
    `- ${describeCandidate(candidate)}`,
    `- 命令: ${candidate.cmd}`,
    `- 原因: ${verdict.reasons.join("；")}`,
    suggestionBlock(verdict),
  ].join("\n")
}

/** 只通知模式（notify）的文案。 */
export function buildNotifyMessage(candidate: ScriptCandidate, verdict: JudgeVerdict): string {
  return [
    "⚠️ oc-perf-guard 检测到脚本资源异常（仅通知模式, 未采取动作）",
    "",
    `- ${describeCandidate(candidate)}`,
    `- 命令: ${candidate.cmd}`,
    `- 建议动作: ${verdict.action}（${verdict.reasons.join("；")}）`,
    `- 处理: script_kill(pid=${candidate.pid}) 终止 / script_nice(pid=${candidate.pid}) 降优先级 / script_keep(pid=${candidate.pid}) 忽略`,
    suggestionBlock(verdict),
  ].join("\n")
}
