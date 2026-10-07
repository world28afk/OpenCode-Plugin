#!/usr/bin/env node
// 确定性回归校验 — oc-bark。
//
//   bun scripts/verify.mjs     # 推荐;  node scripts/verify.mjs 会自动改用 bun

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const pluginRoot = join(root, ".opencode", "plugins", "oc-bark")
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

// ── 1. 文件布局 ───────────────────────────────────────────────────────────────

for (const relative of [
  "package.json",
  "index.ts",
  "src/index.ts",
  "src/mount.ts",
  "src/bark.ts",
  "src/config.ts",
  "src/format.ts",
  "src/rpc.ts",
]) {
  check(`plugin ${relative}`, existsSync(join(pluginRoot, relative)))
}
check("LICENSE (MIT)", existsSync(join(root, "LICENSE")))
check("oc-bark.example.json", existsSync(join(root, "oc-bark.example.json")))
check("scripts/smoke.test.ts", existsSync(join(root, "scripts", "smoke.test.ts")))

// ── 2. package.json ───────────────────────────────────────────────────────────

const pkgPath = join(pluginRoot, "package.json")
if (existsSync(pkgPath)) {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
  check("exports '.'", pkg.exports?.["."] === "./src/index.ts")
  check("exports './rpc'", pkg.exports?.["./rpc"] === "./src/rpc.ts")
  check("no peerDependencies on opentui (纯服务端插件)", !pkg.peerDependencies)
}

// ── 3. 关键实现静态检查 ───────────────────────────────────────────────────────

const format = readFileSync(join(pluginRoot, "src", "format.ts"), "utf8")
check(
  "默认完成文案 = 关于‘{task}’任务目前已完成，历时{minutes}分钟",
  format.includes("关于‘{task}’任务目前已完成，历时{minutes}分钟"),
)
check(
  "默认授权文案 = 关于‘{task}’任务需要授权：{detail}",
  format.includes("关于‘{task}’任务需要授权：{detail}"),
)
check("formatMinutes 三档格式", format.includes("不到1") && format.includes("toFixed(1)"))
check("condenseTask 折叠空白+截断", format.includes("condenseTask") && format.includes("…"))

const bark = readFileSync(join(pluginRoot, "src", "bark.ts"), "utf8")
check("POST /push 端点归一化", bark.includes("/push") && bark.includes("normalizePushUrl"))
check("单 key device_key / 批量 device_keys", bark.includes("device_key") && bark.includes("device_keys"))
check("推送异常折叠为结果 (不抛出)", bark.includes("AbortError") && bark.includes("catch"))

const config = readFileSync(join(pluginRoot, "src", "config.ts"), "utf8")
check("配置文件 ~/.config/opencode/oc-bark.json", config.includes("oc-bark.json") && config.includes(".config"))
check("环境变量 OC_BARK_SERVER / OC_BARK_DEVICE_KEY(S)", config.includes("OC_BARK_SERVER") && config.includes("OC_BARK_DEVICE_KEY"))
check("优先级 options > env > file", config.includes("options.server, env.OC_BARK_SERVER, file.server"))
check("标题默认取会话标题", config.includes("titleFromSession: asBoolean(firstDefined(options.titleFromSession, file.titleFromSession), true)"))
check(
  "完成/失败/授权推送默认开启",
  config.includes("notifyOnError: asBoolean(firstDefined(options.notifyOnError, file.notifyOnError), true)") &&
    config.includes("notifyOnPermission: asBoolean(firstDefined(options.notifyOnPermission, file.notifyOnPermission), true)"),
)

const mount = readFileSync(join(pluginRoot, "src", "mount.ts"), "utf8")
check("prompt hook 记录用户任务", mount.includes('hook!("prompt"') || mount.includes('"prompt", recordPrompt'))
check("订阅服务端事件流", mount.includes("event") && mount.includes("subscribe") && mount.includes("for await"))
check(
  "完成/失败/中断/授权事件都处理",
  mount.includes("session.execution.succeeded") &&
    mount.includes("session.execution.failed") &&
    mount.includes("session.execution.interrupted") &&
    mount.includes("permission.asked"),
)
check("三事件推送开关 (对齐原版三档提示音)", mount.includes("notifyOnError") && mount.includes("notifyOnPermission") && mount.includes("permissionIds"))
check("子会话默认不推送 (可开 notifyChildSessions)", mount.includes("notifyChildSessions") && mount.includes("childSessions"))
check(
  "多实例去重: 进程级认领 + location 过滤 + 事件 id 去重",
  mount.includes("GLOBAL_CLAIM") &&
    mount.includes("claimOnce") &&
    mount.includes("claimEvent") &&
    mount.includes("isOwnLocation") &&
    mount.includes("seenEventIds"),
)
check("标题取会话标题", mount.includes("titleFromSession") && mount.includes("titleFor"))
check("推送不阻塞事件循环 (track/flush)", mount.includes("track(") && mount.includes("flush"))
check("工具 bark_status / bark_test", mount.includes("bark_status") && mount.includes("bark_test"))
check("RPC bark.v1 注册", mount.includes("rpc") && mount.includes("Bark"))

const rpc = readFileSync(join(pluginRoot, "src", "rpc.ts"), "utf8")
check("rpc id bark.v1", rpc.includes('"bark.v1"'))
check("rpc methods status/test/send", rpc.includes("status:") && rpc.includes("test:") && rpc.includes("send:"))

// ── 4. 「不碰桌面端提示音」护栏 ────────────────────────────────────────────────

check("仓库无 desktop 注入目录", !existsSync(join(root, "desktop")))
const serverSources = ["src/index.ts", "src/mount.ts", "src/bark.ts", "src/config.ts", "src/format.ts", "src/rpc.ts", "index.ts"]
  .map((relative) => readFileSync(join(pluginRoot, relative), "utf8"))
  .join("\n")
check(
  "不补丁桌面包 / 不覆盖提示音",
  !serverSources.includes("@electron/asar") &&
    !serverSources.includes("patch-desktop") &&
    !serverSources.includes("node:child_process"),
)
check("完成事件与桌面提示音同源 (session.execution.succeeded)", mount.includes("session.execution.succeeded"))

// ── 5. bun build + 冒烟 ───────────────────────────────────────────────────────

if (!bun) {
  console.log("WARN  bun not found — skipped build/smoke")
} else {
  const outfile = join(tmpdir(), "oc-bark-server.mjs")
  const args = ["build", join(pluginRoot, "src", "index.ts"), "--target=node", "--format=esm", "--outfile", outfile]
  for (const external of ["@opencode/plugin"]) args.push("--external", external)
  const result = runBun(args)
  check(`bun build src/index.ts`, result.status === 0, result.status === 0 ? "" : (result.stderr || "").trim().split("\n").pop() ?? "")

  const test = runBun(["test", join(root, "scripts", "smoke.test.ts")])
  const summary = (test.stdout || "").split("\n").filter((line) => /pass|fail/i.test(line)).slice(0, 2).join(" | ")
  check("bun test scripts/smoke.test.ts", test.status === 0, test.status === 0 ? summary : `${summary} ${(test.stderr || "").trim().split("\n").pop() ?? ""}`)
}

console.log("")
console.log(`summary: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
