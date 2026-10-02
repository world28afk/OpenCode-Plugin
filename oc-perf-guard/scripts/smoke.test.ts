// 冒烟测试 — 归因/清理计划/快照/mount（全部使用 fixture, 不触碰真实进程）。

import { describe, expect, test } from "bun:test"
import { categorize, executeCleanup, linkState, resetSnapshotCache, planCleanup, snapshot, type ProcInfo } from "../.opencode/plugins/oc-perf-guard/src/processes"
import { createMount, extractCommand } from "../.opencode/plugins/oc-perf-guard/src/mount"
import { ScriptGovernor } from "../.opencode/plugins/oc-perf-guard/src/governor"
import { computeCpuPercents, findCandidates, isCollectorProcess, type ScriptCandidate } from "../.opencode/plugins/oc-perf-guard/src/scripts"
import { classifyCommand, judgeScript } from "../.opencode/plugins/oc-perf-guard/src/judge"

const procFull = (pid: number, ppid: number, name: string, mb: number, cmd: string, cpuTimeMs: number, startMs: number): ProcInfo => ({
  pid,
  ppid,
  name,
  mb,
  cmd,
  cpuTimeMs,
  startMs,
})

const proc = (pid: number, ppid: number, name: string, mb: number, cmd: string): ProcInfo => ({ pid, ppid, name, mb, cmd })

const FIXTURE: ProcInfo[] = [
  proc(1, 0, "opencode-cli.exe", 600, "opencode-cli.exe serve --service"),
  proc(10, 1, "cmd.exe", 5, "cmd /c npx -y @jshookmcp/jshook"),
  proc(11, 10, "node.exe", 80, "node .../@jshookmcp/jshook/dist/index.js"),
  proc(20, 1, "cmd.exe", 5, "cmd /c npx -y @modelcontextprotocol/server-memory"),
  proc(21, 20, "node.exe", 70, "node .../@modelcontextprotocol/server-memory/dist/index.js"),
  proc(30, 99999, "node.exe", 90, "node .../mcp-remote https://mcp.exa.ai/mcp"),
  proc(40, 1, "python.exe", 30, 'python.exe "C:/.../mcp-server-fetch.exe"'),
  proc(50, 1, "node.exe", 500, "node C:/some/other/tool.js"),
]

describe("categorize / linkState", () => {
  test("runtime processes are attributed to categories", () => {
    const categories = categorize(FIXTURE)
    const byName = Object.fromEntries(categories.map((category) => [category.name, category]))
    expect(byName["jshook"]!.count).toBe(1)
    expect(byName["memory"]!.count).toBe(1)
    expect(byName["exa (mcp-remote)"]!.count).toBe(1)
    expect(byName["fetch (uvx)"]!.count).toBe(1)
    expect(byName["other"]!.count).toBe(1) // node C:/some/other/tool.js
    // cmd.exe 与 opencode-cli.exe 不计入运行时
    expect(byName["cmd.exe"]).toBeUndefined()
  })

  test("linkState distinguishes service / dead / outside", () => {
    expect(linkState(FIXTURE, 11)).toBe("service")
    expect(linkState(FIXTURE, 30)).toBe("dead")
    expect(linkState(FIXTURE, 50)).toBe("service")
  })
})

describe("planCleanup / executeCleanup", () => {
  test("category plan anchors at the service child", () => {
    const plan = planCleanup(FIXTURE, "jshook")
    expect(plan.roots.map((root) => root.pid)).toEqual([10])
    expect(plan.orphans).toEqual([])
  })

  test("all-mcp plan includes roots and orphans", () => {
    const plan = planCleanup(FIXTURE, "all-mcp")
    expect(plan.roots.map((root) => root.pid).sort((a, b) => a - b)).toEqual([10, 20, 40])
    expect(plan.orphans.map((orphan) => orphan.pid)).toEqual([30])
  })

  test("dryRun performs no kills; real run kills trees via injected runner", () => {
    const plan = planCleanup(FIXTURE, "jshook")
    const dry = executeCleanup(plan, true)
    expect(dry.planned.roots).toBe(1)
    expect(dry.killed).toEqual([])

    const calls: Array<{ pid: number; tree: boolean }> = []
    const real = executeCleanup(plan, false, (pid, tree) => {
      calls.push({ pid, tree })
      return { ok: true, output: "SUCCESS" }
    })
    expect(calls).toEqual([{ pid: 10, tree: true }])
    expect(real.killed[0]!.ok).toBe(true)
  })
})

describe("snapshot", () => {
  test("thresholds produce warnings", () => {
    resetSnapshotCache()
    const value = snapshot({ procs: FIXTURE, warnAt: 2, serviceWarnMB: 100, force: true })
    expect(value.warn).toBe(true)
    expect(value.warnings.length).toBe(2)
    expect(value.service.count).toBe(1)
    expect(value.service.mb).toBe(600)
    expect(value.runtimes.count).toBe(5) // node/py only
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

  test("registers tools + rpc, cleanup defaults to dryRun", async () => {
    resetSnapshotCache()
    const calls: number[] = []
    const harness = makeContext({ warnAt: 2, serviceWarnMB: 100, intervalMs: 3_600_000 })
    const cleanup = await createMount({
      collect: () => FIXTURE,
      runner: (pid) => {
        calls.push(pid)
        return { ok: true, output: "SUCCESS" }
      },
    })(harness.ctx)

    expect(harness.tools.map((tool) => tool.name).sort()).toEqual(["perf_cleanup", "perf_processes", "script_keep", "script_kill", "script_list", "script_nice"])
    expect((harness.rpc().definition as { id?: string })?.id).toBe("perf.guard")

    const status = (await harness.rpc().handlers!.status!({ force: true })) as { warn: boolean; runtimes: { count: number } }
    expect(status.warn).toBe(true)
    expect(status.runtimes.count).toBe(5)

    // 默认 dryRun: 不调用 runner
    const dry = (await harness.rpc().handlers!.cleanup!({ target: "jshook" })) as { dryRun: boolean; killed: unknown[] }
    expect(dry.dryRun).toBe(true)
    expect(dry.killed).toEqual([])
    expect(calls).toEqual([])

    const real = (await harness.rpc().handlers!.cleanup!({ target: "jshook", dryRun: false })) as { killed: Array<{ ok: boolean }> }
    expect(calls).toEqual([10])
    expect(real.killed[0]!.ok).toBe(true)

    const toolResult = JSON.parse((await harness.tools.find((tool) => tool.name === "perf_cleanup")!.execute({ target: "jshook", dryRun: false })).content ?? "{}")
    expect(toolResult.dryRun).toBe(false)
    expect(calls).toEqual([10, 10])

    await cleanup()
    expect(harness.disposals).toContain("rpc")
    expect(harness.disposals).toContain("tool")
  })

  test("degrades on hosts without tool/rpc domains", async () => {
    const cleanup = await createMount({ collect: () => FIXTURE })({} as never)
    expect(typeof cleanup).toBe("function")
    await cleanup()
  })
})

describe("scripts (cpu / candidates)", () => {
  test("computeCpuPercents", () => {
    const before = [procFull(1, 0, "node.exe", 10, "node a.js", 1000, 0)]
    const after = [procFull(1, 0, "node.exe", 10, "node a.js", 3000, 0)]
    expect(computeCpuPercents(before, after, 1000, 2).get(1)).toBe(200) // 1000ms 内消耗 2000ms CPU = 2 核
    expect(computeCpuPercents(before, after, 0, 2).size).toBe(0)
  })

  test("collector processes are excluded", () => {
    expect(isCollectorProcess(procFull(1, 0, "powershell.exe", 30, "powershell -Command Get-CimInstance Win32_Process", 0, 0))).toBe(true)
    expect(isCollectorProcess(procFull(2, 0, "node.exe", 30, "node app.js", 0, 0))).toBe(false)
  })

  test("findCandidates picks hogs and forgotten scripts, skips MCP/young/collector", () => {
    const now = 1_798_000_000_000
    const procs: ProcInfo[] = [
      procFull(1, 0, "opencode-cli.exe", 600, "opencode-cli.exe serve --service", 0, 0),
      procFull(11, 1, "node.exe", 900, "node hog.js", 5000, now - 120_000),
      procFull(20, 1, "node.exe", 300, "node jest --runInBand", 0, now - 30_000),
      procFull(30, 1, "powershell.exe", 30, "powershell -Command Get-CimInstance Win32_Process", 0, now - 5000),
      procFull(40, 99999, "node.exe", 800, "node forgot.js", 0, now - 3_600_000),
      procFull(50, 1, "node.exe", 700, "node mcp-server-fetch", 0, now - 60_000),
    ]
    const commands = [
      { sessionID: "ses_1", tool: "bash", command: "node hog.js", at: now - 120_000 },
      { sessionID: "ses_1", tool: "bash", command: "node forgot.js", at: now - 3_600_000 },
    ]
    const thresholds = { cpuPercent: 70, memoryMB: 500, maxRuntimeMs: 300_000, minAgeMs: 10_000, askCooldownMs: 1_000, keepMs: 1_000 }
    const candidates = findCandidates(procs, { commands, cpu: new Map([[11, 85]]), thresholds, now })
    expect(candidates.map((candidate) => candidate.pid)).toEqual([11, 40])
    const hog = candidates.find((candidate) => candidate.pid === 11)!
    expect(hog.reason).toContain("cpu")
    expect(hog.reason).toContain("memory")
    expect(hog.sessionID).toBe("ses_1")
    const forgotten = candidates.find((candidate) => candidate.pid === 40)!
    expect(forgotten.link).toBe("dead")
    expect(forgotten.reason).toContain("age")
  })
})

const makeCandidate = (overrides: Partial<ScriptCandidate> = {}): ScriptCandidate => ({
  pid: 11,
  ppid: 1,
  name: "node.exe",
  cmd: "node hog.js",
  mb: 900,
  cpuPercent: 85,
  ageMs: 120_000,
  link: "service",
  reason: ["memory"],
  sessionID: "ses_1",
  tool: "bash",
  command: "node hog.js",
  toolFinished: true,
  ...overrides,
})

describe("judge (Laya-style rules)", () => {
  const base = {
    thresholds: { cpuPercent: 70, memoryMB: 1200, maxRuntimeMs: 600_000, minAgeMs: 0, askCooldownMs: 1_000, keepMs: 1_800_000 },
    memoryKillMB: 2400,
    idleCpuPercent: 5,
  }

  test("classifyCommand", () => {
    expect(classifyCommand("npm run dev --watch")).toBe("server")
    expect(classifyCommand("node server.js")).toBe("server")
    expect(classifyCommand("npm run build")).toBe("long-job")
    expect(classifyCommand("pytest -q")).toBe("long-job")
    expect(classifyCommand('node -e "while(true){}"')).toBe("one-shot")
    expect(classifyCommand("python foo.py")).toBe("one-shot")
  })

  test("rules pick kill / nice / observe", () => {
    expect(judgeScript(makeCandidate({ command: "node -e x", cmd: "node -e x", cpuPercent: 98, mb: 100 }), base).action).toBe("kill")
    expect(judgeScript(makeCandidate({ mb: 3000 }), base).action).toBe("kill") // 内存硬线
    expect(judgeScript(makeCandidate({ command: "npm run build", cmd: "npm run build", cpuPercent: 95 }), base).action).toBe("nice") // 长任务
    expect(judgeScript(makeCandidate({ command: "npm run dev", cmd: "npm run dev", cpuPercent: 10 }), base).action).toBe("nice") // 长驻服务
    expect(judgeScript(makeCandidate({ cpuPercent: 1, ageMs: 3_600_000 }), base).action).toBe("kill") // 卡住/被遗忘
    expect(judgeScript(makeCandidate({ cpuPercent: 0, ageMs: 1_000, mb: 100 }), base).action).toBe("observe")
  })
})

describe("ScriptGovernor (staged enforcement)", () => {
  test("kill verdict: nice + grace, then kill; records actions", async () => {
    const niceCalls: Array<{ pid: number; level: string }> = []
    const killCalls: number[] = []
    const notices: string[] = []
    let clock = 1_000_000
    const governor = new ScriptGovernor({
      thresholds: { cpuPercent: 70, memoryMB: 500, maxRuntimeMs: 300_000, minAgeMs: 0, askCooldownMs: 1_000, keepMs: 60_000 },
      mode: "auto",
      graceMs: 5_000,
      memoryKillMB: 800,
      idleCpuPercent: 5,
      now: () => clock,
      notify: async (_sessionID, text) => {
        notices.push(text)
      },
      kill: (pid) => {
        killCalls.push(pid)
        return { ok: true, output: "SUCCESS" }
      },
      nice: (pid, level) => {
        niceCalls.push({ pid, level })
        return { ok: true, output: level }
      },
      actionCooldownMs: 0,
    })
    const hog = makeCandidate()
    governor.observe([hog])
    const first = await governor.enforce(hog)
    expect(first.action).toBe("nice") // 第一阶段: 降优先级 + 宽限
    expect(first.reason).toBe("grace")
    expect(niceCalls).toEqual([{ pid: 11, level: "idle" }])
    expect(killCalls).toEqual([])
    expect(notices.join("\n")).toContain("自动处置")

    clock += 1_000 // 宽限内
    expect((await governor.enforce(hog)).applied).toBe(false)

    clock += 6_000 // 宽限后
    const escalated = await governor.enforce(hog)
    expect(escalated.action).toBe("kill")
    expect(escalated.applied).toBe(true)
    expect(killCalls).toEqual([11])
    expect(governor.list()).toHaveLength(0)
    expect(governor.listActions(5).some((record) => record.action === "kill")).toBe(true)
  })

  test("keep cancels pending kill; notify mode takes no action", async () => {
    const killCalls: number[] = []
    const notices: string[] = []
    let clock = 5_000_000
    const governor = new ScriptGovernor({
      thresholds: { cpuPercent: 70, memoryMB: 500, maxRuntimeMs: 300_000, minAgeMs: 0, askCooldownMs: 1_000, keepMs: 60_000 },
      mode: "auto",
      graceMs: 1_000,
      memoryKillMB: 800,
      idleCpuPercent: 5,
      now: () => clock,
      notify: async (_sessionID, text) => {
        notices.push(text)
      },
      kill: (pid) => {
        killCalls.push(pid)
        return { ok: true, output: "ok" }
      },
      nice: () => ({ ok: true, output: "Idle" }),
      actionCooldownMs: 0,
    })
    const hog = makeCandidate()
    governor.observe([hog])
    await governor.enforce(hog) // nice + grace
    expect(governor.keep(11, 30).ok).toBe(true)
    clock += 10_000
    await governor.enforce(hog)
    expect(killCalls).toEqual([]) // 已保留 → 不终止

    const notifyOnly = new ScriptGovernor({
      thresholds: { cpuPercent: 70, memoryMB: 500, maxRuntimeMs: 300_000, minAgeMs: 0, askCooldownMs: 1_000, keepMs: 60_000 },
      mode: "notify",
      graceMs: 1_000,
      memoryKillMB: 800,
      idleCpuPercent: 5,
      now: () => clock,
      notify: async (_sessionID, text) => {
        notices.push(text)
      },
      kill: () => ({ ok: true, output: "ok" }),
      nice: () => ({ ok: true, output: "Idle" }),
    })
    notifyOnly.observe([hog])
    const result = await notifyOnly.enforce(hog)
    expect(result.action).toBe("notify")
    expect(notices.join("\n")).toContain("仅通知模式")
  })
})

describe("mount script governance", () => {
  test("tool hook attribution + staged auto governance (nice → kill)", async () => {
    const notices: Array<{ sessionID: string; text: string }> = []
    const killed: number[] = []
    const niced: number[] = []
    const tools: Array<{ name: string; execute: (input?: unknown) => Promise<{ content?: string }> }> = []
    const hooks = new Map<string, (input: unknown) => Promise<void>>()
    let clock = 1_000_000
    const ctx = {
      options: {
        scripts: {
          enabled: true,
          intervalMs: 3_600_000,
          mode: "auto",
          memoryMB: 500,
          memoryKillMB: 800,
          cpuPercent: 999,
          maxRuntimeMs: 3_600_000,
          minAgeMs: 0,
          graceMs: 1_000,
          actionCooldownMs: 0,
        },
      },
      session: { synthetic: async () => ({}), prompt: async () => ({}) },
      tool: {
        transform: async (callback: (editor: { add: (definition: (typeof tools)[number]) => void }) => void) => {
          callback({ add: (definition) => tools.push(definition) })
          return { dispose: async () => {} }
        },
        hook: async (name: string, callback: (input: unknown) => Promise<void>) => {
          hooks.set(name, callback)
          return { dispose: async () => {} }
        },
      },
      rpc: { register: async () => ({ dispose: async () => {}, events: { emit: async () => {} } }) },
    }
    const procs = () => [
      procFull(1, 0, "opencode-cli.exe", 600, "opencode-cli.exe serve --service", 0, 0),
      procFull(11, 1, "node.exe", 900, "node hog.js", 1000, Date.now() - 60_000),
    ]
    const cleanup = await createMount({
      collect: procs,
      runner: (pid) => {
        killed.push(pid)
        return { ok: true, output: "SUCCESS" }
      },
      notify: async (sessionID, text) => {
        notices.push({ sessionID, text })
      },
      nice: (pid) => {
        niced.push(pid)
        return { ok: true, output: "Idle" }
      },
      now: () => clock,
    })(ctx as never)

    await hooks.get("execute.before")!({ tool: "bash", sessionID: "ses_1", agent: "build", messageID: "msg_1", id: "call_1", input: { command: "node hog.js" } })
    await hooks.get("execute.after")!({ tool: "bash", sessionID: "ses_1", agent: "build", messageID: "msg_1", id: "call_1", input: { command: "node hog.js" }, status: "completed", result: {} })

    const listed = JSON.parse((await tools.find((tool) => tool.name === "script_list")!.execute({})).content ?? "{}")
    expect(
      listed.candidates.some((candidate: { pid: number; sessionID: string | null; toolFinished: boolean | null }) => candidate.pid === 11 && candidate.sessionID === "ses_1" && candidate.toolFinished === true),
    ).toBe(true)

    await (cleanup as unknown as { tickScripts: () => Promise<unknown> }).tickScripts()
    expect(niced).toEqual([11])
    expect(notices[0]!.sessionID).toBe("ses_1")
    expect(notices[0]!.text).toContain("自动处置")

    clock += 2_000
    await (cleanup as unknown as { tickScripts: () => Promise<unknown> }).tickScripts()
    expect(killed).toEqual([11])
    expect(notices.some((entry) => entry.text.includes("已终止"))).toBe(true)

    await (cleanup as unknown as () => Promise<void>)()
  })

  test("extractCommand reads shell tool inputs", () => {
    expect(extractCommand({ command: "python x.py" })).toBe("python x.py")
    expect(extractCommand({ cmd: "node -e 1" })).toBe("node -e 1")
    expect(extractCommand({ foo: 1 })).toBeNull()
  })
})
