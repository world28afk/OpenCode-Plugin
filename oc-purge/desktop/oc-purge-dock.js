/**
 * oc-purge — Desktop dock injector（会话输入框上方的「⚔ 破甲」按钮 + 右侧 Clean / Drill 面板）
 *
 * 上游: dsh-purge 的 client.js 在会话标题旁挂 "dsh-purge" 按钮, 打开右侧 dock
 * （Clean / Drill 两页, Light / Ink 主题）。OpenCode 桌面/Web 无官方 UI 插件接口,
 * 因此改为 DOM 注入, 尽量还原上游界面与功能。
 *
 * 面板数据与写面全部走服务端插件 RPC:
 *   POST {base}/api/rpc/purge.status/{get|set|apply|revert|rules|skills|servers|cwd}
 *
 * 用法:
 *   • 控制台: Ctrl+Shift+I → Console → 粘贴本文件全部内容。
 *   • 持久化: node scripts/patch-desktop.mjs（注入 app.asar, 可 --unpatch/--restore）。
 */

;(() => {
  "use strict"

  if (window.__ocPurgeDock) return

  const VERSION = "1.1.71"
  const RPC_ID = "purge.status"
  const MARK = "data-oc-purge"
  const LS_BASE = "oc-purge:serverBase"
  const LS_THEME = "oc-purge:theme"
  const LS_NOTICE = "oc-purge:notified"
  const LS_DRILL = "oc-purge:drillAuthorized"
  const SHARED_BASE_KEYS = ["oc-infinite-gen-4:serverBase", "oc-deepseek-banlance:serverBase"]
  const DESKTOP_PORTS = [49374, 4096, 49375, 49376, 49377, 3001]
  const CHECK_MS = 30_000

  const state = { phase: "checking", profile: null, error: null, open: false, tab: "clean", theme: "ink" }

  try {
    const savedTheme = localStorage.getItem(LS_THEME)
    if (savedTheme === "white" || savedTheme === "ink") state.theme = savedTheme
  } catch {}

  // ── 服务源探测 ───────────────────────────────────────────────────────────
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
      const profile = await call("get", {})
      state.profile = profile
      state.phase = profile && profile.plugin ? "running" : "stopped"
      state.error = profile && profile.plugin ? null : "RPC 返回异常"
    } catch (error) {
      state.profile = null
      state.phase = "stopped"
      state.error = error instanceof Error ? error.message : String(error)
    }
    schedule()
  }

  async function write(method, input) {
    state.phase = "checking"
    schedule()
    try {
      const profile = await call(method, input)
      if (profile && profile.plugin) state.profile = profile
      state.phase = "running"
      state.error = null
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error)
    }
    schedule()
  }

  // ── 主题 ─────────────────────────────────────────────────────────────────
  const THEMES = {
    ink: { bg: "#111827", fg: "#e5e7eb", muted: "#94a3b8", line: "rgba(148,163,184,0.35)", soft: "rgba(148,163,184,0.10)", accent: "#10b981" },
    white: { bg: "#f6f4ef", fg: "#1f2937", muted: "#6b7280", line: "rgba(31,41,55,0.18)", soft: "rgba(31,41,55,0.06)", accent: "#0f766e" },
  }
  const palette = () => THEMES[state.theme] ?? THEMES.ink

  function setTheme(theme) {
    state.theme = theme
    try {
      localStorage.setItem(LS_THEME, theme)
    } catch {}
    schedule()
  }

  // ── DOM helpers ──────────────────────────────────────────────────────────
  function el(tag, css, text) {
    const node = document.createElement(tag)
    if (css) node.style.cssText = css
    if (text !== undefined) node.textContent = text
    return node
  }

  function button(text, onClick, primary) {
    const p = palette()
    const node = el("button", [
      "padding:3px 10px",
      "border-radius:6px",
      `border:1px solid ${p.line}`,
      primary ? `background:${p.accent};color:#fff` : `background:${p.soft};color:inherit`,
      "font-size:11px",
      "cursor:pointer",
    ].join(";"), text)
    node.type = "button"
    node.addEventListener("click", (event) => {
      event.preventDefault()
      onClick()
    })
    return node
  }

  function row(label, value) {
    const p = palette()
    const wrap = el("div", "display:flex;justify-content:space-between;gap:12px;font-size:12px;line-height:20px")
    wrap.append(el("span", `color:${p.muted};flex:none`, label), el("span", "text-align:right;word-break:break-all", value))
    return wrap
  }

  function block(title) {
    const p = palette()
    const wrap = el("div", "margin-top:12px")
    wrap.append(el("div", `font-size:12px;font-weight:600;margin-bottom:4px;color:${p.fg}`, title))
    return wrap
  }

  function textarea(value, placeholder) {
    const p = palette()
    const node = el("textarea", [
      "width:100%",
      "min-height:110px",
      "margin-top:4px",
      "padding:6px",
      "border-radius:6px",
      `border:1px solid ${p.line}`,
      `background:${p.soft}`,
      "color:inherit",
      "font-size:11px",
      "font-family:ui-monospace,monospace",
      "resize:vertical",
      "box-sizing:border-box",
    ].join(";"))
    node.placeholder = placeholder || ""
    node.value = value || ""
    return node
  }

  // ── 面板渲染 ─────────────────────────────────────────────────────────────
  function renderClean(panel, profile) {
    const enabled = !profile || profile.enabled !== false
    const actions = el("div", "display:flex;flex-wrap:wrap;gap:6px;margin-top:8px")
    actions.append(
      button("应用", () => void write("apply", {}), true),
      button("复原", () => void write("revert", {})),
      button(enabled ? "停用注入" : "开启注入", () => void write("set", { enabled: !enabled })),
    )
    panel.append(actions)

    panel.append(
      row("状态", enabled ? "注入已开启" : "注入已停用"),
      row("提示词来源", String(profile?.promptSource ?? "-")),
      row("策略", String(profile?.policy ?? "-")),
      row("能力协议", profile?.capabilityProtocol === false ? "关" : "开"),
      row("规则集", `${profile?.ruleCount ?? 0} 个`),
      row("技能", `内置 ${profile?.skills?.bundled ?? 0} · 已装 ${(profile?.skills?.installed ?? []).length}`),
      row("自己的服务器", `${profile?.servers?.hosts?.length ?? 0} 台`),
      row("本地规则", `${(profile?.cwd?.scanned ?? []).length} 个候选`),
    )

    // 策略
    const policyBlock = block("作用域策略")
    const policies = el("div", "display:flex;gap:6px;flex-wrap:wrap")
    for (const policy of ["fallback", "strict", "always"]) {
      policies.append(button(policy === profile?.policy ? `● ${policy}` : policy, () => void write("set", { policy })))
    }
    policyBlock.append(policies)
    policyBlock.append(button("能力协议开关", () => void write("set", { capabilityProtocol: !(profile && profile.capabilityProtocol !== false) })))
    panel.append(policyBlock)

    // Prompt（等价 prompt-inject.md）
    const promptBlock = block("提示词（等价 prompt-inject.md）")
    const area = textarea(profile?.customText ?? "", "留空则用内置默认提示词")
    promptBlock.append(area)
    const promptActions = el("div", "display:flex;gap:6px;margin-top:6px")
    promptActions.append(
      button("保存", () => void write("set", { customText: area.value })),
      button("恢复默认", () => {
        area.value = ""
        void write("set", { customText: null })
      }),
    )
    promptBlock.append(promptActions)
    panel.append(promptBlock)

    // 规则库
    const rulesBlock = block("规则库")
    const rules = Array.isArray(profile?.rules) ? profile.rules : []
    const active = profile?.activeRule?.id ?? null
    for (const rule of rules) {
      const line = el("div", "display:flex;align-items:center;gap:6px;font-size:11px;margin:2px 0")
      line.append(el("span", "flex:1;word-break:break-all", `${rule.id} · ${rule.name} (${rule.bytes}B)`))
      line.append(
        active === rule.id
          ? button("已启用", () => void write("rules", { action: "deactivate" }))
          : button("启用", () => void write("rules", { action: "activate", id: rule.id })),
        button("删除", () => void write("rules", { action: "delete", id: rule.id })),
      )
      rulesBlock.append(line)
    }
    const createRow = el("div", "display:flex;gap:6px;margin-top:6px;flex-wrap:wrap")
    const idInput = el("input", `padding:3px 6px;border-radius:6px;border:1px solid ${palette().line};background:${palette().soft};color:inherit;font-size:11px`)
    idInput.placeholder = "规则 id"
    const bodyInput = textarea("", "规则正文（AGENTS.md / CLAUDE.md 内容）")
    createRow.append(idInput)
    rulesBlock.append(createRow, bodyInput)
    rulesBlock.append(button("新建/覆盖规则", () => void write("rules", { action: "upsert", id: idInput.value.trim(), name: idInput.value.trim(), content: bodyInput.value })))
    panel.append(rulesBlock)

    // 自己的服务器
    const ownBlock = block("自己的服务器")
    ownBlock.append(el("div", `font-size:10px;color:${palette().muted}`, "每行一个 IP 或完整主机名；user@host 可写；密钥/口令/网段/通配符会被丢弃。"))
    const serversArea = textarea(profile?.servers?.hosts?.length ? profile.servers.hosts.join("\n") : "", "203.0.113.10\nmy-vps.example.com")
    ownBlock.append(serversArea)
    ownBlock.append(button("保存列表", () => void write("servers", { action: "set", text: serversArea.value })))
    panel.append(ownBlock)

    // 本地规则（CWD rules）
    const cwdBlock = block("本地规则（当前目录）")
    cwdBlock.append(button("重新扫描", () => void rescanCwd(cwdBlock)))
    panel.append(cwdBlock)
    void renderCwdRows(cwdBlock, profile)

    // 技能
    const skillBlock = block("技能（Skill）")
    const bundled = profile?.skills?.ids ?? []
    const installed = profile?.skills?.installed ?? []
    skillBlock.append(row("内置", String(bundled.length)))
    if (installed.length) skillBlock.append(row("已装", installed.join(", ")))
    const skillActions = el("div", "display:flex;gap:6px;margin-top:6px;flex-wrap:wrap")
    skillActions.append(button("导出全部内置", () => void write("skills", { action: "install" })))
    skillBlock.append(skillActions)
    const importRow = el("div", "display:flex;gap:6px;margin-top:6px;flex-wrap:wrap")
    const pathInput = el("input", `flex:1;padding:3px 6px;border-radius:6px;border:1px solid ${palette().line};background:${palette().soft};color:inherit;font-size:11px`)
    pathInput.placeholder = "文件夹或 .zip 路径"
    importRow.append(pathInput, button("导入", () => void write("skills", { action: "import", path: pathInput.value.trim() })))
    skillBlock.append(importRow)
    const createSkillRow = el("div", "display:flex;gap:6px;margin-top:6px;flex-wrap:wrap")
    const skillId = el("input", `padding:3px 6px;border-radius:6px;border:1px solid ${palette().line};background:${palette().soft};color:inherit;font-size:11px`)
    skillId.placeholder = "技能 id（kebab-case）"
    createSkillRow.append(skillId, button("新建", () => void write("skills", { action: "create", id: skillId.value.trim() })))
    skillBlock.append(createSkillRow)
    panel.append(skillBlock)
  }

  async function rescanCwd(anchor) {
    try {
      const result = await call("cwd", { action: "scan" })
      const rows = await renderCwdRows(anchor, null, result)
      void rows
    } catch (error) {
      console.warn("[oc-purge] cwd scan failed:", error)
    }
  }

  async function renderCwdRows(anchor, profile, scanned) {
    const p = palette()
    let items = scanned?.items
    if (!items) {
      try {
        const result = await call("cwd", { action: "scan" })
        items = result?.items ?? []
      } catch {
        items = []
      }
    }
    // 清掉旧的候选行
    for (const node of anchor.querySelectorAll(`[${MARK}="cwd-row"]`)) node.remove()
    const selections = new Set(profile?.cwd?.selections ?? state.profile?.cwd?.selections ?? [])
    if (!items.length) {
      const empty = el("div", `font-size:11px;color:${p.muted};margin-top:4px`, "当前目录没有 AGENTS.md / CLAUDE.md")
      empty.setAttribute(MARK, "cwd-row")
      anchor.append(empty)
      return
    }
    for (const item of items) {
      const line = el("label", "display:flex;align-items:center;gap:6px;font-size:11px;margin:2px 0")
      line.setAttribute(MARK, "cwd-row")
      const box = document.createElement("input")
      box.type = "checkbox"
      box.checked = selections.has(item.path)
      box.addEventListener("change", () => {
        const next = new Set(state.profile?.cwd?.selections ?? [])
        if (box.checked) next.add(item.path)
        else next.delete(item.path)
        void write("set", { cwdSelections: [...next] })
      })
      line.append(box, el("span", "flex:1;word-break:break-all", `${item.scope} · ${item.name} · ${item.size}B`))
      line.title = item.path
      anchor.append(line)
    }
  }

  const DRILL_NOTICE = [
    "演练台（Drill）仅限：你管理的主机、离线靶标、或已获书面授权的演练。",
    "未经授权的入侵、攻击、窃取或破坏一律禁止。",
    "关闭本面板不会撤销授权；授权仅存于本机浏览器。",
  ]

  function renderDrill(panel) {
    const p = palette()
    let authorized = false
    try {
      authorized = localStorage.getItem(LS_DRILL) === "1"
    } catch {}

    if (!authorized) {
      panel.append(el("div", `font-size:12px;font-weight:600;margin-bottom:6px;color:${p.fg}`, "演练台授权"))
      for (const line of DRILL_NOTICE) panel.append(el("div", `font-size:11px;color:${p.muted};margin:2px 0`, "• " + line))
      const boxes = []
      for (const text of ["我已阅读安全与反滥用告知，并接受全部条款。", "我只会在已授权主机 / 离线靶标 / 合规演练中使用。", "我不会将其用于任何非法用途。"]) {
        const wrap = el("label", "display:flex;align-items:center;gap:6px;font-size:11px;margin:4px 0")
        const box = document.createElement("input")
        box.type = "checkbox"
        boxes.push(box)
        wrap.append(box, el("span", "", text))
        panel.append(wrap)
      }
      panel.append(
        button("确认授权并打开 Drill", () => {
          if (!boxes.every((box) => box.checked)) {
            state.error = "请勾选全部三项"
            schedule()
            return
          }
          try {
            localStorage.setItem(LS_DRILL, "1")
          } catch {}
          state.error = null
          schedule()
        }, true),
      )
      return
    }

    const profile = state.profile
    panel.append(el("div", `font-size:12px;font-weight:600;margin-bottom:6px;color:${p.fg}`, "演练台 · 资源"))
    panel.append(
      row("内置红队技能", String(profile?.skills?.bundled ?? 0)),
      row("已装技能", String((profile?.skills?.installed ?? []).length)),
      row("靶标白名单", `${profile?.servers?.hosts?.length ?? 0} 台`),
      row("上游 Drill 授权声明", "docs/drill-auth-legal.html"),
    )
    if (Array.isArray(profile?.skills?.ids)) {
      panel.append(el("div", `font-size:10px;color:${p.muted};margin-top:6px;word-break:break-all`, "技能: " + profile.skills.ids.join(", ")))
    }
    panel.append(el("div", `font-size:10px;color:${p.muted};margin-top:8px`, "说明: 上游「assets / 环境适配 / 报告回放」依赖 DSH 宿主面，OpenCode 无对应接口；此处保留技能资产与靶标白名单，其余以工具实现。"))
  }

  function renderDock(panel) {
    const p = palette()
    panel.replaceChildren()

    const head = el("div", "display:flex;align-items:center;gap:8px")
    head.append(el("div", "font-size:13px;font-weight:600;flex:1", `⚔ 破甲 dsh-purge v${VERSION}`))
    head.append(
      button(state.theme === "white" ? "Light" : "Ink", () => setTheme(state.theme === "white" ? "ink" : "white")),
      button("×", () => {
        state.open = false
        schedule()
      }),
    )
    panel.append(head)

    const tabs = el("div", "display:flex;gap:6px;margin:6px 0")
    for (const [id, label] of [["clean", "Clean"], ["drill", "Drill"]]) {
      tabs.append(button(state.tab === id ? `● ${label}` : label, () => {
        state.tab = id
        schedule()
      }))
    }
    panel.append(tabs)

    const statusText =
      state.phase === "running"
        ? `运行中 · ${state.profile && state.profile.enabled === false ? "注入已停用" : "注入已开启"}`
        : state.phase === "checking"
          ? "检测中…"
          : `未连接${state.error ? " · " + state.error : ""}`
    panel.append(el("div", `font-size:11px;color:${state.phase === "running" ? p.accent : p.muted}`, statusText))

    const body = el("div", "")
    if (state.tab === "drill") renderDrill(body)
    else renderClean(body, state.profile)
    panel.append(body)
  }

  function ensureDock() {
    let panel = document.querySelector(`[${MARK}="dock"]`)
    if (!state.open) {
      if (panel) panel.remove()
      return
    }
    const p = palette()
    if (!panel) {
      panel = el("aside", "")
      panel.setAttribute(MARK, "dock")
      panel.style.cssText = [
        "position:fixed",
        "top:56px",
        "right:12px",
        "width:360px",
        "max-height:calc(100vh - 80px)",
        "overflow:auto",
        "z-index:2147483000",
        "padding:12px",
        "border-radius:10px",
        `border:1px solid ${p.line}`,
        `background:${p.bg}`,
        `color:${p.fg}`,
        "box-shadow:0 8px 28px rgba(0,0,0,0.35)",
        "font-family:inherit",
        "box-sizing:border-box",
      ].join(";")
      document.body.append(panel)
    }
    panel.style.borderColor = p.line
    panel.style.background = p.bg
    panel.style.color = p.fg
    renderDock(panel)
  }

  function ensureButton() {
    const composer = document.querySelector('[data-component="composer"]')
    const host = composer && composer.parentElement
    if (!composer || !host) return null
    let node = host.querySelector(`[${MARK}="button"]`)
    if (!node) {
      node = document.createElement("button")
      node.setAttribute(MARK, "button")
      node.type = "button"
      node.style.cssText = [
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
      node.addEventListener("click", (event) => {
        event.preventDefault()
        state.open = !state.open
        schedule()
        void refresh()
      })
      host.insertBefore(node, composer)
    }
    node.textContent = state.phase === "running" ? "⚔ 破甲" : "⚔ 破甲 · 未连接"
    return node
  }

  // ── 首次使用告知（等价上游 welcome notice） ──────────────────────────────
  function ensureNotice() {
    let notified = true
    try {
      notified = localStorage.getItem(LS_NOTICE) === "1"
    } catch {}
    if (notified) return
    if (document.querySelector(`[${MARK}="notice"]`)) return
    const p = palette()
    const overlay = el("div", `position:fixed;inset:0;z-index:2147483100;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.45)`)
    overlay.setAttribute(MARK, "notice")
    const card = el("div", `width:min(420px,92vw);padding:16px;border-radius:10px;border:1px solid ${p.line};background:${p.bg};color:${p.fg};font-family:inherit`)
    card.append(
      el("div", "font-size:14px;font-weight:600;margin-bottom:6px", "使用告知"),
      el("div", `font-size:11px;color:${p.muted};margin-bottom:8px`, "oc-purge 是 dsh-purge 的 OpenCode 移植：本地自有主机上的提示词/规则/技能管理与红队评测。免费非商业，保留上游署名。"),
      el("div", `font-size:11px;color:${p.muted};margin-bottom:8px`, "来源: https://github.com/YuJunZhiXue/dsh-purge"),
      el("div", `font-size:11px;color:${p.muted};margin-bottom:8px`, "不得用于未授权攻击、入侵、数据窃取或破坏；不得商业倒卖。"),
    )
    const ack = el("label", "display:flex;align-items:center;gap:6px;font-size:11px;margin-bottom:10px")
    const box = document.createElement("input")
    box.type = "checkbox"
    ack.append(box, el("span", "", "我已阅读并理解本告知，将合法使用本插件。"))
    card.append(ack)
    card.append(
      button("我已知晓 · 继续", () => {
        if (!box.checked) return
        try {
          localStorage.setItem(LS_NOTICE, "1")
        } catch {}
        overlay.remove()
        void write("set", { noticeAck: true })
      }, true),
    )
    overlay.append(card)
    document.body.append(overlay)
  }

  let scheduled = false
  function schedule() {
    if (scheduled) return
    scheduled = true
    const run = () => {
      scheduled = false
      try {
        ensureNotice()
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

  let timer = null
  const loop = () => {
    void refresh().then(() => {
      const delay = state.phase === "running" ? CHECK_MS : 5_000
      timer = setTimeout(loop, delay)
    })
  }
  loop()

  window.__ocPurgeDock = true
  window.ocPurgeDock = {
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
      delete window.ocPurgeDock
      delete window.__ocPurgeDock
    },
  }

  console.info(`[oc-purge] v${VERSION} dock 已注入（输入框上方「破甲」按钮；Clean / Drill 双页）。`)
})()
