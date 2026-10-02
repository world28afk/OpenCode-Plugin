// 最小 TUI 插件骨架: 状态条 + 斜杠命令 + 会话面板
// 放置: <项目>/.opencode/plugins/acme-plugin/tui.tsx  (package.json exports "./tui")

/** @jsxImportSource @opentui/solid */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { createMemo, createSignal, onCleanup, Show } from "solid-js"

const PANEL = "acme.panel"

function AcmePanel(props: { text: string }) {
  const context = usePlugin()
  return (
    <box flexDirection="column">
      <text fg={context.theme.text.base}>ACME 面板</text>
      <text fg={context.theme.text.muted}>{props.text}</text>
    </box>
  )
}

export default Plugin.define({
  id: "acme-plugin.tui",
  setup(context) {
    const [value, setValue] = createSignal<string | null>(null)

    const pull = async () => {
      // 若定义了 RPC, 可经 context.client.rpc(...) 调用; 这里演示纯客户端逻辑
      setValue(new Date().toLocaleTimeString("zh-CN", { hour12: false }))
    }
    void pull()
    const timer = setInterval(() => void pull(), 60_000)
    onCleanup(() => clearInterval(timer))

    const label = createMemo(() => `ACME ${value() ?? "…"}`)

    const offStatus = context.ui.slot({
      append: "prompt.footer.status",
      render: () => <text fg={context.theme.text.feedback.success.base}>{label()}</text>,
    })

    const offCommands = context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "acme.panel.open",
              title: "打开 ACME 面板",
              slash: { name: "acme" },
              run: () => {
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
          <AcmePanel text={label()} />
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
