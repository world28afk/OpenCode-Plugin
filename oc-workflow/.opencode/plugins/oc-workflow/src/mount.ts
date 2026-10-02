// 服务端挂载 — workflow:
//   • 工具: workflow_list / run_workflow / workflow_manage
//   • 命令: /workflow（通过 ctx.command 注册, 结果以 synthetic 消息回显）
//   • RPC: workflow.engine（外部客户端可用）
//
// 依赖注入: createMount(deps) 便于测试替换 catalog / store。

import { mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { createSessionBridge, type SessionDomainLike } from "./agents"
import { validateCapsule, type Capsule } from "./capsule"
import { findEntry, loadCatalog, type Catalog } from "./catalog"
import { summarizeRun, WorkflowEngine, type BridgeFactory } from "./engine"
import { WorkflowEngineRpc } from "./rpc"
import { RunStore } from "./store"
import { slug } from "./util"

export const PLUGIN_ID = "oc-workflow"
export const PLUGIN_VERSION = "0.1.0"

export interface WorkflowDeps {
  readonly catalog?: (directory: string, home: string) => Catalog
  readonly storeFactory?: (directory: string) => RunStore
}

const USAGE = [
  "workflow 用法:",
  "  /workflow list                     列出可用 workflow",
  "  /workflow run <name> [JSON 输入]   启动（后台运行, 返回 runId）",
  "  /workflow runs [N]                 最近运行",
  "  /workflow show [runId]             查看运行详情",
  "  /workflow pause|resume|stop [runId]",
  "  /workflow rerun <runId>            重跑",
  "  /workflow resume-run <runId>       按缓存续跑",
  "  /workflow prune [keep]             清理旧 run",
].join("\n")

export function createMount(deps: WorkflowDeps = {}) {
  return async function mount(ctx: Plugin.Context): Promise<() => Promise<void> | void> {
    const directory = (ctx.location as { directory?: string } | undefined)?.directory ?? process.cwd()
    const home = homedir()
    let store: RunStore
    try {
      store = deps.storeFactory ? deps.storeFactory(directory) : new RunStore(join(directory, ".opencode", "workflow-runs"))
      store.ensure()
    } catch {
      store = new RunStore(join(home, ".config", "opencode", "workflow-runs"))
      store.ensure()
    }

    const catalogOf = (): Catalog => (deps.catalog ? deps.catalog(directory, home) : loadCatalog(directory, home))
    const log = (message: string) => console.info(`[${PLUGIN_ID}] ${message}`)
    const json = <T,>(value: T): T => JSON.parse(JSON.stringify(value))

    const knownAgents: string[] = []
    try {
      const list = await ctx.agent.list({})
      const items = Array.isArray(list) ? list : ((list as { data?: unknown[] })?.data ?? [])
      for (const item of items as Array<{ id?: string }>) if (item?.id) knownAgents.push(item.id)
    } catch {
      // agent 列表不可用时 readOnly 任务退回默认 agent
    }

    const bridgeFactory: BridgeFactory = ({ parentSessionID }) =>
      createSessionBridge({
        session: ctx.session as unknown as SessionDomainLike,
        directory,
        parentSessionID,
        readOnlyAgent: knownAgents.includes("explore") ? "explore" : undefined,
        knownAgents,
        log,
      })

    let emitRun: (payload: unknown) => void = () => {}
    const engine = new WorkflowEngine({
      directory,
      store,
      bridge: bridgeFactory,
      log,
      onUpdate: (record) => emitRun(json({ type: "run.updated", run: summarizeRun(record) })),
    })

    const registrations: Array<{ dispose: () => Promise<void> }> = []

    // ── 工具 ────────────────────────────────────────────────────────────────

    if (ctx.tool && typeof (ctx.tool as { transform?: unknown }).transform === "function") {
      registrations.push(
        await ctx.tool.transform((editor) => {
          editor.add({
            name: "workflow_list",
            description: "列出可用 workflow（内置 + 项目 .opencode/workflows + 个人 ~/.config/opencode/workflows）与最近运行。",
            input: { type: "object", properties: {}, additionalProperties: false },
            execute: async () => {
              const catalog = catalogOf()
              return {
                content: JSON.stringify(
                  {
                    workflows: catalog.entries.map((entry) => ({ name: entry.name, source: entry.source, description: entry.description, inputs: entry.capsule.inputs ?? {} })),
                    errors: catalog.errors,
                    recentRuns: store.list(10).map(summarizeRun),
                  },
                  null,
                  2,
                ),
              }
            },
          })

          editor.add({
            name: "run_workflow",
            description:
              "运行 workflow。name 指向已保存的 workflow（如 parallel-investigation / scoped-review）, 或用 capsule 传内联定义。默认后台运行返回 runId; wait:true 同步等待完成。",
            input: {
              type: "object",
              properties: {
                name: { type: "string" },
                capsule: { type: "object", additionalProperties: true },
                inputs: { type: "object", additionalProperties: true },
                wait: { type: "boolean" },
              },
              additionalProperties: false,
            },
            execute: async (input, toolContext) => {
              const value = (input ?? {}) as { name?: string; capsule?: Capsule; inputs?: Record<string, unknown>; wait?: boolean }
              let capsule: Capsule | null = null
              if (value.capsule) {
                const validated = validateCapsule(value.capsule)
                if (!validated.ok) return { content: JSON.stringify({ ok: false, errors: validated.errors }, null, 2) }
                capsule = validated.value
              } else if (value.name) {
                const entry = findEntry(catalogOf(), value.name)
                if (!entry) return { content: JSON.stringify({ ok: false, error: `未知 workflow: ${value.name}` }, null, 2) }
                capsule = entry.capsule
              }
              if (!capsule) return { content: JSON.stringify({ ok: false, error: "需要 name 或 capsule" }, null, 2) }
              const parentSessionID = (toolContext as { sessionID?: string } | undefined)?.sessionID
              try {
                const record = await engine.start(capsule, { inputs: value.inputs, parentSessionID, wait: value.wait === true })
                return { content: JSON.stringify({ ok: true, run: summarizeRun(record) }, null, 2) }
              } catch (error) {
                return { content: JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2) }
              }
            },
          })

          editor.add({
            name: "workflow_manage",
            description:
              "管理 workflow 运行。action: runs | show | pause | resume | stop | rerun | resumeRun | prune | save。",
            input: {
              type: "object",
              properties: {
                action: { type: "string" },
                runId: { type: "string" },
                name: { type: "string" },
                inputs: { type: "object", additionalProperties: true },
                keep: { type: "number" },
                scope: { type: "string", enum: ["project", "global"] },
              },
              required: ["action"],
              additionalProperties: false,
            },
            execute: async (input) => {
              const value = (input ?? {}) as { action: string; runId?: string; name?: string; inputs?: Record<string, unknown>; keep?: number; scope?: "project" | "global" }
              const result = await manage(value)
              return { content: JSON.stringify(result, null, 2) }
            },
          })
        }),
      )
    }

    // ── 管理逻辑（工具与 RPC/命令共享） ──────────────────────────────────────

    const manage = async (value: { action: string; runId?: string; name?: string; inputs?: Record<string, unknown>; keep?: number; scope?: "project" | "global" }) => {
      switch (value.action) {
        case "runs":
          return { ok: true, runs: store.list(value.keep ?? 20).map(summarizeRun) }
        case "show": {
          const record = value.runId ? engine.show(value.runId) : engine.latest()
          return record ? { ok: true, run: summarizeRun(record), record: json(record) } : { ok: false, error: "没有可显示的 run" }
        }
        case "pause":
          return { ok: engine.pause(value.runId ?? engine.latest()?.id ?? "") }
        case "resume":
          return { ok: engine.resume(value.runId ?? engine.latest()?.id ?? "") }
        case "stop":
          return { ok: engine.stop(value.runId ?? engine.latest()?.id ?? "") }
        case "rerun": {
          const record = await engine.rerun({ runId: value.runId, inputs: value.inputs })
          return { ok: true, run: summarizeRun(record) }
        }
        case "resumeRun": {
          if (!value.runId) return { ok: false, error: "resumeRun 需要 runId" }
          const record = await engine.resumeRun({ runId: value.runId })
          return { ok: true, run: summarizeRun(record) }
        }
        case "prune": {
          const removed = store.prune({ keep: value.keep ?? 50 })
          return { ok: true, removed }
        }
        case "save": {
          const source = value.runId ? engine.show(value.runId) : engine.latest()
          if (!source) return { ok: false, error: "没有可保存的 run" }
          const name = value.name ?? source.name
          const scope = value.scope ?? "project"
          const dir = scope === "project" ? join(directory, ".opencode", "workflows") : join(home, ".config", "opencode", "workflows")
          mkdirSync(dir, { recursive: true })
          const capsule: Capsule = { ...source.capsule, name }
          const path = join(dir, `${slug(name)}.workflow.json`)
          writeFileSync(path, `${JSON.stringify(capsule, null, 2)}\n`, "utf8")
          return { ok: true, path }
        }
        default:
          return { ok: false, error: `未知 action: ${value.action}` }
      }
    }

    // ── 命令 /workflow ──────────────────────────────────────────────────────

    if (ctx.command && typeof (ctx.command as { transform?: unknown }).transform === "function") {
      const reply = async (sessionID: string, text: string) => {
        try {
          await ctx.session.synthetic({ sessionID, text, description: "workflow" })
        } catch {
          console.info(`[${PLUGIN_ID}] ${text}`)
        }
      }

      registrations.push(
        await ctx.command.transform((editor) => {
          editor.add({
            name: "workflow",
            description: "运行/管理 workflow（list/run/runs/show/pause/resume/stop/rerun/resume-run/prune）",
            execute: async (invocation) => {
              const sessionID = invocation.sessionID
              const raw = (invocation.prompt as { text?: string } | undefined)?.text ?? ""
              const stripped = raw.replace(/^\s*\/?workflow\s*/i, "").trim()
              const [subcommand, ...rest] = stripped.split(/\s+/)
              const arg = rest.join(" ")
              try {
                switch (subcommand) {
                  case "": {
                    await reply(sessionID, USAGE)
                    return
                  }
                  case "list": {
                    const catalog = catalogOf()
                    const lines = catalog.entries.map((entry) => `- ${entry.name} (${entry.source})${entry.description ? ` — ${entry.description}` : ""}`)
                    if (catalog.errors.length) lines.push("", "错误:", ...catalog.errors.map((error) => `- ${error}`))
                    await reply(sessionID, `可用 workflow:\n${lines.join("\n")}`)
                    return
                  }
                  case "run": {
                    const [name, ...jsonParts] = arg.split(/\s+/)
                    if (!name) {
                      await reply(sessionID, "用法: /workflow run <name> [JSON 输入]")
                      return
                    }
                    const entry = findEntry(catalogOf(), name)
                    if (!entry) {
                      await reply(sessionID, `未知 workflow: ${name}`)
                      return
                    }
                    let inputs: Record<string, unknown> | undefined
                    const jsonText = jsonParts.join(" ")
                    if (jsonText) {
                      try {
                        inputs = JSON.parse(jsonText) as Record<string, unknown>
                      } catch {
                        await reply(sessionID, `输入 JSON 解析失败: ${jsonText}`)
                        return
                      }
                    }
                    const record = await engine.start(entry.capsule, { inputs, parentSessionID: sessionID })
                    await reply(sessionID, `已启动 ${record.name}: runId=${record.id}（/workflow show ${record.id} 查看进度）`)
                    return
                  }
                  case "runs": {
                    const record = store.list(Number(arg) || 10)
                    const lines = record.map((item) => `- ${item.id}  ${item.name}  [${item.status}]  agents=${item.agentsUsed}`)
                    await reply(sessionID, lines.length ? `最近运行:\n${lines.join("\n")}` : "还没有运行记录")
                    return
                  }
                  case "show": {
                    const result = await manage({ action: "show", runId: arg || undefined })
                    await reply(sessionID, JSON.stringify(result, null, 2))
                    return
                  }
                  case "pause":
                  case "resume":
                  case "stop": {
                    const result = await manage({ action: subcommand, runId: arg || undefined })
                    await reply(sessionID, JSON.stringify(result))
                    return
                  }
                  case "rerun": {
                    const result = await manage({ action: "rerun", runId: arg || undefined })
                    await reply(sessionID, JSON.stringify(result, null, 2))
                    return
                  }
                  case "resume-run": {
                    const result = await manage({ action: "resumeRun", runId: arg || undefined })
                    await reply(sessionID, JSON.stringify(result, null, 2))
                    return
                  }
                  case "prune": {
                    const result = await manage({ action: "prune", keep: Number(arg) || 50 })
                    await reply(sessionID, JSON.stringify(result))
                    return
                  }
                  default: {
                    await reply(sessionID, `未知子命令: ${subcommand}\n\n${USAGE}`)
                  }
                }
              } catch (error) {
                await reply(sessionID, `workflow 执行失败: ${error instanceof Error ? error.message : String(error)}`)
              }
            },
          })
        }),
      )
    }

    // ── RPC ─────────────────────────────────────────────────────────────────

    if (ctx.rpc && typeof (ctx.rpc as { register?: unknown }).register === "function") {
      try {
        const registration = (await ctx.rpc.register(WorkflowEngineRpc, {
          list: async () => {
            const catalog = catalogOf()
            return json({
              workflows: catalog.entries.map((entry) => ({ name: entry.name, source: entry.source, description: entry.description })),
              errors: catalog.errors,
            })
          },
          runs: async (input: unknown) => json({ runs: store.list((input as { limit?: number })?.limit ?? 20).map(summarizeRun) }),
          start: async (input: unknown) => {
            const value = (input ?? {}) as { name?: string; capsule?: Capsule; inputs?: Record<string, unknown>; wait?: boolean }
            let capsule: Capsule | null = null
            if (value.capsule) {
              const validated = validateCapsule(value.capsule)
              if (!validated.ok) return json({ ok: false, errors: validated.errors })
              capsule = validated.value
            } else if (value.name) {
              const entry = findEntry(catalogOf(), value.name)
              if (!entry) return json({ ok: false, error: `未知 workflow: ${value.name}` })
              capsule = entry.capsule
            }
            if (!capsule) return json({ ok: false, error: "需要 name 或 capsule" })
            const record = await engine.start(capsule, { inputs: value.inputs, wait: value.wait === true })
            return json({ ok: true, run: summarizeRun(record) })
          },
          show: async (input: unknown) => {
            const record = engine.show((input as { runId: string }).runId)
            return json(record ? { ok: true, run: summarizeRun(record), record } : { ok: false, error: "not found" })
          },
          pause: async (input: unknown) => json({ ok: engine.pause((input as { runId: string }).runId) }),
          resume: async (input: unknown) => json({ ok: engine.resume((input as { runId: string }).runId) }),
          stop: async (input: unknown) => json({ ok: engine.stop((input as { runId: string }).runId) }),
          rerun: async (input: unknown) =>
            json({ ok: true, run: summarizeRun(await engine.rerun(input as { runId?: string; inputs?: Record<string, unknown> })) }),
          resumeRun: async (input: unknown) =>
            json({ ok: true, run: summarizeRun(await engine.resumeRun(input as { runId: string })) }),
          prune: async (input: unknown) => json({ ok: true, removed: store.prune({ keep: (input as { keep?: number })?.keep ?? 50 }) }),
        })) as { dispose: () => Promise<void>; events?: { emit?: (name: string, data: unknown) => Promise<void> } }
        if (registration) registrations.push(registration)
        emitRun = (payload: unknown) => {
          try {
            void registration?.events?.emit?.("run", payload as never)?.catch?.(() => {})
          } catch {
            // ignore
          }
        }
      } catch (error) {
        console.warn(`[${PLUGIN_ID}] rpc register failed:`, error instanceof Error ? error.message : String(error))
      }
    }

    return async () => {
      for (const registration of registrations.reverse()) {
        await registration.dispose()
      }
    }
  }
}

export default { id: PLUGIN_ID, setup: createMount() }
