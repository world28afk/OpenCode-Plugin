// 服务端挂载 — 路由:
//   • prompt hook: 每轮用户消息 → 决策 → (auto) 切换会话模型档位
//   • 工具: router_status / router_decide / router_set / router_history
//   • 命令: /router（status | auto | manual | history | decide <text> | tier <档>）
//   • RPC: router.laya（外部客户端 + TUI）

import { homedir } from "node:os"
import type { Plugin } from "@opencode/plugin"
import {
  loadConfig,
  normalizeModelId,
  resolveRoute,
  type ModelInfoLike,
  type RouterConfig,
} from "./config"
import { decide, type DecideInput, type Decision } from "./policy"
import { RouterLaya } from "./rpc"
import { hashText, RouterState, sameRef, type HistoryEntry, type RouteRef, type SessionState } from "./state"
import { isTier, QIDS, QUESTIONS, type QId, type Tier } from "./tiers"

export const PLUGIN_ID = "oc-router-laya"
export const PLUGIN_VERSION = "0.1.0"

export interface RouterDeps {
  readonly loadConfig?: (options: { directory: string; models: readonly ModelInfoLike[]; pluginOptions?: Record<string, unknown> }) => RouterConfig
  readonly home?: string
}

function normalizeModels(input: unknown): ModelInfoLike[] {
  const raw = Array.isArray(input) ? input : ((input as { data?: unknown[] })?.data ?? [])
  return (raw as ModelInfoLike[]).filter((model) => model && (model.id || model.modelID))
}

function summarizeDecision(entry: HistoryEntry, includeText: boolean): Record<string, unknown> {
  const signals: Record<string, string[]> = {}
  for (const [qid, hits] of Object.entries(entry.signals ?? {})) {
    if (hits.length) signals[qid] = hits
  }
  return {
    at: entry.at,
    sessionID: entry.sessionID,
    tier: entry.tier,
    baseTier: entry.baseTier,
    triggeredBy: entry.triggeredBy,
    regenerate: entry.regenerate,
    escalated: entry.escalated,
    constrained: entry.constrained,
    density: entry.density,
    intent: entry.intent,
    labels: entry.labels,
    signals,
    judgeMs: entry.judgeMs,
    applied: entry.applied,
    appliedReason: entry.appliedReason ?? null,
    ...(includeText ? { text: entry.text } : {}),
  }
}

export function createMount(deps: RouterDeps = {}) {
  return async function mount(ctx: Plugin.Context): Promise<() => Promise<void> | void> {
    const home = deps.home ?? homedir()
    const directory = (ctx.location as { directory?: string } | undefined)?.directory ?? process.cwd()
    const state = new RouterState()
    let models: ModelInfoLike[] = []
    const registrations: Array<{ dispose: () => Promise<void> }> = []
    let emit: (payload: unknown) => void = () => {}
    const json = <T,>(value: T): T => JSON.parse(JSON.stringify(value))

    const refreshModels = async () => {
      try {
        models = normalizeModels(await ctx.model.list())
      } catch {
        models = []
      }
      return models
    }
    await refreshModels()

    const configOf = (): RouterConfig =>
      deps.loadConfig
        ? deps.loadConfig({ directory, models, pluginOptions: ctx.options })
        : loadConfig({ directory, models, pluginOptions: ctx.options, home })

    const currentModel = async (sessionID: string): Promise<RouteRef | null> => {
      try {
        const info = (await ctx.session.get({ sessionID })) as { model?: RouteRef } | undefined
        const model = info?.model
        if (model?.providerID && model?.id) return { providerID: model.providerID, id: model.id, ...(model.variant ? { variant: model.variant } : {}) }
      } catch {
        // ignore
      }
      return null
    }

    const makeModelJudge = (session: SessionState, config: RouterConfig) => {
      const model = config.judgeModel
      if (!model) return undefined
      return async (text: string): Promise<Partial<Record<QId, boolean>> | null> => {
        const key = hashText(text)
        const cached = session.judgeCache.get(key)
        if (cached) return cached as Partial<Record<QId, boolean>>
        const instruction = Object.entries(QUESTIONS)
          .map(([qid, question]) => `${qid} ${question}`)
          .join("\n")
        const prompt = `你是路由判定器。阅读任务, 对每个问题只回 true/false。\n${instruction}\n\n任务:\n"""${text.slice(0, 4000)}"""\n\n只输出 JSON, 形如 {"Q1":false,"Q2":true,"Q3":false,"Q4":true,"Q5":true,"Q6":true,"Q7":false}`
        try {
          const out = await ctx.generate.text({ prompt, model })
          const match = /\{[\s\S]*\}/.exec(out?.text ?? "")
          if (!match) return null
          const parsed = JSON.parse(match[0]) as Record<string, unknown>
          const labels: Partial<Record<QId, boolean>> = {}
          for (const qid of QIDS) if (typeof parsed[qid] === "boolean") labels[qid] = parsed[qid] as boolean
          if (!Object.keys(labels).length) return null
          session.judgeCache.set(key, labels as Record<string, boolean>)
          return labels
        } catch {
          return null
        }
      }
    }

    // ── prompt hook: 每轮决策 + 应用 ─────────────────────────────────────────

    if (ctx.session && typeof (ctx.session as { hook?: unknown }).hook === "function") {
      registrations.push(
        await ctx.session.hook("prompt", async (input) => {
          try {
            const text = input?.prompt?.text ?? ""
            if (!text.trim()) return
            const config = configOf()
            const session = state.session(input.sessionID)
            const oneShot = session.oneShot
            session.oneShot = undefined

            const decisionInput: DecideInput = {
              text,
              prevTier: session.prevTier,
              prevTask: session.prevTask,
              constraints: session.constraints,
              ...(oneShot ? { oneShot } : {}),
              judge: config.judge,
              ...(config.judge === "model" ? { modelLabels: makeModelJudge(session, config) } : {}),
            }
            const decision: Decision = await decide(decisionInput)

            if (decision.intent.op === "exclude" && decision.intent.tier && !session.constraints.includes(decision.intent.tier)) {
              session.constraints.push(decision.intent.tier)
            }
            session.prevTask = text
            session.prevTier = decision.tier

            const entry: HistoryEntry = { ...decision, sessionID: input.sessionID, applied: null }
            const mode = state.modeOverride ?? config.mode
            if (mode !== "auto") {
              entry.appliedReason = "manual"
            } else {
              const route = resolveRoute(config.tiers, decision.tier, models)
              if (!route) {
                entry.appliedReason = "no-route"
              } else {
                let current: RouteRef | null = null
                if (config.respectExplicit && session.lastApplied) {
                  current = await currentModel(input.sessionID)
                }
                if (config.respectExplicit && session.lastApplied && current && !sameRef(current, session.lastApplied)) {
                  // 会话模型已被外部（用户/其它插件）切换 → 尊重显式选择
                  entry.appliedReason = "explicit-model"
                } else if (session.lastApplied && sameRef(session.lastApplied, route)) {
                  entry.applied = route
                  entry.appliedReason = "already"
                } else {
                  await ctx.session.switchModel({ sessionID: input.sessionID, model: route })
                  session.lastApplied = route
                  session.appliedAt = Date.now()
                  entry.applied = route
                }
              }
            }

            state.push(entry, config.historyLimit)
            emit(json({ type: "decision", decision: summarizeDecision(entry, false) }))
          } catch (error) {
            console.warn(`[${PLUGIN_ID}] prompt hook failed:`, error instanceof Error ? error.message : String(error))
          }
        }),
      )
    }

    // ── 共享管理逻辑 ────────────────────────────────────────────────────────

    const statusPayload = () => {
      const config = configOf()
      const resolved = Object.fromEntries(
        (["low", "high", "max"] as Tier[]).map((tier) => [tier, resolveRoute(config.tiers, tier, models)]),
      )
      const variantExamples = models
        .filter((model) => (model.variants ?? []).length > 0)
        .slice(0, 12)
        .map((model) => ({
          providerID: model.providerID,
          id: normalizeModelId(model),
          variants: (model.variants ?? []).map((variant) => variant.id),
        }))
      return {
        plugin: { id: PLUGIN_ID, version: PLUGIN_VERSION },
        mode: state.modeOverride ?? config.mode,
        modeOverride: state.modeOverride,
        judge: config.judge,
        judgeModel: config.judgeModel ?? null,
        respectExplicit: config.respectExplicit,
        escalateOnRegenerate: config.escalateOnRegenerate,
        fallback: config.fallback,
        tiers: resolved,
        sources: config.sources,
        models: { total: models.length, withVariants: variantExamples },
        sessions: state.sessions.size,
        history: state.history.length,
        lastDecision: state.history[0] ? summarizeDecision(state.history[0], false) : null,
      }
    }

    const decidePreview = async (text: string, sessionID?: string) => {
      const config = configOf()
      const session = sessionID ? state.session(sessionID) : undefined
      const decision = await decide({
        text,
        ...(session?.prevTier !== undefined ? { prevTier: session.prevTier } : {}),
        ...(session?.prevTask !== undefined ? { prevTask: session.prevTask } : {}),
        constraints: session?.constraints ?? [],
        judge: config.judge,
      })
      const route = resolveRoute(config.tiers, decision.tier, models)
      return {
        decision: summarizeDecision({ ...decision, sessionID: sessionID ?? "preview", applied: null }, true),
        route,
        mode: state.modeOverride ?? config.mode,
      }
    }

    const setMode = (mode: "auto" | "manual") => {
      state.modeOverride = mode
      emit(json({ type: "mode", mode }))
      return { ok: true, mode }
    }

    const setTier = (tier: Tier, sessionID?: string) => {
      const key = sessionID ?? [...state.sessions.keys()].pop()
      if (!key) return { ok: false, error: "没有可应用的会话（先在本会话或提供 sessionID）" }
      state.session(key).oneShot = tier
      return { ok: true, sessionID: key, tier, note: "下一轮消息生效" }
    }

    // ── 工具 ────────────────────────────────────────────────────────────────

    if (ctx.tool && typeof (ctx.tool as { transform?: unknown }).transform === "function") {
      registrations.push(
        await ctx.tool.transform((editor) => {
          editor.add({
            name: "router_status",
            description: "查看档位路由状态: 模式/判定方式/各档位解析结果/可用模型与 variants/最近决策。",
            input: { type: "object", properties: {}, additionalProperties: false },
            execute: async () => {
              await refreshModels()
              return { content: JSON.stringify(statusPayload(), null, 2) }
            },
          })
          editor.add({
            name: "router_decide",
            description: "预演路由决策（不切换模型）: 给定文本返回档位、触发层、7 问标签、解析后的目标模型。",
            input: {
              type: "object",
              properties: { text: { type: "string" }, sessionID: { type: "string" } },
              required: ["text"],
              additionalProperties: false,
            },
            execute: async (input) => {
              const value = (input ?? {}) as { text: string; sessionID?: string }
              return { content: JSON.stringify(await decidePreview(value.text, value.sessionID), null, 2) }
            },
          })
          editor.add({
            name: "router_set",
            description: "设置路由: mode=auto|manual 切换自动路由; tier=low|high|max 为本会话下一轮指定档位（一次性）。",
            input: {
              type: "object",
              properties: {
                mode: { type: "string", enum: ["auto", "manual"] },
                tier: { type: "string", enum: ["low", "high", "max"] },
              },
              additionalProperties: false,
            },
            execute: async (input, toolContext) => {
              const value = (input ?? {}) as { mode?: "auto" | "manual"; tier?: Tier }
              const sessionID = (toolContext as { sessionID?: string } | undefined)?.sessionID
              const result: Record<string, unknown> = {}
              if (value.mode) Object.assign(result, setMode(value.mode))
              if (value.tier && isTier(value.tier)) Object.assign(result, setTier(value.tier, sessionID))
              return { content: JSON.stringify(result, null, 2) }
            },
          })
          editor.add({
            name: "router_history",
            description: "最近的档位路由决策记录（含每轮触发层与应用结果）。",
            input: { type: "object", properties: { limit: { type: "number" } }, additionalProperties: false },
            execute: async (input) => {
              const limit = Math.min(50, Math.max(1, Number((input as { limit?: number })?.limit) || 20))
              return { content: JSON.stringify({ history: state.history.slice(0, limit).map((entry) => summarizeDecision(entry, true)) }, null, 2) }
            },
          })
        }),
      )
    }

    // ── 命令 /router ────────────────────────────────────────────────────────

    if (ctx.command && typeof (ctx.command as { transform?: unknown }).transform === "function") {
      const reply = async (sessionID: string, text: string) => {
        try {
          await ctx.session.synthetic({ sessionID, text, description: "router" })
        } catch {
          console.info(`[${PLUGIN_ID}] ${text}`)
        }
      }
      registrations.push(
        await ctx.command.transform((editor) => {
          editor.add({
            name: "router",
            description: "档位路由: status | auto | manual | decide <文本> | tier <low|high|max> | history",
            execute: async (invocation) => {
              const raw = (invocation.prompt as { text?: string } | undefined)?.text ?? ""
              const stripped = raw.replace(/^\s*\/?router\s*/i, "").trim()
              const [sub, ...rest] = stripped.split(/\s+/)
              const arg = rest.join(" ")
              try {
                switch ((sub ?? "").toLowerCase()) {
                  case "":
                  case "status": {
                    const payload = statusPayload()
                    await reply(
                      invocation.sessionID,
                      `router: mode=${payload.mode} judge=${payload.judge}\n档位: ${JSON.stringify(payload.tiers)}\n最近: ${payload.lastDecision ? `${payload.lastDecision.tier} (${payload.lastDecision.triggeredBy})` : "无"}`,
                    )
                    return
                  }
                  case "auto":
                    setMode("auto")
                    await reply(invocation.sessionID, "已切换: auto（自动档位路由）")
                    return
                  case "manual":
                    setMode("manual")
                    await reply(invocation.sessionID, "已切换: manual（只记录决策, 不切换模型）")
                    return
                  case "tier": {
                    if (!isTier(arg)) {
                      await reply(invocation.sessionID, "用法: /router tier low|high|max")
                      return
                    }
                    const result = setTier(arg, invocation.sessionID)
                    await reply(invocation.sessionID, JSON.stringify(result))
                    return
                  }
                  case "decide": {
                    if (!arg) {
                      await reply(invocation.sessionID, "用法: /router decide <文本>")
                      return
                    }
                    const preview = await decidePreview(arg, invocation.sessionID)
                    await reply(invocation.sessionID, JSON.stringify(preview, null, 2))
                    return
                  }
                  case "history": {
                    const limit = Number(arg) || 10
                    const entries = state.history.slice(0, limit).map((entry) => summarizeDecision(entry, false))
                    await reply(invocation.sessionID, JSON.stringify({ history: entries }, null, 2))
                    return
                  }
                  default:
                    await reply(invocation.sessionID, "未知子命令。用法: /router status|auto|manual|decide <文本>|tier <档>|history")
                }
              } catch (error) {
                await reply(invocation.sessionID, `router 执行失败: ${error instanceof Error ? error.message : String(error)}`)
              }
            },
          })
        }),
      )
    }

    // ── RPC ─────────────────────────────────────────────────────────────────

    if (ctx.rpc && typeof (ctx.rpc as { register?: unknown }).register === "function") {
      try {
        const registration = (await ctx.rpc.register(RouterLaya, {
          status: async () => json(statusPayload()),
          decide: async (input: unknown) => {
            const value = input as { text: string; sessionID?: string }
            return json(await decidePreview(value.text, value.sessionID))
          },
          history: async (input: unknown) => {
            const limit = Math.min(50, Math.max(1, Number((input as { limit?: number })?.limit) || 20))
            return json({ history: state.history.slice(0, limit).map((entry) => summarizeDecision(entry, true)) })
          },
          setMode: async (input: unknown) => json(setMode((input as { mode: "auto" | "manual" }).mode)),
          setTier: async (input: unknown) => {
            const value = input as { tier: Tier; sessionID?: string }
            return json(setTier(value.tier, value.sessionID))
          },
        })) as { dispose: () => Promise<void>; events?: { emit?: (name: string, data: unknown) => Promise<void> } }
        if (registration) registrations.push(registration)
        emit = (payload: unknown) => {
          try {
            void registration?.events?.emit?.("decision", payload as never)?.catch?.(() => {})
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
