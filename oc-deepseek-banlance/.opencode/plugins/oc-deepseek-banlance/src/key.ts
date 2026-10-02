// DeepSeek API Key 解析 — 服务端执行, 按优先级:
//   1. 插件选项 apiKey
//   2. 环境变量 DEEPSEEK_API_KEY
//   3. OpenCode auth 存储 ~/.local/share/opencode/auth.json 的 deepseek.key
//   4. opencode.json(c) 中 provider.ds / provider.deepseek 的 options.apiKey
//      (项目目录 → 全局 ~/.config/opencode)
//
// 密钥只在服务端进程内使用, 不会写入日志或发往除 DeepSeek 官方端点以外的地址。

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface ResolvedKey {
  readonly key: string | null
  readonly source: string
}

export interface ResolveKeyOptions {
  readonly apiKey?: string
  readonly env?: Record<string, string | undefined>
  readonly home?: string
  /** 当前项目目录 (ctx.location.directory), 用于发现项目级 opencode.json(c)。 */
  readonly directory?: string
  readonly configHome?: string
}

/** 去除 JSONC 注释与尾逗号 (字符串感知, 够用于 opencode 配置)。 */
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

function readJsonc(path: string): unknown | undefined {
  try {
    if (!existsSync(path)) return undefined
    return parseJsonc(readFileSync(path, "utf8"))
  } catch {
    return undefined
  }
}

function apiKeyFromConfig(config: unknown): string | null {
  if (!config || typeof config !== "object") return null
  const providers = (config as Record<string, unknown>).provider
  if (!providers || typeof providers !== "object") return null
  for (const id of ["ds", "deepseek", "deepseek-official"]) {
    const provider = (providers as Record<string, unknown>)[id]
    if (!provider || typeof provider !== "object") continue
    const options = (provider as Record<string, unknown>).options
    if (!options || typeof options !== "object") continue
    const key = (options as Record<string, unknown>).apiKey
    if (typeof key === "string" && key.trim()) return key.trim()
  }
  return null
}

export function resolveApiKey(options: ResolveKeyOptions = {}): ResolvedKey {
  const optionKey = options.apiKey?.trim()
  if (optionKey) return { key: optionKey, source: "options.apiKey" }

  const env = options.env ?? process.env
  const envKey = env.DEEPSEEK_API_KEY?.trim()
  if (envKey) return { key: envKey, source: "env:DEEPSEEK_API_KEY" }

  const home = options.home ?? homedir()
  const authPath = join(home, ".local", "share", "opencode", "auth.json")
  const auth = readJsonc(authPath)
  if (auth && typeof auth === "object") {
    const record = auth as Record<string, unknown>
    for (const id of ["deepseek", "deepseek-official", "ds"]) {
      const entry = record[id]
      if (entry && typeof entry === "object") {
        const key = (entry as Record<string, unknown>).key
        if (typeof key === "string" && key.trim()) return { key: key.trim(), source: `auth.json:${id}` }
      }
    }
  }

  const configHome = options.configHome ?? env.XDG_CONFIG_HOME ?? join(home, ".config")
  const candidates: string[] = []
  if (options.directory) {
    candidates.push(join(options.directory, "opencode.json"), join(options.directory, "opencode.jsonc"))
    candidates.push(join(options.directory, ".opencode", "opencode.json"), join(options.directory, ".opencode", "opencode.jsonc"))
  }
  candidates.push(join(configHome, "opencode", "opencode.json"), join(configHome, "opencode", "opencode.jsonc"))
  for (const candidate of candidates) {
    const key = apiKeyFromConfig(readJsonc(candidate))
    if (key) return { key, source: candidate }
  }

  return { key: null, source: "none" }
}
