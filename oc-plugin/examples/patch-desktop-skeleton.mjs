#!/usr/bin/env node
// app.asar 补丁器骨架（以「注入 desktop 脚本」为例）。
// 完整实现（--dry-run / --force / --app / --unpatch / --restore）见:
//   https://github.com/world28afk/oc-infinite-gen-4/blob/main/scripts/patch-desktop.mjs
//
// 关键步骤:
//   1. 默认目标 %LOCALAPPDATA%\Programs\@opencodedesktop\resources\app.asar
//   2. 应用运行中文件会被锁: 先退出应用, 或对副本使用 --app
//   3. extract → 复制注入脚本到 out/renderer/ → index.html </body> 前插入 <script src="./x.js">
//      （幂等: 已含标记则跳过）
//   4. 首次注入前备份 app.asar → app.asar.<plugin>.bak
//   5. pack → 覆盖 app.asar → 校验 asar 列表包含注入文件

import { spawnSync } from "node:child_process"
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const injectName = "acme-inject.js"
const injectSource = join(root, "desktop", injectName)
const appPath = process.env.APPDATA_ASAR ?? join(process.env.LOCALAPPDATA, "Programs", "@opencodedesktop", "resources", "app.asar")

const run = (cmd) => {
  const r = spawnSync(cmd, { shell: true, stdio: "inherit" })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

if (!existsSync(appPath)) throw new Error(`app.asar not found: ${appPath}`)
if (!existsSync(injectSource)) throw new Error(`injector not found: ${injectSource}`)

const work = join(tmpdir(), `acme-asar-${Date.now()}`)
run(`npx --yes @electron/asar extract "${appPath}" "${work}"`)

const renderer = join(work, "out", "renderer")
copyFileSync(injectSource, join(renderer, injectName))
const htmlPath = join(renderer, "index.html")
let html = readFileSync(htmlPath, "utf8")
if (!html.includes(injectName)) {
  html = html.replace("</body>", `  <script src="./${injectName}"></script>\n</body>`)
  writeFileSync(htmlPath, html, "utf8")
}

const backup = `${appPath}.acme.bak`
if (!existsSync(backup)) copyFileSync(appPath, backup)

run(`npx --yes @electron/asar pack "${work}" "${appPath}"`)
const list = spawnSync(`npx --yes @electron/asar list "${appPath}"`, { shell: true, encoding: "utf8" })
if (!(list.stdout ?? "").includes(injectName)) throw new Error("verify failed: injector missing in asar")
console.log("done. restart OpenCode Desktop to take effect. backup:", backup)
