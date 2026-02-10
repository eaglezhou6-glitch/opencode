# Memory Plugin (OpenCode)

This plugin implements OpenClaw-style memory and compaction limits for OpenCode
without modifying core source code.

## Layout

- `src/memory.ts` — memory storage + indexing (remote embeddings).
- `src/compaction.ts` — compaction limits, session snapshot, tool-output trigger.
- `src/plugin.ts` — plugin hooks (recall, flush, compaction limit + snapshot).
- `../memory.ts` — plugin entrypoint (loader target).

## Compaction (merged from compaction-limit)

- **Session snapshot**: Before compaction, appends the current conversation to
  `memory/YYYY-MM-DD.md` under the worktree root. Consider adding `memory/` to
  `.gitignore`.
- **Limit on summary**: Injects a token limit into the compaction prompt and
  truncates compaction output so the summary stays within the model’s context.
- **Tool output trigger**: When tool output is large or context would exceed the
  limit, triggers compaction (with cooldown).

Limits are derived from the active model; optional env overrides:

- `OPENCODE_COMPACTION_MAX_TOKENS` — hard cap
- `OPENCODE_COMPACTION_RESERVE_TOKENS` — reserved tokens to subtract
- `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX` — global output cap (default 32000)
- `OPENCODE_TOOL_OUTPUT_COMPACT_TOKENS` — trigger threshold for tool output
- `OPENCODE_TOOL_OUTPUT_COMPACT_COOLDOWN_MS` — min time between triggers (default 60000)

## Config

Memory settings live in `.opencode/memory.jsonc`. By default memory files are
stored under:

```
~/.config/.opencode/MEMORY.md
~/.config/.opencode/memory/<session_id>-YYYY-MM-DD.md
```

## Tools

Custom tools are defined in `.opencode/tool/`:

- `memory_search`
- `memory_get`
- `memory_store`
