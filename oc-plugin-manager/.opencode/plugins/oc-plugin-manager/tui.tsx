/** @jsxImportSource @opentui/solid */
// oc-plugin-manager — TUI 半体:
//   • prompt.footer.status 状态条: 「🧩 插件 n/m」
//   • /plugins 命令 → 插件管理器面板（只读列表; 切换请用桌面设置面板或 plugin_manager_set 工具）

import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { For, createMemo, createSignal, onCleanup, Show } from "solid-js"
import { PluginManager } from "./src/rpc"

const PANEL = "oc-plugin-manager.panel"

interface Entry {
  readonly name: string
  readonly scope: string
  readonly kind: string
  readonly enabled: boolean
  readonly manageable: boolean
  readonly note?: string
}

function ManagerPanel(props: { entries: Entry[]; error: string | null }) {
  const context = usePlugin()
  return (
    <box flexDirection="column">
      <text fg={context.theme.text.base}>🧩 插件管理器</text>
      <text fg={context.theme.text.muted}>共 {props.entries.length} 项 · 启用 {props.entries.filter((entry) => entry.enabled).length}</text>
      <For each={props.entries}>
        {(entry) => (
          <text fg={entry.enabled ? context.theme.text.feedback.success.base : context.theme.text.muted}>
            {entry.enabled ? "●" : "○"} {entry.name} [{entry.scope}/{entry.kind}]
            {entry.manageable ? "" : " · 不可切换"}
          </text>
        )}
      </For>
      <Show when={props.error()}>
        <text fg={context.theme.text.feedback.error.base}>查询错误: {props.error()}</text>
      </Show>
      <text fg={context.theme.text.muted}>切换: 桌面端 设置→扩展→插件, 或让模型调用 plugin_manager_set</text>
    </box>
  )
}

export default Plugin.define({
  id: "oc-plugin-manager.tui",
  setup(context) {
    const [entries, setEntries] = createSignal<Entry[]>([])
    const [error, setError] = createSignal<string | null>(null)

    const client = context.client as unknown as {
      rpc?: (definition: unknown) => { list: (input: Record<string, never>) => Promise<{ entries?: Entry[] }> }
    }
    const rpc = typeof client.rpc === "function" ? client.rpc(PluginManager) : null

    const pull = async () => {
      if (!rpc) return
      try {
        const result = await rpc.list({})
        setEntries(Array.isArray(result?.entries) ? result.entries : [])
        setError(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    }
    void pull()
    const timer = setInterval(() => void pull(), 30_000)
    onCleanup(() => clearInterval(timer))

    const chip = createMemo(() => `🧩 插件 ${entries().filter((entry) => entry.enabled).length}/${entries().length}`)

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
              id: "oc-plugin-manager.open",
              title: "打开插件管理器",
              slash: { name: "plugins" },
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
          <ManagerPanel entries={entries()} error={error()} />
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
