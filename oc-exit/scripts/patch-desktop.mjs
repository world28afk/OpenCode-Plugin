#!/usr/bin/env node
// oc-exit 桌面端注入工具（独立于其它插件, 只处理本插件的文件与标签）。
//
//   node scripts/patch-desktop.mjs --dry-run     # 只做提取+打包验证到临时文件, 不改动安装
//   node scripts/patch-desktop.mjs               # 注入 (默认目标: OpenCode Desktop 安装目录)
//   node scripts/patch-desktop.mjs --force       # 目标 asar 被占用时跳过运行中检测
//   node scripts/patch-desktop.mjs --app <asar>  # 指定其它 app.asar (如测试副本)
//   node scripts/patch-desktop.mjs --unpatch     # 只移除本插件的注入 (不还原其它插件)
//   node scripts/patch-desktop.mjs --restore     # 还原为首次注入前的备份
//
// 说明:
//   • 每个插件独立注入: 提取当前 asar → 只添加本插件的脚本文件与 <script> 标签 → 回写
//   • 幂等: 重复执行安全; 与其它插件的注入共存互不影响
//   • 首次注入前自动备份 app.asar → app.asar.oc-exit.bak

import { spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const injectSource = join(root, "desktop", "oc-exit-inject.js")
const injectName = "oc-exit-inject.js"
const defaultApp = join(
  process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
  "Programs",
  "@opencodedesktop",
  "resources",
  "app.asar",
)

const args = process.argv.slice(2)
const dryRun = args.includes("--dry-run")
const restore = args.includes("--restore")
const unpatch = args.includes("--unpatch")
const force = args.includes("--force")
const appIndex = args.indexOf("--app")
const appPath = appIndex >= 0 && args[appIndex + 1] ? args[appIndex + 1] : defaultApp

const fail = (message) => {
  console.error(`error: ${message}`)
  process.exit(1)
}

if (!existsSync(appPath)) fail(`找不到 app.asar: ${appPath}（可用 --app <路径> 指定）`)

const backupPath = `${appPath}.oc-exit.bak`
const quote = (value) => (/[\s"&|<>^()]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value)
const run = (command, commandArgs) => {
  const line = [command, ...commandArgs].map(quote).join(" ")
  const result = spawnSync(line, { shell: true, stdio: ["ignore", "inherit", "inherit"], encoding: "utf8" })
  if (result.status !== 0) fail(`命令失败(${result.status}): ${line}`)
}
const asar = (action, ...rest) => run("npx", ["--yes", "@electron/asar", action, ...rest])

if (restore) {
  if (!existsSync(backupPath)) fail(`没有找到备份: ${backupPath}`)
  copyFileSync(backupPath, appPath)
  console.log(`已还原: ${appPath}`)
  console.log(`备份保留在: ${backupPath}（可手动删除）`)
  process.exit(0)
}

const isDefaultTarget = appPath === defaultApp
if (!dryRun && !force && isDefaultTarget) {
  const tasklist = spawnSync('tasklist /FI "IMAGENAME eq OpenCode.exe"', { shell: true, encoding: "utf8" })
  if ((tasklist.stdout ?? "").includes("OpenCode.exe")) {
    fail("检测到 OpenCode Desktop 正在运行，请先完全退出（含托盘），或加 --force；也可先用 --dry-run 验证。")
  }
}

if (unpatch && !existsSync(injectSource)) {
  // unpatch 不依赖源脚本存在
} else if (!existsSync(injectSource)) {
  fail(`缺少注入脚本: ${injectSource}`)
}

const workDir = join(tmpdir(), `oc-exit-asar-${Date.now()}`)
const packTarget = dryRun ? join(tmpdir(), `oc-exit-test-${Date.now()}.asar`) : appPath

console.log(`app.asar : ${appPath}`)
console.log(`模式      : ${dryRun ? "dry-run（不改动安装）" : unpatch ? "移除本插件注入" : "注入"}`)

mkdirSync(workDir, { recursive: true })
console.log("提取中…")
asar("extract", appPath, workDir)

const findIndexHtml = (dir) => {
  const candidates = []
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name === "index.html") candidates.push(full)
    }
  }
  walk(dir)
  if (candidates.length === 0) fail("asar 中未找到 index.html")
  candidates.sort((a, b) => {
    const score = (value) => (value.includes("renderer") ? 0 : 1)
    return score(a) - score(b) || a.length - b.length
  })
  return candidates[0]
}

const indexHtml = findIndexHtml(workDir)
const rendererDir = dirname(indexHtml)
console.log(`renderer  : ${relative(workDir, indexHtml)}`)

if (unpatch) {
  let html = readFileSync(indexHtml, "utf8")
  const before = html
  html = html
    .split("\n")
    .filter((line) => !line.includes(injectName))
    .join("\n")
  const scriptPath = join(rendererDir, injectName)
  if (existsSync(scriptPath)) rmSync(scriptPath, { force: true })
  if (html === before) {
    console.log("未发现本插件注入，无需移除")
  } else {
    writeFileSync(indexHtml, html, "utf8")
    console.log("已移除本插件的 <script> 标签与脚本文件")
  }
} else {
  copyFileSync(injectSource, join(rendererDir, injectName))
  const html = readFileSync(indexHtml, "utf8")
  if (!html.includes(injectName)) {
    const tag = `  <script src="./${injectName}"></script>\n`
    const next = html.includes("</body>") ? html.replace("</body>", `${tag}</body>`) : html.replace("</head>", `${tag}</head>`)
    writeFileSync(indexHtml, next, "utf8")
    console.log("已写入 <script> 标签")
  } else {
    console.log("已存在 <script> 标签，跳过")
  }
}

if (!dryRun && !unpatch && !existsSync(backupPath)) {
  copyFileSync(appPath, backupPath)
  console.log(`已备份  : ${backupPath}`)
}

console.log(`打包中… → ${packTarget}`)
asar("pack", workDir, packTarget)

const listed = spawnSync(`npx --yes @electron/asar list ${quote(packTarget)}`, { shell: true, encoding: "utf8" })
const listText = (listed.stdout ?? "") + (listed.stderr ?? "")
const ok = unpatch ? !listText.includes(injectName) : listText.includes(injectName)
if (dryRun && !ok) fail("打包校验失败")
if (!dryRun && !ok) fail(unpatch ? "校验失败: 仍包含注入脚本" : "打包校验失败: 未包含注入脚本")
console.log(`校验通过: ${unpatch ? "注入已移除" : "asar 已包含注入脚本"}`)

rmSync(workDir, { recursive: true, force: true })

if (dryRun) {
  console.log(`dry-run 完成（未改动安装）。测试产物: ${packTarget}`)
} else if (unpatch) {
  console.log("移除完成。重新启动 OpenCode Desktop 后生效。")
} else {
  console.log("注入完成。重新启动 OpenCode Desktop 后生效。")
  console.log("如需移除本插件注入: node scripts/patch-desktop.mjs --unpatch")
}
