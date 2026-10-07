/**
 * oc-plugin-manager — Desktop 设置面板注入脚本
 *
 * 在 OpenCode Desktop 的「偏好设置 → 扩展 → 插件」列表中，为每个插件追加
 * 原生样式开关（与 MCP 列表完全一致的 [data-component="switch"] 结构，
 * 直接复用应用自带 CSS）；被禁用的插件会以灰显行形式补列表尾，可随时重新启用。
 *
 * 数据通道: 服务端插件 RPC
 *   POST {base}/api/rpc/plugin.manager/list   { "input": {} }                     → { entries: [...] }
 *   POST {base}/api/rpc/plugin.manager/set    { "input": { name, scope, enabled } } → { ok, ... }
 *
 * 安装（持久化）: node scripts/patch-desktop.mjs（独立注入, 可 --unpatch 移除）
 * 临时: Ctrl+Shift+I → Console → 粘贴本文件
 */
;(() => {
  "use strict"
  if (window.__ocPluginManager) return

  const VERSION = "0.2.0"
  const RPC_ID = "plugin.manager"
  const MARK = "data-oc-plugin-manager"
  const LS_BASE = "oc-plugin-manager:serverBase"
  const SHARED_BASE_KEYS = ["oc-deepseek-banlance:serverBase", "oc-deepseek-balance:serverBase", "oc-infinite-gen-4:serverBase"]
  const PORTS = [49374, 4096, 49375, 49376, 49377, 3001]
  const REFRESH_MS = 15_000

  const state = { entries: [], error: null, loadedAt: 0, busy: false }
  let timer = null
  let scheduled = false
  let observer = null
  let basePromise = null

  const strip = (v) => String(v || "").replace(/\/+$/, "")

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
    } catch {}
    const boot = window.electron && window.electron.bootstrap
    if (boot && typeof boot === "object" && typeof boot.defaultServerUrl === "string") candidates.push(strip(boot.defaultServerUrl))
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
      try { localStorage.setItem(LS_BASE, hit) } catch {}
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

  async function pull() {
    try {
      const result = await call("list")
      if (result && Array.isArray(result.entries)) {
        state.entries = result.entries
        state.error = null
        state.loadedAt = Date.now()
      }
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error)
    }
    schedule()
  }

  async function toggle(entry, enabled) {
    state.busy = true
    try {
      await call("set", { name: entry.name, scope: entry.scope, kind: entry.kind, enabled })
      await pull()
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error)
      schedule()
    } finally {
      state.busy = false
    }
  }

  // ── 原生样式开关（结构与设置页 MCP 列表完全一致, 应用 CSS 直接生效） ──────

  /**
   * 复刻应用 [data-component="switch"] 的 DOM:
   *   div[role=group][data-component=switch][data-appearance=compact]
   *     ├─ input[role=switch][data-slot=switch-input]
   *     ├─ label.sr-only[data-slot=switch-label]
   *     └─ div[data-slot=switch-control] > div[data-slot=switch-thumb]
   * 选中态 = 各元素带 data-checked 属性（与应用一致）。
   */
  function buildSwitch(name, checked) {
    const group = document.createElement("div")
    group.setAttribute("role", "group")
    group.setAttribute("data-component", "switch")
    group.setAttribute("data-appearance", "compact")
    group.setAttribute(MARK, name)
    group.style.flexShrink = "0"

    const input = document.createElement("input")
    input.type = "checkbox"
    input.setAttribute("role", "switch")
    input.value = "on"
    input.setAttribute("data-slot", "switch-input")
    input.style.cssText =
      "border:0;clip:rect(0,0,0,0);clip-path:inset(50%);height:1px;margin:-1px;overflow:hidden;padding:0;position:absolute;width:1px;white-space:nowrap"

    const label = document.createElement("label")
    label.setAttribute("data-slot", "switch-label")
    label.className = "sr-only"
    label.textContent = name

    const control = document.createElement("div")
    control.setAttribute("data-slot", "switch-control")
    const thumb = document.createElement("div")
    thumb.setAttribute("data-slot", "switch-thumb")
    control.appendChild(thumb)

    group.append(input, label, control)
    setSwitchChecked(group, checked)
    return group
  }

  function setSwitchChecked(group, checked) {
    if (checked) group.setAttribute("data-checked", "")
    else group.removeAttribute("data-checked")
    for (const el of group.querySelectorAll("[data-slot]")) {
      if (el.getAttribute("data-slot") === "switch-input") {
        el.setAttribute("aria-checked", String(!!checked))
      }
      if (checked) el.setAttribute("data-checked", "")
      else el.removeAttribute("data-checked")
    }
  }

  function attachToggle(group) {
    group.addEventListener("click", (event) => {
      event.stopPropagation()
      event.preventDefault()
      if (state.busy) return
      // 点击时按当前状态查找（避免闭包引用过期条目）
      const current = findEntry(group.getAttribute(MARK) || "")
      if (!current || !current.manageable) return
      const next = !current.enabled
      setSwitchChecked(group, next) // 乐观更新
      void toggle(current, next)
    })
  }

  // ── UI 注入 ──────────────────────────────────────────────────────────────

  function findEntry(name) {
    const list = state.entries
    return (
      list.find((e) => e.name === name && e.scope === "global" && e.kind !== "config") ??
      list.find((e) => e.name === name && e.kind !== "config") ??
      list.find((e) => e.name === name)
    )
  }

  function activePluginList() {
    const trigger = document.querySelector('button[role="tab"][data-key="plugins"][aria-selected="true"]')
    if (!trigger) return null
    const controls = trigger.getAttribute("aria-controls")
    const panel = controls ? document.getElementById(controls) : null
    if (!panel) return null
    // 实测 2.0.22: 列表容器为 data-component="settings-list"; 兼容 class 形式
    return panel.querySelector('[data-component="settings-list"]') || panel.querySelector(".settings-list")
  }

  function apply() {
    try {
      const list = activePluginList()
      if (!list) return

      // 已启用条目: 移除遗留的灰显行
      for (const row of list.querySelectorAll(`[${MARK}-row]`)) {
        const name = row.getAttribute(`${MARK}-row`)
        const entry = state.entries.find((e) => e.name === name)
        if (entry && entry.enabled) row.remove()
      }

      const seen = new Set()
      for (const row of list.querySelectorAll(".settings-extension-row")) {
        if (row.hasAttribute(`${MARK}-row`)) continue // 合成行单独处理
        const nameNode = row.querySelector(".settings-extension-name")
        const name = nameNode ? (nameNode.textContent || "").trim() : ""
        if (!name) continue
        const entry = findEntry(name)
        if (!entry) continue
        if (!entry.manageable) continue // 管理器自身等不可切换条目: 不显示开关
        seen.add(entry.name)
        let control = row.querySelector(`[${MARK}]`)
        if (!control) {
          control = buildSwitch(entry.name, entry.enabled)
          attachToggle(control)
          row.appendChild(control)
        } else {
          setSwitchChecked(control, entry.enabled)
        }
        control.title = `${entry.enabled ? "点击禁用" : "点击启用"} ${entry.name}（${entry.scope}/${entry.kind}）`
      }

      // 已禁用（不在应用列表中）的插件: 补灰显行, 提供重新启用入口
      for (const entry of state.entries) {
        if (!entry.manageable) continue
        if (entry.enabled) continue
        if (seen.has(entry.name)) continue
        if (list.querySelector(`[${MARK}-row="${entry.name}"]`)) continue
        const row = document.createElement("div")
        row.className = "settings-extension-row"
        row.setAttribute(`${MARK}-row`, entry.name)
        row.style.opacity = "0.65"
        const lead = document.createElement("div")
        lead.className = "settings-extension-lead"
        const nameEl = document.createElement("span")
        nameEl.className = "settings-extension-name truncate"
        nameEl.textContent = entry.name
        lead.appendChild(nameEl)
        row.appendChild(lead)
        const control = buildSwitch(entry.name, false)
        attachToggle(control)
        row.appendChild(control)
        list.appendChild(row)
      }
    } catch {
      // UI 注入失败不影响功能
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

  const loop = async () => {
    await pull()
    timer = setTimeout(loop, REFRESH_MS)
  }
  void loop()

  observer = new MutationObserver(() => schedule())
  observer.observe(document.body, { childList: true, subtree: true })

  window.__ocPluginManager = true
  window.ocPluginManager = {
    version: VERSION,
    state,
    refresh: () => pull(),
    setServerBase: (url) => {
      try {
        url ? localStorage.setItem(LS_BASE, strip(url)) : localStorage.removeItem(LS_BASE)
      } catch {}
      basePromise = null
      return pull()
    },
    destroy: () => {
      if (timer) clearTimeout(timer)
      observer?.disconnect()
      for (const node of document.querySelectorAll(`[${MARK}], [${MARK}-row]`)) node.remove()
      delete window.ocPluginManager
      delete window.__ocPluginManager
    },
  }

  console.info(`[oc-plugin-manager] v${VERSION} 已注入: 设置→扩展→插件 列表右侧将出现原生样式开关。`)
})()
