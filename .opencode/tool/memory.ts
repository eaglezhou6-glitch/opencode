import path from "path"
import fs from "fs/promises"
import { existsSync } from "fs"
import { tool } from "@opencode-ai/plugin"
import {
  dbPath,
  daily,
  indexAll,
  indexFile,
  long,
  open,
  root,
  search as find,
  today,
} from "../memory/lib"

const baseAlpha = Number.parseFloat(process.env.MEMORY_HYBRID_ALPHA ?? "0.6")
const alpha = Number.isFinite(baseAlpha) ? baseAlpha : 0.6

export const search = tool({
  description: "Hybrid semantic + keyword search over memory notes",
  args: {
    query: tool.schema.string().describe("Search query"),
    limit: tool.schema.number().describe("Max results").default(8),
    alpha: tool.schema.number().describe("Vector weight (0-1)").default(alpha),
  },
  async execute(args, context) {
    const base = root(context.worktree)
    const file = dbPath(base)
    if (!existsSync(file)) {
      return `No memory index found. Run memory_index or the watcher first.`
    }
    const db = open(file)
    const hits = find(db, args.query, { limit: args.limit, alpha: args.alpha })
    db.close()
    if (!hits.length) return "No memory matches."
    const rows = hits.map((hit, idx) => {
      const rel = path.relative(context.worktree, hit.file)
      const text = hit.text.replace(/\s+/g, " ").trim()
      const snippet = text.length > 240 ? `${text.slice(0, 240)}...` : text
      return [
        `${idx + 1}. ${rel} (lines ${hit.lineStart}-${hit.lineEnd}, score ${hit.score.toFixed(3)})`,
        `   ${snippet}`,
      ].join("\n")
    })
    return `Found ${hits.length} matches:\n\n${rows.join("\n\n")}`
  },
})

export const write = tool({
  description: "Append memory notes to daily or long-term files",
  args: {
    text: tool.schema.string().describe("Memory content to store"),
    kind: tool.schema.enum(["daily", "long"]).default("daily"),
    date: tool.schema.string().describe("Daily note date (YYYY-MM-DD)").optional(),
    index: tool.schema.boolean().describe("Reindex after write").default(true),
  },
  async execute(args, context) {
    const note = args.text.trim()
    if (!note) return "No memory written."
    const base = root(context.worktree)
    await fs.mkdir(base, { recursive: true })
    const day = args.kind === "daily" ? args.date ?? today() : today()
    const file = args.kind === "long" ? long(base) : daily(base, day)
    const head = args.kind === "long" ? "# Memory" : `# ${day}`
    const prefix = existsSync(file) ? "\n" : `${head}\n\n`
    await fs.appendFile(file, `${prefix}- ${note}\n`)
    if (args.index && existsSync(dbPath(base))) {
      const db = open(dbPath(base))
      await indexFile(db, file)
      db.close()
    }
    return `Saved to ${path.relative(context.worktree, file)}`
  },
})

export const index = tool({
  description: "Rebuild the memory index for all markdown files",
  args: {},
  async execute(_args, context) {
    const base = root(context.worktree)
    await fs.mkdir(base, { recursive: true })
    const db = open(dbPath(base))
    const stats = await indexAll(db, base)
    db.close()
    return `Indexed ${stats.files} files (${stats.chunks} chunks).`
  },
})
