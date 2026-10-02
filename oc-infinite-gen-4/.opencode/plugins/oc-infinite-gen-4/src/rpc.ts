// RPC 契约 — 服务端注册后客户端可经 HTTP 调用:
//   POST /api/rpc/infinite.gen4.profile/get   {} → profile 元数据 (含运行状态)
//
// 供桌面端徽章 (desktop/oc-infinite-gen-4-inject.js) / TUI / 第三方客户端确认插件是否在运行。
// 注意: rpcID 使用点号分隔 (URL 路径段不能包含 "/")。
// Rpc.define 只是 identity 辅助, 这里用纯对象定义以保持运行时零外部依赖。

export const RPC_ID = "infinite.gen4.profile"

const looseObject = { type: "object", additionalProperties: true } as const

export const InfiniteGen4Profile = {
  id: RPC_ID,
  methods: {
    get: {
      input: { type: "object", additionalProperties: false, properties: {} },
      output: looseObject,
    },
  },
  events: {
    updated: { schema: looseObject },
  },
} as const

export type InfiniteGen4ProfileDefinition = typeof InfiniteGen4Profile
