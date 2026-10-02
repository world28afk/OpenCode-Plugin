// 端到端冒烟测试 — 用假 Context 驱动 mount(), 网络用假 fetch。
//
//   bun test scripts/smoke.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { balanceURL, parseBalanceResponse, pickPrimary } from "../.opencode/plugins/oc-deepseek-banlance/src/deepseek"
import { formatCompact, formatContextLine, formatDetail } from "../.opencode/plugins/oc-deepseek-banlance/src/format"
import { parseJsonc, resolveApiKey } from "../.opencode/plugins/oc-deepseek-banlance/src/key"
import { mount } from "../.opencode/plugins/oc-deepseek-banlance/src/mount"
import { createBalanceService } from "../.opencode/plugins/oc-deepseek-banlance/src/service"

// ── 假 fetch (避免真实网络) ────────────────────────────────────────────────

const originalFetch = globalThis.fetch
let fetchCalls = 0

beforeAll(() => {
  globalThis.fetch = (async () => {
    fetchCalls += 1
    return new Response(
      JSON.stringify({
        is_available: true,
        balance_infos: [
          { currency: "CNY", total_balance: "42.50", granted_balance: "2.50", topped_up_balance: "40.00" },
          { currency: "USD", total_balance: "6.00", granted_balance: "0.00", topped_up_balance: "6.00" },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }) as typeof fetch
})

afterAll(() => {
  globalThis.fetch = originalFetch
})

// ── 假 Context ─────────────────────────────────────────────────────────────

function makeContext(options: Record<string, unknown> = {}) {
  const hooks: Array<{ name: string; callback: (event: { system: Array<Record<string, unknown>> }) => void; disposed: boolean }> = []
  const tools: Array<{ name: string; execute: (input?: unknown) => Promise<{ content?: string; metadata?: unknown }> }> = []
  const disposals: string[] = []
  let rpcDefinition: unknown = null
  let rpcHandlers: Record<string, (input: unknown, context?: unknown) => Promise<unknown>> | null = null
  const events: Array<{ name: string; data: unknown }> = []

  const ctx = {
    options,
    location: { directory: process.cwd() },
    storage: {
      get: async () => undefined,
      set: async () => {},
      remove: async () => {},
    },
    rpc: {
      register: async (definition: unknown, handlers: Record<string, (input: unknown, context?: unknown) => Promise<unknown>>) => {
        rpcDefinition = definition
        rpcHandlers = handlers
        return {
          dispose: async () => {
            disposals.push("rpc")
          },
          events: {
            emit: async (name: string, data: unknown) => {
              events.push({ name, data })
            },
          },
        }
      },
    },
    tool: {
      transform: async (callback: (editor: Record<string, unknown>) => void) => {
        callback({
          add: (definition: { name: string; execute: (input?: unknown) => Promise<{ content?: string; metadata?: unknown }> }) => tools.push(definition),
          list: () => tools,
          get: () => undefined,
          namespace: () => {},
          update: () => {},
          remove: () => {},
        })
        return {
          dispose: async () => {
            disposals.push("tool")
          },
        }
      },
    },
    session: {
      hook: async (name: string, callback: (event: { system: Array<Record<string, unknown>> }) => void) => {
        const entry = { name, callback, disposed: false }
        hooks.push(entry)
        return {
          dispose: async () => {
            entry.disposed = true
            disposals.push("session")
          },
        }
      },
    },
  }

  return {
    ctx: ctx as never,
    hooks,
    tools,
    disposals,
    events,
    rpc: () => ({ definition: rpcDefinition, handlers: rpcHandlers }),
  }
}

// ── 纯函数 ─────────────────────────────────────────────────────────────────

describe("deepseek client", () => {
  test("balanceURL handles /v1 suffix", () => {
    expect(balanceURL(undefined)).toBe("https://api.deepseek.com/user/balance")
    expect(balanceURL("https://api.deepseek.com/v1")).toBe("https://api.deepseek.com/user/balance")
    expect(balanceURL("https://proxy.example.com/base/")).toBe("https://proxy.example.com/base/user/balance")
  })

  test("parseBalanceResponse filters invalid entries", () => {
    const parsed = parseBalanceResponse({
      is_available: true,
      balance_infos: [
        { currency: "CNY", total_balance: "1", granted_balance: "0", topped_up_balance: "1" },
        { currency: 1, total_balance: "x" },
        null,
      ],
    })
    expect(parsed.is_available).toBe(true)
    expect(parsed.balance_infos).toHaveLength(1)
  })

  test("pickPrimary prefers CNY", () => {
    const cny = { currency: "CNY", total_balance: "1", granted_balance: "0", topped_up_balance: "1" }
    const usd = { currency: "USD", total_balance: "2", granted_balance: "0", topped_up_balance: "2" }
    expect(pickPrimary([usd, cny])?.currency).toBe("CNY")
    expect(pickPrimary([usd])?.currency).toBe("USD")
    expect(pickPrimary([])).toBeNull()
  })
})

describe("key resolution", () => {
  test("parseJsonc strips comments and trailing commas", () => {
    const parsed = parseJsonc('{\n  // comment\n  "a": 1, /* block */\n  "b": [1, 2,],\n}') as Record<string, unknown>
    expect(parsed.a).toBe(1)
    expect(parsed.b).toEqual([1, 2])
  })

  test("priority: options > env > auth.json > config", () => {
    const home = mkdtempSync(join(tmpdir(), "oc-bal-home-"))
    mkdirSync(join(home, ".local", "share", "opencode"), { recursive: true })
    writeFileSync(join(home, ".local", "share", "opencode", "auth.json"), JSON.stringify({ deepseek: { type: "api", key: "sk-auth" } }))
    const configHome = join(home, ".config")
    mkdirSync(join(configHome, "opencode"), { recursive: true })
    writeFileSync(join(configHome, "opencode", "opencode.json"), JSON.stringify({ provider: { ds: { options: { apiKey: "sk-config" } } } }))

    expect(resolveApiKey({ apiKey: "sk-opt", env: {}, home, configHome }).key).toBe("sk-opt")
    expect(resolveApiKey({ env: { DEEPSEEK_API_KEY: "sk-env" }, home, configHome }).source).toBe("env:DEEPSEEK_API_KEY")
    expect(resolveApiKey({ env: {}, home, configHome }).source).toBe("auth.json:deepseek")
    rmSync(join(home, ".local", "share", "opencode", "auth.json"))
    const fromConfig = resolveApiKey({ env: {}, home, configHome })
    expect(fromConfig.key).toBe("sk-config")
    rmSync(home, { recursive: true, force: true })
  })

  test("no key => source none", () => {
    const home = mkdtempSync(join(tmpdir(), "oc-bal-empty-"))
    const resolved = resolveApiKey({ env: {}, home, configHome: join(home, ".config") })
    expect(resolved.key).toBeNull()
    expect(resolved.source).toBe("none")
    rmSync(home, { recursive: true, force: true })
  })
})

describe("balance service", () => {
  const makeResult = (total: string) => ({
    ok: true,
    noKey: false,
    error: null,
    source: "test",
    isAvailable: true,
    infos: [{ currency: "CNY", total_balance: total, granted_balance: "0", topped_up_balance: total }],
    primary: { currency: "CNY", total_balance: total, granted_balance: "0", topped_up_balance: total },
  })

  test("ttl cache + force refresh + change events", async () => {
    let calls = 0
    let time = 1_000
    const service = createBalanceService({
      load: async () => {
        calls += 1
        return makeResult(String(calls))
      },
      ttlMs: 1_000,
      now: () => time,
    })
    const events: number[] = []
    service.onChange((snapshot) => events.push(snapshot.updatedAt))

    const first = await service.get()
    expect(first.primary?.total_balance).toBe("1")
    await service.get()
    expect(calls).toBe(1)
    time += 2_000
    await service.get()
    expect(calls).toBe(2)
    await service.get(true)
    expect(calls).toBe(3)
    expect(events.length).toBe(3)
  })

  test("error keeps last good snapshot", async () => {
    let mode: "ok" | "fail" = "ok"
    const service = createBalanceService({
      load: async () => {
        if (mode === "fail") throw new Error("boom")
        return makeResult("9.99")
      },
      ttlMs: 0,
    })
    await service.get()
    mode = "fail"
    const failed = await service.get(true)
    expect(failed.ok).toBe(false)
    expect(failed.error).toContain("boom")
    expect(failed.primary?.total_balance).toBe("9.99")
    expect(failed.lastGoodAt).toBeNumber()
  })

  test("seed hydrates persisted snapshot", () => {
    const service = createBalanceService({ load: async () => makeResult("1") })
    service.seed({ ...makeResult("77.7"), updatedAt: 42 })
    expect(service.snapshot()?.primary?.total_balance).toBe("77.7")
  })
})

describe("format", () => {
  const snapshot = {
    ok: true,
    noKey: false,
    error: null,
    source: "env:DEEPSEEK_API_KEY",
    isAvailable: true,
    infos: [{ currency: "CNY", total_balance: "12.34", granted_balance: "1.00", topped_up_balance: "11.34" }],
    primary: { currency: "CNY", total_balance: "12.34", granted_balance: "1.00", topped_up_balance: "11.34" },
    updatedAt: 1_700_000_000_000,
    lastGoodAt: 1_700_000_000_000,
  }

  test("compact/detail/context line", () => {
    expect(formatCompact(snapshot)).toBe("¥12.34")
    expect(formatCompact(null)).toBe("…")
    expect(formatDetail(snapshot)).toContain("总余额 ¥12.34")
    expect(formatDetail(snapshot)).toContain("赠金 ¥1.00")
    expect(formatContextLine(snapshot)).toContain("[DeepSeek 余额] ¥12.34")
  })

  test("noKey detail mentions configuration paths", () => {
    const text = formatDetail({ ...snapshot, ok: false, noKey: true, primary: null, isAvailable: null })
    expect(text).toContain("未找到 DeepSeek API Key")
    expect(text).toContain("DEEPSEEK_API_KEY")
  })
})

describe("mount (fake host)", () => {
  test("registers rpc + tool, serves balance, disposes", async () => {
    const harness = makeContext({ apiKey: "sk-test", ttlMs: 60_000 })
    const before = fetchCalls
    const cleanup = await mount(harness.ctx)

    const rpc = harness.rpc()
    expect(rpc.definition).toMatchObject({ id: "deepseek.balance.v1" })
    expect(typeof rpc.handlers?.get).toBe("function")
    expect(typeof rpc.handlers?.refresh).toBe("function")

    const snapshot = (await rpc.handlers!.get!({ refresh: true })) as Record<string, unknown>
    expect(snapshot.ok).toBe(true)
    expect((snapshot.primary as Record<string, unknown>).total_balance).toBe("42.50")
    expect(fetchCalls).toBeGreaterThan(before)

    expect(harness.tools.map((tool) => tool.name)).toContain("deepseek_balance")
    const result = await harness.tools[0]!.execute({})
    expect(result.content).toContain("DeepSeek 账户余额")

    const eventsBefore = harness.events.length
    await rpc.handlers!.refresh!({})
    expect(harness.events.length).toBeGreaterThan(eventsBefore)
    expect(harness.events.at(-1)?.name).toBe("updated")

    await cleanup()
    expect(harness.disposals).toContain("rpc")
    expect(harness.disposals).toContain("tool")
  })

  test("contextLine=true injects one line into system", async () => {
    const harness = makeContext({ apiKey: "sk-test", contextLine: true })
    await mount(harness.ctx)
    await harness.rpc().handlers!.get!({ refresh: true }) // 确保快照已就绪
    expect(harness.hooks).toHaveLength(1)
    const event = { system: [] as Array<Record<string, unknown>> }
    harness.hooks[0]!.callback(event)
    expect(event.system).toHaveLength(1)
    expect(String(event.system[0]!.text)).toContain("[DeepSeek 余额]")
  })

  test("degrades on hosts without rpc/tool/session", async () => {
    const ctx = { options: {}, location: {} } as never
    const cleanup = await mount(ctx)
    expect(typeof cleanup).toBe("function")
    await cleanup()
  })

  test("no key => noKey snapshot (isolated home)", async () => {
    const isolatedHome = mkdtempSync(join(tmpdir(), "oc-bal-mount-"))
    const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY }
    process.env.USERPROFILE = isolatedHome
    process.env.HOME = isolatedHome
    process.env.XDG_CONFIG_HOME = join(isolatedHome, ".config")
    delete process.env.DEEPSEEK_API_KEY
    try {
      const harness = makeContext({ ttlMs: 0 })
      await mount(harness.ctx)
      const snapshot = (await harness.rpc().handlers!.get!({ refresh: true })) as Record<string, unknown>
      expect(snapshot.noKey).toBe(true)
      expect(snapshot.ok).toBe(false)
    } finally {
      if (saved.USERPROFILE !== undefined) process.env.USERPROFILE = saved.USERPROFILE
      if (saved.HOME !== undefined) process.env.HOME = saved.HOME
      if (saved.XDG_CONFIG_HOME !== undefined) process.env.XDG_CONFIG_HOME = saved.XDG_CONFIG_HOME
      if (saved.DEEPSEEK_API_KEY !== undefined) process.env.DEEPSEEK_API_KEY = saved.DEEPSEEK_API_KEY
      rmSync(isolatedHome, { recursive: true, force: true })
    }
  })
})
