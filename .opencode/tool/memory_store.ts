import { tool } from "@opencode-ai/plugin"
import { appendMemory, resolveMemoryConfig } from "../lib/memory"

export default tool({
  description: "Store a memory note in long-term or daily memory.",
  args: {
    text: tool.schema.string().describe("Memory text to store"),
    target: tool.schema
      .enum(["daily", "longTerm"])
      .optional()
      .describe("Write target (daily or longTerm)"),
  },
  async execute(args, context) {
    const cfg = await resolveMemoryConfig(context.worktree)
    const result = await appendMemory({
      cfg,
      target: args.target ?? "daily",
      items: [args.text],
    }).catch((err) => ({
      path: "",
      added: [] as string[],
      error: formatError(err),
    }))
    context.metadata({ title: "Memory Store", metadata: { path: result.path } })
    return JSON.stringify(result)
  },
})

function formatError(err: unknown) {
  if (err instanceof Error) {
    return err.message
  }
  return String(err)
}
