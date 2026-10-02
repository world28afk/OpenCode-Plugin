// 模板插值: {{inputs.NAME}} 与 {{steps.ID.output}}
// 缺失引用不会抛错, 但会收集进 missing 供引擎告警。

export interface InterpolationScope {
  readonly inputs: Record<string, unknown>
  readonly steps: Record<string, { readonly output?: string | null } | undefined>
}

export interface InterpolationResult {
  readonly text: string
  readonly missing: string[]
}

const PATTERN = /\{\{\s*(inputs|steps)\.([a-zA-Z0-9._-]+?)(?:\.(output))?\s*\}\}/g

export function interpolate(template: string, scope: InterpolationScope): InterpolationResult {
  const missing: string[] = []
  const text = template.replace(PATTERN, (match, kind: string, name: string, output: string | undefined) => {
    if (kind === "inputs") {
      const value = scope.inputs[name]
      if (value === undefined) {
        missing.push(match)
        return match
      }
      return typeof value === "string" ? value : JSON.stringify(value)
    }
    const step = scope.steps[name]
    const value = step?.output
    if (value === undefined || value === null) {
      missing.push(match)
      return match
    }
    return value
  })
  return { text, missing }
}

export function hasTemplate(template: string): boolean {
  return PATTERN.test(template)
}
