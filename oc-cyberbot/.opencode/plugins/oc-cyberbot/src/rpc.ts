// RPC 契约 —— 桌面 renderer 注入脚本通过 HTTP 调用:
//   POST /api/rpc/cyberbot.message/ping   { "input": {} }                                             → { ok, version, db }
//   POST /api/rpc/cyberbot.message/list   { "input": { sessionID, messageID } }                        → { ok, items: [{messageID, partIndex, kind, text, seq}], error? }
//   POST /api/rpc/cyberbot.message/get    { "input": { sessionID, messageID } }                        → { ok, text?, messageID?, resolvedFrom?, error? }
//   POST /api/rpc/cyberbot.message/edit   { "input": { sessionID, messageID, text, partIndex? } }      → { ok, text?, messageID?, error? }
//   POST /api/rpc/cyberbot.message/remove { "input": { sessionID, messageID, partIndex } }             → { ok, error? }
//
// rpcID 使用点分隔；URL 路径尾不能包含 "/"。

export const RPC_ID = "cyberbot.message"

const looseObject = { type: "object", additionalProperties: true } as const

const messageInput = {
  type: "object",
  additionalProperties: false,
  properties: {
    sessionID: { type: "string" },
    messageID: { type: "string" },
  },
  required: ["sessionID", "messageID"],
} as const

export const CyberbotRPC = {
  id: RPC_ID,
  methods: {
    ping: {
      input: { type: "object", additionalProperties: false, properties: {} },
      output: looseObject,
    },
    list: {
      input: messageInput,
      output: looseObject,
    },
    get: {
      input: messageInput,
      output: looseObject,
    },
    edit: {
      input: {
        type: "object",
        additionalProperties: false,
        properties: {
          sessionID: { type: "string" },
          messageID: { type: "string" },
          text: { type: "string" },
          partIndex: { type: "number" },
        },
        required: ["sessionID", "messageID", "text"],
      },
      output: looseObject,
    },
    remove: {
      input: {
        type: "object",
        additionalProperties: false,
        properties: {
          sessionID: { type: "string" },
          messageID: { type: "string" },
          partIndex: { type: "number" },
        },
        required: ["sessionID", "messageID", "partIndex"],
      },
      output: looseObject,
    },
  },
} as const

export type CyberbotRPCDefinition = typeof CyberbotRPC
