#!/usr/bin/env node
// 确定性回归校验 — oc-router-laya。
//
//   bun scripts/verify.mjs

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const pluginRoot = join(root, ".opencode", "plugins", "oc-router-laya")
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
  "src/tiers.ts",
  "src/lexicon.ts",
  "src/heuristic.ts",
  "src/policy.ts",
  "src/config.ts",
  "src/state.ts",
  "src/rpc.ts",
]) {
  check(`plugin ${relative}`, existsSync(join(pluginRoot, relative)))
}
check("LICENSE (MIT)", existsSync(join(root, "LICENSE")))
check("NOTICE (attribution)", existsSync(join(root, "NOTICE")))

const tiers = readFileSync(join(pluginRoot, "src", "tiers.ts"), "utf8")
check("seven-rule engine ported", ["Rule 0", "Rule 1", "Rule 2", "Rule 3", "Rule 4", "Rule 5", "Rule 6"].every((rule) => tiers.includes(rule)))
check("weights match upstream", tiers.includes("Q1: 0.18") && tiers.includes("Q4: 0.29"))

const policy = readFileSync(join(pluginRoot, "src", "policy.ts"), "utf8")
check("escalation on regenerate", policy.includes("escalate_regenerate"))
check("constraints applied last", policy.includes("applyConstraints"))

const config = readFileSync(join(pluginRoot, "src", "config.ts"), "utf8")
check("multi-model tier table", config.includes("providerID") && config.includes("variantFor") && config.includes("xhigh"))

const mount = readFileSync(join(pluginRoot, "src", "mount.ts"), "utf8")
check("prompt hook registered", mount.includes('ctx.session.hook("prompt"'))
check("switchModel applied", mount.includes("switchModel"))
check("tools registered", mount.includes("router_status") && mount.includes("router_decide") && mount.includes("router_set"))
check("command registered", mount.includes("ctx.command.transform"))
check("rpc registered", mount.includes("ctx.rpc.register"))

if (!bun) {
  console.log("WARN  bun not found — skipped build/smoke")
} else {
  const externals = ["@opencode/plugin", "@opencode/plugin/tui", "solid-js", "@opentui/solid"]
  for (const [entry, label] of [
    ["src/index.ts", "server"],
    ["tui.tsx", "tui"],
  ]) {
    const outfile = join(tmpdir(), `oc-router-laya-${label}.mjs`)
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
