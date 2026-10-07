/**
 * oc-deepseek-banlance — Desktop / Web UI bridge (桌面端注入脚本)
 *
 * 作用: 在 OpenCode Desktop / Web UI 中把 DeepSeek 余额显示到
 *   1) 右上角「上下文小圆圈」的悬浮提示 (上下文工具提示) 内;
 *   2) 审查页 (Review panel) 的「上下文」页 内。
 *
 * 数据来源 (按顺序尝试):
 *   1. 服务端插件 RPC: POST {base}/api/rpc/deepseek.balance.v1/get
 *      • Web 页面: base = location.origin; Desktop (oc://renderer): base = 自动探测的本机服务地址
 *        (Electron main 会给顶层 frame 的本机请求自动附加 Basic 认证)
 *   2. /api/config 中 provider.ds/deepseek 的 apiKey → 直连 https://api.deepseek.com/user/balance
 *   3. localStorage("oc-deepseek-balance:apiKey") 或 window.ocDeepSeekBalance.setKey("sk-...")
 *
 * 用法:
 *   • 控制台: 打开开发者工具 (Ctrl+Shift+I) → Console → 粘贴本文件全部内容 → 回车。
 *   • 持久化: 用 scripts/patch-desktop.mjs 注入到桌面端 app.asar (可 --restore 还原)。
 *
 * 该脚本只读余额信息, 不发送任何其他数据; 除 DeepSeek 官方端点与本地服务外无外部请求。
 */
(() => {
  "use strict"

  if (window.__ocDeepSeekBalance) return

  const VERSION = "0.2.1"
  const LS_KEY = "oc-deepseek-balance:apiKey"
  const LS_BASE = "oc-deepseek-balance:serverBase"
  const RPC_ID = "deepseek.balance.v1"
  const REFRESH_MS = 60_000
  const MARK = "data-oc-balance"
  const LABEL = "余额"
  const DESKTOP_PORTS = [49374, 4096, 49375, 49376, 49377, 3001]

  const state = {
    snapshot: null,
    error: null,
    loading: false,
    fetchedAt: 0,
  }

  let timer = null
  let scheduled = false
  let observer = null

  // ── 工具 ────────────────────────────────────────────────────────────────

  const compact = (snapshot) => {
    if (!snapshot) return "…"
    if (snapshot.noKey) return "未配置"
    const primary = snapshot.primary
    if (primary) return `${symbol(primary.currency)}${primary.total_balance}`
    if (snapshot.error) return "查询失败"
    return "…"
  }

  const symbol = (currency) => {
    if (currency === "USD") return "$"
    if (currency === "CNY") return "¥"
    return currency ? `${currency} ` : ""
  }

  const detailText = (snapshot) => {
    if (!snapshot) return "余额加载中…"
    if (snapshot.noKey) return "未配置 DeepSeek API Key"
    const parts = []
    for (const info of snapshot.infos || []) {
      parts.push(`${info.currency} 总余额 ${symbol(info.currency)}${info.total_balance}（赠金 ${symbol(info.currency)}${info.granted_balance} / 充值 ${symbol(info.currency)}${info.topped_up_balance}）`)
    }
    if (!parts.length) parts.push("无可展示的余额条目")
    const time = snapshot.updatedAt ? new Date(snapshot.updatedAt).toLocaleTimeString("zh-CN", { hour12: false }) : "—"
    parts.push(`${snapshot.isAvailable === false ? "余额不足，不可调用" : snapshot.ok ? "可调用" : "查询失败"} · 更新于 ${time}`)
    if (snapshot.error) parts.push(`错误: ${snapshot.error}`)
    return parts.join(" · ")
  }

  const stripBase = (value) => String(value || "").replace(/\/+$/, "")
  let basePromise = null

  function isDesktop() {
    return location.protocol === "oc:"
  }

  // 桌面端 (oc://renderer): 探测本机服务地址。
  // Electron main 会对顶层 frame 发往本机 http://127.0.0.1/* 的请求自动附加 Basic 认证,
  // 因此这里只需要找到正确的端口。
  async function probeBase() {
    const candidates = []
    try {
      const override = localStorage.getItem(LS_BASE)
      if (override) candidates.push(stripBase(override))
    } catch {
      // ignore
    }
    const bootstrap = window.electron && window.electron.bootstrap
    if (bootstrap && typeof bootstrap === "object") {
      if (typeof bootstrap.defaultServerUrl === "string") candidates.push(stripBase(bootstrap.defaultServerUrl))
      if (typeof bootstrap.serverUrl === "string") candidates.push(stripBase(bootstrap.serverUrl))
    }
    for (const port of DESKTOP_PORTS) candidates.push(`http://127.0.0.1:${port}`)

    const attempt = async (base) => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 1500)
      try {
        const response = await fetch(`${base}/api/info`, { cache: "no-store", signal: controller.signal })
        return response.ok ? base : null
      } catch {
        return null
      } finally {
        clearTimeout(timeout)
      }
    }

    const unique = [...new Set(candidates.filter(Boolean))]
    // 并行探测 (优先项按顺序优先返回); 首个成功者即为服务地址
    const results = await Promise.all(unique.map(attempt))
    const hit = results.find((value) => value)
    if (hit) {
      try {
        localStorage.setItem(LS_BASE, hit)
      } catch {
        // ignore
      }
    }
    return hit ?? null
  }

  function baseURL() {
    if (!basePromise) {
      basePromise = (async () => {
        if (/^https?:/.test(location.origin)) return location.origin
        if (!isDesktop()) return null
        const base = await probeBase()
        // 失败不缓存: 应用可能尚未完成服务连接, 下次刷新重试
        if (!base) basePromise = null
        return base
      })()
    }
    return basePromise
  }

  // ── 数据获取 ─────────────────────────────────────────────────────────────

  async function fromRpc() {
    const base = await baseURL()
    if (!base) return null
    try {
      const response = await fetch(`${base}/api/rpc/${RPC_ID}/get`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: {} }),
        credentials: "same-origin",
      })
      if (!response.ok) return null
      const json = await response.json().catch(() => null)
      const data = json && typeof json === "object" ? json.output ?? json.data ?? json : null
      if (data && typeof data === "object" && (data.primary || data.noKey || data.error || data.infos)) return data
      return null
    } catch {
      return null
    }
  }

  function findApiKey(node, depth = 0) {
    if (!node || typeof node !== "object" || depth > 8) return null
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = findApiKey(item, depth + 1)
        if (found) return found
      }
      return null
    }
    for (const id of ["ds", "deepseek", "deepseek-official"]) {
      const provider = node[id]
      if (provider && typeof provider === "object") {
        const options = provider.options
        if (options && typeof options === "object" && typeof options.apiKey === "string" && options.apiKey.trim()) {
          return options.apiKey.trim()
        }
      }
    }
    for (const value of Object.values(node)) {
      const found = findApiKey(value, depth + 1)
      if (found) return found
    }
    return null
  }

  async function keyFromConfig() {
    const base = await baseURL()
    if (!base) return null
    try {
      const response = await fetch(`${base}/api/config`, { credentials: "same-origin" })
      if (!response.ok) return null
      const json = await response.json().catch(() => null)
      return findApiKey(json?.data ?? json)
    } catch {
      return null
    }
  }

  async function fromDirect() {
    const key = (() => {
      try {
        return (localStorage.getItem(LS_KEY) || "").trim() || null
      } catch {
        return null
      }
    })()
    const effective = key ?? (await keyFromConfig())
    if (!effective) return null
    try {
      const response = await fetch("https://api.deepseek.com/user/balance", {
        headers: { authorization: `Bearer ${effective}` },
      })
      if (!response.ok) return null
      const data = await response.json().catch(() => null)
      if (!data || !Array.isArray(data.balance_infos)) return null
      const infos = data.balance_infos
      const primary = infos.find((item) => item.currency === "CNY") ?? infos[0] ?? null
      return {
        ok: true,
        noKey: false,
        error: null,
        source: key ? "localStorage" : "/api/config",
        isAvailable: data.is_available === true,
        infos,
        primary,
        updatedAt: Date.now(),
        lastGoodAt: Date.now(),
      }
    } catch {
      return null
    }
  }

  async function refresh() {
    if (state.loading) return state.snapshot
    state.loading = true
    try {
      const snapshot = (await fromRpc()) ?? (await fromDirect())
      if (snapshot) {
        state.snapshot = snapshot
        state.error = null
      } else {
        state.error = "无法获取余额（插件未加载且未配置 Key）"
      }
      state.fetchedAt = Date.now()
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error)
    } finally {
      state.loading = false
      schedule()
    }
    return state.snapshot
  }

  // ── UI 注入 ──────────────────────────────────────────────────────────────

  function ensureTooltipRow() {
    const containers = document.querySelectorAll('[class*="w-[120px]"]')
    for (const container of containers) {
      if (!container.querySelector(`[${MARK}="tooltip"]`)) {
        const row = document.createElement("div")
        row.className = "flex min-w-0 items-center gap-4"
        row.setAttribute(MARK, "tooltip")
        const name = document.createElement("span")
        name.className = "shrink-0 text-v2-text-text-muted"
        name.textContent = LABEL
        const value = document.createElement("span")
        value.className = "ml-auto min-w-0 truncate text-right text-v2-text-text-base"
        value.textContent = compact(state.snapshot)
        value.title = detailText(state.snapshot)
        row.append(name, value)
        container.appendChild(row)
      } else {
        const value = container.querySelector(`[${MARK}="tooltip"] span:last-child`)
        if (value) {
          value.textContent = compact(state.snapshot)
          value.title = detailText(state.snapshot)
        }
      }
    }
  }

  function ensureContextStat() {
    const grids = document.querySelectorAll('[class*="grid-cols-1"]')
    for (const grid of grids) {
      if (!grid.className.includes("grid-cols-2")) continue
      if (!grid.querySelector(`[${MARK}="stat"]`)) {
        const stat = document.createElement("div")
        stat.className = "flex flex-col gap-1"
        stat.setAttribute(MARK, "stat")
        const label = document.createElement("div")
        label.className = "text-12-regular text-text-weak"
        label.textContent = LABEL
        const value = document.createElement("div")
        value.className = "text-12-medium text-text-strong"
        value.textContent = compact(state.snapshot)
        stat.append(label, value)
        grid.appendChild(stat)
      } else {
        const value = grid.querySelector(`[${MARK}="stat"] div:last-child`)
        if (value) value.textContent = compact(state.snapshot)
      }
      ensureDetailCard(grid)
    }
  }

  function ensureDetailCard(grid) {
    const parent = grid.parentElement
    if (!parent) return
    let card = parent.querySelector(`[${MARK}="card"]`)
    if (!card) {
      card = document.createElement("div")
      card.className = "flex flex-col gap-2"
      card.setAttribute(MARK, "card")
      const title = document.createElement("div")
      title.className = "text-12-regular text-text-weak"
      title.textContent = "DeepSeek 账户余额"
      const body = document.createElement("div")
      body.className = "border border-border-base rounded-md bg-surface-base px-3 py-2 text-12-regular text-text-base"
      card.append(title, body)
      grid.insertAdjacentElement("afterend", card)
    }
    const body = card.lastElementChild
    if (body) body.textContent = detailText(state.snapshot)
  }

  function apply() {
    try {
      ensureTooltipRow()
      ensureContextStat()
    } catch {
      // UI 注入失败不影响数据层
    }
  }

  function schedule() {
    if (scheduled) return
    scheduled = true
    const run = () => {
      scheduled = false
      apply()
    }
    if (typeof requestAnimationFrame === "function" && !document.hidden) requestAnimationFrame(run)
    else setTimeout(run, 16)
  }

  // ── 生命周期 ────────────────────────────────────────────────────────────

  // 动态轮询: 有数据 60s, 无数据(桌面端服务尚未就绪/探测失败) 5s 重试
  const scheduleNext = () => {
    const delay = state.snapshot ? REFRESH_MS : 5_000
    timer = setTimeout(async () => {
      await refresh()
      scheduleNext()
    }, delay)
  }
  void refresh().then(scheduleNext)

  observer = new MutationObserver(() => schedule())
  observer.observe(document.body, { childList: true, subtree: true })

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && Date.now() - state.fetchedAt > REFRESH_MS / 2) void refresh()
  })

  window.__ocDeepSeekBalance = true
  window.ocDeepSeekBalance = {
    version: VERSION,
    refresh: () => refresh(),
    state,
    setKey: (key) => {
      try {
        if (key) localStorage.setItem(LS_KEY, String(key).trim())
        else localStorage.removeItem(LS_KEY)
      } catch {
        // ignore
      }
      return refresh()
    },
    setServerBase: (url) => {
      try {
        if (url) localStorage.setItem(LS_BASE, stripBase(url))
        else localStorage.removeItem(LS_BASE)
      } catch {
        // ignore
      }
      basePromise = null
      return refresh()
    },
    destroy: () => {
      if (timer) clearTimeout(timer)
      observer?.disconnect()
      for (const node of document.querySelectorAll(`[${MARK}]`)) node.remove()
      delete window.ocDeepSeekBalance
      delete window.__ocDeepSeekBalance
    },
  }

  console.info(
    `[oc-deepseek-banlance] v${VERSION} 已注入。余额将显示在上下文圆圈提示与审查页-上下文页。` +
      ` 未配置 Key 时可执行: ocDeepSeekBalance.setKey("sk-...")` +
      ` 桌面端端口探测失败时可执行: ocDeepSeekBalance.setServerBase("http://127.0.0.1:49374")`,
  )
})()
