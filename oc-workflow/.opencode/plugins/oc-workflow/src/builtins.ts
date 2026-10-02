// 内置 workflow — 移植自 dsh_workflow 的产品能力（独立实现）:
//   • parallel-investigation: 多角度并行调查 → 汇总
//   • scoped-review:          捕获 git diff → 双评审员 → 复核 → 报告
//   • fan-out-and-synthesize: 通用扇出-汇总模板

import { CAPSULE_VERSION, type Capsule } from "./capsule"

export function parallelInvestigation(): Capsule {
  return {
    version: CAPSULE_VERSION,
    name: "parallel-investigation",
    intent: "把一个问题并行拆给多个调查员（事实/反例/影响面），汇总为可复核结论。",
    description: "多角度并行调查并汇总",
    inputs: {
      question: { type: "string", required: true, description: "要调查的问题" },
      concurrency: { type: "number", default: 3, description: "并行度" },
    },
    limits: { maxAgents: 8, maxConcurrency: 3 },
    steps: [
      { type: "phase", name: "investigate" },
      {
        type: "parallel",
        concurrency: 3,
        tasks: [
          {
            id: "facts",
            readOnly: true,
            prompt:
              "你是一名并行调查员（角度: 事实与证据）。\n问题: {{inputs.question}}\n\n请只输出: 结论清单 + 每条结论的证据（文件:行号 / 命令输出 / 引用）。不要臆测。",
          },
          {
            id: "counter",
            readOnly: true,
            prompt:
              "你是一名并行调查员（角度: 反例与边界条件）。\n问题: {{inputs.question}}\n\n请专门寻找: 反例、边界条件、与主流结论矛盾的证据、可能的误判来源。输出: 发现 + 证据 + 可信度。",
          },
          {
            id: "impact",
            readOnly: true,
            prompt:
              "你是一名并行调查员（角度: 影响面与回归风险）。\n问题: {{inputs.question}}\n\n请评估: 涉及模块、调用链、回归风险、需要补的测试。输出: 影响清单 + 风险评级 + 验证建议。",
          },
        ],
      },
      { type: "phase", name: "synthesize" },
      {
        type: "synthesize",
        id: "final",
        from: ["facts", "counter", "impact"],
        prompt:
          "你是调查负责人。请综合三路调查结果，处理互相矛盾的结论（以证据为准），输出最终报告:\n1. 结论（按可信度排序）\n2. 关键证据\n3. 未决问题与建议的下一步验证\n\n=== 事实 ===\n{{steps.facts.output}}\n\n=== 反例 ===\n{{steps.counter.output}}\n\n=== 影响面 ===\n{{steps.impact.output}}",
      },
      { type: "artifact", name: "report.md", from: "final" },
    ],
  }
}

export function scopedReview(): Capsule {
  return {
    version: CAPSULE_VERSION,
    name: "scoped-review",
    intent: "对当前 Git 工作区范围做双评审 + 复核的分区审查，产出分级报告。",
    description: "捕获 diff → 双评审 → 复核报告",
    inputs: {
      requirement: { type: "string", description: "需求/约束（例如: 不得破坏公开 API）" },
      testEvidence: { type: "string", description: "测试证据（例如: bun test 全绿）" },
    },
    limits: { maxAgents: 8, maxConcurrency: 2 },
    steps: [
      { type: "phase", name: "capture" },
      { type: "capture", id: "diff-stat", command: "git diff --stat" },
      { type: "capture", id: "diff-full", command: "git diff", maxLength: 60000 },
      { type: "phase", name: "review" },
      {
        type: "parallel",
        concurrency: 2,
        tasks: [
          {
            id: "correctness",
            readOnly: true,
            prompt:
              "你是一名代码正确性评审员。\n需求/约束: {{inputs.requirement}}\n\n请审查以下 diff: 正确性、边界条件、错误处理、与需求的一致性。\n每条发现给出: 严重度(blocker/major/minor) + 位置 + 证据 + 修复建议。\n\n=== diff stat ===\n{{steps.diff-stat.output}}\n\n=== diff ===\n{{steps.diff-full.output}}",
          },
          {
            id: "risk",
            readOnly: true,
            prompt:
              "你是一名风险与回归评审员。\n请审查以下 diff: 回归风险、安全、性能、并发、兼容性、缺失测试。\n每条发现给出: 严重度(blocker/major/minor) + 位置 + 证据 + 修复建议。\n\n=== diff stat ===\n{{steps.diff-stat.output}}\n\n=== diff ===\n{{steps.diff-full.output}}",
          },
        ],
      },
      { type: "phase", name: "verify" },
      {
        type: "synthesize",
        id: "final",
        from: ["correctness", "risk"],
        prompt:
          "你是审查负责人。请复核两位评审员的发现: 剔除无证据/误报，合并重复项，按严重度排序。\n需求/约束: {{inputs.requirement}}\n测试证据: {{inputs.testEvidence}}\n\n输出格式:\n# 审查报告\n## 结论（是否可合入 + 理由）\n## 发现（按严重度分级, 含证据与修复建议）\n## 未覆盖/建议补充验证\n\n=== 正确性评审 ===\n{{steps.correctness.output}}\n\n=== 风险评审 ===\n{{steps.risk.output}}",
      },
      { type: "artifact", name: "review.md", from: "final" },
    ],
  }
}

export function fanOutAndSynthesize(): Capsule {
  return {
    version: CAPSULE_VERSION,
    name: "fan-out-and-synthesize",
    intent: "通用扇出-汇总模板: 把主题拆成 N 个子任务并行处理，再汇总。",
    description: "通用扇出-汇总模板",
    inputs: {
      topic: { type: "string", required: true, description: "主题/目标" },
      subtasks: { type: "json", required: true, description: "子任务列表（字符串数组）" },
      concurrency: { type: "number", default: 3 },
    },
    limits: { maxAgents: 16, maxConcurrency: 4 },
    steps: [
      { type: "phase", name: "fan-out" },
      {
        type: "parallel",
        concurrency: 3,
        tasks: [
          {
            id: "task-1",
            readOnly: true,
            prompt: "子任务 1（主题: {{inputs.topic}}）: {{inputs.subtasks}}\n请独立完成并输出结构化结果 + 证据。",
          },
        ],
      },
      { type: "phase", name: "synthesize" },
      {
        type: "synthesize",
        id: "final",
        from: ["task-1"],
        prompt: "请把所有子任务结果汇总为最终交付物（去重、解决矛盾、给出结论）:\n\n{{steps.task-1.output}}",
      },
    ],
  }
}

export function builtinCapsules(): Capsule[] {
  return [parallelInvestigation(), scopedReview(), fanOutAndSynthesize()]
}
