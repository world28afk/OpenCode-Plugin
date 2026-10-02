// Capsule v1 — 工作流定义（JSON DSL）与校验。
//
// 版本: oc.workflow/v1
// 步骤类型: phase | agent | parallel | synthesize | capture | artifact | log
//   - agent:       单个子代理任务
//   - parallel:    并行任务组（自带并发上限）
//   - synthesize:  汇总/综合（本质是一个带 from 依赖的 agent）
//   - capture:     受限本地命令（仅允许 git 前缀）, 用于抓取 diff 等证据
//   - artifact:    把某步骤输出落盘为 run 目录内的证据文件
//   - log:         运行日志

import { slug } from "./util"

export const CAPSULE_VERSION = "oc.workflow/v1"

export interface ModelRef {
  readonly providerID: string
  readonly id: string
  readonly variant?: string
}

export interface InputSpec {
  readonly type?: "string" | "number" | "boolean" | "json"
  readonly required?: boolean
  readonly default?: unknown
  readonly description?: string
}

export interface TaskSpec {
  readonly id: string
  readonly prompt: string
  readonly agent?: string
  readonly model?: ModelRef
  readonly readOnly?: boolean
  readonly title?: string
}

export type Step =
  | { readonly type: "phase"; readonly name: string }
  | { readonly type: "agent"; readonly id: string; readonly prompt: string; readonly agent?: string; readonly model?: ModelRef; readonly readOnly?: boolean }
  | { readonly type: "parallel"; readonly id?: string; readonly concurrency?: number; readonly tasks: readonly TaskSpec[] }
  | { readonly type: "synthesize"; readonly id: string; readonly prompt: string; readonly from?: readonly string[]; readonly agent?: string; readonly model?: ModelRef }
  | { readonly type: "capture"; readonly id: string; readonly command: string; readonly maxLength?: number }
  | { readonly type: "artifact"; readonly name: string; readonly from: string }
  | { readonly type: "log"; readonly message: string }

export interface Capsule {
  readonly version: string
  readonly name: string
  readonly intent?: string
  readonly description?: string
  readonly inputs?: Record<string, InputSpec>
  readonly limits?: { readonly maxAgents?: number; readonly maxConcurrency?: number }
  readonly steps: readonly Step[]
}

export type ValidationResult = { readonly ok: true; readonly value: Capsule } | { readonly ok: false; readonly errors: readonly string[] }

const STEP_TYPES = new Set(["phase", "agent", "parallel", "synthesize", "capture", "artifact", "log"])
const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i
const ALLOWED_CAPTURE = /^git(\s|$)/

export function validateCapsule(input: unknown): ValidationResult {
  const errors: string[] = []
  if (!input || typeof input !== "object") return { ok: false, errors: ["capsule 必须是对象"] }
  const capsule = input as Record<string, unknown>

  if (capsule.version !== CAPSULE_VERSION) errors.push(`version 必须为 ${CAPSULE_VERSION}`)
  if (typeof capsule.name !== "string" || !NAME_RE.test(capsule.name)) errors.push("name 缺失或不符合 [a-z0-9._-] 规则")
  if (!Array.isArray(capsule.steps) || capsule.steps.length === 0) errors.push("steps 必须是非空数组")

  const ids = new Set<string>()
  const claim = (id: unknown, where: string) => {
    if (typeof id !== "string" || !NAME_RE.test(id)) {
      errors.push(`${where}: id 缺失或非法`)
      return
    }
    if (ids.has(id)) errors.push(`${where}: id 重复 (${id})`)
    ids.add(id)
  }

  if (Array.isArray(capsule.steps)) {
    capsule.steps.forEach((raw, index) => {
      const step = raw as Record<string, unknown>
      const where = `steps[${index}]`
      if (!step || typeof step !== "object" || typeof step.type !== "string" || !STEP_TYPES.has(step.type)) {
        errors.push(`${where}: 未知步骤类型`)
        return
      }
      switch (step.type) {
        case "phase":
          if (typeof step.name !== "string" || !step.name.trim()) errors.push(`${where}: phase.name 缺失`)
          break
        case "agent":
          claim(step.id, where)
          if (typeof step.prompt !== "string" || !step.prompt.trim()) errors.push(`${where}: agent.prompt 缺失`)
          break
        case "parallel": {
          if (!Array.isArray(step.tasks) || step.tasks.length === 0) {
            errors.push(`${where}: parallel.tasks 必须是非空数组`)
            break
          }
          if (step.concurrency !== undefined && (typeof step.concurrency !== "number" || step.concurrency < 1)) {
            errors.push(`${where}: parallel.concurrency 必须是 >=1 的数字`)
          }
          step.tasks.forEach((rawTask, taskIndex) => {
            const task = rawTask as Record<string, unknown>
            const taskWhere = `${where}.tasks[${taskIndex}]`
            claim(task?.id, taskWhere)
            if (typeof task?.prompt !== "string" || !task.prompt.trim()) errors.push(`${taskWhere}: prompt 缺失`)
          })
          break
        }
        case "synthesize":
          claim(step.id, where)
          if (typeof step.prompt !== "string" || !step.prompt.trim()) errors.push(`${where}: synthesize.prompt 缺失`)
          if (step.from !== undefined && (!Array.isArray(step.from) || step.from.some((item) => typeof item !== "string"))) {
            errors.push(`${where}: synthesize.from 必须是字符串数组`)
          }
          break
        case "capture":
          claim(step.id, where)
          if (typeof step.command !== "string" || !ALLOWED_CAPTURE.test(step.command)) {
            errors.push(`${where}: capture.command 仅允许 git 前缀命令`)
          }
          break
        case "artifact":
          if (typeof step.name !== "string" || !slug(step.name)) errors.push(`${where}: artifact.name 缺失`)
          if (typeof step.from !== "string") errors.push(`${where}: artifact.from 缺失`)
          break
        case "log":
          if (typeof step.message !== "string") errors.push(`${where}: log.message 缺失`)
          break
      }
    })
  }

  if (errors.length) return { ok: false, errors }
  return { ok: true, value: input as Capsule }
}

export interface InputResolution {
  readonly values: Record<string, unknown>
  readonly errors: string[]
}

export function resolveInputs(capsule: Capsule, raw: Record<string, unknown> | undefined): InputResolution {
  const values: Record<string, unknown> = {}
  const errors: string[] = []
  const provided = raw ?? {}
  for (const [name, spec] of Object.entries(capsule.inputs ?? {})) {
    const value = provided[name] ?? spec.default
    if (value === undefined) {
      if (spec.required) errors.push(`缺少必填输入: ${name}`)
      continue
    }
    const type = spec.type ?? "string"
    const actual = typeof value
    const ok =
      type === "json" ? true : type === "number" ? actual === "number" : type === "boolean" ? actual === "boolean" : actual === "string"
    if (!ok) errors.push(`输入 ${name} 类型应为 ${type}`)
    else values[name] = value
  }
  return { values, errors }
}
