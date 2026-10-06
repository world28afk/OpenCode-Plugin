// oc-cyberbot 消息编辑核心 —— 直接读写 OpenCode V2 会话库 (opencode.db)。
//
// 数据模型 (V2): 每条消息真身 = session_message.data (JSON 字符串),
// 其中 content 数组保存各段: reasoning / text / tool / step-finish 等。
// 界面上"一条可见回复"通常是"一轮"(两条 user 消息之间)的一组 assistant 行,
// 其中工具步骤行没有 text 段。
//
// 提供的操作:
//   list  — 列出"本轮"(点击消息所在的、上一次用户消息之后的全部)所有带文本的回复段;
//   get   — 读取某条消息的文本（若所点行无文本则回溯到本轮最后一条带文本的回复）;
//   edit  — 改写指定回复段的文本（合并该段全部 text 为一个, reasoning/tool 保留）。
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

export interface ReplyItem {
  messageID: string
  seq: number
  text: string
  timeCreated: number
}

export interface ListResult {
  ok: boolean
  items?: ReplyItem[]
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

/** 列出本轮全部带文本的 assistant 回复段（升序）。 */
export function listTurnTexts(sessionID: string, messageID: string): ListResult {
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
    const items: ReplyItem[] = []
    for (const candidate of rows) {
      try {
        const text = collectText(JSON.parse(candidate.data))
        if (!text.trim()) continue
        items.push({ messageID: candidate.id, seq: candidate.seq, text, timeCreated: candidate.time_created })
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
 * 解析单条编辑目标行：
 * - 该行有文本 → 用它；
 * - 否则 → 同"轮"最后一个带文本的 assistant 行；
 * - 都没有 → 退回原行（调用方按空文本处理）。
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
