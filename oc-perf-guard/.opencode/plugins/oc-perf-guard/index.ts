// 目录解析兜底入口: package.json exports "." → ./src/index.ts, 此处再导出一份。
export { default, PLUGIN_ID, PLUGIN_VERSION, createMount } from "./src/index"
