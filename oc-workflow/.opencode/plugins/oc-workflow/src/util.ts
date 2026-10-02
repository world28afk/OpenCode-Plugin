// 基础工具: id / hash / json / 信号量 / 截断。

import { createHash, randomBytes } from "node:crypto"

export function runId(): string {
  const time = Date.now().toString(36)
  const rand = randomBytes(3).toString("hex")
  return `wf_${time}_${rand}`
}

export function shortHash(input: unknown): string {
  return createHash("sha1").update(JSON.stringify(input ?? null)).digest("hex").slice(0, 12)
}

export function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function slug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  const head = text.slice(0, Math.max(0, max - 40))
  return `${head}\n…（已截断, 原始 ${text.length} 字符）`
}

export function getPath(source: unknown, path: string): unknown {
  let current: unknown = source
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object") return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

export class Semaphore {
  private available: number
  private readonly queue: Array<() => void> = []

  constructor(size: number) {
    this.available = Math.max(1, size)
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1
      return () => this.release()
    }
    await new Promise<void>((resolve) => this.queue.push(resolve))
    return () => this.release()
  }

  private release() {
    const next = this.queue.shift()
    if (next) {
      next()
      return
    }
    this.available += 1
  }
}
