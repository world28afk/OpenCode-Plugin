#!/usr/bin/env node
// 确定性回归校验 — oc-perf-guard。
//
//   bun scripts/verify.mjs     # 推荐;  node scripts/verify.mjs 会自动改用 bun

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const pluginRoot = join(root, ".opencode", "plugins", "oc-perf-guard")
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

for (const relative of ["package.json", "index.ts", "tui.tsx", "src/index.ts", "src/mount.ts", "src/processes.ts", "src/rpc.ts", "src/scripts.ts", "src/governor.ts", "src/judge.ts"]) {
  check(`plugin ${relative}`, existsSync(join(pluginRoot, relative)))
}
check("LICENSE (MIT)", existsSync(join(root, "LICENSE")))
check("scripts/smoke.test.ts", existsSync(join(root, "scripts", "smoke.test.ts")))

// ── 2. package.json ───────────────────────────────────────────────────────────

const pkgPath = join(pluginRoot, "package.json")
if (existsSync(pkgPath)) {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
  check("exports '.'", pkg.exports?.["."] === "./src/index.ts")
  check("exports './rpc'", pkg.exports?.["./rpc"] === "./src/rpc.ts")
  check("exports './tui'", pkg.exports?.["./tui"] === "./src/tui.tsx")
}

// ── 3. 关键实现静态检查 ───────────────────────────────────────────────────────

const rpc = readFileSync(join(pluginRoot, "src", "rpc.ts"), "utf8")
check("rpc id perf.guard", rpc.includes('"perf.guard"'))
check("rpc methods status/cleanup", rpc.includes("status:") && rpc.includes("cleanup:"))

const mount = readFileSync(join(pluginRoot, "src", "mount.ts"), "utf8")
check("mount registers tools", mount.includes("perf_processes") && mount.includes("perf_cleanup"))
check("mount registers script tools", mount.includes("script_list") && mount.includes("script_kill") && mount.includes("script_keep") && mount.includes("script_nice"))
check("mount registers RPC", mount.includes("ctx.rpc.register"))
check("cleanup defaults to dryRun", mount.includes("value.dryRun === false ? false : true"))
check("monitor interval present", mount.includes("setInterval"))
check("tool hook attribution", mount.includes('ctx.tool.hook("execute.before"') && mount.includes('ctx.tool.hook("execute.after"'))
check("busy-safe notification (synthetic)", mount.includes("ctx.session.synthetic"))
check("staged enforcement wired", mount.includes("graceMs") && mount.includes("governor.enforce"))

const scripts = readFileSync(join(pluginRoot, "src", "scripts.ts"), "utf8")
check("cpu sampling from process times", scripts.includes("computeCpuPercents"))
check("protect list: 桥/代理永不进候选", scripts.includes("DEFAULT_PROTECT_PATTERNS") && scripts.includes("isProtectedProcess"))
const processes2 = readFileSync(join(pluginRoot, "src", "processes.ts"), "utf8")
check("collector reads CPU counters", processes2.includes("KernelModeTime") && processes2.includes("StartMs"))
check("collector excluded", scripts.includes("isCollectorProcess"))

const judge = readFileSync(join(pluginRoot, "src", "judge.ts"), "utf8")
check("laya-style rule table", judge.includes("R0") && judge.includes("memoryKillMB") && judge.includes("classifyCommand"))
check("actionable messages", judge.includes("script_keep(pid=") && judge.includes("script_kill(pid=") && judge.includes("script_nice(pid="))

const governor = readFileSync(join(pluginRoot, "src", "governor.ts"), "utf8")
check("governor staged kill", governor.includes("graceUntil") && governor.includes('"idle"'))
check("governor action history + limit", governor.includes("listActions") && governor.includes("maxActionsPerHour"))
check(
  "keeps 热载存活 (seed/persist)",
  governor.includes("pendingKeeps") &&
    governor.includes("seedKeep") &&
    governor.includes("listKeeps") &&
    mount.includes("STORAGE_KEEPS") &&
    mount.includes("persistKeeps") &&
    mount.includes("keeps: restoredKeeps"),
)
check("script_list 暴露 protect/keeps", mount.includes("protect: scriptPayload().protect") && mount.includes("keeps: scriptPayload().keeps"))

const processes = readFileSync(join(pluginRoot, "src", "processes.ts"), "utf8")
check("uses taskkill for trees", processes.includes('"taskkill"') && processes.includes('"/T"'))
check("categorizes mcp-remote", processes.includes("mcp-remote"))
check("detects orphans via linkState", processes.includes('"dead"'))

// ── 4. bun build + 冒烟 ───────────────────────────────────────────────────────

if (!bun) {
  console.log("WARN  bun not found — skipped build/smoke")
} else {
  const externals = ["@opencode/plugin", "@opencode/plugin/tui", "solid-js", "@opentui/solid"]
  for (const [entry, label] of [
    ["src/index.ts", "server"],
    ["tui.tsx", "tui"],
  ]) {
    const outfile = join(tmpdir(), `oc-perf-guard-${label}.mjs`)
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
