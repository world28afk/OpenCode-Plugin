// 端到端冒烟测试: 用假 Context 驱动 mount(), 验证双层注入、profile 工具、profile RPC、卸载清理与降级。
//
//   bun test scripts/smoke.test.ts

import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { mount, PLUGIN_ID, PLUGIN_VERSION } from "../.opencode/plugins/oc-infinite-gen-4/src/mount"
import { PROMPT_CORE } from "../.opencode/plugins/oc-infinite-gen-4/src/prompts"

interface HookEntry {
  name: string
  callback: (event: { system: Array<{ type: string; text: string; metadata?: Record<string, unknown> }> }) => void
  disposed: boolean
}

interface ToolRegistration {
  disposed: boolean
}

interface ToolDefinition {
  name: string
  execute: () => Promise<{ content?: string }>
}

function makeContext(options: Record<string, unknown> = {}) {
  const hooks: HookEntry[] = []
  const toolRegistrations: ToolRegistration[] = []
  const tools: ToolDefinition[] = []
  let rpcDefinition: unknown = null
  let rpcHandlers: Record<string, () => Promise<unknown>> | null = null
  let rpcDisposed = false

  const ctx = {
    options,
    session: {
      hook: async (name: string, callback: HookEntry["callback"]) => {
        const entry: HookEntry = { name, callback, disposed: false }
        hooks.push(entry)
        return { dispose: async () => { entry.disposed = true } }
      },
    },
    tool: {
      transform: async (callback: (editor: Record<string, unknown>) => void) => {
        const registration: ToolRegistration = { disposed: false }
        toolRegistrations.push(registration)
        callback({
          add: (definition: ToolDefinition) => tools.push(definition),
          list: () => tools,
          get: () => undefined,
          namespace: () => {},
          update: () => {},
          remove: () => {},
        })
        return { dispose: async () => { registration.disposed = true } }
      },
    },
    rpc: {
      register: async (definition: unknown, handlers: Record<string, () => Promise<unknown>>) => {
        rpcDefinition = definition
        rpcHandlers = handlers
        return { dispose: async () => { rpcDisposed = true } }
      },
    },
  }

  return {
    ctx: ctx as unknown as Plugin.Context,
    hooks,
    tools,
    toolRegistrations,
    rpc: () => ({ definition: rpcDefinition, handlers: rpcHandlers, disposed: () => rpcDisposed }),
  }
}

describe("mount", () => {
  test("default options: dual-layer hook + profile tool + profile RPC + cleanup", async () => {
    const harness = makeContext()
    const cleanup = await mount(harness.ctx)

    expect(harness.hooks).toHaveLength(1)
    expect(harness.hooks[0]!.name).toBe("context")
    expect(harness.tools.map((tool) => tool.name)).toEqual(["infinite_gen4_profile"])
    expect(harness.toolRegistrations).toHaveLength(1)

    const event = { system: [] as Array<{ type: string; text: string; metadata?: Record<string, unknown> }> }
    harness.hooks[0]!.callback(event)
    expect(event.system).toHaveLength(2)
    expect(event.system[0]!.text).toBe(PROMPT_CORE)
    expect(event.system[1]!.text).toBe(PROMPT_CORE)
    expect(event.system[0]!.metadata).toMatchObject({ source: PLUGIN_ID, order: 100 })
    expect(event.system[1]!.metadata).toMatchObject({ source: PLUGIN_ID, order: 200 })

    await cleanup()
    expect(harness.hooks[0]!.disposed).toBe(true)
    expect(harness.toolRegistrations[0]!.disposed).toBe(true)
    expect(harness.rpc().disposed()).toBe(true)
  })

  test("profile RPC: /api/rpc/infinite.gen4.profile/get returns running metadata", async () => {
    const harness = makeContext()
    await mount(harness.ctx)

    const rpc = harness.rpc()
    expect((rpc.definition as { id?: string })?.id).toBe("infinite.gen4.profile")
    expect(typeof rpc.handlers?.get).toBe("function")

    const profile = (await rpc.handlers!.get!()) as Record<string, unknown>
    expect(profile.plugin).toBe(PLUGIN_ID)
    expect(profile.pluginVersion).toBe(PLUGIN_VERSION)
    expect((profile.injection as Array<{ enabled: boolean }>)[0]!.enabled).toBe(true)
    expect((profile.injection as Array<{ enabled: boolean }>)[1]!.enabled).toBe(true)
  })

  test("dualLayer=false: single-layer injection", async () => {
    const harness = makeContext({ dualLayer: false })
    await mount(harness.ctx)
    const event = { system: [] as Array<{ type: string; text: string; metadata?: Record<string, unknown> }> }
    harness.hooks[0]!.callback(event)
    expect(event.system).toHaveLength(1)
    expect(event.system[0]!.metadata).toMatchObject({ order: 100 })
  })

  test("inject=false: no hook, profile reflects disabled injection", async () => {
    const harness = makeContext({ inject: false })
    await mount(harness.ctx)
    expect(harness.hooks).toHaveLength(0)
    expect(harness.tools).toHaveLength(1)

    const result = await harness.tools[0]!.execute()
    const parsed = JSON.parse(result.content ?? "{}")
    expect(parsed.plugin).toBe(PLUGIN_ID)
    expect(parsed.injection[0].enabled).toBe(false)
    expect(parsed.injection[1].enabled).toBe(false)

    const rpcProfile = (await harness.rpc().handlers!.get!()) as { injection: Array<{ enabled: boolean }> }
    expect(rpcProfile.injection[0]!.enabled).toBe(false)
  })

  test("profileTool=false: hook + RPC only", async () => {
    const harness = makeContext({ profileTool: false })
    await mount(harness.ctx)
    expect(harness.hooks).toHaveLength(1)
    expect(harness.tools).toHaveLength(0)
    expect(typeof harness.rpc().handlers?.get).toBe("function")
  })

  test("degraded host (no session.hook / tool.transform / rpc): loads as no-op", async () => {
    const ctx = { options: {} } as unknown as Plugin.Context
    const cleanup = await mount(ctx)
    expect(typeof cleanup).toBe("function")
    await cleanup()
  })
})
