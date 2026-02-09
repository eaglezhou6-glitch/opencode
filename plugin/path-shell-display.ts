import type { Hooks, PluginInput } from "@opencode-ai/plugin"

/**
 * Converts Windows paths in text to Git Bash style (/c/Users/...) so the agent
 * sees paths that work in bash. Only runs on Windows; no-op otherwise.
 */
function toShellPath(s: string): string {
  if (process.platform !== "win32") return s
  return s
    .replace(/\b([A-Za-z]):[\\/]/g, (_, d) => `/${d.toLowerCase()}/`)
    .replace(/\\/g, "/")
}

export default (async (_input: PluginInput): Promise<Hooks> => ({
  "experimental.chat.system.transform": async (_input, output) => {
    for (let i = 0; i < output.system.length; i++) {
      output.system[i] = toShellPath(output.system[i])
    }
  },
}))
