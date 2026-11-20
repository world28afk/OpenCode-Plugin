#!/usr/bin/env node
// 把 skills/redteam/ 下的**目录型技能**（含 SKILL.md 的子目录）合并进
// skills/redteam.bundle.json.gz，保留原有扁平条目不动。
//
//   node scripts/bundle-skills.mjs            # 合并写入
//   node scripts/bundle-skills.mjs --check    # 只比对，不一致退出码 1
//
// 条目键：
//   扁平技能  active-scan.md
//   目录技能  game-hacking/SKILL.md、game-hacking/references/anti-cheat.md
// 反向操作由 scripts/sync-assets.mjs 完成（把包内条目还原成可读副本）。

import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { gunzipSync, gzipSync } from "node:zlib"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const skillsDir = join(root, "skills", "redteam")
const bundlePath = join(root, "skills", "redteam.bundle.json.gz")

const SKIP_DIRS = new Set([".git", "node_modules", "__MACOSX", ".system"])
const TEXT_EXT = /\.(md|txt|json|ya?ml|py|c|h|cpp|hpp|sh|ps1|js|mjs|ts)$/i

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex")
const read = (path) => readFileSync(path, "utf8").replace(/\r\n/g, "\n")

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (TEXT_EXT.test(name)) out.push(full)
  }
  return out
}

if (!existsSync(bundlePath)) throw new Error(`缺少 ${bundlePath}`)
const bundle = JSON.parse(gunzipSync(readFileSync(bundlePath)).toString("utf8"))
const files = { ...(bundle.files || {}) }
const before = Object.keys(files).length

// 目录型技能：<skillsDir>/<id>/SKILL.md
const dirSkills = readdirSync(skillsDir)
  .filter((name) => {
    try {
      return statSync(join(skillsDir, name)).isDirectory() && existsSync(join(skillsDir, name, "SKILL.md"))
    } catch {
      return false
    }
  })
  .sort()

let added = 0
let changed = 0
for (const id of dirSkills) {
  for (const full of walk(join(skillsDir, id))) {
    const key = `${id}/${relative(join(skillsDir, id), full).split("\\").join("/")}`
    const text = read(full)
    if (!(key in files)) added += 1
    else if (files[key] !== text) changed += 1
    files[key] = text
  }
}

// 目录型技能的条目若已从磁盘删除，同步移除（避免包内残留旧引用）
for (const key of Object.keys(files)) {
  if (!key.includes("/")) continue
  const id = key.split("/")[0]
  if (!dirSkills.includes(id)) {
    delete files[key]
    console.log(`removed stale entry: ${key}`)
  }
}

const next = { ...bundle, files }
const payload = gzipSync(Buffer.from(`${JSON.stringify(next, null, 0)}\n`, "utf8"), { level: 9 })
const current = readFileSync(bundlePath)

const report = {
  dirSkills,
  entries: Object.keys(files).length,
  added,
  changed,
  before,
  bytes: payload.length,
}

if (process.argv.includes("--check")) {
  const same = Buffer.compare(payload, current) === 0
  console.log(`${same ? "OK" : "DRIFT"}  ${JSON.stringify(report)}`)
  process.exit(same ? 0 : 1)
}

if (added || changed || Object.keys(files).length !== before) {
  writeFileSync(bundlePath, payload)
  console.log(`bundle updated: ${JSON.stringify(report)}`)
} else {
  console.log(`bundle unchanged: ${JSON.stringify(report)}`)
}

console.log(`bundle sha256=${sha256(JSON.stringify(next))}`)
