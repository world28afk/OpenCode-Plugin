// RPC 契约 — 服务端注册后客户端可经 HTTP 调用:
//   POST /api/rpc/plugin.manager/list   { "input": {} } → { entries: [...] }
//   POST /api/rpc/plugin.manager/set    { "input": { name, scope?, kind?, enabled } } → { ok, error?, entry? }
//   SSE 事件: rpc.plugin.manager.updated
//
// rpcID 使用点号分隔（URL 路径段不能包含 "/"）。

export const RPC_ID = "plugin.manager"

const looseObject = { type: "object", additionalProperties: true } as const

export const PluginManager = {
  id: RPC_ID,
  methods: {
    list: {
      input: { type: "object", additionalProperties: false, properties: {} },
      output: looseObject,
    },
    set: {
      input: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          scope: { type: "string", enum: ["project", "global"] },
          kind: { type: "string", enum: ["dir", "file", "config"] },
          enabled: { type: "boolean" },
        },
        required: ["name", "enabled"],
      },
      output: looseObject,
    },
  },
  events: {
    updated: { schema: looseObject },
  },
} as const

export type PluginManagerDefinition = typeof PluginManager
