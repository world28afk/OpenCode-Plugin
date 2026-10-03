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
import { createSessionBridge, createToolSubagentBridge, extractToolSessionID, type SessionDomainLike, type ToolExecuteLike } from "./agents"
import { backgroundPrompt, detectHeavy, loadAutoConfig, persistAutoMode, policyText, type AutoConfig, type AutoMode } from "./auto"
import { validateCapsule, type Capsule } from "./capsule"
import { findEntry, loadCatalog, type Catalog } from "./catalog"
import { summarizeRun, WorkflowEngine, type BridgeFactory } from "./engine"
import { WorkflowEngineRpc } from "./rpc"
import { RunStore } from "./store"
import { slug, truncate } from "./util"

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
  "  /workflow auto [on|off|suggest|status]  自动派发开关（默认 on）",
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

    // 原生 subagent 工具（OpenCode 后台任务）: 可用时优先承载 workflow 任务,
    // 由宿主托管为可审计的 subagent（不进项目会话窗口）。
    const nativeSubagent = await (async (): Promise<ToolExecuteLike | null> => {
      try {
        const toolDomain = ctx.tool as unknown as { list?: (input: Record<string, unknown>) => Promise<unknown> }
        if (typeof toolDomain?.list !== "function") return null
        const list = await toolDomain.list({})
        const items = Array.isArray(list) ? list : ((list as { data?: unknown[] })?.data ?? [])
        const found = (items as Array<{ name?: string; execute?: unknown }>).find((item) => item?.name === "subagent" && typeof item.execute === "function")
        return found ? (found as unknown as ToolExecuteLike) : null
      } catch {
        return null
      }
    })()

    // 记录 workflow 自己创建的子会话, 用于阻止递归派发（子会话不再触发自动 workflow）。
    const childSessions = new Set<string>()
    const wrapBridge = (inner: SessionBridge): SessionBridge => ({
      async spawn(task) {
        const handle = await inner.spawn(task)
        if (handle.sessionID && handle.sessionID.startsWith("ses")) childSessions.add(handle.sessionID)
        return handle
      },
    })
    const bridgeFactory: BridgeFactory = ({ parentSessionID }) => {
      if (nativeSubagent) {
        return wrapBridge(
          createToolSubagentBridge({
            tool: nativeSubagent,
            parentSessionID,
            defaultAgent: "general",
            readOnlyAgent: knownAgents.includes("explore") ? "explore" : undefined,
            background: false,
            log,
          }),
        )
      }
      return wrapBridge(
        createSessionBridge({
          session: ctx.session as unknown as SessionDomainLike,
          directory,
          parentSessionID,
          readOnlyAgent: knownAgents.includes("explore") ? "explore" : undefined,
          knownAgents,
          log,
        }),
      )
    }

    const notify = async (sessionID: string, text: string) => {
      try {
        await (ctx.session as unknown as { synthetic: (input: Record<string, unknown>) => Promise<unknown> }).synthetic({
          sessionID,
          text,
          description: "oc-workflow",
        })
      } catch {
        log(text)
      }
    }

    // ── 自动派发状态 ────────────────────────────────────────────────────────
    let autoOverride: { mode?: AutoMode; enabled?: boolean } = {}
    const autoConfig = (): AutoConfig =>
      loadAutoConfig({
        directory,
        home,
        pluginOptions: (ctx.options ?? {}) as Record<string, unknown>,
        override: autoOverride,
      })
    const autoRuns = new Map<string, { sessionID: string; name: string; injected: boolean }>()
    const sessionAuto = new Map<string, { count: number; lastAt: number }>()

    const handleAutoUpdate = (record: { id: string; name: string; status: string; agentsUsed: number; summary?: string | null; error?: string | null }) => {
      const info = autoRuns.get(record.id)
      if (!info || info.injected) return
      if (record.status !== "completed" && record.status !== "failed" && record.status !== "stopped") return
      info.injected = true
      const label = record.status === "completed" ? "已完成" : record.status === "failed" ? "失败" : "已停止"
      const body = record.summary ? truncate(record.summary, 5000) : record.error ?? "(无汇总输出)"
      void notify(
        info.sessionID,
        `[oc-workflow] 自动派发的 ${info.name} ${label}（runId=${record.id}, agents=${record.agentsUsed}）:\n\n${body}\n\n（细节: /workflow show ${record.id}; 关闭自动派发: /workflow auto off）`,
      )
    }

    let emitRun: (payload: unknown) => void = () => {}
    const engine = new WorkflowEngine({
      directory,
      store,
      bridge: bridgeFactory,
      log,
      onUpdate: (record) => {
        emitRun(json({ type: "run.updated", run: summarizeRun(record) }))
        handleAutoUpdate(record)
      },
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
              const auto = autoConfig()
              return {
                content: JSON.stringify(
                  {
                    workflows: catalog.entries.map((entry) => ({ name: entry.name, source: entry.source, description: entry.description, inputs: entry.capsule.inputs ?? {} })),
                    errors: catalog.errors,
                    recentRuns: store.list(10).map(summarizeRun),
                    auto: { enabled: auto.enabled, mode: auto.mode, threshold: auto.threshold, workflow: auto.workflow, categories: auto.categories, execution: auto.execution, agent: auto.agent },
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
                  case "auto": {
                    const mode = rest[0]
                    if (!mode || mode === "status") {
                      const cfg = autoConfig()
                      await reply(
                        sessionID,
                        [
                          `自动派发: mode=${cfg.mode}（enabled=${cfg.enabled}, 注入策略=${cfg.injectPolicy}）`,
                          `执行方式=${cfg.execution}（background=OpenCode 后台任务 | workflow=oc-workflow 引擎）  agent=${cfg.agent}`,
                          `阈值=${cfg.threshold}  触发 workflow=${cfg.workflow}  冷却=${cfg.cooldownMs}ms  每会话上限=${cfg.maxPerSession}`,
                          `类别: ${cfg.categories.join(", ")}`,
                          `配置来源: ${cfg.sources.length ? cfg.sources.join(" | ") : "(默认)"}`,
                          "用法: /workflow auto on|off|suggest",
                        ].join("\n"),
                      )
                      return
                    }
                    const next: AutoMode | null = mode === "on" ? "auto" : mode === "off" ? "off" : mode === "suggest" ? "suggest" : null
                    if (!next) {
                      await reply(sessionID, `未知模式: ${mode}（可用 on | off | suggest | status）`)
                      return
                    }
                    autoOverride = { mode: next, enabled: next !== "off" }
                    const path = persistAutoMode(home, next)
                    const desc = next === "auto" ? "策略注入 + 自动触发" : next === "suggest" ? "仅策略注入（模型自行决定）" : "关闭"
                    await reply(sessionID, `自动派发已切换为 ${next}（${desc}），已写入 ${path}`)
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

    // ── 会话钩子: 策略注入 + 自动派发 ─────────────────────────────────────────

    const sessionDomain = ctx.session as unknown as {
      hook?: (name: string, handler: (input: unknown) => unknown) => Promise<{ dispose: () => Promise<void> }>
      get?: (input: Record<string, unknown>) => Promise<unknown>
    }
    if (sessionDomain && typeof sessionDomain.hook === "function") {
      const isChild = async (sessionID: string): Promise<boolean> => {
        if (!sessionID) return true
        if (childSessions.has(sessionID)) return true
        try {
          const info = (await sessionDomain.get?.({ sessionID })) as
            | { parentID?: string; parentSessionID?: string; parent?: { id?: string } }
            | undefined
          const parent = info?.parentID ?? info?.parentSessionID ?? info?.parent?.id
          if (parent) {
            childSessions.add(sessionID)
            return true
          }
        } catch {
          // 无法判定时按非子会话处理
        }
        return false
      }

      // context: 每轮向模型注入「重任务派发」策略
      registrations.push(
        await sessionDomain.hook("context", (raw: unknown) => {
          try {
            const config = autoConfig()
            if (!config.enabled || config.mode === "off" || !config.injectPolicy) return
            const event = raw as { sessionID?: string; system?: Array<Record<string, unknown>> }
            const sessionID = String(event?.sessionID ?? "")
            if (sessionID && childSessions.has(sessionID)) return
            const pending = [...autoRuns.entries()]
              .filter(([, info]) => !info.injected && (!sessionID || info.sessionID === sessionID))
              .map(([runId, info]) => ({ name: info.name, runId }))
            event?.system?.push?.({
              type: "text",
              text: policyText(config, pending),
              metadata: { source: PLUGIN_ID, kind: "auto-policy" },
            })
          } catch {
            // 策略注入失败不影响主流程
          }
        }),
      )

      // prompt: 识别重任务 → 后台自动派发 workflow
      registrations.push(
        await sessionDomain.hook("prompt", (raw: unknown) => {
          try {
            const input = raw as { sessionID?: string; prompt?: { text?: string } }
            const sessionID = String(input?.sessionID ?? "")
            const text = String(input?.prompt?.text ?? "")
            if (!sessionID || !text.trim()) return
            void (async () => {
              try {
                if (await isChild(sessionID)) return
                const config = autoConfig()
                if (!config.enabled || config.mode !== "auto") return
                const detection = detectHeavy(text, config)
                if (!detection.heavy) return
                const stat = sessionAuto.get(sessionID) ?? { count: 0, lastAt: 0 }
                if (stat.count >= config.maxPerSession) return
                if (Date.now() - stat.lastAt < config.cooldownMs) return
                const entry = findEntry(catalogOf(), config.workflow)
                if (!entry) {
                  log(`auto-dispatch: 未知 workflow ${config.workflow}`)
                  return
                }
                sessionAuto.set(sessionID, { count: stat.count + 1, lastAt: Date.now() })
                const label = detection.categories.join("/") || "heavy"

                // 默认: 作为 OpenCode 后台任务（原生 subagent, 不阻塞、不新开项目窗口）。
                if (config.execution === "background" && nativeSubagent) {
                  const controller = new AbortController()
                  const stamp = Date.now()
                  const result = await nativeSubagent.execute(
                    {
                      description: `自动调查 · ${entry.name}`,
                      prompt: backgroundPrompt(text, entry.capsule.intent ?? entry.capsule.description),
                      agent: config.agent,
                      background: true,
                    },
                    {
                      signal: controller.signal,
                      sessionID,
                      agent: config.agent,
                      messageID: `auto_${stamp}`,
                      callID: `auto_${stamp}`,
                      progress: async () => {},
                      abort: () => controller.abort(),
                    },
                  )
                  const child = extractToolSessionID(result)
                  if (child) childSessions.add(child)
                  log(`auto-dispatch(bg) ${entry.name} → subagent ${child ?? "?"} session=${sessionID} score=${detection.score} [${detection.signals.join(",")}]`)
                  await notify(
                    sessionID,
                    `[oc-workflow] 检测到重任务（${label}, score=${detection.score}），已作为后台任务派发子代理调查${child ? `（子会话 ${child}）` : ""}。完成后由 OpenCode 通知回本会话，可点开子会话审计；/workflow auto off 可关闭。`,
                  )
                  return
                }

                // 可选: 走 oc-workflow 引擎（并行 + 汇总 + 落盘 + 缓存续跑）。
                const record = await engine.start(entry.capsule, {
                  inputs: { [config.inputField]: text, question: text },
                  parentSessionID: sessionID,
                  wait: false,
                })
                autoRuns.set(record.id, { sessionID, name: entry.name, injected: false })
                log(`auto-dispatch(workflow) ${entry.name} runId=${record.id} session=${sessionID} score=${detection.score} [${detection.signals.join(",")}]`)
                await notify(
                  sessionID,
                  `[oc-workflow] 检测到重任务（${detection.categories.join("/") || "heavy"}, score=${detection.score}），已自动派发 ${entry.name}（runId=${record.id}）。完成后结果会回注本会话；/workflow auto off 可关闭。`,
                )
              } catch (error) {
                log(`auto-dispatch failed: ${error instanceof Error ? error.message : String(error)}`)
              }
            })()
          } catch {
            // 自动派发失败不影响主流程
          }
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
