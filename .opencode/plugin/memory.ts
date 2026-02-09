import type { Plugin } from "@opencode-ai/plugin"
import { appendMemory, resolveMemoryConfig, searchMemory } from "../lib/memory"

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

const RECALL_TTL_MS = 5 * 60 * 1000
const RECALL_CACHE = new Map<string, RecallEntry>()

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

      const notes = await resolveNotes(cfg, transcript, log)
      if (!notes) {
        return
      }

      const longTerm = uniqueNotes(notes.longTerm, cfg.flush.maxItems)
      const daily = uniqueNotes(notes.daily, cfg.flush.maxItems)
      if (longTerm.length === 0 && daily.length === 0) {
        return
      }

      if (longTerm.length > 0) {
        await appendMemory({ cfg, target: "longTerm", items: longTerm }).catch(() => {})
      }
      if (daily.length > 0) {
        await appendMemory({ cfg, target: "daily", items: daily }).catch(() => {})
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
) {
  if (cfg.flush.mode === "heuristic") {
    return extractHeuristic(transcript)
  }
  const llm = await extractWithLlm(cfg, transcript).catch(() => null)
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

async function extractWithLlm(cfg: Awaited<ReturnType<typeof resolveMemoryConfig>>, transcript: string) {
  const apiKey = cfg.flush.apiKey
  if (!apiKey) {
    return null
  }
  const url = `${cfg.flush.baseUrl.replace(/\/+$/, "")}/chat/completions`
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    ...cfg.flush.headers,
  }
  const body = {
    model: cfg.flush.model,
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
