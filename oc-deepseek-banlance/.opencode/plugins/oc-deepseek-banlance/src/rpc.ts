// RPC 契约 — 服务端注册后客户端可经 HTTP 调用:
//   POST /api/rpc/deepseek.balance.v1/get      { "refresh"?: boolean } → BalanceSnapshot
//   POST /api/rpc/deepseek.balance.v1/refresh  {}                      → BalanceSnapshot
//   SSE 事件: rpc.deepseek.balance.v1.updated
//
// 注意: Rpc.define 只是 identity 辅助, 这里用纯对象定义以保持运行时零外部依赖
// (与 oc-infinite-gen-4 的自包含策略一致)。

export const RPC_ID = "deepseek.balance.v1"

/** 宽松对象 schema — 余额快照字段可能随失败状态增减。 */
const looseObject = { type: "object", additionalProperties: true } as const

export const DeepSeekBalance = {
  id: RPC_ID,
  methods: {
    get: {
      input: {
        type: "object",
        additionalProperties: false,
        properties: { refresh: { type: "boolean" } },
      },
      output: looseObject,
    },
    refresh: {
      input: { type: "object", additionalProperties: false, properties: {} },
      output: looseObject,
    },
  },
  events: {
    updated: { schema: looseObject },
  },
} as const

export type DeepSeekBalanceDefinition = typeof DeepSeekBalance
