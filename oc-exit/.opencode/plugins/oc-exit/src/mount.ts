// 服务端挂载 — oc-exit:
//   • RPC exit.control: status / focus / quit（桌面角标右键菜单的数据与动作通道）
//   • 安全降级: 缺少 rpc 域时静默空操作, 不污染宿主日志。

import type { Plugin } from "@opencode/plugin"
import { resetCache, targets } from "./processes"
import { focusWindow, launchQuit, normalizeQuit } from "./quit"
import { ExitControl } from "./rpc"

export const PLUGIN_ID = "oc-exit"
export const PLUGIN_VERSION = "0.1.0"

export type Cleanup = () => Promise<void> | void

function hasFunction(value: unknown, key: string): boolean {
  return !!value && typeof (value as Record<string, unknown>)[key] === "function"
}

export function createMount() {
  return async function mount(ctx: Plugin.Context): Promise<Cleanup> {
    const registrations: Array<{ dispose: () => Promise<void> }> = []
    const json = <T>(value: T): T => JSON.parse(JSON.stringify(value))

    const snapshot = (force = false) => {
      const found = targets({ force })
      return {
        plugin: PLUGIN_ID,
        pluginVersion: PLUGIN_VERSION,
        platform: process.platform,
        serverPid: process.pid,
        desktop: found.desktop,
        service: found.service,
        mcp: found.mcp,
        counts: { desktop: found.desktop.length, service: found.service.length, mcp: found.mcp.length },
        at: Date.now(),
      }
    }

    if (hasFunction(ctx.rpc, "register")) {
      try {
        const registration = await ctx.rpc.register(ExitControl, {
          status: async (input: unknown) => json(snapshot((input as { force?: boolean } | undefined)?.force === true)),
          focus: async () => json(focusWindow()),
          quit: async (input: unknown) => {
            const value = (input ?? {}) as Record<string, unknown>
            const options = normalizeQuit(value)
            if (value.dryRun === true) {
              return json({ ok: true, dryRun: true, plan: options, snapshot: snapshot(true) })
            }
            resetCache()
            const result = launchQuit(options)
            return json({
              ok: result.ok,
              plan: options,
              command: result.command,
              error: result.error ?? null,
              note: "正在彻底退出 OpenCode（关闭界面 + 结束后台服务）…",
            })
          },
        })
        if (registration) registrations.push(registration as unknown as { dispose: () => Promise<void> })
      } catch (error) {
        console.warn(`[${PLUGIN_ID}] rpc registration failed:`, error instanceof Error ? error.message : String(error))
      }
    }

    return async () => {
      for (const registration of registrations.reverse()) {
        await registration.dispose()
      }
    }
  }
}
