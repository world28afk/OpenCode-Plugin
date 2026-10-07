// RPC 契约 — bark.v1
//   methods: status / test / send
//   events:  pushed (每次推送结果广播, 供 TUI / 桌面注入 / 第三方客户端订阅)

export const RPC_ID = "bark.v1"

const loose = { type: "object", additionalProperties: true } as const

export const Bark = {
  id: RPC_ID,
  methods: {
    status: {
      input: { type: "object", additionalProperties: false, properties: {} },
      output: loose,
    },
    test: {
      input: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string", description: "推送标题, 默认 OpenCode 任务完成" },
          body: { type: "string", description: "推送正文, 默认一条测试文案" },
        },
      },
      output: loose,
    },
    send: {
      input: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          body: { type: "string" },
          subtitle: { type: "string" },
        },
        required: ["body"],
      },
      output: loose,
    },
  },
  events: {
    pushed: { schema: loose },
  },
} as const

export type BarkDefinition = typeof Bark
