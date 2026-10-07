// oc-bark — OpenCode 服务端半体。
// 运行时打包为纯对象 { id, setup }; 类型来自 @opencode/plugin (仅编译期)。

import type { Plugin } from "@opencode/plugin"
import { createMount, PLUGIN_ID } from "./mount"

export { PLUGIN_ID, PLUGIN_VERSION, createMount, claimOnce, resetClaims, type MountHandle, type TurnRecord, type BarkStats, type BarkDeps } from "./mount"
export { Bark, RPC_ID, type BarkDefinition } from "./rpc"
export * from "./bark"
export * from "./config"
export * from "./format"

export default { id: PLUGIN_ID, setup: createMount() } satisfies Plugin.Plugin
