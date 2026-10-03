// 插件扫描与启用/禁用引擎（框架无关, 可单测）。
//
// 禁用机制（2026-10 修正, 见 README「已知边界」）:
//   • 文件型插件: `<file>.ts` → `<file>.ts.disabled`（发现逻辑按扩展名匹配, 改名即不加载）。
//   • 目录型插件: **不能靠目录改名**。OpenCode 的 `PluginSourceDirectory.discover`
//     会加载 `{plugin,plugins}/` 下的**每一个**目录, 与目录名无关（`<name>.disabled`
//     照样被加载）; 且运行中的服务端对插件目录持有句柄, Windows 上 `rename` 目录
//     必然 EPERM。因此改为「入口中和」: 把入口文件（package.json / index.*）
//     改名为 `*.disabled` 并写入标记, 使 `{plugin,plugins}/<name>/` 解析不到入口而
//     不被激活（服务端文件监视会即时热卸载）。启用 = 还原入口 + 删除标记。
//   • 配置型插件: opencode.json(c) plugins 数组字符串条目 → 追加/移除 `-id` 标记。

import { existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { discoverConfigFiles, listConfigPlugins, setConfigPluginEnabled } from "./config"

export const DISABLED_SUFFIX = ".disabled"
export const SELF_NAME = "oc-plugin-manager"

/** 目录型插件的禁用标记（记录被中和的入口文件, 便于精确还原）。 */
export const DIR_MARK_FILE = ".oc-plugin-manager.disabled.json"
/** 目录型插件的候选入口文件（改名后 OpenCode 解析不到入口 → 不激活）。 */
export const DIR_ENTRY_FILES = [
  "package.json",
  "index.ts",
  "index.tsx",
  "index.mts",
  "index.cts",
  "index.js",
  "index.jsx",
  "index.mjs",
  "index.cjs",
] as const

interface DirMark {
  readonly disabledAt: number
  readonly renamed: string[]
}

function readDirMark(dir: string): DirMark | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, DIR_MARK_FILE), "utf8")) as Partial<DirMark>
    return { disabledAt: Number(raw.disabledAt) || 0, renamed: Array.isArray(raw.renamed) ? raw.renamed.map(String) : [] }
  } catch {
    return null
  }
}

/** 中和目录型插件入口; 失败时回滚已完成的改名。 */
function disableDir(dir: string): { ok: boolean; error?: string } {
  const renamed: string[] = []
  try {
    for (const name of DIR_ENTRY_FILES) {
      const from = join(dir, name)
      const to = from + DISABLED_SUFFIX
      if (existsSync(from) && !existsSync(to)) {
        renameSync(from, to)
        renamed.push(name)
      }
    }
    if (!renamed.length && !existsSync(join(dir, DIR_MARK_FILE))) {
      return { ok: false, error: `目录内未找到可中和的入口文件（${DIR_ENTRY_FILES.join(" / ")}）` }
    }
    writeFileSync(join(dir, DIR_MARK_FILE), JSON.stringify({ disabledAt: Date.now(), renamed }, null, 2), "utf8")
    return { ok: true }
  } catch (error) {
    for (const name of renamed) {
      try {
        const from = join(dir, name + DISABLED_SUFFIX)
        const to = join(dir, name)
        if (existsSync(from) && !existsSync(to)) renameSync(from, to)
      } catch {
        // ignore rollback errors
      }
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 还原目录型插件入口。 */
function enableDir(dir: string): { ok: boolean; error?: string } {
  const mark = readDirMark(dir)
  const names = mark?.renamed?.length
    ? mark.renamed
    : DIR_ENTRY_FILES.filter((name) => existsSync(join(dir, name + DISABLED_SUFFIX)))
  try {
    for (const name of names) {
      const from = join(dir, name + DISABLED_SUFFIX)
      const to = join(dir, name)
      if (existsSync(from) && !existsSync(to)) renameSync(from, to)
    }
    if (existsSync(join(dir, DIR_MARK_FILE))) rmSync(join(dir, DIR_MARK_FILE), { force: true })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export interface PluginEntry {
  readonly name: string
  readonly scope: "project" | "global"
  readonly kind: "dir" | "file" | "config"
  readonly path: string
  readonly enabled: boolean
  readonly manageable: boolean
  readonly note?: string
}

const PLUGIN_FILE_RE = /\.(m?[jt]s|c?js)$/

export function scanPluginRoot(root: string, scope: "project" | "global", selfName = SELF_NAME): PluginEntry[] {
  if (!existsSync(root)) return []
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return []
  }
  const out: PluginEntry[] = []
  for (const name of names) {
    if (name.startsWith(".") || name === "node_modules") continue
    const full = join(root, name)
    let isDir = false
    try {
      isDir = statSync(full).isDirectory()
    } catch {
      continue
    }
    const disabled = name.endsWith(DISABLED_SUFFIX)
    if (isDir) {
      const display = disabled ? name.slice(0, -DISABLED_SUFFIX.length) : name
      if (!display) continue
      // 目录型插件禁用态: 旧式 `<name>.disabled` 改名, 或新式入口中和标记。
      const neutralized = !disabled && existsSync(join(full, DIR_MARK_FILE))
      out.push({
        name: display,
        scope,
        kind: "dir",
        path: full,
        enabled: !disabled && !neutralized,
        manageable: display !== selfName,
        note:
          display === selfName
            ? "管理器自身（不可禁用）"
            : neutralized || disabled
              ? "已禁用（入口中和）"
              : undefined,
      })
      continue
    }
    const base = disabled ? name.slice(0, -DISABLED_SUFFIX.length) : name
    if (!PLUGIN_FILE_RE.test(base) || base.endsWith(".d.ts")) continue
    out.push({
      name: base,
      scope,
      kind: "file",
      path: full,
      enabled: !disabled,
      manageable: base !== selfName,
      note: base === selfName ? "管理器自身（不可禁用）" : undefined,
    })
  }
  return out
}

export interface ManagerOptions {
  readonly projectDir?: string
  readonly home: string
  readonly configHome?: string
}

export function listAll(options: ManagerOptions): { entries: PluginEntry[]; errors: string[] } {
  const errors: string[] = []
  const entries: PluginEntry[] = []
  const configHome = options.configHome ?? join(options.home, ".config")

  if (options.projectDir) {
    entries.push(...scanPluginRoot(join(options.projectDir, ".opencode", "plugins"), "project"))
  }
  entries.push(...scanPluginRoot(join(configHome, "opencode", "plugins"), "global"))

  for (const file of discoverConfigFiles(options)) {
    for (const item of listConfigPlugins(file)) {
      entries.push({
        name: item.id,
        scope: item.scope,
        kind: "config",
        path: file.path,
        enabled: item.enabled,
        manageable: item.manageable,
        note: item.manageable ? undefined : "对象条目（请在配置文件中手动管理）",
      })
    }
  }

  return { entries, errors }
}

export interface SetInput {
  readonly name: string
  readonly scope?: "project" | "global"
  readonly kind?: "dir" | "file" | "config"
  readonly enabled: boolean
}

export function setEnabled(
  options: ManagerOptions,
  input: SetInput,
): { ok: boolean; error?: string; entry?: PluginEntry } {
  const { entries } = listAll(options)
  const candidates = entries.filter(
    (entry) =>
      entry.name === input.name &&
      (!input.scope || entry.scope === input.scope) &&
      (!input.kind || entry.kind === input.kind),
  )
  const target = candidates.find((entry) => entry.kind !== "config") ?? candidates[0]
  if (!target) return { ok: false, error: `未找到插件: ${input.name}` }
  if (!target.manageable) return { ok: false, error: target.note ?? "该条目不可切换" }

  if (target.kind === "config") {
    const result = setConfigPluginEnabled({ path: target.path, scope: target.scope }, target.name, input.enabled)
    return result.ok ? { ok: true, entry: { ...target, enabled: input.enabled } } : { ok: false, error: result.error }
  }

  if (target.enabled === input.enabled) return { ok: true, entry: target }

  if (target.kind === "dir") {
    // 旧式禁用目录（<name>.disabled）需先改回原名, 再走入口中和逻辑。
    const dir = target.path.endsWith(DISABLED_SUFFIX) ? target.path.slice(0, -DISABLED_SUFFIX.length) : target.path
    if (target.path.endsWith(DISABLED_SUFFIX)) {
      try {
        if (existsSync(target.path) && !existsSync(dir)) renameSync(target.path, dir)
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
    const result = input.enabled ? enableDir(dir) : disableDir(dir)
    return result.ok
      ? { ok: true, entry: { ...target, path: dir, enabled: input.enabled, note: input.enabled ? undefined : "已禁用（入口中和）" } }
      : { ok: false, error: result.error }
  }

  const nextPath = input.enabled ? target.path.slice(0, -DISABLED_SUFFIX.length) : target.path + DISABLED_SUFFIX
  if (existsSync(nextPath)) return { ok: false, error: `目标已存在: ${nextPath}` }
  try {
    renameSync(target.path, nextPath)
    return { ok: true, entry: { ...target, path: nextPath, enabled: input.enabled } }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
