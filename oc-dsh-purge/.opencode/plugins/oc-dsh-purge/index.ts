// 目录解析兜底入口: 当宿主按目录加载插件且不读取 package.json exports 时使用。
// 正常加载路径是 package.json 的 "." → ./src/index.ts。
export { default, PLUGIN_ID, PLUGIN_VERSION } from "./src/index"
