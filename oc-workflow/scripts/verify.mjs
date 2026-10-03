#!/usr/bin/env node
// 确定性回归校验 — oc-workflow。
//
//   bun scripts/verify.mjs

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const pluginRoot = join(root, ".opencode", "plugins", "oc-workflow")
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

for (const relative of [
  "package.json",
  "index.ts",
  "tui.tsx",
  "src/index.ts",
  "src/mount.ts",
  "src/engine.ts",
  "src/store.ts",
  "src/capsule.ts",
  "src/catalog.ts",
  "src/agents.ts",
  "src/builtins.ts",
  "src/auto.ts",
  "src/interpolate.ts",
  "src/rpc.ts",
  "src/util.ts",
]) {
  check(`plugin ${relative}`, existsSync(join(pluginRoot, relative)))
}
check("LICENSE (MIT)", existsSync(join(root, "LICENSE")))

const rpc = readFileSync(join(pluginRoot, "src", "rpc.ts"), "utf8")
check("rpc id workflow.engine", rpc.includes('"workflow.engine"'))
check("rpc has start/show/rerun", rpc.includes("start:") && rpc.includes("show:") && rpc.includes("rerun:"))

const capsule = readFileSync(join(pluginRoot, "src", "capsule.ts"), "utf8")
check("capsule version pinned", capsule.includes('"oc.workflow/v1"'))
check("capture whitelist is git-only", capsule.includes("ALLOWED_CAPTURE") && capsule.includes("^git"))

const mount = readFileSync(join(pluginRoot, "src", "mount.ts"), "utf8")
check("mount registers tools", mount.includes("workflow_list") && mount.includes("run_workflow") && mount.includes("workflow_manage"))
check("mount registers command", mount.includes("ctx.command.transform") && mount.includes('name: "workflow"'))
check("mount registers RPC", mount.includes("ctx.rpc.register"))
check("save action available", mount.includes('case "save"'))
check("mount injects context policy + prompt dispatch", mount.includes('hook("context"') && mount.includes('hook("prompt"'))
check("mount supports /workflow auto", mount.includes('case "auto"'))
check("mount uses native subagent for dispatch", mount.includes("createToolSubagentBridge") && mount.includes("nativeSubagent"))

const auto = readFileSync(join(pluginRoot, "src", "auto.ts"), "utf8")
check("auto heuristic + policy", auto.includes("detectHeavy") && auto.includes("policyText"))
check("auto config file name", auto.includes("workflow-auto.json"))
check("auto execution modes", auto.includes('"background"') && auto.includes('"workflow"'))

const agents = readFileSync(join(pluginRoot, "src", "agents.ts"), "utf8")
check("native subagent bridge", agents.includes("createToolSubagentBridge") && agents.includes("background"))

const engine = readFileSync(join(pluginRoot, "src", "engine.ts"), "utf8")
check("engine pause/resume/stop", engine.includes("pause(") && engine.includes("resume(") && engine.includes("stop("))
check("engine budget guard", engine.includes("超出 agent 预算"))
check("engine caches completed results", engine.includes("writeResult") && engine.includes("readResult"))

const builtins = readFileSync(join(pluginRoot, "src", "builtins.ts"), "utf8")
check("builtin parallel-investigation", builtins.includes('"parallel-investigation"'))
check("builtin scoped-review", builtins.includes('"scoped-review"'))
check("builtin fan-out-and-synthesize", builtins.includes('"fan-out-and-synthesize"'))

if (!bun) {
  console.log("WARN  bun not found — skipped build/smoke")
} else {
  const externals = ["@opencode/plugin", "@opencode/plugin/tui", "solid-js", "@opentui/solid"]
  for (const [entry, label] of [
    ["src/index.ts", "server"],
    ["tui.tsx", "tui"],
  ]) {
    const outfile = join(tmpdir(), `oc-workflow-${label}.mjs`)
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
