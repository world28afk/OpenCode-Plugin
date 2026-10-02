// RPC 契约 — router.laya
//   status / decide / history / setMode / setTier
//   SSE 事件: rpc.router.laya.decision

export const RPC_ID = "router.laya"

const loose = { type: "object", additionalProperties: true } as const

export const RouterLaya = {
  id: RPC_ID,
  methods: {
    status: { input: { type: "object", additionalProperties: false, properties: {} }, output: loose },
    decide: {
      input: {
        type: "object",
        additionalProperties: false,
        properties: { text: { type: "string" }, sessionID: { type: "string" } },
        required: ["text"],
      },
      output: loose,
    },
    history: {
      input: { type: "object", additionalProperties: false, properties: { limit: { type: "number" } } },
      output: loose,
    },
    setMode: {
      input: { type: "object", additionalProperties: false, properties: { mode: { type: "string", enum: ["auto", "manual"] } }, required: ["mode"] },
      output: loose,
    },
    setTier: {
      input: {
        type: "object",
        additionalProperties: false,
        properties: { tier: { type: "string", enum: ["low", "high", "max"] }, sessionID: { type: "string" } },
        required: ["tier"],
      },
      output: loose,
    },
  },
  events: {
    decision: { schema: loose },
  },
} as const

export type RouterLayaDefinition = typeof RouterLaya
