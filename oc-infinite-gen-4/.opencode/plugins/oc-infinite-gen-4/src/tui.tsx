/** @jsxImportSource @opentui/solid */
// oc-infinite-gen-4 — OpenCode TUI 插件半体 (上游 client.js 状态条的等价面)。
//
// 上游: conversation.input.dock 槽位 + useProjection("armor") 实时投影。
// 移植: prompt.footer.status 槽位 + src/armor.ts 评分器 (读取会话消息缓存)。
// 显示「⚫ 无限四代 v0.4.0」, 并在可判定时追加 ✓ 通过/域/载荷 或 ✗ 拒绝标记。
//
// 服务端注入不依赖本文件; 该半体仅提供状态条展示。

import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { createEffect, createMemo, onCleanup } from "solid-js"
import { projectMessages, type ArmorState } from "./armor"

const BADGE = "⚫ 无限四代 v0.4.0"

/** 触发状态条重新评分的服务端事件 (回复文本结束/会话空闲/执行状态切换)。 */
const REFRESH_EVENTS = new Set<string>([
  "session.text.ended",
  "session.step.ended",
  "session.idle",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
])

function ArmorBadge(props: { readonly sessionID?: string }) {
  const context = usePlugin()

  createEffect(() => {
    const sessionID = props.sessionID
    if (!sessionID) return
    void context.data.session.message.sync(sessionID).catch(() => {})
  })

  createEffect(() => {
    const stop = context.data.listen(({ details }) => {
      const sessionID = props.sessionID
      if (!sessionID) return
      if (!REFRESH_EVENTS.has(details.type)) return
      context.data.session.message.invalidate(sessionID)
    })
    onCleanup(stop)
  })

  const state = createMemo<ArmorState | undefined>(() => {
    const sessionID = props.sessionID
    if (!sessionID) return undefined
    return projectMessages(context.data.session.message.list(sessionID) ?? [])
  })

  const label = createMemo(() => {
    const armor = state()
    if (!armor?.verdict) return armor?.running ? `${BADGE} · 执行中…` : BADGE
    if (armor.verdict === "pass") {
      const extras = ["✓ 通过"]
      if (armor.domain) extras.push(armor.domain)
      if (armor.risk.length) extras.push(`载荷x${armor.risk.length}`)
      return `${BADGE} · ${extras.join(" · ")}`
    }
    return `${BADGE} · ✗ ${armor.words[0] ?? "触发安全拒绝"}`
  })

  const color = createMemo(() => {
    const armor = state()
    if (!armor?.verdict) return context.theme.text.base
    return armor.verdict === "pass"
      ? context.theme.text.feedback.success.base
      : context.theme.text.feedback.error.base
  })

  return <text fg={color()}>{label()}</text>
}

export default Plugin.define({
  id: "oc-infinite-gen-4.tui",
  setup(context) {
    return context.ui.slot({
      append: "prompt.footer.status",
      render: (input) => <ArmorBadge sessionID={input.sessionID} />,
    })
  },
})
