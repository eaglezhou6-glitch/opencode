# Compaction Limit Plugin

This plugin enforces a hard size limit for compaction summaries. It:

- Adds a length constraint to the compaction prompt.
- Truncates compaction output so the summary never exceeds the limit.

## Loading

This plugin is loaded from `.opencode/opencode.jsonc` via a file path:

```
./plugin/compaction-limit/src/index.ts
```

## Limits

The limit is derived from the active model:

- If the model exposes a `context` window, use `context - output_limit`.
- If `output_limit` is missing, use the full context.
- If the context is unknown, fall back to `32_000`.

Optional environment overrides:

- `OPENCODE_COMPACTION_MAX_TOKENS` (hard cap, applied first)
- `OPENCODE_COMPACTION_RESERVE_TOKENS` (reserved tokens to subtract)
- `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX` (global output cap, default 32000)

## Notes

Token limits are estimated using `4 chars ~= 1 token`, matching core logic.
