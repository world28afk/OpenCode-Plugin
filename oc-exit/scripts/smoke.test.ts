// 冒烟测试 — oc-exit（纯逻辑 + 挂载; 不真正结束进程, 不启动 powershell 副作用）。

import { describe, expect, test } from "bun:test"
import { createMount } from "../.opencode/plugins/oc-exit/src/mount"
import { classify, isDesktop, isMcpCmd, isService, type ProcInfo } from "../.opencode/plugins/oc-exit/src/processes"
import { buildFocusScript, buildQuitScript, normalizeQuit } from "../.opencode/plugins/oc-exit/src/quit"

const proc = (pid: number, name: string, cmd = ""): ProcInfo => ({ pid, ppid: 1, name, mb: 10, cmd })

describe("processes", () => {
  test("classifies desktop / service / mcp", () => {
    expect(isDesktop("OpenCode.exe")).toBe(true)
    expect(isDesktop("opencode-cli.exe")).toBe(false)
    expect(isService("opencode-cli.exe")).toBe(true)
    expect(isService("OpenCode.exe")).toBe(false)
    expect(isMcpCmd("node C:/x/@modelcontextprotocol/server-memory")).toBe(true)
    expect(isMcpCmd("node C:/app/index.js")).toBe(false)

    const found = classify([
      proc(100, "OpenCode.exe"),
      proc(101, "opencode-cli.exe"),
      proc(102, "node.exe", "npx -y @modelcontextprotocol/server-memory"),
      proc(103, "node.exe", "some unrelated server"),
    ])
    expect(found.desktop.map((item) => item.pid)).toEqual([100])
    expect(found.service.map((item) => item.pid)).toEqual([101])
    expect(found.mcp.map((item) => item.pid)).toEqual([102])
  })
})

describe("quit", () => {
  test("normalizeQuit defaults to desktop+service, mcp off", () => {
    expect(normalizeQuit({})).toEqual({ desktop: true, service: true, mcp: false })
    expect(normalizeQuit({ desktop: false })).toEqual({ desktop: false, service: true, mcp: false })
    expect(normalizeQuit({ mcp: true })).toEqual({ desktop: true, service: true, mcp: true })
  })

  test("buildQuitScript targets both desktop and service, desktop first", () => {
    const script = buildQuitScript({ desktop: true, service: true, mcp: false })
    expect(script).toContain("taskkill /IM OpenCode.exe /T /F")
    expect(script).toContain("taskkill /IM opencode-cli.exe /T /F")
    expect(script.indexOf("OpenCode.exe")).toBeLessThan(script.indexOf("opencode-cli.exe"))
    expect(script).not.toContain("modelcontextprotocol")
  })

  test("buildQuitScript can opt out and add mcp sweep", () => {
    const script = buildQuitScript({ desktop: false, service: true, mcp: true })
    expect(script).not.toContain("OpenCode.exe")
    expect(script).toContain("opencode-cli.exe")
    expect(script).toContain("modelcontextprotocol")
  })

  test("focus script uses Win32 activation", () => {
    expect(buildFocusScript()).toContain("SetForegroundWindow")
  })
})

describe("mount (fake host)", () => {
  test("registers exit.control rpc and answers status/dryRun quit", async () => {
    let definition: unknown = null
    let handlers: Record<string, (input: unknown) => Promise<unknown>> | null = null
    const disposals: string[] = []
    const ctx = {
      rpc: {
        register: async (def: unknown, fn: Record<string, (input: unknown) => Promise<unknown>>) => {
          definition = def
          handlers = fn
          return { dispose: async () => { disposals.push("rpc") } }
        },
      },
    }
    const cleanup = await createMount()(ctx as never)
    expect((definition as { id?: string })?.id).toBe("exit.control")
    expect(typeof handlers!.status).toBe("function")
    expect(typeof handlers!.quit).toBe("function")

    const status = (await handlers!.status!({})) as { plugin: string; counts: { desktop: number } }
    expect(status.plugin).toBe("oc-exit")
    expect(typeof status.counts.desktop).toBe("number")

    const dry = (await handlers!.quit!({ dryRun: true })) as { ok: boolean; dryRun: boolean; plan: { desktop: boolean } }
    expect(dry.ok).toBe(true)
    expect(dry.dryRun).toBe(true)
    expect(dry.plan.desktop).toBe(true)

    await cleanup()
    expect(disposals).toContain("rpc")
  })

  test("degrades on hosts without rpc domain", async () => {
    const cleanup = await createMount()({} as never)
    expect(typeof cleanup).toBe("function")
    await cleanup()
  })
})
