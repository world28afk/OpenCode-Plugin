// 冒烟测试 — 规则引擎/词典/启发式/配置/管线/mount（全部离线 fixture）。

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { loadConfig, pickDefaultTiers, resolveRoute, resolveTierRoute, variantFor, type ModelInfoLike } from "../.opencode/plugins/oc-router-laya/src/config"
import { judgeHeuristic } from "../.opencode/plugins/oc-router-laya/src/heuristic"
import { parseIntent } from "../.opencode/plugins/oc-router-laya/src/lexicon"
import { createMount } from "../.opencode/plugins/oc-router-laya/src/mount"
import { decide, isRegenerate } from "../.opencode/plugins/oc-router-laya/src/policy"
import { capTier, computeTier, escalate, floorTier } from "../.opencode/plugins/oc-router-laya/src/tiers"

const MODELS: ModelInfoLike[] = [
  { id: "deepseek-flash", modelID: "deepseek-flash", providerID: "deepseek", variants: [{ id: "none" }, { id: "low" }, { id: "high" }, { id: "max" }] },
  { id: "glm-5.3-flash", modelID: "glm-5.3-flash", providerID: "opencode-go", variants: [{ id: "low" }, { id: "high" }, { id: "max" }] },
  { id: "qwen3.8-flash", modelID: "qwen3.8-flash", providerID: "opencode-go", variants: [{ id: "none" }, { id: "low" }, { id: "medium" }, { id: "xhigh" }] },
  { id: "plain", modelID: "plain", providerID: "x", variants: [] },
]

describe("tiers (rule engine port)", () => {
  test("computeTier follows the seven rules", () => {
    expect(computeTier({ Q7: true })).toBe("high") // rule 0
    expect(computeTier({ Q4: true })).toBe("max") // rule 1
    expect(computeTier({ Q2: true, Q3: true })).toBe("max") // rule 2
    expect(computeTier({ Q1: true, Q4: true, Q5: true })).toBe("high") // rule 3
    expect(computeTier({ Q2: true })).toBe("high") // rule 4
    expect(computeTier({ Q1: true, Q4: true, Q6: true })).toBe("max") // rule 5, score .61
    expect(computeTier({ Q1: true, Q6: true })).toBe("high") // rule 5, score .32
    expect(computeTier({ Q6: true })).toBe("low") // rule 6
    expect(computeTier({})).toBe("low")
  })

  test("escalate / floor / cap", () => {
    expect(escalate("low")).toBe("high")
    expect(escalate("high")).toBe("max")
    expect(escalate("max")).toBe("max")
    expect(escalate("medium")).toBe("high")
    expect(escalate("weird")).toBe("weird")
    expect(floorTier("low", "max")).toBe("max")
    expect(floorTier("max", "low")).toBe("max")
    expect(floorTier("low", "bogus")).toBe("low")
    expect(capTier("max", ["max"])).toBe("high")
    expect(capTier("high", ["max"])).toBe("high")
    expect(capTier("high", ["high"])).toBe("low")
    expect(capTier("max", ["high"])).toBe("low") // 压到 high 档以下
    expect(capTier("low", ["max"])).toBe("low")
  })
})

describe("lexicon intents", () => {
  test("force / inherit / exclude / none", () => {
    expect(parseIntent("用最高档")).toMatchObject({ op: "force", tier: "max" })
    expect(parseIntent("拉满，全力做")).toMatchObject({ op: "force", tier: "max" })
    expect(parseIntent("认真点做")).toMatchObject({ op: "force", tier: "high" })
    expect(parseIntent("省点 token")).toMatchObject({ op: "force", tier: "low" })
    expect(parseIntent("继续")).toMatchObject({ op: "inherit" })
    expect(parseIntent("接着之前的活干")).toMatchObject({ op: "inherit" })
    expect(parseIntent("别用 max")).toMatchObject({ op: "exclude", tier: "max" })
    expect(parseIntent("不要拉满")).toMatchObject({ op: "exclude", tier: "max" })
    expect(parseIntent("别省了，拉满")).toMatchObject({ op: "force", tier: "max" })
    expect(parseIntent("这是一段普通描述")).toMatchObject({ op: "none" })
  })
})

describe("heuristic judge", () => {
  test("detects structural questions", () => {
    const refactor = judgeHeuristic("重构微服务架构，先跑测试再部署")
    expect(refactor.labels.Q1).toBe(true)
    expect(refactor.labels.Q2).toBe(true)
    expect(refactor.labels.Q3).toBe(true)

    const why = judgeHeuristic("为什么这个函数有 bug？帮我分析根因")
    expect(why.labels.Q4).toBe(true)
    expect(why.labels.Q5).toBe(true)

    const batch = judgeHeuristic("批量重命名所有文件")
    expect(batch.labels.Q7).toBe(true)
    expect(batch.density).toBeGreaterThan(0)
    expect(batch.density).toBeLessThanOrEqual(1)
  })
})

describe("regenerate detection", () => {
  test("similarity and retry phrasing", () => {
    expect(isRegenerate("帮我修这个问题", "帮我修这个问题")).toBe(true)
    expect(isRegenerate("帮我修这个问题，再来", "帮我修这个问题")).toBe(true)
    expect(isRegenerate("再来一次", "任意旧任务")).toBe(true)
    expect(isRegenerate("不对，重新做", "旧任务")).toBe(true)
    expect(isRegenerate("不对", "旧任务")).toBe(false)
    expect(isRegenerate("全新任务", undefined)).toBe(false)
  })
})

describe("decide pipeline", () => {
  test("force / inherit / one-shot", async () => {
    expect((await decide({ text: "用最高档", judge: "heuristic" })).triggeredBy).toBe("intent_force")
    expect((await decide({ text: "用最高档", judge: "heuristic" })).tier).toBe("max")
    const inherit = await decide({ text: "继续", prevTier: "high", judge: "heuristic" })
    expect(inherit.tier).toBe("high")
    expect(inherit.triggeredBy).toBe("intent_inherit")
    expect((await decide({ text: "继续", judge: "heuristic" })).tier).toBe("low")
    const oneShot = await decide({ text: "普通文本", oneShot: "max", judge: "heuristic" })
    expect(oneShot.tier).toBe("max")
    expect(oneShot.triggeredBy).toBe("one_shot")
  })

  test("escalation on regenerate floors the tier", async () => {
    const task = "帮我看看"
    const decision = await decide({ text: task, prevTask: task, prevTier: "low", judge: "heuristic" })
    expect(decision.regenerate).toBe(true)
    expect(decision.triggeredBy).toBe("escalate_regenerate")
    expect(decision.tier).toBe("high")
  })

  test("constraints cap the tier; judge off yields low", async () => {
    const capped = await decide({ text: "为什么这个算法这样设计", constraints: ["max"], judge: "heuristic" })
    expect(capped.baseTier).toBe("max") // rule 1
    expect(capped.tier).toBe("high")
    expect(capped.constrained).toBe(true)
    const off = await decide({ text: "复杂任务", judge: "off" })
    expect(off.tier).toBe("low")
  })
})

describe("config", () => {
  test("default tiers prefer deepseek-flash variants", () => {
    const tiers = pickDefaultTiers(MODELS)
    expect(tiers.low).toMatchObject({ providerID: "deepseek", id: "deepseek-flash", variant: "low" })
    expect(tiers.max).toMatchObject({ variant: "max" })
  })

  test("variant aliasing and route resolution", () => {
    const qwen = MODELS.find((model) => model.id === "qwen3.8-flash")!
    expect(variantFor(qwen, "max")).toBe("xhigh")
    expect(variantFor(qwen, "low")).toBe("low")
    expect(variantFor(MODELS.find((model) => model.id === "plain")!, "low")).toBeUndefined()
    const route = resolveRoute({ high: { providerID: "opencode-go", id: "qwen3.8-flash" } }, "high", MODELS)
    expect(route).toMatchObject({ providerID: "opencode-go", id: "qwen3.8-flash", variant: "medium" })
  })

  test("resolveTierRoute anchors to the session model (no cross-group jump)", () => {
    const anchor = { providerID: "opencode-go", id: "glm-5.3-flash" }
    expect(resolveTierRoute({}, "max", MODELS, anchor)).toMatchObject({ providerID: "opencode-go", id: "glm-5.3-flash", variant: "max" })
    // 当前模型无该档位 variant → null（保持不动, 不跨模型）
    expect(resolveTierRoute({}, "max", MODELS, { providerID: "x", id: "plain" })).toBeNull()
    // 未锚定 → 回退静态档位表（保留跨模型路由）
    expect(resolveTierRoute({ max: { providerID: "deepseek", id: "deepseek-flash", variant: "max" } }, "max", MODELS, null)).toMatchObject({ providerID: "deepseek" })
  })

  test("followSessionModel defaults on for auto tiers, off when tiers configured", () => {
    const root = mkdtempSync(join(tmpdir(), "ocrouter-anchcfg-"))
    const home = join(root, "home")
    const auto = loadConfig({ directory: join(root, "empty"), models: MODELS, home })
    expect(auto.followSessionModel).toBe(true)
    expect(auto.tiersConfigured).toBe(false)
    const configured = loadConfig({
      directory: join(root, "empty"),
      models: MODELS,
      home,
      pluginOptions: { tiers: { max: { providerID: "opencode-go", id: "glm-5.3-flash" } } },
    })
    expect(configured.tiersConfigured).toBe(true)
    expect(configured.followSessionModel).toBe(false)
    rmSync(root, { recursive: true, force: true })
  })

  test("file precedence: options > project > global", () => {
    const root = mkdtempSync(join(tmpdir(), "ocrouter-"))
    const home = join(root, "home")
    const project = join(root, "project")
    mkdirSync(join(home, ".config", "opencode"), { recursive: true })
    mkdirSync(join(project, ".opencode"), { recursive: true })
    writeFileSync(join(home, ".config", "opencode", "router-laya.json"), JSON.stringify({ mode: "manual", judge: "model" }))
    writeFileSync(join(project, ".opencode", "router-laya.json"), JSON.stringify({ mode: "auto" }))
    const config = loadConfig({ directory: project, models: MODELS, home })
    expect(config.mode).toBe("auto")
    expect(config.judge).toBe("model")
    expect(config.tiers.low).toMatchObject({ providerID: "deepseek" })
    const withOptions = loadConfig({ directory: project, models: MODELS, home, pluginOptions: { mode: "manual", fallback: "max" } })
    expect(withOptions.mode).toBe("manual")
    expect(withOptions.fallback).toBe("max")
    rmSync(root, { recursive: true, force: true })
  })
})

describe("mount (fake host)", () => {
  function fakeHost(directory: string, initialModel: Record<string, unknown> = { providerID: "deepseek", id: "deepseek-flash", variant: "low" }) {
    const tools: Array<{ name: string; execute: (input?: unknown, context?: unknown) => Promise<{ content?: string }> }> = []
    const commands: Array<{ name: string; execute: (input: unknown) => Promise<void> }> = []
    const synthetics: Array<{ sessionID: string; text?: string }> = []
    const switches: Array<Record<string, unknown>> = []
    let hook: ((input: { sessionID: string; prompt: { text: string } }) => Promise<void>) | null = null
    let rpcHandlers: Record<string, (input: unknown) => Promise<unknown>> | null = null
    const disposals: string[] = []
    const ctx = {
      location: { directory },
      options: {},
      model: { list: async () => ({ data: MODELS }) },
      generate: { text: async () => ({ text: '{"Q1":true,"Q2":false,"Q3":false,"Q4":false,"Q5":true,"Q6":false,"Q7":false}' }) },
      session: {
        hook: async (name: string, callback: typeof hook) => {
          if (name === "prompt") hook = callback
          return { dispose: async () => { disposals.push("hook") } }
        },
        switchModel: async (input: Record<string, unknown>) => {
          switches.push(input)
          return undefined
        },
        get: async () => ({
          model:
            switches.length > 0
              ? (switches[switches.length - 1]!.model as Record<string, unknown>)
              : initialModel,
        }),
        synthetic: async (input: { sessionID: string; text?: string }) => {
          synthetics.push(input)
          return {}
        },
      },
      tool: {
        transform: async (callback: (editor: { add: (definition: (typeof tools)[number]) => void }) => void) => {
          callback({ add: (definition) => tools.push(definition) })
          return { dispose: async () => { disposals.push("tool") } }
        },
      },
      command: {
        transform: async (callback: (editor: { add: (definition: (typeof commands)[number]) => void }) => void) => {
          callback({ add: (definition) => commands.push(definition) })
          return { dispose: async () => { disposals.push("command") } }
        },
      },
      rpc: {
        register: async (_definition: unknown, handlers: Record<string, (input: unknown) => Promise<unknown>>) => {
          rpcHandlers = handlers
          return { dispose: async () => { disposals.push("rpc") }, events: { emit: async () => {} } }
        },
      },
    }
    return { ctx: ctx as never, tools, commands, synthetics, switches, hook: () => hook, rpc: () => rpcHandlers, disposals }
  }

  test("routes a max-tier prompt in auto mode, respects manual", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocrouter-mount-"))
    const host = fakeHost(root)
    const cleanup = await createMount({ home: join(root, "home") })(host.ctx)

    expect(host.hook()).toBeTruthy()
    expect(host.tools.map((tool) => tool.name).sort()).toEqual(["router_decide", "router_history", "router_set", "router_status"])
    expect(host.commands.map((command) => command.name)).toEqual(["router"])

    // rule 1: Q4 且非 Q1 → max → 切换到 deepseek-flash:max
    await host.hook()!({ sessionID: "ses_1", prompt: { text: "为什么这个算法这样设计" } })
    expect(host.switches.length).toBe(1)
    expect(host.switches[0]).toMatchObject({ sessionID: "ses_1", model: { providerID: "deepseek", id: "deepseek-flash", variant: "max" } })

    // manual 模式: 只记录不切换
    const setResult = JSON.parse((await host.tools.find((tool) => tool.name === "router_set")!.execute({ mode: "manual" }, { sessionID: "ses_1" })).content ?? "{}")
    expect(setResult).toMatchObject({ ok: true, mode: "manual" })
    await host.hook()!({ sessionID: "ses_1", prompt: { text: "再修一个 bug（重发）" } })
    expect(host.switches.length).toBe(1)

    // 切回 auto + /router tier 一次性档位（与当前档不同 → 应切换）
    await host.tools.find((tool) => tool.name === "router_set")!.execute({ mode: "auto" }, { sessionID: "ses_1" })
    await host.rpc()!.setTier!({ tier: "low", sessionID: "ses_1" })
    await host.hook()!({ sessionID: "ses_1", prompt: { text: "普通的小问题" } })
    expect(host.switches.length).toBe(2)
    expect(host.switches[1]).toMatchObject({ model: { variant: "low" } })

    // 幂等: 下一轮同为 low → 不重复切换
    await host.hook()!({ sessionID: "ses_1", prompt: { text: "再问个小问题" } })
    expect(host.switches.length).toBe(2)

    const history = JSON.parse((await host.tools.find((tool) => tool.name === "router_history")!.execute({ limit: 10 })).content ?? "{}")
    expect(history.history.length).toBe(4)

    const preview = JSON.parse((await host.tools.find((tool) => tool.name === "router_decide")!.execute({ text: "用最高档" })).content ?? "{}")
    expect(preview.decision).toMatchObject({ tier: "max", triggeredBy: "intent_force" })

    const status = JSON.parse((await host.tools.find((tool) => tool.name === "router_status")!.execute({})).content ?? "{}")
    expect(status.mode).toBe("auto")
    expect(status.tiers.low).toMatchObject({ providerID: "deepseek", variant: "low" })

    await cleanup()
    expect(host.disposals).toContain("rpc")
    rmSync(root, { recursive: true, force: true })
  })

  test("anchors tier to the current session model (no cross-group jump)", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocrouter-anchor-"))
    const host = fakeHost(root, { providerID: "opencode-go", id: "glm-5.3-flash" })
    const cleanup = await createMount({ home: join(root, "home") })(host.ctx)

    // 当前在 opencode-go/glm-5.3-flash（无 variant）, 命中 max 档 → 只加 variant, 不跳 deepseek
    await host.hook()!({ sessionID: "ses_anchor", prompt: { text: "为什么这个算法这样设计" } })
    expect(host.switches.length).toBe(1)
    expect(host.switches[0]).toMatchObject({
      model: { providerID: "opencode-go", id: "glm-5.3-flash", variant: "max" },
    })

    // 用户手动降思考等级到 low（同模型改 variant）→ 插件跟随, 仍不换 provider
    await host.hook()!({ sessionID: "ses_anchor", prompt: { text: "省点，简单说说" } })
    const last = host.switches[host.switches.length - 1]!
    expect((last.model as Record<string, unknown>).providerID).toBe("opencode-go")
    expect((last.model as Record<string, unknown>).variant).toBe("low")

    await cleanup()
    rmSync(root, { recursive: true, force: true })
  })

  test("degrades on hosts without session hook", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocrouter-degrade-"))
    const cleanup = await createMount({ home: join(root, "home") })({ location: { directory: root }, options: {} } as never)
    expect(typeof cleanup).toBe("function")
    await cleanup()
    rmSync(root, { recursive: true, force: true })
  })
})
