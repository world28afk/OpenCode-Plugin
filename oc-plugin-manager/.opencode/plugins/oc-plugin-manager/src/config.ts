// opencode.json(c) 的发现与读写（用于切换「配置型插件」的启用/禁用）。
//
// OpenCode 配置规则: plugins 数组按顺序处理, `-id` 前缀禁用该 id (后面的条目胜出)。
// 禁用 = 在数组末尾追加 `"-id"` 标记 (保留原始条目与注释);
// 启用 = 移除该标记。
//
// 文本级编辑: 只动 plugins 数组区间, 不改写其它内容 (注释/格式保留)。

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export interface ConfigFile {
  readonly path: string
  readonly scope: "project" | "global"
}

export interface ConfigPluginEntry {
  /** 展示 id: 字符串条目本身或对象条目的 package 字段。 */
  readonly id: string
  readonly scope: "project" | "global"
  readonly path: string
  /** 是否可由管理器切换 (仅字符串条目)。 */
  readonly manageable: boolean
  readonly enabled: boolean
}

/** 去除 JSONC 注释与尾逗号 (字符串感知)。 */
export function parseJsonc(text: string): unknown {
  let output = ""
  let inString = false
  let quote = ""
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string
    const next = text[index + 1]
    if (inString) {
      output += char
      if (char === "\\") {
        output += next ?? ""
        index += 1
        continue
      }
      if (char === quote) inString = false
      continue
    }
    if (char === '"' || char === "'") {
      inString = true
      quote = char
      output += char
      continue
    }
    if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index += 1
      output += "\n"
      continue
    }
    if (char === "/" && next === "*") {
      index += 2
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1
      index += 1
      continue
    }
    output += char
  }
  return JSON.parse(output.replace(/,\s*([}\]])/g, "$1"))
}

export function discoverConfigFiles(options: { projectDir?: string; home: string; configHome?: string }): ConfigFile[] {
  const out: ConfigFile[] = []
  const push = (path: string, scope: "project" | "global") => {
    if (existsSync(path) && !out.some((file) => file.path === path)) out.push({ path, scope })
  }
  const configHome = options.configHome ?? join(options.home, ".config")
  push(join(configHome, "opencode", "opencode.json"), "global")
  push(join(configHome, "opencode", "opencode.jsonc"), "global")
  if (options.projectDir) {
    push(join(options.projectDir, "opencode.json"), "project")
    push(join(options.projectDir, "opencode.jsonc"), "project")
    push(join(options.projectDir, ".opencode", "opencode.json"), "project")
    push(join(options.projectDir, ".opencode", "opencode.jsonc"), "project")
  }
  return out
}

/** 定位 plugins 数组区间 [start, end)（start=第一个 [, end=匹配的 ] 之后）。 */
export function locatePluginsArray(text: string): { start: number; end: number } | null {
  const key = /"plugins"\s*:/.exec(text)
  if (!key) return null
  let i = text.indexOf("[", key.index + key[0].length)
  if (i < 0) return null
  const start = i
  let depth = 0
  let inString = false
  let quote = ""
  for (; i < text.length; i += 1) {
    const char = text[i] as string
    if (inString) {
      if (char === "\\") i += 1
      else if (char === quote) inString = false
      continue
    }
    if (char === '"' || char === "'") {
      inString = true
      quote = char
      continue
    }
    if (char === "[") depth += 1
    else if (char === "]") {
      depth -= 1
      if (depth === 0) return { start, end: i + 1 }
    }
  }
  return null
}

function stringLiterals(slice: string): string[] {
  const out: string[] = []
  const re = /"((?:[^"\\]|\\.)*)"/g
  let match: RegExpExecArray | null
  while ((match = re.exec(slice))) out.push(match[1]!.replace(/\\(.)/g, "$1"))
  return out
}

/** 读取某配置文件中的插件条目（含 `-id` 前缀解析, 后出现者胜出）。 */
export function listConfigPlugins(file: ConfigFile): ConfigPluginEntry[] {
  try {
    const text = readFileSync(file.path, "utf8")
    const range = locatePluginsArray(text)
    if (!range) return []
    const parsed = parseJsonc(text) as { plugins?: unknown }
    const raw = Array.isArray(parsed?.plugins) ? parsed.plugins : []
    const literals = stringLiterals(text.slice(range.start, range.end))
    const state = new Map<string, boolean>()
    const order: string[] = []
    for (const literal of literals) {
      const disabled = literal.startsWith("-")
      const id = disabled ? literal.slice(1) : literal
      if (!id) continue
      if (!state.has(id)) order.push(id)
      state.set(id, !disabled) // 后出现者胜出
    }
    const out: ConfigPluginEntry[] = []
    for (const id of order) {
      const item = raw.find((entry) => (typeof entry === "string" ? entry.replace(/^-/, "") : undefined) === id)
      const manageable = typeof item === "string"
      out.push({ id, scope: file.scope, path: file.path, manageable, enabled: state.get(id) === true })
    }
    return out
  } catch {
    return []
  }
}

/** 切换字符串型配置插件的启用状态; 返回是否成功修改。 */
export function setConfigPluginEnabled(file: ConfigFile, id: string, enabled: boolean): { ok: boolean; error?: string } {
  try {
    const text = readFileSync(file.path, "utf8")
    const range = locatePluginsArray(text)
    if (!range) return { ok: false, error: "未找到 plugins 数组" }
    const before = text.slice(0, range.start)
    const slice = text.slice(range.start, range.end)
    const after = text.slice(range.end)
    const marker = `"-${id}"`

    if (!enabled) {
      if (slice.includes(marker)) return { ok: true } // 已禁用
      const inner = slice.slice(1, -1)
      let nextSlice: string
      if (inner.trim().length === 0) {
        nextSlice = `[${marker}]`
      } else {
        // 在尾随空白(与 `]`)之前插入标记; 保留原格式
        const trailing = /\s*\]$/.exec(slice)?.[0] ?? "]"
        const body = slice.slice(0, slice.length - trailing.length)
        const separator = body.trimEnd().endsWith(",") ? " " : ", "
        nextSlice = `${body}${separator}${marker}${trailing}`
      }
      writeFileSync(file.path, before + nextSlice + after, "utf8")
      return { ok: true }
    }

    // 启用: 逐一移除 `"-id"` 标记及其相邻逗号/空白
    let nextSlice = slice
    for (;;) {
      const index = nextSlice.indexOf(marker)
      if (index < 0) break
      let start = index
      let end = index + marker.length
      let s = start - 1
      while (s >= 0 && /\s/.test(nextSlice[s] as string)) s -= 1
      if (s >= 0 && nextSlice[s] === ",") start = s
      let e = end
      while (e < nextSlice.length && /\s/.test(nextSlice[e] as string)) e += 1
      if (e < nextSlice.length && nextSlice[e] === ",") end = e + 1
      nextSlice = nextSlice.slice(0, start) + nextSlice.slice(end)
    }
    if (nextSlice === slice) return { ok: true } // 无标记
    nextSlice = nextSlice.replace(/\[\s*,/, "[").replace(/,\s*\]/, "]")
    writeFileSync(file.path, before + nextSlice + after, "utf8")
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
