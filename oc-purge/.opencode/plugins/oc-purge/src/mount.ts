// 服务端挂载逻辑 — 与宿主 API 解耦, 便于用假 Context 做端到端冒烟测试。
// src/index.ts 以 { id, setup: mount } 形式导出。

import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type { Plugin } from "@opencode/plugin"
import { BUNDLED_SKILLS } from "./skills"
import {
  DEFAULT_STATE,
  normalizeState,
  resolveInjectText,
  type PurgeRule,
  type PurgeState,
} from "./config"
import { buildSystemParts } from "./inject"
import { buildProfile } from "./profile"
import { DshPurgeStatus } from "./rpc"
import { buildTools, type PurgeController } from "./tools"
import { DEFAULT_PROMPT } from "./prompts"

export const PLUGIN_ID = "oc-purge"
export const PLUGIN_VERSION = "1.1.71"

const STORAGE_KEY = "state"

export type Cleanup = () => Promise<void> | void

function hasFunction(value: unknown, key: string): boolean {
  return !!value && typeof (value as Record<string, unknown>)[key] === "function"
}

const HOST_FEATURES = [
  'Context Hook Injection: session.hook("context") 每次模型调用组装 system 数组（等价 systemPrompt.section）',
  "Capability Protocol: dshpg-capabilities 段（official / redteam-lead / redteam-child）",
  "Rules Library: 多规则集存储于插件私有 ctx.storage（等价 $DSH_HOME/rules/）",
  "Workspace Policy: fallback / strict / always",
  "Purge Tools: purge_status / purge_inject / purge_rules / purge_skills（等价 tools.register）",
  "Purge RPC: POST /api/rpc/dsh.purge.status/get（桌面 dock 数据源，等价 /redteam/api 桥）",
  "Bundled Skills: skills/redteam/*.md 内置，可导出到 <项目>/.opencode/skills/",
  "TUI Badge: prompt.footer.status 状态条（src/tui.tsx）",
  "Desktop Dock: 会话标题旁破甲面板（desktop/oc-purge-dock.js）",
  "No Host Patch: 删除 cordis.patch.yml / patcher.js，卸载即净",
]

/**
 * 等价于上游 apply(ctx, config): 注册注入 hook + 工具 + RPC, 返回清理函数。
 *
 * 能力探测: session.hook / tool.transform / rpc.register 是 OpenCode V2 插件 API。
 * 旧运行时缺少这些域时静默降级为空操作, 避免污染宿主日志。
 */
export async function mount(ctx: Plugin.Context): Promise<Cleanup> {
  const options = (ctx.options ?? {}) as Record<string, unknown>
  const canHook = hasFunction(ctx.session, "hook")
  const canRegisterTools = hasFunction(ctx.tool, "transform")
  const canStore = hasFunction(ctx.storage, "get") && hasFunction(ctx.storage, "set")
  const inject = options.inject !== false && canHook
  const redteam = options.redteam === true
  const redteamChild = options.redteamChild === true

  // ── 状态装载（ctx.storage 优先, 否则内存默认） ──────────────────────────
  let state: PurgeState = DEFAULT_STATE
  if (canStore) {
    try {
      const raw = await (ctx.storage as { get: (key: string) => Promise<unknown> }).get(STORAGE_KEY)
      if (raw !== undefined && raw !== null) state = normalizeState(raw)
    } catch (error) {
      console.warn("[oc-purge] state load failed:", message(error))
    }
  }

  const persist = async () => {
    if (!canStore) return
    try {
      await (ctx.storage as { set: (key: string, value: unknown) => Promise<void> }).set(STORAGE_KEY, state)
    } catch (error) {
      console.warn("[oc-purge] state persist failed:", message(error))
    }
  }

  const projectDir =
    str((ctx.location as { directory?: unknown } | undefined)?.directory) ?? process.cwd()
  const skillsRoot = str(options.skillsDir) ?? join(projectDir, ".opencode", "skills")

  const controller: PurgeController = {
    state: () => state,
    profile: () => profile(),
    update: async (patch) => {
      state = normalizeState({ ...state, ...patch })
      await persist()
      return state
    },
    upsertRule: async (rule) => {
      const next: PurgeRule = { updatedAt: Date.now(), ...rule }
      const rules = state.rules.filter((item) => item.id !== next.id)
      rules.push(next)
      state = normalizeState({ ...state, rules })
      await persist()
      return state
    },
    deleteRule: async (id) => {
      const rules = state.rules.filter((item) => item.id !== id)
      const removed = rules.length !== state.rules.length
      const activeRule = state.activeRule === id ? null : state.activeRule
      state = normalizeState({ ...state, rules, activeRule })
      await persist()
      return { removed, state }
    },
    listSkills: () => BUNDLED_SKILLS.map((skill) => ({ id: skill.id, description: skill.description })),
    installSkills: (ids, targetDir) => {
      const wanted = ids && ids.length ? new Set(ids) : null
      const dir = targetDir ?? skillsRoot
      const installed: string[] = []
      for (const skill of BUNDLED_SKILLS) {
        if (wanted && !wanted.has(skill.id)) continue
        const folder = join(dir, `dsh-purge-${skill.id}`)
        try {
          if (!existsSync(folder)) mkdirSync(folder, { recursive: true })
          writeFileSync(join(folder, "SKILL.md"), skill.content, "utf8")
          installed.push(skill.id)
        } catch (error) {
          console.warn(`[oc-purge] skill install failed (${skill.id}):`, message(error))
        }
      }
      return { installed, targetDir: dir }
    },
  }

  const profile = () =>
    buildProfile({
      version: PLUGIN_VERSION,
      state,
      resolved: resolveInjectText(state, DEFAULT_PROMPT),
      hostFeatures: HOST_FEATURES,
      injectActive: inject,
    })

  const registrations: Array<{ dispose: () => Promise<void> | void }> = []

  // ── 1. 系统提示词注入（等价上游三个 systemPrompt section） ──────────────
  if (inject) {
    registrations.push(
      await ctx.session.hook("context", (event) => {
        const parts = buildSystemParts({
          state,
          resolved: resolveInjectText(state, DEFAULT_PROMPT),
          redteam,
          redteamChild,
          pluginID: PLUGIN_ID,
        })
        for (const part of parts) event.system.push(part)
      }),
    )
  }

  // ── 2. 工具（等价上游 ctx.tools.register） ──────────────────────────────
  if (canRegisterTools) {
    registrations.push(
      await ctx.tool.transform((editor) => {
        for (const tool of buildTools(controller)) editor.add(tool)
      }),
    )
  }

  // ── 3. RPC（等价上游 /redteam/api HTTP 桥 / liberate dock） ─────────────
  if (hasFunction(ctx.rpc, "register")) {
    try {
      const registration = await ctx.rpc.register(DshPurgeStatus, {
        get: async () => profile(),
        set: async (input: unknown) => {
          await controller.update(sanitizePatch(input, state))
          return profile()
        },
      })
      if (registration) registrations.push(registration as unknown as { dispose: () => Promise<void> | void })
    } catch (error) {
      console.warn("[oc-purge] status RPC registration failed:", message(error))
    }
  }

  // ── 4. 解析器导出（供注入脚本/工具读取同一份契约） ─────────────────────
  ;(globalThis as Record<string, unknown>).__ocPurgeResolveInject = (raw: unknown) =>
    resolveInjectText(normalizeState(raw), DEFAULT_PROMPT)

  return async () => {
    for (const registration of registrations.reverse()) {
      try {
        await registration.dispose()
      } catch (error) {
        console.warn("[oc-purge] dispose failed:", message(error))
      }
    }
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

/** RPC set 白名单: 只接受已知字段, 其余忽略。 */
function sanitizePatch(input: unknown, current: PurgeState): Partial<PurgeState> {
  const source = input && typeof input === "object" ? (input as Record<string, unknown>) : {}
  const patch: Record<string, unknown> = {}
  if (typeof source.enabled === "boolean") patch.enabled = source.enabled
  if (source.policy === "fallback" || source.policy === "strict" || source.policy === "always") {
    patch.policy = source.policy
  }
  if (typeof source.capabilityProtocol === "boolean") patch.capabilityProtocol = source.capabilityProtocol
  if (typeof source.customText === "string") patch.customText = source.customText
  if (source.customText === null) patch.customText = null
  if (typeof source.activeRule === "string") {
    patch.activeRule = current.rules.some((rule) => rule.id === source.activeRule) ? source.activeRule : null
  }
  if (source.activeRule === null) patch.activeRule = null
  return patch
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
