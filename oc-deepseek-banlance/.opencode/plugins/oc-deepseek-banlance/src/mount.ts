// 服务端挂载 — DeepSeek 余额查询:
//   • background refresh + TTL 缓存
//   • deepseek_balance 工具
//   • RPC deepseek.balance.v1 (HTTP 可调用, 供 TUI/桌面注入脚本/第三方客户端)
//   • 可选: 向 system 上下文注入一行余额 (contextLine, 默认关闭)
//
// 与宿主 API 解耦: 缺失的域 (旧运行时) 自动跳过对应注册。

import type { Plugin } from "@opencode/plugin"
import { fetchBalance, pickPrimary } from "./deepseek"
import { formatContextLine, formatDetail } from "./format"
import { resolveApiKey } from "./key"
import { DeepSeekBalance } from "./rpc"
import { createBalanceService, type BalanceLoaderResult, type BalanceSnapshot } from "./service"

export const PLUGIN_ID = "oc-deepseek-banlance"
export const PLUGIN_VERSION = "0.1.0"

const STORAGE_KEY = "deepseek.balance.snapshot"
const CONTEXT_SLOT = "oc-deepseek-balance:context-line"

export type Cleanup = () => Promise<void> | void

function hasFunction(value: unknown, key: string): boolean {
  return !!value && typeof (value as Record<string, unknown>)[key] === "function"
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback
}

export async function mount(ctx: Plugin.Context): Promise<Cleanup> {
  const options = ctx.options ?? {}
  const ttlMs = asNumber(options.ttlMs, 60_000)
  const refreshMs = asNumber(options.refreshMs, 15 * 60_000)
  const timeoutMs = asNumber(options.timeoutMs, 8_000)
  const contextLine = options.contextLine === true
  const toolEnabled = options.tool !== false
  const directory = (ctx.location as { directory?: string } | undefined)?.directory

  const loader = async (): Promise<BalanceLoaderResult> => {
    const resolved = resolveApiKey({ apiKey: asString(options.apiKey), directory })
    if (!resolved.key) {
      return {
        ok: false,
        noKey: true,
        error: "未找到 DeepSeek API Key",
        source: "none",
        isAvailable: null,
        infos: [],
        primary: null,
      }
    }
    const response = await fetchBalance(resolved.key, { baseURL: asString(options.baseURL), timeoutMs })
    return {
      ok: true,
      noKey: false,
      error: null,
      source: resolved.source,
      isAvailable: response.is_available,
      infos: response.balance_infos,
      primary: pickPrimary(response.balance_infos),
    }
  }

  const service = createBalanceService({ load: loader, ttlMs })

  // 用上次持久化的快照预热 (免等待)
  if (hasFunction(ctx.storage, "get")) {
    try {
      const cached = await ctx.storage.get(STORAGE_KEY)
      if (cached !== undefined) service.seed(cached)
    } catch {
      // ignore seed failures
    }
  }

  const registrations: Array<{ dispose: () => Promise<void> }> = []
  let rpcRegistration: { events?: { emit?: (name: string, data: unknown) => Promise<void> } } | null = null

  // 变更时: 持久化 + 广播 RPC 事件
  const offChange = service.onChange((snapshot) => {
    if (hasFunction(ctx.storage, "set")) {
      try {
        void Promise.resolve(ctx.storage.set(STORAGE_KEY, snapshot as unknown as never)).catch(() => {})
      } catch {
        // ignore
      }
    }
    try {
      void rpcRegistration?.events?.emit?.("updated", snapshot)?.catch?.(() => {})
    } catch {
      // ignore
    }
  })
  registrations.push({ dispose: async () => offChange() })

  // RPC: POST /api/rpc/deepseek.balance.v1/{get|refresh}
  if (hasFunction(ctx.rpc, "register")) {
    try {
      rpcRegistration = (await ctx.rpc.register(DeepSeekBalance, {
        get: async (input: unknown) => service.get(Boolean((input as { refresh?: boolean } | undefined)?.refresh)),
        refresh: async () => service.get(true),
      })) as typeof rpcRegistration
      if (rpcRegistration) registrations.push(rpcRegistration as unknown as { dispose: () => Promise<void> })
    } catch {
      rpcRegistration = null
    }
  }

  // 工具: deepseek_balance
  if (toolEnabled && hasFunction(ctx.tool, "transform")) {
    registrations.push(
      await ctx.tool.transform((editor) => {
        editor.add({
          name: "deepseek_balance",
          description:
            "查询当前 DeepSeek API Key 的账户余额 (GET /user/balance)。" +
            "参数 refresh=true 可强制刷新; 默认返回 60 秒内的缓存。",
          input: {
            type: "object",
            properties: { refresh: { type: "boolean", description: "true 时强制刷新缓存" } },
            additionalProperties: false,
          },
          execute: async (input: unknown) => {
            const snapshot = await service.get(Boolean((input as { refresh?: boolean } | undefined)?.refresh))
            return { content: formatDetail(snapshot), metadata: snapshot as unknown as Record<string, unknown> }
          },
        })
      }),
    )
  }

  // 可选: system 上下文注入一行余额
  if (contextLine && hasFunction(ctx.session, "hook")) {
    registrations.push(
      await ctx.session.hook("context", (event) => {
        const line = formatContextLine(service.snapshot())
        if (line) {
          event.system.push({ type: "text", text: line, metadata: { source: PLUGIN_ID, slot: CONTEXT_SLOT } })
        }
      }),
    )
  }

  // 后台周期刷新
  if (refreshMs > 0) {
    const timer = setInterval(() => {
      void service.get(true)
    }, refreshMs)
    ;(timer as { unref?: () => void }).unref?.()
    registrations.push({ dispose: async () => clearInterval(timer) })
  }

  // 预热首个快照 (非阻塞)
  void service.get(false)

  return async () => {
    for (const registration of registrations.reverse()) {
      await registration.dispose()
    }
  }
}

export type { BalanceSnapshot }
