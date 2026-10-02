// 最小服务端插件骨架（单文件版本, 可拆分为 src/*）
// 能力: 会话上下文注入 + 工具 + RPC + 存储 + 能力探测降级 + 清理
//
// 放置: <项目>/.opencode/plugins/acme-plugin/index.ts
// 依赖: 仅 import type（运行时零外部依赖）

import type { Plugin } from "@opencode/plugin"

export const PLUGIN_ID = "acme-plugin"
export const PLUGIN_VERSION = "0.1.0"

const KEY = "acme.snapshot"

function hasFunction(value: unknown, key: string): boolean {
  return !!value && typeof (value as Record<string, unknown>)[key] === "function"
}

interface Snapshot {
  readonly value: number
  readonly updatedAt: number
}

export async function mount(ctx: Plugin.Context): Promise<() => Promise<void>> {
  const options = ctx.options ?? {}
  const canHook = hasFunction(ctx.session, "hook")
  const canTool = hasFunction(ctx.tool, "transform")
  const canRpc = hasFunction(ctx.rpc, "register")
  const canStorage = hasFunction(ctx.storage, "get") && hasFunction(ctx.storage, "set")

  const registrations: Array<{ dispose: () => Promise<void> }> = []
  let cached: Snapshot | null = null

  const refresh = async (): Promise<Snapshot> => {
    const value = Number(options.seed ?? 42) + Math.random()
    cached = { value, updatedAt: Date.now() }
    if (canStorage) await ctx.storage.set(KEY, cached)
    return cached
  }

  if (canStorage) {
    try {
      const stored = await ctx.storage.get(KEY)
      if (stored && typeof stored === "object") cached = stored as Snapshot
    } catch {
      // ignore
    }
  }

  // 1) 会话上下文注入（每次模型调用）
  if (canHook) {
    registrations.push(
      await ctx.session.hook("context", (event) => {
        event.system.push({ type: "text", text: "[ACME] 插件已挂载。", metadata: { source: PLUGIN_ID } })
      }),
    )
  }

  // 2) 工具
  if (canTool) {
    registrations.push(
      await ctx.tool.transform((editor) => {
        editor.add({
          name: "acme_value",
          description: "返回 ACME 当前值 (可选 refresh=true 刷新)",
          input: {
            type: "object",
            properties: { refresh: { type: "boolean" } },
            additionalProperties: false,
          },
          execute: async (input) => {
            const snapshot = (input as { refresh?: boolean } | undefined)?.refresh ? await refresh() : (cached ?? (await refresh()))
            return { content: JSON.stringify(snapshot, null, 2), metadata: { source: PLUGIN_ID } }
          },
        })
      }),
    )
  }

  // 3) RPC（POST /api/rpc/acme.value/get  body {"input":{}} → {"output":{...}}）
  //    ⚠️ rpcID 不要包含 "/"
  if (canRpc) {
    try {
      const registration = await ctx.rpc.register(
        {
          id: "acme.value",
          methods: {
            get: { input: { type: "object", additionalProperties: false, properties: {} }, output: { type: "object", additionalProperties: true } },
          },
          events: { updated: { schema: { type: "object", additionalProperties: true } } },
        },
        { get: async () => cached ?? (await refresh()) },
      )
      if (registration) registrations.push(registration as unknown as { dispose: () => Promise<void> })
    } catch (error) {
      console.warn(`[${PLUGIN_ID}] rpc register failed:`, error instanceof Error ? error.message : String(error))
    }
  }

  return async () => {
    for (const registration of registrations.reverse()) await registration.dispose()
  }
}

export default { id: PLUGIN_ID, setup: mount } satisfies Plugin.Plugin
