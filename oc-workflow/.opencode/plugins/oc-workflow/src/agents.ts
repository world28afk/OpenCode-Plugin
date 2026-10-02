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
