// 冒烟测试 — capsule/interpolate/提取/目录/存储/引擎/mount（全部离线 fixture, 不产生真实子会话）。

import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { extractAssistantText, type AgentTask, type SessionBridge } from "../.opencode/plugins/oc-workflow/src/agents"
import { builtinCapsules } from "../.opencode/plugins/oc-workflow/src/builtins"
import { CAPSULE_VERSION, resolveInputs, validateCapsule, type Capsule } from "../.opencode/plugins/oc-workflow/src/capsule"
import { loadCatalog } from "../.opencode/plugins/oc-workflow/src/catalog"
import { WorkflowEngine } from "../.opencode/plugins/oc-workflow/src/engine"
import { interpolate } from "../.opencode/plugins/oc-workflow/src/interpolate"
import { createMount } from "../.opencode/plugins/oc-workflow/src/mount"
import { RunStore, type RunRecord } from "../.opencode/plugins/oc-workflow/src/store"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const waitFor = async (fn: () => boolean, ms = 4000) => {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (fn()) return true
    await sleep(10)
  }
  return false
}

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "ocwf-"))
  const store = new RunStore(join(root, "runs"))
  return { root, store }
}

function autoBridge() {
  const spawned: string[] = []
  const factory = () => ({
    spawn: async (task: AgentTask) => {
      spawned.push(task.id)
      return {
        id: task.id,
        sessionID: `ses_${task.id}`,
        wait: async () => ({ status: "completed" as const, output: `out:${task.id}` }),
        interrupt: async () => {},
        output: async () => `out:${task.id}`,
      }
    },
  })
  return { factory: factory as unknown as (input: { parentSessionID?: string }) => SessionBridge, spawned }
}

function manualBridge() {
  const pending: Array<{ task: AgentTask; release: () => void }> = []
  const factory = () => ({
    spawn: async (task: AgentTask) => {
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      pending.push({ task, release })
      return {
        id: task.id,
        sessionID: `ses_${task.id}`,
        wait: async () => {
          await gate
          return { status: "completed" as const, output: `out:${task.id}` }
        },
        interrupt: async () => release(),
        output: async () => null,
      }
    },
  })
  return { factory: factory as unknown as (input: { parentSessionID?: string }) => SessionBridge, pending }
}

describe("capsule", () => {
  test("builtins validate", () => {
    for (const capsule of builtinCapsules()) {
      expect(validateCapsule(capsule).ok).toBe(true)
    }
  })

  test("rejects bad version / capture / duplicate ids", () => {
    expect(validateCapsule({ version: "x", name: "a", steps: [{ type: "log", message: "m" }] }).ok).toBe(false)
    const badCapture: Capsule = { version: CAPSULE_VERSION, name: "a", steps: [{ type: "capture", id: "c", command: "rm -rf /" }] }
    const captureResult = validateCapsule(badCapture)
    expect(captureResult.ok).toBe(false)
    if (!captureResult.ok) expect(captureResult.errors.join(" ")).toContain("git")
    const dup: Capsule = {
      version: CAPSULE_VERSION,
      name: "a",
      steps: [
        { type: "agent", id: "x", prompt: "1" },
        { type: "agent", id: "x", prompt: "2" },
      ],
    }
    expect(validateCapsule(dup).ok).toBe(false)
  })

  test("resolveInputs enforces required and defaults", () => {
    const capsule = builtinCapsules()[0]!
    const missing = resolveInputs(capsule, {})
    expect(missing.errors.some((error) => error.includes("question"))).toBe(true)
    const provided = resolveInputs(capsule, { question: "why" })
    expect(provided.errors).toEqual([])
    expect(provided.values.question).toBe("why")
  })
})

describe("interpolate", () => {
  test("replaces inputs and step outputs, collects missing", () => {
    const result = interpolate("Q={{inputs.question}} A={{steps.facts.output}} M={{steps.none.output}}", {
      inputs: { question: "why" },
      steps: { facts: { output: "answer" } },
    })
    expect(result.text).toBe("Q=why A=answer M={{steps.none.output}}")
    expect(result.missing).toEqual(["{{steps.none.output}}"])
  })
})

describe("extractAssistantText", () => {
  test("walks parts/content and ignores tool parts", () => {
    const text = extractAssistantText([
      { role: "user", parts: [{ type: "text", text: "q" }] },
      { role: "assistant", parts: [{ type: "text", text: "hello" }, { type: "tool", text: "tool-output" }] },
    ])
    expect(text).toBe("hello")
    expect(extractAssistantText([{ role: "assistant", content: [{ type: "message.text", text: "a" }, { type: "message.text", text: "b" }] }])).toBe("a\nb")
    expect(extractAssistantText(null)).toBeNull()
    expect(extractAssistantText([{ role: "assistant", text: "plain" }])).toBe("plain")
  })
})

describe("catalog", () => {
  test("project overrides global; invalid files reported", () => {
    const root = mkdtempSync(join(tmpdir(), "ocwf-cat-"))
    const project = join(root, "project")
    const home = join(root, "home")
    mkdirSync(join(project, ".opencode", "workflows"), { recursive: true })
    mkdirSync(join(home, ".config", "opencode", "workflows"), { recursive: true })

    const capsule = (name: string, description: string): Capsule => ({ version: CAPSULE_VERSION, name, description, steps: [{ type: "log", message: "hi" }] })
    writeFileSync(join(home, ".config", "opencode", "workflows", "demo.workflow.json"), JSON.stringify(capsule("demo", "from-global")))
    writeFileSync(join(project, ".opencode", "workflows", "demo.workflow.json"), JSON.stringify(capsule("demo", "from-project")))
    writeFileSync(join(project, ".opencode", "workflows", "broken.workflow.json"), "{ not json")

    const catalog = loadCatalog(project, home)
    expect(catalog.errors.length).toBe(1)
    const demo = catalog.entries.find((entry) => entry.name === "demo")!
    expect(demo.description).toBe("from-project")
    expect(catalog.entries.some((entry) => entry.name === "parallel-investigation" && entry.source === "builtin")).toBe(true)
    rmSync(root, { recursive: true, force: true })
  })
})

describe("store", () => {
  test("records, results, artifacts and prune", () => {
    const ws = workspace()
    ws.store.ensure()
    const record: RunRecord = {
      id: "wf_test_1",
      name: "demo",
      status: "running",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      directory: ws.root,
      inputs: {},
      capsule: builtinCapsules()[2]!,
      phases: [],
      steps: {},
      summary: null,
      error: null,
      agentsUsed: 0,
    }
    ws.store.create(record)
    expect(ws.store.load("wf_test_1")?.name).toBe("demo")
    expect(ws.store.list()).toHaveLength(1)
    expect(existsSync(join(ws.store.dir("wf_test_1"), "events.jsonl"))).toBe(true)

    ws.store.writeResult("wf_test_1", "abc", { output: "cached" })
    expect(ws.store.readResult("wf_test_1", "abc")?.output).toBe("cached")
    const artifact = ws.store.writeArtifact("wf_test_1", "review.md", "# ok")
    expect(readFileSync(artifact, "utf8")).toBe("# ok")

    const second: RunRecord = { ...record, id: "wf_test_2", createdAt: Date.now() + 1 }
    ws.store.create(second)
    const removed = ws.store.prune({ keep: 1 })
    expect(removed).toContain("wf_test_1")
    rmSync(ws.root, { recursive: true, force: true })
  })
})

describe("engine", () => {
  const capsule: Capsule = {
    version: CAPSULE_VERSION,
    name: "demo",
    inputs: { topic: { type: "string", required: true } },
    limits: { maxConcurrency: 2 },
    steps: [
      { type: "phase", name: "fan-out" },
      {
        type: "parallel",
        tasks: [
          { id: "t1", prompt: "{{inputs.topic}} one" },
          { id: "t2", prompt: "two" },
        ],
      },
      { type: "synthesize", id: "final", from: ["t1", "t2"], prompt: "summarize {{steps.t1.output}} + {{steps.t2.output}}" },
      { type: "artifact", name: "out.md", from: "final" },
    ],
  }

  test("full run completes with artifacts and cached results", async () => {
    const ws = workspace()
    ws.store.ensure()
    const auto = autoBridge()
    const engine = new WorkflowEngine({ directory: ws.root, store: ws.store, bridge: auto.factory })
    const record = await engine.start(capsule, { inputs: { topic: "hello" }, wait: true })
    expect(record.status).toBe("completed")
    expect(record.steps.t1!.output).toBe("out:t1")
    expect(record.steps.final!.output).toBe("out:final")
    expect(record.steps["artifact:out.md"]!.status).toBe("completed")
    expect(record.summary).toBe("out:final")
    expect(readFileSync(join(ws.store.dir(record.id), "artifacts", "out.md"), "utf8")).toBe("out:final")

    // resume-run by cache: no new spawns
    const spawnedBefore = auto.spawned.length
    const resumed = await engine.start(capsule, { inputs: { topic: "hello" }, cacheFrom: record.id, wait: true })
    expect(resumed.status).toBe("completed")
    expect(resumed.steps.t1!.status).toBe("cached")
    expect(auto.spawned.length).toBe(spawnedBefore)
    rmSync(ws.root, { recursive: true, force: true })
  })

  test("pause gates pending tasks, resume continues", async () => {
    const ws = workspace()
    ws.store.ensure()
    const manual = manualBridge()
    const engine = new WorkflowEngine({ directory: ws.root, store: ws.store, bridge: manual.factory })
    const twoSteps: Capsule = {
      version: CAPSULE_VERSION,
      name: "gate",
      steps: [
        { type: "agent", id: "a1", prompt: "1" },
        { type: "agent", id: "a2", prompt: "2" },
      ],
    }
    const started = await engine.start(twoSteps, { wait: false })
    await waitFor(() => manual.pending.length === 1)
    expect(engine.pause(started.id)).toBe(true)
    manual.pending.shift()!.release()
    await sleep(60)
    expect(manual.pending.length).toBe(0)
    expect(engine.resume(started.id)).toBe(true)
    await waitFor(() => manual.pending.length === 1)
    manual.pending.shift()!.release()
    const done = await engine.wait(started.id)
    expect(done?.status).toBe("completed")
    expect(done?.steps.a2!.status).toBe("completed")
    rmSync(ws.root, { recursive: true, force: true })
  })

  test("budget failure and stop semantics", async () => {
    const ws = workspace()
    ws.store.ensure()
    const auto = autoBridge()
    const budgetCapsule: Capsule = {
      version: CAPSULE_VERSION,
      name: "budget",
      steps: [
        { type: "agent", id: "b1", prompt: "1" },
        { type: "agent", id: "b2", prompt: "2" },
      ],
    }
    const limited = new WorkflowEngine({ directory: ws.root, store: ws.store, bridge: auto.factory, maxAgents: 1 })
    const failed = await limited.start(budgetCapsule, { wait: true })
    expect(failed.status).toBe("failed")
    expect(failed.error ?? "").toContain("预算")

    const manual = manualBridge()
    const stopper = new WorkflowEngine({ directory: ws.root, store: ws.store, bridge: manual.factory })
    const started = await stopper.start(budgetCapsule, { wait: false })
    await waitFor(() => manual.pending.length === 1)
    expect(stopper.stop(started.id)).toBe(true)
    manual.pending.shift()!.release()
    const done = await stopper.wait(started.id)
    expect(done?.status).toBe("stopped")
    rmSync(ws.root, { recursive: true, force: true })
  })
})

describe("mount (fake host)", () => {
  function fakeHost(directory: string) {
    const tools: Array<{ name: string; execute: (input?: unknown, context?: unknown) => Promise<{ content?: string }> }> = []
    const commands: Array<{ name: string; execute: (input: unknown) => Promise<void> }> = []
    const synthetics: Array<{ sessionID: string; text?: string }> = []
    let rpcDefinition: unknown = null
    let rpcHandlers: Record<string, (input: unknown) => Promise<unknown>> | null = null
    const disposals: string[] = []
    const ctx = {
      location: { directory },
      options: {},
      agent: { list: async () => [{ id: "explore" }] },
      session: {
        create: async () => ({ id: `ses_child_${synthetics.length}` }),
        prompt: async () => ({}),
        wait: async () => undefined,
        context: async () => [{ role: "assistant", parts: [{ type: "text", text: "fake output" }] }],
        interrupt: async () => ({}),
        synthetic: async (input: { sessionID: string; text?: string }) => {
          synthetics.push(input)
          return {}
        },
      },
      tool: {
        transform: async (callback: (editor: { add: (definition: (typeof tools)[number]) => void }) => void) => {
          callback({ add: (definition: (typeof tools)[number]) => tools.push(definition) })
          return { dispose: async () => { disposals.push("tool") } }
        },
      },
      command: {
        transform: async (callback: (editor: { add: (definition: (typeof commands)[number]) => void }) => void) => {
          callback({ add: (definition: (typeof commands)[number]) => commands.push(definition) })
          return { dispose: async () => { disposals.push("command") } }
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
    return { ctx: ctx as never, tools, commands, synthetics, disposals, rpc: () => ({ definition: rpcDefinition, handlers: rpcHandlers }) }
  }

  test("registers tools + command + rpc and runs end to end", async () => {
    const ws = workspace()
    const host = fakeHost(ws.root)
    const demo: Capsule = { version: CAPSULE_VERSION, name: "demo", inputs: {}, steps: [{ type: "agent", id: "a1", prompt: "hi" }] }
    const cleanup = await createMount({
      catalog: () => ({ entries: [{ name: "demo", source: "builtin", capsule: demo }], errors: [] }),
      storeFactory: () => new RunStore(join(ws.root, "runs")),
    })(host.ctx)

    expect(host.tools.map((tool) => tool.name).sort()).toEqual(["run_workflow", "workflow_list", "workflow_manage"])
    expect(host.commands.map((command) => command.name)).toEqual(["workflow"])
    expect((host.rpc().definition as { id?: string })?.id).toBe("workflow.engine")

    const runResult = JSON.parse(
      (await host.tools.find((tool) => tool.name === "run_workflow")!.execute({ name: "demo", wait: true }, { sessionID: "ses_parent" })).content ?? "{}",
    ) as { ok: boolean; run: { status: string; id: string } }
    expect(runResult.ok).toBe(true)
    expect(runResult.run.status).toBe("completed")

    await host.commands[0]!.execute({ sessionID: "ses_x", prompt: { text: "list" }, delivery: "queue" })
    expect(host.synthetics[0]!.text ?? "").toContain("demo")

    const runs = (await host.rpc().handlers!.runs!({ limit: 5 })) as { runs: unknown[] }
    expect(runs.runs.length).toBe(1)
    const shown = (await host.rpc().handlers!.show!({ runId: runResult.run.id })) as { ok: boolean }
    expect(shown.ok).toBe(true)

    await cleanup()
    expect(host.disposals).toContain("rpc")
    rmSync(ws.root, { recursive: true, force: true })
  })
})
