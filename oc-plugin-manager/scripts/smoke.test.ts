// 端到端冒烟测试 — 扫描/切换引擎 + 配置编辑 + mount 挂载（全部在临时目录内, 不触碰真实环境）。
//
//   bun test scripts/smoke.test.ts

import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { listConfigPlugins, locatePluginsArray, parseJsonc, setConfigPluginEnabled } from "../.opencode/plugins/oc-plugin-manager/src/config"
import { listAll, scanPluginRoot, setEnabled } from "../.opencode/plugins/oc-plugin-manager/src/manager"
import { mount } from "../.opencode/plugins/oc-plugin-manager/src/mount"

function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "ocpm-"))
  const project = join(root, "project")
  const home = join(root, "home")
  const configHome = join(home, ".config")
  mkdirSync(join(project, ".opencode", "plugins"), { recursive: true })
  mkdirSync(join(configHome, "opencode"), { recursive: true })
  return { root, project, home, configHome, options: { projectDir: project, home, configHome } }
}

describe("config jsonc", () => {
  test("parseJsonc handles comments and trailing commas", () => {
    const parsed = parseJsonc('{\n  // c\n  "plugins": ["a",], /* x */\n}') as { plugins: string[] }
    expect(parsed.plugins).toEqual(["a"])
  })

  test("locatePluginsArray finds the range", () => {
    const text = '{\n  "plugins": [\n    "a", "b"\n  ],\n  "other": [1]\n}'
    const range = locatePluginsArray(text)
    expect(range).not.toBeNull()
    expect(text.slice(range!.start, range!.end)).toBe('[\n    "a", "b"\n  ]')
  })

  test("list + disable + enable string entries (preserve other content)", () => {
    const ws = makeWorkspace()
    const file = join(ws.configHome, "opencode", "opencode.json")
    writeFileSync(file, '{\n  // keep me\n  "plugins": ["alpha", "beta"],\n  "username": "tester"\n}\n')

    const entries = listConfigPlugins({ path: file, scope: "global" })
    expect(entries.map((e) => `${e.id}:${e.enabled}`)).toEqual(["alpha:true", "beta:true"])

    expect(setConfigPluginEnabled({ path: file, scope: "global" }, "alpha", false).ok).toBe(true)
    let text = readFileSync(file, "utf8")
    expect(text).toContain('"-alpha"')
    expect(text).toContain("// keep me")
    let after = listConfigPlugins({ path: file, scope: "global" })
    expect(after.find((e) => e.id === "alpha")!.enabled).toBe(false)
    expect(after.find((e) => e.id === "beta")!.enabled).toBe(true)

    expect(setConfigPluginEnabled({ path: file, scope: "global" }, "alpha", true).ok).toBe(true)
    text = readFileSync(file, "utf8")
    expect(text).not.toContain('"-alpha"')
    expect(text).toContain("// keep me")
    after = listConfigPlugins({ path: file, scope: "global" })
    expect(after.find((e) => e.id === "alpha")!.enabled).toBe(true)

    rmSync(ws.root, { recursive: true, force: true })
  })

  test("empty plugins array disable keeps valid json", () => {
    const ws = makeWorkspace()
    const file = join(ws.configHome, "opencode", "opencode.json")
    writeFileSync(file, '{\n  "plugins": []\n}\n')
    expect(setConfigPluginEnabled({ path: file, scope: "global" }, "alpha", false).ok).toBe(true)
    const parsed = parseJsonc(readFileSync(file, "utf8")) as { plugins: string[] }
    expect(parsed.plugins).toEqual(["-alpha"])
    expect(setConfigPluginEnabled({ path: file, scope: "global" }, "alpha", true).ok).toBe(true)
    expect((parseJsonc(readFileSync(file, "utf8")) as { plugins: string[] }).plugins).toEqual([])
    rmSync(ws.root, { recursive: true, force: true })
  })
})

describe("directory scanning + toggling", () => {
  test("scan finds enabled/disabled dirs and files; self is not manageable", () => {
    const ws = makeWorkspace()
    const root = join(ws.project, ".opencode", "plugins")
    mkdirSync(join(root, "oc-a"))
    mkdirSync(join(root, "oc-c"))
    writeFileSync(join(root, "oc-c", "package.json"), "{}\n")
    writeFileSync(join(root, "oc-c", ".oc-plugin-manager.disabled.json"), '{"disabledAt":1,"renamed":["package.json"]}\n')
    mkdirSync(join(root, "oc-b.disabled"))
    writeFileSync(join(root, "x.ts"), "export default {}\n")
    writeFileSync(join(root, "y.ts.disabled"), "export default {}\n")
    mkdirSync(join(root, "oc-plugin-manager"))

    const entries = scanPluginRoot(root, "project")
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]))
    expect(byName["oc-a"]!.enabled).toBe(true)
    expect(byName["oc-b"]!.enabled).toBe(false)
    expect(byName["oc-c"]!.enabled).toBe(false) // 入口中和标记 → 禁用
    expect(byName["x.ts"]!.kind).toBe("file")
    expect(byName["y.ts"]!.enabled).toBe(false)
    expect(byName["oc-plugin-manager"]!.manageable).toBe(false)

    rmSync(ws.root, { recursive: true, force: true })
  })

  test("setEnabled neutralizes dir entry / renames file and refuses self", () => {
    const ws = makeWorkspace()
    const root = join(ws.project, ".opencode", "plugins")
    mkdirSync(join(root, "oc-a"))
    writeFileSync(join(root, "oc-a", "package.json"), '{"name":"oc-a"}\n')
    writeFileSync(join(root, "oc-a", "index.ts"), "export default {}\n")

    const disable = setEnabled(ws.options, { name: "oc-a", scope: "project", enabled: false })
    expect(disable.ok).toBe(true)
    expect(existsSync(join(root, "oc-a", "package.json.disabled"))).toBe(true)
    expect(existsSync(join(root, "oc-a", "index.ts.disabled"))).toBe(true)
    expect(existsSync(join(root, "oc-a", "package.json"))).toBe(false)
    expect(listAll(ws.options).entries.find((e) => e.name === "oc-a")!.enabled).toBe(false)

    const enable = setEnabled(ws.options, { name: "oc-a", scope: "project", enabled: true })
    expect(enable.ok).toBe(true)
    expect(existsSync(join(root, "oc-a", "package.json"))).toBe(true)
    expect(existsSync(join(root, "oc-a", "index.ts"))).toBe(true)
    expect(listAll(ws.options).entries.find((e) => e.name === "oc-a")!.enabled).toBe(true)

    // 文件型插件仍按扩展名改名
    writeFileSync(join(root, "z.ts"), "export default {}\n")
    expect(setEnabled(ws.options, { name: "z.ts", scope: "project", enabled: false }).ok).toBe(true)
    expect(existsSync(join(root, "z.ts.disabled"))).toBe(true)

    mkdirSync(join(root, "oc-plugin-manager"))
    const refuse = setEnabled(ws.options, { name: "oc-plugin-manager", scope: "project", enabled: false })
    expect(refuse.ok).toBe(false)

    const missing = setEnabled(ws.options, { name: "nope", enabled: false })
    expect(missing.ok).toBe(false)

    rmSync(ws.root, { recursive: true, force: true })
  })

  test("scopes stay independent (project vs global same name)", () => {
    const ws = makeWorkspace()
    for (const dir of [join(ws.project, ".opencode", "plugins", "dup"), join(ws.configHome, "opencode", "plugins", "dup")]) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "package.json"), "{}\n")
    }

    const all = listAll(ws.options).entries.filter((e) => e.name === "dup")
    expect(all).toHaveLength(2)

    expect(setEnabled(ws.options, { name: "dup", scope: "global", enabled: false }).ok).toBe(true)
    const after = listAll(ws.options).entries.filter((e) => e.name === "dup")
    expect(after.find((e) => e.scope === "project")!.enabled).toBe(true)
    expect(after.find((e) => e.scope === "global")!.enabled).toBe(false)

    rmSync(ws.root, { recursive: true, force: true })
  })
})

describe("mount (fake host)", () => {
  function makeContext(options: Record<string, unknown>) {
    const tools: Array<{ name: string; execute: (input?: unknown) => Promise<{ content?: string }> }> = []
    let rpcDefinition: unknown = null
    let rpcHandlers: Record<string, (input: unknown) => Promise<unknown>> | null = null
    const disposals: string[] = []
    const ctx = {
      options,
      tool: {
        transform: async (callback: (editor: Record<string, unknown>) => void) => {
          callback({
            add: (definition: (typeof tools)[number]) => tools.push(definition),
            list: () => tools,
            get: () => undefined,
            namespace: () => {},
            update: () => {},
            remove: () => {},
          })
          return { dispose: async () => { disposals.push("tool") } }
        },
      },
      rpc: {
        register: async (definition: unknown, handlers: Record<string, (input: unknown) => Promise<unknown>>) => {
          rpcDefinition = definition
          rpcHandlers = handlers
          return { dispose: async () => { disposals.push("rpc") }, events: { emit: async () => {} } }
        },
      },
    }
    return { ctx: ctx as never, tools, disposals, rpc: () => ({ definition: rpcDefinition, handlers: rpcHandlers }) }
  }

  test("registers tools + rpc and toggles a plugin", async () => {
    const ws = makeWorkspace()
    mkdirSync(join(ws.project, ".opencode", "plugins", "demo"))
    writeFileSync(join(ws.project, ".opencode", "plugins", "demo", "package.json"), "{}\n")
    const harness = makeContext(ws.options)
    const cleanup = await mount(harness.ctx)

    expect(harness.tools.map((t) => t.name).sort()).toEqual(["plugin_manager_list", "plugin_manager_set"])
    expect((harness.rpc().definition as { id?: string })?.id).toBe("plugin.manager")

    const listed = (await harness.rpc().handlers!.list!({})) as { entries: Array<{ name: string; enabled: boolean }> }
    expect(listed.entries.find((e) => e.name === "demo")!.enabled).toBe(true)

    const set = (await harness.rpc().handlers!.set!({ name: "demo", scope: "project", enabled: false })) as { ok: boolean }
    expect(set.ok).toBe(true)
    const listed2 = (await harness.rpc().handlers!.list!({})) as { entries: Array<{ name: string; enabled: boolean }> }
    expect(listed2.entries.find((e) => e.name === "demo")!.enabled).toBe(false)

    const toolResult = await harness.tools.find((t) => t.name === "plugin_manager_set")!.execute({ name: "demo", scope: "project", enabled: true })
    expect(JSON.parse(toolResult.content ?? "{}").ok).toBe(true)

    await cleanup()
    expect(harness.disposals).toContain("rpc")
    expect(harness.disposals).toContain("tool")
    rmSync(ws.root, { recursive: true, force: true })
  })

  test("degrades on hosts without tool/rpc domains", async () => {
    const ctx = { options: {} } as never
    const cleanup = await mount(ctx)
    expect(typeof cleanup).toBe("function")
    await cleanup()
  })
})
