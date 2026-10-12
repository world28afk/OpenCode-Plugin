// 本地规则发现（CWD rules）— 移植上游 lib/rules.js 的 ancestorChainForCwd /
// scanCwdInstructions / readSelectedCwdInject。
//
// 上游扫描当前会话目录及其祖先目录里的 AGENTS.md / CLAUDE.md，勾选的文件在
// 「提示词为空」时作为注入正文。OpenCode 侧同样如此（见 config.resolveInjectText）。

import { existsSync, readFileSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

export const RULE_TARGETS = ["AGENTS.md", "CLAUDE.md"] as const
const PROJECT_ROOT_MARKERS = [".git", ".hg", "package.json", "pnpm-workspace.yaml"]
const MAX_CWD_WALK_DEPTH = 64
const MAX_SELECTED_BYTES = 512 * 1024

/** 从 cwd 向上找工程根（含 .git / package.json 等标记），返回 [根 ... cwd] 目录链。 */
export function ancestorChainForCwd(cwd: string): string[] {
  if (!cwd) return []
  const normalized = resolve(cwd)
  let root: string | null = null
  let cur = normalized
  for (let i = 0; i < MAX_CWD_WALK_DEPTH; i += 1) {
    for (const marker of PROJECT_ROOT_MARKERS) {
      try {
        if (existsSync(join(cur, marker))) {
          root = cur
          break
        }
      } catch {
        /* ignore */
      }
    }
    if (root) break
    const parent = dirname(cur)
    if (!parent || parent === cur) break
    cur = parent
  }
  const chain: string[] = []
  const pushed = new Set<string>()
  const stopAt = root ? resolve(root) : normalized
  let walker = normalized
  for (let i = 0; i < MAX_CWD_WALK_DEPTH; i += 1) {
    if (!pushed.has(walker)) {
      chain.push(walker)
      pushed.add(walker)
    }
    if (walker === stopAt) break
    const parent = dirname(walker)
    if (!parent || parent === walker) break
    walker = parent
  }
  return chain.reverse()
}

export interface CwdInstruction {
  readonly path: string
  readonly name: string
  readonly dir: string
  readonly scope: "cwd" | "ancestor" | "root"
  readonly size: number
  readonly mtime: number
  readonly preview: string
}

export function scanCwdInstructions(cwd: string): CwdInstruction[] {
  const out: CwdInstruction[] = []
  if (!cwd) return out
  const chain = ancestorChainForCwd(cwd)
  const seen = new Set<string>()
  const leaf = resolve(cwd)
  for (const dir of chain) {
    for (const name of RULE_TARGETS) {
      const fp = join(dir, name)
      if (seen.has(fp)) continue
      let stat: ReturnType<typeof statSync> | null = null
      try {
        stat = statSync(fp)
      } catch {
        continue
      }
      if (!stat.isFile()) continue
      seen.add(fp)
      let preview = ""
      try {
        preview = readFileSync(fp, "utf8").replace(/\s+/g, " ").trim().slice(0, 160)
      } catch {
        /* ignore */
      }
      const scope: CwdInstruction["scope"] = dir === leaf ? "cwd" : dir === chain[0] ? "root" : "ancestor"
      out.push({ path: fp, name, dir, scope, size: stat.size, mtime: stat.mtimeMs || 0, preview })
    }
  }
  return out
}

/** 返回勾选的本地指令文件拼接内容（仅当前 cwd 扫描结果里仍存在的文件）。 */
export function readSelectedCwdInject(selections: readonly string[], cwd: string): string {
  if (!selections.length) return ""
  const candidates = cwd ? scanCwdInstructions(cwd) : []
  const candidateSet = new Set(candidates.map((item) => item.path))
  const chosen = selections.filter((item) => candidateSet.has(item))
  if (!chosen.length) return ""
  const parts: string[] = []
  let budget = MAX_SELECTED_BYTES
  for (const fp of chosen) {
    try {
      const raw = readFileSync(fp, "utf8")
      const slice = raw.slice(0, budget)
      budget -= slice.length
      parts.push(`# ${fp}\n\n${slice}`)
    } catch {
      /* ignore */
    }
    if (budget <= 0) break
  }
  return parts.join("\n\n---\n\n")
}
