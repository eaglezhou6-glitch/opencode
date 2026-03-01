# OpenCode Scheduler Plugin (Design)

## Summary

Design a scheduling plugin for OpenCode that provides cron/interval/one-shot jobs
without modifying core OpenCode code. The plugin is loaded via a compiled JS entry
configured in `.opencode/opencode.jsonc`, and exposes tools for creating and
managing jobs. The design aligns with OpenClaw's cron subsystem (job store,
schedule kinds, main vs isolated execution, delivery, run logs, and backoff).

## Goals

- Provide a scheduler with three schedule kinds: `at`, `every`, `cron`.
- Support two execution targets: `main` (system-event style) and `isolated`
  (fresh session per run).
- Expose tools for job CRUD, run history, and on-demand execution.
- Persist jobs and run logs on disk.
- Implement rate limits, concurrency caps, and error backoff.
- Load via plugin config (compiled JS), no OpenCode core changes.

## Non-Goals

- No modifications to OpenCode core runtime or UI.
- No bundled database; default storage is JSON + JSONL files.
- No server-side UI for job management.

## Constraints

- Plugin only; must not modify OpenCode source code.
- Must be loadable by config:
  `.opencode/opencode.jsonc -> plugin: ["./plugin/scheduler/dist/index.js"]`.
- Default to ASCII content for project documentation.

## References (OpenClaw)

Key areas to mirror from OpenClaw:

- Job schedules: `at`, `every`, `cron` (cron expr + timezone + stagger).
- Job store: `~/.openclaw/cron/jobs.json`.
- Run log: `~/.openclaw/cron/runs/<jobId>.jsonl`.
- Execution modes: main session vs isolated session.
- Delivery modes: announce, webhook, none.
- Error backoff and one-shot disable.

## Architecture Overview

```
Scheduler Plugin
├─ Scheduler loop (tick + due computation)
├─ Job store (JSON, versioned)
├─ Run log (JSONL)
├─ Executor
│  ├─ main session (system-event style)
│  └─ isolated session (agent turn)
├─ Delivery
│  ├─ announce (session message)
│  └─ webhook (HTTP POST)
└─ Tools (CRUD + run + status)
```

## Data Model

### Schedule

```
schedule.kind = "at" | "every" | "cron"
```

- `at`: ISO-8601 timestamp
- `every`: interval in milliseconds
- `cron`: 5-field or 6-field cron expression
- `tz`: optional timezone (IANA)
- `staggerMs`: optional deterministic stagger window

### Job

```json
{
  "id": "job-123",
  "name": "Morning brief",
  "enabled": true,
  "schedule": { "kind": "cron", "expr": "0 7 * * *", "tz": "Asia/Shanghai" },
  "sessionTarget": "isolated",
  "wakeMode": "now",
  "payload": { "kind": "agentTurn", "message": "Summarize the day." },
  "delivery": { "mode": "announce", "channel": "last" },
  "state": {
    "nextRunAtMs": 0,
    "lastRunAtMs": 0,
    "lastRunStatus": "ok",
    "consecutiveErrors": 0
  }
}
```

### Run Log

```
~/.config/.opencode/scheduler/runs/<jobId>.jsonl
```

Each line:

```json
{
  "jobId": "job-123",
  "status": "ok|error|skipped",
  "startedAt": 1700000000000,
  "endedAt": 1700000009999,
  "error": "optional",
  "summary": "optional"
}
```

## Execution Modes

### Main Session (system-event style)

- The plugin injects a system event into the main session.
- `wakeMode` determines immediate or next-heartbeat behavior.
- Best for reminders that need full context.

### Isolated Session (agent turn)

- Each run uses a fresh session key:
  `cron:<jobId>:run:<uuid>`.
- Optional model/thinking overrides.
- Default delivery is `announce`.

## Delivery

### announce

- Deliver summary/output to the target session/channel.
- If `channel` or `to` missing, fall back to "last route".

### webhook

- POST run result to the configured URL.

### none

- No delivery; internal run only.

## Backoff and Concurrency

- `maxConcurrentRuns` (default 1).
- Exponential backoff for recurring jobs:
  30s, 1m, 5m, 15m, 60m.
- One-shot jobs disable after any terminal result.

## Plugin Configuration

`~/.config/.opencode/scheduler.jsonc`

```jsonc
{
  "scheduler": {
    "enabled": true,
    "root": "~/.config/.opencode/scheduler",
    "timezone": "Asia/Shanghai",
    "tickMs": 1000,
    "maxConcurrentRuns": 1,
    "defaultWakeMode": "now",
    "defaultDelivery": { "mode": "announce", "channel": "last" },
    "sessionRetention": "24h",
    "runLog": { "maxBytes": 2000000, "keepLines": 2000 }
  }
}
```

## Tools API (LLM)

Tools mirror OpenClaw:

- `schedule_add`
- `schedule_update`
- `schedule_list`
- `schedule_remove`
- `schedule_run`
- `schedule_runs`
- `schedule_status`
- `schedule_wake`

Input shapes follow the job model above, with runtime validation
and normalization.

## Plugin Loading

`.opencode/opencode.jsonc`:

```jsonc
{
  "plugin": [
    "./plugin/compaction-limit/src/index.ts",
    "./plugin/scheduler/dist/index.js"
  ]
}
```

## Security and Safety

- Validate cron expressions and timestamps.
- Validate webhook URLs (http/https).
- Apply timeouts to job execution.
- Guard against rapid re-trigger loops.

## Testing Strategy

- Unit tests for schedule calculation and stagger.
- Store load/save with migration tests.
- Execution tests for main and isolated modes.
- Delivery tests (announce and webhook).

## Rollout Plan

1. Implement job store + scheduler tick.
2. Add execution for main session.
3. Add isolated session execution.
4. Add delivery modes and run logs.
5. Add tools.
6. Add docs and examples.

## Open Questions

- Exact integration with OpenCode session API for system events.
- Preferred default delivery behavior for isolated jobs.
- Whether to expose model/thinking overrides in tools by default.
