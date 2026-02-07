import path from "path"
import fs from "fs/promises"
import { existsSync } from "fs"
import { Database } from "bun:sqlite"

export type Chunk = {
  idx: number
  start: number
  end: number
  tokens: number
  text: string
  lineStart: number
  lineEnd: number
}

export type Hit = {
  file: string
  idx: number
  lineStart: number
  lineEnd: number
  text: string
  score: number
  vector: number
  lex: number
}

type Row = {
  id: number
  file: string
  idx: number
  lineStart: number
  lineEnd: number
  content: string
  embedding: string
}

const size = Number.parseInt(process.env.MEMORY_CHUNK_SIZE ?? "400", 10)
const overlap = Number.parseInt(process.env.MEMORY_CHUNK_OVERLAP ?? "80", 10)
const dim = Number.parseInt(process.env.MEMORY_EMBED_DIM ?? "384", 10)

const seg = new Intl.Segmenter(undefined, { granularity: "word" })

export function root(base: string) {
  if (process.env.MEMORY_ROOT) return path.resolve(process.env.MEMORY_ROOT)
  return path.join(base, "memory")
}

export function dbPath(base: string) {
  if (process.env.MEMORY_DB) return path.resolve(process.env.MEMORY_DB)
  return path.join(base, "index.sqlite")
}

export function date(day = new Date()) {
  return day.toLocaleDateString("sv-SE")
}

export function today(day = new Date()) {
  return date(day)
}

export function yesterday(day = new Date()) {
  const prev = new Date(day)
  prev.setDate(prev.getDate() - 1)
  return date(prev)
}

export function daily(base: string, day: string) {
  return path.join(base, `${day}.md`)
}

export function long(base: string) {
  return path.join(base, "MEMORY.md")
}

export async function read(file: string) {
  if (!existsSync(file)) return null
  const text = await Bun.file(file).text()
  const trimmed = text.trim()
  if (!trimmed) return null
  return trimmed
}

type Segment = { start: number; end: number; value: string }

function segments(text: string): Segment[] {
  if (!text) return []
  const parts = Array.from(seg.segment(text))
  if (!parts.length) return []
  return parts
    .map((part, idx) => {
      const start = part.index
      const end = idx + 1 < parts.length ? parts[idx + 1]!.index : text.length
      const value = text.slice(start, end)
      return { start, end, value }
    })
    .filter((item) => item.value.trim().length > 0)
}

function words(text: string) {
  return segments(text).map((item) => item.value.toLowerCase())
}

function tokens(text: string) {
  return segments(text).map((item) => ({ start: item.start, end: item.end }))
}

export function chunk(text: string, opts?: { size?: number; overlap?: number }): Chunk[] {
  const limit = opts?.size ?? size
  const cover = opts?.overlap ?? overlap
  if (!text.trim()) return []
  if (limit <= 0) return []
  const step = limit - cover
  if (step <= 0) return []
  const items = tokens(text)
  if (!items.length) return []
  const count = Math.ceil(items.length / step)
  return Array.from({ length: count }, (_, idx) => {
    const start = idx * step
    const part = items.slice(start, start + limit)
    if (!part.length) return null
    const first = part[0]!
    const last = part[part.length - 1]!
    const slice = text.slice(first.start, last.end).trim()
    if (!slice) return null
    const lineStart = text.slice(0, first.start).split("\n").length
    const lineEnd = text.slice(0, last.end).split("\n").length
    return {
      idx,
      start: first.start,
      end: last.end,
      tokens: part.length,
      text: slice,
      lineStart,
      lineEnd,
    }
  }).filter((item): item is Chunk => !!item)
}

function hash(value: string) {
  let out = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    out ^= value.charCodeAt(i)
    out = Math.imul(out, 16777619)
  }
  return out >>> 0
}

function grams(value: string) {
  if (value.length < 3) return [value]
  return Array.from({ length: value.length - 2 }, (_, idx) => value.slice(idx, idx + 3))
}

export function embed(text: string) {
  const vec = new Float32Array(dim)
  words(text).forEach((word) => {
    grams(word).forEach((part) => {
      const idx = hash(part) % dim
      vec[idx] += 1
    })
  })
  const norm = Math.sqrt(vec.reduce((sum, value) => sum + value * value, 0))
  if (!norm) return Array.from(vec)
  for (let i = 0; i < vec.length; i += 1) {
    vec[i] /= norm
  }
  return Array.from(vec)
}

export function open(file: string) {
  const db = new Database(file)
  db.exec(`PRAGMA journal_mode = WAL;`)
  db.exec(`PRAGMA synchronous = NORMAL;`)
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY,
      file TEXT NOT NULL,
      idx INTEGER NOT NULL,
      start INTEGER NOT NULL,
      end INTEGER NOT NULL,
      tokens INTEGER NOT NULL,
      line_start INTEGER NOT NULL,
      line_end INTEGER NOT NULL,
      content TEXT NOT NULL,
      embedding TEXT NOT NULL,
      updated INTEGER NOT NULL
    );
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS chunk_file ON chunks(file);`)
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(content, file, idx);`)
  return db
}

export function removeFile(db: Database, file: string) {
  db.prepare(`DELETE FROM chunks WHERE file = ?`).run(file)
  db.prepare(`DELETE FROM fts WHERE file = ?`).run(file)
}

export async function indexFile(db: Database, file: string) {
  if (!existsSync(file)) {
    removeFile(db, file)
    return 0
  }
  const text = await Bun.file(file).text()
  const parts = chunk(text)
  removeFile(db, file)
  if (!parts.length) return 0
  const insert = db.prepare(`
    INSERT INTO chunks (file, idx, start, end, tokens, line_start, line_end, content, embedding, updated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const fts = db.prepare(`INSERT INTO fts (rowid, content, file, idx) VALUES (?, ?, ?, ?)`)
  const now = Date.now()
  parts.forEach((item) => {
    const info = insert.run(
      file,
      item.idx,
      item.start,
      item.end,
      item.tokens,
      item.lineStart,
      item.lineEnd,
      item.text,
      JSON.stringify(embed(item.text)),
      now,
    )
    const id = Number(info.lastInsertRowid)
    fts.run(id, item.text, file, item.idx)
  })
  return parts.length
}

async function scan(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return []
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const items = await Promise.all(
    entries.map(async (entry) => {
      const next = path.join(dir, entry.name)
      if (entry.isDirectory()) return scan(next)
      if (entry.isFile() && entry.name.endsWith(".md")) return [next]
      return []
    }),
  )
  return items.flat()
}

export async function indexAll(db: Database, base: string) {
  const files = await scan(base)
  const counts = await Promise.all(files.map((file) => indexFile(db, file)))
  const chunks = counts.reduce((sum, count) => sum + count, 0)
  return { files: files.length, chunks }
}

function terms(value: string) {
  const safe = value.replace(/[^\p{L}\p{N}_-]+/gu, " ").trim()
  if (!safe) return []
  return safe.split(/\s+/)
}

function vec(value: string) {
  const raw = JSON.parse(value) as unknown
  if (!Array.isArray(raw)) return []
  return raw.map((item) => Number(item))
}

function dot(a: number[], b: number[]) {
  const limit = Math.min(a.length, b.length)
  let sum = 0
  for (let i = 0; i < limit; i += 1) {
    sum += (a[i] ?? 0) * (b[i] ?? 0)
  }
  return sum
}

export function search(db: Database, query: string, opts?: { limit?: number; alpha?: number }) {
  const key = query.trim()
  if (!key) return []
  const limit = opts?.limit ?? 8
  const alpha = typeof opts?.alpha === "number" && Number.isFinite(opts.alpha) ? opts.alpha : 0.6
  const weight = Math.min(1, Math.max(0, alpha))
  const max = Math.max(limit * 4, 20)
  const rows = db
    .query(
      `
        SELECT
          id,
          file,
          idx,
          line_start as lineStart,
          line_end as lineEnd,
          content,
          embedding
        FROM chunks
      `,
    )
    .all() as Row[]
  if (!rows.length) return []
  const rowMap = new Map(rows.map((row) => [row.id, row]))
  const queryVec = embed(key)
  const vecHits = rows
    .map((row) => ({ id: row.id, score: dot(queryVec, vec(row.embedding)), row }))
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
  const keys = terms(key)
  const lexHits = keys.length
    ? (db
        .query(`SELECT rowid as id, bm25(fts) as score FROM fts WHERE fts MATCH ? LIMIT ?`)
        .all(keys.map((term) => `"${term}"`).join(" "), max) as Array<{ id: number; score: number }>)
    : []
  const combined = new Map<number, { row: Row; vector: number; lex: number }>()
  vecHits.forEach((item) => {
    combined.set(item.id, { row: item.row, vector: item.score, lex: 0 })
  })
  lexHits.forEach((item) => {
    const row = rowMap.get(item.id)
    if (!row) return
    const score = 1 / (1 + item.score)
    const entry = combined.get(item.id)
    if (entry) {
      entry.lex = score
      return
    }
    combined.set(item.id, { row, vector: 0, lex: score })
  })
  return Array.from(combined.values())
    .map((item) => ({
      file: item.row.file,
      idx: item.row.idx,
      lineStart: item.row.lineStart,
      lineEnd: item.row.lineEnd,
      text: item.row.content,
      vector: item.vector,
      lex: item.lex,
      score: item.vector * weight + item.lex * (1 - weight),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}
