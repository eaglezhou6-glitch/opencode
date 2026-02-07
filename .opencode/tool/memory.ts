import path from "path"
import { existsSync } from "fs"
import { tool } from "@opencode-ai/plugin"
import { dbPath, open, root, search as find } from "../memory/lib"

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
    if (!existsSync(file)) return `No memory index found. Run the watcher first.`
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
