// 服务端挂载逻辑 — 与宿主 API 解耦, 便于用假 Context 做端到端冒烟测试。
// src/index.ts 以 { id, setup: mount } 形式导出。

import type { Plugin } from "@opencode/plugin"
import { buildSystemParts } from "./inject"
import { buildProfile } from "./profile"
import { loadKernelPrompts } from "./prompts"
import { InfiniteGen4Profile } from "./rpc"

export const PLUGIN_ID = "oc-infinite-gen-4"
export const PLUGIN_VERSION = "0.4.1"

export type Cleanup = () => Promise<void> | void

function hasFunction(value: unknown, key: string): boolean {
  return !!value && typeof (value as Record<string, unknown>)[key] === "function"
}

/**
 * 等价于上游 apply(): 注册双层 system 段 + profile 工具 + profile RPC, 返回清理函数。
 *
 * 能力探测: session.hook / tool.transform / rpc.register 是 OpenCode V2 插件 API。
 * 旧运行时 (如 opencode-ai 1.18.x 的 V2 预览内核) 会加载本插件但缺少这些域,
 * 此时静默降级为空操作, 避免污染宿主日志。
 */
export async function mount(ctx: Plugin.Context): Promise<Cleanup> {
  const options = ctx.options ?? {}
  const canHook = hasFunction(ctx.session, "hook")
  const canRegisterTools = hasFunction(ctx.tool, "transform")
  const inject = options.inject !== false && canHook
  const dualLayer = options.dualLayer !== false
  const profileTool = options.profileTool !== false && canRegisterTools

  const prompts = loadKernelPrompts()
  const registrations: Array<{ dispose: () => Promise<void> }> = []
  const profile = () => buildProfile({ version: PLUGIN_VERSION, inject, dualLayer, profileTool })

  if (inject) {
    // 等价于上游 Order 100 + Order 200 两个 systemPrompt section。
    // hook 在每次模型调用前运行, 追加到本次请求的 system 数组。
    registrations.push(
      await ctx.session.hook("context", (event) => {
        for (const part of buildSystemParts(prompts, { dualLayer, pluginID: PLUGIN_ID })) {
          event.system.push(part)
        }
      }),
    )
  }

  if (profileTool) {
    registrations.push(
      await ctx.tool.transform((editor) => {
        editor.add({
          name: "infinite_gen4_profile",
          description:
            "Return runtime metadata for the bundled 无限四代 (Infinite Generation Four) " +
            "kernel: version, injection slots, armor projection and host features.",
          input: { type: "object", properties: {}, additionalProperties: false },
          execute: async () => ({ content: JSON.stringify(profile(), null, 2) }),
        })
      }),
    )
  }

  // RPC: POST /api/rpc/infinite.gen4.profile/get — 桌面端徽章据此显示「运行中」
  if (hasFunction(ctx.rpc, "register")) {
    try {
      const registration = await ctx.rpc.register(InfiniteGen4Profile, {
        get: async () => profile(),
      })
      if (registration) registrations.push(registration as unknown as { dispose: () => Promise<void> })
    } catch (error) {
      // RPC 不可用不影响注入与工具; 记录一次便于诊断
      console.warn("[oc-infinite-gen-4] profile RPC registration failed:", error instanceof Error ? error.message : String(error))
    }
  }

  // 插件卸载时释放注册 (hook / tool / rpc), 等价于上游 ctx.effect 清理。
  return async () => {
    for (const registration of registrations.reverse()) {
      await registration.dispose()
    }
  }
}
