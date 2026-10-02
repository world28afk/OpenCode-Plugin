// 目录发现 — builtin + 项目 + 个人。
//   1. 内置（不可被磁盘遮蔽）
//   2. 个人: ~/.config/opencode/workflows/*.workflow.json
//   3. 项目: <project>/.opencode/workflows/*.workflow.json（同名覆盖个人）

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { validateCapsule, type Capsule } from "./capsule"
import { builtinCapsules } from "./builtins"

export interface CatalogEntry {
  readonly name: string
  readonly source: "builtin" | "project" | "global"
  readonly description?: string
  readonly capsule: Capsule
  readonly path?: string
}

export interface Catalog {
  readonly entries: CatalogEntry[]
  readonly errors: string[]
}

export function loadCatalog(directory: string, home: string): Catalog {
  const entries: CatalogEntry[] = builtinCapsules().map((capsule) => ({
    name: capsule.name,
    source: "builtin" as const,
    description: capsule.intent ?? capsule.description,
    capsule,
  }))
  const errors: string[] = []

  const addDir = (dir: string, source: "project" | "global") => {
    if (!existsSync(dir)) return
    let files: string[]
    try {
      files = readdirSync(dir)
    } catch {
      return
    }
    for (const file of files) {
      if (!file.endsWith(".workflow.json")) continue
      const path = join(dir, file)
      try {
        const raw = JSON.parse(readFileSync(path, "utf8")) as unknown
        const result = validateCapsule(raw)
        if (!result.ok) {
          errors.push(`${source}/${file}: ${result.errors.join("; ")}`)
          continue
        }
        const capsule = result.value
        const builtin = entries.find((entry) => entry.name === capsule.name && entry.source === "builtin")
        if (builtin) {
          errors.push(`${source}/${file}: 与内置 workflow 同名（${capsule.name}）, 已忽略`)
          continue
        }
        const next: CatalogEntry = { name: capsule.name, source, description: capsule.intent ?? capsule.description, capsule, path }
        const index =
          source === "project"
            ? entries.findIndex((entry) => entry.name === capsule.name && entry.source !== "builtin")
            : entries.findIndex((entry) => entry.name === capsule.name && entry.source === "global")
        if (index >= 0) entries[index] = next
        else entries.push(next)
      } catch (error) {
        errors.push(`${source}/${file}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  addDir(join(home, ".config", "opencode", "workflows"), "global")
  addDir(join(directory, ".opencode", "workflows"), "project")
  return { entries, errors }
}

export function findEntry(catalog: Catalog, name: string): CatalogEntry | null {
  return catalog.entries.find((entry) => entry.name === name) ?? null
}
