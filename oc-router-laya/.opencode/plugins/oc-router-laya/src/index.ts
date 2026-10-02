// oc-router-laya — 服务端插件入口。
// 运行时自包含: 默认导出 { id, setup }, 不 import 宿主包的运行时值。

import type { Plugin } from "@opencode/plugin"
import { createMount, PLUGIN_ID } from "./mount"

export { PLUGIN_ID, PLUGIN_VERSION, createMount } from "./mount"
export { RouterLaya, RPC_ID } from "./rpc"
export * from "./tiers"
export * from "./policy"
export * from "./config"
export * from "./state"

export default { id: PLUGIN_ID, setup: createMount() } satisfies Plugin.Plugin
