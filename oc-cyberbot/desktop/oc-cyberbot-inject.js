/**
 * oc-cyberbot —— Desktop 桌面注入脚本
 *
 * 在 OpenCode Desktop 的 agent 回复消息操作栏中，为「复制回复」按钮旁追加
 * 一个铅笔图标的「修改回复」按钮。点击后：
 *   - 列出"本轮"（上一次用户消息之后）的全部「回复」(text) 与「思考」(reasoning) 段；
 *   - 点击任意一条进入编辑（预填原文）；每条也可以直接删除（✕）；
 *   - 保存/删除通过服务端 RPC (cyberbot.message/*) 写回会话存储，随后自动刷新。
 *
 * 启用门控: 仅当服务端插件 oc-cyberbot 处于启用状态（RPC ping 可用）时注入按钮；
 * 插件被禁用后按钮自动消失。
 *
 * 安装与移除:
 *   node scripts/patch-desktop.mjs            # 注入（需先退出 OpenCode Desktop）
 *   node scripts/patch-desktop.mjs --unpatch  # 移除注入
 * 临时调试: 打开 DevTools 控制台（Ctrl+Shift+I）粘贴本文件直接运行。
 */
;(() => {
  "use strict"
  if (window.__ocCyberbot) return

  const VERSION = "0.3.0"
  const RPC_ID = "cyberbot.message"
  const MARK = "data-oc-cyberbot"
  const LS_BASE = "oc-cyberbot:serverBase"
  const SHARED_BASE_KEYS = ["oc-plugin-manager:serverBase", "oc-deepseek-banlance:serverBase", "oc-infinite-gen-4:serverBase"]
  const PORTS = [49374, 4096, 49375, 49376, 49377, 3001]
  const REFRESH_MS = 15_000
  const TARGET_LABEL = "复制回复"
  const KIND_LABEL = { text: "回复", reasoning: "思考" }

  const state = { enabled: false, lastError: null, serverBase: null, buttons: 0 }
  let timer = null
  let scheduled = false
  let observer = null
  let basePromise = null

  const strip = (value) => String(value || "").replace(/\/+$/, "")

  // ---------- 认证（web 客户端从已保存的连接里取 Basic 凭据；桌面 app 场景通常由宿主自动携带） ----------

  function connectionInfo() {
    const out = { base: null, password: "" }
    try {
      const raw = localStorage.getItem("opencode.global.dat:server")
      if (raw) {
        const parsed = JSON.parse(raw)
        const list = parsed && Array.isArray(parsed.list) ? parsed.list : []
        const entry = list.find((item) => item && item.http && typeof item.http.url === "string")
        if (entry) {
          out.base = strip(entry.http.url)
          if (typeof entry.http.password === "string") out.password = entry.http.password
        }
      }
    } catch {}
    if (!out.password) {
      try {
        const boot = window.electron && window.electron.bootstrap
        if (boot && typeof boot === "object") {
          if (!out.base && typeof boot.defaultServerUrl === "string") out.base = strip(boot.defaultServerUrl)
          if (typeof boot.defaultServerPassword === "string") out.password = boot.defaultServerPassword
        }
      } catch {}
    }
    return out
  }

  function authHeaders() {
    const headers = {}
    try {
      const info = connectionInfo()
      if (info.password) headers.Authorization = "Basic " + btoa("opencode:" + info.password)
    } catch {}
    return headers
  }

  // ---------- 服务地址探测 ----------

  async function probeBase() {
    const candidates = []
    try {
      const own = localStorage.getItem(LS_BASE)
      if (own) candidates.push(strip(own))
      for (const key of SHARED_BASE_KEYS) {
        const shared = localStorage.getItem(key)
        if (shared) candidates.push(strip(shared))
      }
    } catch {}
    const info = connectionInfo()
    if (info.base) candidates.push(info.base)
    const boot = window.electron && window.electron.bootstrap
    if (boot && typeof boot === "object" && typeof boot.defaultServerUrl === "string") candidates.push(strip(boot.defaultServerUrl))
    for (const port of PORTS) candidates.push(`http://127.0.0.1:${port}`)

    const attempt = async (base) => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 1500)
      try {
        const response = await fetch(`${base}/api/info`, { cache: "no-store", signal: controller.signal, headers: authHeaders() })
        return response.ok || response.status === 401 || response.status === 403 ? base : null
      } catch {
        return null
      } finally {
        clearTimeout(timeout)
      }
    }
    const unique = [...new Set(candidates.filter(Boolean))]
    const hits = await Promise.all(unique.map(attempt))
    const hit = hits.find(Boolean) || null
    if (hit) {
      try { localStorage.setItem(LS_BASE, hit) } catch {}
      if (state.serverBase !== hit) console.info(`[oc-cyberbot] server base=${hit}`)
      state.serverBase = hit
    }
    return hit
  }

  function baseURL() {
    if (/^https?:/.test(location.origin)) return Promise.resolve(location.origin)
    if (!basePromise) basePromise = probeBase()
    return basePromise
  }

  async function call(method, input) {
    const base = await baseURL()
    if (!base) throw new Error("未找到服务器地址")
    const response = await fetch(`${base}/api/rpc/${RPC_ID}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({ input: input ?? {} }),
    })
    const json = await response.json().catch(() => null)
    const data = json && typeof json === "object" ? (json.output ?? json.data ?? json) : null
    if (!response.ok) throw new Error(`RPC HTTP ${response.status}`)
    return data
  }

  // ---------- Toast ----------

  function toast(message, isError) {
    try {
      const id = `${MARK}-toast`
      const old = document.getElementById(id)
      if (old) old.remove()
      const el = document.createElement("div")
      el.id = id
      el.textContent = message
      el.style.cssText = [
        "position:fixed",
        "left:50%",
        "bottom:28px",
        "transform:translateX(-50%)",
        "z-index:2147483647",
        "max-width:min(640px,86vw)",
        "padding:10px 14px",
        "border-radius:10px",
        "font-size:13px",
        "line-height:1.4",
        "box-shadow:0 8px 28px rgba(0,0,0,.28)",
        "pointer-events:none",
        isError ? "background:#b3261e;color:#fff" : "background:#1f6feb;color:#fff",
      ].join(";")
      document.body.appendChild(el)
      setTimeout(() => {
        try { el.remove() } catch {}
      }, 4200)
    } catch {}
  }

  // ---------- 消息定位 ----------

  function messageInfo(node) {
    let el = node
    while (el && el !== document.body) {
      let id = el.getAttribute ? el.getAttribute("data-message-id") || "" : ""
      if (!id && el.id) {
        if (/^message-msg_/.test(el.id)) id = el.id.slice("message-".length)
        else if (/^msg_/.test(el.id)) id = el.id
      }
      if (id) {
        const match = (location.pathname || "").match(/\/session\/(ses_[A-Za-z0-9]+)/)
        return { messageID: id, sessionID: match ? match[1] : "" }
      }
      el = el.parentElement
    }
    return null
  }

  // ---------- 主题与控件 ----------

  function themeColors() {
    const dark = (() => {
      try {
        const scheme = (document.documentElement && document.documentElement.dataset && document.documentElement.dataset.colorScheme) || ""
        if (scheme) return scheme === "dark"
        return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches
      } catch {
        return false
      }
    })()
    return dark
      ? { panelBg: "#1b1c20", panelFg: "#ececec", areaBg: "rgba(255,255,255,.05)", border: "rgba(255,255,255,.22)", overlay: "rgba(0,0,0,.55)", hover: "rgba(255,255,255,.08)", muted: "#9a9aa2" }
      : { panelBg: "#ffffff", panelFg: "#111111", areaBg: "rgba(0,0,0,.03)", border: "rgba(0,0,0,.18)", overlay: "rgba(0,0,0,.35)", hover: "rgba(0,0,0,.05)", muted: "#666666" }
  }

  function makeButton(label, primary, colors) {
    const button = document.createElement("button")
    button.textContent = label
    button.style.cssText =
      "padding:7px 14px;border-radius:9px;font-size:13px;cursor:pointer;border:1px solid " +
      (primary ? "transparent" : colors.border) +
      ";" +
      (primary ? "background:#1f6feb;color:#fff" : "background:transparent;color:inherit")
    return button
  }

  // ---------- 回复/思考 列表 + 编辑弹窗 ----------

  function openReplyFlow(info) {
    const colors = themeColors()

    let items = []
    let changed = 0
    let closed = false
    let view = "loading" // loading | list | editor

    const overlay = document.createElement("div")
    overlay.setAttribute(MARK, "overlay")
    overlay.style.cssText = "position:fixed;inset:0;z-index:2147483600;display:flex;align-items:center;justify-content:center;background:" + colors.overlay

    const panel = document.createElement("div")
    panel.style.cssText =
      "width:min(780px,92vw);max-height:82vh;display:flex;flex-direction:column;gap:10px;padding:16px;border-radius:14px;" +
      "background:" + colors.panelBg + ";color:" + colors.panelFg + ";border:1px solid " + colors.border + ";" +
      "box-shadow:0 24px 64px rgba(0,0,0,.45)"

    const title = document.createElement("div")
    title.style.cssText = "font-size:14px;font-weight:600"
    const subtitle = document.createElement("div")
    subtitle.style.cssText = "font-size:12px;color:" + colors.muted
    const body = document.createElement("div")
    body.style.cssText = "flex:1;min-height:180px;max-height:58vh;overflow:auto;border:1px solid " + colors.border + ";border-radius:10px"
    const footer = document.createElement("div")
    footer.style.cssText = "display:flex;justify-content:flex-end;gap:8px"

    panel.append(title, subtitle, body, footer)
    overlay.appendChild(panel)

    const closeFlow = () => {
      if (closed) return
      closed = true
      try { overlay.remove() } catch {}
      document.removeEventListener("keydown", onKey, true)
      if (changed > 0) {
        toast("已保存修改，正在刷新…")
        setTimeout(() => {
          try { location.reload() } catch {}
        }, 900)
      }
    }

    const onKey = (event) => {
      if (event.key !== "Escape") return
      event.stopPropagation()
      if (view === "editor") renderList()
      else closeFlow()
    }

    overlay.addEventListener("mousedown", (event) => {
      if (event.target === overlay) closeFlow()
    })
    document.addEventListener("keydown", onKey, true)

    function renderLoading() {
      view = "loading"
      title.textContent = "修改回复 / 思考"
      subtitle.textContent = "正在读取本轮内容…"
      body.textContent = ""
      footer.textContent = ""
      const cancel = makeButton("取消", false, colors)
      cancel.addEventListener("click", closeFlow)
      footer.appendChild(cancel)
    }

    function renderEmpty() {
      view = "list"
      title.textContent = "修改回复 / 思考"
      subtitle.textContent = "本轮已无可编辑内容"
      body.textContent = ""
      footer.textContent = ""
      const done = makeButton("完成", true, colors)
      done.addEventListener("click", closeFlow)
      footer.appendChild(done)
    }

    function renderList() {
      if (!items.length) { renderEmpty(); return }
      view = "list"
      title.textContent = "修改回复 / 思考"
      subtitle.textContent =
        "本轮共 " + items.length + " 段（思考/回复）· 点击编辑，✕ 删除" + (changed ? " · 已改 " + changed + " 处" : "")
      body.textContent = ""
      footer.textContent = ""

      items.forEach((item, index) => {
        const row = document.createElement("div")
        row.style.cssText = "display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid " + colors.border + ";font-size:13px;line-height:1.5"
        const badge = document.createElement("span")
        badge.textContent = KIND_LABEL[item.kind] || item.kind
        badge.style.cssText =
          "flex:none;font-size:11px;padding:1px 6px;border-radius:6px;border:1px solid " + colors.border + ";" + (item.kind === "reasoning" ? "color:" + colors.muted : "")
        const main = document.createElement("div")
        main.style.cssText = "flex:1;min-width:0;cursor:pointer"
        const head = document.createElement("div")
        head.style.cssText = "font-size:11px;color:" + colors.muted + ";margin-bottom:2px"
        head.textContent = "#" + (index + 1) + " · " + item.text.length + " 字"
        const preview = document.createElement("div")
        preview.style.cssText = "white-space:nowrap;overflow:hidden;text-overflow:ellipsis"
        const flat = item.text.replace(/\s+/g, " ").trim()
        preview.textContent = flat.length > 100 ? flat.slice(0, 100) + "…" : flat
        main.append(head, preview)
        main.addEventListener("mouseenter", () => { row.style.background = colors.hover })
        main.addEventListener("mouseleave", () => { row.style.background = "transparent" })
        main.addEventListener("click", () => renderEditor(item, index))
        const del = document.createElement("button")
        del.textContent = "✕"
        del.setAttribute("aria-label", "删除")
        del.style.cssText = "flex:none;width:24px;height:24px;border-radius:6px;border:1px solid " + colors.border + ";background:transparent;color:inherit;cursor:pointer;font-size:12px;line-height:1"
        del.addEventListener("click", (event) => {
          event.stopPropagation()
          void deleteItem(item)
        })
        row.append(badge, main, del)
        body.appendChild(row)
      })

      const done = makeButton("完成", true, colors)
      done.addEventListener("click", closeFlow)
      footer.appendChild(done)
    }

    function renderEditor(item, index) {
      view = "editor"
      const kindLabel = KIND_LABEL[item.kind] || "内容"
      title.textContent = "修改" + kindLabel
      subtitle.textContent = "第 #" + (index + 1) + " 段（" + kindLabel + "）· 保存或删除后返回列表"
      body.textContent = ""
      footer.textContent = ""

      const area = document.createElement("textarea")
      area.value = item.text
      area.spellcheck = false
      area.style.cssText =
        "width:100%;height:100%;min-height:280px;border:0;resize:none;padding:12px 14px;box-sizing:border-box;background:" + colors.areaBg + ";color:" + colors.panelFg +
        ";font-size:13px;line-height:1.55;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;outline:none"
      body.appendChild(area)
      setTimeout(() => {
        try {
          area.focus()
          area.setSelectionRange(area.value.length, area.value.length)
        } catch {}
      }, 30)

      const back = makeButton("返回", false, colors)
      const del = makeButton("删除", false, colors)
      del.style.color = "#e5484d"
      const save = makeButton("保存", true, colors)
      let busy = false

      back.addEventListener("click", () => { if (!busy) renderList() })
      del.addEventListener("click", () => { if (!busy) void deleteItem(item) })
      save.addEventListener("click", async () => {
        if (busy) return
        busy = true
        save.textContent = "保存中…"
        try {
          const done = await call("edit", {
            sessionID: info.sessionID,
            messageID: item.messageID,
            partIndex: item.partIndex,
            text: area.value,
          })
          if (done && done.ok === true) {
            item.text = area.value
            changed++
            toast("已保存本条修改")
            busy = false
            save.textContent = "保存"
            renderList()
            return
          }
          toast("保存失败: " + String((done && done.error) || "unknown"), true)
        } catch (error) {
          toast("保存失败: " + String((error && error.message) || error), true)
        }
        busy = false
        save.textContent = "保存"
      })

      footer.append(back, del, save)
    }

    async function deleteItem(item) {
      const kindLabel = KIND_LABEL[item.kind] || "内容"
      let confirmed = false
      try {
        confirmed = window.confirm("确定删除这条" + kindLabel + "吗？此操作不可撤销。")
      } catch {
        confirmed = true
      }
      if (!confirmed) return
      try {
        const res = await call("remove", { sessionID: info.sessionID, messageID: item.messageID, partIndex: item.partIndex })
        if (!res || res.ok !== true) {
          toast("删除失败: " + String((res && res.error) || "unknown"), true)
          return
        }
        const idx = items.indexOf(item)
        if (idx >= 0) items.splice(idx, 1)
        changed++
        toast("已删除这条" + kindLabel)
        renderList()
      } catch (error) {
        toast("删除失败: " + String((error && error.message) || error), true)
      }
    }

    document.body.appendChild(overlay)
    renderLoading()

    void (async () => {
      try {
        const res = await call("list", { sessionID: info.sessionID, messageID: info.messageID })
        items = res && res.ok === true && Array.isArray(res.items) ? res.items : []
      } catch {
        items = []
      }
      if (closed) return
      if (!items.length) {
        toast("这一轮没有可编辑的回复/思考（可能点在工具步骤上了）", true)
        closeFlow()
        return
      }
      renderList()
    })()
  }

  async function openEditor(copyBtn) {
    const info = messageInfo(copyBtn)
    if (!info) {
      toast("未找到消息 ID，无法修改", true)
      return
    }
    openReplyFlow(info)
  }

  // ---------- 按钮注入 ----------

  const PENCIL_PATHS = [
    "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z",
    "m15 5 4 4",
  ]

  // ---------- 应用原生样式气泡（data-component="tooltip-v2"，与官方按钮一致） ----------

  function hideAppTooltip() {
    try {
      const existing = document.getElementById(`${MARK}-tooltip`)
      if (existing) existing.remove()
    } catch {}
  }

  function showAppTooltip(anchor, text) {
    hideAppTooltip()
    try {
      const rect = anchor.getBoundingClientRect()
      if (!rect || (rect.width === 0 && rect.height === 0)) return
      // 外层 positioner 负责定位 transform；内层 tooltip-v2 只跑官方入场动画。
      // （官方动画 tooltipV2In 会接管 transform，定位 transform 若放在内层会被动画覆盖，
      //   表现为气泡先出现在图标右侧、动画结束后才跳回上方。）
      const positioner = document.createElement("div")
      positioner.id = `${MARK}-tooltip`
      positioner.setAttribute("data-popper-positioner", "")
      positioner.style.position = "fixed"
      positioner.style.left = Math.round(rect.left + rect.width / 2) + "px"
      positioner.style.top = Math.round(rect.top - 4) + "px"
      positioner.style.transform = "translate(-50%, -100%)"
      const tip = document.createElement("div")
      tip.setAttribute("data-component", "tooltip-v2")
      tip.setAttribute("data-appearance", "compact")
      tip.setAttribute("data-placement", "top")
      tip.setAttribute("role", "tooltip")
      tip.style.setProperty("--kb-tooltip-content-transform-origin", "50% 100%")
      tip.textContent = text
      positioner.appendChild(tip)
      document.body.appendChild(positioner)
    } catch {}
  }

  function attachAppTooltip(button, text) {
    let timer = null
    button.addEventListener("mouseenter", () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        showAppTooltip(button, text)
      }, 400)
    })
    button.addEventListener("mouseleave", () => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      hideAppTooltip()
    })
    button.addEventListener("mousedown", hideAppTooltip)
  }

  function buildEditButton(copyBtn) {
    const mine = copyBtn.cloneNode(true)
    if (mine.removeAttribute) mine.removeAttribute("id")
    for (const el of [mine, ...mine.querySelectorAll("*")]) {
      if (!el.attributes) continue
      for (const attr of [...el.attributes]) {
        const name = attr.name
        const value = String(attr.value || "")
        if (name === "id" || name === "title" || name === "aria-label" || name === "aria-labelledby" || value.includes("复制")) {
          el.removeAttribute(name)
        }
      }
      if (el !== mine && el.children.length === 0 && /复制/.test(el.textContent || "")) {
        el.textContent = "修改回复"
      }
    }
    mine.setAttribute(MARK, "button")
    mine.setAttribute("aria-label", "修改回复")
    attachAppTooltip(mine, "修改回复")
    const svg = mine.querySelector("svg")
    if (svg) {
      svg.setAttribute("viewBox", "0 0 24 24")
      svg.setAttribute("fill", "none")
      svg.setAttribute("stroke", "currentColor")
      svg.setAttribute("stroke-width", "2")
      svg.setAttribute("stroke-linecap", "round")
      svg.setAttribute("stroke-linejoin", "round")
      svg.innerHTML = PENCIL_PATHS.map((d) => `<path d="${d}"/>`).join("")
    }
    mine.addEventListener("click", (event) => {
      event.preventDefault()
      event.stopPropagation()
      void openEditor(copyBtn)
    })
    return mine
  }

  function apply() {
    try {
      if (!state.enabled) return
      let injected = 0
      const buttons = document.querySelectorAll(`button[aria-label="${TARGET_LABEL}"]`)
      for (const copyBtn of buttons) {
        // 复制按钮包在应用自带的 tooltip-v2-trigger 容器里（悬停会显示"复制回复"气泡）。
        // 修改按钮要插到该容器**外面**，否则会继承原容器的气泡；改为自带气泡。
        const wrapper = copyBtn.closest ? copyBtn.closest('[data-component="tooltip-v2-trigger"]') : null
        const anchor = wrapper || copyBtn
        const parent = anchor.parentElement
        if (!parent) continue
        if (parent.querySelector(`[${MARK}="button"]`)) { injected++; continue }
        const mine = buildEditButton(copyBtn)
        anchor.insertAdjacentElement("afterend", mine)
        injected++
      }
      if (injected !== state.buttons) console.info(`[oc-cyberbot] buttons=${injected} (enabled=${state.enabled})`)
      state.buttons = injected
    } catch {}
  }

  function removeAll() {
    try {
      for (const node of document.querySelectorAll(`[${MARK}="button"]`)) node.remove()
    } catch {}
    state.buttons = 0
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

  // ---------- 主循环 ----------

  const loop = async () => {
    try {
      const res = await call("ping")
      const nowEnabled = !!(res && res.ok === true)
      if (nowEnabled !== state.enabled) {
        state.enabled = nowEnabled
        console.info(`[oc-cyberbot] enabled=${nowEnabled} (base=${state.serverBase || location.origin})`)
        if (!nowEnabled) removeAll()
      }
      state.lastError = null
    } catch (error) {
      const message = String((error && error.message) || error)
      if (state.lastError !== message) console.info(`[oc-cyberbot] ping failed: ${message} (base=${state.serverBase || location.origin})`)
      state.lastError = message
      if (state.enabled) {
        state.enabled = false
        removeAll()
      }
    }
    schedule()
    timer = setTimeout(loop, REFRESH_MS)
  }

  observer = new MutationObserver(() => schedule())
  observer.observe(document.body, { childList: true, subtree: true })
  window.addEventListener("scroll", hideAppTooltip, true)
  void loop()

  window.__ocCyberbot = true
  window.ocCyberbot = {
    version: VERSION,
    state,
    refresh: async () => {
      try {
        const res = await call("ping")
        state.enabled = !!(res && res.ok === true)
      } catch {
        state.enabled = false
      }
      schedule()
      return state
    },
    remove: removeAll,
    destroy: () => {
      if (timer) clearTimeout(timer)
      try { observer && observer.disconnect() } catch {}
      removeAll()
      hideAppTooltip()
      try {
        for (const node of document.querySelectorAll(`[${MARK}="overlay"]`)) node.remove()
        const t = document.getElementById(`${MARK}-toast`)
        if (t) t.remove()
      } catch {}
      delete window.ocCyberbot
      delete window.__ocCyberbot
    },
  }

  console.info(`[oc-cyberbot] v${VERSION} 已注入：agent 回复的「复制回复」旁将出现铅笔「修改回复」按钮（需服务端插件启用）。`)
})()
