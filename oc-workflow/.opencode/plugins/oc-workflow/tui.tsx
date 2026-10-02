/** @jsxImportSource @opentui/solid */
// oc-workflow — TUI 半体:
//   • prompt.footer.status 状态条: 「⌁ wf n」显示最近 run 状态
//   • /workflows 面板: 运行列表

import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { For, createMemo, createSignal, onCleanup, Show } from "solid-js"
import { WorkflowEngineRpc } from "./src/rpc"

const PANEL = "oc-workflow.panel"

interface RunSummary {
  readonly id: string
  readonly name: string
  readonly status: string
  readonly agentsUsed?: number
  readonly updatedAt?: number
}

function PanelBody(props: { runs: RunSummary[]; error: string | null }) {
  const context = usePlugin()
  const colorOf = (status: string) => {
    if (status === "completed") return context.theme.text.feedback.success.base
    if (status === "failed" || status === "stopped") return context.theme.text.feedback.error.base
    return context.theme.text.muted
  }
  return (
    <box flexDirection="column">
      <text fg={context.theme.text.base}>⌁ Workflow 运行</text>
      <Show when={props.runs.length === 0}>
        <text fg={context.theme.text.muted}>还没有运行记录（/workflow list 查看可用 workflow）</text>
      </Show>
      <For each={props.runs}>
        {(run) => (
          <text fg={context.theme.text.base}>
            <span style={{ fg: colorOf(run.status) }}>[{run.status}]</span> {run.name} · {run.id} · agents={run.agentsUsed ?? 0}
          </text>
        )}
      </For>
      <Show when={props.error}>
        <text fg={context.theme.text.feedback.error.base}>查询错误: {props.error}</text>
      </Show>
      <text fg={context.theme.text.muted}>操作: /workflow list | run &lt;name&gt; | show &lt;runId&gt;</text>
    </box>
  )
}

export default Plugin.define({
  id: "oc-workflow.tui",
  setup(context) {
    const [runs, setRuns] = createSignal<RunSummary[]>([])
    const [error, setError] = createSignal<string | null>(null)

    const client = context.client as unknown as {
      rpc?: (definition: unknown) => { runs: (input: { limit: number }) => Promise<{ runs?: RunSummary[] }> }
    }
    const rpc = typeof client.rpc === "function" ? client.rpc(WorkflowEngineRpc) : null

    const pull = async () => {
      if (!rpc) return
      try {
        const result = await rpc.runs({ limit: 20 })
        setRuns(Array.isArray(result?.runs) ? result.runs : [])
        setError(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    }
    void pull()
    const timer = setInterval(() => void pull(), 30_000)
    onCleanup(() => clearInterval(timer))

    const chip = createMemo(() => {
      const latest = runs()[0]
      return latest ? `⌁ ${latest.status}` : "⌁ wf"
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
              id: "oc-workflow.open",
              title: "打开 Workflow 运行列表",
              slash: { name: "workflows" },
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
          <PanelBody runs={runs()} error={error()} />
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
