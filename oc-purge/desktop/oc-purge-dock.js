/**
 * oc-purge — Desktop dock injector（输入框上方「⚔ 破甲」按钮 + 右侧 Clean / Drill 面板）
 *
 * 上游 dsh-purge 的 client.js 在会话标题旁挂 dock（Clean / Drill 两页, Light / Ink 主题）。
 * OpenCode 桌面/Web 无官方 UI 插件接口, 故用 DOM 注入实现等价界面。
 *
 * 设计要点（修复「无法点击」）:
 *   • 面板只创建一次, **仅在数据变化时**重建内容（signature 判定）;
 *     绝不因宿主 DOM 变动（流式输出）反复重建, 避免按钮/输入框被反复替换。
 *   • MutationObserver 只做「按钮是否存在 / 面板是否被移除」的保活, 不触发重建。
 *   • 重建前记住聚焦元素与输入值, 重建后恢复（编辑不丢字）。
 *
 * 数据通道: 服务端插件 RPC（自包含, 不依赖其它插件的 serverBase）
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
  const LS_NOTICE = "oc-purge:noticed"
  const LS_DRILL = "oc-purge:drillAuthorized"
  const CHECK_MS = 20_000
  const RETRY_MS = 4_000

  const state = {
    phase: "checking", // checking | running | stopped
    error: null,
    profile: null,
    open: false,
    tab: "clean", // clean | drill
    theme: "ink", // ink | white
    busy: false,
    toast: null,
    connected: false,
  }

  try {
    const t = localStorage.getItem(LS_THEME)
    if (t === "white" || t === "ink") state.theme = t
  } catch {}

  // ── 独立服务源发现（自有 capture + 端口探测, 不读其它插件的键） ────────────
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

  function portCandidates() {
    const ports = new Set([49374, 4096, 49375, 49376, 49377, 3001])
    return [...ports].map((port) => `http://127.0.0.1:${port}`)
  }

  async function probeBase() {
    const candidates = []
    try {
      const own = localStorage.getItem(LS_BASE)
      if (own) candidates.push(stripBase(own))
    } catch {}
    for (const origin of captured) candidates.push(stripBase(origin))
    for (const port of portCandidates()) candidates.push(port)

    const attempt = async (base) => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 1200)
      try {
        const response = await fetch(`${base}/api/info`, { cache: "no-store", signal: controller.signal })
        // 200 = 已就绪; 401/403 = 找到了服务但认证尚未就绪
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

  async function call(method, input) {
    const base = await baseURL()
    if (!base) throw new Error("未连接到 OpenCode 服务（可在面板「连接」里手填地址）")
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

  // ── 主题 ─────────────────────────────────────────────────────────────────
  const THEMES = {
    ink: {
      bg: "#0f172a", panel: "#111c33", fg: "#e5e7eb", muted: "#94a3b8", line: "rgba(148,163,184,0.28)",
      soft: "rgba(148,163,184,0.12)", accent: "#10b981", accent2: "#38bdf8", warn: "#f59e0b", danger: "#ef4444",
    },
    white: {
      bg: "#f7f6f2", panel: "#ffffff", fg: "#1f2937", muted: "#6b7280", line: "rgba(31,41,55,0.16)",
      soft: "rgba(31,41,55,0.06)", accent: "#0f766e", accent2: "#0369a1", warn: "#b45309", danger: "#b91c1c",
    },
  }
  const pal = () => THEMES[state.theme] ?? THEMES.ink

  const CSS = {
    panel: () => `position:fixed;top:56px;right:12px;width:378px;max-height:calc(100vh - 76px);overflow:auto;z-index:2147483600;padding:12px;border-radius:12px;border:1px solid ${pal().line};background:${pal().panel};color:${pal().fg};box-shadow:0 10px 34px rgba(0,0,0,0.42);font-family:inherit;font-size:12px;box-sizing:border-box;pointer-events:auto`,
    btn: (primary) => `padding:4px 10px;border-radius:7px;border:1px solid ${primary ? pal().accent : pal().line};background:${primary ? pal().accent : pal().soft};color:${primary ? "#fff" : "inherit"};font-size:11px;line-height:18px;cursor:pointer;white-space:nowrap`,
    input: () => `padding:4px 8px;border-radius:7px;border:1px solid ${pal().line};background:${pal().soft};color:inherit;font-size:11px;box-sizing:border-box`,
    area: () => `width:100%;min-height:96px;margin-top:4px;padding:7px;border-radius:8px;border:1px solid ${pal().line};background:${pal().soft};color:inherit;font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;line-height:1.5;resize:vertical;box-sizing:border-box`,
    muted: () => `color:${pal().muted};font-size:10px;line-height:15px`,
    chip: (tone) => {
      const color = tone === "ok" ? pal().accent : tone === "warn" ? pal().warn : tone === "bad" ? pal().danger : pal().muted
      return `display:inline-flex;align-items:center;gap:4px;padding:1px 7px;border-radius:999px;border:1px solid ${color};color:${color};font-size:10px;line-height:16px;white-space:nowrap`
    },
    section: `margin-top:12px;padding-top:10px;border-top:1px solid ${pal().line}`,
  }

  const el = (tag, css, text) => {
    const node = document.createElement(tag)
    if (css) node.style.cssText = css
    if (text !== undefined) node.textContent = text
    return node
  }

  function button(text, onClick, options = {}) {
    const node = el("button", CSS.btn(Boolean(options.primary)), text)
    node.type = "button"
    if (options.title) node.title = options.title
    if (options.disabled || state.busy) {
      node.disabled = true
      node.style.opacity = "0.5"
      node.style.cursor = "default"
    } else {
      node.addEventListener("click", (event) => {
        event.preventDefault()
        event.stopPropagation()
        onClick()
      })
    }
    return node
  }

  function chip(text, tone) {
    return el("span", CSS.chip(tone), text)
  }

  function section(title, hint) {
    const wrap = el("div", CSS.section)
    const head = el("div", "display:flex;align-items:center;gap:6px;margin-bottom:6px")
    head.append(el("div", `font-weight:600;font-size:12px;color:${pal().fg}`, title))
    wrap.append(head)
    if (hint) wrap.append(el("div", CSS.muted(), hint))
    return wrap
  }

  function toast(message, tone) {
    state.toast = message ? { message, tone: tone || "ok", at: Date.now() } : null
  }

  async function act(method, input, okMessage) {
    state.busy = true
    renderNow()
    try {
      const profile = await call(method, input)
      if (profile && profile.plugin) state.profile = profile
      state.phase = "running"
      state.error = null
      toast(okMessage || "已完成", "ok")
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error)
      toast(`失败：${state.error}`, "bad")
    }
    state.busy = false
    renderNow()
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
    renderNow()
  }

  // ── 渲染（仅数据变化时重建；保护聚焦输入） ───────────────────────────────
  let panel = null
  let bodyNode = null
  let signature = ""
  let pendingRender = false

  function profileKey(p) {
    if (!p) return "-"
    return JSON.stringify({
      e: p.enabled,
      s: p.promptSource,
      pol: p.policy,
      cap: p.capabilityProtocol,
      r: (p.rules || []).map((x) => `${x.id}:${x.bytes}`),
      a: p.activeRule ? p.activeRule.id : null,
      sv: (p.servers && p.servers.hosts) || [],
      cw: (p.cwd && p.cwd.selections) || [],
      sk: (p.skills && p.skills.installed) || [],
      sc: (p.cwd && p.cwd.scanned || []).length,
    })
  }

  function currentSignature() {
    return [state.phase, state.error, state.tab, state.theme, state.busy ? 1 : 0, profileKey(state.profile)].join("|")
  }

  function focusSnapshot() {
    const active = document.activeElement
    if (!panel || !active || !panel.contains(active)) return null
    const mark = active.getAttribute(`${MARK}-field`)
    if (!mark) return null
    return { mark, value: "value" in active ? active.value : null, start: active.selectionStart }
  }

  function restoreFocus(snapshot) {
    if (!snapshot || !panel) return
    const node = panel.querySelector(`[${MARK}-field="${snapshot.mark}"]`)
    if (!node) return
    if (snapshot.value !== null && "value" in node) node.value = snapshot.value
    node.focus?.()
    try {
      if (snapshot.start != null && node.setSelectionRange) node.setSelectionRange(snapshot.start, snapshot.start)
    } catch {}
  }

  function renderNow() {
    if (!panel || !state.open) return
    updateStatus()
    const active = document.activeElement
    const editing = active && panel.contains(active) && /INPUT|TEXTAREA/.test(active.tagName)
    if (editing) {
      // 编辑中不重建正文, 待失焦或下次动作统一刷新
      pendingRender = true
      return
    }
    const next = currentSignature()
    if (next === signature) return
    signature = next
    pendingRender = false
    const snapshot = focusSnapshot()
    const scroll = panel.scrollTop
    bodyNode.replaceChildren()
    if (state.tab === "drill") renderDrill(bodyNode)
    else renderClean(bodyNode)
    restoreFocus(snapshot)
    panel.scrollTop = scroll
  }

  function field(mark, node) {
    node.setAttribute(`${MARK}-field`, mark)
    return node
  }

  function renderClean(body) {
    const p = state.profile
    const enabled = !p || p.enabled !== false

    // 概览
    const overview = el("div", "display:flex;flex-wrap:wrap;gap:6px;align-items:center")
    overview.append(
      chip(enabled ? "注入 开" : "注入 关", enabled ? "ok" : "bad"),
      chip(`来源 ${p?.promptSource ?? "-"}`, p?.promptSource === "none" ? "warn" : "ok"),
      chip(`策略 ${p?.policy ?? "-"}`, "info"),
      chip(`规则 ${p?.ruleCount ?? 0}`, "info"),
    )
    body.append(overview)
    body.append(el("div", `${CSS.muted()};margin-top:6px`, "提示：本面板控制的是「注入到每次模型调用的 system 段」，改完立即对下一次调用生效，无需重启。"))

    // 操作
    const ops = section("操作", "应用=开注入；复原=清空自定义文本/规则并回落内置默认提示词。")
    const opsRow = el("div", "display:flex;flex-wrap:wrap;gap:6px")
    opsRow.append(
      button("应用", () => act("apply", {}, "已应用，注入已开启"), { primary: true, title: "开启注入并使用当前生效文本" }),
      button("复原默认", () => act("revert", {}, "已复原为内置默认提示词")),
      button(enabled ? "停用注入" : "开启注入", () => act("set", { enabled: !enabled }, enabled ? "已停用注入" : "已开启注入")),
    )
    ops.append(opsRow)
    body.append(ops)

    // 策略
    const policy = section("作用域策略", "fallback：有用户文本用用户文本，否则用内置默认；strict：只用用户文本；always：用户文本后再追加内置默认。")
    const policyRow = el("div", "display:flex;flex-wrap:wrap;gap:6px;align-items:center")
    for (const item of ["fallback", "strict", "always"]) {
      policyRow.append(button(item === p?.policy ? `● ${item}` : item, () => act("set", { policy: item }, `策略已切换为 ${item}`)))
    }
    policyRow.append(button(`能力协议：${p?.capabilityProtocol === false ? "关" : "开"}`, () => act("set", { capabilityProtocol: !(p && p.capabilityProtocol !== false) }, "能力协议已切换")))
    policy.append(policyRow)
    body.append(policy)

    // 提示词（等价 prompt-inject.md）
    const prompt = section("提示词（等价 prompt-inject.md）", "留空 = 使用内置默认提示词。保存后立即生效。")
    const area = field("customText", el("textarea", CSS.area()))
    area.placeholder = "在此写入自定义注入正文；留空则用内置默认"
    area.value = p?.customText ?? ""
    const meter = el("div", `${CSS.muted()};margin-top:2px`, `${area.value.length} 字符`)
    area.addEventListener("input", () => {
      meter.textContent = `${area.value.length} 字符`
    })
    const promptOps = el("div", "display:flex;gap:6px;margin-top:6px")
    promptOps.append(
      button("保存文本", () => act("set", { customText: area.value }, "提示词已保存"), { primary: true }),
      button("清空文本", () => act("set", { customText: null }, "已清空自定义文本")),
    )
    prompt.append(area, meter, promptOps)
    body.append(prompt)

    // 规则库
    const rules = section("规则库", "每条规则可启用/删除；启用后作为注入文本（优先级高于本地规则、低于自定义文本）。")
    const list = el("div", "")
    const items = Array.isArray(p?.rules) ? p.rules : []
    if (!items.length) list.append(el("div", CSS.muted(), "（空）"))
    for (const rule of items) {
      const row = el("div", "display:flex;align-items:center;gap:6px;margin:3px 0")
      row.append(el("span", "flex:1;word-break:break-all", `${rule.id}  ·  ${rule.name}  (${rule.bytes}B)`))
      row.append(
        p?.activeRule?.id === rule.id
          ? button("已启用", () => act("rules", { action: "deactivate" }, "已取消启用"))
          : button("启用", () => act("rules", { action: "activate", id: rule.id }, `已启用 ${rule.id}`)),
        button("删除", () => act("rules", { action: "delete", id: rule.id }, `已删除 ${rule.id}`)),
      )
      list.append(row)
    }
    rules.append(list)
    const newRule = el("div", "margin-top:8px")
    const ruleId = field("ruleId", el("input", `${CSS.input()};width:100%`))
    ruleId.placeholder = "新规则 id（如 redteam-base）"
    const ruleBody = field("ruleBody", el("textarea", CSS.area()))
    ruleBody.placeholder = "规则正文"
    const ruleOps = el("div", "display:flex;gap:6px;margin-top:6px")
    ruleOps.append(
      button("新建 / 覆盖", () => {
        const id = ruleId.value.trim()
        if (!id) {
          toast("请填写规则 id", "warn")
          renderNow()
          return
        }
        void act("rules", { action: "upsert", id, name: id, content: ruleBody.value }, `已保存规则 ${id}`)
      }, { primary: true }),
      button("清空输入", () => {
        ruleId.value = ""
        ruleBody.value = ""
      }),
    )
    newRule.append(ruleId, ruleBody, ruleOps)
    rules.append(newRule)
    body.append(rules)

    // 自己的服务器
    const own = section("自己的服务器（白名单）", "每行一个 IP 或完整主机名；可写 user@host；密钥、口令、网段、通配符会被自动丢弃。")
    const servers = field("servers", el("textarea", CSS.area()))
    servers.placeholder = "203.0.113.10\nmy-vps.example.com"
    servers.value = (p?.servers?.hosts || []).join("\n")
    const ownOps = el("div", "display:flex;gap:6px;margin-top:6px;align-items:center")
    ownOps.append(
      button("保存列表", () => act("servers", { action: "set", text: servers.value }, "白名单已保存"), { primary: true }),
      el("span", CSS.muted(), `当前 ${(p?.servers?.hosts || []).length} 台`),
    )
    own.append(servers, ownOps)
    body.append(own)

    // 本地规则（CWD）
    const cwd = section("本地规则（当前目录 / 祖先）", "扫描 AGENTS.md / CLAUDE.md；勾选后，当自定义文本与规则集都为空时作为注入来源。")
    const cwdOps = el("div", "display:flex;gap:6px;align-items:center")
    cwdOps.append(
      button("重新扫描", () => rescanCwd(cwd)),
      button("全部取消", () => act("set", { cwdSelections: [] }, "已取消全部勾选")),
      el("span", CSS.muted(), `已选 ${(p?.cwd?.selections || []).length}`),
    )
    cwd.append(cwdOps)
    const cwdList = el("div", `${MARK}-cwd`)
    cwd.append(cwdList)
    void fillCwd(cwdList)
    body.append(cwd)

    // 技能
    const skills = section("技能（Skill）", "内置 = 随插件捆绑的红队技能；导出/导入到 OpenCode 技能目录（.opencode/skills）。")
    const skOps = el("div", "display:flex;gap:6px;align-items:center;flex-wrap:wrap")
    skOps.append(
      button("导出全部内置", () => act("skills", { action: "install" }, "已导出内置技能")),
      el("span", CSS.muted(), `内置 ${p?.skills?.bundled ?? 0} · 已装 ${(p?.skills?.installed || []).length}`),
    )
    const importRow = el("div", "display:flex;gap:6px;margin-top:6px")
    const importPath = field("skillPath", el("input", `${CSS.input()};flex:1`))
    importPath.placeholder = "文件夹或 .zip 路径"
    importRow.append(importPath, button("导入", () => act("skills", { action: "import", path: importPath.value.trim() }, "已导入技能")))
    const createRow = el("div", "display:flex;gap:6px;margin-top:6px")
    const skillId = field("skillId", el("input", `${CSS.input()};flex:1`))
    skillId.placeholder = "新建技能 id（kebab-case）"
    createRow.append(skillId, button("新建", () => act("skills", { action: "create", id: skillId.value.trim() }, "已新建技能")))
    skills.append(skOps, importRow, createRow)
    if ((p?.skills?.installed || []).length) {
      skills.append(el("div", `${CSS.muted()};margin-top:4px;word-break:break-all`, "已装: " + (p.skills.installed || []).join(", ")))
    }
    body.append(skills)

    // 连接（自包含）
    const conn = section("连接", "插件自包含探测本机服务；如探测失败可手填地址（如 http://127.0.0.1:49374）。")
    const connRow = el("div", "display:flex;gap:6px")
    const baseInput = field("serverBase", el("input", `${CSS.input()};flex:1`))
    baseInput.placeholder = "http://127.0.0.1:49374"
    baseInput.value = (() => {
      try {
        return localStorage.getItem(LS_BASE) || ""
      } catch {
        return ""
      }
    })()
    connRow.append(
      baseInput,
      button("连接", () => {
        try {
          if (baseInput.value.trim()) localStorage.setItem(LS_BASE, stripBase(baseInput.value.trim()))
          else localStorage.removeItem(LS_BASE)
        } catch {}
        basePromise = null
        void refresh().then(() => toast("已按新地址重连", "ok"), () => {})
      }),
    )
    conn.append(connRow)
    body.append(conn)
  }

  async function fillCwd(listNode) {
    const p = state.profile
    listNode.replaceChildren()
    let items = p?.cwd?.scanned
    const selections = new Set((p?.cwd?.selections || []).map((x) => x))
    if (!Array.isArray(items) || !items.length) {
      listNode.append(el("div", CSS.muted(), "当前目录没有 AGENTS.md / CLAUDE.md"))
      return
    }
    for (const item of items) {
      const row = el("label", "display:flex;align-items:center;gap:6px;margin:3px 0;cursor:pointer")
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
      row.append(box, el("span", "flex:1;word-break:break-all", `${item.scope} · ${item.name} · ${item.size}B`))
      listNode.append(row)
    }
  }

  async function rescanCwd(anchor) {
    let listNode = anchor.querySelector(`[${MARK}-cwd]`)
    if (!listNode) {
      listNode = el("div", `${MARK}-cwd`)
      anchor.append(listNode)
    }
    try {
      const result = await call("cwd", { action: "scan" })
      if (state.profile) {
        state.profile.cwd = state.profile.cwd || {}
        state.profile.cwd.scanned = result.items || []
      }
      await fillCwd(listNode)
      toast(`已扫描：${(result.items || []).length} 个候选`, "ok")
    } catch (error) {
      toast(`扫描失败：${error instanceof Error ? error.message : error}`, "bad")
    }
  }

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
      const gate = section("演练台授权", "首次进入 Drill 需确认以下条款（Clean 页不需要）。")
      for (const line of DRILL_NOTICE) gate.append(el("div", `${CSS.muted()};margin:2px 0`, "• " + line))
      const boxes = []
      for (const text of [
        "我已阅读安全与反滥用告知，并接受全部条款。",
        "我只在已授权主机 / 离线靶标 / 合规演练中使用。",
        "我不会将其用于任何非法用途。",
      ]) {
        const wrap = el("label", "display:flex;align-items:center;gap:6px;margin:5px 0;cursor:pointer")
        const box = document.createElement("input")
        box.type = "checkbox"
        boxes.push(box)
        wrap.append(box, el("span", "flex:1", text))
        gate.append(wrap)
      }
      gate.append(
        button("确认授权并打开 Drill", () => {
          if (!boxes.every((box) => box.checked)) {
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
    const info = section("演练台 · 资源", "OpenCode 无 DSH 的演练台事实库 / 报告回放接口；此处保留技能资产、靶标白名单与授权声明。")
    for (const [k, v] of [
      ["内置红队技能", String(p?.skills?.bundled ?? 0)],
      ["已装技能", String((p?.skills?.installed || []).length)],
      ["靶标白名单", `${(p?.servers?.hosts || []).length} 台`],
      ["上游 Drill 授权声明", "docs/drill-auth-legal.html"],
      ["插件版本", String(p?.pluginVersion ?? VERSION)],
    ]) {
      const row = el("div", "display:flex;justify-content:space-between;gap:12px;margin:2px 0")
      row.append(el("span", CSS.muted(), k), el("span", "text-align:right", v))
      info.append(row)
    }
    if ((p?.skills?.ids || []).length) {
      info.append(el("div", `${CSS.muted()};margin-top:6px;word-break:break-all`, "技能: " + p.skills.ids.join(", ")))
    }
    body.append(info)
  }

  // ── 面板骨架（只创建一次） ───────────────────────────────────────────────
  function buildPanel() {
    const root = el("aside", CSS.panel())
    root.setAttribute(MARK, "dock")
    root.addEventListener("click", (event) => event.stopPropagation())

    const head = el("div", "display:flex;align-items:center;gap:6px")
    head.append(el("div", "flex:1;font-weight:600;font-size:13px", `⚔ 破甲 · dsh-purge v${VERSION}`))
    head.append(
      button(state.theme === "white" ? "Light" : "Ink", () => {
        state.theme = state.theme === "white" ? "ink" : "white"
        try {
          localStorage.setItem(LS_THEME, state.theme)
        } catch {}
        applyTheme()
        signature = ""
        renderNow()
      }),
      button("×", () => {
        state.open = false
        ensureDock()
      }),
    )
    root.append(head)

    const tabs = el("div", "display:flex;gap:6px;margin:8px 0 4px")
    tabs.append(
      button(state.tab === "clean" ? "● Clean" : "Clean", () => {
        state.tab = "clean"
        signature = ""
        renderNow()
      }),
      button(state.tab === "drill" ? "● Drill" : "Drill", () => {
        state.tab = "drill"
        signature = ""
        renderNow()
      }),
    )
    root.append(tabs)

    const status = el("div", "margin-bottom:6px")
    status.setAttribute(`${MARK}-status`, "")
    root.append(status)

    bodyNode = el("div", "")
    bodyNode.setAttribute(`${MARK}-body`, "")
    root.append(bodyNode)

    const toastNode = el("div", `margin-top:10px;min-height:16px;font-size:11px`)
    toastNode.setAttribute(`${MARK}-toast`, "")
    root.append(toastNode)

    root.addEventListener("focusout", () => {
      setTimeout(() => {
        const active = document.activeElement
        const stillEditing = active && root.contains(active) && /INPUT|TEXTAREA/.test(active.tagName)
        if (pendingRender && !stillEditing) {
          signature = ""
          renderNow()
        }
      }, 0)
    })

    return root
  }

  function applyTheme() {
    if (!panel) return
    panel.style.cssText = CSS.panel()
  }

  function updateStatus() {
    if (!panel) return
    const node = panel.querySelector(`[${MARK}-status]`)
    if (!node) return
    node.replaceChildren()
    const text =
      state.phase === "running"
        ? `运行中 · ${state.profile && state.profile.enabled === false ? "注入已停用" : "注入已开启"}`
        : state.phase === "checking"
          ? "正在连接服务…"
          : `未连接${state.error ? "：" + state.error : ""}`
    node.append(chip(text, state.phase === "running" ? "ok" : state.phase === "checking" ? "info" : "bad"))
    if (state.busy) node.append(el("span", `${CSS.muted()};margin-left:6px`, "处理中…"))
    const toastNode = panel.querySelector(`[${MARK}-toast]`)
    if (toastNode) {
      toastNode.textContent = state.toast ? state.toast.message : ""
      toastNode.style.color = state.toast ? (state.toast.tone === "bad" ? pal().danger : state.toast.tone === "warn" ? pal().warn : pal().accent) : pal().muted
    }
  }

  function ensureDock() {
    if (!state.open) {
      if (panel) {
        panel.remove()
        panel = null
        bodyNode = null
        signature = ""
      }
      return
    }
    if (!panel) {
      panel = buildPanel()
      document.body.append(panel)
      signature = ""
    }
    applyTheme()
    updateStatus()
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
        "display:flex", "align-items:center", "gap:6px", "width:fit-content",
        "margin:0 auto 6px", "padding:3px 12px", "border-radius:999px",
        "border:1px solid rgba(148,163,184,0.45)", "background:rgba(148,163,184,0.12)",
        "color:inherit", "font-size:11px", "line-height:16px", "font-family:inherit",
        "cursor:pointer", "user-select:none", "pointer-events:auto", "position:relative", "z-index:50",
      ].join(";")
      node.addEventListener("click", (event) => {
        event.preventDefault()
        state.open = !state.open
        ensureDock()
        if (state.open) void refresh()
      })
      host.insertBefore(node, composer)
    }
    const tone = state.phase === "running" ? pal().accent : state.phase === "checking" ? pal().warn : pal().muted
    node.style.borderColor = tone
    node.textContent = state.open ? "⚔ 破甲 ▾" : state.phase === "running" ? "⚔ 破甲" : "⚔ 破甲 · 未连接"
  }

  // ── 首次使用告知 ─────────────────────────────────────────────────────────
  function ensureNotice() {
    let ok = true
    try {
      ok = localStorage.getItem(LS_NOTICE) === "1"
    } catch {}
    if (ok || document.querySelector(`[${MARK}="notice"]`)) return
    const overlay = el("div", "position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.45)")
    overlay.setAttribute(MARK, "notice")
    const card = el("div", `width:min(430px,92vw);padding:16px;border-radius:12px;border:1px solid ${pal().line};background:${pal().panel};color:${pal().fg}`)
    card.append(
      el("div", "font-size:14px;font-weight:600;margin-bottom:6px", "使用告知"),
      el("div", `${CSS.muted()};margin-bottom:8px`, "oc-purge 是 dsh-purge 的 OpenCode 移植：本地自有主机上的提示词 / 规则 / 技能管理与红队评测。免费非商业，保留上游署名。"),
      el("div", `${CSS.muted()};margin-bottom:8px`, "来源：https://github.com/YuJunZhiXue/dsh-purge"),
      el("div", `${CSS.muted()};margin-bottom:10px`, "不得用于未授权攻击、入侵、数据窃取或破坏；不得商业倒卖。"),
    )
    const ack = el("label", "display:flex;align-items:center;gap:6px;margin-bottom:10px;cursor:pointer")
    const box = document.createElement("input")
    box.type = "checkbox"
    ack.append(box, el("span", "flex:1", "我已阅读并理解本告知，将合法使用本插件。"))
    card.append(ack)
    card.append(
      button("我已知晓 · 继续", () => {
        if (!box.checked) return
        try {
          localStorage.setItem(LS_NOTICE, "1")
        } catch {}
        overlay.remove()
        void act("set", { noticeAck: true }, "已确认使用告知")
      }, { primary: true }),
    )
    overlay.append(card)
    document.body.append(overlay)
  }

  // ── 保活循环（不重建面板, 只补缺失的按钮/面板） ─────────────────────────
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
      basePromise = null
      return refresh()
    },
    destroy: () => {
      if (timer) clearTimeout(timer)
      observer.disconnect()
      for (const node of document.querySelectorAll(`[${MARK}]`)) node.remove()
      panel = null
      bodyNode = null
      delete window.ocPurgeDock
      delete window.__ocPurgeDock
    },
  }

  console.info(`[oc-purge] v${VERSION} dock 已注入（输入框上方「破甲」按钮；Clean / Drill 双页）。`)
})()
