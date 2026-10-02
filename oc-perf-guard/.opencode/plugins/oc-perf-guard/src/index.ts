// oc-perf-guard — 服务端插件入口。
// 运行时自包含: 默认导出 { id, setup }, 不 import 宿主包的运行时值。

import type { Plugin } from "@opencode/plugin"
import { createMount, PLUGIN_ID } from "./mount"

export { PLUGIN_ID, PLUGIN_VERSION, createMount } from "./mount"
export { PerfGuard, RPC_ID } from "./rpc"
export * from "./processes"
export * from "./scripts"
export * from "./governor"
export * from "./judge"

export default { id: PLUGIN_ID, setup: createMount() } satisfies Plugin.Plugin
