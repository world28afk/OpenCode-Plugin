// oc-cyberbot 消息编辑核心 —— 直接读写 OpenCode V2 会话库 (opencode.db)。
//
// 数据模型 (V2): 每条消息真身 = session_message.data (JSON 字符串),
// 其中 content 数组保存各段: reasoning(思考) / text(回复) / tool / step-finish 等。
// 界面上"一条可见回复"通常是"一轮"(两条 user 消息之间)的一组 assistant 行。
//
// 提供的操作:
//   list   — 列出本轮所有可编辑段(text/reasoning)，带 partIndex 精确定位;
//   get    — 读取整条消息文本（兼容旧调用）;
//   edit   — 按 partIndex 改写段文本；partIndex 缺省时兼容旧行为（合并替换全部 text 段）;
//   remove — 按 partIndex 删除段（仅允许 text/reasoning）。
//
// 注: OpenCode V2 没有提供"修改消息"的公开 API（仅 GET），因此这里做受控
// UPDATE；实测服务器读取会话时实时读取数据库（编辑立即可见）。

import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface TextResult {
  ok: boolean
  text?: string
  error?: string
  messageID?: string
  resolvedFrom?: string
}

export interface OkResult {
  ok: boolean
  error?: string
}

export type EditableKind = "text" | "reasoning"

export interface PartItem {
  messageID: string
  partIndex: number
  kind: EditableKind
  text: string
  seq: number
  timeCreated: number
}

export interface ListResult {
  ok: boolean
  items?: PartItem[]
  error?: string
}

const MESSAGE_ID_RE = /^msg_[A-Za-z0-9]+$/
const MAX_TEXT = 200_000

function dbCandidates(): string[] {
  const env = process.env
  const out: string[] = []
  if (env.OPENCODE_DATA_DIR) out.push(join(env.OPENCODE_DATA_DIR, "opencode.db"))
  if (env.OPENCODE_DATA) out.push(join(env.OPENCODE_DATA, "opencode.db"))
  out.push(join(homedir(), ".local", "share", "opencode", "opencode.db"))
  if (env.LOCALAPPDATA) out.push(join(env.LOCALAPPDATA, "opencode", "opencode.db"))
  if (env.APPDATA) out.push(join(env.APPDATA, "opencode", "opencode.db"))
  return out
}

let cached: Database | null = null
let cachedPath = ""

function openDb(): Database {
  if (cached) return cached
  const tried: string[] = []
  for (const candidate of dbCandidates()) {
    tried.push(candidate)
    if (!existsSync(candidate)) continue
    const db = new Database(candidate)
    db.exec("PRAGMA busy_timeout = 4000")
    cached = db
    cachedPath = candidate
    return db
  }
  throw new Error(`未找到 opencode.db（尝试过: ${tried.join(" ; ")}）`)
}

export function dbPath(): string {
  openDb()
  return cachedPath
}

interface MessageRow {
  id: string
  session_id: string
  type: string
  seq: number
  time_created: number
  data: string
}

function loadRow(messageID: string): MessageRow | { error: string } {
  if (!MESSAGE_ID_RE.test(messageID)) return { error: "messageID 格式无效（应为 msg_...）" }
  const db = openDb()
  const row = db
    .query("select id, session_id, type, seq, time_created, data from session_message where id = ?")
    .get(messageID) as MessageRow | null
  if (!row) return { error: "消息不存在（session_message 中未找到）" }
  return row
}

function isEditablePart(part: unknown): part is Record<string, unknown> & { type: EditableKind } {
  if (!part || typeof part !== "object") return false
  const type = (part as { type?: unknown }).type
  return type === "text" || type === "reasoning"
}

function partAt(obj: unknown, index: number): Record<string, unknown> | null {
  const content = (obj as { content?: unknown[] }).content
  if (!Array.isArray(content)) return null
  if (!Number.isInteger(index) || index < 0 || index >= content.length) return null
  const part = content[index]
  return part && typeof part === "object" ? (part as Record<string, unknown>) : null
}

function textParts(obj: unknown): string[] {
  const content = Array.isArray((obj as { content?: unknown[] }).content) ? (obj as { content: unknown[] }).content : []
  return content
    .filter((part): part is { type?: unknown; text?: unknown } => !!part && typeof part === "object")
    .filter((part) => part.type === "text")
    .map((part) => String(part.text ?? ""))
}

function collectText(obj: unknown): string {
  return textParts(obj).join("\n\n")
}

function hasText(obj: unknown): boolean {
  return textParts(obj).some((text) => text.trim().length > 0)
}

/** 计算"本轮"边界: 点击行所在的两条用户消息之间。 */
function turnBounds(db: Database, row: MessageRow): { lower: number; upper: number } {
  const previous = db
    .query("select max(seq) as s from session_message where session_id = ? and type = 'user' and seq < ?")
    .get(row.session_id, row.seq) as { s: number | null } | null
  const next = db
    .query("select min(seq) as s from session_message where session_id = ? and type = 'user' and seq > ?")
    .get(row.session_id, row.seq) as { s: number | null } | null
  return {
    lower: previous && previous.s != null ? previous.s : -1,
    upper: next && next.s != null ? next.s : Number.MAX_SAFE_INTEGER,
  }
}

/** 列出本轮全部可编辑段（text/reasoning，带 partIndex，按时间与内容顺序）。 */
export function listTurnParts(sessionID: string, messageID: string): ListResult {
  try {
    const row = loadRow(messageID)
    if ("error" in row) return { ok: false, error: row.error }
    if (sessionID && row.session_id !== sessionID) return { ok: false, error: "消息与会话不匹配" }
    const db = openDb()
    const { lower, upper } = turnBounds(db, row)
    const rows = db
      .query(
        "select id, session_id, type, seq, time_created, data from session_message " +
          "where session_id = ? and type = 'assistant' and seq > ? and seq < ? order by seq",
      )
      .all(row.session_id, lower, upper) as MessageRow[]
    const items: PartItem[] = []
    for (const candidate of rows) {
      try {
        const obj = JSON.parse(candidate.data)
        const content = Array.isArray(obj.content) ? obj.content : []
        content.forEach((part: unknown, index: number) => {
          if (!isEditablePart(part)) return
          const text = String(part.text ?? "")
          if (!text.trim()) return
          items.push({
            messageID: candidate.id,
            partIndex: index,
            kind: part.type,
            text,
            seq: candidate.seq,
            timeCreated: candidate.time_created,
          })
        })
      } catch {
        // 跳过无法解析的行
      }
    }
    return { ok: true, items }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 解析单条"整消息"目标行（兼容旧调用）：
 * - 该行有文本 → 用它；
 * - 否则 → 同"轮"最后一个带文本的 assistant 行；
 * - 都没有 → 退回原行。
 */
function resolveTarget(db: Database, row: MessageRow): MessageRow {
  try {
    if (hasText(JSON.parse(row.data))) return row
    const { lower, upper } = turnBounds(db, row)
    const candidates = db
      .query(
        "select id, session_id, type, seq, time_created, data from session_message " +
          "where session_id = ? and type = 'assistant' and seq > ? and seq < ? order by seq",
      )
      .all(row.session_id, lower, upper) as MessageRow[]
    let fallback: MessageRow | null = null
    for (const candidate of candidates) {
      try {
        if (hasText(JSON.parse(candidate.data))) fallback = candidate
      } catch {
        // 跳过
      }
    }
    return fallback ?? row
  } catch {
    return row
  }
}

export function readMessageText(sessionID: string, messageID: string): TextResult {
  try {
    const row = loadRow(messageID)
    if ("error" in row) return { ok: false, error: row.error }
    if (sessionID && row.session_id !== sessionID) return { ok: false, error: "消息与会话不匹配" }
    const db = openDb()
    const target = resolveTarget(db, row)
    const obj = JSON.parse(target.data)
    return {
      ok: true,
      text: collectText(obj),
      messageID: target.id,
      resolvedFrom: target.id === row.id ? undefined : row.id,
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 兼容旧调用：不使用 partIndex 时，合并替换目标行的全部 text 段。 */
export function editMessageText(sessionID: string, messageID: string, text: string): TextResult {
  try {
    if (typeof text !== "string") return { ok: false, error: "text 必须是字符串" }
    if (text.length > MAX_TEXT) return { ok: false, error: `文本过长（> ${MAX_TEXT}）` }
    const row = loadRow(messageID)
    if ("error" in row) return { ok: false, error: row.error }
    if (sessionID && row.session_id !== sessionID) return { ok: false, error: "消息与会话不匹配" }

    const db = openDb()
    const target = resolveTarget(db, row)
    const obj = JSON.parse(target.data) as { content?: Array<Record<string, unknown>> }
    const content = Array.isArray(obj.content) ? obj.content : []
    const textIndexes = content
      .map((part, index) => (part && part.type === "text" ? index : -1))
      .filter((index) => index >= 0)

    if (textIndexes.length > 0) {
      const first = textIndexes[0]
      content[first].text = text
      obj.content = content.filter((part, index) => !(part && part.type === "text" && index !== first))
    } else {
      content.push({ type: "text", text, metadata: { source: "oc-cyberbot" } })
      obj.content = content
    }

    const statement = db.prepare("update session_message set data = ?, time_updated = ? where id = ?")
    const result = statement.run(JSON.stringify(obj), Date.now(), target.id)
    if (!result.changes) return { ok: false, error: "写入未生效（0 行）" }
    return {
      ok: true,
      text,
      messageID: target.id,
      resolvedFrom: target.id === row.id ? undefined : row.id,
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 按 partIndex 改写单个段（text/reasoning）。 */
export function editPartText(sessionID: string, messageID: string, partIndex: number, text: string): TextResult {
  try {
    if (typeof text !== "string") return { ok: false, error: "text 必须是字符串" }
    if (text.length > MAX_TEXT) return { ok: false, error: `文本过长（> ${MAX_TEXT}）` }
    const row = loadRow(messageID)
    if ("error" in row) return { ok: false, error: row.error }
    if (sessionID && row.session_id !== sessionID) return { ok: false, error: "消息与会话不匹配" }

    const obj = JSON.parse(row.data) as { content?: unknown[] }
    const part = partAt(obj, partIndex)
    if (!part) return { ok: false, error: "partIndex 超出范围（消息可能已被更新）" }
    if (!isEditablePart(part)) return { ok: false, error: "该段不可编辑（仅支持 text/reasoning）" }
    part.text = text

    const db = openDb()
    const statement = db.prepare("update session_message set data = ?, time_updated = ? where id = ?")
    const result = statement.run(JSON.stringify(obj), Date.now(), row.id)
    if (!result.changes) return { ok: false, error: "写入未生效（0 行）" }
    return { ok: true, text, messageID: row.id }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 按 partIndex 删除单个段（仅 text/reasoning）。 */
export function removePart(sessionID: string, messageID: string, partIndex: number): OkResult {
  try {
    const row = loadRow(messageID)
    if ("error" in row) return { ok: false, error: row.error }
    if (sessionID && row.session_id !== sessionID) return { ok: false, error: "消息与会话不匹配" }

    const obj = JSON.parse(row.data) as { content?: unknown[] }
    const part = partAt(obj, partIndex)
    if (!part) return { ok: false, error: "partIndex 超出范围（消息可能已被更新）" }
    if (!isEditablePart(part)) return { ok: false, error: "该段不可删除（仅支持 text/reasoning）" }
    ;(obj.content as unknown[]).splice(partIndex, 1)

    const db = openDb()
    const statement = db.prepare("update session_message set data = ?, time_updated = ? where id = ?")
    const result = statement.run(JSON.stringify(obj), Date.now(), row.id)
    if (!result.changes) return { ok: false, error: "写入未生效（0 行）" }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
