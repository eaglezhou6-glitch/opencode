# Memory workspace

This folder stores long-term memory for the personal assistant and the main
session loader.

## Files

- `MEMORY.md` keeps durable, long-term notes.
- `YYYY-MM-DD.md` stores daily notes extracted from sessions.
- `index.sqlite` is the hybrid search index (auto-generated).

## Loading

The memory plugin injects:

- `MEMORY.md` (long-term)
- Today and yesterday's daily files

into the system prompt at session start.

The personal assistant also writes new entries after sessions finish.

## Tools

- `memory_search` for hybrid retrieval

## Monitor process

Run the watcher to keep the SQLite index in sync with markdown updates:

```bash
bun .opencode/memory/watch.ts
```

For a one-off rebuild:

```bash
bun .opencode/memory/watch.ts --once
```

## Environment

- `MEMORY_ROOT`: override the memory workspace path (default: `./memory`)
- `MEMORY_DB`: override the SQLite path (default: `<MEMORY_ROOT>/index.sqlite`)
- `MEMORY_CHUNK_SIZE`: chunk size in tokens (default: `400`)
- `MEMORY_CHUNK_OVERLAP`: overlap in tokens (default: `80`)
- `MEMORY_EMBED_DIM`: embedding dimension (default: `384`)
- `MEMORY_HYBRID_ALPHA`: vector weight for hybrid search (default: `0.6`)
