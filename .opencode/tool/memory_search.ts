import { tool } from "@opencode-ai/plugin"
import { resolveMemoryConfig, searchMemory } from "../lib/memory"

export default tool({
  description:
    "Search memory files for relevant notes (MEMORY.md + ~/.config/.opencode/memory/*.md).",
  args: {
    query: tool.schema.string().describe("Search query"),
    maxResults: tool.schema.number().optional().describe("Max results"),
    minScore: tool.schema.number().optional().describe("Minimum cosine score"),
  },
  async execute(args, context) {
    const cfg = await resolveMemoryConfig(context.worktree)
    const result = await searchMemory({
      cfg,
      query: args.query,
      maxResults: args.maxResults,
      minScore: args.minScore,
    }).catch((err) => ({
      results: [],
      provider: cfg.embedding.provider,
      model: cfg.embedding.model,
      error: formatError(err),
    }))
    const count = Array.isArray(result.results) ? result.results.length : 0
    context.metadata({ title: "Memory Search", metadata: { count } })
    return JSON.stringify(result)
  },
})

function formatError(err: unknown) {
  if (err instanceof Error) {
    return err.message
  }
  return String(err)
}
