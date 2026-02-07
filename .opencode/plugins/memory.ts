import type { Plugin } from "@opencode-ai/plugin"
import { daily, long, read, root, today, yesterday } from "../memory/lib"

export const MemoryPlugin: Plugin = async ({ worktree }) => {
  const base = root(worktree)

  return {
    "experimental.chat.system.transform": async (_input, output) => {
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
  }
}
