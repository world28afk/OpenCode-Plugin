// Bark 推送客户端。
//
// 文档: https://bark.day.app/#/
//   - URL 组成:      /:key/:title/:body
//   - POST 端点:     {server}/push    (JSON 请求体)
//   - 批量推送:      "device_keys": ["key1", "key2", ...]  (bark-server v2.1.9+; api.day.app 单次 ≤10 台)
//
// 本模块只负责「组装 + 发送 + 解析结果」, 不发散其它副作用, 便于单测。

export interface BarkPushConfig {
  /** 服务器地址, 如 https://api.day.app (自建亦可); 可带完整 /push 端点 */
  server: string
  /** 设备 Key 列表 */
  deviceKeys: readonly string[]
  /** 推送分组 (Bark App 内聚合展示) */
  group?: string
  /** Bark 端铃声 (如 minuet / alarm); 留空使用 Bark 默认 */
  sound?: string
  /** active | timeSensitive | passive | critical */
  level?: string
  /** 推送图标 URL */
  icon?: string
  /** 点按推送跳转的 URL */
  url?: string
  timeoutMs?: number
}

export interface BarkPushResult {
  ok: boolean
  /** 实际请求的推送端点 */
  url: string
  /** HTTP 状态码 */
  status?: number
  /** Bark 业务码 (200 为成功) */
  code?: number
  message: string
  at: number
  response?: unknown
}

export const DEFAULT_TIMEOUT_MS = 8_000

/** 归一化推送端点: 去掉尾部斜杠并补 `/push`; 已以 /push 结尾则原样。 */
export function normalizePushUrl(server: string): string {
  const value = typeof server === "string" ? server.trim().replace(/\/+$/, "") : ""
  if (!value) return ""
  return /\/push$/i.test(value) ? value : `${value}/push`
}

/** 清洗 Key: 支持逗号/分号/空白分隔的字符串或数组, 去重保序。 */
export function normalizeDeviceKeys(value: unknown): string[] {
  const raw: string[] = []
  if (typeof value === "string") {
    raw.push(...value.split(/[,;\s]+/))
  } else if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string") raw.push(item)
      else if (Array.isArray(item)) raw.push(...item.filter((entry): entry is string => typeof entry === "string"))
    }
  }
  const seen = new Set<string>()
  const keys: string[] = []
  for (const key of raw) {
    const trimmed = key.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    keys.push(trimmed)
  }
  return keys
}

/** 组装 POST /push 的 JSON 体。 */
export function buildPushPayload(
  config: Pick<BarkPushConfig, "deviceKeys" | "group" | "sound" | "level" | "icon" | "url">,
  message: { title: string; body: string; subtitle?: string },
): Record<string, unknown> {
  const payload: Record<string, unknown> = { title: message.title, body: message.body }
  if (typeof message.subtitle === "string" && message.subtitle.trim()) payload.subtitle = message.subtitle.trim()

  const keys = normalizeDeviceKeys(config.deviceKeys)
  if (keys.length === 1) payload.device_key = keys[0]
  else if (keys.length > 1) payload.device_keys = keys

  const optional: Array<[string, unknown]> = [
    ["group", config.group],
    ["sound", config.sound],
    ["level", config.level],
    ["icon", config.icon],
    ["url", config.url],
  ]
  for (const [key, value] of optional) {
    if (typeof value === "string" && value.trim()) payload[key] = value.trim()
  }
  return payload
}

export interface SendOptions {
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/** POST {server}/push; 任何异常都折叠为 { ok:false, message } 结果, 不向上抛。 */
export async function sendBarkPush(
  config: BarkPushConfig,
  payload: Record<string, unknown>,
  options: SendOptions = {},
): Promise<BarkPushResult> {
  const url = normalizePushUrl(config.server)
  const at = Date.now()
  if (!url) {
    return { ok: false, url: "", message: "未配置 Bark 服务器地址 (server)", at }
  }
  if (payload.device_key === undefined && payload.device_keys === undefined) {
    return { ok: false, url, message: "未配置 Bark Device Key (deviceKey/deviceKeys)", at }
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== "function") {
    return { ok: false, url, message: "当前运行时没有可用的 fetch", at }
  }

  const timeoutMs = Math.max(500, options.timeoutMs ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    const text = await response.text().catch(() => "")
    let json: unknown
    try {
      json = text ? JSON.parse(text) : undefined
    } catch {
      json = undefined
    }
    const code = typeof (json as { code?: unknown } | undefined)?.code === "number" ? (json as { code: number }).code : undefined
    const ok = response.ok && (code === undefined || code === 200)
    const message =
      typeof (json as { message?: unknown } | undefined)?.message === "string"
        ? ((json as { message: string }).message)
        : text.trim() || response.statusText || (ok ? "ok" : `HTTP ${response.status}`)
    return {
      ok,
      url,
      status: response.status,
      ...(code !== undefined ? { code } : {}),
      message,
      at,
      ...(json !== undefined ? { response: json } : {}),
    }
  } catch (error) {
    const reason =
      error instanceof Error
        ? error.name === "AbortError"
          ? `推送超时 (${timeoutMs}ms)`
          : error.message
        : String(error)
    return { ok: false, url, message: reason, at }
  } finally {
    clearTimeout(timer)
  }
}
