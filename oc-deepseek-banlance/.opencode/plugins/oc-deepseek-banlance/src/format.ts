// 余额格式化 — 供工具输出、TUI 状态条与桌面注入脚本共用 (纯函数, 可单测)。

import type { BalanceInfo } from "./deepseek"
import type { BalanceSnapshot } from "./service"

export function currencySymbol(currency: string | undefined): string {
  if (currency === "USD") return "$"
  if (currency === "CNY") return "¥"
  return currency ? `${currency} ` : ""
}

export function formatAmount(info: BalanceInfo | null | undefined): string {
  if (!info) return "—"
  return `${currencySymbol(info.currency)}${info.total_balance}`
}

/** 紧凑标签: "¥12.34" / "…" / "未配置 Key" / "查询失败"。 */
export function formatCompact(snapshot: BalanceSnapshot | null | undefined): string {
  if (!snapshot) return "…"
  if (snapshot.noKey) return "未配置 Key"
  if (snapshot.primary) return formatAmount(snapshot.primary)
  if (snapshot.error) return "查询失败"
  return "…"
}

export function formatTime(ms: number | null | undefined): string {
  if (!ms) return "—"
  try {
    return new Date(ms).toLocaleString("zh-CN", { hour12: false })
  } catch {
    return new Date(ms).toISOString()
  }
}

/** 详细文本 (deepseek_balance 工具结果与 TUI 面板使用)。 */
export function formatDetail(snapshot: BalanceSnapshot | null | undefined): string {
  if (!snapshot) return "尚未获取 DeepSeek 余额。"
  const lines: string[] = []
  if (snapshot.noKey) {
    lines.push("未找到 DeepSeek API Key。")
    lines.push("配置方式(任一): 插件选项 apiKey / 环境变量 DEEPSEEK_API_KEY / auth.json 的 deepseek.key / opencode.json 中 provider.ds.options.apiKey。")
    return lines.join("\n")
  }

  const state = snapshot.ok ? (snapshot.isAvailable ? "可调用" : "余额不足, 不可调用") : "查询失败"
  lines.push(`DeepSeek 账户余额 (${state})`)
  lines.push(`- 更新时间: ${formatTime(snapshot.updatedAt)}${snapshot.ok ? "" : `, 数据为 ${formatTime(snapshot.lastGoodAt)} 的最近成功快照`}`)
  lines.push(`- Key 来源: ${snapshot.source}`)
  if (snapshot.error) lines.push(`- 错误: ${snapshot.error}`)
  for (const info of snapshot.infos) {
    const symbol = currencySymbol(info.currency)
    lines.push(`- ${info.currency}: 总余额 ${symbol}${info.total_balance} (赠金 ${symbol}${info.granted_balance} / 充值 ${symbol}${info.topped_up_balance})`)
  }
  if (snapshot.infos.length === 0) lines.push("- 无可展示的余额条目")
  return lines.join("\n")
}

/** 注入 system 上下文的一行 (可选, 默认关闭)。 */
export function formatContextLine(snapshot: BalanceSnapshot | null | undefined): string | null {
  if (!snapshot?.ok || !snapshot.primary) return null
  return `[DeepSeek 余额] ${formatAmount(snapshot.primary)} (${snapshot.isAvailable ? "可用" : "不可用"}, ${formatTime(snapshot.updatedAt)})`
}
