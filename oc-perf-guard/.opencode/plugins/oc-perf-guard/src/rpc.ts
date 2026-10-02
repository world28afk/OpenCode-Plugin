// RPC 契约 — perf.guard
//   MCP 侧:    status / cleanup
//   脚本侧:    scripts / scriptKill / scriptKeep / scriptNice
//   SSE 事件: rpc.perf.guard.warning（含 script.alert）

export const RPC_ID = "perf.guard"

const loose = { type: "object", additionalProperties: true } as const

export const PerfGuard = {
  id: RPC_ID,
  methods: {
    status: {
      input: { type: "object", additionalProperties: false, properties: { force: { type: "boolean" } } },
      output: loose,
    },
    cleanup: {
      input: {
        type: "object",
        additionalProperties: false,
        properties: {
          target: { type: "string", description: "all-mcp | orphans | 分类名（如 jshook / memory）" },
          dryRun: { type: "boolean" },
        },
      },
      output: loose,
    },
    scripts: {
      input: { type: "object", additionalProperties: false, properties: { evaluate: { type: "boolean" } } },
      output: loose,
    },
    scriptKill: {
      input: {
        type: "object",
        additionalProperties: false,
        properties: { pid: { type: "number" } },
        required: ["pid"],
      },
      output: loose,
    },
    scriptKeep: {
      input: {
        type: "object",
        additionalProperties: false,
        properties: { pid: { type: "number" }, minutes: { type: "number" } },
        required: ["pid"],
      },
      output: loose,
    },
    scriptNice: {
      input: {
        type: "object",
        additionalProperties: false,
        properties: { pid: { type: "number" }, level: { type: "string" } },
        required: ["pid"],
      },
      output: loose,
    },
  },
  events: {
    warning: { schema: loose },
  },
} as const

export type PerfGuardDefinition = typeof PerfGuard
