import { tool } from "@opencode-ai/plugin"
import { readMemoryFile, resolveMemoryConfig } from "../plugin/memory/src/memory"

export default tool({
  description: "Read a memory file by path with optional line ranges.",
  args: {
    path: tool.schema.string().describe("Memory file path"),
    from: tool.schema.number().int().optional().describe("Start line (1-based)"),
    lines: tool.schema.number().int().optional().describe("Number of lines"),
  },
  async execute(args, context) {
    const cfg = await resolveMemoryConfig(context.worktree)
    const result = await readMemoryFile({
      cfg,
      path: args.path,
      from: args.from,
      lines: args.lines,
    }).catch((err) => ({
      path: args.path,
      text: "",
      error: formatError(err),
    }))
    context.metadata({ title: "Memory Get", metadata: { path: result.path } })
    return JSON.stringify(result)
  },
})

function formatError(err: unknown) {
  if (err instanceof Error) {
    return err.message
  }
  return String(err)
}
