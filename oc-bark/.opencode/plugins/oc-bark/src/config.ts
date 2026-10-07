// 配置解析 —— 三种来源, 优先级: 插件 options > 环境变量 > 配置文件。
//
//   1. opencode.jsonc:  { "plugin": [{ "package": "oc-bark", "options": { ... } }] }
//   2. 环境变量:        OC_BARK_SERVER / OC_BARK_DEVICE_KEY(S) / OC_BARK_CONFIG(配置文件路径)
//   3. 配置文件:        ~/.config/opencode/oc-bark.json  (schema 与 options 相同)
//
// 本模块无副作用 (文件读取可注入), 便于单测。

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { normalizeDeviceKeys } from "./bark"
import {
  DEFAULT_ERROR_TEMPLATE,
  DEFAULT_ERROR_TITLE,
  DEFAULT_PERMISSION_TEMPLATE,
  DEFAULT_PERMISSION_TITLE,
  DEFAULT_TEMPLATE,
  DEFAULT_TITLE,
} from "./format"

export interface ResolvedConfig {
  /** 显式 enabled=false 时整个插件停用 */
  enabled: boolean
  /** server + deviceKey 是否齐备 */
  configured: boolean
  server: string
  deviceKeys: string[]
  group?: string
  sound?: string
  level?: string
  icon?: string
  url?: string
  title: string
  /** 推送标题用会话标题 (默认 true; false 时用 title/errorTitle/permissionTitle) */
  titleFromSession: boolean
  template: string
  errorTitle: string
  errorTemplate: string
  permissionTitle: string
  permissionTemplate: string
  notifyOnError: boolean
  notifyOnPermission: boolean
  notifyChildSessions: boolean
  minDurationMs: number
  maxTaskChars: number
  timeoutMs: number
  /** 生效的配置来源 (用于 bark_status 诊断) */
  source: "options" | "env" | "file" | "none"
  configPath: string
  problems: string[]
}

export interface ResolveInput {
  options?: Record<string, unknown>
  env?: Record<string, string | undefined>
  file?: Record<string, unknown>
  configPath?: string
}

const CONFIG_FILE_NAME = "oc-bark.json"

export function defaultConfigPath(home: string = homedir()): string {
  return join(home, ".config", "opencode", CONFIG_FILE_NAME)
}

/** 读取并解析配置文件; 不抛错, 文件缺失/损坏时返回 undefined。 */
export function loadFileConfig(
  filePath: string,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): Record<string, unknown> | undefined {
  if (!filePath) return undefined
  try {
    const raw = readFile(filePath)
    if (!raw || !raw.trim()) return undefined
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

function firstDefined(...values: unknown[]): unknown {
  for (const value of values) {
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase()
    if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true
    if (["0", "false", "no", "off", "disabled"].includes(normalized)) return false
  }
  return fallback
}

function asNumber(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, numeric))
}

export function resolveConfig(input: ResolveInput = {}): ResolvedConfig {
  const options = input.options ?? {}
  const env = input.env ?? {}
  const file = input.file ?? {}
  const configPath = input.configPath ?? ""

  const problems: string[] = []

  // ── 来源判定 (任一侧提供即为该来源) ────────────────────────────────────────
  const optionKeys = normalizeDeviceKeys(firstDefined(options.deviceKeys, options.deviceKey))
  const envKeys = normalizeDeviceKeys(firstDefined(env.OC_BARK_DEVICE_KEYS, env.OC_BARK_DEVICE_KEY))
  const fileKeys = normalizeDeviceKeys(firstDefined(file.deviceKeys, file.deviceKey))
  const optionsTouched = firstString(options.server) !== undefined || optionKeys.length > 0
  const envTouched = firstString(env.OC_BARK_SERVER) !== undefined || envKeys.length > 0
  const fileTouched = firstString(file.server) !== undefined || fileKeys.length > 0
  const source: ResolvedConfig["source"] = optionsTouched ? "options" : envTouched ? "env" : fileTouched ? "file" : "none"

  const server = firstString(options.server, env.OC_BARK_SERVER, file.server) ?? ""
  const deviceKeys =
    optionKeys.length > 0 ? optionKeys : envKeys.length > 0 ? envKeys : fileKeys.length > 0 ? fileKeys : []

  const enabled = asBoolean(firstDefined(options.enabled, env.OC_BARK_ENABLED, file.enabled), true)
  const configured = server.length > 0 && deviceKeys.length > 0

  if (enabled && !server) problems.push(`缺少 Bark 服务器地址 (server); 可写入 ${configPath || "~/.config/opencode/oc-bark.json"}`)
  if (enabled && deviceKeys.length === 0) problems.push("缺少设备 Key (deviceKey 或 deviceKeys)")
  if (server && !/^https?:\/\//i.test(server)) problems.push(`server 需要是 http(s) 绝对地址: ${server}`)
  if (deviceKeys.length > 10) {
    let host = ""
    try {
      host = new URL(server).hostname
    } catch {
      host = ""
    }
    if (host === "api.day.app") problems.push("api.day.app 公共服务器单次最多 10 台设备 (超出建议自建或分批)")
  }

  return {
    enabled,
    configured,
    server,
    deviceKeys,
    group: firstString(options.group, env.OC_BARK_GROUP, file.group),
    sound: firstString(options.sound, env.OC_BARK_SOUND, file.sound),
    level: firstString(options.level, env.OC_BARK_LEVEL, file.level),
    icon: firstString(options.icon, file.icon),
    url: firstString(options.url, file.url),
    title: firstString(options.title, file.title) ?? DEFAULT_TITLE,
    titleFromSession: asBoolean(firstDefined(options.titleFromSession, file.titleFromSession), true),
    template: firstString(options.template, file.template) ?? DEFAULT_TEMPLATE,
    errorTitle: firstString(options.errorTitle, file.errorTitle) ?? DEFAULT_ERROR_TITLE,
    errorTemplate: firstString(options.errorTemplate, file.errorTemplate) ?? DEFAULT_ERROR_TEMPLATE,
    permissionTitle: firstString(options.permissionTitle, file.permissionTitle) ?? DEFAULT_PERMISSION_TITLE,
    permissionTemplate: firstString(options.permissionTemplate, file.permissionTemplate) ?? DEFAULT_PERMISSION_TEMPLATE,
    notifyOnError: asBoolean(firstDefined(options.notifyOnError, file.notifyOnError), true),
    notifyOnPermission: asBoolean(firstDefined(options.notifyOnPermission, file.notifyOnPermission), true),
    notifyChildSessions: asBoolean(firstDefined(options.notifyChildSessions, file.notifyChildSessions), false),
    minDurationMs: asNumber(firstDefined(options.minDurationMs, file.minDurationMs), 0, 0, 24 * 3600_000),
    maxTaskChars: asNumber(firstDefined(options.maxTaskChars, file.maxTaskChars), 100, 8, 1000),
    timeoutMs: asNumber(firstDefined(options.timeoutMs, file.timeoutMs), 8_000, 500, 60_000),
    source,
    configPath,
    problems,
  }
}
