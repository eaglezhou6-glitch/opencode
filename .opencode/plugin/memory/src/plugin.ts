import type { Plugin } from "@opencode-ai/plugin"
import { generateText } from "ai"
import { createCompaction, createCompactionState, type CompactionCtx } from "./compaction"
import { appendMemory, resolveMemoryConfig, searchMemory, syncMemoryIndex } from "./memory"

type MessageEntry = {
  info?: { role?: string }
  parts?: unknown[]
}

type MemoryNotes = {
  longTerm: string[]
  daily: string[]
}

type RecallEntry = {
  messageID: string
  text: string
  createdAt: number
}

type ModelRef = {
  providerID: string
  modelID: string
}

type ModelEntry = {
  api?: {
    id?: string
    url?: string
    npm?: string
  }
  headers?: Record<string, string>
  options?: Record<string, unknown>
}

type ProviderEntry = {
  id: string
  key?: string
  options?: Record<string, unknown>
  models?: Record<string, ModelEntry>
}

type ConfigSnapshot = {
  model?: string
  providers: ProviderEntry[]
}

type FlushTarget = {
  provider: ProviderEntry
  model: ModelEntry
  modelID: string
  apiID: string
  npm: string
  options: Record<string, unknown>
}

type LanguageModel = any

const RECALL_TTL_MS = 5 * 60 * 1000
const RECALL_CACHE = new Map<string, RecallEntry>()

const CONFIG_TTL_MS = 60 * 1000
let CONFIG_CACHE: { at: number; snapshot: ConfigSnapshot } | null = null

export const MemoryPlugin: Plugin = async ({ client, worktree }) => {
  const compactionState = createCompactionState()
  const compaction = createCompaction({ client } as unknown as CompactionCtx, compactionState)

  let activeSessionID: string | undefined
  const flushedSessions = new Set<string>()

  const log = (level: "debug" | "info" | "warn" | "error", message: string, extra?: object) => {
    void client.app
      .log({
        body: {
          service: "memory",
          level,
          message,
          extra: extra as unknown as Record<string, unknown> | undefined,
        },
      })
      .catch(() => {})
  }

  const flushSession = async (sessionID: string, messages?: MessageEntry[]) => {
    if (flushedSessions.has(sessionID)) return
    const cfg = await resolveMemoryConfig(worktree)
    if (!cfg.flush.enabled) return
    if (!messages) {
      const res = await client.session.messages({ path: { id: sessionID } })
      messages = Array.isArray(res.data) ? (res.data as MessageEntry[]) : []
    }
    if (messages.length === 0) return
    const transcript = buildTranscript(messages, cfg.flush.maxMessages)
    if (!transcript) return
    const notes = await resolveNotes(client, cfg, transcript, log)
    if (!notes) return
    const longTerm = uniqueNotes(notes.longTerm, cfg.flush.maxItems)
    const daily = uniqueNotes(notes.daily, cfg.flush.maxItems)
    if (longTerm.length > 0) {
      await appendMemory({ cfg, target: "longTerm", items: longTerm, sessionID }).catch(() => {})
    }
    if (daily.length > 0) {
      await appendMemory({ cfg, target: "daily", items: daily, sessionID }).catch(() => {})
    }
    if (longTerm.length > 0 || daily.length > 0) {
      log("info", "memory flush wrote notes", { sessionID, longTerm: longTerm.length, daily: daily.length })
      await syncMemoryIndex(cfg)
    }
    flushedSessions.add(sessionID)
  }

  return {
    event: async ({ event }: { event: { type: string; properties?: Record<string, unknown> } }) => {
      if (event.type !== "session.created") return
      const info = (event.properties?.info ?? {}) as { id?: string }
      const prev = activeSessionID
      activeSessionID = info.id
      if (!prev || flushedSessions.has(prev)) return
      await flushSession(prev).catch(() => {})
    },
    "chat.message": async (input, output) => {
      if (!activeSessionID) activeSessionID = input.sessionID

      const msg = output.message
      if (msg.role !== "user") {
        return
      }
      if (msg.agent === "compaction" || msg.agent === "summary" || msg.agent === "title") {
        return
      }

      const cfg = await resolveMemoryConfig(worktree)
      if (!cfg.recall.enabled) {
        return
      }

      const query = buildQuery(output.parts)
      if (!query || query.length < 4) {
        return
      }

      const searched = await searchMemory({
        cfg,
        query,
        maxResults: cfg.recall.maxResults,
        minScore: cfg.recall.minScore,
      }).catch(() => null)
      const results = searched?.results ?? []
      if (results.length === 0) {
        return
      }

      const text = formatRecall(cfg, results)
      if (!text) {
        return
      }

      RECALL_CACHE.set(input.sessionID, {
        messageID: msg.id,
        text,
        createdAt: Date.now(),
      })
    },
    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) {
        return
      }
      const entry = RECALL_CACHE.get(input.sessionID)
      if (!entry) {
        return
      }
      if (Date.now() - entry.createdAt > RECALL_TTL_MS) {
        RECALL_CACHE.delete(input.sessionID)
        return
      }
      output.system.push(entry.text)
      RECALL_CACHE.delete(input.sessionID)
    },
    "experimental.session.compacting": async (input, output) => {
      // Fetch all messages once — shared by flush and compaction
      const res = await client.session.messages({
        path: { id: input.sessionID },
      })
      const allMessages = Array.isArray(res.data) ? (res.data as MessageEntry[]) : []

      // Memory flush (reuses allMessages, deduplicates via flushedSessions)
      await flushSession(input.sessionID, allMessages)

      // Compaction: token limit note (reuses allMessages)
      await compaction.onCompacting(input, output, allMessages)
    },
    "experimental.text.complete": async (input, output) => {
      await compaction.onTextComplete(input, output)
    },
    "tool.execute.after": async (input, output) => {
      await compaction.onToolAfter(input, output)
    },
  }
}

function buildTranscript(entries: MessageEntry[], limit: number) {
  const slice = entries.slice(Math.max(0, entries.length - limit))
  const lines = slice
    .map((entry) => {
      const role = entry.info?.role === "user" ? "User" : "Assistant"
      const text = (entry.parts ?? [])
        .map((part) => readTextPart(part))
        .filter(Boolean)
        .join("\n")
        .trim()
      if (!text) {
        return null
      }
      return `${role}: ${text}`
    })
    .filter((line): line is string => Boolean(line))
  if (lines.length === 0) {
    return ""
  }
  const joined = lines.join("\n")
  const maxChars = 12000
  if (joined.length <= maxChars) {
    return joined
  }
  return joined.slice(joined.length - maxChars)
}

function readTextPart(part: unknown) {
  if (!part || typeof part !== "object") {
    return null
  }
  const record = part as { type?: unknown; text?: unknown }
  if (record.type !== "text") {
    return null
  }
  if (typeof record.text !== "string") {
    return null
  }
  const text = record.text.trim()
  return text ? text : null
}

function buildQuery(parts: unknown[]) {
  const lines = (parts ?? [])
    .map((part) => readTextPart(part))
    .filter(Boolean) as string[]
  if (lines.length === 0) {
    return ""
  }
  const joined = lines.join("\n").trim()
  if (!joined) {
    return ""
  }
  const maxChars = 4000
  if (joined.length <= maxChars) {
    return joined
  }
  return joined.slice(0, maxChars)
}

function extractHeuristic(transcript: string): MemoryNotes {
  const lines = transcript
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("User: "))
    .map((line) => line.replace(/^User:\s*/, ""))
  const longTermRules = [
    /my name is/i,
    /\bI am\b/i,
    /\bI'?m\b/i,
    /prefer/i,
    /always/i,
    /never/i,
    /like/i,
    /love/i,
    /hate/i,
  ]
  const dailyRules = [/working on/i, /next step/i, /todo/i, /current task/i]
  const longTerm = lines.filter((line) => longTermRules.some((rule) => rule.test(line)))
  const daily = lines.filter((line) => dailyRules.some((rule) => rule.test(line)))
  return { longTerm, daily }
}

async function resolveNotes(
  client: Parameters<Plugin>[0]["client"],
  cfg: Awaited<ReturnType<typeof resolveMemoryConfig>>,
  transcript: string,
  log: (level: "debug" | "info" | "warn" | "error", message: string, extra?: object) => void,
) {
  if (cfg.flush.mode === "heuristic") {
    return extractHeuristic(transcript)
  }
  const llm = await extractWithLlm(client, cfg, transcript, log).catch(() => null)
  if (llm) {
    return llm
  }
  log("warn", "memory flush LLM failed, falling back to heuristics")
  return extractHeuristic(transcript)
}

function formatRecall(
  cfg: Awaited<ReturnType<typeof resolveMemoryConfig>>,
  results: Array<{ path: string; startLine: number; endLine: number; snippet: string }>,
) {
  if (results.length === 0) {
    return ""
  }
  const lines = ["<memory>", "Relevant memory notes:"]
  let remaining = cfg.recall.maxChars - lines.join("\n").length - 1
  if (remaining <= 0) {
    return ""
  }
  for (const result of results) {
    const snippet = result.snippet.trim()
    if (!snippet) {
      continue
    }
    const source = cfg.recall.includePath
      ? `\n  Source: ${result.path}#L${result.startLine}-${result.endLine}`
      : ""
    let entry = `- ${snippet}${source}`
    if (entry.length > remaining) {
      entry = entry.slice(0, Math.max(0, remaining))
    }
    if (!entry) {
      break
    }
    lines.push(entry)
    remaining -= entry.length + 1
    if (remaining <= 0) {
      break
    }
  }
  lines.push("</memory>")
  return lines.join("\n")
}

async function extractWithLlm(
  client: Parameters<Plugin>[0]["client"],
  cfg: Awaited<ReturnType<typeof resolveMemoryConfig>>,
  transcript: string,
  log: (level: "debug" | "info" | "warn" | "error", message: string, extra?: object) => void,
) {
  const target = await resolveFlushTarget(client, cfg, log)
  if (target) {
    const notes = await extractWithSdk(target, cfg, transcript).catch(() => null)
    if (notes) {
      return notes
    }
  }
  return extractWithFetch(cfg, transcript)
}

async function extractWithSdk(
  target: FlushTarget,
  cfg: Awaited<ReturnType<typeof resolveMemoryConfig>>,
  transcript: string,
) {
  const language = await resolveLanguage(target).catch(() => null)
  if (!language) {
    return null
  }
  const result = await generateText({
    model: language,
    temperature: 0.2,
    messages: [
      { role: "system", content: cfg.flush.systemPrompt },
      { role: "user", content: `${cfg.flush.userPrompt}\n\n${transcript}` },
    ],
  })
  const content = result.text
  if (typeof content !== "string") {
    return null
  }
  return parseNotes(content)
}

async function extractWithFetch(cfg: Awaited<ReturnType<typeof resolveMemoryConfig>>, transcript: string) {
  const model = readString(cfg.flush.model)
  if (!model) {
    return null
  }
  const apiKey = cfg.flush.apiKey
  if (!apiKey) {
    return null
  }
  const baseUrl = cfg.flush.baseUrl.replace(/\/+$/, "")
  if (!baseUrl) {
    return null
  }
  const url = `${baseUrl}/chat/completions`
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    ...cfg.flush.headers,
  }
  const body = {
    model,
    temperature: 0.2,
    messages: [
      { role: "system", content: cfg.flush.systemPrompt },
      { role: "user", content: `${cfg.flush.userPrompt}\n\n${transcript}` },
    ],
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    return null
  }
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  const content = data.choices?.[0]?.message?.content
  if (typeof content !== "string") {
    return null
  }
  return parseNotes(content)
}

async function resolveFlushTarget(
  client: Parameters<Plugin>[0]["client"],
  cfg: Awaited<ReturnType<typeof resolveMemoryConfig>>,
  log: (level: "debug" | "info" | "warn" | "error", message: string, extra?: object) => void,
) {
  const snapshot = await getConfigSnapshot(client)
  const candidates = buildCandidates(cfg, snapshot.model)
  if (candidates.length === 0) {
    log("warn", "memory flush model is missing", {})
    return null
  }
  const match = pickCandidate(snapshot.providers, candidates)
  if (!match) {
    log("warn", "memory flush model not found in providers", { candidates })
    return null
  }
  const provider = match.provider
  const model = match.model
  const api = readRecord(model.api)
  const apiID = readString(api?.id) ?? match.ref.modelID
  const npm = readString(api?.npm)
  if (!npm) {
    log("warn", "memory flush npm missing", { provider: provider.id, model: match.ref.modelID })
    return null
  }
  const options = buildProviderOptions(provider, model, cfg)
  return {
    provider,
    model,
    modelID: match.ref.modelID,
    apiID,
    npm,
    options,
  }
}

function buildProviderOptions(
  provider: ProviderEntry,
  model: ModelEntry,
  cfg: Awaited<ReturnType<typeof resolveMemoryConfig>>,
) {
  const base = readRecord(provider.options) ?? {}
  const extra = readRecord(model.options) ?? {}
  const out: Record<string, unknown> = { ...base, ...extra }
  if (out.name === undefined) {
    out.name = provider.id
  }
  const baseUrl = resolveBaseUrl(provider, model, cfg)
  if (baseUrl && out.baseURL === undefined) {
    out.baseURL = baseUrl
  }
  const apiKey = readString(provider.key) ?? readString(provider.options?.apiKey) ?? cfg.flush.apiKey
  if (apiKey && out.apiKey === undefined) {
    out.apiKey = apiKey
  }
  const baseHeaders = readStringMap(provider.options?.headers) ?? {}
  const modelHeaders = readStringMap(model.headers) ?? {}
  const headers = { ...baseHeaders, ...modelHeaders, ...cfg.flush.headers }
  if (Object.keys(headers).length > 0) {
    out.headers = headers
  }
  return out
}

async function resolveLanguage(target: FlushTarget): Promise<LanguageModel | null> {
  const mod = await import(target.npm).catch(() => null)
  const record = readRecord(mod)
  if (!record) {
    return null
  }
  const key = Object.keys(record).find((item) => item.startsWith("create"))
  if (!key) {
    return null
  }
  const fn = record[key]
  if (!isFunction(fn)) {
    return null
  }
  const opt = { ...target.options }
  if (opt.name === undefined) {
    opt.name = target.provider.id
  }
  const sdk = fn(opt)
  const sdkRecord = readRecord(sdk)
  if (!sdkRecord) {
    return null
  }
  const modelFn = sdkRecord.languageModel
  if (!isFunction(modelFn)) {
    return null
  }
  const language = await Promise.resolve()
    .then(() => modelFn(target.apiID))
    .catch(() => null)
  if (!language) {
    return null
  }
  return language as LanguageModel
}

function buildCandidates(
  cfg: Awaited<ReturnType<typeof resolveMemoryConfig>>,
  mainModel: string | undefined,
) {
  const items: ModelRef[] = []
  const model = readString(cfg.flush.model)
  if (model) {
    const parsed = parseModelRef(model)
    if (parsed) {
      items.push(parsed)
    }
    if (!parsed && cfg.flush.provider) {
      items.push({ providerID: cfg.flush.provider, modelID: model })
    }
    if (!parsed && !cfg.flush.provider) {
      const main = mainModel ? parseModelRef(mainModel) : null
      if (main) {
        items.push({ providerID: main.providerID, modelID: model })
      }
    }
    return items
  }
  const main = mainModel ? parseModelRef(mainModel) : null
  if (main) {
    items.push(main)
  }
  return items
}

function pickCandidate(providers: ProviderEntry[], refs: ModelRef[]) {
  const match = refs
    .map((ref) => {
      const provider = providers.find((item) => item.id === ref.providerID)
      const model = provider?.models?.[ref.modelID]
      if (!provider || !model) {
        return null
      }
      return { ref, provider, model }
    })
    .find((entry) => entry)
  if (!match) {
    return null
  }
  return match
}

function resolveBaseUrl(
  provider: ProviderEntry,
  model: ModelEntry,
  cfg: Awaited<ReturnType<typeof resolveMemoryConfig>>,
) {
  const baseUrl = readString(provider.options?.baseURL) ?? readString(provider.options?.baseUrl)
  if (baseUrl) {
    return baseUrl
  }
  const api = readRecord(model.api)
  const apiUrl = readString(api?.url)
  if (apiUrl) {
    return apiUrl
  }
  if (provider.id === "openai") {
    return "https://api.openai.com/v1"
  }
  return cfg.flush.baseUrl
}

async function getConfigSnapshot(client: Parameters<Plugin>[0]["client"]) {
  if (CONFIG_CACHE && Date.now() - CONFIG_CACHE.at < CONFIG_TTL_MS) {
    return CONFIG_CACHE.snapshot
  }
  const [configRes, providerRes] = await Promise.all([
    client.config.get({ responseStyle: "data" }).catch(() => null),
    client.provider.list({ responseStyle: "data" }).catch(() => null),
  ])
  const config = readRecord(configRes) ?? {}
  const all = providerRes && typeof providerRes === "object" && "all" in providerRes ? (providerRes as { all: ProviderEntry[] }).all : undefined
  const providers = Array.isArray(all) ? all : []
  const snapshot = {
    model: readString(config.model),
    providers,
  }
  CONFIG_CACHE = { at: Date.now(), snapshot }
  return snapshot
}

function parseModelRef(value: string) {
  const raw = value.trim()
  if (!raw) {
    return null
  }
  const slash = raw.indexOf("/")
  if (slash > 0) {
    const providerID = raw.slice(0, slash).trim()
    const modelID = raw.slice(slash + 1).trim()
    if (!providerID || !modelID) {
      return null
    }
    return { providerID, modelID }
  }
  const colon = raw.indexOf(":")
  if (colon > 0) {
    const providerID = raw.slice(0, colon).trim()
    const modelID = raw.slice(colon + 1).trim()
    if (!providerID || !modelID) {
      return null
    }
    return { providerID, modelID }
  }
  return null
}


function parseNotes(text: string): MemoryNotes | null {
  if (text.includes("NO_MEMORY")) {
    return { longTerm: [], daily: [] }
  }
  const json = extractJson(text)
  if (!json) {
    return null
  }
  const parsed = parseJson(json)
  if (!parsed) {
    return null
  }
  const longTerm = readStringArray(parsed.longTerm) ?? []
  const daily = readStringArray(parsed.daily) ?? []
  return { longTerm, daily }
}

function extractJson(text: string) {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end <= start) {
    return null
  }
  return text.slice(start, end + 1)
}

function parseJson(text: string) {
  try {
    const value = JSON.parse(text) as unknown
    if (!value || typeof value !== "object") {
      return null
    }
    return value as Record<string, unknown>
  } catch {
    return null
  }
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

function readString(value: unknown) {
  if (typeof value !== "string") {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function isFunction(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === "function"
}

function readStringMap(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== "string") {
      continue
    }
    out[key] = entry
  }
  return out
}

function readRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}

function uniqueNotes(items: string[], limit: number) {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of items) {
    const trimmed = item.trim()
    if (!trimmed) {
      continue
    }
    const key = trimmed.toLowerCase()
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    out.push(trimmed)
    if (out.length >= limit) {
      break
    }
  }
  return out
}

