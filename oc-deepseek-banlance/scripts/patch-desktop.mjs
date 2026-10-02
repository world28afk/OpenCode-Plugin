#!/usr/bin/env node
// 将 oc-balance-inject.js 注入 OpenCode Desktop 的 app.asar（可选, 可完整还原）。
//
//   node scripts/patch-desktop.mjs --dry-run     # 只做提取+打包验证到临时文件, 不改动安装
//   node scripts/patch-desktop.mjs               # 注入 (要求桌面端已完全退出)
//   node scripts/patch-desktop.mjs --restore     # 还原为注入前的备份
//
// 安全设计:
//   • 首次注入前自动备份 app.asar → app.asar.oc-balance.bak (只保留一份原始备份)
//   • 注入前检测 OpenCode.exe 是否在运行, 运行中直接拒绝 (文件被锁)
//   • 注入后校验 asar 列表包含注入文件
//   • --restore 一键还原

import { spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const injectSource = join(root, "desktop", "oc-balance-inject.js")
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
const appIndex = args.indexOf("--app")
const appPath = appIndex >= 0 && args[appIndex + 1] ? args[appIndex + 1] : defaultApp

const fail = (message) => {
  console.error(`error: ${message}`)
  process.exit(1)
}

if (!existsSync(appPath)) fail(`找不到 app.asar: ${appPath}（可用 --app <路径> 指定）`)
if (!existsSync(injectSource)) fail(`缺少注入脚本: ${injectSource}`)

const backupPath = `${appPath}.oc-balance.bak`
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

// 运行中检测
const tasklist = spawnSync("tasklist /FI \"IMAGENAME eq OpenCode.exe\"", { shell: true, encoding: "utf8" })
const desktopRunning = (tasklist.stdout ?? "").includes("OpenCode.exe")
if (desktopRunning && !dryRun) {
  fail("检测到 OpenCode Desktop 正在运行，请先完全退出（含托盘），再执行本脚本；或先用 --dry-run 验证。")
}

const workDir = join(tmpdir(), `oc-balance-asar-${Date.now()}`)
const packTarget = dryRun ? join(tmpdir(), `oc-balance-test-${Date.now()}.asar`) : appPath

console.log(`app.asar : ${appPath}`)
console.log(`模式      : ${dryRun ? "dry-run（不改动安装）" : "注入"}`)

// 1) 提取
mkdirSync(workDir, { recursive: true })
console.log("提取中…")
asar("extract", appPath, workDir)

// 2) 找 renderer 的 index.html
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

// 3) 注入脚本 + 标签
copyFileSync(injectSource, join(rendererDir, "oc-balance-inject.js"))
const html = readFileSync(indexHtml, "utf8")
if (!html.includes("oc-balance-inject.js")) {
  const tag = '  <script src="./oc-balance-inject.js"></script>\n'
  const next = html.includes("</body>") ? html.replace("</body>", `${tag}</body>`) : html.includes("</head>") ? html.replace("</head>", `${tag}</head>`) : html + tag
  writeFileSync(indexHtml, next, "utf8")
  console.log("已写入 <script> 标签")
} else {
  console.log("已存在 <script> 标签，跳过")
}

// 4) 备份（首次注入时）
if (!dryRun && !existsSync(backupPath)) {
  copyFileSync(appPath, backupPath)
  console.log(`已备份  : ${backupPath}`)
}

// 5) 打包
console.log(`打包中… → ${packTarget}`)
asar("pack", workDir, packTarget)

// 6) 校验
const listed = spawnSync([`npx --yes @electron/asar list ${quote(packTarget)}`].join(""), { shell: true, encoding: "utf8" })
const listText = (listed.stdout ?? "") + (listed.stderr ?? "")
if (!listText.includes("oc-balance-inject.js")) fail("打包校验失败: 未包含 oc-balance-inject.js")
console.log("校验通过: asar 已包含 oc-balance-inject.js")

rmSync(workDir, { recursive: true, force: true })

if (dryRun) {
  console.log(`dry-run 完成（未改动安装）。测试产物: ${packTarget}`)
} else {
  console.log("注入完成。重新启动 OpenCode Desktop 后生效。")
  console.log(`如需还原: node scripts/patch-desktop.mjs --restore   （或复制 ${backupPath} 覆盖回 app.asar）`)
}
