// oc-cyberbot 服务端插件入口。
//
// 运行时只包含: 默认导出 { id, setup }，不 import 任何运行时值；
// "@opencode/plugin" 仅作 import type 使用（与仓库内其它插件保持一致）。

import type { Plugin } from "@opencode/plugin"
import { mount, PLUGIN_ID } from "./mount"

export { PLUGIN_ID, PLUGIN_VERSION } from "./mount"
export { CyberbotRPC, RPC_ID } from "./rpc"

const plugin = { id: PLUGIN_ID, setup: mount } satisfies Plugin.Plugin

export default plugin
