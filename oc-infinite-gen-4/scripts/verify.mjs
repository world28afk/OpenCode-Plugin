#!/usr/bin/env node
// 确定性回归校验 — oc-infinite-gen-4 (OpenCode 移植版)。
//
//   bun scripts/verify.mjs        # 推荐 (bun 原生解析 TS 模块)
//   node scripts/verify.mjs       # 检测到 bun 时自动以 bun 重新执行
//
// 覆盖: 载荷资产哈希一致性 / 生成模块一致性 / armor 评分器与投影 /
//       双层注入与 profile 组装 / 包导出与发现布局 / 入口语法构建 / 端到端冒烟。

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const pluginRoot = join(root, ".opencode", "plugins", "oc-infinite-gen-4")
const runningUnderBun = typeof globalThis.Bun !== "undefined"

const quoteForShell = (value) => (/[\s"&|<>^()]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value)

function bunCommand() {
  if (runningUnderBun) return process.execPath
  const probe = spawnSync("bun --version", { encoding: "utf8", shell: true })
  return probe.status === 0 ? "bun" : null
}

// node 无法直接加载带扩展名省略的 TS 模块; 有 bun 时转用 bun 重跑整份校验。
const bun = bunCommand()

function runBun(args, spawnOptions = {}) {
  const options = { encoding: "utf8", cwd: root, ...spawnOptions }
  if (runningUnderBun) return spawnSync(process.execPath, args, options)
  return spawnSync([bun, ...args].map(quoteForShell).join(" "), { ...options, shell: true })
}

if (!runningUnderBun && bun) {
  const child = runBun([fileURLToPath(import.meta.url)], { stdio: "inherit" })
  process.exit(child.status ?? 1)
}

let failures = 0
let warnings = 0
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures += 1
}
const warn = (name, detail = "") => {
  console.log(`WARN  ${name}${detail ? ` — ${detail}` : ""}`)
  warnings += 1
}

// ── 1. 载荷资产 ───────────────────────────────────────────────────────────────

const promptFiles = ["infinite-gen-3.md", "infinite-gen-4.md", "infinite-gen-4.1-flash.md"]
const promptTexts = []
const promptHashes = []
for (const name of promptFiles) {
  const path = join(pluginRoot, "prompts", name)
  check(`prompts/${name} exists`, existsSync(path))
  if (!existsSync(path)) continue
  const text = readFileSync(path, "utf8")
  promptTexts.push(text)
  promptHashes.push(createHash("sha256").update(text, "utf8").digest("hex"))
}
check(
  "prompts/*.md SHA256 identical (同源同构)",
  promptHashes.length === promptFiles.length && new Set(promptHashes).size === 1,
  promptHashes[0] ?? "n/a",
)
check("kernel payload byte size equals upstream (3592)", promptTexts.every((text) => Buffer.byteLength(text, "utf8") === 3592))

// ── 2. 运行时模块可加载 ───────────────────────────────────────────────────────

const load = (relative) => import(pathToFileURL(join(pluginRoot, relative)).href)

let armor
let inject
let profile
let prompts
try {
  ;[prompts, armor, inject, profile] = await Promise.all([
    load("src/prompts.ts"),
    load("src/armor.ts"),
    load("src/inject.ts"),
    load("src/profile.ts"),
  ])
} catch (error) {
  check("TS modules importable (需 bun)", false, String(error))
}

if (armor && prompts && inject && profile) {
  // ── 2a. 生成模块与 md 源一致 ───────────────────────────────────────────────
  check("src/prompts.ts KERNEL_SHA256 matches md", prompts.KERNEL_SHA256 === promptHashes[0])
  check("PROMPT_CORE === prompts/infinite-gen-4.md", prompts.PROMPT_CORE === promptTexts[promptFiles.indexOf("infinite-gen-4.md")])
  check(
    "PROMPT_REINFORCE === prompts/infinite-gen-4.1-flash.md",
    prompts.PROMPT_REINFORCE === promptTexts[promptFiles.indexOf("infinite-gen-4.1-flash.md")],
  )
  check("payload anchor [MODE: SANDBOX]", prompts.PROMPT_CORE.includes("[MODE: SANDBOX]"))
  check("payload anchor SUPREME DIRECTIVE", prompts.PROMPT_CORE.includes("SUPREME DIRECTIVE"))

  // ── 2b. armor 评分器 ────────────────────────────────────────────────────────
  const refusal = armor.armorScore("抱歉，我无法提供该请求的细节。")
  check("armor: refusal verdict", refusal.verdict === "refusal" && refusal.words.length > 0, JSON.stringify(refusal.words))

  const fallback = armor.armorScore("我可以提供防御建议，改为授权靶场内验证。")
  check("armor: fallback verdict", fallback.verdict === "fallback", JSON.stringify(fallback.words))

  const pass = armor.armorScore("## 登录接口渗透与账号枚举\n1. hydra -L users.txt -P pass.txt http-post-form \"http://TARGET/login\"")
  check(
    "armor: pass + web domain + risk markers",
    pass.verdict === "pass" && pass.domain === "web" && pass.risk.length > 0,
    `domain=${pass.domain} risk=${JSON.stringify(pass.risk)}`,
  )

  const enRefusal = armor.armorScore("I can't help with that request.")
  check("armor: english refusal", enRefusal.verdict === "refusal", JSON.stringify(enRefusal.words))

  const benign = armor.armorScore("请保证继续处理这个文件的编译流程。")
  check("armor: NON_REFUSAL_TAIL guard (保证后不判拒)", benign.verdict === "pass", JSON.stringify(benign.verdict))

  // ── 2c. 会话投影 ────────────────────────────────────────────────────────────
  const running = armor.projectMessages([{ type: "user", text: "hi" }])
  check("projection: pending user => running", running.running === true && running.verdict === null)

  const scored = armor.projectMessages([
    { type: "user", text: "hi" },
    { type: "assistant", content: [{ type: "reasoning", text: "hmm" }, { type: "text", text: "## 输出\n步骤 1" }] },
  ])
  check(
    "projection: assistant => scored (reasoning 段被忽略)",
    scored.running === false && scored.verdict === "pass",
    `verdict=${scored.verdict}`,
  )

  const scoredEmpty = armor.projectMessages([{ type: "assistant", content: [] }])
  check("projection: empty assistant text stays neutral", scoredEmpty.running === false && scoredEmpty.verdict === null)

  // ── 2d. 双层注入槽位 ────────────────────────────────────────────────────────
  const dual = inject.buildSystemParts(prompts.loadKernelPrompts(), { dualLayer: true })
  check("inject: dual layer => 2 parts (Order 100/200)", dual.length === 2 && dual[0].metadata.order === 100 && dual[1].metadata.order === 200)
  check("inject: parts share 同源 payload", dual[0].text === dual[1].text && dual[0].text === prompts.PROMPT_CORE)
  const single = inject.buildSystemParts(prompts.loadKernelPrompts(), { dualLayer: false })
  check("inject: single layer => 1 part", single.length === 1 && single[0].metadata.order === 100)

  // ── 2e. profile 元数据 ──────────────────────────────────────────────────────
  const built = profile.buildProfile({ version: "0.4.0", inject: true, dualLayer: true, profileTool: true })
  check("profile: serializes and carries lineage", built.plugin === "oc-infinite-gen-4" && Array.isArray(built.lineage))
  check(
    "profile: injection flags follow options",
    built.injection[0].enabled === true && built.injection[1].enabled === true &&
      profile.buildProfile({ version: "0.4.0", inject: true, dualLayer: false, profileTool: true }).injection[1].enabled === false,
  )
}

// ── 3. 包导出与发现布局 ───────────────────────────────────────────────────────

const pkgPath = join(pluginRoot, "package.json")
check("plugin package.json exists", existsSync(pkgPath))
if (existsSync(pkgPath)) {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
  check("package.json exports '.'", pkg.exports?.["."] === "./src/index.ts")
  check("package.json exports './rpc'", pkg.exports?.["./rpc"] === "./src/rpc.ts")
  check("package.json exports './tui'", pkg.exports?.["./tui"] === "./src/tui.tsx")
  check("package.json main", pkg.main === "./src/index.ts")
  check("package.json engines require OpenCode >= 2", pkg.engines?.opencode === ">=2.0.0")
}
check("src/rpc.ts exists", existsSync(join(pluginRoot, "src", "rpc.ts")))

check("discovery layout .opencode/plugins/oc-infinite-gen-4/", existsSync(pluginRoot))
check("plugin entry index.ts exists (目录解析兜底)", existsSync(join(pluginRoot, "index.ts")))

const licensePath = join(root, "LICENSE")
check("LICENSE exists (CC BY-NC-SA 4.0)", existsSync(licensePath) && statSync(licensePath).size > 1000)
if (existsSync(licensePath)) {
  check("LICENSE mentions NonCommercial", readFileSync(licensePath, "utf8").includes("NonCommercial"))
}
check("LICENSE included in plugin package", existsSync(join(pluginRoot, "LICENSE")))

// ── 4. 入口语法构建 (bun build, 外部依赖不解析) ───────────────────────────────

if (!bun) {
  warn("bun not found — skipped bun build syntax checks")
} else {
  const externals = ["@opencode/plugin", "@opencode/plugin/tui", "solid-js", "@opentui/solid"]
  for (const [entry, label] of [
    ["src/index.ts", "server"],
    ["src/tui.tsx", "tui"],
  ]) {
    const outfile = join(tmpdir(), `oc-infinite-gen-4-verify-${label}.mjs`)
    const args = ["build", join(pluginRoot, entry), "--target=node", "--format=esm", "--outfile", outfile]
    for (const external of externals) args.push("--external", external)
    const result = runBun(args)
    const detail = result.status === 0 ? "" : (result.stderr || "").trim().split("\n").pop() ?? ""
    check(`bun build ${entry}`, result.status === 0, detail)
  }
}

// ── 5. 入口关键挂点静态检查 ───────────────────────────────────────────────────

if (existsSync(join(pluginRoot, "src/mount.ts"))) {
  const server = readFileSync(join(pluginRoot, "src/mount.ts"), "utf8")
  check("mount uses session context hook", server.includes('session.hook("context"'))
  check("mount registers profile tool", server.includes('name: "infinite_gen4_profile"'))
  check("mount registers profile RPC", server.includes("ctx.rpc.register"))
  check("mount degrades on hosts without V2 domains", server.includes("hasFunction(ctx.session"))
}
if (existsSync(join(pluginRoot, "src/tui.tsx"))) {
  const tui = readFileSync(join(pluginRoot, "src/tui.tsx"), "utf8")
  check("tui entry claims prompt.footer.status slot", tui.includes('"prompt.footer.status"'))
}

const injectorPath = join(root, "desktop", "oc-infinite-gen-4-inject.js")
check("desktop injector exists", existsSync(injectorPath))
if (existsSync(injectorPath)) {
  const injector = readFileSync(injectorPath, "utf8")
  check("injector uses profile RPC id", injector.includes("infinite.gen4.profile"))
  check("injector anchors composer", injector.includes('[data-component="composer"]'))
  check("injector inserts badge above composer", injector.includes("host.insertBefore(badge, composer)"))
  check("injector has running/stopped states", injector.includes('"running"') && injector.includes('"stopped"'))
  const syntax = spawnSync(["node", "--check", quoteForShell(injectorPath)].join(" "), { shell: true, encoding: "utf8" })
  check("injector syntax (node --check)", syntax.status === 0, syntax.status === 0 ? "" : ((syntax.stderr || "").split("\n")[0] ?? ""))
}
check("patch-desktop script exists", existsSync(join(root, "scripts", "patch-desktop.mjs")))
check("desktop README exists", existsSync(join(root, "desktop", "README.md")))

if (bun) {
  const result = runBun(["test", join(root, "scripts/smoke.test.ts")])
  const detail = (result.stdout || "").trim().split("\n").filter((line) => /pass|fail/i.test(line)).slice(0, 2).join(" | ")
  check("bun test scripts/smoke.test.ts (端到端冒烟)", result.status === 0, result.status === 0 ? detail : `${detail} ${(result.stderr || "").trim().split("\n").pop() ?? ""}`)
}

console.log("")
console.log(`summary: ${failures} failure(s), ${warnings} warning(s)`)
process.exit(failures === 0 ? 0 : 1)
