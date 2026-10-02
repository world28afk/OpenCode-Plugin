// 服务端挂载 — 插件管理:
//   • plugin_manager_list / plugin_manager_set 工具
//   • RPC plugin.manager (list/set + updated 事件) — 桌面设置面板开关与 TUI 的数据源
//
// 与宿主 API 解耦: 缺失的域自动跳过。

import { homedir } from "node:os"
import type { Plugin } from "@opencode/plugin"
import { listAll, setEnabled, type ManagerOptions, type SetInput } from "./manager"
import { PluginManager } from "./rpc"

export const PLUGIN_ID = "oc-plugin-manager"
export const PLUGIN_VERSION = "0.1.0"

export type Cleanup = () => Promise<void> | void

function hasFunction(value: unknown, key: string): boolean {
  return !!value && typeof (value as Record<string, unknown>)[key] === "function"
}

export async function mount(ctx: Plugin.Context): Promise<Cleanup> {
  const options = ctx.options ?? {}
  const projectDir = (ctx.location as { directory?: string } | undefined)?.directory
  const configHome = typeof options.configHome === "string" ? options.configHome : process.env.XDG_CONFIG_HOME
  const base: ManagerOptions = {
    projectDir: typeof options.projectDir === "string" ? options.projectDir : projectDir,
    home: typeof options.home === "string" ? options.home : homedir(),
    configHome,
  }

  const registrations: Array<{ dispose: () => Promise<void> }> = []
  let rpcRegistration: { events?: { emit?: (name: string, data: unknown) => Promise<void> } } | null = null

  // RPC/事件输出必须是纯 JSON（显式 undefined 会被 schema 校验拒绝）
  const json = <T>(value: T): T => JSON.parse(JSON.stringify(value))
  const snapshot = () => listAll(base)
  const emitUpdated = () => {
    try {
      void rpcRegistration?.events?.emit?.("updated", json(snapshot())).catch?.(() => {})
    } catch {
      // ignore
    }
  }

  if (hasFunction(ctx.tool, "transform")) {
    registrations.push(
      await ctx.tool.transform((editor) => {
        editor.add({
          name: "plugin_manager_list",
          description: "列出 OpenCode 插件（项目/全局目录 + opencode.json 配置）及其启用状态。",
          input: { type: "object", properties: {}, additionalProperties: false },
          execute: async () => ({ content: JSON.stringify(snapshot(), null, 2) }),
        })
        editor.add({
          name: "plugin_manager_set",
          description: "启用/禁用指定插件。目录型插件通过重命名 `.disabled` 切换, 配置型插件通过 opencode.json 的 `-id` 标记切换。",
          input: {
            type: "object",
            properties: {
              name: { type: "string", description: "插件名（目录名 / 文件名 / 配置条目 id）" },
              enabled: { type: "boolean" },
              scope: { type: "string", enum: ["project", "global"], description: "可选: 指定作用域" },
              kind: { type: "string", enum: ["dir", "file", "config"], description: "可选: 指定类型" },
            },
            required: ["name", "enabled"],
            additionalProperties: false,
          },
          execute: async (input) => {
            const result = setEnabled(base, input as SetInput)
            if (result.ok) emitUpdated()
            return { content: JSON.stringify({ ok: result.ok, error: result.error ?? null, entry: result.entry ?? null }, null, 2) }
          },
        })
      }),
    )
  }

  if (hasFunction(ctx.rpc, "register")) {
    try {
      rpcRegistration = (await ctx.rpc.register(PluginManager, {
        list: async () => json(snapshot()),
        set: async (input: unknown) => {
          const result = setEnabled(base, input as SetInput)
          if (result.ok) emitUpdated()
          return json({ ok: result.ok, error: result.error ?? null, entry: result.entry ?? null })
        },
      })) as typeof rpcRegistration
      if (rpcRegistration) registrations.push(rpcRegistration as unknown as { dispose: () => Promise<void> })
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
