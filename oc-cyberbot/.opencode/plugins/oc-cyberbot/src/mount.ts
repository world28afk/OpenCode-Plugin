// oc-cyberbot 服务端挂载 —— 注册 RPC（供桌面 renderer 注入脚本调用）:
//   ping / list / get / edit / remove，见 ./rpc.ts。
//
// 插件接口遵循"缺失容错"约定：检测不到的 ctx 能力直接跳过（兼容旧宿主）。

import type { Plugin } from "@opencode/plugin"
import { dbPath, editMessageText, editPartText, listTurnParts, readMessageText, removePart } from "./edit"
import { CyberbotRPC } from "./rpc"

export const PLUGIN_ID = "oc-cyberbot"
export const PLUGIN_VERSION = "0.3.0"

export type Cleanup = () => Promise<void> | void

function hasFunction(value: unknown, key: string): boolean {
  return !!value && typeof (value as Record<string, unknown>)[key] === "function"
}

interface MessageInput {
  sessionID?: unknown
  messageID?: unknown
  text?: unknown
  partIndex?: unknown
}

const asString = (value: unknown): string => (typeof value === "string" ? value : "")
const asIndex = (value: unknown): number | undefined => (typeof value === "number" && Number.isInteger(value) ? value : undefined)

export async function mount(ctx: Plugin.Context): Promise<Cleanup> {
  const registrations: Array<{ dispose: () => Promise<void> }> = []

  // RPC/事件输出必须是纯 JSON 值（undefined 会被 schema 校验拒绝）。
  const json = <T>(value: T): T => JSON.parse(JSON.stringify(value))

  if (hasFunction(ctx.rpc, "register")) {
    try {
      const registration = await ctx.rpc.register(CyberbotRPC, {
        ping: async () =>
          json({
            ok: true,
            version: PLUGIN_VERSION,
            db: (() => {
              try {
                return dbPath()
              } catch {
                return null
              }
            })(),
          }),
        list: async (input: unknown) => {
          const draft = (input ?? {}) as MessageInput
          return json(listTurnParts(asString(draft.sessionID), asString(draft.messageID)))
        },
        get: async (input: unknown) => {
          const draft = (input ?? {}) as MessageInput
          return json(readMessageText(asString(draft.sessionID), asString(draft.messageID)))
        },
        edit: async (input: unknown) => {
          const draft = (input ?? {}) as MessageInput
          const partIndex = asIndex(draft.partIndex)
          if (partIndex === undefined) {
            // 兼容旧调用：整消息合并替换全部 text 段
            return json(editMessageText(asString(draft.sessionID), asString(draft.messageID), asString(draft.text)))
          }
          return json(editPartText(asString(draft.sessionID), asString(draft.messageID), partIndex, asString(draft.text)))
        },
        remove: async (input: unknown) => {
          const draft = (input ?? {}) as MessageInput
          const partIndex = asIndex(draft.partIndex)
          if (partIndex === undefined) return json({ ok: false, error: "partIndex 必填" })
          return json(removePart(asString(draft.sessionID), asString(draft.messageID), partIndex))
        },
      })
      if (registration) registrations.push(registration)
    } catch (error) {
      console.warn(`[${PLUGIN_ID}] rpc register failed:`, error instanceof Error ? error.message : String(error))
    }
  }

  return async () => {
    for (const registration of registrations.reverse()) {
      await registration.dispose()
    }
  }
}
