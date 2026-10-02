// 插件扫描与启用/禁用引擎（框架无关, 可单测）。
//
// 目录型插件（.opencode/plugins/ 下的文件或包目录）通过重命名切换:
//   <name>        → 启用
//   <name>.disabled → 禁用（发现逻辑会忽略该条目）
// 配置型插件（opencode.json plugins 数组中的字符串条目）通过在数组尾部追加/移除 `-id` 标记切换。

import { existsSync, readdirSync, renameSync, statSync } from "node:fs"
import { join } from "node:path"
import { discoverConfigFiles, listConfigPlugins, setConfigPluginEnabled } from "./config"

export const DISABLED_SUFFIX = ".disabled"
export const SELF_NAME = "oc-plugin-manager"

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
      out.push({
        name: display,
        scope,
        kind: "dir",
        path: full,
        enabled: !disabled,
        manageable: display !== selfName,
        note: display === selfName ? "管理器自身（不可禁用）" : undefined,
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

  const nextPath = input.enabled ? target.path.slice(0, -DISABLED_SUFFIX.length) : target.path + DISABLED_SUFFIX
  if (existsSync(nextPath)) return { ok: false, error: `目标已存在: ${nextPath}` }
  try {
    renameSync(target.path, nextPath)
    return { ok: true, entry: { ...target, path: nextPath, enabled: input.enabled } }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
