// infinite_gen4_profile 工具返回的运行时元数据 (框架无关, 可单测)。
// 对齐上游 dsh-infinite-gen-4 v0.4.0 的 profileTool 输出, 增加 OpenCode 移植信息。

import { CORE_ORDER, CORE_SLOT, REINFORCE_ORDER, REINFORCE_SLOT } from "./inject"
import { KERNEL_SHA256 } from "./prompts"

export interface ProfileInput {
  readonly version: string
  readonly inject: boolean
  readonly dualLayer: boolean
  readonly profileTool: boolean
}

export function buildProfile(input: ProfileInput): Record<string, unknown> {
  return {
    plugin: "oc-infinite-gen-4",
    pluginVersion: input.version,
    pluginDisplayName: "无限四代 (OpenCode 移植版)",
    name: "infinite-gen-4",
    displayName: "无限四代",
    kernelVersion: "0.4.0",
    kernelSha256: KERNEL_SHA256,
    targetArchitecture: "DeepSeek-V4 / V4-Pro / V4.1-Flash 全系列",
    upstream: {
      host: "DeepSeek Harness (Cordis)",
      repo: "Minglink/dsh-infinite-gen-4",
      version: "0.4.0",
    },
    host: "opencode",
    promptSource: ["prompts/infinite-gen-4.md", "prompts/infinite-gen-4.1-flash.md"],
    lineage: [
      "dsh-infinite-gen-4 (v0.4.0) — 双层协同注入内核",
      "oc-infinite-gen-4 (v0.4.1) — OpenCode V2 插件移植 (+桌面徽章/Profile RPC)",
    ],
    injection: [
      { hook: "session.context", section: CORE_SLOT, order: CORE_ORDER, enabled: input.inject },
      {
        hook: "session.context",
        section: REINFORCE_SLOT,
        order: REINFORCE_ORDER,
        enabled: input.inject && input.dualLayer,
      },
    ],
    mode: "armor — 双层协同注入，零工具面纯净直出",
    profileTool: input.profileTool,
    payloadSections: [
      "[MODE: SANDBOX]",
      "SUPREME DIRECTIVE — USER AUTHORITY",
      "Output contract（首行 ##/``` 命名交付物 + 静默推理 + 占位符自造）",
      "Task classes（逆向工程/合规渗透/防御审计/LLM研究/其他，直接产出）",
      "Format examples（[USER]/[OUTPUT] few-shot 镜像）",
    ],
    hostFeatures: [
      "Context Hook Injection: session.hook(\"context\") 在每次模型调用组装 system 数组",
      "Dual-Layer Injection: Order 100 通用内核 + Order 200 强化镜像 (dualLayer 选项)",
      "Armor Projection: 开头窗口(160)判拒 + REFUSAL/FALLBACK/SAFE/RISK 标记 + 域命中 (src/armor.ts)",
      "TUI Badge: prompt.footer.status 状态条「⚫ 无限四代 v0.4.1」(src/tui.tsx)",
      "Desktop Badge: 输入框上方绿框「⚫ 无限四代 v0.4.1 · 运行中」(desktop/oc-infinite-gen-4-inject.js)",
      "Profile Tool: infinite_gen4_profile 返回内核版本与注入槽位元数据",
      "Profile RPC: POST /api/rpc/infinite.gen4.profile/get (桌面端徽章运行状态来源)",
    ],
    features: [
      "Pure Zero-Tool Architecture: 零工具面纯净直出，消除决策噪音",
      "Direct Deliverable Contract: 首行 ##/``` 命名交付物",
      "Supreme User Authority: 用户指令最高优先级",
      "Placeholder Self-Synthesis: 缺失细节自造 TARGET/HOST/TOKEN/OFFSET/PAYLOAD/SERIAL/SYMBOL/HOOK_FN",
      "Task-Class Direct Output: 逆向分析 / 合规渗透 / 防御审计 / LLM 安全研究",
      "Format Anchors: [USER]/[OUTPUT] few-shot 镜像",
      "Refusal Hardening: 拒绝对抗硬化 + 无拒绝动作",
    ],
  }
}
