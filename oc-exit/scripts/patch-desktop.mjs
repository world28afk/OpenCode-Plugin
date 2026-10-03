#!/usr/bin/env node
// oc-exit 桌面端注入工具（独立于其它插件, 只处理本插件的标记）。
//
//   node scripts/patch-desktop.mjs --dry-run     # 只做提取+打包验证到临时文件, 不改动安装
//   node scripts/patch-desktop.mjs               # 注入系统托盘（默认目标: OpenCode Desktop 安装目录）
//   node scripts/patch-desktop.mjs --force       # 目标 asar 被占用时跳过运行中检测
//   node scripts/patch-desktop.mjs --app <asar>  # 指定其它 app.asar (如测试副本)
//   node scripts/patch-desktop.mjs --unpatch     # 只移除本插件的注入 (不还原其它插件)
//   node scripts/patch-desktop.mjs --restore     # 还原为首次注入前的备份
//
// 注入位置: out/main/index.js（主进程）—— 追加一段创建系统托盘（Tray）的片段:
//   • 托盘右键: 显示 OpenCode / 退出 OpenCode
//   • 关闭主窗口改为「收进托盘」（不再直接退出）, 托盘常驻
//   • 退出 = 结束后台服务 opencode-cli.exe（含子进程）+ 关闭界面
//
// 说明:
//   • 每个插件独立注入: 提取当前 asar → 只添加本插件的标记片段 → 回写
//   • 幂等: 重复执行安全; 与其它插件（渲染层注入）互不影响
//   • 首次注入前自动备份 app.asar → app.asar.oc-exit.bak

import { spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const traySource = join(root, "desktop", "oc-exit-tray.js")
const LEGACY_INJECT = "oc-exit-inject.js"
const MARK_START = "/* oc-exit:tray:start */"
const MARK_END = "/* oc-exit:tray:end */"
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
const run = (command, commandArgs, inherit = true) => {
  const line = [command, ...commandArgs].map(quote).join(" ")
  const result = spawnSync(line, { shell: true, stdio: inherit ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"], encoding: "utf8" })
  if (result.status !== 0 && inherit) fail(`命令失败(${result.status}): ${line}`)
  return result
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

if (!unpatch && !existsSync(traySource)) fail(`缺少托盘注入片段: ${traySource}`)

const workDir = join(tmpdir(), `oc-exit-asar-${Date.now()}`)
const packTarget = dryRun ? join(tmpdir(), `oc-exit-test-${Date.now()}.asar`) : appPath

console.log(`app.asar : ${appPath}`)
console.log(`模式      : ${dryRun ? "dry-run（不改动安装）" : unpatch ? "移除本插件注入" : "注入（系统托盘）"}`)

mkdirSync(workDir, { recursive: true })
console.log("提取中…")
asar("extract", appPath, workDir)

// 定位主进程入口（package.json 的 main）
const pkgPath = join(workDir, "package.json")
if (!existsSync(pkgPath)) fail("asar 中未找到 package.json")
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
const mainEntry = typeof pkg.main === "string" ? pkg.main.replace(/^\.\//, "") : "out/main/index.js"
const mainPath = join(workDir, mainEntry)
if (!existsSync(mainPath)) fail(`找不到主进程入口: ${mainEntry}`)
console.log(`主进程    : ${relative(workDir, mainPath)}`)

const stripBlock = (text) => {
  const startIndex = text.indexOf(MARK_START)
  if (startIndex < 0) return text
  const endIndex = text.indexOf(MARK_END, startIndex)
  if (endIndex < 0) return text
  return text.slice(0, startIndex) + text.slice(endIndex + MARK_END.length)
}

// 兼容清理：早期版本注入到渲染层 index.html 的角标
const cleanupLegacy = () => {
  const findIndexHtml = (dir) => {
    const found = []
    const walk = (current) => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = join(current, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name === "index.html") found.push(full)
      }
    }
    walk(dir)
    return found
  }
  let removed = false
  for (const file of findIndexHtml(workDir)) {
    let html = readFileSync(file, "utf8")
    if (!html.includes(LEGACY_INJECT)) continue
    html = html
      .split("\n")
      .filter((line) => !line.includes(LEGACY_INJECT))
      .join("\n")
    writeFileSync(file, html, "utf8")
    const legacyFile = join(dirname(file), LEGACY_INJECT)
    if (existsSync(legacyFile)) rmSync(legacyFile, { force: true })
    removed = true
  }
  if (removed) console.log("已清理旧的渲染层角标注入")
}

if (unpatch) {
  let text = readFileSync(mainPath, "utf8")
  const next = stripBlock(text)
  if (next === text) {
    console.log("未发现主进程注入，无需移除")
  } else {
    writeFileSync(mainPath, next, "utf8")
    console.log("已移除主进程托盘注入")
  }
  cleanupLegacy()
} else {
  cleanupLegacy()
  let text = readFileSync(mainPath, "utf8")
  text = stripBlock(text) // 幂等：先移除旧块
  const snippet = readFileSync(traySource, "utf8")
  const block = `\n;${MARK_START}\n${snippet}\n;${MARK_END}\n`
  writeFileSync(mainPath, text + block, "utf8")
  console.log("已写入托盘注入块")
}

if (!dryRun && !unpatch && !existsSync(backupPath)) {
  copyFileSync(appPath, backupPath)
  console.log(`已备份  : ${backupPath}`)
}

console.log(`打包中… → ${packTarget}`)
asar("pack", workDir, packTarget)

const storedText = readFileSync(mainPath, "utf8")
const ok = unpatch ? !storedText.includes(MARK_START) : storedText.includes(MARK_START)
if (!ok) fail(unpatch ? "校验失败: 仍包含托盘注入块" : "打包校验失败: 未包含托盘注入块")
console.log(`校验通过: ${unpatch ? "注入已移除" : "主进程已包含托盘注入块"}`)

rmSync(workDir, { recursive: true, force: true })

if (dryRun) {
  console.log(`dry-run 完成（未改动安装）。测试产物: ${packTarget}`)
} else if (unpatch) {
  console.log("移除完成。重新启动 OpenCode Desktop 后生效。")
} else {
  console.log("注入完成。重新启动 OpenCode Desktop 后生效：任务栏右下角出现 OpenCode 托盘图标。")
  console.log("如需移除: node scripts/patch-desktop.mjs --unpatch")
}
