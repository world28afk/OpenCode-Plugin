// RPC 契约 — workflow.engine
//   list / runs / start / show / pause / resume / stop / rerun / resumeRun / prune
//   SSE 事件: rpc.workflow.engine.run（状态更新）

export const RPC_ID = "workflow.engine"

const loose = { type: "object", additionalProperties: true } as const

export const WorkflowEngineRpc = {
  id: RPC_ID,
  methods: {
    list: { input: { type: "object", additionalProperties: false, properties: {} }, output: loose },
    runs: {
      input: { type: "object", additionalProperties: false, properties: { limit: { type: "number" } } },
      output: loose,
    },
    start: {
      input: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          capsule: { type: "object", additionalProperties: true },
          inputs: { type: "object", additionalProperties: true },
          wait: { type: "boolean" },
        },
      },
      output: loose,
    },
    show: {
      input: { type: "object", additionalProperties: false, properties: { runId: { type: "string" } }, required: ["runId"] },
      output: loose,
    },
    pause: {
      input: { type: "object", additionalProperties: false, properties: { runId: { type: "string" } }, required: ["runId"] },
      output: loose,
    },
    resume: {
      input: { type: "object", additionalProperties: false, properties: { runId: { type: "string" } }, required: ["runId"] },
      output: loose,
    },
    stop: {
      input: { type: "object", additionalProperties: false, properties: { runId: { type: "string" } }, required: ["runId"] },
      output: loose,
    },
    rerun: {
      input: {
        type: "object",
        additionalProperties: false,
        properties: { runId: { type: "string" }, name: { type: "string" }, inputs: { type: "object", additionalProperties: true }, wait: { type: "boolean" } },
      },
      output: loose,
    },
    resumeRun: {
      input: { type: "object", additionalProperties: false, properties: { runId: { type: "string" } }, required: ["runId"] },
      output: loose,
    },
    prune: {
      input: { type: "object", additionalProperties: false, properties: { keep: { type: "number" } } },
      output: loose,
    },
  },
  events: {
    run: { schema: loose },
  },
} as const

export type WorkflowEngineDefinition = typeof WorkflowEngineRpc
