// DeepSeek 余额 API 客户端。
// 文档: https://api-docs.deepseek.com/zh-cn/api/get-user-balance
//   GET /user/balance   Authorization: Bearer <API Key>
//   200: { is_available: boolean, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }

export const DEFAULT_BASE_URL = "https://api.deepseek.com"
export const BALANCE_PATH = "/user/balance"

export interface BalanceInfo {
  readonly currency: string
  readonly total_balance: string
  readonly granted_balance: string
  readonly topped_up_balance: string
}

export interface BalanceResponse {
  readonly is_available: boolean
  readonly balance_infos: readonly BalanceInfo[]
}

export interface FetchBalanceOptions {
  readonly baseURL?: string
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

/** 归一化 baseURL: 允许传入 https://api.deepseek.com/v1 这类 OpenAI 兼容端点。 */
export function balanceURL(baseURL: string | undefined): string {
  const base = (baseURL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "").replace(/\/v\d+$/, "")
  return `${base}${BALANCE_PATH}`
}

function isBalanceInfo(value: unknown): value is BalanceInfo {
  if (!value || typeof value !== "object") return false
  const info = value as Record<string, unknown>
  return typeof info.currency === "string" && typeof info.total_balance === "string"
}

export function parseBalanceResponse(value: unknown): BalanceResponse {
  if (!value || typeof value !== "object") throw new Error("余额响应格式错误: 不是对象")
  const record = value as Record<string, unknown>
  const infos = Array.isArray(record.balance_infos) ? record.balance_infos.filter(isBalanceInfo) : []
  return {
    is_available: record.is_available === true,
    balance_infos: infos,
  }
}

/** 查询余额; 非 2xx 抛出带状态码的错误。 */
export async function fetchBalance(apiKey: string, options: FetchBalanceOptions = {}): Promise<BalanceResponse> {
  const timeoutMs = options.timeoutMs ?? 8_000
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout

  let response: Response
  try {
    response = await fetch(balanceURL(options.baseURL), {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      signal,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`余额请求失败: ${message}`)
  }

  if (!response.ok) {
    let detail = ""
    try {
      const body = await response.text()
      detail = body ? ` — ${body.slice(0, 200)}` : ""
    } catch {
      // ignore
    }
    throw new Error(`余额请求失败: HTTP ${response.status}${detail}`)
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new Error("余额响应不是合法 JSON")
  }
  return parseBalanceResponse(payload)
}

/** 优先 CNY, 否则取第一条 (与参考实现 opencode-provider-balance 一致)。 */
export function pickPrimary(infos: readonly BalanceInfo[]): BalanceInfo | null {
  if (infos.length === 0) return null
  return infos.find((info) => info.currency === "CNY") ?? infos[0] ?? null
}
