// 服务端挂载 — oc-bark: OpenCode 的原版提示音事件, 同步推送 Bark 通知。
//
//   prompt hook ──► 记录 (sessionID → 任务原文 + 起始时间)
//   事件流      ──► session.execution.succeeded → 推送（原版 Agent 提示音事件）
//                   session.execution.failed    → 推送（原版 Errors 提示音事件, 可关）
//                   permission.asked            → 推送（原版 Permissions 提示音事件, 可关）
//                   session.execution.interrupted / session.deleted → 清理
//
//   ⚠️ 桌面端自带提示音由官方界面半体播放（设置 → Sound effects: Agent/Permissions/Errors）,
//      本插件不补丁桌面包、不触碰任何界面资源, 提示音保持原样; 两者由同一批服务端事件驱动。
//
//   依赖注入: createMount(deps) 允许测试替换 fetch / 时钟 / 环境变量 / 配置文件读取。

import type { Plugin } from "@opencode/plugin"
import {
  buildPushPayload,
  normalizePushUrl,
  sendBarkPush,
  type BarkPushConfig,
  type BarkPushResult,
} from "./bark"
import { defaultConfigPath, loadFileConfig, resolveConfig, type ResolvedConfig } from "./config"
import { buildCompletionBody, buildErrorBody, buildPermissionBody, DEFAULT_TITLE } from "./format"
import { Bark, RPC_ID } from "./rpc"

export const PLUGIN_ID = "oc-bark"
export const PLUGIN_VERSION = "0.3.1"

const DEFAULT_TEST_BODY = "这是一条来自 OpenCode oc-bark 的测试推送 ✅"
const MAX_PENDING = 200
const MAX_CHILD_SESSIONS = 500
const MAX_PERMISSION_IDS = 200
const MAX_EVENT_IDS = 500

export interface TurnRecord {
  /** 用户发的任务内容 (prompt.text) */
  task: string
  /** 该轮任务开始时间 (prompt hook 触发时刻) */
  startedAt: number
  messageID?: string
}

export interface BarkStats {
  pushed: number
  failed: number
  /** 因 minDurationMs / 未配置等原因跳过 */
  skipped: number
  /** 同进程其它 location 实例已认领（跨实例去重命中） */
  deduped: number
  last: BarkPushResult | null
}

export interface BarkDeps {
  /** 测试注入的 fetch; 默认 globalThis.fetch */
  fetchImpl?: typeof fetch
  /** 测试注入的时钟; 默认 Date.now */
  now?: () => number
  /** 测试注入的环境变量; 默认 process.env */
  env?: Record<string, string | undefined>
  /** 测试注入的文件读取器; 默认 node:fs */
  readFile?: (path: string) => string
  /** 配置文件路径; 默认 $OC_BARK_CONFIG 或 ~/.config/opencode/oc-bark.json */
  configPath?: string
  /** 日志输出; 默认 console.info */
  log?: (message: string) => void
}

/** 仅描述本插件实际用到的宿主能力 (运行时做能力探测, 旧内核缺失时降级)。 */
interface CtxLike {
  options?: Record<string, unknown>
  location?: { directory?: string }
  session?: {
    hook?: (name: string, callback: (event: unknown) => unknown) => Promise<{ dispose?: () => Promise<void> | void } | void>
    get?: (input: { sessionID: string }) => Promise<unknown>
    context?: (input: { sessionID: string }) => Promise<unknown>
  }
  event?: {
    subscribe?: (options?: { signal?: AbortSignal }) => AsyncIterable<unknown>
  }
  tool?: {
    transform?: (callback: (editor: CtxToolEditor) => void) => Promise<{ dispose?: () => Promise<void> | void } | void>
  }
  rpc?: {
    register?: (
      definition: unknown,
      handlers: Record<string, (input: unknown) => Promise<unknown>>,
    ) => Promise<{ dispose?: () => Promise<void> | void; events?: { emit?: (name: string, data: unknown) => Promise<void> } } | void>
  }
}

interface CtxToolEditor {
  add: (definition: {
    name: string
    description: string
    input: Record<string, unknown>
    execute: (input: unknown) => Promise<{ content: string; metadata?: Record<string, unknown> }>
  }) => void
}

interface IncomingEvent {
  type?: string
  created?: number
  id?: string
  location?: { directory?: string }
  data?: Record<string, unknown>
}

interface SessionInfoLite {
  parentID?: string
  title?: string
}

export interface MountHandle {
  (): Promise<void>
  /** 等待所有进行中的推送/查询结束 (测试与脚本用) */
  flush: () => Promise<unknown>
  /** 当前状态快照 (与 bark_status 一致) */
  status: () => Record<string, unknown>
}

function hasFunction(value: unknown, key: string): boolean {
  return !!value && typeof (value as Record<string, unknown>)[key] === "function"
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function maskKey(key: string): string {
  if (key.length <= 8) return "****"
  return `${key.slice(0, 4)}****${key.slice(-4)}`
}

/** 路径归一化: 统一分隔符 + 小写 (Windows 大小写/斜杠不敏感比较)。 */
function normalizePath(value: string | undefined): string | undefined {
  const text = asString(value)
  return text ? text.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase() : undefined
}

function jsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// ── 跨实例去重（同一服务进程内的关键机制）────────────────────────────────────
// 桌面每个 location(项目窗口)都会加载一份插件实例, 且事件流是全局的:
// 同一个 session.execution.succeeded 会被 N 个实例各处理一次 → N 条重复推送。
// 事件本身在当前版本不带 location, 因此用进程级"认领"保证同一事件只推一次。
const GLOBAL_CLAIM = Symbol.for("opencode.oc-bark.claimed")
const MAX_CLAIMS = 1000

interface ClaimStore {
  ids: Set<string>
  order: string[]
}

function claimStore(): ClaimStore {
  const host = globalThis as unknown as Record<PropertyKey, unknown>
  let store = host[GLOBAL_CLAIM] as ClaimStore | undefined
  if (!store) {
    store = { ids: new Set<string>(), order: [] }
    host[GLOBAL_CLAIM] = store
  }
  return store
}

/** 认领一个事件: 全进程内首个调用者返回 true, 其余实例返回 false。 */
export function claimOnce(key: string): boolean {
  const store = claimStore()
  if (store.ids.has(key)) return false
  store.ids.add(key)
  store.order.push(key)
  while (store.order.length > MAX_CLAIMS) {
    const first = store.order.shift()
    if (first === undefined) break
    store.ids.delete(first)
  }
  return true
}

/** 测试用: 清空进程级认领记录。 */
export function resetClaims(): void {
  const store = claimStore()
  store.ids.clear()
  store.order.length = 0
}

export function createMount(deps: BarkDeps = {}) {
  return async function mount(ctx: Plugin.Context): Promise<MountHandle> {
    const host = ctx as unknown as CtxLike
    const log = deps.log ?? ((message: string) => console.info(`[${PLUGIN_ID}] ${message}`))
    const now = deps.now ?? (() => Date.now())
    const env = deps.env ?? (typeof process !== "undefined" ? process.env : {})

    // ── 配置 ────────────────────────────────────────────────────────────────
    const options = asRecord(host.options) ?? {}
    const configPath = deps.configPath ?? asString(env.OC_BARK_CONFIG) ?? defaultConfigPath()
    const fileConfig = deps.readFile
      ? loadFileConfig(configPath, deps.readFile)
      : loadFileConfig(configPath)
    const config: ResolvedConfig = resolveConfig({ options, env, file: fileConfig, configPath })

    const pushConfig = (): BarkPushConfig => ({
      server: config.server,
      deviceKeys: config.deviceKeys,
      ...(config.group ? { group: config.group } : {}),
      ...(config.sound ? { sound: config.sound } : {}),
      ...(config.level ? { level: config.level } : {}),
      ...(config.icon ? { icon: config.icon } : {}),
      ...(config.url ? { url: config.url } : {}),
      timeoutMs: config.timeoutMs,
    })

    // ── 状态 ────────────────────────────────────────────────────────────────
    const pendingTurns = new Map<string, TurnRecord>()
    const childSessions = new Set<string>()
    const permissionIds = new Set<string>()
    const seenEventIds = new Set<string>()
    const stats: BarkStats = { pushed: 0, failed: 0, skipped: 0, deduped: 0, last: null }
    const registrations: Array<{ dispose: () => Promise<void> | void }> = []
    const abort = new AbortController()

    let inflight: Promise<unknown> = Promise.resolve()
    const track = (task: Promise<unknown>): void => {
      inflight = inflight.then(() => task).catch(() => {})
    }

    let rpcRegistration: { dispose?: () => Promise<void> | void; events?: { emit?: (name: string, data: unknown) => Promise<void> } } | null = null

    // 本实例所属 location: 每个项目窗口都会加载一份插件, 必须只处理自己 location 的事件,
    // 否则同一个完成事件会被 N 个实例各推一次 (实测 5 个 location → 5 条重复推送)。
    const ownDirectory = normalizePath(asRecord(host.location)?.directory as string | undefined)

    const isOwnLocation = (event: IncomingEvent): boolean => {
      if (!ownDirectory) return true
      const eventDirectory = normalizePath(asString(event.location?.directory))
      if (!eventDirectory) return true // 事件未带 location: 保守放行
      return eventDirectory === ownDirectory
    }

    /** 事件级去重 (重连重投/同 id 重放 → 只处理一次)。 */
    const rememberEvent = (eventID: string): void => {
      seenEventIds.add(eventID)
      while (seenEventIds.size > MAX_EVENT_IDS) {
        const first = seenEventIds.values().next().value
        if (first === undefined) break
        seenEventIds.delete(first)
      }
    }

    /** 跨实例认领: 同一事件在「同进程 N 份 location 实例」中只允许推送一次。 */
    const claimEvent = (event: IncomingEvent, kind: string): boolean => {
      const eventID = asString(event.id)
      if (!eventID) return true // 无 id 事件: 交给本实例内去重/轮次消费
      const sessionID = asString(event.data?.sessionID) ?? "-"
      return claimOnce(`${kind}|${eventID}|${sessionID}`)
    }

    const emitPushed = (payload: Record<string, unknown>): void => {
      try {
        void rpcRegistration?.events?.emit?.("pushed", jsonSafe(payload))?.catch?.(() => {})
      } catch {
        // ignore
      }
    }

    // ── 推送 ────────────────────────────────────────────────────────────────

    const failedResult = (message: string): BarkPushResult => ({ ok: false, url: "", message, at: now() })

    const pushMessage = async (message: { title: string; body: string; subtitle?: string }): Promise<BarkPushResult> => {
      if (!config.enabled) {
        const result = failedResult("oc-bark 已禁用 (enabled:false)")
        stats.last = result
        return result
      }
      if (!config.configured) {
        const result = failedResult(`未配置 Bark 推送: ${config.problems.join("; ") || "缺少 server / deviceKey"}`)
        stats.last = result
        stats.failed += 1
        return result
      }
      const payload = buildPushPayload(pushConfig(), message)
      const result = await sendBarkPush(pushConfig(), payload, {
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        timeoutMs: config.timeoutMs,
      })
      stats.last = result
      if (result.ok) stats.pushed += 1
      else {
        stats.failed += 1
        log(`推送失败: ${result.message} (${normalizePushUrl(config.server)})`)
      }
      emitPushed({
        kind: message.title,
        ok: result.ok,
        message: result.message,
        at: result.at,
        url: result.url,
      })
      return result
    }

    // ── 会话/任务追踪 ────────────────────────────────────────────────────────

    const rememberChild = (sessionID: string): void => {
      childSessions.add(sessionID)
      while (childSessions.size > MAX_CHILD_SESSIONS) {
        const first = childSessions.values().next().value
        if (first === undefined) break
        childSessions.delete(first)
      }
    }

    const trimPending = (): void => {
      while (pendingTurns.size > MAX_PENDING) {
        const first = pendingTurns.keys().next().value
        if (first === undefined) break
        pendingTurns.delete(first)
      }
    }

    const rememberPermission = (requestID: string): void => {
      permissionIds.add(requestID)
      while (permissionIds.size > MAX_PERMISSION_IDS) {
        const first = permissionIds.values().next().value
        if (first === undefined) break
        permissionIds.delete(first)
      }
    }

    const getSessionInfo = async (sessionID: string): Promise<SessionInfoLite | undefined> => {
      if (!hasFunction(host.session, "get")) return undefined
      try {
        const info = asRecord(await host.session!.get!({ sessionID }))
        if (!info) return undefined
        return {
          ...(typeof info.parentID === "string" ? { parentID: info.parentID } : {}),
          ...(typeof info.title === "string" ? { title: info.title } : {}),
        }
      } catch {
        return undefined
      }
    }

    /** 推送标题 = 会话标题（可关闭回退到配置标题）。 */
    const titleFor = (info: SessionInfoLite | undefined, fallback: string): string => {
      if (!config.titleFromSession) return fallback
      return asString(info?.title) ?? fallback
    }

    /** 最近一条用户消息 (prompt hook 未记录时的兜底: 插件热载/重连后的轮次)。 */
    const readLastUserTurn = async (sessionID: string): Promise<TurnRecord | undefined> => {
      if (!hasFunction(host.session, "context")) return undefined
      try {
        const messages = await host.session!.context!({ sessionID })
        if (!Array.isArray(messages)) return undefined
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          const message = asRecord(messages[index])
          if (!message || message.type !== "user") continue
          const text = asString(message.text)
          if (!text) continue
          const time = asRecord(message.time)
          const created = typeof time?.created === "number" ? time.created : undefined
          return {
            task: text,
            startedAt: created ?? now(),
            ...(asString(message.id) ? { messageID: asString(message.id)! } : {}),
          }
        }
      } catch {
        // ignore
      }
      return undefined
    }

    const recordPrompt = (event: unknown): void => {
      const payload = asRecord(event)
      const sessionID = asString(payload?.sessionID)
      if (!sessionID) return
      const prompt = asRecord(payload?.prompt)
      const task = asString(prompt?.text) ?? ""
      pendingTurns.set(sessionID, {
        task,
        startedAt: now(),
        ...(asString(payload?.messageID) ? { messageID: asString(payload?.messageID)! } : {}),
      })
      trimPending()
    }

    const isChild = async (sessionID: string): Promise<boolean> => {
      if (childSessions.has(sessionID)) return true
      const info = await getSessionInfo(sessionID)
      if (info?.parentID) {
        rememberChild(sessionID)
        return true
      }
      return false
    }

    const onExecutionSucceeded = async (event: IncomingEvent): Promise<void> => {
      const sessionID = asString(event.data?.sessionID)
      if (!sessionID) return
      const at = typeof event.created === "number" ? event.created : now()
      const info = await getSessionInfo(sessionID)
      if (info?.parentID) rememberChild(sessionID)
      const child = childSessions.has(sessionID)

      const recorded = pendingTurns.get(sessionID)
      pendingTurns.delete(sessionID)

      if (child && !config.notifyChildSessions) {
        stats.skipped += 1
        return
      }

      // 必须有「用户轮次」的证据才推送: prompt hook 记录, 或会话里能找到用户消息。
      // 中断清理后残留的 succeeded / 纯自动化会话 → 不打扰。
      let hasTurn = recorded !== undefined
      let task = recorded?.task ?? ""
      let startedAt = recorded?.startedAt
      if (!task) {
        const fallback = await readLastUserTurn(sessionID)
        if (fallback) {
          task = fallback.task
          hasTurn = true
          if (typeof startedAt !== "number") startedAt = fallback.startedAt
        }
      }
      if (!hasTurn) {
        stats.skipped += 1
        return
      }

      const durationMs = Math.max(0, at - (typeof startedAt === "number" ? startedAt : at))
      if (durationMs < config.minDurationMs) {
        stats.skipped += 1
        return
      }
      if (!config.enabled || !config.configured) {
        stats.skipped += 1
        return
      }
      const body = buildCompletionBody({
        task,
        ...(info?.title ? { fallbackTask: info.title } : {}),
        durationMs,
        template: config.template,
        maxTaskChars: config.maxTaskChars,
      })
      if (!claimEvent(event, "completed")) {
        stats.deduped += 1
        return
      }
      log(`任务完成 (${sessionID}), 推送: ${body}`)
      await pushMessage({ title: titleFor(info, config.title), body })
    }

    const onExecutionFailed = async (event: IncomingEvent): Promise<void> => {
      const sessionID = asString(event.data?.sessionID)
      if (!sessionID) return
      // 失败不清理 pending: 自动重试成功后仍需推送「完成」; 新 prompt 会自然覆盖
      const recorded = pendingTurns.get(sessionID)
      if (!recorded) return
      if (!config.enabled || !config.configured || !config.notifyOnError) return
      if (await isChild(sessionID)) return

      const at = typeof event.created === "number" ? event.created : now()
      const durationMs = Math.max(0, at - recorded.startedAt)
      if (durationMs < config.minDurationMs) return
      const info = await getSessionInfo(sessionID)
      const body = buildErrorBody({
        task: recorded.task,
        ...(info?.title ? { fallbackTask: info.title } : {}),
        durationMs,
        template: config.errorTemplate,
        maxTaskChars: config.maxTaskChars,
      })
      if (!claimEvent(event, "failed")) {
        stats.deduped += 1
        return
      }
      await pushMessage({ title: titleFor(info, config.errorTitle), body })
    }

    /** 授权请求 (对应桌面端 Sound effects → Permissions; 同 permission.asked 事件)。 */
    const onPermissionAsked = async (event: IncomingEvent): Promise<void> => {
      const requestID = asString(event.data?.id)
      const sessionID = asString(event.data?.sessionID)
      if (!requestID || !sessionID) return
      if (permissionIds.has(requestID)) return // 重连重投不重复打扰
      rememberPermission(requestID)
      if (!config.enabled || !config.configured || !config.notifyOnPermission) return
      if (await isChild(sessionID)) return

      const info = await getSessionInfo(sessionID)
      let task = pendingTurns.get(sessionID)?.task ?? ""
      if (!task) {
        const fallback = await readLastUserTurn(sessionID)
        task = fallback?.task ?? ""
      }
      const action = asString(event.data?.action)
      const resources = Array.isArray(event.data?.resources) ? event.data.resources : []
      const firstResource = resources.map((item) => asString(item)).find(Boolean)
      const detail = asString(event.data?.message) ?? [action, firstResource].filter(Boolean).join(" ")
      const body = buildPermissionBody({
        task,
        ...(info?.title ? { fallbackTask: info.title } : {}),
        detail,
        template: config.permissionTemplate,
        maxTaskChars: config.maxTaskChars,
      })
      if (!claimEvent(event, "permission")) {
        stats.deduped += 1
        return
      }
      await pushMessage({ title: titleFor(info, config.permissionTitle), body })
    }

    const handleEvent = (raw: unknown): void => {
      const event = asRecord(raw) as IncomingEvent | undefined
      const type = event?.type
      if (!type) return
      if (!isOwnLocation(event)) return // 只处理本 location 的事件 (多窗口各有一份实例)
      if (type === "session.execution.succeeded" || type === "session.execution.failed" || type === "permission.asked") {
        const eventID = asString(event?.id)
        if (eventID) {
          if (seenEventIds.has(eventID)) return // 重连重投: 同一事件只推一次
          rememberEvent(eventID)
        }
      }
      switch (type) {
        case "session.created": {
          const sessionID = asString(event?.data?.sessionID)
          if (sessionID && asString(event?.data?.parentID)) rememberChild(sessionID)
          return
        }
        case "session.deleted": {
          const sessionID = asString(event?.data?.sessionID)
          if (sessionID) pendingTurns.delete(sessionID)
          return
        }
        case "session.execution.interrupted": {
          const sessionID = asString(event?.data?.sessionID)
          const reason = asString(event?.data?.reason)
          // 用户主动取消/服务关闭 → 该轮任务作废; superseded 说明有新 prompt 接棒, 保留待命
          if (sessionID && reason !== "superseded") pendingTurns.delete(sessionID)
          return
        }
        case "session.execution.succeeded":
          track(onExecutionSucceeded(event!))
          return
        case "session.execution.failed":
          track(onExecutionFailed(event!))
          return
        case "permission.asked":
          track(onPermissionAsked(event!))
          return
        default:
          return
      }
    }

    // ── 组装状态 / 工具 / RPC ────────────────────────────────────────────────

    const statusPayload = (): Record<string, unknown> => ({
      plugin: PLUGIN_ID,
      version: PLUGIN_VERSION,
      enabled: config.enabled,
      configured: config.configured,
      server: config.server || null,
      pushUrl: normalizePushUrl(config.server) || null,
      deviceKeys: config.deviceKeys.map(maskKey),
      deviceKeyCount: config.deviceKeys.length,
      group: config.group ?? null,
      sound: config.sound ?? null,
      level: config.level ?? null,
      title: config.title,
      titleFromSession: config.titleFromSession,
      template: config.template,
      errorTitle: config.errorTitle,
      errorTemplate: config.errorTemplate,
      permissionTitle: config.permissionTitle,
      permissionTemplate: config.permissionTemplate,
      notifyOnError: config.notifyOnError,
      notifyOnPermission: config.notifyOnPermission,
      notifyChildSessions: config.notifyChildSessions,
      minDurationMs: config.minDurationMs,
      maxTaskChars: config.maxTaskChars,
      timeoutMs: config.timeoutMs,
      source: config.source,
      configPath: config.configPath,
      problems: config.problems,
      stats: {
        pushed: stats.pushed,
        failed: stats.failed,
        skipped: stats.skipped,
        deduped: stats.deduped,
        last: stats.last
          ? {
              ok: stats.last.ok,
              url: stats.last.url,
              status: stats.last.status ?? null,
              code: stats.last.code ?? null,
              message: stats.last.message,
              at: stats.last.at,
            }
          : null,
      },
      pendingTurns: pendingTurns.size,
      childSessionsTracked: childSessions.size,
      permissionsSeen: permissionIds.size,
      eventsSeen: seenEventIds.size,
      location: ownDirectory ?? null,
    })

    const runTest = async (input: unknown): Promise<Record<string, unknown>> => {
      const value = asRecord(input) ?? {}
      const title = asString(value.title) ?? config.title ?? DEFAULT_TITLE
      const body = asString(value.body) ?? DEFAULT_TEST_BODY
      return jsonSafe(await pushMessage({ title, body }))
    }

    const runSend = async (input: unknown): Promise<Record<string, unknown>> => {
      const value = asRecord(input) ?? {}
      const title = asString(value.title) ?? config.title ?? DEFAULT_TITLE
      const body = asString(value.body) ?? ""
      if (!body) return jsonSafe(failedResult("body 不能为空"))
      const subtitle = asString(value.subtitle)
      return jsonSafe(await pushMessage({ title, body, ...(subtitle ? { subtitle } : {}) }))
    }

    // 1) prompt hook: 记录用户任务原文 + 起始时间
    if (config.enabled && hasFunction(host.session, "hook")) {
      try {
        const registration = await host.session!.hook!("prompt", recordPrompt)
        if (registration?.dispose) registrations.push({ dispose: () => registration.dispose?.() })
      } catch (error) {
        log(`prompt hook 注册失败: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    // 2) 事件流: 完成/失败/中断/子会话追踪
    if (config.enabled && hasFunction(host.event, "subscribe")) {
      const createStream = host.event!.subscribe!.bind(host.event)
      const consume = async (): Promise<void> => {
        for await (const event of createStream({ signal: abort.signal })) handleEvent(event)
      }
      consume().catch((error) => {
        if (!abort.signal.aborted) log(`事件流中断: ${error instanceof Error ? error.message : String(error)}`)
      })
    }

    // 3) 工具: bark_status / bark_test
    if (hasFunction(host.tool, "transform")) {
      try {
        const registration = await host.tool!.transform!((editor) => {
          editor.add({
            name: "bark_status",
            description:
              "查看 oc-bark 状态: Bark 服务器/设备Key(掩码)/推送统计/待命任务数/配置来源与问题。" +
              "配置不生效时先跑它确认问题。",
            input: { type: "object", properties: {}, additionalProperties: false },
            execute: async () => ({ content: JSON.stringify(statusPayload(), null, 2), metadata: { ok: true } }),
          })
          editor.add({
            name: "bark_test",
            description:
              "发送一条 Bark 测试推送（验证服务器地址/设备Key 是否配置正确）。title/body 可选, 默认一套测试文案。",
            input: {
              type: "object",
              properties: { title: { type: "string" }, body: { type: "string" }, subtitle: { type: "string" } },
              additionalProperties: false,
            },
            execute: async (input) => {
              const value = asRecord(input) ?? {}
              const title = asString(value.title) ?? config.title ?? DEFAULT_TITLE
              const body = asString(value.body) ?? DEFAULT_TEST_BODY
              const subtitle = asString(value.subtitle)
              const result = await pushMessage({ title, body, ...(subtitle ? { subtitle } : {}) })
              return { content: JSON.stringify(jsonSafe(result), null, 2), metadata: { ok: result.ok } }
            },
          })
        })
        if (registration?.dispose) registrations.push({ dispose: () => registration.dispose?.() })
      } catch (error) {
        log(`工具注册失败: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    // 4) RPC: bark.v1 { status, test, send } + pushed 事件
    if (hasFunction(host.rpc, "register")) {
      try {
        rpcRegistration = await host.rpc!.register!(Bark, {
          status: async () => jsonSafe(statusPayload()),
          test: runTest,
          send: runSend,
        })
        if (rpcRegistration?.dispose) registrations.push({ dispose: () => rpcRegistration.dispose?.() })
      } catch (error) {
        log(`RPC 注册失败 (${RPC_ID}): ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    if (!config.enabled) log("已禁用 (enabled:false), 不注册任何推送行为")
    else if (!config.configured) log(`尚未配置完整 (${config.problems.join("; ")}); bark_status 查看, bark_test 验证`)

    // ── 清理 ────────────────────────────────────────────────────────────────
    const cleanup = async (): Promise<void> => {
      abort.abort()
      for (const registration of registrations.reverse()) {
        try {
          await registration.dispose()
        } catch {
          // ignore
        }
      }
    }

    const handle = cleanup as MountHandle
    handle.flush = () => inflight
    handle.status = () => jsonSafe(statusPayload())
    return handle
  }
}

export default { id: PLUGIN_ID, setup: createMount() } satisfies Plugin.Plugin
