// 目录级兜底入口: package.json 的 exports "." 指向 ./src/index.ts, 此处再导出一份。
export { default, PLUGIN_ID, PLUGIN_VERSION, createMount } from "./src/index"
