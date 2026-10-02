// oc-plugin-manager — 服务端插件入口。
// 运行时自包含: 默认导出 { id, setup }, 不 import 宿主包的运行时值。

import type { Plugin } from "@opencode/plugin"
import { mount, PLUGIN_ID } from "./mount"

export { PLUGIN_ID, PLUGIN_VERSION } from "./mount"
export { PluginManager, RPC_ID } from "./rpc"

export default { id: PLUGIN_ID, setup: mount } satisfies Plugin.Plugin
