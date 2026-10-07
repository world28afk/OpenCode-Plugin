/**
 * oc-infinite-gen-4 — Desktop badge injector（输入框上方运行状态绿框）
 *
 * 作用: 在 OpenCode Desktop / Web UI 中，于**输入框正上方**显示一个小绿框:
 *   运行中 → 「● 无限四代 v0.4.1 · 运行中」（绿色）
 *   未加载 → 「● 无限四代 · 未运行」（灰色）
 * 与 dsh-infinite-gen-4 的客户端状态条等位, 用于直观确认双层注入内核已挂载。
 *
 * 数据通道: 服务端插件 RPC
 *   POST {base}/api/rpc/infinite.gen4.profile/get   body: {"input":{}}
 *   • Web 页面: base = location.origin
 *   • Desktop (oc://renderer): base = 自动探测本机服务端口
 *     (Electron main 会给顶层 frame 发往本机服务 origin 的请求自动附加 Basic 认证)
 *
 * 用法:
 *   • 控制台: Ctrl+Shift+I → Console → 粘贴本文件全部内容。
 *   • 持久化: node scripts/patch-desktop.mjs（注入 app.asar, 可 --restore 还原）。
 */

;(() => {
  "use strict"

  if (window.__ocInfiniteGen4Badge) return

  const VERSION = "0.4.1"
  const RPC_ID = "infinite.gen4.profile"
  const MARK = "data-oc-infinite-gen-4"
  const LS_BASE = "oc-infinite-gen-4:serverBase"
  const SHARED_BASE_KEYS = ["oc-deepseek-banlance:serverBase", "oc-deepseek-balance:serverBase"]
  const DESKTOP_PORTS = [49374, 4096, 49375, 49376, 49377, 3001]
  const CHECK_MS = 30_000

  const state = {
    phase: "checking", // checking | running | stopped
    profile: null,
    error: null,
    checkedAt: 0,
  }

  let timer = null
  let scheduled = false
  let observer = null
  let basePromise = null

  // ── 工具 ────────────────────────────────────────────────────────────────

  const stripBase = (value) => String(value || "").replace(/\/+$/, "")

  function isDesktop() {
    return location.protocol === "oc:"
  }

  async function probeBase() {
    const candidates = []
    try {
      const own = localStorage.getItem(LS_BASE)
      if (own) candidates.push(stripBase(own))
      for (const key of SHARED_BASE_KEYS) {
        const shared = localStorage.getItem(key)
        if (shared) candidates.push(stripBase(shared))
      }
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
        // 200 = 已认证; 401/403 = 是 OpenCode 服务但认证尚未就绪 (Electron main 稍后附加)
        return response.ok || response.status === 401 || response.status === 403 ? base : null
      } catch {
        return null
      } finally {
        clearTimeout(timeout)
      }
    }

    const unique = [...new Set(candidates.filter(Boolean))]
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
        if (!base) basePromise = null
        return base
      })()
    }
    return basePromise
  }

  // ── 状态检查 ─────────────────────────────────────────────────────────────

  async function check() {
    try {
      const base = await baseURL()
      if (!base) {
        state.phase = "stopped"
        state.error = "服务地址探测失败"
      } else {
        const response = await fetch(`${base}/api/rpc/${RPC_ID}/get`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ input: {} }),
        })
        if (response.ok) {
          const json = await response.json().catch(() => null)
          const data = json && typeof json === "object" ? json.output ?? json.data ?? json : null
          if (data && typeof data === "object" && data.plugin) {
            state.phase = "running"
            state.profile = data
            state.error = null
          } else {
            state.phase = "stopped"
            state.error = "RPC 返回异常"
          }
        } else {
          state.phase = "stopped"
          state.error = `RPC HTTP ${response.status}`
        }
      }
    } catch (error) {
      state.phase = "stopped"
      state.error = error instanceof Error ? error.message : String(error)
    }
    state.checkedAt = Date.now()
    schedule()
  }

  // ── UI ──────────────────────────────────────────────────────────────────

  const COLORS = {
    running: { border: "rgba(16, 185, 129, 0.45)", bg: "rgba(16, 185, 129, 0.12)", dot: "#10b981" },
    stopped: { border: "rgba(148, 163, 184, 0.40)", bg: "rgba(148, 163, 184, 0.10)", dot: "#94a3b8" },
    checking: { border: "rgba(148, 163, 184, 0.35)", bg: "rgba(148, 163, 184, 0.08)", dot: "#94a3b8" },
  }

  function badgeText() {
    if (state.phase === "running") {
      const version = state.profile && state.profile.pluginVersion ? state.profile.pluginVersion : VERSION
      return `无限四代 v${version} · 运行中`
    }
    if (state.phase === "checking") return "无限四代 · 检测中…"
    return "无限四代 · 未运行"
  }

  function badgeTitle() {
    const profile = state.profile
    if (state.phase === "running" && profile) {
      const slots = Array.isArray(profile.injection)
        ? profile.injection.filter((item) => item && item.enabled).map((item) => item.section).join(" + ")
        : ""
      return `无限四代 (Infinite Generation Four) 已挂载\n${slots}\n内核 v${profile.kernelVersion ?? "?"} · 插件 v${profile.pluginVersion ?? "?"}`
    }
    if (state.error) return `无限四代未运行: ${state.error}`
    return "无限四代状态检测中"
  }

  function render() {
    const badge = document.querySelector(`[${MARK}="badge"]`)
    if (!badge) return
    const color = COLORS[state.phase] ?? COLORS.checking
    badge.style.borderColor = color.border
    badge.style.background = color.bg
    const dot = badge.firstElementChild
    if (dot) dot.style.background = color.dot
    const text = badge.lastElementChild
    if (text) text.textContent = badgeText()
    badge.title = badgeTitle()
  }

  function ensureBadge() {
    const composer = document.querySelector('[data-component="composer"]')
    const host = composer && composer.parentElement
    if (!composer || !host) return

    let badge = host.querySelector(`[${MARK}="badge"]`)
    if (!badge) {
      badge = document.createElement("div")
      badge.setAttribute(MARK, "badge")
      badge.style.cssText = [
        "display:flex",
        "align-items:center",
        "gap:6px",
        "width:fit-content",
        "margin:0 auto 6px",
        "padding:2px 10px",
        "border-radius:6px",
        "border:1px solid rgba(148,163,184,0.4)",
        "background:rgba(148,163,184,0.1)",
        "font-size:11px",
        "line-height:16px",
        "font-family:inherit",
        "user-select:none",
        "white-space:nowrap",
        "pointer-events:auto",
      ].join(";")

      const dot = document.createElement("span")
      dot.style.cssText = "width:6px;height:6px;border-radius:50%;background:#94a3b8;flex:none"
      const text = document.createElement("span")
      text.textContent = badgeText()
      badge.append(dot, text)
      // 输入框正上方
      host.insertBefore(badge, composer)
    }
    render()
  }

  function apply() {
    try {
      ensureBadge()
    } catch {
      // UI 注入失败不影响状态检查
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

  const scheduleNext = () => {
    // 未运行/未就绪时快速重试 (应用连接与认证可能晚于页面加载); 运行中 30s 定期复查
    const delay = state.phase === "running" ? CHECK_MS : 5_000
    timer = setTimeout(async () => {
      await check()
      scheduleNext()
    }, delay)
  }
  void check().then(scheduleNext)

  observer = new MutationObserver(() => schedule())
  observer.observe(document.body, { childList: true, subtree: true })

  window.__ocInfiniteGen4Badge = true
  window.ocInfiniteGen4Badge = {
    version: VERSION,
    state,
    refresh: () => check(),
    setServerBase: (url) => {
      try {
        if (url) localStorage.setItem(LS_BASE, stripBase(url))
        else localStorage.removeItem(LS_BASE)
      } catch {
        // ignore
      }
      basePromise = null
      return check()
    },
    destroy: () => {
      if (timer) clearTimeout(timer)
      observer?.disconnect()
      for (const node of document.querySelectorAll(`[${MARK}]`)) node.remove()
      delete window.ocInfiniteGen4Badge
      delete window.__ocInfiniteGen4Badge
    },
  }

  console.info(`[oc-infinite-gen-4] v${VERSION} 徽章已注入 (输入框上方)。`)
})()
