// purge 工具集（等价上游 ctx.tools.register 的 purge_status / purge_apply / purge_revert，
// 并补齐规则库 / 技能 / 自己的服务器 / 本地规则）。
// 框架无关: 通过 PurgeController 与宿主解耦, 便于假 Context 冒烟测试。

import {
  WORKSPACE_POLICIES,
  type PurgeRule,
  type PurgeState,
  type WorkspacePolicy,
} from "./config"

export interface PurgeController {
  /** 当前状态快照。 */
  state(): PurgeState
  /** profile() 元数据（purge_status / RPC 共用）。 */
  profile(): Record<string, unknown>
  /** 合并式更新状态并持久化。 */
  update(patch: Partial<PurgeState>): Promise<PurgeState>
  /** 新增/覆盖规则集。 */
  upsertRule(rule: Omit<PurgeRule, "updatedAt"> & { updatedAt?: number }): Promise<PurgeState>
  /** 删除规则集。 */
  deleteRule(id: string): Promise<{ removed: boolean; state: PurgeState }>
  /** 上游 purge_apply 的等价动作: 开注入 + 能力协议（写默认提示词）。 */
  apply(): Promise<PurgeState>
  /** 上游 purge_revert 的等价动作: 清自定义文本/激活规则, 回落内置默认。 */
  revert(): Promise<PurgeState>
  /** 列出内置红队技能。 */
  listSkills(): Array<{ id: string; description: string }>
  /** 列出目标目录里已安装的技能 id。 */
  installedSkills(): string[]
  /** 把内置红队技能导出到目标目录（默认 <项目>/.opencode/skills/）。 */
  installSkills(ids?: readonly string[], targetDir?: string): { installed: string[]; targetDir: string }
  /** 从文件夹/zip 导入技能（等价 /skills import <路径>）。 */
  importSkills(sourcePath: string): Promise<{ ok: boolean; imported?: string[]; error?: string }>
  /** 新建技能 SKILL.md（等价 /skills create <id> [说明]）。 */
  createSkill(id: string, description?: string, content?: string): Promise<{ ok: boolean; path?: string; error?: string }>
  /** 删除技能目录（等价 /skills delete <id>）。 */
  deleteSkill(id: string): Promise<{ ok: boolean; removed?: string; error?: string }>
  /** 扫描当前目录及祖先的 AGENTS.md / CLAUDE.md（等价 CWD rules）。 */
  scanCwd(): { cwd: string; items: Array<{ path: string; name: string; scope: string; size: number; preview: string }> }
}

export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly input: Record<string, unknown>
  readonly execute: (input: Record<string, unknown>, context?: unknown) => Promise<Record<string, unknown>>
}

const json = (value: unknown) => ({ content: JSON.stringify(value, null, 2) })

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)
const asArray = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined

export function buildTools(controller: PurgeController): ToolDefinition[] {
  return [
    {
      name: "purge_status",
      description:
        "Return oc-purge runtime status: injection slot state, resolved prompt source, active rule, " +
        "workspace policy, own-servers allowlist, CWD rules, bundled/installed red-team skills and host capabilities.",
      input: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => json(controller.profile()),
    },
    {
      name: "purge_apply",
      description:
        "OpenCode equivalent of upstream purge_apply: turn prompt injection on and re-apply the effective " +
        "prompt (custom text → active rule → selected CWD rules → bundled default). Takes effect on the next model call.",
      input: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => json({ ok: true, action: "apply", status: controller.profile(), state: await controller.apply() }),
    },
    {
      name: "purge_revert",
      description:
        "OpenCode equivalent of upstream purge_revert: clear custom text and the active rule, fall back to the " +
        "bundled default prompt, and restore the fallback workspace policy. Bundled assets always survive.",
      input: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => json({ ok: true, action: "revert", status: controller.profile(), state: await controller.revert() }),
    },
    {
      name: "purge_inject",
      description:
        "Control the oc-purge prompt injection. Actions: status | enable | disable | set-text | " +
        "clear-text | set-policy | set-post | set-capability. 'set-text' is the OpenCode equivalent of " +
        "editing prompt-inject.md; 'set-policy' selects fallback/strict/always.",
      input: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["status", "enable", "disable", "set-text", "clear-text", "set-policy", "set-post", "set-capability"],
          },
          text: { type: "string", description: "set-text / set-post 的正文（等价 prompt-inject.md）" },
          policy: { type: "string", enum: [...WORKSPACE_POLICIES] },
          capability: { type: "boolean", description: "set-capability: 是否注入能力选用协议段" },
        },
        required: ["action"],
        additionalProperties: false,
      },
      execute: async (input) => {
        const action = asString(input.action) ?? "status"
        if (action === "status") return json(controller.profile())
        if (action === "enable") {
          await controller.update({ enabled: true })
        } else if (action === "disable") {
          await controller.update({ enabled: false })
        } else if (action === "set-text") {
          await controller.update({ customText: asString(input.text) ?? "" })
        } else if (action === "clear-text") {
          await controller.update({ customText: null })
        } else if (action === "set-policy") {
          const policy = asString(input.policy)
          if (!policy || !WORKSPACE_POLICIES.includes(policy as WorkspacePolicy)) {
            return json({ ok: false, error: `policy 必须是 ${WORKSPACE_POLICIES.join(" / ")}` })
          }
          await controller.update({ policy: policy as WorkspacePolicy })
        } else if (action === "set-post") {
          await controller.update({ postPrompt: asString(input.text) ?? "" })
        } else if (action === "set-capability") {
          await controller.update({ capabilityProtocol: input.capability !== false })
        }
        return json({ ok: true, action, status: controller.profile() })
      },
    },
    {
      name: "purge_rules",
      description:
        "Manage the oc-purge rule library (OpenCode equivalent of $DSH_HOME/rules/ + /rules command). " +
        "Actions: list | upsert | delete | activate | deactivate.",
      input: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "upsert", "delete", "activate", "deactivate"] },
          id: { type: "string", description: "规则集 id（upsert/delete/activate 必填）" },
          name: { type: "string" },
          content: { type: "string", description: "规则集正文（upsert 必填）" },
        },
        required: ["action"],
        additionalProperties: false,
      },
      execute: async (input) => {
        const action = asString(input.action) ?? "list"
        if (action === "list") {
          const state = controller.state()
          return json({
            active: state.activeRule,
            policy: state.policy,
            rules: state.rules.map((rule) => ({ id: rule.id, name: rule.name, bytes: rule.content.length })),
          })
        }
        const id = asString(input.id)
        if (!id) return json({ ok: false, error: "id 必填" })
        if (action === "upsert") {
          const content = asString(input.content)
          if (content === undefined) return json({ ok: false, error: "content 必填" })
          await controller.upsertRule({ id, name: asString(input.name) ?? id, content })
          return json({ ok: true, action, id, status: controller.profile() })
        }
        if (action === "delete") {
          const result = await controller.deleteRule(id)
          return json({ ok: result.removed, action, id, status: controller.profile() })
        }
        if (action === "activate") {
          if (!controller.state().rules.some((rule) => rule.id === id)) return json({ ok: false, error: `规则集不存在: ${id}` })
          await controller.update({ activeRule: id })
          return json({ ok: true, action, id, status: controller.profile() })
        }
        await controller.update({ activeRule: null })
        return json({ ok: true, action: "deactivate", status: controller.profile() })
      },
    },
    {
      name: "purge_skills",
      description:
        "Manage red-team skills (upstream /skills command). Actions: list | install | import | create | delete. " +
        "'install' exports the bundled skills/redteam/*.md; 'import' takes a folder or zip path; " +
        "'create' writes <id>/SKILL.md; 'delete' removes <id> from the skills directory.",
      input: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "install", "import", "create", "delete"] },
          ids: { type: "array", items: { type: "string" }, description: "install 时指定技能 id；缺省=全部" },
          path: { type: "string", description: "import: 文件夹或 zip 路径" },
          id: { type: "string", description: "create/delete: 技能 id（kebab-case）" },
          description: { type: "string", description: "create: description" },
          content: { type: "string", description: "create: SKILL.md 正文（可选）" },
        },
        required: ["action"],
        additionalProperties: false,
      },
      execute: async (input) => {
        const action = asString(input.action) ?? "list"
        if (action === "list") {
          return json({ bundled: controller.listSkills(), installed: controller.installedSkills() })
        }
        if (action === "install") {
          const result = controller.installSkills(asArray(input.ids))
          return json({ ok: true, action, ...result, status: controller.profile() })
        }
        if (action === "import") {
          const path = asString(input.path)
          if (!path) return json({ ok: false, error: "path 必填" })
          return json({ action, ...(await controller.importSkills(path)) })
        }
        if (action === "create") {
          const id = asString(input.id)
          if (!id) return json({ ok: false, error: "id 必填" })
          return json({ action, ...(await controller.createSkill(id, asString(input.description), asString(input.content))) })
        }
        const id = asString(input.id)
        if (!id) return json({ ok: false, error: "id 必填" })
        return json({ action, ...(await controller.deleteSkill(id)) })
      },
    },
    {
      name: "purge_servers",
      description:
        "Own-servers allowlist (OpenCode equivalent of $DSH_HOME/net-scope-allow.txt). Actions: list | set. " +
        "'set' keeps one IP or exact hostname per line (user@host allowed) and drops keys, passwords, ranges and wildcards.",
      input: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "set"] },
          text: { type: "string", description: "set: 每行一个主机" },
        },
        required: ["action"],
        additionalProperties: false,
      },
      execute: async (input) => {
        const action = asString(input.action) ?? "list"
        if (action === "list") {
          const state = controller.state()
          const hosts = state.serversText
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line && !line.startsWith("#"))
          return json({ text: state.serversText, hosts })
        }
        const text = asString(input.text) ?? ""
        // 规范化由 mount 侧完成并回传结果
        const state = await controller.update({ serversText: text })
        const hosts = state.serversText
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith("#"))
        return json({ ok: true, action, text: state.serversText, hosts, status: controller.profile() })
      },
    },
    {
      name: "purge_cwd",
      description:
        "Workspace local rules (CWD rules): scan the current directory and its ancestors for AGENTS.md / " +
        "CLAUDE.md and pick which ones may be injected when the prompt is empty. Actions: scan | select | deselect | clear.",
      input: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["scan", "select", "deselect", "clear"] },
          path: { type: "string", description: "select/deselect: 文件绝对路径" },
        },
        required: ["action"],
        additionalProperties: false,
      },
      execute: async (input) => {
        const action = asString(input.action) ?? "scan"
        if (action === "scan") return json(controller.scanCwd())
        if (action === "clear") {
          await controller.update({ cwdSelections: [] })
          return json({ ok: true, action, status: controller.profile() })
        }
        const path = asString(input.path)
        if (!path) return json({ ok: false, error: "path 必填" })
        const current = new Set(controller.state().cwdSelections)
        if (action === "select") current.add(path)
        else current.delete(path)
        await controller.update({ cwdSelections: [...current] })
        return json({ ok: true, action, status: controller.profile() })
      },
    },
  ]
}
