import type { Plugin } from "@opencode-ai/plugin"
import { daily, long, read, root, today, yesterday } from "../memory/lib"

const seen = new Map<string, string>()
const running = new Set<string>()

function stamp() {
  return new Date().toLocaleString("sv-SE", { timeZoneName: "short" })
}

function lines(parts: Array<{ type: string; text?: string }>) {
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text?.trim())
    .filter((text): text is string => !!text)
    .join("\n")
    .trim()
}

function transcript(items: Array<{ info: { role: string }; parts: Array<{ type: string; text?: string }> }>) {
  const rows = items
    .filter((item) => item.info.role === "user" || item.info.role === "assistant")
    .map((item) => {
      const text = lines(item.parts)
      if (!text) return null
      const role = item.info.role === "user" ? "User" : "Assistant"
      return `${role}:\n${text}`
    })
    .filter((item): item is string => !!item)
  if (!rows.length) return ""
  return rows.join("\n\n")
}

export const MemoryPlugin: Plugin = async ({ worktree, client }) => {
  const base = root(worktree)

  return {
    "experimental.chat.system.transform": async (_input, output) => {
      output.system.push(`Current date/time: ${stamp()}`)
      const day = today()
      const prev = yesterday()
      const longText = await read(long(base))
      const dayText = await read(daily(base, day))
      const prevText = await read(daily(base, prev))
      const parts = [
        longText && `# Memory (long-term)\n${longText}`,
        dayText && `# Memory (${day})\n${dayText}`,
        prevText && `# Memory (${prev})\n${prevText}`,
      ].filter((item): item is string => !!item)
      if (!parts.length) return
      output.system.push(parts.join("\n\n"))
    },
    event: async ({ event }) => {
      if (event.type !== "session.idle") return
      const sessionID = event.properties.sessionID
      if (!sessionID) return
      if (running.has(sessionID)) return
      running.add(sessionID)
      try {
        const result = await client.session.messages({
          path: { id: sessionID },
          query: { limit: 20 },
        })
        const items = result.data ?? []
        if (!Array.isArray(items) || items.length === 0) return
        const last = [...items].reverse().find((item) => item.info.role === "user")
        if (!last) return
        if (last.info.agent === "assistant") return
        if (seen.get(sessionID) === last.info.id) return
        seen.set(sessionID, last.info.id)
        const slice = items.slice(-10)
        const log = transcript(slice)
        if (!log) return
        const day = today()
        const text = [
          "You are a personal assistant.",
          "Review the recent conversation and decide whether any durable memory should be saved.",
          `If needed, use the write tool to update memory/${day}.md and/or memory/MEMORY.md.`,
          "Use bullet points, keep entries short and factual, preserve existing content.",
          "If there is nothing to save, reply with: No memory to write",
          "",
          "Conversation:",
          log,
        ].join("\n")
        await client.session.prompt({
          path: { id: sessionID },
          body: {
            agent: "assistant",
            parts: [{ type: "text", text }],
          },
        })
      } finally {
        running.delete(sessionID)
      }
    },
  }
}
