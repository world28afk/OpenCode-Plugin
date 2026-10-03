/**
 * oc-exit — Desktop「彻底退出」角标注入脚本
 *
 * 在 OpenCode Desktop / Web UI 右下角显示一个电源角标；**右键**（或左键）
 * 弹出两个选项：
 *   • 显示 OpenCode — 把主窗口显示并激活到前台
 *   • 退出 OpenCode — **彻底退出**：关闭桌面界面并结束后台服务进程
 *     （右上角 X 只关界面, 后台 opencode-cli.exe 仍常驻; 本动作会一并终止）
 *
 * 数据通道: 服务端插件 RPC
 *   POST {base}/api/rpc/exit.control/status  { "input": {} }
 *   POST {base}/api/rpc/exit.control/focus   { "input": {} }
 *   POST {base}/api/rpc/exit.control/quit    { "input": {} }
 *
 * 安装（持久化）: node scripts/patch-desktop.mjs（独立注入, 可 --unpatch 移除）
 * 临时: Ctrl+Shift+I → Console → 粘贴本文件
 */
;(() => {
  "use strict"
  if (window.__ocExitBadge) return

  const VERSION = "0.1.0"
  const RPC_ID = "exit.control"
  const MARK = "data-oc-exit"
  const LS_BASE = "oc-exit:serverBase"
  const SHARED_BASE_KEYS = [
    "oc-plugin-manager:serverBase",
    "oc-infinite-gen-4:serverBase",
    "oc-deepseek-banlance:serverBase",
    "oc-deepseek-balance:serverBase",
  ]
  const PORTS = [49374, 4096, 49375, 49376, 49377, 3001]
  const CHECK_MS = 15_000

  const state = { connected: false, error: null, checkedAt: 0, busy: false }
  let timer = null
  let basePromise = null
  let menu = null

  const strip = (value) => String(value || "").replace(/\/+$/, "")

  // ── 服务地址探测（桌面端 main 会给本机请求自动附加认证） ─────────────────

  async function probeBase() {
    const candidates = []
    try {
      const own = localStorage.getItem(LS_BASE)
      if (own) candidates.push(strip(own))
      for (const key of SHARED_BASE_KEYS) {
        const shared = localStorage.getItem(key)
        if (shared) candidates.push(strip(shared))
      }
    } catch {
      // ignore
    }
    const boot = window.electron && window.electron.bootstrap
    if (boot && typeof boot === "object") {
      if (typeof boot.defaultServerUrl === "string") candidates.push(strip(boot.defaultServerUrl))
      if (typeof boot.serverUrl === "string") candidates.push(strip(boot.serverUrl))
    }
    for (const port of PORTS) candidates.push(`http://127.0.0.1:${port}`)

    const attempt = async (base) => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 1500)
      try {
        const response = await fetch(`${base}/api/info`, { cache: "no-store", signal: controller.signal })
        return response.ok || response.status === 401 || response.status === 403 ? base : null
      } catch {
        return null
      } finally {
        clearTimeout(timeout)
      }
    }
    const unique = [...new Set(candidates.filter(Boolean))]
    const hit = (await Promise.all(unique.map(attempt))).find(Boolean)
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
        const base = await probeBase()
        if (!base) basePromise = null
        return base
      })()
    }
    return basePromise
  }

  async function call(method, input) {
    const base = await baseURL()
    if (!base) throw new Error("服务地址探测失败")
    const response = await fetch(`${base}/api/rpc/${RPC_ID}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: input ?? {} }),
    })
    const json = await response.json().catch(() => null)
    const data = json && typeof json === "object" ? json.output ?? json.data ?? json : null
    if (!response.ok) throw new Error(`RPC HTTP ${response.status}`)
    return data
  }

  async function refreshStatus() {
    try {
      await call("status", {})
      state.connected = true
      state.error = null
    } catch (error) {
      state.connected = false
      state.error = error instanceof Error ? error.message : String(error)
    }
    state.checkedAt = Date.now()
    render()
  }

  // ── 动作 ────────────────────────────────────────────────────────────────

  async function doFocus() {
    closeMenu()
    try {
      window.focus()
    } catch {
      // ignore
    }
    try {
      await call("focus", {})
      toast("已显示 OpenCode")
    } catch (error) {
      toast(`显示失败: ${error instanceof Error ? error.message : String(error)}`, true)
    }
  }

  async function doQuit() {
    closeMenu()
    if (state.busy) return
    let confirmed = true
    try {
      confirmed = window.confirm("彻底退出 OpenCode？\n\n将关闭桌面界面并结束后台服务（含其子进程）。未保存的输入可能丢失。")
    } catch {
      confirmed = true
    }
    if (!confirmed) return
    state.busy = true
    render()
    toast("正在彻底退出 OpenCode…")
    try {
      await call("quit", {})
    } catch {
      // 服务端已在退出, 请求可能中断；忽略
    }
    // 兜底：若服务未在数秒内退出, 提示用户
    setTimeout(() => {
      state.busy = false
      render()
      toast("退出请求已发送；若界面仍在, 请稍候或手动结束 opencode-cli.exe", true)
    }, 4000)
  }

  // ── UI ──────────────────────────────────────────────────────────────────

  function toast(text, isError) {
    let node = document.querySelector(`[${MARK}="toast"]`)
    if (!node) {
      node = document.createElement("div")
      node.setAttribute(MARK, "toast")
      node.style.cssText = [
        "position:fixed",
        "right:16px",
        "bottom:64px",
        "z-index:2147483001",
        "padding:6px 12px",
        "border-radius:8px",
        "font-size:12px",
        "line-height:18px",
        "font-family:inherit",
        "color:#fff",
        "background:rgba(15,23,42,0.92)",
        "border:1px solid rgba(148,163,184,0.4)",
        "box-shadow:0 6px 20px rgba(0,0,0,0.35)",
        "pointer-events:none",
        "max-width:320px",
      ].join(";")
      document.body.appendChild(node)
    }
    node.textContent = text
    node.style.borderColor = isError ? "rgba(248,113,113,0.7)" : "rgba(52,211,153,0.6)"
    node.style.display = "block"
    clearTimeout(node.__ocExitTimer)
    node.__ocExitTimer = setTimeout(() => {
      node.style.display = "none"
    }, 3200)
  }

  function ensureBadge() {
    let badge = document.querySelector(`[${MARK}="badge"]`)
    if (badge) return badge
    badge = document.createElement("div")
    badge.setAttribute(MARK, "badge")
    badge.style.cssText = [
      "position:fixed",
      "right:12px",
      "bottom:12px",
      "z-index:2147483000",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "width:28px",
      "height:28px",
      "border-radius:50%",
      "cursor:pointer",
      "user-select:none",
      "font-size:14px",
      "line-height:1",
      "color:#e2e8f0",
      "background:rgba(15,23,42,0.82)",
      "border:1px solid rgba(148,163,184,0.5)",
      "box-shadow:0 2px 10px rgba(0,0,0,0.35)",
      "backdrop-filter:blur(4px)",
      "transition:transform .12s ease, border-color .12s ease, background .12s ease",
    ].join(";")
    badge.title = "OpenCode 退出（右键：显示 / 彻底退出）"
    badge.textContent = "⏻"
    badge.addEventListener("click", (event) => {
      event.stopPropagation()
      if (menu) closeMenu()
      else openMenu(event.clientX, event.clientY)
    })
    badge.addEventListener("contextmenu", (event) => {
      event.preventDefault()
      event.stopPropagation()
      openMenu(event.clientX, event.clientY)
    })
    document.body.appendChild(badge)
    return badge
  }

  function render() {
    const badge = ensureBadge()
    const connected = state.connected
    badge.style.borderColor = connected ? "rgba(52,211,153,0.75)" : "rgba(148,163,184,0.5)"
    badge.style.background = connected ? "rgba(6,78,59,0.85)" : "rgba(15,23,42,0.82)"
    if (state.busy) {
      badge.style.opacity = "0.6"
      badge.textContent = "…"
    } else {
      badge.style.opacity = "1"
      badge.textContent = "⏻"
    }
    badge.title = connected
      ? "OpenCode 退出（右键：显示 / 彻底退出）"
      : `OpenCode 退出 · 服务未连接${state.error ? `: ${state.error}` : ""}`
  }

  function menuItem(label, hint, danger, onClick) {
    const item = document.createElement("div")
    item.setAttribute(MARK, "item")
    item.style.cssText = [
      "display:flex",
      "align-items:center",
      "justify-content:space-between",
      "gap:16px",
      "padding:7px 12px",
      "font-size:13px",
      "line-height:18px",
      "font-family:inherit",
      "color:" + (danger ? "#fca5a5" : "#e2e8f0"),
      "cursor:pointer",
      "user-select:none",
      "white-space:nowrap",
    ].join(";")
    const text = document.createElement("span")
    text.textContent = label
    item.appendChild(text)
    if (hint) {
      const badge = document.createElement("span")
      badge.textContent = hint
      badge.style.cssText = "font-size:11px;color:#94a3b8"
      item.appendChild(badge)
    }
    item.addEventListener("mouseenter", () => {
      item.style.background = danger ? "rgba(127,29,29,0.55)" : "rgba(51,65,85,0.6)"
    })
    item.addEventListener("mouseleave", () => {
      item.style.background = "transparent"
    })
    item.addEventListener("click", (event) => {
      event.stopPropagation()
      onClick()
    })
    return item
  }

  function openMenu(x, y) {
    closeMenu()
    menu = document.createElement("div")
    menu.setAttribute(MARK, "menu")
    menu.style.cssText = [
      "position:fixed",
      "z-index:2147483001",
      "min-width:172px",
      "padding:4px",
      "border-radius:10px",
      "background:rgba(15,23,42,0.98)",
      "border:1px solid rgba(148,163,184,0.45)",
      "box-shadow:0 10px 30px rgba(0,0,0,0.45)",
      "overflow:hidden",
    ].join(";")
    menu.appendChild(menuItem("显示 OpenCode", "focus", false, doFocus))
    menu.appendChild(menuItem("退出 OpenCode", "quit", true, doQuit))
    document.body.appendChild(menu)
    // 视口内定位
    const rect = menu.getBoundingClientRect()
    const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))
    const top = Math.max(8, y - rect.height - 8)
    menu.style.left = `${left}px`
    menu.style.top = `${top}px`
    setTimeout(() => {
      window.addEventListener("click", closeMenu, { once: true })
      window.addEventListener("contextmenu", closeMenu, { once: true })
    }, 0)
  }

  function closeMenu() {
    if (menu) {
      menu.remove()
      menu = null
    }
  }

  // ── 生命周期 ────────────────────────────────────────────────────────────

  const loop = async () => {
    await refreshStatus()
    timer = setTimeout(loop, CHECK_MS)
  }
  void loop()

  window.__ocExitBadge = true
  window.ocExit = {
    version: VERSION,
    state,
    refresh: () => refreshStatus(),
    show: doFocus,
    quit: doQuit,
    setServerBase: (url) => {
      try {
        if (url) localStorage.setItem(LS_BASE, strip(url))
        else localStorage.removeItem(LS_BASE)
      } catch {
        // ignore
      }
      basePromise = null
      return refreshStatus()
    },
    destroy: () => {
      if (timer) clearTimeout(timer)
      closeMenu()
      for (const node of document.querySelectorAll(`[${MARK}]`)) node.remove()
      delete window.ocExit
      delete window.__ocExitBadge
    },
  }

  console.info(`[oc-exit] v${VERSION} 已注入: 右下角电源角标, 右键「显示 OpenCode / 退出 OpenCode」。`)
})()
