/**
 * 桌面/Web UI 注入脚本骨架（以「输入框上方徽章」为例）
 *
 * 原理:
 *   • Desktop 渲染进程为 oc://renderer; Electron main 会给顶层 frame 发往本机服务 origin 的请求
 *     自动附加 Basic 认证 → 同页 fetch 无需处理密钥
 *   • 服务地址自动探测: 并行探测候选端口 + GET /api/info (401/403 也视为找到) + 失败 5s 重试
 *   • 页面 CSP 禁 eval → 持久注入需把本文件放进 app.asar 并用 <script src> 加载 (见 patch 骨架)
 *
 * 用法:
 *   • 临时: Ctrl+Shift+I → Console → 粘贴
 *   • 持久: 随插件仓库的 patch-desktop.mjs 注入 app.asar
 */
;(() => {
  "use strict"
  if (window.__acmeBadge) return

  const VERSION = "0.1.0"
  const RPC_ID = "acme.value" // 与服务端 ctx.rpc.register 的 id 一致
  const MARK = "data-acme-badge"
  const LS_BASE = "acme:serverBase"
  const PORTS = [49374, 4096, 49375]
  const CHECK_MS = 30_000

  const state = { phase: "checking", data: null, error: null }
  let timer = null
  let basePromise = null

  const strip = (v) => String(v || "").replace(/\/+$/, "")

  async function probeBase() {
    const candidates = []
    try {
      const saved = localStorage.getItem(LS_BASE)
      if (saved) candidates.push(strip(saved))
    } catch {}
    const boot = window.electron && window.electron.bootstrap
    if (boot && typeof boot === "object") {
      if (typeof boot.defaultServerUrl === "string") candidates.push(strip(boot.defaultServerUrl))
    }
    for (const port of PORTS) candidates.push(`http://127.0.0.1:${port}`)

    const attempt = async (base) => {
      const c = new AbortController()
      const t = setTimeout(() => c.abort(), 1500)
      try {
        const r = await fetch(`${base}/api/info`, { cache: "no-store", signal: c.signal })
        return r.ok || r.status === 401 || r.status === 403 ? base : null
      } catch {
        return null
      } finally {
        clearTimeout(t)
      }
    }
    const unique = [...new Set(candidates.filter(Boolean))]
    const hit = (await Promise.all(unique.map(attempt))).find(Boolean)
    if (hit) {
      try { localStorage.setItem(LS_BASE, hit) } catch {}
    }
    return hit ?? null
  }

  function baseURL() {
    if (!basePromise) {
      basePromise = (async () => {
        if (/^https?:/.test(location.origin)) return location.origin
        const base = await probeBase()
        if (!base) basePromise = null // 失败不缓存, 稍后重试
        return base
      })()
    }
    return basePromise
  }

  async function check() {
    try {
      const base = await baseURL()
      if (!base) {
        state.phase = "stopped"
        state.error = "服务地址探测失败"
      } else {
        const r = await fetch(`${base}/api/rpc/${RPC_ID}/get`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ input: {} }),
        })
        if (r.ok) {
          const json = await r.json()
          state.data = json.output ?? json.data ?? json
          state.phase = "running"
          state.error = null
        } else {
          state.phase = "stopped"
          state.error = `RPC HTTP ${r.status}`
        }
      }
    } catch (error) {
      state.phase = "stopped"
      state.error = String(error)
    }
    schedule()
  }

  function render() {
    const composer = document.querySelector('[data-component="composer"]')
    const host = composer && composer.parentElement
    if (!composer || !host) return
    let badge = host.querySelector(`[${MARK}]`)
    if (!badge) {
      badge = document.createElement("div")
      badge.setAttribute(MARK, "badge")
      badge.style.cssText =
        "display:flex;align-items:center;gap:6px;width:fit-content;margin:0 auto 6px;padding:2px 10px;" +
        "border-radius:6px;font-size:11px;line-height:16px;user-select:none;white-space:nowrap"
      const dot = document.createElement("span")
      dot.style.cssText = "width:6px;height:6px;border-radius:50%;flex:none"
      const text = document.createElement("span")
      badge.append(dot, text)
      host.insertBefore(badge, composer) // 输入框正上方
    }
    const running = state.phase === "running"
    badge.style.border = `1px solid ${running ? "rgba(16,185,129,.45)" : "rgba(148,163,184,.4)"}`
    badge.style.background = running ? "rgba(16,185,129,.12)" : "rgba(148,163,184,.1)"
    badge.firstElementChild.style.background = running ? "#10b981" : "#94a3b8"
    badge.lastElementChild.textContent = running ? `ACME v${VERSION} · 运行中` : `ACME · 未运行`
    badge.title = state.error || ""
  }

  let scheduled = false
  function schedule() {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(() => {
      scheduled = false
      try { render() } catch {}
    })
  }

  const observer = new MutationObserver(() => schedule())
  observer.observe(document.body, { childList: true, subtree: true })

  const loop = async () => {
    await check()
    timer = setTimeout(loop, state.phase === "running" ? CHECK_MS : 5_000) // 未就绪 5s 快速重试
  }
  void loop()

  window.__acmeBadge = true
  window.acmeBadge = {
    state,
    refresh: () => check(),
    setServerBase: (url) => {
      try { url ? localStorage.setItem(LS_BASE, strip(url)) : localStorage.removeItem(LS_BASE) } catch {}
      basePromise = null
      return check()
    },
    destroy: () => {
      if (timer) clearTimeout(timer)
      observer.disconnect()
      document.querySelectorAll(`[${MARK}]`).forEach((n) => n.remove())
      delete window.acmeBadge
      delete window.__acmeBadge
    },
  }
})()
