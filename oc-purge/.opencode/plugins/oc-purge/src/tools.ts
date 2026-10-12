// purge 工具集（等价上游 ctx.tools.register 的 purge_status / purge_apply / purge_revert）。
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
  /** 列出内置红队技能。 */
  listSkills(): Array<{ id: string; description: string }>
  /** 把内置红队技能导出到目标目录（默认 <项目>/.opencode/skills/）。 */
  installSkills(ids?: readonly string[], targetDir?: string): { installed: string[]; targetDir: string }
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
        "Return oc-purge runtime status: injection slot state, resolved prompt source, " +
        "active rule, workspace policy, bundled red-team skills and host capabilities.",
      input: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => json(controller.profile()),
    },
    {
      name: "purge_inject",
      description:
        "Control the dsh-purge prompt injection. Actions: status | enable | disable | set-text | " +
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
        "Manage the dsh-purge rule library (OpenCode equivalent of $DSH_HOME/rules/ + /rules command). " +
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
        // deactivate
        await controller.update({ activeRule: null })
        return json({ ok: true, action: "deactivate", status: controller.profile() })
      },
    },
    {
      name: "purge_skills",
      description:
        "List or export the bundled dsh-purge red-team skills (skills/redteam/*.md) into the " +
        "OpenCode skills directory (<项目>/.opencode/skills/<id>/SKILL.md). Actions: list | install.",
      input: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "install"] },
          ids: { type: "array", items: { type: "string" }, description: "install 时指定技能 id；缺省=全部" },
        },
        required: ["action"],
        additionalProperties: false,
      },
      execute: async (input) => {
        const action = asString(input.action) ?? "list"
        if (action === "list") return json({ skills: controller.listSkills() })
        const ids = asArray(input.ids)
        const result = controller.installSkills(ids)
        return json({ ok: true, action, ...result, status: controller.profile() })
      },
    },
  ]
}
