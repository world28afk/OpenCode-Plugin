// 目录入口：package.json exports "." 指向 ./src/index.ts，此处再导出一份。
export { default, PLUGIN_ID, PLUGIN_VERSION } from "./src/index"
