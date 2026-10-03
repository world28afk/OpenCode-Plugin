#!/usr/bin/env node
// 确定性回归校验 — oc-exit。
//
//   bun scripts/verify.mjs

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const pluginRoot = join(root, ".opencode", "plugins", "oc-exit")
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
  "src/rpc.ts",
  "src/processes.ts",
  "src/quit.ts",
]) {
  check(`plugin ${relative}`, existsSync(join(pluginRoot, relative)))
}
check("LICENSE (MIT)", existsSync(join(root, "LICENSE")))
check("desktop tray", existsSync(join(root, "desktop", "oc-exit-tray.js")))

const rpc = readFileSync(join(pluginRoot, "src", "rpc.ts"), "utf8")
check("rpc id exit.control", rpc.includes('"exit.control"'))
check("rpc has status/focus/quit", rpc.includes("status:") && rpc.includes("focus:") && rpc.includes("quit:"))

const quit = readFileSync(join(pluginRoot, "src", "quit.ts"), "utf8")
check("quit kills desktop", quit.includes("taskkill /IM OpenCode.exe /T /F"))
check("quit kills service", quit.includes("taskkill /IM opencode-cli.exe /T /F"))
check("quit is detached", quit.includes("detached: true") && quit.includes("unref()"))
check("focus uses SetForegroundWindow", quit.includes("SetForegroundWindow"))

const mount = readFileSync(join(pluginRoot, "src", "mount.ts"), "utf8")
check("mount registers rpc", mount.includes("ctx.rpc.register") && mount.includes("ExitControl"))

const tray = readFileSync(join(root, "desktop", "oc-exit-tray.js"), "utf8")
check("tray uses Tray/Menu", tray.includes("new Tray(") && tray.includes("Menu.buildFromTemplate"))
check("tray has 显示/退出 menu", tray.includes("显示 OpenCode") && tray.includes("退出 OpenCode"))
check("tray hides window on close", tray.includes('"close"') && tray.includes("preventDefault") && tray.includes("hide()"))
check("tray quit kills opencode-cli", tray.includes("taskkill /IM opencode-cli.exe /T /F"))
check("tray syntax (node --check)", spawnSync("node", ["--check", join(root, "desktop", "oc-exit-tray.js")], { encoding: "utf8" }).status === 0)

const patch = readFileSync(join(root, "scripts", "patch-desktop.mjs"), "utf8")
check("patcher targets main process", patch.includes("oc-exit:tray:start") && patch.includes("pkg.main"))
check("patcher cleans legacy renderer inject", patch.includes("oc-exit-inject.js"))

if (!bun) {
  console.log("WARN  bun not found — skipped build/smoke")
} else {
  const externals = ["@opencode/plugin", "@opencode/plugin/tui", "solid-js", "@opentui/solid"]
  for (const [entry, label] of [
    ["src/index.ts", "server"],
    ["tui.tsx", "tui"],
  ]) {
    const outfile = join(tmpdir(), `oc-exit-${label}.mjs`)
    const buildArgs = ["build", join(pluginRoot, entry), "--target=node", "--format=esm", "--outfile", outfile]
    for (const external of externals) buildArgs.push("--external", external)
    const result = runBun(buildArgs)
    check(`bun build ${entry}`, result.status === 0, result.status === 0 ? "" : (result.stderr || "").trim().split("\n").pop() ?? "")
  }

  const test = runBun(["test", join(root, "scripts", "smoke.test.ts")])
  const summary = (test.stdout || "").split("\n").filter((line) => /pass|fail/i.test(line)).slice(0, 2).join(" | ")
  check("bun test scripts/smoke.test.ts", test.status === 0, test.status === 0 ? summary : `${summary} ${(test.stderr || "").trim().split("\n").pop() ?? ""}`)
}

console.log("")
console.log(`summary: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
