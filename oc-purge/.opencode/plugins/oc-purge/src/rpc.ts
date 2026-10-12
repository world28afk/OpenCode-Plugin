// RPC 契约 — 服务端注册后客户端可经 HTTP 调用:
//   POST /api/rpc/purge.status/get      {} → 状态元数据 (注入槽位/规则/服务器/技能)
//   POST /api/rpc/purge.status/set      {"input":{enabled?,policy?,capabilityProtocol?,customText?,activeRule?,serversText?,cwdSelections?,noticeAck?}}
//   POST /api/rpc/purge.status/apply    {} → 开注入并应用
//   POST /api/rpc/purge.status/revert   {} → 回落到内置默认
//   POST /api/rpc/purge.status/rules    {"input":{action,id?,name?,content?}}
//   POST /api/rpc/purge.status/skills   {"input":{action,ids?,path?,id?,description?,content?}}
//   POST /api/rpc/purge.status/servers  {"input":{action,text?}}
//   POST /api/rpc/purge.status/cwd      {"input":{action,path?}}
//
// 供桌面 dock (desktop/oc-purge-dock.js) / TUI / 第三方客户端驱动。
// 注意: rpcID 使用点号分隔 (URL 路径段不能包含 "/")。
// Rpc.define 只是 identity 辅助, 这里用纯对象定义以保持运行时零外部依赖。

export const RPC_ID = "purge.status"

const looseObject = { type: "object", additionalProperties: true } as const

export const PurgeStatus = {
  id: RPC_ID,
  methods: {
    get: {
      input: { type: "object", additionalProperties: false, properties: {} },
      output: looseObject,
    },
    // 桌面 dock 的写面: 开关注入 / 切换策略 / 设置自定义注入文本（等价 Clean 页 Apply/编辑）。
    set: {
      input: {
        type: "object",
        additionalProperties: false,
        properties: {
          enabled: { type: "boolean" },
          policy: { type: "string", enum: ["fallback", "strict", "always"] },
          capabilityProtocol: { type: "boolean" },
          customText: { type: ["string", "null"] },
          activeRule: { type: ["string", "null"] },
          serversText: { type: "string" },
          cwdSelections: { type: "array", items: { type: "string" } },
          noticeAck: { type: "boolean" },
        },
      },
      output: looseObject,
    },
    apply: { input: { type: "object", additionalProperties: false, properties: {} }, output: looseObject },
    revert: { input: { type: "object", additionalProperties: false, properties: {} }, output: looseObject },
    rules: {
      input: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: {
            type: "string",
            enum: ["list", "use", "save", "duplicate", "rename", "delete", "bind", "unbind", "reset", "activate", "deactivate", "upsert"],
          },
          id: { type: "string" },
          name: { type: "string" },
          content: { type: "string" },
          newId: { type: "string" },
          kind: { type: "string", enum: ["model", "agent"] },
          key: { type: "string" },
        },
      },
      output: looseObject,
    },
    skills: {
      input: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", enum: ["list", "install", "import", "create", "delete"] },
          ids: { type: "array", items: { type: "string" } },
          path: { type: "string" },
          id: { type: "string" },
          description: { type: "string" },
          content: { type: "string" },
        },
      },
      output: looseObject,
    },
    servers: {
      input: {
        type: "object",
        additionalProperties: false,
        properties: { action: { type: "string", enum: ["list", "set"] }, text: { type: "string" } },
      },
      output: looseObject,
    },
    cwd: {
      input: {
        type: "object",
        additionalProperties: false,
        properties: { action: { type: "string", enum: ["scan", "select", "deselect", "clear"] }, path: { type: "string" } },
      },
      output: looseObject,
    },
  },
  events: {
    updated: { schema: looseObject },
  },
} as const

export type PurgeStatusDefinition = typeof PurgeStatus
