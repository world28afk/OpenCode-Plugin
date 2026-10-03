/** @jsxImportSource @opentui/solid */
// oc-exit — TUI 半体:
//   • /exit-app 命令: 彻底退出（关闭界面 + 结束后台服务）
// 桌面角标由 desktop/oc-exit-inject.js 提供, 与此半体互不依赖。

import { Plugin } from "@opencode/plugin/tui"
import { launchQuit } from "./src/quit"

export default Plugin.define({
  id: "oc-exit.tui",
  setup(context) {
    const off = context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "oc-exit.quit",
              title: "彻底退出 OpenCode",
              slash: { name: "exit-app" },
              run: () => {
                launchQuit()
              },
            },
          ],
        }))
        return null
      },
    })
    return () => off()
  },
})
