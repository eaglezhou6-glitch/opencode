import path from "node:path"
import os from "node:os"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import fsSync from "node:fs"
import { Database } from "bun:sqlite"

type RawConfig = Record<string, unknown>

export type MemorySearchResult = {
  path: string
  startLine: number
  endLine: number
  score: number
  snippet: string
}

export type ResolvedMemoryConfig = {
  worktree: string
  paths: {
    rootDir: string
    dailyDir: string
    longTermFile: string
    indexFile: string
    extraPaths: string[]
  }
  chunk: {
    maxChars: number
    overlap: number
  }
  embedding: {
    provider: "openai"
    model: string
    baseUrl: string
    apiKey?: string
    headers: Record<string, string>
    batchSize: number
    providerKey: string
  }
  search: {
    maxResults: number
    minScore: number
    snippetChars: number
  }
  recall: {
    enabled: boolean
    maxResults: number
    minScore: number
    maxChars: number
    includePath: boolean
  }
  flush: {
    enabled: boolean
    mode: "llm" | "heuristic"
    model: string
    baseUrl: string
    apiKey?: string
    headers: Record<string, string>
    maxMessages: number
    maxItems: number
    systemPrompt: string
    userPrompt: string
  }
}

type MemoryChunk = {
  text: string
  startLine: number
  endLine: number
  hash: string
}

type MemoryFile = {
  absPath: string
  relPath: string
  mtimeMs: number
  size: number
  hash: string
  content: string
}

type MemoryMeta = {
  provider: string
  model: string
  providerKey: string
  chunkMaxChars: number
  chunkOverlap: number
}

type EmbeddingClient = {
  provider: "openai"
  model: string
  baseUrl: string
  apiKey: string
  headers: Record<string, string>
  batchSize: number
  providerKey: string
}

const CONFIG_FILES = ["memory.jsonc", "memory.json"] as const
const META_KEY = "memory_index_meta_v1"

const DEFAULT_FLUSH_SYSTEM = [
  "You are extracting durable memory notes for an AI assistant.",
  'Return JSON only with schema: {"longTerm": string[], "daily": string[]}.',
  "longTerm: stable preferences, identity facts, durable decisions.",
  "daily: short-term tasks and working context.",
  "If nothing, return empty arrays.",
  "Do not include secrets.",
].join("\n")

const DEFAULT_FLUSH_USER = [
  "Extract durable memory notes from the conversation below.",
  "Conversation:",
].join("\n")

const DEFAULT_CONFIG = {
  memory: {
    root: ".opencode",
    dailyDir: "memory",
    longTermFile: "MEMORY.md",
    indexFile: "",
    extraPaths: [] as string[],
    chunk: {
      maxChars: 1600,
      overlap: 200,
    },
  },
  embedding: {
    provider: "openai",
    model: "text-embedding-3-small",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "env:OPENAI_API_KEY",
    headers: {} as Record<string, string>,
    batchSize: 64,
  },
  search: {
    maxResults: 6,
    minScore: 0.35,
    snippetChars: 700,
  },
  recall: {
    enabled: true,
    maxResults: 6,
    minScore: 0.35,
    maxChars: 1600,
    includePath: true,
  },
  flush: {
    enabled: true,
    mode: "llm",
    model: "gpt-4o-mini",
    baseUrl: "",
    apiKey: "",
    headers: {} as Record<string, string>,
    maxMessages: 50,
    maxItems: 6,
    systemPrompt: DEFAULT_FLUSH_SYSTEM,
    userPrompt: DEFAULT_FLUSH_USER,
  },
} as const

const INDEX_LOCKS = new Map<string, Promise<void>>()

export async function resolveMemoryConfig(worktree: string): Promise<ResolvedMemoryConfig> {
  const raw = await readConfigFile(worktree)

  const mem = isRecord(raw.memory) ? raw.memory : {}
  const rootRaw = readString(mem.root) ?? DEFAULT_CONFIG.memory.root
  const dailyRaw = readString(mem.dailyDir) ?? DEFAULT_CONFIG.memory.dailyDir
  const longRaw = readString(mem.longTermFile) ?? DEFAULT_CONFIG.memory.longTermFile
  const indexRaw = readString(mem.indexFile)
  const extraRaw = readStringArray(mem.extraPaths)
  const chunkRaw = isRecord(mem.chunk) ? mem.chunk : {}
  const maxChars = clampInt(
    readNumber(chunkRaw.maxChars) ?? DEFAULT_CONFIG.memory.chunk.maxChars,
    200,
    8000,
  )
  const overlap = clampInt(
    readNumber(chunkRaw.overlap) ?? DEFAULT_CONFIG.memory.chunk.overlap,
    0,
    Math.max(0, maxChars - 1),
  )

  const rootDir = resolvePath(worktree, rootRaw)
  const dailyDir = path.resolve(rootDir, dailyRaw)
  const longTermFile = path.resolve(rootDir, longRaw)
  const indexFile = indexRaw ? resolvePath(worktree, indexRaw) : path.join(dailyDir, "index.sqlite")
  const extraPaths = (extraRaw ?? DEFAULT_CONFIG.memory.extraPaths).map((value) =>
    resolvePath(worktree, value),
  )

  const embedding = isRecord(raw.embedding) ? raw.embedding : {}
  const embModel = readString(embedding.model) ?? DEFAULT_CONFIG.embedding.model
  const embBaseUrl = readString(embedding.baseUrl) ?? DEFAULT_CONFIG.embedding.baseUrl
  const embApiKeyRaw = readString(embedding.apiKey) ?? DEFAULT_CONFIG.embedding.apiKey
  const embHeaders = readStringMap(embedding.headers) ?? DEFAULT_CONFIG.embedding.headers
  const embBatchSize = clampInt(
    readNumber(embedding.batchSize) ?? DEFAULT_CONFIG.embedding.batchSize,
    1,
    256,
  )
  const embApiKey = resolveApiKey(embApiKeyRaw)
  const embKey = hashText(
    JSON.stringify({
      baseUrl: embBaseUrl,
      model: embModel,
      headers: stableHeaders(embHeaders),
    }),
  )

  const search = isRecord(raw.search) ? raw.search : {}
  const maxResults = clampInt(
    readNumber(search.maxResults) ?? DEFAULT_CONFIG.search.maxResults,
    1,
    50,
  )
  const minScore = clampNumber(
    readNumber(search.minScore) ?? DEFAULT_CONFIG.search.minScore,
    0,
    1,
  )
  const snippetChars = clampInt(
    readNumber(search.snippetChars) ?? DEFAULT_CONFIG.search.snippetChars,
    100,
    2000,
  )

  const recall = isRecord(raw.recall) ? raw.recall : {}
  const recallEnabled = readBool(recall.enabled) ?? DEFAULT_CONFIG.recall.enabled
  const recallMaxResults = clampInt(
    readNumber(recall.maxResults) ?? maxResults ?? DEFAULT_CONFIG.recall.maxResults,
    1,
    20,
  )
  const recallMinScore = clampNumber(
    readNumber(recall.minScore) ?? minScore ?? DEFAULT_CONFIG.recall.minScore,
    0,
    1,
  )
  const recallMaxChars = clampInt(
    readNumber(recall.maxChars) ?? DEFAULT_CONFIG.recall.maxChars,
    200,
    8000,
  )
  const recallIncludePath = readBool(recall.includePath) ?? DEFAULT_CONFIG.recall.includePath

  const flush = isRecord(raw.flush) ? raw.flush : {}
  const flushEnabled = readBool(flush.enabled) ?? DEFAULT_CONFIG.flush.enabled
  const flushModeRaw = readString(flush.mode) ?? DEFAULT_CONFIG.flush.mode
  const flushMode = flushModeRaw === "heuristic" ? "heuristic" : "llm"
  const flushModel = readString(flush.model) ?? DEFAULT_CONFIG.flush.model
  const flushBase = readString(flush.baseUrl) ?? DEFAULT_CONFIG.flush.baseUrl
  const flushApiRaw = readString(flush.apiKey) ?? DEFAULT_CONFIG.flush.apiKey
  const flushHeaders = readStringMap(flush.headers) ?? DEFAULT_CONFIG.flush.headers
  const flushMaxMessages = clampInt(
    readNumber(flush.maxMessages) ?? DEFAULT_CONFIG.flush.maxMessages,
    1,
    200,
  )
  const flushMaxItems = clampInt(
    readNumber(flush.maxItems) ?? DEFAULT_CONFIG.flush.maxItems,
    1,
    50,
  )
  const flushSystem = readString(flush.systemPrompt) ?? DEFAULT_CONFIG.flush.systemPrompt
  const flushUser = readString(flush.userPrompt) ?? DEFAULT_CONFIG.flush.userPrompt
  const resolvedFlushBase = flushBase || embBaseUrl
  const resolvedFlushApi = resolveApiKey(flushApiRaw) ?? embApiKey

  return {
    worktree,
    paths: {
      rootDir,
      dailyDir,
      longTermFile,
      indexFile,
      extraPaths,
    },
    chunk: {
      maxChars,
      overlap,
    },
    embedding: {
      provider: "openai",
      model: embModel,
      baseUrl: embBaseUrl,
      apiKey: embApiKey,
      headers: embHeaders,
      batchSize: embBatchSize,
      providerKey: embKey,
    },
    search: {
      maxResults,
      minScore,
      snippetChars,
    },
    recall: {
      enabled: recallEnabled,
      maxResults: recallMaxResults,
      minScore: recallMinScore,
      maxChars: recallMaxChars,
      includePath: recallIncludePath,
    },
    flush: {
      enabled: flushEnabled,
      mode: flushMode,
      model: flushModel,
      baseUrl: resolvedFlushBase,
      apiKey: resolvedFlushApi,
      headers: flushHeaders,
      maxMessages: flushMaxMessages,
      maxItems: flushMaxItems,
      systemPrompt: flushSystem,
      userPrompt: flushUser,
    },
  }
}

export async function appendMemory(params: {
  cfg: ResolvedMemoryConfig
  target: "daily" | "longTerm"
  items: string[]
  now?: Date
}) {
  const cfg = params.cfg
  const items = params.items.map((item) => item.trim()).filter(Boolean)
  if (items.length === 0) {
    return { path: "", added: [] as string[] }
  }
  await ensureMemoryDirs(cfg)

  const now = params.now ?? new Date()
  const stamp = `${now.toISOString().replace("T", " ").split(".")[0]} UTC`
  const date = now.toISOString().split("T")[0]
  const filePath =
    params.target === "longTerm"
      ? cfg.paths.longTermFile
      : path.join(cfg.paths.dailyDir, `${date}.md`)
  const relPath = normalizeRelPath(cfg.worktree, filePath)
  const existing = await Bun.file(filePath)
    .text()
    .catch(() => "")
  const existingLower = existing.toLowerCase()
  const unique = items.filter((item) => !existingLower.includes(item.toLowerCase()))
  if (unique.length === 0) {
    return { path: relPath, added: [] as string[] }
  }

  const header = existing ? "\n" : params.target === "daily" ? `# ${date}\n\n` : ""
  const entry = `${header}### ${stamp}\n${unique.map((item) => `- ${item}`).join("\n")}\n`
  await fs.appendFile(filePath, entry, "utf-8")
  return { path: relPath, added: unique }
}

export async function readMemoryFile(params: {
  cfg: ResolvedMemoryConfig
  path: string
  from?: number
  lines?: number
}) {
  const cfg = params.cfg
  const resolved = await resolveAllowedPath(cfg, params.path)
  if (!resolved) {
    throw new Error("Invalid memory path.")
  }
  const content = await Bun.file(resolved.absPath).text()
  if (!params.from && !params.lines) {
    return { path: resolved.relPath, text: content }
  }
  const lines = content.split("\n")
  const start = Math.max(1, params.from ?? 1)
  const count = Math.max(1, params.lines ?? lines.length)
  const slice = lines.slice(start - 1, start - 1 + count)
  return { path: resolved.relPath, text: slice.join("\n") }
}

export async function searchMemory(params: {
  cfg: ResolvedMemoryConfig
  query: string
  maxResults?: number
  minScore?: number
}) {
  const cfg = params.cfg
  const query = params.query.trim()
  if (!query) {
    return { results: [] as MemorySearchResult[], provider: cfg.embedding.provider, model: cfg.embedding.model }
  }
  const client = createEmbeddingClient(cfg)
  await syncIndex(cfg, client)
  const queryVec = (await embedBatch(client, [query]))[0] ?? []
  const results = await searchIndex(cfg, queryVec, {
    maxResults: params.maxResults,
    minScore: params.minScore,
  })
  return { results, provider: cfg.embedding.provider, model: cfg.embedding.model }
}

function createEmbeddingClient(cfg: ResolvedMemoryConfig): EmbeddingClient {
  const apiKey = cfg.embedding.apiKey
  if (!apiKey) {
    throw new Error("Missing embedding API key. Set memory.embedding.apiKey or OPENAI_API_KEY.")
  }
  return {
    provider: "openai",
    model: cfg.embedding.model,
    baseUrl: cfg.embedding.baseUrl,
    apiKey,
    headers: cfg.embedding.headers,
    batchSize: cfg.embedding.batchSize,
    providerKey: cfg.embedding.providerKey,
  }
}

async function syncIndex(cfg: ResolvedMemoryConfig, client: EmbeddingClient) {
  const existing = INDEX_LOCKS.get(cfg.paths.indexFile)
  if (existing) {
    return await existing
  }
  const task = runSync(cfg, client).finally(() => {
    INDEX_LOCKS.delete(cfg.paths.indexFile)
  })
  INDEX_LOCKS.set(cfg.paths.indexFile, task)
  return await task
}

async function runSync(cfg: ResolvedMemoryConfig, client: EmbeddingClient) {
  const db = openDb(cfg.paths.indexFile)
  try {
    ensureSchema(db)
    const meta = readMeta(db)
    const nextMeta: MemoryMeta = {
      provider: client.provider,
      model: client.model,
      providerKey: client.providerKey,
      chunkMaxChars: cfg.chunk.maxChars,
      chunkOverlap: cfg.chunk.overlap,
    }
    if (!meta || !sameMeta(meta, nextMeta)) {
      resetIndex(db)
      writeMeta(db, nextMeta)
    }

    const files = await listMemoryFiles(cfg)
    const active = new Set(files.map((file) => file.relPath))

    for (const file of files) {
      const row = db
        .prepare("SELECT hash FROM files WHERE path = ?")
        .get(file.relPath) as { hash: string } | undefined
      if (row?.hash === file.hash) {
        continue
      }
      await indexFile(db, cfg, client, file)
    }

    const stale = db.prepare("SELECT path FROM files").all() as Array<{ path: string }>
    for (const row of stale) {
      if (active.has(row.path)) {
        continue
      }
      db.prepare("DELETE FROM files WHERE path = ?").run(row.path)
      db.prepare("DELETE FROM chunks WHERE path = ?").run(row.path)
    }
  } finally {
    db.close()
  }
}

async function searchIndex(
  cfg: ResolvedMemoryConfig,
  queryVec: number[],
  opts: { maxResults?: number; minScore?: number },
) {
  const db = openDb(cfg.paths.indexFile)
  try {
    const rows = db
      .prepare("SELECT path, start_line, end_line, text, embedding FROM chunks")
      .all() as Array<{
      path: string
      start_line: number
      end_line: number
      text: string
      embedding: string
    }>
    const minScore = opts.minScore ?? cfg.search.minScore
    const maxResults = opts.maxResults ?? cfg.search.maxResults
    const results = rows
      .map((row) => {
        const embedding = parseEmbedding(row.embedding)
        if (embedding.length === 0 || embedding.length !== queryVec.length) {
          return null
        }
        const score = cosineSimilarity(queryVec, embedding)
        if (!Number.isFinite(score) || score < minScore) {
          return null
        }
        const snippet = row.text.trim().slice(0, cfg.search.snippetChars)
        return {
          path: row.path,
          startLine: row.start_line,
          endLine: row.end_line,
          score,
          snippet,
        } satisfies MemorySearchResult
      })
      .filter((entry): entry is MemorySearchResult => Boolean(entry))
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
    return results
  } finally {
    db.close()
  }
}

async function indexFile(
  db: Database,
  cfg: ResolvedMemoryConfig,
  client: EmbeddingClient,
  file: MemoryFile,
) {
  const chunks = chunkMarkdown(file.content, cfg.chunk.maxChars, cfg.chunk.overlap).filter((entry) =>
    entry.text.trim(),
  )
  const embeddings = await embedChunks(db, client, chunks)
  db.prepare("DELETE FROM chunks WHERE path = ?").run(file.relPath)
  const now = Date.now()
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i]
    const embedding = embeddings[i] ?? []
    const id = hashText(
      `${file.relPath}:${chunk.startLine}:${chunk.endLine}:${chunk.hash}:${client.model}`,
    )
    db.prepare(
      `INSERT INTO chunks (id, path, start_line, end_line, hash, text, embedding, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         hash=excluded.hash,
         text=excluded.text,
         embedding=excluded.embedding,
         updated_at=excluded.updated_at`,
    ).run(
      id,
      file.relPath,
      chunk.startLine,
      chunk.endLine,
      chunk.hash,
      chunk.text,
      JSON.stringify(embedding),
      now,
    )
  }
  db.prepare(
    `INSERT INTO files (path, hash, mtime, size) VALUES (?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET hash=excluded.hash, mtime=excluded.mtime, size=excluded.size`,
  ).run(file.relPath, file.hash, file.mtimeMs, file.size)
}

async function embedChunks(db: Database, client: EmbeddingClient, chunks: MemoryChunk[]) {
  if (chunks.length === 0) {
    return [] as number[][]
  }
  const cached = loadEmbeddingCache(db, client, chunks.map((chunk) => chunk.hash))
  const embeddings: number[][] = Array.from({ length: chunks.length }, () => [])
  const missing: Array<{ index: number; chunk: MemoryChunk }> = []

  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i]
    const hit = cached.get(chunk.hash)
    if (hit && hit.length > 0) {
      embeddings[i] = hit
      continue
    }
    missing.push({ index: i, chunk })
  }

  if (missing.length === 0) {
    return embeddings
  }

  const toCache: Array<{ hash: string; embedding: number[] }> = []
  for (const batch of buildBatches(missing, client.batchSize)) {
    const texts = batch.map((item) => item.chunk.text)
    const batchEmbeddings = await embedBatch(client, texts)
    for (let i = 0; i < batch.length; i += 1) {
      const item = batch[i]
      const embedding = batchEmbeddings[i] ?? []
      embeddings[item.index] = embedding
      toCache.push({ hash: item.chunk.hash, embedding })
    }
  }
  upsertEmbeddingCache(db, client, toCache)
  return embeddings
}

async function embedBatch(client: EmbeddingClient, texts: string[]) {
  if (texts.length === 0) {
    return [] as number[][]
  }
  const url = `${client.baseUrl.replace(/\/+$/, "")}/embeddings`
  const body = {
    model: client.model,
    input: texts,
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${client.apiKey}`,
    ...client.headers,
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const message = await response.text()
    throw new Error(`Embedding request failed (${response.status}): ${message}`)
  }
  const data = (await response.json()) as {
    data?: Array<{ embedding: number[]; index: number }>
  }
  const items = Array.isArray(data.data) ? data.data : []
  const ordered = items.toSorted((a, b) => a.index - b.index)
  return ordered.map((item) => normalizeEmbedding(item.embedding))
}

function loadEmbeddingCache(db: Database, client: EmbeddingClient, hashes: string[]) {
  const out = new Map<string, number[]>()
  if (hashes.length === 0) {
    return out
  }
  const unique = Array.from(new Set(hashes.filter(Boolean)))
  if (unique.length === 0) {
    return out
  }
  const batchSize = 400
  for (let start = 0; start < unique.length; start += batchSize) {
    const batch = unique.slice(start, start + batchSize)
    const placeholders = batch.map(() => "?").join(", ")
    const rows = db
      .prepare(
        `SELECT hash, embedding FROM embedding_cache
         WHERE provider = ? AND model = ? AND provider_key = ? AND hash IN (${placeholders})`,
      )
      .all(client.provider, client.model, client.providerKey, ...batch) as Array<{
      hash: string
      embedding: string
    }>
    for (const row of rows) {
      out.set(row.hash, parseEmbedding(row.embedding))
    }
  }
  return out
}

function upsertEmbeddingCache(
  db: Database,
  client: EmbeddingClient,
  entries: Array<{ hash: string; embedding: number[] }>,
) {
  if (entries.length === 0) {
    return
  }
  const now = Date.now()
  const stmt = db.prepare(
    `INSERT INTO embedding_cache (provider, model, provider_key, hash, embedding, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider, model, provider_key, hash) DO UPDATE SET
       embedding=excluded.embedding,
       updated_at=excluded.updated_at`,
  )
  for (const entry of entries) {
    stmt.run(
      client.provider,
      client.model,
      client.providerKey,
      entry.hash,
      JSON.stringify(entry.embedding),
      now,
    )
  }
}

function ensureSchema(db: Database) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  )
  db.exec(
    `CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      hash TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL
    )`,
  )
  db.exec(
    `CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      hash TEXT NOT NULL,
      text TEXT NOT NULL,
      embedding TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  )
  db.exec(
    `CREATE TABLE IF NOT EXISTS embedding_cache (
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      provider_key TEXT NOT NULL,
      hash TEXT NOT NULL,
      embedding TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (provider, model, provider_key, hash)
    )`,
  )
}

function resetIndex(db: Database) {
  db.exec("DELETE FROM files")
  db.exec("DELETE FROM chunks")
}

function readMeta(db: Database): MemoryMeta | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(META_KEY) as
    | { value: string }
    | undefined
  if (!row?.value) {
    return null
  }
  return parseJsonValue(row.value) as MemoryMeta | null
}

function writeMeta(db: Database, meta: MemoryMeta) {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(META_KEY, JSON.stringify(meta))
}

function sameMeta(a: MemoryMeta, b: MemoryMeta) {
  return (
    a.provider === b.provider &&
    a.model === b.model &&
    a.providerKey === b.providerKey &&
    a.chunkMaxChars === b.chunkMaxChars &&
    a.chunkOverlap === b.chunkOverlap
  )
}

function openDb(filePath: string) {
  const dir = path.dirname(filePath)
  if (!fsSync.existsSync(dir)) {
    fsSync.mkdirSync(dir, { recursive: true })
  }
  return new Database(filePath)
}

async function listMemoryFiles(cfg: ResolvedMemoryConfig): Promise<MemoryFile[]> {
  const files: string[] = []
  if (await exists(cfg.paths.longTermFile)) {
    files.push(cfg.paths.longTermFile)
  }
  files.push(...(await listMarkdownFiles(cfg.paths.dailyDir)))
  for (const extra of cfg.paths.extraPaths) {
    if (await exists(extra)) {
      const stat = await fs.lstat(extra)
      if (stat.isSymbolicLink()) {
        continue
      }
      if (stat.isFile() && extra.endsWith(".md")) {
        files.push(extra)
      }
      if (stat.isDirectory()) {
        files.push(...(await listMarkdownFiles(extra)))
      }
    }
  }
  const unique = Array.from(new Set(files))
  const entries: MemoryFile[] = []
  for (const absPath of unique) {
    const stat = await fs.stat(absPath)
    const content = await Bun.file(absPath).text()
    entries.push({
      absPath,
      relPath: normalizeRelPath(cfg.worktree, absPath),
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      hash: hashText(content),
      content,
    })
  }
  return entries
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  const files: string[] = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isSymbolicLink()) {
      continue
    }
    if (entry.isDirectory()) {
      files.push(...(await listMarkdownFiles(full)))
      continue
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(full)
    }
  }
  return files
}

async function resolveAllowedPath(cfg: ResolvedMemoryConfig, rawPath: string) {
  const input = rawPath.trim()
  if (!input) {
    return null
  }
  const absPath = path.isAbsolute(input) ? path.resolve(input) : path.resolve(cfg.worktree, input)
  if (!absPath.endsWith(".md")) {
    return null
  }
  const stat = await fs.lstat(absPath).catch(() => null)
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
    return null
  }
  if (samePath(absPath, cfg.paths.longTermFile)) {
    return { absPath, relPath: normalizeRelPath(cfg.worktree, absPath) }
  }
  if (absPath.startsWith(`${cfg.paths.dailyDir}${path.sep}`)) {
    return { absPath, relPath: normalizeRelPath(cfg.worktree, absPath) }
  }
  for (const extra of cfg.paths.extraPaths) {
    const extraStat = await fs.lstat(extra).catch(() => null)
    if (!extraStat || extraStat.isSymbolicLink()) {
      continue
    }
    if (extraStat.isFile() && samePath(extra, absPath)) {
      return { absPath, relPath: normalizeRelPath(cfg.worktree, absPath) }
    }
    if (extraStat.isDirectory() && absPath.startsWith(`${extra}${path.sep}`)) {
      return { absPath, relPath: normalizeRelPath(cfg.worktree, absPath) }
    }
  }
  return null
}

function chunkMarkdown(content: string, maxChars: number, overlapChars: number): MemoryChunk[] {
  const lines = content.split("\n")
  const chunks: MemoryChunk[] = []
  let buffer: string[] = []
  let count = 0
  let startLine = 1

  const pushChunk = (endLine: number) => {
    const text = buffer.join("\n")
    chunks.push({
      text,
      startLine,
      endLine,
      hash: hashText(text),
    })
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ""
    const lineSize = line.length + 1
    if (buffer.length > 0 && count + lineSize > maxChars) {
      const endLine = i
      pushChunk(endLine)
      const overlap = takeOverlap(buffer, overlapChars)
      buffer = overlap
      count = overlap.join("\n").length
      startLine = Math.max(1, endLine - buffer.length + 1)
    }
    buffer.push(line)
    count += lineSize
  }

  if (buffer.length > 0) {
    pushChunk(lines.length)
  }

  return chunks
}

function takeOverlap(lines: string[], overlapChars: number) {
  if (overlapChars <= 0) {
    return []
  }
  const out: string[] = []
  let count = 0
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? ""
    const size = line.length + 1
    if (count + size > overlapChars && out.length > 0) {
      break
    }
    out.unshift(line)
    count += size
  }
  return out
}

function normalizeEmbedding(vec: number[]) {
  const sanitized = vec.map((value) => (Number.isFinite(value) ? value : 0))
  const sum = sanitized.reduce((total, value) => total + value * value, 0)
  const mag = Math.sqrt(sum)
  if (!Number.isFinite(mag) || mag === 0) {
    return sanitized
  }
  return sanitized.map((value) => value / mag)
}

function cosineSimilarity(a: number[], b: number[]) {
  let sum = 0
  for (let i = 0; i < a.length; i += 1) {
    sum += (a[i] ?? 0) * (b[i] ?? 0)
  }
  return sum
}

function buildBatches<T>(items: T[], size: number) {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size))
  }
  return out
}

function parseEmbedding(value: string) {
  const parsed = parseJsonValue(value)
  if (!Array.isArray(parsed)) {
    return [] as number[]
  }
  return parsed.filter((item) => typeof item === "number")
}

function parseJsonValue(value: string) {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return null
  }
}

function readConfigFile(worktree: string): Promise<RawConfig> {
  const dir = path.join(worktree, ".opencode")
  return CONFIG_FILES.reduce(async (acc, name) => {
    const value = await acc
    if (Object.keys(value).length > 0) {
      return value
    }
    const filePath = path.join(dir, name)
    const file = Bun.file(filePath)
    if (!(await file.exists())) {
      return value
    }
    const text = await file.text()
    const parsed = parseJsonWithComments(text)
    return isRecord(parsed) ? parsed : value
  }, Promise.resolve({} as RawConfig))
}

function parseJsonWithComments(text: string) {
  const withoutBlock = text.replace(/\/\*[\s\S]*?\*\//g, "")
  const withoutLine = withoutBlock.replace(/^\s*\/\/.*$/gm, "")
  return parseJsonValue(withoutLine) ?? {}
}

function resolvePath(worktree: string, raw: string) {
  if (!raw) {
    return worktree
  }
  if (raw.startsWith("~/")) {
    return path.join(os.homedir(), raw.slice(2))
  }
  if (raw.startsWith("~")) {
    return path.join(os.homedir(), raw.slice(1))
  }
  if (path.isAbsolute(raw)) {
    return path.normalize(raw)
  }
  return path.normalize(path.join(worktree, raw))
}

function normalizeRelPath(worktree: string, absPath: string) {
  return path.relative(worktree, absPath).replace(/\\/g, "/")
}

function samePath(a: string, b: string) {
  return path.resolve(a) === path.resolve(b)
}

function resolveApiKey(value?: string) {
  if (!value) {
    return undefined
  }
  if (value.startsWith("env:")) {
    const key = value.slice(4).trim()
    return key ? process.env[key] : undefined
  }
  return value
}

function stableHeaders(headers: Record<string, string>) {
  return Object.entries(headers)
    .filter(([key]) => key.toLowerCase() !== "authorization")
    .toSorted(([a], [b]) => a.localeCompare(b))
}

function hashText(text: string) {
  return crypto.createHash("sha256").update(text).digest("hex")
}

function readString(value: unknown) {
  if (typeof value !== "string") {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function readNumber(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined
  }
  return value
}

function readBool(value: unknown) {
  if (typeof value !== "boolean") {
    return undefined
  }
  return value
}

function readStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return undefined
  }
  return value
    .filter((entry) => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function readStringMap(value: unknown) {
  if (!isRecord(value)) {
    return undefined
  }
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      continue
    }
    out[key] = entry
  }
  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function clampInt(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.floor(value)))
}

function clampNumber(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

async function ensureMemoryDirs(cfg: ResolvedMemoryConfig) {
  await fs.mkdir(cfg.paths.rootDir, { recursive: true })
  await fs.mkdir(cfg.paths.dailyDir, { recursive: true })
}

async function exists(filePath: string) {
  return await fs
    .access(filePath)
    .then(() => true)
    .catch(() => false)
}
