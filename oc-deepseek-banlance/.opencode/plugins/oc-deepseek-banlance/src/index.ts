// oc-deepseek-banlance — OpenCode 服务端插件入口。
//
// 运行时自包含: 默认导出 { id, setup }, 不 import 任何宿主包的运行时值。
// "@opencode/plugin" 仅作 import type 使用, 编译期擦除。

import type { Plugin } from "@opencode/plugin"
import { mount, PLUGIN_ID } from "./mount"

export { PLUGIN_ID, PLUGIN_VERSION } from "./mount"
export { DeepSeekBalance, RPC_ID } from "./rpc"

export default { id: PLUGIN_ID, setup: mount } satisfies Plugin.Plugin
