// RPC 契约 — 服务端注册后客户端可经 HTTP 调用:
//   POST /api/rpc/dsh.purge.status/get   {} → 状态元数据 (含注入开关/规则/技能)
//
// 供桌面 dock (desktop/oc-purge-dock.js) / TUI / 第三方客户端确认插件运行状态。
// 注意: rpcID 使用点号分隔 (URL 路径段不能包含 "/")。
// Rpc.define 只是 identity 辅助, 这里用纯对象定义以保持运行时零外部依赖。

export const RPC_ID = "dsh.purge.status"

const looseObject = { type: "object", additionalProperties: true } as const

export const DshPurgeStatus = {
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
        },
      },
      output: looseObject,
    },
  },
  events: {
    updated: { schema: looseObject },
  },
} as const

export type DshPurgeStatusDefinition = typeof DshPurgeStatus
