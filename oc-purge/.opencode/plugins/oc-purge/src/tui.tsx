/** @jsxImportSource @opentui/solid */
// oc-purge — OpenCode TUI 插件半体 (上游 client.js dock 的等价面之一)。
//
// 上游: 会话标题旁 "dsh-purge" 按钮 + 右侧 dock (Clean / Drill 两页)。
// 移植: prompt.footer.status 槽位状态条 + 服务端 RPC 拉取状态;
// 完整面板走桌面端 DOM 注入 (desktop/oc-purge-dock.js)。
//
// 服务端注入不依赖本文件; 该半体仅提供状态条展示。

import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { createMemo, createSignal, onCleanup } from "solid-js"

const BADGE = "⚫ 破甲 v1.1.71"

const REFRESH_EVENTS = new Set<string>([
  "session.text.ended",
  "session.idle",
  "session.execution.succeeded",
  "session.execution.failed",
])

interface PurgeSnapshot {
  readonly enabled?: boolean
  readonly promptSource?: string
  readonly policy?: string
  readonly ruleCount?: number
}

function PurgeBadge() {
  const context = usePlugin()
  const [snapshot, setSnapshot] = createSignal<PurgeSnapshot | null>(null)

  const pull = async () => {
    try {
      const client = context.client as { rpc?: (definition: unknown) => { get: (input: object) => Promise<PurgeSnapshot> } }
      if (typeof client?.rpc !== "function") return
      const { PurgeStatus } = await import("./rpc")
      const result = await client.rpc(PurgeStatus).get({})
      if (result && typeof result === "object") setSnapshot(result)
    } catch {
      // RPC 不可用 (旧运行时 / location 未就绪) 时保持静态徽章
    }
  }
  void pull()

  createMemo(() => {
    const stop = context.data.listen(({ details }) => {
      if (REFRESH_EVENTS.has(details.type)) void pull()
    })
    onCleanup(stop)
    return null
  })

  const label = createMemo(() => {
    const value = snapshot()
    if (!value) return BADGE
    if (value.enabled === false) return `${BADGE} · 已停用`
    const extras: string[] = []
    if (value.promptSource && value.promptSource !== "none") extras.push(value.promptSource)
    if (value.policy) extras.push(value.policy)
    if (typeof value.ruleCount === "number" && value.ruleCount > 0) extras.push(`规则x${value.ruleCount}`)
    return extras.length ? `${BADGE} · ${extras.join(" · ")}` : BADGE
  })

  const color = createMemo(() => {
    const value = snapshot()
    if (value && value.enabled === false) return context.theme.text.feedback.warning.base
    return context.theme.text.feedback.success.base
  })

  return <text fg={color()}>{label()}</text>
}

export default Plugin.define({
  id: "oc-purge.tui",
  setup(context) {
    return context.ui.slot({
      append: "prompt.footer.status",
      render: () => <PurgeBadge />,
    })
  },
})
