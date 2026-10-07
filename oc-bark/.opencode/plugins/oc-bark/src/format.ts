// 文案与格式化 — 纯函数, 可单测。
//
// 默认推送文案 (与需求一致):
//   关于‘<我的任务内容>’任务目前已完成，历时<分钟>分钟
//
// 例: 关于‘修复登录接口的空指针’任务目前已完成，历时3.4分钟

export const DEFAULT_TEMPLATE = "关于‘{task}’任务目前已完成，历时{minutes}分钟"
export const DEFAULT_ERROR_TEMPLATE = "关于‘{task}’任务执行失败，历时{minutes}分钟"
export const DEFAULT_PERMISSION_TEMPLATE = "关于‘{task}’任务需要授权：{detail}"
export const DEFAULT_TITLE = "OpenCode 任务完成"
export const DEFAULT_ERROR_TITLE = "OpenCode 任务失败"
export const DEFAULT_PERMISSION_TITLE = "OpenCode 需要授权"
const DEFAULT_PERMISSION_DETAIL = "请打开 OpenCode 处理"

/**
 * 折叠空白并截断任务文本。
 * - 换行/制表/连续空格 → 单个空格 (Bark 正文单行更易读)
 * - 按 **字符** (而非 UTF-16 码元) 截断, 不会切开 emoji/代理对
 */
export function condenseTask(text: unknown, maxChars = 100): string {
  if (typeof text !== "string") return ""
  let value = text.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim()
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 0
  if (limit <= 0) return value
  const chars = Array.from(value)
  if (chars.length > limit) value = `${chars.slice(0, limit).join("").trimEnd()}…`
  return value
}

/**
 * 分钟数文案:
 * - 不足 1 分钟 → "不到1"
 * - 1 ~ 10 分钟 → 一位小数 (整数则省略小数位), 如 "3.4" / "5"
 * - 10 分钟以上 → 取整, 如 "42"
 */
export function formatMinutes(durationMs: number): string {
  const ms = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0
  if (ms < 60_000) return "不到1"
  const minutes = ms / 60_000
  if (minutes < 10) {
    const rounded = Math.round(minutes * 10) / 10
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
  }
  return String(Math.round(minutes))
}

/** `{token}` 占位替换; 未提供的 token 原样保留。 */
export function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? (values[key] as string) : match))
}

export interface BodyInput {
  /** 用户发的任务内容 (prompt 原文) */
  task?: string
  /** 任务内容缺失时的兜底 (如会话标题) */
  fallbackTask?: string
  durationMs: number
  /** 自定义模板, 支持 {task} / {minutes} */
  template?: string
  /** 任务文本截断长度, 默认 100 字符 */
  maxTaskChars?: number
}

function renderBody(template: string, input: BodyInput): string {
  const maxChars = typeof input.maxTaskChars === "number" ? input.maxTaskChars : 100
  const task = condenseTask(input.task, maxChars) || condenseTask(input.fallbackTask, maxChars) || "未记录任务"
  const minutes = formatMinutes(input.durationMs)
  return renderTemplate(template.trim() || DEFAULT_TEMPLATE, { task, minutes })
}

export function buildCompletionBody(input: BodyInput): string {
  return renderBody(input.template ?? DEFAULT_TEMPLATE, input)
}

export function buildErrorBody(input: BodyInput): string {
  return renderBody(input.template ?? DEFAULT_ERROR_TEMPLATE, input)
}

export interface PermissionBodyInput {
  /** 用户发的任务内容 (prompt 原文) */
  task?: string
  /** 任务内容缺失时的兜底 (如会话标题) */
  fallbackTask?: string
  /** 权限请求详情 (permission.asked 的 message / action / resources) */
  detail?: string
  /** 自定义模板, 支持 {task} / {detail} */
  template?: string
  maxTaskChars?: number
}

/** 授权请求文案: 关于‘<任务>’任务需要授权：<详情> */
export function buildPermissionBody(input: PermissionBodyInput): string {
  const maxChars = typeof input.maxTaskChars === "number" ? input.maxTaskChars : 100
  const task = condenseTask(input.task, maxChars) || condenseTask(input.fallbackTask, maxChars) || "未记录任务"
  const detail = condenseTask(input.detail, maxChars) || DEFAULT_PERMISSION_DETAIL
  const template = (input.template ?? DEFAULT_PERMISSION_TEMPLATE).trim() || DEFAULT_PERMISSION_TEMPLATE
  return renderTemplate(template, { task, detail })
}
