/** @jsxImportSource @opentui/solid */
// oc-deepseek-banlance — TUI 半体:
//   • prompt.footer.status 状态条: 「💠 余额 ¥12.34」
//   • /balance 斜杠命令: 手动刷新
//   • session.panel 面板: 余额详情 (命令或快捷键打开)
//
// 数据经服务端 RPC (POST /api/rpc/deepseek.balance.v1/get) 获取, 不接触 API Key。

import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { createMemo, createSignal, onCleanup, Show } from "solid-js"
import { formatCompact, formatDetail } from "./src/format"
import { DeepSeekBalance } from "./src/rpc"
import type { BalanceSnapshot } from "./src/service"

const PANEL = "oc-deepseek-balance.panel"
const REFRESH_MS = 60_000

interface BalanceRpcClient {
  get(input: { refresh?: boolean }): Promise<BalanceSnapshot>
  refresh(input: Record<string, never>): Promise<BalanceSnapshot>
}

function BalancePanel(props: { snapshot: BalanceSnapshot | null; error: string | null }) {
  const context = usePlugin()
  return (
    <box flexDirection="column">
      <text fg={context.theme.text.base}>💠 DeepSeek 账户余额</text>
      <text fg={context.theme.text.muted}>{formatDetail(props.snapshot)}</text>
      <Show when={props.error()}>
        <text fg={context.theme.text.feedback.error.base}>查询错误: {props.error()}</text>
      </Show>
      <text fg={context.theme.text.muted}>快捷键: /balance 手动刷新 · 每 60 秒自动刷新</text>
    </box>
  )
}

export default Plugin.define({
  id: "oc-deepseek-banlance.tui",
  setup(context) {
    const [snapshot, setSnapshot] = createSignal<BalanceSnapshot | null>(null)
    const [error, setError] = createSignal<string | null>(null)

    const client = context.client as unknown as { rpc?: (definition: unknown) => BalanceRpcClient }
    const rpc = typeof client.rpc === "function" ? client.rpc(DeepSeekBalance) : null

    const pull = async (refresh: boolean) => {
      if (!rpc) return
      try {
        const next = refresh ? await rpc.refresh({}) : await rpc.get({ refresh: false })
        if (next && typeof next === "object") {
          setSnapshot(next)
          setError(null)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    }

    void pull(true)
    const timer = setInterval(() => void pull(false), REFRESH_MS)
    onCleanup(() => clearInterval(timer))

    const label = createMemo(() => {
      const current = snapshot()
      if (current) return `💠 余额 ${formatCompact(current)}`
      if (error()) return "💠 余额 查询失败"
      return "💠 余额 …"
    })

    const color = createMemo(() => {
      const current = snapshot()
      if (current?.ok && current.isAvailable === false) return context.theme.text.feedback.warning.base
      if (current?.ok) return context.theme.text.feedback.success.base
      return context.theme.text.feedback.error.base
    })

    const unregisterFooter = context.ui.slot({
      append: "prompt.footer.status",
      render: () => <text fg={color()}>{label()}</text>,
    })

    const unregisterCommands = context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          priority: 5,
          commands: [
            {
              id: "oc-deepseek-balance.refresh",
              title: "刷新 DeepSeek 余额",
              group: "DeepSeek",
              slash: { name: "balance" },
              run: async () => {
                await pull(true)
                context.ui.toast.show({ message: `DeepSeek 余额: ${formatCompact(snapshot())}` })
              },
            },
            {
              id: "oc-deepseek-balance.panel",
              title: "打开 DeepSeek 余额面板",
              group: "DeepSeek",
              run: () => {
                context.ui.panel.open(PANEL)
              },
            },
          ],
        }))
        return null
      },
    })

    const unregisterPanel = context.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <Show when={panel.name === PANEL}>
          <BalancePanel snapshot={snapshot()} error={error()} />
        </Show>
      ),
    })

    return () => {
      unregisterFooter()
      unregisterCommands()
      unregisterPanel()
    }
  },
})
