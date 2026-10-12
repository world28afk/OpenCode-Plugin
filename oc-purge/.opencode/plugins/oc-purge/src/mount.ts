// 服务端挂载逻辑 — 与宿主 API 解耦, 便于用假 Context 做端到端冒烟测试。
// src/index.ts 以 { id, setup: mount } 形式导出。

import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { spawnSync } from "node:child_process"

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
import { normalizeAllowText } from "./netScope"
import { buildProfile } from "./profile"
import { PurgeStatus } from "./rpc"
import { buildTools, type PurgeController } from "./tools"
import { readSelectedCwdInject, scanCwdInstructions } from "./workspace"
import { DEFAULT_PROMPT } from "./prompts"

export const PLUGIN_ID = "oc-purge"
export const PLUGIN_VERSION = "1.1.71"

const STORAGE_KEY = "state"
const SKILL_ENTRY = "SKILL.md"

export type Cleanup = () => Promise<void> | void

function hasFunction(value: unknown, key: string): boolean {
  return !!value && typeof (value as Record<string, unknown>)[key] === "function"
}

const HOST_FEATURES = [
  'Context Hook Injection: session.hook("context") 每次模型调用组装 system 数组（等价 systemPrompt.section）',
  "Capability Protocol: oc-purge:capabilities 段（official / redteam-lead / redteam-child）",
  "Rules Library: 多规则集存储于插件私有 ctx.storage（等价 $DSH_HOME/rules/）",
  "Workspace Policy: fallback / strict / always（等价 workspace baseline 策略）",
  "CWD Rules: 扫描当前目录/祖先的 AGENTS.md / CLAUDE.md 并勾选注入（等价 CWD rules）",
  "Own Servers: 网段白名单（等价 $DSH_HOME/net-scope-allow.txt）",
  "Purge Tools: purge_status / purge_apply / purge_revert / purge_inject / purge_rules / purge_skills / purge_servers / purge_cwd",
  "Purge Commands: /purge /rules /skills（等价上游斜杠命令; 运行时无 command API 时自动省略）",
  "Purge RPC: /api/rpc/purge.status/{get,set,apply,revert,rules,skills,servers,cwd}",
  "Bundled Skills: skills/redteam/*.md 内置, 可导出/导入/新建/删除",
  "TUI Badge: prompt.footer.status 状态条（src/tui.tsx）",
  "Desktop Dock: 会话标题旁破甲面板（desktop/oc-purge-dock.js, Clean/Drill 双页 + Light/Ink）",
  "No Host Patch: 删除 cordis.patch.yml / patcher.js, 卸载即净（上游 patch 清单在 V2 无对应面）",
]

const SKILL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** 删除方案时清理指向它的绑定。 */
function pruneBindings(bindings: PurgeState["bindings"], removedId: string): PurgeState["bindings"] {
  const strip = (table: Readonly<Record<string, string>>): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(table)) if (value !== removedId) out[key] = value
    return out
  }
  return { model: strip(bindings.model), agent: strip(bindings.agent) }
}

/** 从 context 事件里取模型（不同版本字段略有差异, 全部容错）。 */
function modelOf(event: unknown): { id: string; provider?: string } | null {
  const e = (event ?? {}) as Record<string, unknown>
  const fromValue = (value: unknown): { id: string; provider?: string } | null => {
    if (!value) return null
    if (typeof value === "string") return { id: value }
    if (typeof value === "object") {
      const row = value as Record<string, unknown>
      const inner = typeof row.model === "object" && row.model ? (row.model as Record<string, unknown>) : row
      const id =
        typeof inner.id === "string"
          ? inner.id
          : typeof inner.modelID === "string"
            ? inner.modelID
            : typeof inner.model === "string"
              ? inner.model
              : undefined
      const provider =
        typeof inner.providerID === "string"
          ? inner.providerID
          : typeof inner.provider === "string"
            ? inner.provider
            : typeof row.providerID === "string"
              ? row.providerID
              : undefined
      if (id) return { id, provider }
    }
    return null
  }
  return (
    fromValue(e.model) ??
    fromValue((e.session as Record<string, unknown> | undefined)?.model) ??
    fromValue((e.request as Record<string, unknown> | undefined)?.model) ??
    null
  )
}

function agentOf(event: unknown): string | undefined {
  const value = (event as { agent?: unknown })?.agent
  if (typeof value === "string") return value
  if (value && typeof value === "object") {
    const id = (value as { id?: unknown }).id
    if (typeof id === "string") return id
  }
  return undefined
}

function skillDoc(id: string, description: string, body: string): string {
  const desc = (description || id).replace(/\s+/g, " ").trim()
  const inner = String(body || "").replace(/^\uFEFF/, "").replace(/^\s*\n/, "")
  return `---\nname: ${id}\ndescription: ${JSON.stringify(desc)}\n---\n\n${inner}`
}

/** 递归找含 SKILL.md 的目录（深度 <= 3）。 */
function findSkillDirs(root: string, depth = 0): string[] {
  const out: string[] = []
  if (depth > 3) return out
  let entries: string[] = []
  try {
    entries = readdirSync(root)
  } catch {
    return out
  }
  if (entries.includes(SKILL_ENTRY)) out.push(root)
  for (const name of entries) {
    const full = join(root, name)
    try {
      if (statSync(full).isDirectory()) out.push(...findSkillDirs(full, depth + 1))
    } catch {
      /* ignore */
    }
  }
  return out
}

/**
 * 等价于上游 apply(ctx, config): 注册注入 hook + 工具 + 命令 + RPC, 返回清理函数。
 *
 * 能力探测: session.hook / tool.transform / command.transform / rpc.register 是 OpenCode V2
 * 插件 API。旧运行时缺少这些域时静默降级为空操作, 避免污染宿主日志。
 */
export async function mount(ctx: Plugin.Context): Promise<Cleanup> {
  const options = (ctx.options ?? {}) as Record<string, unknown>
  const canHook = hasFunction(ctx.session, "hook")
  const canRegisterTools = hasFunction(ctx.tool, "transform")
  const canStore = hasFunction(ctx.storage, "get") && hasFunction(ctx.storage, "set")
  const inject = options.inject !== false && canHook
  const redteam = options.redteam === true
  const redteamChild = options.redteamChild === true
  const preserveChatml = options.preserveChatml === true

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

  const projectDir = str((ctx.location as { directory?: unknown } | undefined)?.directory) ?? process.cwd()
  const skillsRoot = str(options.skillsDir) ?? join(projectDir, ".opencode", "skills")

  // 运行时观测：最近一次请求看到的模型 / agent（不落盘, 供面板显示与绑定校验）。
  let lastModel: string | null = null
  let lastAgent: string | null = null
  let lastModelPersistAt = 0

  const installedSkills = (): string[] => {
    try {
      return readdirSync(skillsRoot)
        .filter((name) => {
          try {
            return existsSync(join(skillsRoot, name, SKILL_ENTRY))
          } catch {
            return false
          }
        })
        .sort()
    } catch {
      return []
    }
  }

  const controller: PurgeController = {
    state: () => state,
    profile: () => profile(),
    update: async (patch) => {
      const next = { ...state, ...patch }
      if (typeof patch.serversText === "string") next.serversText = normalizeAllowText(patch.serversText).text
      state = normalizeState(next)
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
      const bindings = pruneBindings(state.bindings, id)
      state = normalizeState({ ...state, rules, activeRule, bindings })
      await persist()
      return { removed, state }
    },
    duplicateRule: async (id, newId) => {
      const source = state.rules.find((rule) => rule.id === id)
      if (!source) return { ok: false, error: `方案不存在: ${id}`, state }
      if (!SKILL_ID.test(newId)) return { ok: false, error: "newId 必须是 kebab-case", state }
      const copy: PurgeRule = { id: newId, name: newId, content: source.content, updatedAt: Date.now() }
      state = normalizeState({ ...state, rules: [...state.rules.filter((r) => r.id !== newId), copy] })
      await persist()
      return { ok: true, state }
    },
    renameRule: async (id, name) => {
      const source = state.rules.find((rule) => rule.id === id)
      if (!source) return { ok: false, error: `方案不存在: ${id}`, state }
      state = normalizeState({
        ...state,
        rules: state.rules.map((rule) => (rule.id === id ? { ...rule, name: name.trim() || rule.id, updatedAt: Date.now() } : rule)),
      })
      await persist()
      return { ok: true, state }
    },
    setBinding: async (kind, key, schemeId) => {
      const table = { ...(kind === "model" ? state.bindings.model : state.bindings.agent) }
      if (schemeId) table[key] = schemeId
      else delete table[key]
      const bindings = kind === "model" ? { ...state.bindings, model: table } : { ...state.bindings, agent: table }
      state = normalizeState({ ...state, bindings })
      await persist()
      return state
    },
    apply: async () => {
      state = normalizeState({ ...state, enabled: true })
      await persist()
      return state
    },
    revert: async () => {
      state = normalizeState({
        ...state,
        customText: null,
        activeRule: null,
        policy: "fallback",
        cwdSelections: [],
        bindings: { model: {}, agent: {} },
      })
      await persist()
      return state
    },
    listSkills: () => BUNDLED_SKILLS.map((skill) => ({ id: skill.id, description: skill.description })),
    installedSkills,
    installSkills: (ids, targetDir) => {
      const wanted = ids && ids.length ? new Set(ids) : null
      const dir = targetDir ?? skillsRoot
      const installed: string[] = []
      for (const skill of BUNDLED_SKILLS) {
        if (wanted && !wanted.has(skill.id)) continue
        const folder = join(dir, skill.id)
        try {
          if (!existsSync(folder)) mkdirSync(folder, { recursive: true })
          writeFileSync(join(folder, SKILL_ENTRY), skillDoc(skill.id, skill.description, skill.content), "utf8")
          installed.push(skill.id)
        } catch (error) {
          console.warn(`[oc-purge] skill install failed (${skill.id}):`, message(error))
        }
      }
      return { installed, targetDir: dir }
    },
    importSkills: async (sourcePath) => {
      const abs = resolve(sourcePath)
      if (!existsSync(abs)) return { ok: false, error: `路径不存在: ${abs}` }
      let scanRoot = abs
      let temp: string | null = null
      try {
        if (statSync(abs).isFile()) {
          if (!/\.zip$/i.test(abs)) return { ok: false, error: "只支持文件夹或 .zip" }
          temp = mkdtempSync(join(tmpdir(), "oc-purge-skill-"))
          const tar = spawnSync("tar", ["-xf", abs, "-C", temp], { encoding: "utf8", shell: false })
          if (tar.status !== 0) return { ok: false, error: "zip 解压失败（需要系统 tar/bsdtar）" }
          scanRoot = temp
        }
        const dirs = findSkillDirs(scanRoot, 0)
        if (!dirs.length) return { ok: false, error: "未找到 SKILL.md（请选择技能目录或其压缩包）" }
        const imported: string[] = []
        for (const dir of dirs) {
          const name = basename(dir)
          try {
            const target = join(skillsRoot, name)
            rmSync(target, { recursive: true, force: true })
            mkdirSync(skillsRoot, { recursive: true })
            cpSync(dir, target, { recursive: true })
            imported.push(name)
          } catch (error) {
            console.warn(`[oc-purge] skill import failed (${name}):`, message(error))
          }
        }
        return { ok: imported.length > 0, imported }
      } finally {
        if (temp) rmSync(temp, { recursive: true, force: true })
      }
    },
    createSkill: async (id, description, content) => {
      if (!SKILL_ID.test(id)) return { ok: false, error: "id 必须是 kebab-case，例如 code-review" }
      try {
        const folder = join(skillsRoot, id)
        mkdirSync(folder, { recursive: true })
        const body = content && content.trim() ? content : `# ${id}\n`
        const path = join(folder, SKILL_ENTRY)
        writeFileSync(path, skillDoc(id, description ?? id, body), "utf8")
        return { ok: true, path }
      } catch (error) {
        return { ok: false, error: message(error) }
      }
    },
    deleteSkill: async (id) => {
      if (!SKILL_ID.test(id)) return { ok: false, error: "id 必须是 kebab-case" }
      const folder = join(skillsRoot, id)
      if (!existsSync(folder)) return { ok: false, error: `技能不存在: ${id}` }
      try {
        rmSync(folder, { recursive: true, force: true })
        return { ok: true, removed: id }
      } catch (error) {
        return { ok: false, error: message(error) }
      }
    },
    scanCwd: () => {
      const items = scanCwdInstructions(projectDir).map((item) => ({
        path: item.path,
        name: item.name,
        scope: item.scope,
        size: item.size,
        preview: item.preview,
      }))
      return { cwd: projectDir, items }
    },
  }

  const profile = () => {
    const [provider, modelID] = lastModel ? lastModel.split("/") : [undefined, undefined]
    return buildProfile({
      version: PLUGIN_VERSION,
      state,
      resolved: resolveInjectText(state, DEFAULT_PROMPT, readSelectedCwdInject(state.cwdSelections, projectDir), {
        model: modelID,
        provider,
        agent: lastAgent ?? undefined,
      }),
      hostFeatures: HOST_FEATURES,
      injectActive: inject,
      installedSkills: installedSkills(),
      servers: state.serversText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#")),
      cwd: scanCwdInstructions(projectDir).map((item) => ({ path: item.path, scope: item.scope, size: item.size })),
      lastModel: lastModel ?? state.lastModel,
      lastAgent: lastAgent ?? state.lastAgent,
      directory: projectDir,
    })
  }

  const registrations: Array<{ dispose: () => Promise<void> | void }> = []

  // ── 1. 系统提示词注入（等价上游三个 systemPrompt section） ──────────────
  if (inject) {
    registrations.push(
      await ctx.session.hook("context", (event) => {
        const model = modelOf(event)
        const agent = agentOf(event)
        if (model) lastModel = model.provider ? `${model.provider}/${model.id}` : model.id
        if (agent) lastAgent = agent
        // 低频落盘（每 30s 至多一次）：便于其它 location 的 RPC 实例也能显示当前模型。
        if ((lastModel || lastAgent) && Date.now() - lastModelPersistAt > 30_000) {
          lastModelPersistAt = Date.now()
          void controller.update({ lastModel, lastAgent })
        }
        const cwdText = readSelectedCwdInject(state.cwdSelections, projectDir)
        const parts = buildSystemParts({
          state,
          resolved: resolveInjectText(state, DEFAULT_PROMPT, cwdText, {
            model: model?.id,
            provider: model?.provider,
            agent,
          }),
          redteam,
          redteamChild,
          pluginID: PLUGIN_ID,
          preserveChatml,
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

  // ── 3. 斜杠命令（等价上游 /purge /rules /skills; 无 API 时省略） ────────
  if (hasFunction(ctx.command, "transform")) {
    try {
      const tools = new Map(buildTools(controller).map((tool) => [tool.name, tool]))
      const runTool = async (name: string, input: Record<string, unknown>) => {
        const tool = tools.get(name)
        if (!tool) return { kind: "error", text: `${name} 不可用` }
        const result = await tool.execute(input)
        return { kind: "success", text: String((result as { content?: string }).content ?? "") }
      }
      const commandDefs = [
        {
          name: "purge",
          hint: "status | apply | revert | enable | disable | set-policy <fallback|strict|always>",
          run: (sub: string, rest: string) => {
            if (sub === "apply") return runTool("purge_apply", {})
            if (sub === "revert") return runTool("purge_revert", {})
            if (sub === "enable" || sub === "disable") return runTool("purge_inject", { action: sub })
            if (sub === "set-policy") return runTool("purge_inject", { action: "set-policy", policy: rest.trim() })
            return runTool("purge_status", {})
          },
        },
        {
          name: "rules",
          hint: "list | upsert <id> <内容> | delete <id> | activate <id> | deactivate",
          run: (sub: string, rest: string) => {
            if (sub === "upsert") {
              const [id = "", ...body] = rest.split(/\s+/)
              return runTool("purge_rules", { action: "upsert", id, content: body.join(" ") })
            }
            if (sub === "delete" || sub === "activate") return runTool("purge_rules", { action: sub, id: rest.trim() })
            if (sub === "deactivate") return runTool("purge_rules", { action: "deactivate" })
            return runTool("purge_rules", { action: "list" })
          },
        },
        {
          name: "skills",
          hint: "list | install | import <路径> | create <id> | delete <id>",
          run: (sub: string, rest: string) => {
            if (sub === "install") return runTool("purge_skills", { action: "install" })
            if (sub === "import") return runTool("purge_skills", { action: "import", path: rest.trim() })
            if (sub === "create" || sub === "delete") return runTool("purge_skills", { action: sub, id: rest.trim() })
            return runTool("purge_skills", { action: "list" })
          },
        },
      ]
      const registration = await ctx.command.transform((editor) => {
        for (const def of commandDefs) {
          editor.add({
            name: def.name,
            description: `oc-purge /${def.name}: ${def.hint}`,
            input: { hint: def.hint },
            handler: async (invocation: { rawInput?: string }) => {
              const raw = String(invocation?.rawInput ?? "").trim()
              const [sub = "", ...rest] = raw.split(/\s+/).filter(Boolean)
              return def.run(sub.toLowerCase(), rest.join(" "))
            },
          })
        }
      })
      if (registration) registrations.push(registration as unknown as { dispose: () => Promise<void> | void })
      if (hasFunction(ctx.command, "reload")) (ctx.command as { reload: () => void }).reload()
    } catch (error) {
      console.warn("[oc-purge] command registration failed:", message(error))
    }
  }

  // ── 4. RPC（等价上游 /redteam/api HTTP 桥） ─────────────────────────────
  if (hasFunction(ctx.rpc, "register")) {
    try {
      const tools = new Map(buildTools(controller).map((tool) => [tool.name, tool]))
      const call = async (name: string, input: Record<string, unknown>): Promise<unknown> => {
        const tool = tools.get(name)
        if (!tool) throw new Error(`${name} 不可用`)
        const result = await tool.execute(input)
        const content = (result as { content?: string }).content ?? "{}"
        return JSON.parse(content)
      }
      const registration = await ctx.rpc.register(PurgeStatus, {
        get: async () => profile(),
        set: async (input: unknown) => {
          state = normalizeState({ ...state, ...sanitizePatch(input, state) })
          await persist()
          return profile()
        },
        apply: async () => (await controller.apply(), profile()),
        revert: async () => (await controller.revert(), profile()),
        rules: async (input: unknown) => call("purge_rules", asInput(input)),
        skills: async (input: unknown) => call("purge_skills", asInput(input)),
        servers: async (input: unknown) => call("purge_servers", asInput(input)),
        cwd: async (input: unknown) => call("purge_cwd", asInput(input)),
      })
      if (registration) registrations.push(registration as unknown as { dispose: () => Promise<void> | void })
    } catch (error) {
      console.warn("[oc-purge] status RPC registration failed:", message(error))
    }
  }

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

/** 斜杠命令 → 工具入参。 */
function asInput(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {}
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
  if (typeof source.noticeAck === "boolean") patch.noticeAck = source.noticeAck
  if (typeof source.serversText === "string") patch.serversText = normalizeAllowText(source.serversText).text
  if (Array.isArray(source.cwdSelections)) patch.cwdSelections = source.cwdSelections.filter((item) => typeof item === "string")
  return patch
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
