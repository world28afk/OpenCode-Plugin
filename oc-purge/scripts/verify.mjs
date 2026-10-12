#!/usr/bin/env node
// 确定性回归校验 — oc-purge (OpenCode 移植版)。
//
//   bun scripts/verify.mjs        # 推荐 (bun 原生解析 TS 模块)
//   node scripts/verify.mjs       # 检测到 bun 时自动以 bun 重新执行
//
// 覆盖: 资产哈希一致性 / 生成模块一致性 / 注入解析纯函数 / 静态挂点 /
//       包导出与发现布局 / 入口语法构建 / 端到端冒烟。

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const pluginRoot = join(root, ".opencode", "plugins", "oc-purge")
const srcRoot = join(pluginRoot, "src")
const runningUnderBun = typeof globalThis.Bun !== "undefined"

const quoteForShell = (value) => (/[\s"&|<>^()]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value)
const bunCommand = () => (runningUnderBun ? process.execPath : (spawnSync("bun --version", { encoding: "utf8", shell: true }).status === 0 ? "bun" : null))
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
const read = (path) => readFileSync(path, "utf8").replace(/\r\n/g, "\n")
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex")

// ── 1. 资产存在性 ─────────────────────────────────────────────────────────────
const promptAsset = join(pluginRoot, "prompts", "default-prompt-inject.md")
const capabilityAsset = join(pluginRoot, "prompts", "capability-protocol.md")
const skillsBundle = join(root, "skills", "redteam.bundle.json.gz")
check("prompts/default-prompt-inject.md exists", existsSync(promptAsset))
check("prompts/capability-protocol.md exists", existsSync(capabilityAsset))
check("skills/redteam.bundle.json.gz exists (权威技能资产)", existsSync(skillsBundle))
check("skills/redteam/*.md exists (可读副本)", existsSync(join(root, "skills", "redteam")))
check("presets/redteam/*.yml exists", existsSync(join(root, "presets", "redteam", "preset.yml")))
check("docs/drill-auth-legal.html exists", existsSync(join(root, "docs", "drill-auth-legal.html")))
check("LICENSE exists (MIT, upstream attribution)", existsSync(join(root, "LICENSE")))

const bundle = existsSync(skillsBundle)
  ? JSON.parse(gunzipSync(readFileSync(skillsBundle)).toString("utf8"))
  : { files: {} }
const assetSkills = Object.keys(bundle.files || {})
  .filter((name) => name.endsWith(".md"))
  .sort()

// ── 2. 生成模块一致性（需要 bun 解析 TS） ─────────────────────────────────────
if (!runningUnderBun) {
  warn("TS 模块导入检查", "未检测到 bun，跳过生成模块/纯函数/冒烟检查")
} else {
  const prompts = await import(pathToFileURL(join(srcRoot, "prompts.ts")).href)
  const skills = await import(pathToFileURL(join(srcRoot, "skills.ts")).href)
  const config = await import(pathToFileURL(join(srcRoot, "config.ts")).href)
  const inject = await import(pathToFileURL(join(srcRoot, "inject.ts")).href)

  const assetPrompt = read(promptAsset).trim()
  check(
    "prompts.ts DEFAULT_PROMPT 与资产逐字一致",
    prompts.DEFAULT_PROMPT === assetPrompt,
  )
  check(
    "prompts.ts DEFAULT_PROMPT_SHA256 与资产一致",
    prompts.DEFAULT_PROMPT_SHA256 === sha256(assetPrompt),
    prompts.DEFAULT_PROMPT_SHA256.slice(0, 12),
  )

  const capabilityRaw = read(capabilityAsset)
  const labels = { "redteam-lead": "redteamLead", "redteam-child": "redteamChild" }
  const parsed = {}
  {
    const parts = capabilityRaw.split(/\n?<!--\s*oc-purge:\s*section=([a-z-]+)\s*-->\n?/)
    for (let i = 1; i < parts.length; i += 2) parsed[labels[parts[i]] || "official"] = (parts[i + 1] || "").trim()
  }
  check(
    "capability-protocol.md 三段与 prompts.ts 一致",
    parsed.official === prompts.CAPABILITY_PROTOCOL.official &&
      parsed.redteamLead === prompts.CAPABILITY_PROTOCOL.redteamLead &&
      parsed.redteamChild === prompts.CAPABILITY_PROTOCOL.redteamChild,
  )

  check("skills.ts 技能数与资产一致", skills.BUNDLED_SKILLS.length === assetSkills.length, `${skills.BUNDLED_SKILLS.length}/${assetSkills.length}`)
  const skillsConsistent = skills.BUNDLED_SKILLS.every((skill) => {
    const text = String(bundle.files[skill.file] ?? "").replace(/\r\n/g, "\n").trim()
    return skill.sha256 === sha256(text)
  })
  check("skills.ts 每项 SHA256 与资产包一致", skillsConsistent)
  const missingReadable = assetSkills.filter((name) => !existsSync(join(root, "skills", "redteam", name)))
  if (missingReadable.length) warn("skills/redteam 可读副本缺失", `${missingReadable.join(", ")}（可跑 node scripts/sync-assets.mjs 自愈）`)

  // 纯函数: 注入解析优先级
  const state = (patch) => config.normalizeState({ ...config.DEFAULT_STATE, ...patch })
  check(
    "resolveInjectText: 默认 → default 资产",
    config.resolveInjectText(state({}), "DEFAULT").source === "default",
  )
  check(
    "resolveInjectText: custom 优先于 rule",
    config.resolveInjectText(
      state({ customText: "C", activeRule: "r1", rules: [{ id: "r1", name: "r1", content: "R", updatedAt: 0 }] }),
      "DEFAULT",
    ).text === "C",
  )
  check(
    "resolveInjectText: strict 无用户文本 → none",
    config.resolveInjectText(state({ policy: "strict" }), "DEFAULT").source === "none",
  )
  check(
    "resolveInjectText: always 追加默认资产",
    config.resolveInjectText(state({ policy: "always", customText: "H" }), "DEFAULT").text === "H\n\nDEFAULT",
  )

  // 纯函数: ChatML 布局整理 + OpenCode 剥壳
  const normalized = inject.normalizeInjectLayout("<|im_start|>system:<project_instructions>\nHello")
  check("normalizeInjectLayout 拆行 + 闭合 project 标签", normalized.includes("<|im_start|>system:\n") && normalized.includes("</project_instructions>"))
  const stripped = inject.prepareInjectText("<|im_start|>system:\n<project_instructions>\nHARD OUTPUT RULES\n</project_instructions>")
  check("prepareInjectText 剥离 ChatML 外壳（OpenCode 语义）", !stripped.includes("<|im_start|>") && !stripped.includes("project_instructions") && stripped.startsWith("HARD OUTPUT RULES"))

  // 挂点元数据
  const parts = inject.buildSystemParts({
    state: state({}),
    resolved: { text: "X", source: "default" },
  })
  check(
    "buildSystemParts: 注入段 order = -100000",
    parts[0]?.metadata?.order === config.GLOBAL_PROMPT_ORDER,
    String(parts[0]?.metadata?.order),
  )
  check("buildSystemParts: 能力协议段 order = -99999", parts[1]?.metadata?.order === config.CAPABILITY_ORDER)

  // 纯函数: own servers 规范化（上游 net-scope.js 行为）
  const netScope = await import(pathToFileURL(join(srcRoot, "netScope.ts")).href)
  check("netScope.entryHost: 单 IP 保留", netScope.entryHost("203.0.113.10") === "203.0.113.10")
  check("netScope.entryHost: 主机名保留", netScope.entryHost("my-vps.example.com") === "my-vps.example.com")
  check("netScope.entryHost: user@host 去账号", netScope.entryHost("alice@my-vps.example.com") === "my-vps.example.com")
  check("netScope.entryHost: 网段丢弃", netScope.entryHost("10.0.0.0/8") === "")
  check("netScope.entryHost: 通配符丢弃", netScope.entryHost("*.evil.com") === "")
  check("netScope.entryHost: 私钥丢弃", netScope.entryHost("-----BEGIN OPENSSH PRIVATE KEY-----") === "")
  const allow = netScope.normalizeAllowText("203.0.113.10\n10.0.0.0/8\nmy-vps.example.com\n")
  check("netScope.normalizeAllowText: dropped=1 且仅保留合法主机", allow.dropped === 1 && allow.hosts.length === 2)

  // 工具/RPC 契约
  const tools = await import(pathToFileURL(join(srcRoot, "tools.ts")).href)
  const rpc = await import(pathToFileURL(join(srcRoot, "rpc.ts")).href)
  check("rpc.ts RPC_ID = purge.status", rpc.RPC_ID === "purge.status", rpc.RPC_ID)
  check(
    "rpc.ts 方法齐全",
    ["get", "set", "apply", "revert", "rules", "skills", "servers", "cwd"].every((m) => Boolean(rpc.PurgeStatus.methods[m])),
  )
  {
    const list = tools.buildTools({}).map((tool) => tool.name)
    check(
      "tools.ts 工具集齐全",
      ["purge_status", "purge_apply", "purge_revert", "purge_inject", "purge_rules", "purge_skills", "purge_servers", "purge_cwd"].every(
        (name) => list.includes(name),
      ),
      list.join(","),
    )
  }
}

// ── 3. 源码静态检查 ──────────────────────────────────────────────────────────
const mountSource = existsSync(join(srcRoot, "mount.ts")) ? read(join(srcRoot, "mount.ts")) : ""
check("mount.ts: session.hook(\"context\") 挂点", mountSource.includes('ctx.session.hook("context"'))
check("mount.ts: tool.transform 挂点", mountSource.includes("ctx.tool.transform("))
check("mount.ts: rpc.register 挂点", mountSource.includes("ctx.rpc.register("))
check("mount.ts: 能力探测降级 (hasFunction)", mountSource.includes("hasFunction"))
check(
  "mount.ts: 无宿主补丁面（不 import/调用 @deepseek-ai patcher）",
  !/from\s+["']@deepseek-ai/.test(mountSource) && !/applyPatches\s*\(|revertAllHosts\s*\(/.test(mountSource),
)

// ── 4. 包导出与发现布局 ──────────────────────────────────────────────────────
const pkg = JSON.parse(readFileSync(join(pluginRoot, "package.json"), "utf8"))
check("package.json exports['.'] → ./src/index.ts", pkg.exports?.["."] === "./src/index.ts")
check("package.json exports['./tui'] 存在", typeof pkg.exports?.["./tui"] === "string")
check("package.json engines.opencode", Boolean(pkg.engines?.opencode))
check("index.ts 兜底入口存在", existsSync(join(pluginRoot, "index.ts")))
const indexPath = join(pluginRoot, "src", "index.ts")
const indexSource = read(indexPath)
check("入口默认导出 { id, setup }", /export default \{ id: PLUGIN_ID, setup: mount \}/.test(indexSource))
check("入口仅 import type 宿主包", indexSource.includes('import type { Plugin } from "@opencode/plugin"'))

// ── 5. 入口语法构建（bun build, 外置宿主依赖） ──────────────────────────────
if (runningUnderBun) {
  const build = runBun(["build", indexPath, "--external", "@opencode/plugin", "--external", "@opencode/plugin/tui", "--target", "bun"], {
    stdio: "pipe",
  })
  check("bun build 入口语法通过", build.status === 0, (build.stderr || "").trim().split("\n").slice(0, 2).join(" "))
} else {
  warn("bun build 入口语法", "未检测到 bun，跳过")
}

// ── 6. 脚本语法（node --check 不支持 ESM import；用 bun build 兜底） ────────
if (runningUnderBun) {
  for (const file of ["scripts/sync-assets.mjs", "scripts/patch-desktop.mjs", "desktop/oc-purge-dock.js"]) {
    const build = runBun(["build", join(root, file), "--target", "bun"], { stdio: "pipe" })
    check(`${file} 语法通过`, build.status === 0)
  }
} else {
  const a = spawnSync(`node --check ${quoteForShell(join(root, "desktop", "oc-purge-dock.js"))}`, { shell: true, encoding: "utf8" })
  check("desktop/oc-purge-dock.js 语法通过 (node --check)", a.status === 0)
}

// ── 7. 端到端冒烟 (bun test) ─────────────────────────────────────────────────
if (runningUnderBun) {
  const smoke = runBun(["test", "scripts/smoke.test.ts"], { stdio: "inherit" })
  check("scripts/smoke.test.ts 冒烟通过", smoke.status === 0)
} else {
  warn("端到端冒烟", "未检测到 bun，跳过 (bun test scripts/smoke.test.ts)")
}

console.log("")
if (failures) {
  console.log(`verify: ${failures} FAIL, ${warnings} WARN`)
  process.exit(1)
}
console.log(`verify: OK (${warnings} WARN)`)
