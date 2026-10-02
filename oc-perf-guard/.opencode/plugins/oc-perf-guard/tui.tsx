/** @jsxImportSource @opentui/solid */
// oc-perf-guard — TUI 半体:
//   • prompt.footer.status 状态条: 「⚙ 进程 n / 脚本 m」, 超阈值变红
//   • /perf 面板: MCP 分类明细 + 脚本治理列表

import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { For, createMemo, createSignal, onCleanup, Show } from "solid-js"
import { PerfGuard } from "./src/rpc"

const PANEL = "oc-perf-guard.panel"

interface Category {
  readonly name: string
  readonly count: number
  readonly mb: number
}

interface TrackedScript {
  readonly pid?: number
  readonly name?: string
  readonly cpuPercent?: number
  readonly mb?: number
  readonly reason?: readonly string[]
  readonly state?: string
  readonly verdict?: { readonly action?: string } | null
}

interface Status {
  readonly runtimes?: { count?: number; mb?: number }
  readonly categories?: Category[]
  readonly warn?: boolean
  readonly warnings?: string[]
  readonly scripts?: { enabled?: boolean; tracking?: TrackedScript[] }
}

function PanelBody(props: { status: Status | null; error: string | null }) {
  const context = usePlugin()
  const scripts = () => props.status?.scripts?.tracking ?? []
  return (
    <box flexDirection="column">
      <text fg={context.theme.text.base}>⚙ 性能守卫</text>
      <Show when={props.status}>
        {(value) => (
          <>
            <text fg={(value().warn ?? false) ? context.theme.text.feedback.error.base : context.theme.text.muted}>
              运行时进程 {value().runtimes?.count ?? 0} 个 · {(value().runtimes?.mb ?? 0).toFixed?.(1) ?? value().runtimes?.mb} MB
            </text>
            <For each={value().categories ?? []}>
              {(category) => (
                <text fg={context.theme.text.base}>
                  {category.name}: {category.count} 个 · {category.mb}MB
                </text>
              )}
            </For>
            <Show when={scripts().length > 0}>
              <text fg={context.theme.text.base}>脚本治理:</text>
              <For each={scripts()}>
                {(script) => (
                  <text fg={script.state === "kept" ? context.theme.text.muted : context.theme.text.feedback.error.base}>
                    {script.state === "kept" ? "○" : "●"} pid={script.pid} {script.name} CPU {script.cpuPercent ?? 0}% · {script.mb ?? 0}MB ·{" "}
                    {(script.reason ?? []).join(",")} [{script.state}{script.verdict?.action ? `→${script.verdict.action}` : ""}]
                  </text>
                )}
              </For>
            </Show>
            <For each={value().warnings ?? []}>
              {(warning) => <text fg={context.theme.text.feedback.error.base}>⚠ {warning}</text>}
            </For>
          </>
        )}
      </Show>
      <Show when={props.error}>
        <text fg={context.theme.text.feedback.error.base}>查询错误: {props.error}</text>
      </Show>
      <text fg={context.theme.text.muted}>脚本: script_list / script_kill / script_keep / script_nice · MCP: perf_cleanup</text>
    </box>
  )
}

export default Plugin.define({
  id: "oc-perf-guard.tui",
  setup(context) {
    const [status, setStatus] = createSignal<Status | null>(null)
    const [error, setError] = createSignal<string | null>(null)

    const client = context.client as unknown as {
      rpc?: (definition: unknown) => { status: (input: Record<string, never>) => Promise<Status> }
    }
    const rpc = typeof client.rpc === "function" ? client.rpc(PerfGuard) : null

    const pull = async () => {
      if (!rpc) return
      try {
        setStatus(await rpc.status({}))
        setError(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    }
    void pull()
    const timer = setInterval(() => void pull(), 60_000)
    onCleanup(() => clearInterval(timer))

    const chip = createMemo(() => {
      const value = status()
      if (!value) return "⚙ …"
      const scripts = value.scripts?.tracking?.length ?? 0
      return scripts > 0 ? `⚙ ${value.runtimes?.count ?? 0} 进程 · ${scripts} 脚本` : `⚙ ${value.runtimes?.count ?? 0} 进程`
    })

    const offStatus = context.ui.slot({
      append: "prompt.footer.status",
      render: () => (
        <text fg={status()?.warn || (status()?.scripts?.tracking?.length ?? 0) > 0 ? context.theme.text.feedback.error.base : context.theme.text.base}>
          {chip()}
        </text>
      ),
    })

    const offCommands = context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "oc-perf-guard.open",
              title: "打开性能守卫",
              slash: { name: "perf" },
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
          <PanelBody status={status()} error={error()} />
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
