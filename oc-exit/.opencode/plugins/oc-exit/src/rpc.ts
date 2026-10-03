// RPC 契约 — exit.control
//
//   POST /api/rpc/exit.control/status  { "input": {} }                    → 服务/桌面进程快照
//   POST /api/rpc/exit.control/focus   { "input": {} }                    → 把 OpenCode 窗口显示到前台
//   POST /api/rpc/exit.control/quit    { "input": { "dryRun"?, ... } }    → 彻底退出（关闭界面 + 结束后台）
//
// rpcID 使用点号分隔（URL 路径段不能包含 "/"）。

export const RPC_ID = "exit.control"

const looseObject = { type: "object", additionalProperties: true } as const

export const ExitControl = {
  id: RPC_ID,
  methods: {
    status: {
      input: { type: "object", additionalProperties: false, properties: { force: { type: "boolean" } } },
      output: looseObject,
    },
    focus: {
      input: { type: "object", additionalProperties: false, properties: {} },
      output: looseObject,
    },
    quit: {
      input: {
        type: "object",
        additionalProperties: false,
        properties: {
          dryRun: { type: "boolean", description: "只返回将执行的计划, 不真正退出" },
          desktop: { type: "boolean", description: "关闭桌面界面 (OpenCode.exe), 默认 true" },
          service: { type: "boolean", description: "结束后台服务 (opencode-cli.exe), 默认 true" },
          mcp: { type: "boolean", description: "额外清理残留 MCP 子进程, 默认 false（/T 通常已覆盖）" },
        },
      },
      output: looseObject,
    },
  },
  events: {
    updated: { schema: looseObject },
  },
} as const

export type ExitControlDefinition = typeof ExitControl
