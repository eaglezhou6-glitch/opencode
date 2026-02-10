import type { Plugin } from "@opencode-ai/plugin"
import { appendMemory, resolveMemoryConfig, searchMemory } from "./memory"

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

type ProviderEntry = {
  id: string
  key?: string
  options?: Record<string, unknown>
  models?: Record<string, { limit?: { context?: number } }>
}

type FlushOverride = {
  model: string
  baseUrl: string
  apiKey?: string
  headers?: Record<string, string>
}

const RECALL_TTL_MS = 5 * 60 * 1000
const RECALL_CACHE = new Map<string, RecallEntry>()
const CONFIG_TTL_MS = 60 * 1000
let CONFIG_CACHE: { at: number; config: Record<string, unknown>; providers: ProviderEntry[] } | null =
  null

export const MemoryPlugin: Plugin = async ({ client, worktree }) => {
  const log = (level: "debug" | "info" | "warn" | "error", message: string, extra?: object) => {
    void client.app
      .log({
        body: {
          service: "memory",
          level,
          message,
          extra,
        },
      })
      .catch(() => {})
  }

  return {
    "chat.message": async (input, output) => {
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
    "experimental.text.complete": async (input, output) => {
      if (!input.sessionID) {
        return
      }
      const info = await fetchMessageInfo(client, input.sessionID, input.messageID).catch(() => null)
      if (!info) {
        return
      }
      if (info.role !== "assistant") {
        return
      }
      if (info.agent !== "compaction" && info.mode !== "compaction") {
        return
      }
      if (!info.providerID || !info.modelID) {
        return
      }
      const cfg = await resolveMemoryConfig(worktree)
      const limit = await resolveModelContextLimit(client, {
        providerID: info.providerID,
        modelID: info.modelID,
      })
      if (!limit) {
        return
      }
      const estimate = estimateTokens(output.text)
      if (estimate <= limit) {
        return
      }
      const notice = "\n\n【已截断】压缩结果超过上下文长度，关键信息已在记忆中保存。"
      const maxChars = Math.max(200, Math.floor(limit * 4))
      const reserved = Math.min(maxChars, notice.length)
      const bodyLimit = Math.max(0, maxChars - reserved)
      output.text = `${output.text.slice(0, bodyLimit).trimEnd()}${notice}`
    },
    "experimental.session.compacting": async (input) => {
      const cfg = await resolveMemoryConfig(worktree)
      if (!cfg.flush.enabled) {
        return
      }

      const res = await client.session.messages({
        path: { id: input.sessionID },
        query: { limit: cfg.flush.maxMessages },
      })
      const data = Array.isArray(res.data) ? (res.data as MessageEntry[]) : []
      if (data.length === 0) {
        return
      }

      const transcript = buildTranscript(data, cfg.flush.maxMessages)
      if (!transcript) {
        return
      }

      const override = cfg.flush.useCompactionModel
        ? await resolveFlushOverride(client, data, log)
        : null
      const notes = await resolveNotes(cfg, transcript, log, override)
      if (!notes) {
        return
      }

      const longTerm = uniqueNotes(notes.longTerm, cfg.flush.maxItems)
      const daily = uniqueNotes(notes.daily, cfg.flush.maxItems)
      if (longTerm.length === 0 && daily.length === 0) {
        return
      }

      if (longTerm.length > 0) {
        await appendMemory({
          cfg,
          target: "longTerm",
          items: longTerm,
          sessionID: input.sessionID,
        }).catch(() => {})
      }
      if (daily.length > 0) {
        await appendMemory({
          cfg,
          target: "daily",
          items: daily,
          sessionID: input.sessionID,
        }).catch(() => {})
      }

      log("info", "memory flush wrote notes", {
        sessionID: input.sessionID,
        longTerm: longTerm.length,
        daily: daily.length,
      })
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
  cfg: Awaited<ReturnType<typeof resolveMemoryConfig>>,
  transcript: string,
  log: (level: "debug" | "info" | "warn" | "error", message: string, extra?: object) => void,
  override?: FlushOverride | null,
) {
  if (cfg.flush.mode === "heuristic") {
    return extractHeuristic(transcript)
  }
  if (cfg.flush.useCompactionModel && !override) {
    log("warn", "memory flush compaction model unavailable, falling back to heuristics")
    return extractHeuristic(transcript)
  }
  const llm = await extractWithLlm(cfg, transcript, override ?? undefined).catch(() => null)
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
  cfg: Awaited<ReturnType<typeof resolveMemoryConfig>>,
  transcript: string,
  override?: FlushOverride,
) {
  const apiKey = override?.apiKey ?? cfg.flush.apiKey
  if (!apiKey) {
    return null
  }
  const baseUrl = (override?.baseUrl ?? cfg.flush.baseUrl).replace(/\/+$/, "")
  if (!baseUrl) {
    return null
  }
  const url = `${baseUrl}/chat/completions`
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    ...cfg.flush.headers,
    ...(override?.headers ?? {}),
  }
  const body = {
    model: override?.model ?? cfg.flush.model,
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
  const notes = parseNotes(content)
  return notes
}

async function resolveFlushOverride(
  client: {
    config: {
      get: (input?: any) => Promise<{ data?: Record<string, unknown> }>
      providers: (input?: any) => Promise<{ data?: { providers?: ProviderEntry[] } }>
    }
  },
  entries: MessageEntry[],
  log: (level: "debug" | "info" | "warn" | "error", message: string, extra?: object) => void,
) {
  const snapshot = await getConfigSnapshot(client).catch(() => null)
  if (!snapshot) {
    return null
  }
  const compactionModel = resolveCompactionModel(snapshot.config, entries)
  if (!compactionModel) {
    return null
  }
  const provider = snapshot.providers.find((entry) => entry.id === compactionModel.providerID)
  const baseUrl =
    readString(provider?.options?.baseURL) ??
    readString(provider?.options?.baseUrl) ??
    (compactionModel.providerID === "openai" ? "https://api.openai.com/v1" : "")
  const apiKey = provider?.key
  if (!baseUrl || !apiKey) {
    log("warn", "memory flush compaction model not usable, missing baseUrl/apiKey", {
      providerID: compactionModel.providerID,
    })
    return null
  }
  const headers = readStringMap(provider?.options?.headers) ?? {}
  return {
    model: compactionModel.modelID,
    baseUrl,
    apiKey,
    headers,
  }
}

async function getConfigSnapshot(client: {
  config: {
    get: (input?: any) => Promise<{ data?: Record<string, unknown> }>
    providers: (input?: any) => Promise<{ data?: { providers?: ProviderEntry[] } }>
  }
}) {
  if (CONFIG_CACHE && Date.now() - CONFIG_CACHE.at < CONFIG_TTL_MS) {
    return CONFIG_CACHE
  }
  const [configRes, providersRes] = await Promise.all([
    client.config.get({ responseStyle: "data" }),
    client.config.providers({ responseStyle: "data" }),
  ])
  const config = (configRes as { data?: Record<string, unknown> }).data ?? {}
  const providers = (providersRes as { data?: { providers?: ProviderEntry[] } }).data?.providers ?? []
  CONFIG_CACHE = { at: Date.now(), config, providers }
  return CONFIG_CACHE
}

function resolveCompactionModel(config: Record<string, unknown>, entries: MessageEntry[]): ModelRef | null {
  const agent = readRecord(config.agent)
  const compaction = agent ? readRecord(agent.compaction) : null
  const compactionModel = compaction ? readString(compaction.model) : undefined
  if (compactionModel) {
    return parseModelRef(compactionModel)
  }
  const userModel = lastUserModel(entries)
  if (userModel) {
    return userModel
  }
  const defaultModel = readString(config.model)
  if (defaultModel) {
    return parseModelRef(defaultModel)
  }
  return null
}

function lastUserModel(entries: MessageEntry[]): ModelRef | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const info = entries[i]?.info as Record<string, unknown> | undefined
    if (!info || info.role !== "user") {
      continue
    }
    const model = readRecord(info.model)
    const providerID = model ? readString(model.providerID) : undefined
    const modelID = model ? readString(model.modelID) : undefined
    if (providerID && modelID) {
      return { providerID, modelID }
    }
  }
  return null
}

function parseModelRef(model: string): ModelRef | null {
  const trimmed = model.trim()
  if (!trimmed) {
    return null
  }
  const parts = trimmed.split("/")
  if (parts.length < 2) {
    return null
  }
  const providerID = parts[0]
  const modelID = parts.slice(1).join("/")
  if (!providerID || !modelID) {
    return null
  }
  return { providerID, modelID }
}

async function fetchMessageInfo(
  client: {
    session: { message: (input: any) => Promise<{ data?: { info?: Record<string, unknown> } }> }
  },
  sessionID: string,
  messageID: string,
) {
  const res = await client.session.message({
    path: { id: sessionID, messageID },
    responseStyle: "data",
  })
  const info = (res as { data?: { info?: Record<string, unknown> } }).data?.info
  if (!info) {
    return null
  }
  return info as {
    role?: string
    agent?: string
    mode?: string
    providerID?: string
    modelID?: string
  }
}

async function resolveModelContextLimit(
  client: {
    config: {
      get: (input?: any) => Promise<{ data?: Record<string, unknown> }>
      providers: (input?: any) => Promise<{ data?: { providers?: ProviderEntry[] } }>
    }
  },
  ref: ModelRef,
) {
  const snapshot = await getConfigSnapshot(client).catch(() => null)
  if (!snapshot) {
    return null
  }
  const provider = snapshot.providers.find((entry) => entry.id === ref.providerID)
  const model = provider?.models?.[ref.modelID]
  const limit = model?.limit?.context
  if (typeof limit === "number" && limit > 0) {
    return limit
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

function estimateTokens(text: string) {
  if (!text) {
    return 0
  }
  return Math.ceil(text.length / 4)
}
