#!/usr/bin/env node
// 确定性回归校验 — oc-deepseek-banlance。
//
//   bun scripts/verify.mjs     # 推荐;  node scripts/verify.mjs 会自动改用 bun

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const pluginRoot = join(root, ".opencode", "plugins", "oc-deepseek-banlance")
const runningUnderBun = typeof globalThis.Bun !== "undefined"

const quoteForShell = (value) => (/[\s"&|<>^()]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value)

function bunCommand() {
  if (runningUnderBun) return process.execPath
  const probe = spawnSync("bun --version", { encoding: "utf8", shell: true })
  return probe.status === 0 ? "bun" : null
}

const bun = bunCommand()

function runBun(args) {
  if (runningUnderBun) return spawnSync(process.execPath, args, { encoding: "utf8", cwd: root })
  return spawnSync(["bun", ...args].map(quoteForShell).join(" "), { encoding: "utf8", cwd: root, shell: true })
}

function runNode(args) {
  return spawnSync(["node", ...args].map(quoteForShell).join(" "), { encoding: "utf8", cwd: root, shell: true })
}

if (!runningUnderBun && bun) {
  const child = runBun([fileURLToPath(import.meta.url)])
  process.stdout.write(child.stdout ?? "")
  process.stderr.write(child.stderr ?? "")
  process.exit(child.status ?? 1)
}

let failures = 0
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures += 1
}

// ── 1. 文件布局 ───────────────────────────────────────────────────────────────

for (const relative of [
  "package.json",
  "index.ts",
  "tui.tsx",
  "src/index.ts",
  "src/mount.ts",
  "src/rpc.ts",
  "src/deepseek.ts",
  "src/key.ts",
  "src/service.ts",
  "src/format.ts",
]) {
  check(`plugin ${relative}`, existsSync(join(pluginRoot, relative)))
}
check("LICENSE (MIT)", existsSync(join(root, "LICENSE")))
check("desktop/oc-balance-inject.js", existsSync(join(root, "desktop", "oc-balance-inject.js")))
check("scripts/patch-desktop.mjs", existsSync(join(root, "scripts", "patch-desktop.mjs")))

// ── 2. package.json ───────────────────────────────────────────────────────────

const pkgPath = join(pluginRoot, "package.json")
if (existsSync(pkgPath)) {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
  check("exports '.'", pkg.exports?.["."] === "./src/index.ts")
  check("exports './tui'", pkg.exports?.["./tui"] === "./src/tui.tsx")
  check("exports './rpc'", pkg.exports?.["./rpc"] === "./src/rpc.ts")
}

// ── 3. 关键实现静态检查 ───────────────────────────────────────────────────────

if (existsSync(join(pluginRoot, "src/mount.ts"))) {
  const mount = readFileSync(join(pluginRoot, "src/mount.ts"), "utf8")
  check("mount registers RPC", mount.includes("ctx.rpc.register"))
  check("mount registers tool deepseek_balance", mount.includes('name: "deepseek_balance"'))
  check("mount supports contextLine", mount.includes("contextLine"))
  check("mount has background refresh", mount.includes("setInterval"))
}

if (existsSync(join(pluginRoot, "src/rpc.ts"))) {
  const rpc = readFileSync(join(pluginRoot, "src/rpc.ts"), "utf8")
  check("rpc id deepseek.balance.v1", rpc.includes('"deepseek.balance.v1"'))
  check("rpc methods get/refresh", rpc.includes("get:") && rpc.includes("refresh:"))
}

const injectPath = join(root, "desktop", "oc-balance-inject.js")
if (existsSync(injectPath)) {
  const inject = readFileSync(injectPath, "utf8")
  check("injector calls plugin RPC path", inject.includes("/api/rpc/${RPC_ID}/get"))
  check("injector wraps RPC payload as { input }", inject.includes("JSON.stringify({ input: {} })"))
  check("injector reads RPC { output } wrapper", inject.includes("json.output"))
  check("injector targets context tooltip (w-[120px])", inject.includes("w-[120px]"))
  check("injector targets context page grid", inject.includes("grid-cols-2"))
  check("injector uses MutationObserver", inject.includes("MutationObserver"))
  check("injector has direct DeepSeek fallback", inject.includes("api.deepseek.com/user/balance"))
  const syntax = runNode(["--check", injectPath])
  check("injector syntax (node --check)", syntax.status === 0, syntax.status === 0 ? "" : (syntax.stderr || "").split("\n")[0])
}

// ── 4. bun build (外部依赖不解析) ─────────────────────────────────────────────

if (!bun) {
  console.log("WARN  bun not found — skipped build/smoke")
} else {
  const externals = ["@opencode/plugin", "@opencode/plugin/tui", "@opencode/plugin/rpc", "solid-js", "@opentui/solid"]
  for (const [entry, label] of [
    ["src/index.ts", "server"],
    ["tui.tsx", "tui"],
  ]) {
    const outfile = join(tmpdir(), `oc-deepseek-banlance-${label}.mjs`)
    const args = ["build", join(pluginRoot, entry), "--target=node", "--format=esm", "--outfile", outfile]
    for (const external of externals) args.push("--external", external)
    const result = runBun(args)
    check(`bun build ${entry}`, result.status === 0, result.status === 0 ? "" : (result.stderr || "").trim().split("\n").pop() ?? "")
  }

  const test = runBun(["test", join(root, "scripts", "smoke.test.ts")])
  const summary = (test.stdout || "").split("\n").filter((line) => /pass|fail/i.test(line)).slice(0, 2).join(" | ")
  check("bun test scripts/smoke.test.ts", test.status === 0, test.status === 0 ? summary : `${summary} ${(test.stderr || "").trim().split("\n").pop() ?? ""}`)
}

console.log("")
console.log(`summary: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
