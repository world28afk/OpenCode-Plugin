/**
 * oc-dsh-purge — Desktop dock injector（会话输入框上方的「破甲」按钮 + 右侧面板）
 *
 * 上游: dsh-purge 的 client.js 在会话标题旁挂 "dsh-purge" 按钮, 打开右侧 dock
 * （Clean / Drill 两页）。OpenCode 桌面/Web 无官方 UI 插件接口, 因此改为 DOM 注入。
 *
 * 功能:
 *   • 输入框上方一枚「⚔ 破甲」按钮 → 右侧 dock 面板
 *   • 面板: 运行状态 / 注入槽位 / 提示词来源 / 策略 / 规则数 / 内置技能
 *   • 操作: 停用·启用 / 策略切换 / 能力协议开关 / 自定义注入文本（等价 prompt-inject.md）
 *
 * 数据通道: 服务端插件 RPC
 *   POST {base}/api/rpc/dsh.purge.status/get   body {"input":{}}
 *   POST {base}/api/rpc/dsh.purge.status/set   body {"input":{...}}
 *
 * 用法:
 *   • 控制台: Ctrl+Shift+I → Console → 粘贴本文件全部内容。
 *   • 持久化: node scripts/patch-desktop.mjs（注入 app.asar, 可 --unpatch/--restore）。
 */

;(() => {
  "use strict"

  if (window.__ocDshPurgeDock) return

  const VERSION = "1.1.71"
  const RPC_ID = "dsh.purge.status"
  const MARK = "data-oc-dsh-purge"
  const LS_BASE = "oc-dsh-purge:serverBase"
  const SHARED_BASE_KEYS = ["oc-infinite-gen-4:serverBase", "oc-deepseek-banlance:serverBase"]
  const DESKTOP_PORTS = [49374, 4096, 49375, 49376, 49377, 3001]
  const CHECK_MS = 30_000

  const state = { phase: "checking", profile: null, error: null, open: false }

  // ── 服务源探测（复用应用自身 /api 请求的 origin，退化到端口探测） ─────────
  const captured = new Set()
  const recordUrl = (value) => {
    try {
      const url = typeof value === "string" ? value : value && typeof value.url === "string" ? value.url : ""
      if (!url) return
      const absolute = new URL(url, location.href)
      if (!/^https?:$/.test(absolute.protocol)) return
      if (absolute.pathname.indexOf("/api/") === -1) return
      captured.add(absolute.protocol + "//" + absolute.host)
    } catch {}
  }
  try {
    const nativeFetch = window.fetch
    if (typeof nativeFetch === "function") {
      window.fetch = function (input) {
        recordUrl(input)
        return nativeFetch.apply(this, arguments)
      }
    }
  } catch {}
  try {
    const nativeOpen = XMLHttpRequest.prototype.open
    XMLHttpRequest.prototype.open = function (method, url) {
      recordUrl(url)
      return nativeOpen.apply(this, arguments)
    }
  } catch {}

  const stripBase = (value) => String(value || "").replace(/\/+$/, "")
  let basePromise = null

  async function probeBase() {
    const candidates = []
    try {
      const own = localStorage.getItem(LS_BASE)
      if (own) candidates.push(stripBase(own))
      for (const key of SHARED_BASE_KEYS) {
        const shared = localStorage.getItem(key)
        if (shared) candidates.push(stripBase(shared))
      }
    } catch {}
    for (const origin of captured) candidates.push(stripBase(origin))
    for (const port of DESKTOP_PORTS) candidates.push(`http://127.0.0.1:${port}`)

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
      } catch {}
    }
    return hit ?? null
  }

  function baseURL() {
    if (!basePromise) {
      basePromise = (async () => {
        if (/^https?:/.test(location.origin)) return location.origin
        const cap = [...captured][0]
        if (cap) return cap
        if (location.protocol !== "oc:") return null
        const base = await probeBase()
        if (!base) basePromise = null
        return base
      })()
    }
    return basePromise
  }

  // ── RPC ──────────────────────────────────────────────────────────────────
  async function call(method, input) {
    const base = await baseURL()
    if (!base) throw new Error("服务地址探测失败")
    const response = await fetch(`${base}/api/rpc/${RPC_ID}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: input ?? {} }),
    })
    if (!response.ok) throw new Error(`RPC HTTP ${response.status}`)
    const json = await response.json().catch(() => null)
    const data = json && typeof json === "object" ? (json.output ?? json.data ?? json) : null
    if (!data || typeof data !== "object") throw new Error("RPC 返回异常")
    return data
  }

  async function refresh() {
    try {
      state.profile = await call("get", {})
      state.phase = state.profile && state.profile.plugin ? "running" : "stopped"
      state.error = state.profile && state.profile.plugin ? null : "RPC 返回异常"
    } catch (error) {
      state.profile = null
      state.phase = "stopped"
      state.error = error instanceof Error ? error.message : String(error)
    }
    schedule()
  }

  async function write(patch) {
    state.phase = "checking"
    schedule()
    try {
      state.profile = await call("set", patch)
      state.phase = "running"
      state.error = null
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error)
    }
    schedule()
  }

  // ── UI ───────────────────────────────────────────────────────────────────
  const COLORS = {
    running: { dot: "#10b981", border: "rgba(16,185,129,0.45)", bg: "rgba(16,185,129,0.10)" },
    stopped: { dot: "#94a3b8", border: "rgba(148,163,184,0.40)", bg: "rgba(148,163,184,0.08)" },
    checking: { dot: "#eab308", border: "rgba(234,179,8,0.40)", bg: "rgba(234,179,8,0.08)" },
  }

  const buttonText = () => (state.phase === "running" ? "⚔ 破甲" : "⚔ 破甲 · 未连接")

  function ensureButton() {
    const composer = document.querySelector('[data-component="composer"]')
    const host = composer && composer.parentElement
    if (!composer || !host) return null
    let button = host.querySelector(`[${MARK}="button"]`)
    if (!button) {
      button = document.createElement("button")
      button.setAttribute(MARK, "button")
      button.type = "button"
      button.style.cssText = [
        "display:flex",
        "align-items:center",
        "gap:6px",
        "width:fit-content",
        "margin:0 auto 6px",
        "padding:2px 10px",
        "border-radius:6px",
        "border:1px solid rgba(148,163,184,0.4)",
        "background:rgba(148,163,184,0.1)",
        "color:inherit",
        "font-size:11px",
        "line-height:16px",
        "font-family:inherit",
        "cursor:pointer",
        "user-select:none",
      ].join(";")
      button.addEventListener("click", (event) => {
        event.preventDefault()
        state.open = !state.open
        schedule()
        void refresh()
      })
      host.insertBefore(button, composer)
    }
    const color = COLORS[state.phase] ?? COLORS.checking
    button.style.borderColor = color.border
    button.style.background = color.bg
    button.textContent = buttonText()
    return button
  }

  function row(label, value) {
    const wrap = document.createElement("div")
    wrap.style.cssText = "display:flex;justify-content:space-between;gap:12px;font-size:12px;line-height:20px"
    const left = document.createElement("span")
    left.textContent = label
    left.style.cssText = "color:#94a3b8;flex:none"
    const right = document.createElement("span")
    right.textContent = value
    right.style.cssText = "text-align:right;word-break:break-all"
    wrap.append(left, right)
    return wrap
  }

  function actionButton(text, onClick) {
    const button = document.createElement("button")
    button.type = "button"
    button.textContent = text
    button.style.cssText = [
      "padding:3px 10px",
      "border-radius:6px",
      "border:1px solid rgba(148,163,184,0.4)",
      "background:rgba(148,163,184,0.08)",
      "color:inherit",
      "font-size:11px",
      "cursor:pointer",
    ].join(";")
    button.addEventListener("click", (event) => {
      event.preventDefault()
      onClick()
    })
    return button
  }

  function renderDock(panel) {
    const profile = state.profile
    panel.replaceChildren()

    const title = document.createElement("div")
    title.textContent = `⚔ 破甲 dsh-purge v${VERSION}`
    title.style.cssText = "font-size:13px;font-weight:600;margin-bottom:4px"
    panel.append(title)

    const status = document.createElement("div")
    status.textContent =
      state.phase === "running"
        ? `运行中 · ${profile && profile.enabled === false ? "注入已停用" : "注入已开启"}`
        : state.phase === "checking"
          ? "检测中…"
          : `未连接${state.error ? " · " + state.error : ""}`
    status.style.cssText = `font-size:11px;margin-bottom:8px;color:${(COLORS[state.phase] ?? COLORS.checking).dot}`
    panel.append(status)

    if (profile) {
      panel.append(
        row("提示词来源", String(profile.promptSource ?? "-")),
        row("策略", String(profile.policy ?? "-")),
        row("能力协议", profile.capabilityProtocol === false ? "关" : "开"),
        row("规则集", `${profile.ruleCount ?? 0} 个`),
        row("内置技能", `${profile.skills?.bundled ?? 0} 项`),
      )
      const slots = Array.isArray(profile.injection)
        ? profile.injection.filter((item) => item && item.enabled).map((item) => item.slot).join(", ")
        : ""
      panel.append(row("注入槽位", slots || "无"))
    }

    // 操作区
    const actions = document.createElement("div")
    actions.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 6px"
    const enabled = !profile || profile.enabled !== false
    actions.append(
      actionButton(enabled ? "停用注入" : "开启注入", () => void write({ enabled: !enabled })),
      actionButton("能力协议", () =>
        void write({ capabilityProtocol: !(profile && profile.capabilityProtocol !== false) }),
      ),
    )
    for (const policy of ["fallback", "strict", "always"]) {
      actions.append(actionButton(`策略:${policy}`, () => void write({ policy })))
    }
    panel.append(actions)

    // 自定义注入文本（等价 prompt-inject.md）
    const textarea = document.createElement("textarea")
    textarea.placeholder = "自定义注入文本（等价 prompt-inject.md，留空则用内置默认）"
    textarea.value = profile && typeof profile.customText === "string" ? profile.customText : ""
    textarea.style.cssText = [
      "width:100%",
      "min-height:120px",
      "margin-top:6px",
      "padding:6px",
      "border-radius:6px",
      "border:1px solid rgba(148,163,184,0.4)",
      "background:rgba(148,163,184,0.06)",
      "color:inherit",
      "font-size:11px",
      "font-family:ui-monospace,monospace",
      "resize:vertical",
    ].join(";")
    panel.append(textarea)

    const save = document.createElement("div")
    save.style.cssText = "display:flex;gap:6px;margin-top:6px"
    save.append(
      actionButton("保存文本", () => void write({ customText: textarea.value })),
      actionButton("清空文本", () => {
        textarea.value = ""
        void write({ customText: null })
      }),
    )
    panel.append(save)

    if (profile && Array.isArray(profile.skills?.ids)) {
      const skills = document.createElement("div")
      skills.textContent = "技能: " + profile.skills.ids.join(", ")
      skills.style.cssText = "margin-top:8px;font-size:10px;line-height:15px;color:#94a3b8;word-break:break-all"
      panel.append(skills)
    }
  }

  function ensureDock() {
    let panel = document.querySelector(`[${MARK}="dock"]`)
    if (!state.open) {
      if (panel) panel.remove()
      return
    }
    if (!panel) {
      panel = document.createElement("aside")
      panel.setAttribute(MARK, "dock")
      panel.style.cssText = [
        "position:fixed",
        "top:56px",
        "right:12px",
        "width:320px",
        "max-height:calc(100vh - 80px)",
        "overflow:auto",
        "z-index:2147483000",
        "padding:12px",
        "border-radius:10px",
        "border:1px solid rgba(148,163,184,0.35)",
        "background:rgba(17,24,39,0.94)",
        "color:#e5e7eb",
        "box-shadow:0 8px 28px rgba(0,0,0,0.35)",
        "font-family:inherit",
      ].join(";")
      document.body.append(panel)
    }
    renderDock(panel)
  }

  let scheduled = false
  function schedule() {
    if (scheduled) return
    scheduled = true
    const run = () => {
      scheduled = false
      try {
        ensureButton()
        ensureDock()
      } catch {
        // UI 注入失败不影响状态检查
      }
    }
    if (typeof requestAnimationFrame === "function" && !document.hidden) requestAnimationFrame(run)
    else setTimeout(run, 16)
  }

  const observer = new MutationObserver(() => schedule())
  observer.observe(document.body, { childList: true, subtree: true })

  const loop = () => {
    void refresh().then(() => {
      const delay = state.phase === "running" ? CHECK_MS : 5_000
      timer = setTimeout(loop, delay)
    })
  }
  let timer = null
  loop()

  window.__ocDshPurgeDock = true
  window.ocDshPurgeDock = {
    version: VERSION,
    state,
    refresh: () => refresh(),
    open: () => {
      state.open = true
      schedule()
      return refresh()
    },
    close: () => {
      state.open = false
      schedule()
    },
    setServerBase: (url) => {
      try {
        if (url) localStorage.setItem(LS_BASE, stripBase(url))
        else localStorage.removeItem(LS_BASE)
      } catch {}
      basePromise = null
      return refresh()
    },
    destroy: () => {
      if (timer) clearTimeout(timer)
      observer.disconnect()
      for (const node of document.querySelectorAll(`[${MARK}]`)) node.remove()
      delete window.ocDshPurgeDock
      delete window.__ocDshPurgeDock
    },
  }

  console.info(`[oc-dsh-purge] v${VERSION} dock 已注入（输入框上方「破甲」按钮）。`)
})()
