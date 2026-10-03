// 子代理桥接 — 通过 ctx.session.create + prompt + wait 生成并等待真实子会话。
//
// 输出提取对消息结构保持宽容（不同版本的 SessionMessageInfo 形状可能变化）。

import type { ModelRef } from "./capsule"

export interface AgentTask {
  readonly id: string
  readonly prompt: string
  readonly title?: string
  readonly agent?: string
  readonly model?: ModelRef
  readonly readOnly?: boolean
}

export interface SessionDomainLike {
  create: (input: Record<string, unknown>) => Promise<unknown>
  prompt: (input: Record<string, unknown>) => Promise<unknown>
  wait: (input: Record<string, unknown>) => Promise<unknown>
  context: (input: Record<string, unknown>) => Promise<unknown>
  interrupt?: (input: Record<string, unknown>) => Promise<unknown>
  get?: (input: Record<string, unknown>) => Promise<unknown>
}

export interface BridgeOptions {
  readonly session: SessionDomainLike
  readonly directory: string
  readonly parentSessionID?: string
  /** readOnly 任务默认使用的只读 agent（需存在于 knownAgents） */
  readonly readOnlyAgent?: string
  readonly knownAgents?: readonly string[]
  readonly log?: (message: string) => void
}

export interface AgentHandle {
  readonly id: string
  readonly sessionID: string
  wait(): Promise<{ status: "completed" | "failed"; output: string | null }>
  interrupt(): Promise<void>
  output(): Promise<string | null>
}

export interface SessionBridge {
  spawn(task: AgentTask): Promise<AgentHandle>
}

export function createSessionBridge(options: BridgeOptions): SessionBridge {
  const log = options.log ?? (() => {})
  return {
    async spawn(task: AgentTask): Promise<AgentHandle> {
      const input: Record<string, unknown> = { title: task.title ?? `workflow:${task.id}` }
      if (options.parentSessionID) input.parentID = options.parentSessionID
      const readOnlyAgent =
        task.readOnly && options.readOnlyAgent && options.knownAgents?.includes(options.readOnlyAgent)
          ? options.readOnlyAgent
          : undefined
      const agent = task.agent ?? readOnlyAgent
      if (agent) input.agent = agent
      if (task.model) input.model = task.model
      input.location = { directory: options.directory }

      const created = (await options.session.create(input)) as { id?: string }
      const sessionID = created?.id
      if (!sessionID) throw new Error("session.create 未返回会话 id")

      await options.session.prompt({ sessionID, text: task.prompt })
      log(`agent ${task.id} → session ${sessionID}`)

      const readOutput = async (): Promise<string | null> => {
        try {
          return extractAssistantText(await options.session.context({ sessionID }))
        } catch {
          return null
        }
      }

      return {
        id: task.id,
        sessionID,
        async wait() {
          try {
            await options.session.wait({ sessionID })
            let status: "completed" | "failed" = "completed"
            try {
              const info = options.session.get ? ((await options.session.get({ sessionID })) as { outcome?: string }) : undefined
              if (info && (info.outcome === "failed" || info.outcome === "interrupted")) status = "failed"
            } catch {
              // outcome 不可得时按 completed 处理
            }
            return { status, output: await readOutput() }
          } catch {
            return { status: "failed", output: await readOutput() }
          }
        },
        async interrupt() {
          try {
            await options.session.interrupt?.({ sessionID })
          } catch {
            // ignore
          }
        },
        output: readOutput,
      }
    },
  }
}

const TEXT_KEYS = ["parts", "content", "children"]

export function extractAssistantText(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as Record<string, unknown>
    const role = String(message?.role ?? message?.type ?? "")
    if (!/assistant/i.test(role)) continue
    const texts: string[] = []
    collectText(message, texts, 0)
    const text = texts.join("\n").trim()
    if (text) return text
  }
  return null
}

function collectText(node: unknown, out: string[], depth: number): void {
  if (depth > 8 || out.length > 200) return
  if (Array.isArray(node)) {
    for (const item of node) collectText(item, out, depth + 1)
    return
  }
  if (!node || typeof node !== "object") return
  const record = node as Record<string, unknown>
  const type = typeof record.type === "string" ? record.type : ""
  if ((type === "text" || type.endsWith(".text")) && typeof record.text === "string" && record.text.trim()) {
    out.push(record.text)
    return
  }
  if ((!type || /assistant|message/i.test(type)) && typeof record.text === "string" && record.text.trim() && record.parts === undefined && record.content === undefined) {
    out.push(record.text)
    return
  }
  for (const key of TEXT_KEYS) {
    if (key in record) collectText(record[key], out, depth + 1)
  }
}

// ── 原生 subagent 工具桥接 ───────────────────────────────────────────────────
//
// OpenCode 内置 `subagent` 工具（经 ctx.tool.list() 暴露, 含 execute）:
//   input: { agent, description, prompt, model?, sessionID?, background? }
//   - background:true → 原生「后台任务」: 立即返回, 完成后由 OpenCode 通知父会话
//   - background:false → 前台: 阻塞到结束并返回最终回复（仍创建可审计的子会话）
// 相比裸 session.create, 由宿主托管, 桌面端作为 subagent 展示（不新开项目窗口）。

export interface ToolExecuteLike {
  execute: (input: Record<string, unknown>, context: Record<string, unknown>) => Promise<unknown>
}

export interface ToolBridgeOptions {
  readonly tool: ToolExecuteLike
  readonly parentSessionID?: string
  readonly defaultAgent?: string
  readonly readOnlyAgent?: string
  readonly background?: boolean
  readonly log?: (message: string) => void
}

/** 从原生 subagent 工具返回里尽力提取会话 id。 */
export function extractToolSessionID(result: unknown): string | null {
  if (!result || typeof result !== "object") return null
  const record = result as Record<string, unknown>
  const candidates = [record.sessionID, record.sessionId, record.id, (record.metadata as Record<string, unknown> | undefined)?.sessionID, (record.data as Record<string, unknown> | undefined)?.sessionID]
  for (const value of candidates) if (typeof value === "string" && value.startsWith("ses")) return value
  return null
}

/** 从原生 subagent 工具返回里尽力提取文本输出。 */
export function extractToolText(result: unknown): string | null {
  if (typeof result === "string") return result.trim() || null
  if (!result || typeof result !== "object") return null
  const record = result as Record<string, unknown>
  if (typeof record.text === "string" && record.text.trim()) return record.text
  if (typeof record.output === "string" && record.output.trim()) return record.output
  const texts: string[] = []
  for (const key of ["content", "parts", "children", "data"]) {
    if (key in record) collectText(record[key], texts, 0)
  }
  const joined = texts.join("\n").trim()
  return joined || null
}

export function createToolSubagentBridge(options: ToolBridgeOptions): SessionBridge {
  const log = options.log ?? (() => {})
  return {
    async spawn(task: AgentTask): Promise<AgentHandle> {
      const controller = new AbortController()
      const agent =
        task.agent ??
        (task.readOnly && options.readOnlyAgent ? options.readOnlyAgent : undefined) ??
        options.defaultAgent ??
        "general"
      const input: Record<string, unknown> = {
        description: task.title ?? `workflow:${task.id}`,
        prompt: task.prompt,
        agent,
        background: options.background === true,
      }
      if (task.model) input.model = task.model
      const context: Record<string, unknown> = {
        signal: controller.signal,
        sessionID: options.parentSessionID,
        agent,
        messageID: `wf_${task.id}`,
        callID: `wf_${task.id}`,
        progress: async () => {},
        abort: () => controller.abort(),
      }
      const result = await options.tool.execute(input, context)
      const sessionID = extractToolSessionID(result) ?? `tool:${task.id}`
      const output = extractToolText(result)
      log(`agent ${task.id} → native subagent ${sessionID} (background=${options.background === true})`)
      return {
        id: task.id,
        sessionID,
        wait: async () => ({ status: output ? "completed" : "failed", output }),
        interrupt: async () => {
          try {
            controller.abort()
          } catch {
            // ignore
          }
        },
        output: async () => output,
      }
    },
  }
}
