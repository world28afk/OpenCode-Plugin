// 端到端冒烟测试: 用假 Context 驱动 mount(), 验证注入 hook、purge 工具集、状态 RPC、
// 技能/服务器/本地规则操作、状态持久化、卸载清理与旧运行时降级。
//
//   bun test scripts/smoke.test.ts

import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { mount, PLUGIN_ID, PLUGIN_VERSION } from "../.opencode/plugins/oc-purge/src/mount"

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

const TOOL_NAMES = [
  "purge_status",
  "purge_apply",
  "purge_revert",
  "purge_inject",
  "purge_rules",
  "purge_skills",
  "purge_servers",
  "purge_cwd",
]

function makeContext(options: Record<string, unknown> = {}) {
  const hooks: HookEntry[] = []
  const tools: ToolDefinition[] = []
  const commands: Array<Record<string, unknown>> = []
  const flags = { toolDisposed: false, rpcDisposed: false, commandDisposed: false }
  let rpcDefinition: unknown = null
  let rpcHandlers: Record<string, (input: unknown) => Promise<unknown>> | null = null
  let stored: unknown = options.initialState

  const editor = () => ({
    add: (definition: ToolDefinition) => tools.push(definition),
    list: () => tools,
    get: () => undefined,
    namespace: () => {},
    update: () => {},
    remove: () => {},
  })

  const ctx: Record<string, unknown> = {
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
      transform: async (callback: (e: ReturnType<typeof editor>) => void) => {
        callback(editor())
        return { dispose: async () => { flags.toolDisposed = true } }
      },
    },
    rpc: {
      register: async (definition: unknown, handlers: Record<string, (input: unknown) => Promise<unknown>>) => {
        rpcDefinition = definition
        rpcHandlers = handlers
        return { dispose: async () => { flags.rpcDisposed = true } }
      },
    },
  }
  if (options.withCommands) {
    ctx.command = {
      transform: async (callback: (e: { add: (def: Record<string, unknown>) => void }) => void) => {
        callback({ add: (def) => commands.push(def) })
        return { dispose: async () => { flags.commandDisposed = true } }
      },
      reload: () => {},
    }
  }

  return {
    ctx: ctx as unknown as Plugin.Context,
    hooks,
    tools,
    commands,
    stored: () => stored,
    flags,
    rpc: () => ({ definition: rpcDefinition, handlers: rpcHandlers }),
  }
}

const systemOf = (hook: HookEntry) => {
  const event = { system: [] as SystemPart[] }
  hook.callback(event)
  return event.system
}

describe("oc-purge mount", () => {
  test("default: inject hook + 8 tools + status RPC + cleanup", async () => {
    const harness = makeContext()
    const cleanup = await mount(harness.ctx)

    expect(harness.hooks).toHaveLength(1)
    expect(harness.hooks[0]!.name).toBe("context")
    expect(harness.tools.map((tool) => tool.name)).toEqual(TOOL_NAMES)

    const parts = systemOf(harness.hooks[0]!)
    expect(parts).toHaveLength(2)
    expect(parts[0]!.metadata).toMatchObject({ source: PLUGIN_ID, slot: "oc-purge:inject", order: -100000 })
    expect(parts[0]!.text).toContain("HARD OUTPUT RULES")
    expect(parts[0]!.text).not.toContain("<|im_start|>")
    expect(parts[1]!.metadata).toMatchObject({ slot: "oc-purge:capabilities", order: -99999 })

    await cleanup()
    expect(harness.hooks[0]!.disposed).toBe(true)
    expect(harness.flags.toolDisposed).toBe(true)
    expect(harness.flags.rpcDisposed).toBe(true)
  })

  test("status RPC returns running metadata + all control methods", async () => {
    const harness = makeContext()
    await mount(harness.ctx)
    const rpc = harness.rpc()
    expect((rpc.definition as { id?: string })?.id).toBe("purge.status")
    for (const method of ["get", "set", "apply", "revert", "rules", "skills", "servers", "cwd"]) {
      expect(typeof rpc.handlers?.[method]).toBe("function")
    }
    const profile = (await rpc.handlers!.get!({})) as Record<string, any>
    expect(profile.plugin).toBe(PLUGIN_ID)
    expect(profile.pluginVersion).toBe(PLUGIN_VERSION)
    expect(profile.promptSource).toBe("default")
    expect(profile.skills.ids.length).toBeGreaterThanOrEqual(20)
  })

  test("commands registered when host exposes command.transform", async () => {
    const harness = makeContext({ withCommands: true })
    const cleanup = await mount(harness.ctx)
    expect(harness.commands.map((def) => def.name)).toEqual(["purge", "rules", "skills"])
    await cleanup()
    expect(harness.flags.commandDisposed).toBe(true)
  })

  test("purge_apply / purge_revert toggle custom text", async () => {
    const harness = makeContext()
    await mount(harness.ctx)
    const find = (name: string) => harness.tools.find((tool) => tool.name === name)!
    await find("purge_inject").execute({ action: "set-text", text: "X" })
    await find("purge_revert").execute({})
    expect(readJson(await find("purge_status").execute({})).promptSource).toBe("default")
    await find("purge_inject").execute({ action: "disable" })
    await find("purge_apply").execute({})
    expect(readJson(await find("purge_status").execute({})).enabled).toBe(true)
  })

  test("policy=strict with no user text: nothing injected", async () => {
    const harness = makeContext()
    await mount(harness.ctx)
    await harness.tools.find((tool) => tool.name === "purge_inject")!.execute({ action: "set-policy", policy: "strict" })
    expect(systemOf(harness.hooks[0]!).map((part) => part.metadata?.slot)).toEqual(["oc-purge:capabilities"])
  })

  test("purge_rules: save + use drives injection (one-click switching)", async () => {
    const harness = makeContext()
    await mount(harness.ctx)
    const tool = harness.tools.find((item) => item.name === "purge_rules")!
    await tool.execute({ action: "save", id: "alpha", name: "Alpha", content: "RULE-ALPHA" })
    await tool.execute({ action: "use", id: "alpha" })
    expect(systemOf(harness.hooks[0]!)[0]!.text).toBe("RULE-ALPHA")
    const status = readJson(await tool.execute({ action: "list" }))
    expect(status.activeScheme.id).toBe("alpha")
    expect(status.schemes).toHaveLength(1)
    expect(status.promptSource).toBe("rule")
  })

  test("model binding overrides the active scheme for that model", async () => {
    const harness = makeContext()
    await mount(harness.ctx)
    const tool = harness.tools.find((item) => item.name === "purge_rules")!
    await tool.execute({ action: "save", id: "base", name: "Base", content: "SCHEME-BASE" })
    await tool.execute({ action: "save", id: "opus", name: "Opus", content: "SCHEME-OPUS" })
    await tool.execute({ action: "use", id: "base" })
    await tool.execute({ action: "bind", kind: "model", key: "google/claude-opus-4", id: "opus" })

    const event = { system: [] as SystemPart[], model: { providerID: "google", id: "claude-opus-4" } }
    harness.hooks[0]!.callback(event as never)
    expect(event.system[0]!.text).toBe("SCHEME-OPUS")
    expect(event.system[0]!.metadata).toMatchObject({ origin: "binding" })

    const other = { system: [] as SystemPart[], model: { providerID: "ds", id: "deepseek-flash" } }
    harness.hooks[0]!.callback(other as never)
    expect(other.system[0]!.text).toBe("SCHEME-BASE")

    const status = readJson(await tool.execute({ action: "list" }))
    expect(status.bindings.model["google/claude-opus-4"]).toBe("opus")
  })

  test("purge_rules: duplicate / rename / delete", async () => {
    const harness = makeContext()
    await mount(harness.ctx)
    const tool = harness.tools.find((item) => item.name === "purge_rules")!
    await tool.execute({ action: "save", id: "a", name: "A", content: "AAA" })
    const dup = readJson(await tool.execute({ action: "duplicate", id: "a", newId: "b" }))
    expect(dup.ok).toBe(true)
    await tool.execute({ action: "rename", id: "b", name: "Bee" })
    const listed = readJson(await tool.execute({ action: "list" }))
    expect(listed.schemes.map((s: { id: string; name: string }) => `${s.id}:${s.name}`)).toEqual(["a:A", "b:Bee"])
    await tool.execute({ action: "bind", kind: "model", key: "m", id: "b" })
    await tool.execute({ action: "delete", id: "b" })
    expect(readJson(await tool.execute({ action: "list" })).bindings.model.m).toBeUndefined()
  })

  test("purge_servers: normalization drops keys / ranges / wildcards", async () => {
    const harness = makeContext()
    await mount(harness.ctx)
    const tool = harness.tools.find((item) => item.name === "purge_servers")!
    const result = readJson(await tool.execute({ action: "set", text: "203.0.113.10\nmy-vps.example.com\n10.0.0.0/8\n*.evil.com\n-----BEGIN OPENSSH PRIVATE KEY-----" }))
    expect(result.hosts).toEqual(["203.0.113.10", "my-vps.example.com"])
    expect(result.text).toBe("203.0.113.10\nmy-vps.example.com\n")
  })

  test("purge_skills: create / list / delete in a temp dir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-purge-skills-"))
    try {
      const harness = makeContext({ skillsDir: dir })
      await mount(harness.ctx)
      const tool = harness.tools.find((item) => item.name === "purge_skills")!
      const created = readJson(await tool.execute({ action: "create", id: "code-review", description: "review code" }))
      expect(created.ok).toBe(true)
      expect(existsSync(join(dir, "code-review", "SKILL.md"))).toBe(true)
      expect(readFileSync(join(dir, "code-review", "SKILL.md"), "utf8")).toContain("name: code-review")

      const listed = readJson(await tool.execute({ action: "list" }))
      expect(listed.installed).toContain("code-review")

      const installed = readJson(await tool.execute({ action: "install", ids: ["nuclei-scan"] }))
      expect(installed.installed).toEqual(["nuclei-scan"])

      const removed = readJson(await tool.execute({ action: "delete", id: "code-review" }))
      expect(removed.ok).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("purge_cwd: scan returns candidate structure", async () => {
    const harness = makeContext({ directory: process.cwd() })
    await mount(harness.ctx)
    const result = readJson(await harness.tools.find((item) => item.name === "purge_cwd")!.execute({ action: "scan" }))
    expect(typeof result.cwd).toBe("string")
    expect(Array.isArray(result.items)).toBe(true)
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

  test("RPC set / rules / servers drive state", async () => {
    const harness = makeContext()
    await mount(harness.ctx)
    const updated = (await harness.rpc().handlers!.set!({ policy: "strict", serversText: "198.51.100.7" })) as Record<string, any>
    expect(updated.policy).toBe("strict")
    expect(updated.servers.hosts).toEqual(["198.51.100.7"])
    const rules = (await harness.rpc().handlers!.rules!({ action: "list" })) as Record<string, any>
    expect(Array.isArray(rules.schemes)).toBe(true)
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
    expect(harness.tools).toHaveLength(8)
    expect(readJson(await harness.tools[0]!.execute({})).injection[0].enabled).toBe(false)
  })
})
