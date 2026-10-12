/**
 * oc-purge — Desktop dock（输入框上方「破甲」按钮 + 右侧 Clean / Drill 面板）
 *
 * 上游 dsh-purge：会话标题旁 dock、Clean / Drill 两页、Light / Ink 主题、
 * 提示词方案（rules/）一键切换、按模型换提示词。OpenCode 桌面/Web 无官方 UI 接口，
 * 故以 DOM 注入实现等价界面，并适配 OpenCode 语义（session.hook context / RPC / skills）。
 *
 * 稳定性设计（避免「点了没反应」）：
 *   • 面板只创建一次；仅当数据签名变化时重建内容；编辑中不重建；重建保留输入与滚动。
 *   • MutationObserver 只做保活（补按钮/面板），不触发重建。
 *
 * 数据通道（自包含，不读其它插件的键）：
 *   POST {base}/api/rpc/purge.status/{get|set|apply|revert|rules|skills|servers|cwd}
 */

;(() => {
  "use strict"

  if (window.__ocPurgeDock) return

  const VERSION = "1.1.71"
  const RPC_ID = "purge.status"
  const MARK = "data-oc-purge"
  const STYLE_ID = "oc-purge-style"
  const LS_BASE = "oc-purge:serverBase"
  const LS_THEME = "oc-purge:theme"
  const LS_NOTICE = "oc-purge:noticed"
  const LS_DRILL = "oc-purge:drillAuthorized"
  const CHECK_MS = 20_000
  const RETRY_MS = 4_000

  const state = {
    phase: "checking",
    error: null,
    profile: null,
    open: false,
    tab: "clean",
    theme: "ink",
    busy: false,
    toast: null,
  }
  const ui = {
    editor: "",
    editorFor: "",
    newId: "",
    newName: "",
    bindKind: "model",
    bindKey: "",
    bindScheme: "",
    importPath: "",
    skillId: "",
    serverBase: "",
  }
  try {
    const t = localStorage.getItem(LS_THEME)
    if (t === "white" || t === "ink") state.theme = t
    ui.serverBase = localStorage.getItem(LS_BASE) || ""
  } catch {}

  // ── 自包含服务源发现 + 位置捕获 ───────────────────────────────────────────
  const captured = new Set()
  const locations = []
  const rememberLocation = (value) => {
    if (typeof value === "string" && value.trim() && !locations.includes(value)) locations.push(value)
  }
  const currentLocation = () => (locations.length ? locations[locations.length - 1] : null)
  const recordUrl = (value) => {
    try {
      const url = typeof value === "string" ? value : value && typeof value.url === "string" ? value.url : ""
      if (!url) return
      const absolute = new URL(url, location.href)
      if (!/^https?:$/.test(absolute.protocol)) return
      if (absolute.pathname.indexOf("/api/") === -1) return
      captured.add(absolute.protocol + "//" + absolute.host)
      const loc = absolute.searchParams.get("location") || absolute.searchParams.get("location[directory]")
      if (loc) rememberLocation(loc)
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

  const stripBase = (v) => String(v || "").replace(/\/+$/, "")
  let basePromise = null

  async function probeBase() {
    const candidates = []
    try {
      const own = localStorage.getItem(LS_BASE)
      if (own) candidates.push(stripBase(own))
    } catch {}
    for (const origin of captured) candidates.push(stripBase(origin))
    for (const port of [49374, 4096, 49375, 49376, 49377, 3001]) candidates.push(`http://127.0.0.1:${port}`)
    const attempt = async (base) => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 1200)
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
      ui.serverBase = hit
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

  async function call(method, input) {
    const base = await baseURL()
    if (!base) throw new Error("未连接服务（可在「连接」里手填地址）")
    const loc = currentLocation()
    const attempt = async (query) => {
      const response = await fetch(`${base}/api/rpc/${RPC_ID}/${method}${query}`, {
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
    // RPC 的 location 查询是对象（location[directory]），带上才能命中当前会话所在的插件实例。
    if (loc) {
      try {
        return await attempt(`?location[directory]=${encodeURIComponent(loc)}`)
      } catch {
        // 某些位置不是目录（或已失效）→ 退回无 location
      }
    }
    return attempt("")
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
    syncEditor()
    renderNow()
  }

  async function act(method, input, okMessage) {
    state.busy = true
    renderNow()
    try {
      const profile = await call(method, input)
      if (profile && profile.plugin) state.profile = profile
      state.phase = "running"
      state.error = null
      syncEditor()
      toast(okMessage || "已完成", "ok")
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error)
      toast(`失败：${state.error}`, "bad")
    }
    state.busy = false
    renderNow()
  }

  function syncEditor() {
    const p = state.profile
    const target = p && p.activeScheme ? `scheme:${p.activeScheme.id}` : "custom"
    if (ui.editorFor !== target) {
      ui.editor = p ? (p.activeScheme ? p.activeSchemeText || "" : p.customText || "") : ""
      ui.editorFor = target
    }
  }

  function toast(message, tone) {
    state.toast = message ? { message, tone: tone || "ok", at: Date.now() } : null
  }

  // ── 样式（注入一次；index.html 无 CSP meta, 允许内联 <style>） ─────────────
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return
    const style = document.createElement("style")
    style.id = STYLE_ID
    style.textContent = `
.ocp-root{--bg:#0b1220;--panel:#111c33;--panel2:#152341;--fg:#e6ebf5;--muted:#8f9cb3;--line:rgba(143,156,179,.22);
  --accent:#22c55e;--accent-fg:#052e16;--info:#38bdf8;--warn:#f59e0b;--danger:#f87171;--shadow:0 18px 48px rgba(2,6,23,.55);
  position:fixed;top:56px;right:14px;width:392px;max-height:calc(100vh - 78px);z-index:2147483600;overflow:auto;box-sizing:border-box;
  padding:14px;border-radius:16px;border:1px solid var(--line);background:var(--panel);color:var(--fg);
  font-family:ui-sans-serif,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;font-size:13px;line-height:1.5;
  box-shadow:var(--shadow);pointer-events:auto;backdrop-filter:blur(6px)}
.ocp-root[data-theme="white"]{--bg:#f6f7f9;--panel:#ffffff;--panel2:#f2f4f7;--fg:#0f172a;--muted:#64748b;--line:rgba(15,23,42,.12);
  --accent:#0f766e;--accent-fg:#ffffff;--info:#0369a1;--warn:#b45309;--danger:#dc2626;--shadow:0 18px 48px rgba(15,23,42,.18)}
.ocp-root *{box-sizing:border-box}
.ocp-root::-webkit-scrollbar{width:8px}.ocp-root::-webkit-scrollbar-thumb{background:var(--line);border-radius:8px}
.ocp-head{display:flex;align-items:center;gap:8px}
.ocp-logo{width:26px;height:26px;border-radius:8px;display:grid;place-items:center;background:linear-gradient(135deg,var(--accent),var(--info));color:#fff;font-size:14px}
.ocp-title{flex:1;min-width:0}
.ocp-title b{font-size:14px;letter-spacing:.2px}
.ocp-title small{display:block;color:var(--muted);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ocp-icobtn{border:1px solid var(--line);background:var(--panel2);color:var(--fg);border-radius:9px;width:28px;height:28px;cursor:pointer;font-size:12px}
.ocp-icobtn:hover{border-color:var(--accent)}
.ocp-tabs{display:flex;gap:6px;margin:12px 0 10px;background:var(--panel2);border:1px solid var(--line);border-radius:12px;padding:4px}
.ocp-tab{flex:1;border:0;background:transparent;color:var(--muted);border-radius:9px;padding:6px 8px;font-size:12px;cursor:pointer;font-weight:600}
.ocp-tab.on{background:var(--panel);color:var(--fg);box-shadow:0 1px 3px rgba(0,0,0,.18)}
.ocp-status{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:10px}
.ocp-chip{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:999px;border:1px solid var(--line);background:var(--panel2);font-size:11px;color:var(--muted)}
.ocp-chip.ok{color:var(--accent);border-color:color-mix(in srgb,var(--accent) 45%,var(--line))}
.ocp-chip.bad{color:var(--danger);border-color:color-mix(in srgb,var(--danger) 45%,var(--line))}
.ocp-chip.info{color:var(--info);border-color:color-mix(in srgb,var(--info) 45%,var(--line))}
.ocp-chip.warn{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 45%,var(--line))}
.ocp-dot{width:7px;height:7px;border-radius:50%;background:var(--muted);flex:none}
.ocp-dot.on{background:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 25%,transparent)}
.ocp-card{border:1px solid var(--line);background:var(--panel2);border-radius:13px;padding:11px 12px;margin-bottom:10px}
.ocp-card>h4{margin:0 0 2px;font-size:12.5px;display:flex;align-items:center;gap:6px}
.ocp-card>p{margin:0 0 8px;color:var(--muted);font-size:11px;line-height:1.55}
.ocp-row{display:flex;align-items:center;gap:8px;padding:7px 8px;border:1px solid var(--line);border-radius:10px;background:var(--panel);margin-top:6px}
.ocp-row.on{border-color:color-mix(in srgb,var(--accent) 55%,var(--line));box-shadow:inset 3px 0 0 var(--accent)}
.ocp-row-main{flex:1;min-width:0;cursor:pointer}
.ocp-row-main b{font-size:12px;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ocp-row-main span{color:var(--muted);font-size:10.5px;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ocp-ops{display:flex;gap:6px;flex:none;flex-wrap:wrap;justify-content:flex-end}
.ocp-btn{border:1px solid var(--line);background:var(--panel);color:var(--fg);border-radius:9px;padding:5px 11px;font-size:11.5px;cursor:pointer;font-weight:600;white-space:nowrap;transition:border-color .12s,background .12s}
.ocp-btn:hover{border-color:var(--accent)}
.ocp-btn.primary{background:var(--accent);color:var(--accent-fg);border-color:transparent}
.ocp-btn.primary:hover{filter:brightness(1.06)}
.ocp-btn.ghost{background:transparent}
.ocp-btn.danger{color:var(--danger);border-color:color-mix(in srgb,var(--danger) 40%,var(--line))}
.ocp-btn.sm{padding:3px 8px;font-size:11px;border-radius:8px}
.ocp-btn:disabled{opacity:.45;cursor:not-allowed}
.ocp-seg{display:inline-flex;gap:4px;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:3px}
.ocp-seg button{border:0;background:transparent;color:var(--muted);border-radius:7px;padding:4px 10px;font-size:11px;cursor:pointer;font-weight:600}
.ocp-seg button.on{background:var(--accent);color:var(--accent-fg)}
.ocp-input,.ocp-area{width:100%;border:1px solid var(--line);background:var(--panel);color:var(--fg);border-radius:9px;padding:7px 9px;font-size:12px;outline:none}
.ocp-input:focus,.ocp-area:focus{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 20%,transparent)}
.ocp-area{min-height:120px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:1.55;resize:vertical}
.ocp-inline{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.ocp-grid2{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.ocp-muted{color:var(--muted);font-size:10.5px;line-height:1.5}
.ocp-toast{margin-top:10px;min-height:16px;font-size:11.5px}
.ocp-kv{display:flex;justify-content:space-between;gap:12px;padding:3px 0;font-size:11.5px}
.ocp-kv span:first-child{color:var(--muted)}
.ocp-gate label{display:flex;align-items:center;gap:8px;margin:6px 0;font-size:11.5px;cursor:pointer}
.ocp-switch{display:inline-flex;align-items:center;gap:8px;font-size:11.5px;cursor:pointer}
.ocp-switch i{width:34px;height:18px;border-radius:999px;background:var(--line);position:relative;transition:background .15s}
.ocp-switch i::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--panel);transition:left .15s}
.ocp-switch.on i{background:var(--accent)}.ocp-switch.on i::after{left:18px}
`
    ;(document.head || document.documentElement).append(style)
  }

  // ── DOM helpers ──────────────────────────────────────────────────────────
  const el = (tag, cls, text) => {
    const node = document.createElement(tag)
    if (cls) node.className = cls
    if (text !== undefined) node.textContent = text
    return node
  }
  function button(text, onClick, options = {}) {
    const cls = ["ocp-btn", options.primary ? "primary" : "", options.ghost ? "ghost" : "", options.danger ? "danger" : "", options.sm ? "sm" : ""].join(" ")
    const node = el("button", cls, text)
    node.type = "button"
    if (options.title) node.title = options.title
    if (options.disabled || state.busy) node.disabled = true
    else
      node.addEventListener("click", (event) => {
        event.preventDefault()
        event.stopPropagation()
        onClick()
      })
    return node
  }
  const chip = (text, tone) => el("span", `ocp-chip ${tone || ""}`, text)
  const dot = (on) => el("span", `ocp-dot ${on ? "on" : ""}`)
  function card(title, hint) {
    const node = el("section", "ocp-card")
    node.append(el("h4", "", title))
    if (hint) node.append(el("p", "", hint))
    return node
  }
  function input(placeholder, value, onInput) {
    const node = el("input", "ocp-input")
    node.placeholder = placeholder || ""
    node.value = value || ""
    if (onInput) node.addEventListener("input", () => onInput(node.value))
    return node
  }
  function field(name, node) {
    node.setAttribute(`${MARK}-field`, name)
    return node
  }
  const kv = (k, v) => {
    const row = el("div", "ocp-kv")
    row.append(el("span", "", k), el("span", "", String(v)))
    return row
  }

  // ── Clean 页 ─────────────────────────────────────────────────────────────
  function renderClean(body) {
    const p = state.profile
    const enabled = !p || p.enabled !== false
    const schemes = p && Array.isArray(p.schemes) ? p.schemes : []
    const activeId = p && p.activeScheme ? p.activeScheme.id : null

    // 快速操作
    const quick = card("快速操作", "应用＝开注入；复原＝清空方案/手写文本与模型绑定，回落内置默认提示词。")
    const qrow = el("div", "ocp-inline")
    qrow.append(
      button("应用", () => act("apply", {}, "已应用"), { primary: true }),
      button("复原默认", () => act("revert", {}, "已复原为内置默认")),
      button(enabled ? "停用注入" : "开启注入", () => act("set", { enabled: !enabled }, enabled ? "已停用" : "已开启")),
    )
    quick.append(qrow)
    const seg = el("div", "ocp-inline", undefined)
    seg.style.marginTop = "8px"
    const policySeg = el("div", "ocp-seg")
    for (const item of ["fallback", "strict", "always"]) {
      const b = el("button", item === p?.policy ? "on" : "", item)
      b.type = "button"
      b.title = { fallback: "有用户文本用用户文本，否则内置默认", strict: "只用用户文本", always: "用户文本后再追加内置默认" }[item]
      b.addEventListener("click", () => act("set", { policy: item }, `策略：${item}`))
      policySeg.append(b)
    }
    seg.append(policySeg)
    const capOn = !(p && p.capabilityProtocol === false)
    const capSwitch = el("span", `ocp-switch ${capOn ? "on" : ""}`)
    capSwitch.append(el("i"), el("span", "", "能力协议"))
    capSwitch.addEventListener("click", () => act("set", { capabilityProtocol: !capOn }, "能力协议已切换"))
    seg.append(capSwitch)
    quick.append(seg)
    body.append(quick)

    // 提示词方案（一键切换）
    const schemesCard = card("提示词方案（一键切换）", "点方案即可切换；模型绑定可让不同模型用不同方案。当前生效：" + (p?.promptSource ?? "-") + (activeId ? `（方案 ${activeId}）` : "（内置默认）") + "。")
    // 内置默认（恒定可用）
    const pinned = el("div", `ocp-row ${activeId ? "" : "on"}`)
    const pmain = el("div", "ocp-row-main")
    pmain.append(el("b", "", "内置默认（破甲提示词）"), el("span", "", `dsh-purge v${VERSION} 捆绑默认 · ${p?.defaultPromptBytes ?? 0}B · 恒定可用`))
    pmain.title = "点击使用内置默认提示词"
    pmain.addEventListener("click", () => act("rules", { action: "reset" }, "已切到内置默认"))
    const pops = el("div", "ocp-ops")
    pops.append(
      activeId
        ? button("使用", () => act("rules", { action: "reset" }, "已切到内置默认"), { sm: true, primary: true })
        : button("使用中", () => {}, { sm: true, disabled: true }),
      button("复制为方案", () => {
        const id = ((ui.newId || "").trim() || "default").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "default"
        void act("rules", { action: "save", id, name: (ui.newName || "").trim() || "默认破甲", content: p?.defaultPromptText || "" }, `已复制内置默认为方案 ${id}`).then(() =>
          act("rules", { action: "use", id }, `已切换到 ${id}`),
        )
      }, { sm: true }),
    )
    pinned.append(pmain, pops)
    schemesCard.append(pinned)
    if (!schemes.length) schemesCard.append(el("div", "ocp-muted", "还没有自定义方案。点上面「复制为方案」可把内置默认存成可编辑方案；再「另存为方案」即可做多套（按模型切换）。"))
    for (const s of schemes) {
      const row = el("div", `ocp-row ${s.id === activeId ? "on" : ""}`)
      const main = el("div", "ocp-row-main")
      main.append(el("b", "", s.name || s.id), el("span", "", `${s.id} · ${s.bytes}B · ${s.preview || ""}`))
      main.title = "点击切换到此方案"
      main.addEventListener("click", () => act("rules", { action: "use", id: s.id }, `已切换到 ${s.id}`))
      const ops = el("div", "ocp-ops")
      ops.append(
        s.id === activeId ? button("使用中", () => {}, { sm: true, disabled: true }) : button("使用", () => act("rules", { action: "use", id: s.id }, `已切换到 ${s.id}`), { sm: true, primary: true }),
        button("编辑", () => {
          void act("rules", { action: "use", id: s.id }, `编辑中：${s.id}`)
        }, { sm: true }),
        button("复制", () => {
          const newId = `${s.id}-copy`
          void act("rules", { action: "duplicate", id: s.id, newId }, `已复制为 ${newId}`)
        }, { sm: true }),
        button("删除", () => act("rules", { action: "delete", id: s.id }, `已删除 ${s.id}`), { sm: true, danger: true }),
      )
      row.append(main, ops)
      schemesCard.append(row)
    }
    // 另存为 / 新建
    const saveRow = el("div", "ocp-inline")
    saveRow.style.marginTop = "8px"
    saveRow.append(
      field("newId", input("新方案 id（kebab-case）", ui.newId, (v) => (ui.newId = v))),
      field("newName", input("显示名（可选）", ui.newName, (v) => (ui.newName = v))),
    )
    const saveOps = el("div", "ocp-inline")
    saveOps.style.marginTop = "6px"
    saveOps.append(
      button("另存为方案", () => {
        const id = (ui.newId || "").trim()
        if (!id) return toast("请填写方案 id", "warn"), renderNow()
        void act("rules", { action: "save", id, name: (ui.newName || id).trim(), content: ui.editor }, `已保存并切换：${id}`).then(() =>
          act("rules", { action: "use", id }, `已切换到 ${id}`),
        )
      }, { primary: true }),
      button("新建空方案", () => {
        const id = (ui.newId || "").trim()
        if (!id) return toast("请填写方案 id", "warn"), renderNow()
        void act("rules", { action: "save", id, name: (ui.newName || id).trim(), content: "" }, `已新建：${id}`)
      }),
      button("恢复内置默认", () => act("rules", { action: "reset" }, "已清除启用方案")),
    )
    schemesCard.append(saveRow, saveOps)
    body.append(schemesCard)

    // 提示词内容
    const editorCard = card(
      p && p.activeScheme ? `提示词内容 · 方案 ${p.activeScheme.id}` : "提示词内容 · 手写模式",
      p && p.activeScheme ? "保存即更新该方案（所有使用它的模型/agent 同步生效）。" : "未启用方案时，这里作为手写提示词；保存后作为注入来源。",
    )
    const area = field("editor", el("textarea", "ocp-area"))
    area.value = ui.editor
    area.placeholder = "在此编辑提示词正文…"
    area.addEventListener("input", () => {
      ui.editor = area.value
      const meter = editorCard.querySelector("[data-ocp-meter]")
      if (meter) meter.textContent = `${area.value.length} 字符`
    })
    const meter = el("div", "ocp-muted", `${ui.editor.length} 字符`)
    meter.setAttribute("data-ocp-meter", "")
    const editorOps = el("div", "ocp-inline")
    editorOps.style.marginTop = "6px"
    editorOps.append(
      button("保存", () => {
        if (p && p.activeScheme) void act("rules", { action: "save", id: p.activeScheme.id, name: p.activeScheme.name, content: ui.editor }, "已保存方案")
        else void act("set", { customText: ui.editor }, "已保存手写提示词")
      }, { primary: true }),
      button("载入内置默认", () => {
        ui.editor = (p && p.defaultPromptText) || ""
        ui.editorFor = "custom"
        signature = ""
        renderNow()
        toast("已载入内置默认到编辑框（保存即写入手写文本）", "ok")
      }),
      button("清空", () => {
        ui.editor = ""
        signature = ""
        renderNow()
      }),
    )
    editorCard.append(area, meter, editorOps)
    body.append(editorCard)

    // 模型绑定
    const bindCard = card("模型绑定（不同模型用不同方案）", "匹配顺序：provider/model → model → agent。当前模型：" + (p?.lastModel || "未检测到（发一条消息后再看）") + "。")
    const bindings = p && p.bindings ? p.bindings : { model: {}, agent: {} }
    const entries = [...Object.entries(bindings.model || {}).map(([k, v]) => ({ kind: "model", key: k, scheme: v })), ...Object.entries(bindings.agent || {}).map(([k, v]) => ({ kind: "agent", key: k, scheme: v }))]
    if (!entries.length) bindCard.append(el("div", "ocp-muted", "暂无绑定。"))
    for (const item of entries) {
      const row = el("div", "ocp-row")
      const main = el("div", "ocp-row-main")
      main.append(el("b", "", `${item.key}`), el("span", "", `${item.kind} → 方案 ${item.scheme}`))
      const ops = el("div", "ocp-ops")
      ops.append(button("解绑", () => act("rules", { action: "unbind", kind: item.kind, key: item.key }, "已解绑"), { sm: true, danger: true }))
      row.append(main, ops)
      bindCard.append(row)
    }
    const bindRow = el("div", "ocp-inline")
    bindRow.style.marginTop = "8px"
    const kindSel = el("select", "ocp-input")
    kindSel.style.width = "92px"
    for (const k of ["model", "agent"]) {
      const opt = el("option", "", k)
      opt.value = k
      if (ui.bindKind === k) opt.selected = true
      kindSel.append(opt)
    }
    kindSel.addEventListener("change", () => (ui.bindKind = kindSel.value))
    bindRow.append(kindSel, field("bindKey", input(ui.bindKind === "model" ? "provider/model 或 model" : "agent id", ui.bindKey, (v) => (ui.bindKey = v))))
    const schemeSel = el("select", "ocp-input")
    schemeSel.style.maxWidth = "150px"
    for (const s of schemes) {
      const opt = el("option", "", `${s.name || s.id}`)
      opt.value = s.id
      if (ui.bindScheme === s.id) opt.selected = true
      schemeSel.append(opt)
    }
    schemeSel.addEventListener("change", () => (ui.bindScheme = schemeSel.value))
    bindRow.append(schemeSel)
    bindCard.append(bindRow)
    bindCard.append(
      button("绑定", () => {
        const key = (ui.bindKey || "").trim()
        const scheme = ui.bindScheme || (schemes[0] && schemes[0].id)
        if (!key) return toast("请填写匹配键", "warn"), renderNow()
        if (!scheme) return toast("请先创建方案", "warn"), renderNow()
        void act("rules", { action: "bind", kind: ui.bindKind, key, id: scheme }, `已绑定 ${key} → ${scheme}`)
      }, { primary: true }),
    )
    body.append(bindCard)

    // 自己的服务器
    const own = card("自己的服务器（白名单）", "每行一个 IP 或完整主机名；可写 user@host；密钥/口令/网段/通配符自动丢弃。")
    const serversArea = field("servers", el("textarea", "ocp-area"))
    serversArea.style.minHeight = "72px"
    serversArea.value = (p?.servers?.hosts || []).join("\n")
    serversArea.addEventListener("input", () => (ui.editorServers = serversArea.value))
    const ownOps = el("div", "ocp-inline")
    ownOps.style.marginTop = "6px"
    ownOps.append(button("保存列表", () => act("servers", { action: "set", text: serversArea.value }, "白名单已保存"), { primary: true }), el("span", "ocp-muted", `当前 ${(p?.servers?.hosts || []).length} 台`))
    own.append(serversArea, ownOps)
    body.append(own)

    // 本地规则
    const cwd = card("本地规则（当前目录 / 祖先）", "扫描 AGENTS.md / CLAUDE.md；勾选后，当没有任何方案/手写文本时作为注入来源。")
    const cwdOps = el("div", "ocp-inline")
    cwdOps.append(
      button("重新扫描", () => rescanCwd(cwd)),
      button("全部取消", () => act("set", { cwdSelections: [] }, "已取消全部勾选")),
      el("span", "ocp-muted", `已选 ${(p?.cwd?.selections || []).length}`),
    )
    cwd.append(cwdOps)
    const cwdList = el("div", "")
    cwdList.setAttribute(`${MARK}-cwd`, "")
    cwd.append(cwdList)
    fillCwd(cwdList)
    body.append(cwd)

    // 技能
    const skills = card("技能（Skill）", "内置＝随插件捆绑；导出/导入到 OpenCode 技能目录（.opencode/skills/<id>/SKILL.md）。")
    skills.append(el("div", "ocp-muted", `内置 ${p?.skills?.bundled ?? 0} · 已装 ${(p?.skills?.installed || []).length}`))
    const skOps = el("div", "ocp-inline")
    skOps.style.marginTop = "6px"
    skOps.append(button("导出全部内置", () => act("skills", { action: "install" }, "已导出内置技能")))
    const importRow = el("div", "ocp-inline")
    importRow.style.marginTop = "6px"
    importRow.append(field("importPath", input("文件夹或 .zip 路径", ui.importPath, (v) => (ui.importPath = v))), button("导入", () => act("skills", { action: "import", path: (ui.importPath || "").trim() }, "已导入技能")))
    const createRow = el("div", "ocp-inline")
    createRow.style.marginTop = "6px"
    createRow.append(field("skillId", input("新建技能 id（kebab-case）", ui.skillId, (v) => (ui.skillId = v))), button("新建", () => act("skills", { action: "create", id: (ui.skillId || "").trim() }, "已新建技能")))
    skills.append(skOps, importRow, createRow)
    if ((p?.skills?.installed || []).length) skills.append(el("div", "ocp-muted", "已装：" + (p.skills.installed || []).join(", ")))
    body.append(skills)

    // 连接
    const conn = card("连接", "插件自包含探测；失败可手填（如 http://127.0.0.1:49374）。RPC 会自动带上当前会话位置。")
    conn.append(kv("服务位置", (p && p.directory) || "未知"))
    const connRow = el("div", "ocp-inline")
    connRow.append(
      field("serverBase", input("http://127.0.0.1:49374", ui.serverBase, (v) => (ui.serverBase = v))),
      button("连接", () => {
        try {
          if ((ui.serverBase || "").trim()) localStorage.setItem(LS_BASE, stripBase(ui.serverBase.trim()))
          else localStorage.removeItem(LS_BASE)
        } catch {}
        basePromise = null
        void refresh().then(() => toast("已按新地址重连", "ok"))
      }),
    )
    conn.append(connRow)
    body.append(conn)
  }

  function fillCwd(node) {
    node.replaceChildren()
    const p = state.profile
    const items = (p?.cwd?.scanned || []).slice()
    const selections = new Set(p?.cwd?.selections || [])
    if (!items.length) {
      node.append(el("div", "ocp-muted", "当前目录没有 AGENTS.md / CLAUDE.md"))
      return
    }
    for (const item of items) {
      const row = el("label", "ocp-gate")
      row.style.margin = "4px 0"
      const box = document.createElement("input")
      box.type = "checkbox"
      box.checked = selections.has(item.path)
      box.addEventListener("change", () => {
        const next = new Set(state.profile?.cwd?.selections || [])
        if (box.checked) next.add(item.path)
        else next.delete(item.path)
        void act("set", { cwdSelections: [...next] }, box.checked ? "已加入" : "已移除")
      })
      row.title = item.path
      row.append(box, el("span", "", `${item.scope} · ${item.name} · ${item.size}B`))
      node.append(row)
    }
  }

  async function rescanCwd(anchor) {
    let node = anchor.querySelector(`[${MARK}-cwd]`)
    if (!node) {
      node = el("div", "")
      node.setAttribute(`${MARK}-cwd`, "")
      anchor.append(node)
    }
    try {
      const result = await call("cwd", { action: "scan" })
      if (state.profile) {
        state.profile.cwd = state.profile.cwd || {}
        state.profile.cwd.scanned = result.items || []
      }
      fillCwd(node)
      toast(`已扫描：${(result.items || []).length} 个候选`, "ok")
    } catch (error) {
      toast(`扫描失败：${error instanceof Error ? error.message : error}`, "bad")
      renderNow()
    }
  }

  // ── Drill 页 ─────────────────────────────────────────────────────────────
  const DRILL_NOTICE = [
    "演练台（Drill）仅限：你管理的主机、离线靶标、或已获书面授权的演练。",
    "未经授权的入侵、攻击、窃取或破坏一律禁止。",
    "授权只存于本机浏览器；关闭面板不会撤销。",
  ]

  function renderDrill(body) {
    let authorized = false
    try {
      authorized = localStorage.getItem(LS_DRILL) === "1"
    } catch {}
    if (!authorized) {
      const gate = card("演练台授权", "首次进入 Drill 需确认以下条款（Clean 页不需要）。")
      for (const line of DRILL_NOTICE) gate.append(el("div", "ocp-muted", "• " + line))
      const boxes = []
      for (const text of ["我已阅读安全与反滥用告知，并接受全部条款。", "我只在已授权主机 / 离线靶标 / 合规演练中使用。", "我不会将其用于任何非法用途。"]) {
        const wrap = el("label", "ocp-gate")
        const box = document.createElement("input")
        box.type = "checkbox"
        boxes.push(box)
        wrap.append(box, el("span", "", text))
        gate.append(wrap)
      }
      gate.append(
        button("确认授权并打开 Drill", () => {
          if (!boxes.every((b) => b.checked)) {
            toast("请勾选全部三项", "warn")
            return renderNow()
          }
          try {
            localStorage.setItem(LS_DRILL, "1")
          } catch {}
          toast("已授权", "ok")
          signature = ""
          renderNow()
        }, { primary: true }),
      )
      body.append(gate)
      return
    }
    const p = state.profile
    const info = card("演练台 · 资源", "OpenCode 无 DSH 的演练台事实库 / 报告回放接口；此处保留技能资产、靶标白名单与授权声明。")
    info.append(
      kv("内置红队技能", p?.skills?.bundled ?? 0),
      kv("已装技能", (p?.skills?.installed || []).length),
      kv("靶标白名单", `${(p?.servers?.hosts || []).length} 台`),
      kv("上游 Drill 授权声明", "docs/drill-auth-legal.html"),
      kv("插件版本", p?.pluginVersion ?? VERSION),
    )
    if ((p?.skills?.ids || []).length) info.append(el("div", "ocp-muted", "技能：" + p.skills.ids.join(", ")))
    body.append(info)
  }

  // ── 面板骨架 ─────────────────────────────────────────────────────────────
  let panel = null
  let bodyNode = null
  let statusNode = null
  let toastNode = null
  let signature = ""
  let pendingRender = false

  function profileKey(p) {
    if (!p) return "-"
    return JSON.stringify({
      e: p.enabled,
      s: p.promptSource,
      sid: p.schemeId,
      pol: p.policy,
      cap: p.capabilityProtocol,
      a: p.activeScheme ? p.activeScheme.id : null,
      sc: (p.schemes || []).map((x) => `${x.id}:${x.bytes}:${x.name}`),
      b: p.bindings,
      lm: p.lastModel,
      sv: (p.servers && p.servers.hosts) || [],
      cw: (p.cwd && p.cwd.selections) || [],
      cs: (p.cwd && p.cwd.scanned || []).length,
      sk: (p.skills && p.skills.installed) || [],
      tc: (p.customText || "").length,
      ts: (p.activeSchemeText || "").length,
    })
  }
  const currentSignature = () => [state.phase, state.error, state.tab, state.theme, state.busy ? 1 : 0, profileKey(state.profile)].join("|")

  function buildPanel() {
    const root = el("aside", "ocp-root")
    root.setAttribute(MARK, "dock")
    root.dataset.theme = state.theme
    root.addEventListener("click", (event) => event.stopPropagation())

    const head = el("div", "ocp-head")
    head.append(el("div", "ocp-logo", "⚔"))
    const title = el("div", "ocp-title")
    const modelLine = () => {
      const p = state.profile
      if (!p) return state.phase === "checking" ? "正在连接服务…" : "未连接服务"
      const model = p.lastModel ? p.lastModel : "模型未识别（不影响注入）"
      return `Inject 生效 · 来源 ${p.promptSource} · ${model}`
    }
    const b = el("b", "", "破甲 · dsh-purge")
    const small = el("small", "", modelLine())
    small.setAttribute(`${MARK}-sublabel`, "")
    title.append(b, small)
    head.append(title)
    head.append(
      button(state.theme === "white" ? "☀" : "☾", () => {
        state.theme = state.theme === "white" ? "ink" : "white"
        try {
          localStorage.setItem(LS_THEME, state.theme)
        } catch {}
        if (panel) panel.dataset.theme = state.theme
        signature = ""
        renderNow()
      }, { title: "切换主题" }),
      button("✕", () => {
        state.open = false
        ensureDock()
      }, { title: "收起" }),
    )
    root.append(head)

    const tabs = el("div", "ocp-tabs")
    for (const [id, label] of [["clean", "Clean"], ["drill", "Drill"]]) {
      const t = el("button", `ocp-tab ${state.tab === id ? "on" : ""}`, label)
      t.type = "button"
      t.addEventListener("click", () => {
        state.tab = id
        signature = ""
        renderNow()
      })
      tabs.append(t)
    }
    root.append(tabs)

    statusNode = el("div", "ocp-status")
    root.append(statusNode)

    bodyNode = el("div", "")
    root.append(bodyNode)

    toastNode = el("div", "ocp-toast")
    root.append(toastNode)

    root.addEventListener("focusout", () => {
      setTimeout(() => {
        const a = document.activeElement
        const editing = a && root.contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName)
        if (pendingRender && !editing) {
          signature = ""
          renderNow()
        }
      }, 0)
    })
    return root
  }

  function paintStatus() {
    if (!statusNode) return
    statusNode.replaceChildren()
    const running = state.phase === "running"
    const on = running && (!state.profile || state.profile.enabled !== false)
    const s = el("span", "ocp-chip")
    s.append(dot(on), el("span", "", running ? (on ? "运行中" : "已停用") : state.phase === "checking" ? "连接中…" : "未连接"))
    statusNode.append(s)
    if (running && state.profile) {
      statusNode.append(chip(`方案 ${state.profile.activeScheme ? state.profile.activeScheme.id : "内置默认"}`, "info"))
      statusNode.append(chip(`策略 ${state.profile.policy}`, ""))
      statusNode.append(chip(`方案数 ${state.profile.ruleCount ?? 0}`, ""))
      const modelChip = chip(`模型 ${state.profile.lastModel || "未识别"}`, state.profile.lastModel ? "" : "warn")
      modelChip.title = state.profile.lastModel
        ? "最近一次模型调用看到的模型（用于模型绑定）"
        : "尚未从 hooks 捕获到模型；注入仍正常。发送一条消息后即可显示。"
      statusNode.append(modelChip)
    }
    if (state.busy) statusNode.append(chip("处理中…", "warn"))
    if (toastNode) {
      toastNode.textContent = state.toast ? state.toast.message : state.error && state.phase !== "running" ? state.error : ""
      toastNode.style.color = state.toast
        ? state.toast.tone === "bad"
          ? "var(--danger)"
          : state.toast.tone === "warn"
            ? "var(--warn)"
            : "var(--accent)"
        : "var(--muted)"
    }
    const sub = panel && panel.querySelector(`[${MARK}-sublabel]`)
    if (sub) {
      const p = state.profile
      sub.textContent = p
        ? `Inject 生效 · 来源 ${p.promptSource} · ${p.lastModel || "模型未识别（不影响注入）"}`
        : state.phase === "checking"
          ? "正在连接服务…"
          : "未连接服务"
    }
  }

  function focusSnapshot() {
    const active = document.activeElement
    if (!panel || !active || !panel.contains(active)) return null
    const mark = active.getAttribute(`${MARK}-field`)
    if (!mark) return null
    return { mark, value: "value" in active ? active.value : null, start: active.selectionStart }
  }
  function restoreFocus(snap) {
    if (!snap || !panel) return
    const node = panel.querySelector(`[${MARK}-field="${snap.mark}"]`)
    if (!node) return
    if (snap.value !== null && "value" in node) node.value = snap.value
    node.focus?.()
    try {
      if (snap.start != null && node.setSelectionRange) node.setSelectionRange(snap.start, snap.start)
    } catch {}
  }

  function renderNow() {
    if (!panel || !state.open) return
    paintStatus()
    const active = document.activeElement
    if (active && panel.contains(active) && /INPUT|TEXTAREA|SELECT/.test(active.tagName)) {
      pendingRender = true
      return
    }
    const next = currentSignature()
    if (next === signature) return
    signature = next
    pendingRender = false
    const snap = focusSnapshot()
    const scroll = panel.scrollTop
    bodyNode.replaceChildren()
    state.tab === "drill" ? renderDrill(bodyNode) : renderClean(bodyNode)
    restoreFocus(snap)
    panel.scrollTop = scroll
  }

  function ensureDock() {
    if (!state.open) {
      if (panel) {
        panel.remove()
        panel = null
        bodyNode = statusNode = toastNode = null
        signature = ""
      }
      return
    }
    ensureStyle()
    if (!panel) {
      panel = buildPanel()
      document.body.append(panel)
      signature = ""
    }
    panel.dataset.theme = state.theme
    renderNow()
  }

  function ensureButton() {
    const composer = document.querySelector('[data-component="composer"]')
    const host = composer && composer.parentElement
    if (!composer || !host) return
    let node = host.querySelector(`[${MARK}="button"]`)
    if (!node) {
      node = document.createElement("button")
      node.setAttribute(MARK, "button")
      node.type = "button"
      node.style.cssText = [
        "display:inline-flex", "align-items:center", "gap:6px", "padding:4px 13px", "border-radius:999px",
        "border:1px solid rgba(148,163,184,0.5)", "background:rgba(148,163,184,0.14)", "color:inherit",
        "font-size:11.5px", "line-height:16px", "font-weight:600", "font-family:inherit",
        "cursor:pointer", "user-select:none", "pointer-events:auto", "position:relative", "z-index:60", "margin:0 auto 6px",
      ].join(";")
      node.addEventListener("click", (event) => {
        event.preventDefault()
        state.open = !state.open
        ensureDock()
        if (state.open) void refresh()
      })
      host.insertBefore(node, composer)
    }
    const running = state.phase === "running"
    node.style.borderColor = running ? "rgba(34,197,94,0.65)" : "rgba(148,163,184,0.5)"
    node.textContent = state.open ? "⚔ 破甲 ▾" : running ? "⚔ 破甲" : "⚔ 破甲 · 未连接"
  }

  function ensureNotice() {
    let ok = true
    try {
      ok = localStorage.getItem(LS_NOTICE) === "1"
    } catch {}
    if (ok || document.querySelector(`[${MARK}="notice"]`)) return
    ensureStyle()
    const overlay = el("div", "")
    overlay.setAttribute(MARK, "notice")
    overlay.style.cssText = "position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;background:rgba(2,6,23,.5)"
    const card = el("div", "ocp-root")
    card.dataset.theme = state.theme
    card.style.cssText = "position:static;width:min(440px,92vw);max-height:none"
    const c = el("div", "ocp-card")
    c.append(
      el("h4", "", "使用告知"),
      el("p", "", "oc-purge 是 dsh-purge 的 OpenCode 移植：本地自有主机上的提示词 / 方案 / 技能管理与红队评测。免费非商业，保留上游署名。"),
      el("p", "", "来源：https://github.com/YuJunZhiXue/dsh-purge"),
      el("p", "", "不得用于未授权攻击、入侵、数据窃取或破坏；不得商业倒卖。"),
    )
    const ack = el("label", "ocp-gate")
    const box = document.createElement("input")
    box.type = "checkbox"
    ack.append(box, el("span", "", "我已阅读并理解本告知，将合法使用本插件。"))
    c.append(ack)
    c.append(
      button("我已知晓 · 继续", () => {
        if (!box.checked) return
        try {
          localStorage.setItem(LS_NOTICE, "1")
        } catch {}
        overlay.remove()
        void act("set", { noticeAck: true }, "已确认使用告知")
      }, { primary: true }),
    )
    card.append(c)
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
        if (panel && !panel.isConnected) panel = null
        if (state.open) ensureDock()
      } catch {}
    }
    if (typeof requestAnimationFrame === "function" && !document.hidden) requestAnimationFrame(run)
    else setTimeout(run, 16)
  }

  const observer = new MutationObserver(() => schedule())
  observer.observe(document.body, { childList: true, subtree: true })

  let timer = null
  const loop = () => {
    void refresh().then(() => {
      timer = setTimeout(loop, state.phase === "running" ? CHECK_MS : RETRY_MS)
    })
  }
  loop()

  window.__ocPurgeDock = true
  window.ocPurgeDock = {
    version: VERSION,
    state,
    locations: () => locations.slice(),
    refresh: () => refresh(),
    open: () => {
      state.open = true
      ensureDock()
      return refresh()
    },
    close: () => {
      state.open = false
      ensureDock()
    },
    setServerBase: (url) => {
      try {
        if (url) localStorage.setItem(LS_BASE, stripBase(url))
        else localStorage.removeItem(LS_BASE)
      } catch {}
      ui.serverBase = url || ""
      basePromise = null
      return refresh()
    },
    destroy: () => {
      if (timer) clearTimeout(timer)
      observer.disconnect()
      for (const node of document.querySelectorAll(`[${MARK}]`)) node.remove()
      const style = document.getElementById(STYLE_ID)
      if (style) style.remove()
      panel = null
      bodyNode = statusNode = toastNode = null
      delete window.ocPurgeDock
      delete window.__ocPurgeDock
    },
  }

  console.info(`[oc-purge] v${VERSION} dock 已注入（输入框上方「破甲」按钮；Clean / Drill 双页）。`)
})()
