// Type shims for editing this plugin in-worktree.
// The OpenCode runtime executes plugins in Bun, but this directory is not always
// covered by the workspace TypeScript config, so editor diagnostics may miss
// Bun/Node module types.

declare const Bun: any

declare module "fs/promises" {
  const mod: any
  export = mod
}

declare module "path" {
  const mod: any
  export = mod
}

declare module "ai" {
  export const generateText: any
}

