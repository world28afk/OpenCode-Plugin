/** @jsxImportSource @opentui/solid */
// oc-router-laya — TUI 半体:
//   • prompt.footer.status 状态条: 「⌁ auto·high」显示模式与最近档位
//   • /router 面板: 最近决策列表（档位/触发层/应用结果）

import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { For, createMemo, createSignal, onCleanup, Show } from "solid-js"
import { RouterLaya } from "./src/rpc"

const PANEL = "oc-router-laya.panel"

interface DecisionSummary {
  readonly at?: number
  readonly tier?: string
  readonly triggeredBy?: string
  readonly regenerate?: boolean
  readonly applied?: { providerID?: string; id?: string; variant?: string } | null
  readonly appliedReason?: string | null
  readonly text?: string
}

interface StatusPayload {
  readonly mode?: string
  readonly judge?: string
  readonly tiers?: Record<string, { providerID?: string; id?: string; variant?: string } | null>
  readonly lastDecision?: DecisionSummary | null
}

function PanelBody(props: { status: StatusPayload | null; history: DecisionSummary[]; error: string | null }) {
  const context = usePlugin()
  const tierColor = (tier: string | undefined) => {
    if (tier === "max") return context.theme.text.feedback.error.base
    if (tier === "high") return context.theme.text.feedback.warning?.base ?? context.theme.text.base
    return context.theme.text.muted
  }
  return (
    <box flexDirection="column">
      <text fg={context.theme.text.base}>⌁ 档位路由 (router-laya)</text>
      <Show when={props.status}>
        {(status) => (
          <>
            <text fg={context.theme.text.muted}>
              模式 {status().mode} · 判定 {status().judge}
            </text>
            <For each={Object.entries(status().tiers ?? {})}>
              {([tier, route]) => (
                <text fg={context.theme.text.base}>
                  {tier}: {route ? `${route.providerID}/${route.id}${route.variant ? `:${route.variant}` : ""}` : "(未配置)"}
                </text>
              )}
            </For>
          </>
        )}
      </Show>
      <text fg={context.theme.text.muted}>最近决策:</text>
      <For each={props.history.slice(0, 10)}>
        {(entry) => (
          <text fg={context.theme.text.base}>
            <span style={{ fg: tierColor(entry.tier) }}>[{entry.tier}]</span> {entry.triggeredBy}
            {entry.regenerate ? " ↻" : ""}
            {entry.applied ? ` → ${entry.applied.id}${entry.applied.variant ? `:${entry.applied.variant}` : ""}` : entry.appliedReason ? ` (${entry.appliedReason})` : ""}
          </text>
        )}
      </For>
      <Show when={props.error}>
        <text fg={context.theme.text.feedback.error.base}>查询错误: {props.error}</text>
      </Show>
      <text fg={context.theme.text.muted}>命令: /router status | auto | manual | tier high | decide &lt;文本&gt;</text>
    </box>
  )
}

export default Plugin.define({
  id: "oc-router-laya.tui",
  setup(context) {
    const [status, setStatus] = createSignal<StatusPayload | null>(null)
    const [history, setHistory] = createSignal<DecisionSummary[]>([])
    const [error, setError] = createSignal<string | null>(null)

    const client = context.client as unknown as {
      rpc?: (definition: unknown) => {
        status: (input: Record<string, never>) => Promise<StatusPayload>
        history: (input: { limit: number }) => Promise<{ history?: DecisionSummary[] }>
      }
    }
    const rpc = typeof client.rpc === "function" ? client.rpc(RouterLaya) : null

    const pull = async () => {
      if (!rpc) return
      try {
        setStatus(await rpc.status({}))
        const result = await rpc.history({ limit: 20 })
        setHistory(Array.isArray(result?.history) ? result.history : [])
        setError(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    }
    void pull()
    const timer = setInterval(() => void pull(), 30_000)
    onCleanup(() => clearInterval(timer))

    const chip = createMemo(() => {
      const value = status()
      const tier = value?.lastDecision?.tier
      return `⌁ ${value?.mode ?? "?"}${tier ? `·${tier}` : ""}`
    })

    const offStatus = context.ui.slot({
      append: "prompt.footer.status",
      render: () => <text fg={context.theme.text.base}>{chip()}</text>,
    })

    const offCommands = context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "oc-router-laya.open",
              title: "打开档位路由面板",
              slash: { name: "router" },
              run: () => {
                void pull()
                context.ui.panel.open(PANEL)
              },
            },
          ],
        }))
        return null
      },
    })

    const offPanel = context.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <Show when={panel.name === PANEL}>
          <PanelBody status={status()} history={history()} error={error()} />
        </Show>
      ),
    })

    return () => {
      offStatus()
      offCommands()
      offPanel()
    }
  },
})
