# Memory Plugin (OpenCode)

This plugin implements OpenClaw-style memory for OpenCode without modifying
core source code.

## Layout

- `src/memory.ts` — memory storage + indexing (remote embeddings).
- `src/plugin.ts` — plugin hooks (recall + compaction flush).
- `../memory.ts` — plugin entrypoint (loader target).

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
