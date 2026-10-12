// 端到端冒烟测试: 用假 Context 驱动 mount(), 验证注入 hook、purge 工具、状态 RPC、技能导出、
// 状态持久化、卸载清理与旧运行时降级。
//
//   bun test scripts/smoke.test.ts

import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { mount, PLUGIN_ID, PLUGIN_VERSION } from "../.opencode/plugins/oc-purge/src/mount"
import { DEFAULT_PROMPT } from "../.opencode/plugins/oc-purge/src/prompts"

interface SystemPart {
  type: string
  text: string
  metadata?: Record<string, unknown>
}

interface HookEntry {
  name: string
  callback: (event: { system: SystemPart[] }) => void
  disposed: boolean
}

interface ToolDefinition {
  name: string
  execute: (input: Record<string, unknown>, context?: unknown) => Promise<{ content?: string }>
}

const readJson = (value: { content?: string }) => JSON.parse(value.content ?? "{}") as Record<string, any>

function makeContext(options: Record<string, unknown> = {}) {
  const hooks: HookEntry[] = []
  const tools: ToolDefinition[] = []
  const toolDisposed = { value: false }
  const rpcDisposed = { value: false }
  let rpcDefinition: unknown = null
  let rpcHandlers: Record<string, (input: unknown) => Promise<unknown>> | null = null
  let stored: unknown = options.initialState

  const ctx = {
    options,
    location: { directory: options.directory },
    storage: {
      get: async (key: string) => (key === "state" ? stored : undefined),
      set: async (key: string, value: unknown) => {
        if (key === "state") stored = value
      },
    },
    session: {
      hook: async (name: string, callback: HookEntry["callback"]) => {
        const entry: HookEntry = { name, callback, disposed: false }
        hooks.push(entry)
        return { dispose: async () => { entry.disposed = true } }
      },
    },
    tool: {
      transform: async (callback: (editor: Record<string, unknown>) => void) => {
        callback({
          add: (definition: ToolDefinition) => tools.push(definition),
          list: () => tools,
          get: () => undefined,
          namespace: () => {},
          update: () => {},
          remove: () => {},
        })
        return { dispose: async () => { toolDisposed.value = true } }
      },
    },
    rpc: {
      register: async (definition: unknown, handlers: Record<string, (input: unknown) => Promise<unknown>>) => {
        rpcDefinition = definition
        rpcHandlers = handlers
        return { dispose: async () => { rpcDisposed.value = true } }
      },
    },
  }

  return {
    ctx: ctx as unknown as Plugin.Context,
    hooks,
    tools,
    stored: () => stored,
    toolDisposed,
    rpc: () => ({ definition: rpcDefinition, handlers: rpcHandlers, disposed: rpcDisposed.value }),
  }
}

const systemOf = (hook: HookEntry) => {
  const event = { system: [] as SystemPart[] }
  hook.callback(event)
  return event.system
}

describe("oc-purge mount", () => {
  test("default: inject hook + 4 purge tools + status RPC + cleanup", async () => {
    const harness = makeContext()
    const cleanup = await mount(harness.ctx)

    expect(harness.hooks).toHaveLength(1)
    expect(harness.hooks[0]!.name).toBe("context")
    expect(harness.tools.map((tool) => tool.name)).toEqual([
      "purge_status",
      "purge_inject",
      "purge_rules",
      "purge_skills",
    ])

    const parts = systemOf(harness.hooks[0]!)
    expect(parts).toHaveLength(2) // 注入正文 + 能力协议
    expect(parts[0]!.metadata).toMatchObject({ source: PLUGIN_ID, slot: "dshpg-inject", order: -100000 })
    expect(parts[0]!.text).toContain("HARD OUTPUT RULES")
    expect(parts[1]!.metadata).toMatchObject({ slot: "dshpg-capabilities", order: -99999 })

    await cleanup()
    expect(harness.hooks[0]!.disposed).toBe(true)
    expect(harness.toolDisposed.value).toBe(true)
    expect(harness.rpc().disposed).toBe(true)
  })

  test("status RPC returns running metadata (plugin marker)", async () => {
    const harness = makeContext()
    await mount(harness.ctx)
    const rpc = harness.rpc()
    expect((rpc.definition as { id?: string })?.id).toBe("dsh.purge.status")

    const profile = (await rpc.handlers!.get!({})) as Record<string, any>
    expect(profile.plugin).toBe(PLUGIN_ID)
    expect(profile.pluginVersion).toBe(PLUGIN_VERSION)
    expect(profile.promptSource).toBe("default")
    expect((profile.injection as Array<{ enabled: boolean }>)[0]!.enabled).toBe(true)
    expect(profile.skills.ids.length).toBeGreaterThanOrEqual(20)
  })

  test("purge_inject set-text: custom text replaces the default asset", async () => {
    const harness = makeContext()
    await mount(harness.ctx)
    const tool = harness.tools.find((item) => item.name === "purge_inject")!
    await tool.execute({ action: "set-text", text: "CUSTOM-PURGE-TEXT" })

    const parts = systemOf(harness.hooks[0]!)
    expect(parts[0]!.text).toBe("CUSTOM-PURGE-TEXT")
    expect(parts[0]!.metadata).toMatchObject({ origin: "custom" })

    const status = readJson(await harness.tools[0]!.execute({}))
    expect(status.promptSource).toBe("custom")
    expect(status.customTextBytes).toBe("CUSTOM-PURGE-TEXT".length)
  })

  test("policy=strict with no user text: nothing injected", async () => {
    const harness = makeContext()
    await mount(harness.ctx)
    const tool = harness.tools.find((item) => item.name === "purge_inject")!
    await tool.execute({ action: "set-policy", policy: "strict" })

    const parts = systemOf(harness.hooks[0]!)
    expect(parts.map((part) => part.metadata?.slot)).toEqual(["dshpg-capabilities"])
  })

  test("policy=always: default asset appended after custom text", async () => {
    const harness = makeContext()
    await mount(harness.ctx)
    const tool = harness.tools.find((item) => item.name === "purge_inject")!
    await tool.execute({ action: "set-text", text: "HEAD" })
    await tool.execute({ action: "set-policy", policy: "always" })

    const parts = systemOf(harness.hooks[0]!)
    expect(parts[0]!.text.startsWith("HEAD")).toBe(true)
    expect(parts[0]!.text).toContain("HARD OUTPUT RULES")
    expect(parts[0]!.metadata).toMatchObject({ origin: "always" })
  })

  test("purge_rules: upsert + activate drives injection", async () => {
    const harness = makeContext()
    await mount(harness.ctx)
    const tool = harness.tools.find((item) => item.name === "purge_rules")!
    await tool.execute({ action: "upsert", id: "alpha", name: "Alpha", content: "RULE-ALPHA" })
    await tool.execute({ action: "activate", id: "alpha" })

    expect(systemOf(harness.hooks[0]!)[0]!.text).toBe("RULE-ALPHA")
    const list = readJson(await tool.execute({ action: "list" }))
    expect(list.active).toBe("alpha")
    expect(list.rules).toHaveLength(1)

    await tool.execute({ action: "delete", id: "alpha" })
    expect(readJson(await tool.execute({ action: "list" })).active).toBe(null)
  })

  test("purge_skills: install bundled skills to a temp dir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-purge-skills-"))
    try {
      const harness = makeContext({ skillsDir: dir })
      await mount(harness.ctx)
      const tool = harness.tools.find((item) => item.name === "purge_skills")!
      const result = readJson(await tool.execute({ action: "install", ids: ["nuclei-scan", "fofa-recon"] }))
      expect(result.ok).toBe(true)
      expect(result.installed.sort()).toEqual(["fofa-recon", "nuclei-scan"])
      const skillPath = join(dir, "dsh-purge-nuclei-scan", "SKILL.md")
      expect(existsSync(skillPath)).toBe(true)
      expect(readFileSync(skillPath, "utf8").length).toBeGreaterThan(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("state persists through ctx.storage and reloads on mount", async () => {
    const first = makeContext()
    await mount(first.ctx)
    await first.tools.find((item) => item.name === "purge_inject")!.execute({ action: "disable" })
    expect((first.stored() as { enabled: boolean }).enabled).toBe(false)

    const second = makeContext({ initialState: first.stored() })
    await mount(second.ctx)
    expect(systemOf(second.hooks[0]!)).toHaveLength(0)
  })

  test("RPC set writes state", async () => {
    const harness = makeContext()
    await mount(harness.ctx)
    const updated = (await harness.rpc().handlers!.set!({ policy: "strict", capabilityProtocol: false })) as Record<string, any>
    expect(updated.policy).toBe("strict")
    expect(updated.capabilityProtocol).toBe(false)
    expect(systemOf(harness.hooks[0]!)).toHaveLength(0)
  })

  test("degraded host (no session/tool/rpc/storage): loads as no-op", async () => {
    const ctx = { options: {} } as unknown as Plugin.Context
    const cleanup = await mount(ctx)
    expect(typeof cleanup).toBe("function")
    await cleanup()
  })

  test("inject=false: no hook, tools still register", async () => {
    const harness = makeContext({ inject: false })
    await mount(harness.ctx)
    expect(harness.hooks).toHaveLength(0)
    expect(harness.tools).toHaveLength(4)
    const status = readJson(await harness.tools[0]!.execute({}))
    expect((status.injection as Array<{ enabled: boolean }>)[0]!.enabled).toBe(false)
  })
})
