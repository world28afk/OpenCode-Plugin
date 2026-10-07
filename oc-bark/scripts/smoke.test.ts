// 冒烟测试 — oc-bark 纯函数 + mount 闭环（全部使用 fixture, 不发真实网络请求）。

import { describe, expect, test } from "bun:test"
import {
  buildPushPayload,
  normalizeDeviceKeys,
  normalizePushUrl,
  sendBarkPush,
  DEFAULT_TIMEOUT_MS,
} from "../.opencode/plugins/oc-bark/src/bark"
import { defaultConfigPath, loadFileConfig, resolveConfig } from "../.opencode/plugins/oc-bark/src/config"
import {
  buildCompletionBody,
  buildErrorBody,
  buildPermissionBody,
  condenseTask,
  formatMinutes,
  renderTemplate,
} from "../.opencode/plugins/oc-bark/src/format"
import { createMount, resetClaims, type BarkDeps, type MountHandle } from "../.opencode/plugins/oc-bark/src/mount"

const NOW = 1_700_000_000_000
const MINUTE = 60_000

// ── fixtures ─────────────────────────────────────────────────────────────────

interface FetchCall {
  url: string
  init: RequestInit
  body: any
}

function makeFetch(response: { status?: number; json?: unknown } = {}) {
  const calls: FetchCall[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    calls.push({ url, init: init ?? {}, body })
    const status = response.status ?? 200
    const payload = response.json ?? { code: 200, message: "success", data: { timestamp: 1 } }
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } })
  }) as typeof fetch
  return { calls, fetchImpl }
}

function createChannel() {
  const queue: any[] = []
  let waiter: (() => void) | null = null
  let closed = false
  const wake = () => {
    const current = waiter
    waiter = null
    current?.()
  }
  const push = (event: any) => {
    queue.push(event)
    wake()
  }
  async function* iterate(signal?: AbortSignal): AsyncGenerator<any> {
    const onAbort = () => {
      closed = true
      wake()
    }
    signal?.addEventListener?.("abort", onAbort)
    try {
      while (true) {
        while (queue.length) yield queue.shift()
        if (closed || signal?.aborted) return
        await new Promise<void>((resolve) => {
          waiter = resolve
        })
      }
    } finally {
      signal?.removeEventListener?.("abort", onAbort)
    }
  }
  return { push, iterate }
}

interface HostSettings {
  sessions?: Record<string, { id: string; parentID?: string; title?: string }>
  messages?: Record<string, unknown[]>
}

function makeHost(options: Record<string, unknown> = {}, settings: HostSettings = {}) {
  const channel = createChannel()
  const hooks: Record<string, (event: any) => unknown> = {}
  const tools: Array<{ name: string; execute: (input?: unknown) => Promise<{ content: string; metadata?: any }> }> = []
  const rpcHandlers: Record<string, (input: unknown) => Promise<unknown>> = {}
  const disposals: string[] = []
  const emitted: Array<{ name: string; data: unknown }> = []
  const ctx = {
    options,
    location: { directory: "D:/work" },
    session: {
      hook: async (name: string, callback: (event: any) => unknown) => {
        hooks[name] = callback
        return {
          dispose: async () => {
            disposals.push(`hook:${name}`)
          },
        }
      },
      get: async ({ sessionID }: { sessionID: string }) => settings.sessions?.[sessionID] ?? { id: sessionID },
      context: async ({ sessionID }: { sessionID: string }) => settings.messages?.[sessionID] ?? [],
    },
    tool: {
      transform: async (callback: (editor: any) => void) => {
        callback({
          add: (definition: any) => tools.push(definition),
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
    rpc: {
      register: async (_definition: unknown, handlers: Record<string, (input: unknown) => Promise<unknown>>) => {
        Object.assign(rpcHandlers, handlers)
        return {
          dispose: async () => {
            disposals.push("rpc")
          },
          events: {
            emit: async (name: string, data: unknown) => {
              emitted.push({ name, data })
            },
          },
        }
      },
    },
    event: {
      subscribe: (opts?: { signal?: AbortSignal }) => channel.iterate(opts?.signal),
    },
  }
  return { ctx, hooks, tools, rpcHandlers, disposals, emitted, channel }
}

const noFile = () => {
  throw new Error("ENOENT")
}

async function setup(options: Record<string, unknown> = {}, settings: HostSettings = {}, deps: Partial<BarkDeps> = {}) {
  const host = makeHost(options, settings)
  const fetchBox = makeFetch()
  const logs: string[] = []
  const handle = (await createMount({
    fetchImpl: fetchBox.fetchImpl,
    now: () => NOW,
    env: {},
    configPath: "C:/oc-bark-test/oc-bark.json",
    readFile: noFile,
    log: (message) => logs.push(message),
    ...deps,
  })(host.ctx as any)) as MountHandle
  return { ...host, fetchBox, logs, handle }
}

/** 让事件消费循环处理一轮, 再等待所有进行中的推送/查询结束。 */
async function drain(handle: MountHandle) {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await handle.flush()
}

const promptEvent = (sessionID: string, text: string) => ({
  sessionID,
  messageID: `m-${sessionID}`,
  prompt: { text },
})
const succeeded = (sessionID: string, created: number) => ({
  type: "session.execution.succeeded",
  created,
  data: { sessionID },
})
const failed = (sessionID: string, created: number) => ({
  type: "session.execution.failed",
  created,
  data: { sessionID, error: { message: "boom" } },
})
const interrupted = (sessionID: string, reason: string) => ({
  type: "session.execution.interrupted",
  created: NOW,
  data: { sessionID, reason },
})
const permission = (sessionID: string, id: string, extra: Record<string, unknown> = {}) => ({
  type: "permission.asked",
  created: NOW + 30_000,
  data: { id, sessionID, action: "bash", resources: ["rm -rf /tmp/x"], ...extra },
})

const KEY = "test-device-key-1234"
const OPTIONS = { server: "https://api.day.app", deviceKey: KEY, group: "OpenCode" }

// ── format ───────────────────────────────────────────────────────────────────

describe("format", () => {
  test("formatMinutes 分段", () => {
    expect(formatMinutes(0)).toBe("不到1")
    expect(formatMinutes(59_000)).toBe("不到1")
    expect(formatMinutes(60_000)).toBe("1")
    expect(formatMinutes(3.4 * MINUTE)).toBe("3.4")
    expect(formatMinutes(5 * MINUTE)).toBe("5")
    expect(formatMinutes(9.94 * MINUTE)).toBe("9.9")
    expect(formatMinutes(42.4 * MINUTE)).toBe("42")
    expect(formatMinutes(Number.NaN)).toBe("不到1")
  })

  test("condenseTask 折叠空白 + 截断", () => {
    expect(condenseTask("  修\n复\t登录   接口  ")).toBe("修 复 登录 接口")
    const long = "很".repeat(150)
    const condensed = condenseTask(long, 100)
    expect(Array.from(condensed).length).toBe(101) // 100 字符 + …
    expect(condensed.endsWith("…")).toBe(true)
    expect(condenseTask(undefined)).toBe("")
  })

  test("renderTemplate 未提供的 token 原样保留", () => {
    expect(renderTemplate("a{task}b{minutes}c{other}", { task: "T", minutes: "1" })).toBe("aTb1c{other}")
  })

  test("默认完成文案与需求一致", () => {
    expect(buildCompletionBody({ task: "帮我修复登录接口", durationMs: 3.4 * MINUTE })).toBe(
      "关于‘帮我修复登录接口’任务目前已完成，历时3.4分钟",
    )
    expect(buildCompletionBody({ task: "", fallbackTask: "会话标题", durationMs: 30_000 })).toBe(
      "关于‘会话标题’任务目前已完成，历时不到1分钟",
    )
    expect(buildCompletionBody({ task: "", durationMs: 60_000 })).toBe("关于‘未记录任务’任务目前已完成，历时1分钟")
    expect(buildErrorBody({ task: "部署 A", durationMs: 200 * MINUTE })).toBe("关于‘部署 A’任务执行失败，历时200分钟")
    expect(buildCompletionBody({ task: "X", durationMs: MINUTE, template: "[{task}] {minutes}min" })).toBe("[X] 1min")
  })

  test("授权文案（原版 Permissions 提示音事件）", () => {
    expect(buildPermissionBody({ task: "部署 A", detail: "bash rm -rf /tmp/x" })).toBe(
      "关于‘部署 A’任务需要授权：bash rm -rf /tmp/x",
    )
    expect(buildPermissionBody({ task: "部署 A", detail: "" })).toBe("关于‘部署 A’任务需要授权：请打开 OpenCode 处理")
    expect(buildPermissionBody({ task: "", fallbackTask: "会话标题", detail: "X" })).toBe(
      "关于‘会话标题’任务需要授权：X",
    )
    expect(buildPermissionBody({ task: "T", detail: "D", template: "[{task}]{detail}" })).toBe("[T]D")
  })
})

// ── bark client ──────────────────────────────────────────────────────────────

describe("bark client", () => {
  test("normalizePushUrl", () => {
    expect(normalizePushUrl("https://api.day.app")).toBe("https://api.day.app/push")
    expect(normalizePushUrl("https://api.day.app/")).toBe("https://api.day.app/push")
    expect(normalizePushUrl("https://bark.example.com/push")).toBe("https://bark.example.com/push")
    expect(normalizePushUrl("https://bark.example.com/base/")).toBe("https://bark.example.com/base/push")
    expect(normalizePushUrl("")).toBe("")
  })

  test("normalizeDeviceKeys 去重 + 分隔符", () => {
    expect(normalizeDeviceKeys("a,b a;c")).toEqual(["a", "b", "c"])
    expect(normalizeDeviceKeys(["k1", " k2 ", "k1"])).toEqual(["k1", "k2"])
  })

  test("buildPushPayload: 单 key → device_key, 多 key → device_keys", () => {
    const single = buildPushPayload({ deviceKeys: [KEY], group: "OpenCode" }, { title: "T", body: "B" })
    expect(single).toEqual({ title: "T", body: "B", device_key: KEY, group: "OpenCode" })
    const multi = buildPushPayload({ deviceKeys: ["k1", "k2"], sound: "minuet", level: "active" }, { title: "T", body: "B" })
    expect(multi).toEqual({ title: "T", body: "B", device_keys: ["k1", "k2"], sound: "minuet", level: "active" })
  })

  test("sendBarkPush 成功 / 业务码失败 / 网络异常", async () => {
    const okBox = makeFetch()
    const ok = await sendBarkPush(
      { server: "https://api.day.app", deviceKeys: [KEY] },
      { title: "T", body: "B", device_key: KEY },
      { fetchImpl: okBox.fetchImpl },
    )
    expect(ok.ok).toBe(true)
    expect(okBox.calls[0]!.url).toBe("https://api.day.app/push")
    expect(okBox.calls[0]!.init.method).toBe("POST")

    const badBox = makeFetch({ status: 200, json: { code: 400, message: "device key not found" } })
    const bad = await sendBarkPush(
      { server: "https://api.day.app", deviceKeys: [KEY] },
      { title: "T", body: "B", device_key: KEY },
      { fetchImpl: badBox.fetchImpl },
    )
    expect(bad.ok).toBe(false)
    expect(bad.message).toBe("device key not found")

    const boom = await sendBarkPush(
      { server: "https://api.day.app", deviceKeys: [KEY] },
      { title: "T", body: "B", device_key: KEY },
      {
        fetchImpl: (async () => {
          throw new Error("connect ECONNREFUSED")
        }) as typeof fetch,
      },
    )
    expect(boom.ok).toBe(false)
    expect(boom.message).toContain("ECONNREFUSED")

    const unconfigured = await sendBarkPush({ server: "", deviceKeys: [] }, { title: "T", body: "B" })
    expect(unconfigured.ok).toBe(false)
    expect(unconfigured.message).toContain("未配置 Bark 服务器地址")

    const noKey = await sendBarkPush({ server: "https://api.day.app", deviceKeys: [] }, { title: "T", body: "B" })
    expect(noKey.ok).toBe(false)
    expect(noKey.message).toContain("Device Key")

    expect(DEFAULT_TIMEOUT_MS).toBe(8_000)
  })
})

// ── config ───────────────────────────────────────────────────────────────────

describe("config", () => {
  test("优先级 options > env > file, 并归一化 Key", () => {
    const resolved = resolveConfig({
      options: { server: "https://options.example", deviceKey: "opt-key-1" },
      env: { OC_BARK_SERVER: "https://env.example", OC_BARK_DEVICE_KEY: "env-key-1,env-key-2" },
      file: { server: "https://file.example", deviceKey: "file-key-1" },
    })
    expect(resolved.server).toBe("https://options.example")
    expect(resolved.deviceKeys).toEqual(["opt-key-1"])
    expect(resolved.source).toBe("options")

    const envOnly = resolveConfig({ env: { OC_BARK_SERVER: "https://env.example", OC_BARK_DEVICE_KEY: "env-key-1" } })
    expect(envOnly.server).toBe("https://env.example")
    expect(envOnly.source).toBe("env")

    const fileOnly = resolveConfig({ file: { server: "https://file.example", deviceKeys: ["file-key-1"] } })
    expect(fileOnly.server).toBe("https://file.example")
    expect(fileOnly.deviceKeys).toEqual(["file-key-1"])
    expect(fileOnly.source).toBe("file")
  })

  test("缺配置时 problems 指明缺项; enabled:false 遵守; 三事件推送默认开启", () => {
    const empty = resolveConfig({ configPath: "C:/x/oc-bark.json" })
    expect(empty.configured).toBe(false)
    expect(empty.problems.length).toBe(2)
    expect(empty.enabled).toBe(true)
    expect(empty.notifyOnError).toBe(true)
    expect(empty.notifyOnPermission).toBe(true)

    const disabled = resolveConfig({ options: { enabled: false, server: "https://a.b", deviceKey: "k" } })
    expect(disabled.enabled).toBe(false)
    expect(disabled.configured).toBe(true)
  })

  test("loadFileConfig 容忍缺失/损坏", () => {
    expect(loadFileConfig("C:/bark.json", () => '{"server":"https://api.day.app","deviceKey":"abc12345"}')).toEqual({
      server: "https://api.day.app",
      deviceKey: "abc12345",
    })
    expect(loadFileConfig("C:/bark.json", () => "not json")).toBeUndefined()
    expect(loadFileConfig("C:/bark.json", () => "[1,2]")).toBeUndefined()
    expect(loadFileConfig("C:/bark.json", noFile)).toBeUndefined()
    expect(defaultConfigPath("C:/Users/tester").replaceAll("\\", "/")).toBe("C:/Users/tester/.config/opencode/oc-bark.json")
  })
})

// ── mount ────────────────────────────────────────────────────────────────────

describe("mount (fake host)", () => {
  test("任务完成 → 推送「关于‘任务’任务目前已完成，历时x分钟」", async () => {
    const { hooks, channel, handle, fetchBox } = await setup(OPTIONS)
    hooks.prompt!(promptEvent("s1", "帮我修复登录接口"))
    channel.push(succeeded("s1", NOW + 3.4 * MINUTE))
    await drain(handle)

    expect(fetchBox.calls).toHaveLength(1)
    const call = fetchBox.calls[0]!
    expect(call.url).toBe("https://api.day.app/push")
    expect(call.body.device_key).toBe(KEY)
    expect(call.body.title).toBe("OpenCode 任务完成")
    expect(call.body.group).toBe("OpenCode")
    expect(call.body.body).toBe("关于‘帮我修复登录接口’任务目前已完成，历时3.4分钟")

    const status = handle.status()
    expect(status.stats.pushed).toBe(1)
    expect(status.configured).toBe(true)
    expect(status.pendingTurns).toBe(0)
    await handle()
  })

  test("子会话默认不推送; notifyChildSessions 打开后推送", async () => {
    const childSettings: HostSettings = { sessions: { c1: { id: "c1", parentID: "p1" } } }
    const first = await setup(OPTIONS, childSettings)
    first.hooks.prompt!(promptEvent("c1", "子代理任务"))
    first.channel.push(succeeded("c1", NOW + MINUTE))
    await drain(first.handle)
    expect(first.fetchBox.calls).toHaveLength(0)
    expect(first.handle.status().stats.skipped).toBe(1)
    await first.handle()

    const second = await setup({ ...OPTIONS, notifyChildSessions: true }, childSettings)
    second.hooks.prompt!(promptEvent("c1", "子代理任务"))
    second.channel.push(succeeded("c1", NOW + MINUTE))
    await drain(second.handle)
    expect(second.fetchBox.calls).toHaveLength(1)
    expect(second.fetchBox.calls[0]!.body.body).toBe("关于‘子代理任务’任务目前已完成，历时1分钟")
    await second.handle()
  })

  test("用户中断 → 不推送, 该轮作废", async () => {
    const { hooks, channel, handle, fetchBox } = await setup(OPTIONS)
    hooks.prompt!(promptEvent("s1", "写一半被取消"))
    channel.push(interrupted("s1", "user"))
    channel.push(succeeded("s1", NOW + MINUTE))
    await drain(handle)
    expect(fetchBox.calls).toHaveLength(0)
    expect(handle.status().pendingTurns).toBe(0)
    await handle()
  })

  test("失败默认推送「执行失败」; notifyOnError:false 静默且保留待命", async () => {
    const onError = await setup(OPTIONS) // 默认 notifyOnError=true（对齐原版 Errors 提示音默认开启）
    onError.hooks.prompt!(promptEvent("s1", "部署 A"))
    onError.channel.push(failed("s1", NOW + 2 * MINUTE))
    await drain(onError.handle)
    expect(onError.fetchBox.calls).toHaveLength(1)
    expect(onError.fetchBox.calls[0]!.body.title).toBe("OpenCode 任务失败")
    expect(onError.fetchBox.calls[0]!.body.body).toBe("关于‘部署 A’任务执行失败，历时2分钟")
    await onError.handle()

    const silent = await setup({ ...OPTIONS, notifyOnError: false })
    silent.hooks.prompt!(promptEvent("s1", "部署 A"))
    silent.channel.push(failed("s1", NOW + 2 * MINUTE))
    await drain(silent.handle)
    expect(silent.fetchBox.calls).toHaveLength(0)
    expect(silent.handle.status().pendingTurns).toBe(1) // 等重试成功
    silent.channel.push(succeeded("s1", NOW + 5 * MINUTE))
    await drain(silent.handle)
    expect(silent.fetchBox.calls).toHaveLength(1)
    expect(silent.fetchBox.calls[0]!.body.body).toBe("关于‘部署 A’任务目前已完成，历时5分钟")
    await silent.handle()
  })

  test("授权请求推送（对齐原版 Permissions 提示音）: 去重 / 关停 / 子会话", async () => {
    const first = await setup(OPTIONS)
    first.hooks.prompt!(promptEvent("s1", "部署 A"))
    first.channel.push(permission("s1", "req-1"))
    first.channel.push(permission("s1", "req-1")) // 重连重投: 不重复打扰
    await drain(first.handle)
    expect(first.fetchBox.calls).toHaveLength(1)
    expect(first.fetchBox.calls[0]!.body.title).toBe("OpenCode 需要授权")
    expect(first.fetchBox.calls[0]!.body.body).toBe("关于‘部署 A’任务需要授权：bash rm -rf /tmp/x")
    expect(first.handle.status().permissionsSeen).toBe(1)
    await first.handle()

    // message 优先于 action+resources
    const second = await setup(OPTIONS)
    second.hooks.prompt!(promptEvent("s1", "部署 A"))
    second.channel.push(permission("s1", "req-2", { message: "允许写入生产配置?" }))
    await drain(second.handle)
    expect(second.fetchBox.calls[0]!.body.body).toBe("关于‘部署 A’任务需要授权：允许写入生产配置?")
    await second.handle()

    const off = await setup({ ...OPTIONS, notifyOnPermission: false })
    off.hooks.prompt!(promptEvent("s1", "部署 A"))
    off.channel.push(permission("s1", "req-3"))
    await drain(off.handle)
    expect(off.fetchBox.calls).toHaveLength(0)
    await off.handle()

    const child = await setup(OPTIONS, { sessions: { c1: { id: "c1", parentID: "p1" } } })
    child.hooks.prompt!(promptEvent("c1", "子任务"))
    child.channel.push(permission("c1", "req-4"))
    await drain(child.handle)
    expect(child.fetchBox.calls).toHaveLength(0)
    await child.handle()
  })

  test("minDurationMs 过短的轮次跳过", async () => {
    const { hooks, channel, handle, fetchBox } = await setup({ ...OPTIONS, minDurationMs: 2 * MINUTE })
    hooks.prompt!(promptEvent("s1", "快速问答"))
    channel.push(succeeded("s1", NOW + 30_000))
    await drain(handle)
    expect(fetchBox.calls).toHaveLength(0)
    expect(handle.status().stats.skipped).toBe(1)
    await handle()
  })

  test("prompt hook 未参与时, 从会话消息兜底任务与起始时间", async () => {
    const messages: HostSettings = {
      messages: {
        s9: [
          { id: "a1", type: "assistant", text: "..." },
          { id: "m9", type: "user", text: "从消息兜底的任务", time: { created: NOW - 2 * MINUTE } },
        ],
      },
    }
    const { channel, handle, fetchBox } = await setup(OPTIONS, messages)
    channel.push(succeeded("s9", NOW))
    await drain(handle)
    expect(fetchBox.calls).toHaveLength(1)
    expect(fetchBox.calls[0]!.body.body).toBe("关于‘从消息兜底的任务’任务目前已完成，历时2分钟")
    await handle()
  })

  test("重复 succeeded 只推一次", async () => {
    const { hooks, channel, handle, fetchBox } = await setup(OPTIONS)
    hooks.prompt!(promptEvent("s1", "幂等测试"))
    channel.push(succeeded("s1", NOW + MINUTE))
    channel.push(succeeded("s1", NOW + MINUTE))
    await drain(handle)
    expect(fetchBox.calls).toHaveLength(1)
    await handle()
  })

  test("未配置时保持惰性: 不推送, bark_status 给出问题, bark_test 返回失败", async () => {
    const { hooks, channel, tools, handle, fetchBox } = await setup({})
    hooks.prompt!(promptEvent("s1", "无人接听的推送"))
    channel.push(succeeded("s1", NOW + MINUTE))
    await drain(handle)
    expect(fetchBox.calls).toHaveLength(0)

    const status = tools.find((tool) => tool.name === "bark_status")!
    const payload = JSON.parse((await status.execute({})).content)
    expect(payload.configured).toBe(false)
    expect(payload.problems.length).toBe(2)
    expect(payload.source).toBe("none")

    const testTool = tools.find((tool) => tool.name === "bark_test")!
    const result = JSON.parse((await testTool.execute({})).content)
    expect(result.ok).toBe(false)
    expect(fetchBox.calls).toHaveLength(0)
    await handle()
  })

  test("enabled:false 注册工具/RPC 但不订阅推送", async () => {
    const { hooks, tools, rpcHandlers, handle, fetchBox } = await setup({ ...OPTIONS, enabled: false })
    expect(hooks.prompt).toBeUndefined() // 未注册 prompt hook
    expect(tools.map((tool) => tool.name).sort()).toEqual(["bark_status", "bark_test"])
    const status = await rpcHandlers.status!({})
    expect((status as any).enabled).toBe(false)
    expect(fetchBox.calls).toHaveLength(0)
    await handle()
  })

  test("bark_test 工具与 bark.v1 RPC (test/send) 可手动推送", async () => {
    const { tools, rpcHandlers, handle, fetchBox, emitted } = await setup(OPTIONS)

    const testTool = tools.find((tool) => tool.name === "bark_test")!
    const toolResult = JSON.parse((await testTool.execute({ body: "你好" })).content)
    expect(toolResult.ok).toBe(true)
    expect(fetchBox.calls[0]!.body.body).toBe("你好")

    const rpcTest = (await rpcHandlers.test!({ title: "T2" })) as any
    expect(rpcTest.ok).toBe(true)
    expect(fetchBox.calls[1]!.body.title).toBe("T2")

    const rpcSend = (await rpcHandlers.send!({ body: "从 RPC 发出", subtitle: "副标题" })) as any
    expect(rpcSend.ok).toBe(true)
    expect(fetchBox.calls[2]!.body).toMatchObject({ body: "从 RPC 发出", subtitle: "副标题" })

    const empty = (await rpcHandlers.send!({ body: "" })) as any
    expect(empty.ok).toBe(false)

    // 状态里 Key 只露掩码
    const status = (await rpcHandlers.status!({})) as any
    expect(status.deviceKeys).toEqual(["test****1234"])
    expect(status.pushUrl).toBe("https://api.day.app/push")

    // pushed 事件广播
    expect(emitted.length).toBeGreaterThan(0)
    expect(emitted.every((entry) => entry.name === "pushed")).toBe(true)

    await handle()
  })

  test("清理函数释放 hook/工具/RPC 并中断事件流", async () => {
    const { hooks, disposals, handle, channel } = await setup(OPTIONS)
    hooks.prompt!(promptEvent("s1", "会被清理掉"))
    await handle()
    expect(disposals.sort()).toEqual(["hook:prompt", "rpc", "tool"])

    // abort 后事件流停止: push 不再产生推送
    channel.push(succeeded("s1", NOW + MINUTE))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(handle.flush).toBeDefined()
  })

  test("配置文件兜底 (options/env 为空时)", async () => {
    const { handle } = await setup({}, {}, {
      env: {},
      readFile: () => JSON.stringify({ server: "https://bark.example.com", deviceKey: "file-key-9876" }),
    })
    const status = handle.status()
    expect(status.server).toBe("https://bark.example.com")
    expect(status.source).toBe("file")
    await handle()
  })

  test("多 location 窗口去重: 只处理本 location 的事件", async () => {
    const { hooks, channel, handle, fetchBox } = await setup(OPTIONS)
    hooks.prompt!(promptEvent("s1", "只在当前窗口推送"))
    // 其它项目窗口的事件: 忽略（每个 location 各有一份插件实例）
    channel.push({ ...succeeded("s1", NOW + MINUTE), location: { directory: "D:/other-project" } })
    await drain(handle)
    expect(fetchBox.calls).toHaveLength(0)

    // 本 location（大小写/斜杠归一后可匹配）: 正常推送
    channel.push({ ...succeeded("s1", NOW + MINUTE), location: { directory: "d:\\work\\" } })
    await drain(handle)
    expect(fetchBox.calls).toHaveLength(1)
    await handle()
  })

  test("同一事件 id 重投只推一次", async () => {
    resetClaims()
    const { hooks, channel, handle, fetchBox } = await setup(OPTIONS)
    hooks.prompt!(promptEvent("s1", "事件 id 幂等"))
    const event = { ...succeeded("s1", NOW + MINUTE), id: "evt_dup_1" }
    channel.push(event)
    channel.push(event)
    await drain(handle)
    expect(fetchBox.calls).toHaveLength(1)
    expect(handle.status().eventsSeen).toBe(1)
    await handle()
  })

  test("跨实例去重: 同进程多 location 实例只推一次 (本轮重复问题)", async () => {
    resetClaims()
    const first = await setup(OPTIONS)
    const second = await setup(OPTIONS) // 模拟另一项目窗口的插件实例(同一服务进程)
    const event = { ...succeeded("s1", NOW + MINUTE), id: "evt_cross_1" }
    first.hooks.prompt!(promptEvent("s1", "跨实例只推一次"))
    second.hooks.prompt!(promptEvent("s1", "跨实例只推一次"))
    first.channel.push(event)
    second.channel.push(event)
    await drain(first.handle)
    await drain(second.handle)

    expect(first.fetchBox.calls.length + second.fetchBox.calls.length).toBe(1)
    expect(first.handle.status().stats.deduped + second.handle.status().stats.deduped).toBe(1)
    await first.handle()
    await second.handle()
  })

  test("标题使用会话标题（titleFromSession:false 可回退配置标题）", async () => {
    const settings: HostSettings = { sessions: { s1: { id: "s1", title: "修复登录空指针" } } }
    const first = await setup(OPTIONS, settings)
    first.hooks.prompt!(promptEvent("s1", "修复登录空指针"))
    first.channel.push(succeeded("s1", NOW + MINUTE))
    await drain(first.handle)
    expect(first.fetchBox.calls[0]!.body.title).toBe("修复登录空指针")
    expect(first.fetchBox.calls[0]!.body.body).toBe("关于‘修复登录空指针’任务目前已完成，历时1分钟")
    await first.handle()

    const second = await setup({ ...OPTIONS, titleFromSession: false }, settings)
    second.hooks.prompt!(promptEvent("s1", "修复登录空指针"))
    second.channel.push(succeeded("s1", NOW + MINUTE))
    await drain(second.handle)
    expect(second.fetchBox.calls[0]!.body.title).toBe("OpenCode 任务完成")
    await second.handle()
  })
})
