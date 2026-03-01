import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { randomUUID } from "crypto"

type Schedule =
  | { kind: "at"; at: string }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; expr: string; tz?: string; staggerMs?: number }

type Delivery = { mode: "none" | "webhook"; to?: string; headers?: Record<string, string> }

type Payload =
  | { kind: "chat"; message: string }
  | { kind: "tool"; tool: string; args?: unknown; summary?: boolean }

type JobState = {
  nextRunAtMs?: number
  runningAtMs?: number
  lastRunAtMs?: number
  lastRunStatus?: "ok" | "error" | "skipped"
  lastError?: string
  lastDurationMs?: number
  consecutiveErrors?: number
}

type Job = {
  id: string
  name: string
  enabled: boolean
  schedule: Schedule
  payload: Payload
  delivery?: Delivery
  deleteAfterRun?: boolean
  agent?: string
  sessionID: string
  createdAtMs: number
  updatedAtMs: number
  state: JobState
}

type Store = { version: 1; jobs: Job[] }

type Config = {
  enabled: boolean
  root: string
  timezone: string
  tickMs: number
  maxConcurrentRuns: number
  defaultDelivery: Delivery
  runLog: { maxBytes: number; keepLines: number }
}

type RunResult = {
  status: "ok" | "error" | "skipped"
  error?: string
  summary?: string
  startedAt: number
  endedAt: number
}

type State = {
  cfg: Config
  store: Store
  lock: Promise<void>
  running: Set<string>
  active: number
  timer?: ReturnType<typeof setInterval>
}

const CONFIG_FILES = ["scheduler.jsonc", "scheduler.json"] as const
const CFG_TTL_MS = 10_000
const ERROR_BACKOFF_MS = [30_000, 60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000]
const MAX_LOOKAHEAD_MS = 366 * 24 * 60 * 60 * 1000

const DEFAULT_CONFIG: Config = {
  enabled: true,
  root: "~/.config/.opencode/scheduler",
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  tickMs: 1000,
  maxConcurrentRuns: 1,
  defaultDelivery: { mode: "none" },
  runLog: { maxBytes: 2_000_000, keepLines: 2000 },
}

export const SchedulerPlugin: Plugin = async (ctx) => {
  const log = (level: "debug" | "info" | "warn" | "error", message: string, extra?: object) => {
    void ctx.client.app
      .log({
        body: {
          service: "scheduler",
          level,
          message,
          extra,
        },
      })
      .catch(() => {})
  }

  const cfg = await resolveConfig(ctx.worktree)
  const store = await loadStore(cfg.root)
  const state: State = {
    cfg,
    store,
    lock: Promise.resolve(),
    running: new Set(),
    active: 0,
  }

  start(ctx, state, log)

  return {
    tool: {
      schedule_add: tool({
        description: "Create a scheduled job.",
        args: {
          name: tool.schema.string(),
          schedule: tool.schema.object({
            kind: tool.schema.enum(["at", "every", "cron"]),
            at: tool.schema.string().optional(),
            everyMs: tool.schema.number().optional(),
            anchorMs: tool.schema.number().optional(),
            expr: tool.schema.string().optional(),
            tz: tool.schema.string().optional(),
            staggerMs: tool.schema.number().optional(),
          }),
          payload: tool.schema.object({
            kind: tool.schema.enum(["chat", "tool"]),
            message: tool.schema.string().optional(),
            tool: tool.schema.string().optional(),
            args: tool.schema.any().optional(),
            summary: tool.schema.boolean().optional(),
          }),
          enabled: tool.schema.boolean().optional(),
          deleteAfterRun: tool.schema.boolean().optional(),
          agent: tool.schema.string().optional(),
          sessionID: tool.schema.string().optional(),
          delivery: tool.schema
            .object({
              mode: tool.schema.enum(["none", "webhook"]),
              to: tool.schema.string().optional(),
              headers: tool.schema.record(tool.schema.string()).optional(),
            })
            .optional(),
        },
        async execute(args, context) {
          const cfg = await resolveConfig(context.worktree)
          const store = await loadStore(cfg.root)
          const now = Date.now()
          const job = normalizeCreate(args, {
            now,
            sessionID: args.sessionID ?? context.sessionID,
            delivery: cfg.defaultDelivery,
            cfg,
          })
          if (!job) {
            return JSON.stringify({ ok: false, error: "invalid job payload" })
          }
          store.jobs.push(job)
          await saveStore(cfg.root, store)
          context.metadata({ title: "Schedule Add", metadata: { id: job.id } })
          return JSON.stringify({ ok: true, job })
        },
      }),
      schedule_update: tool({
        description: "Update an existing scheduled job.",
        args: {
          jobId: tool.schema.string(),
          name: tool.schema.string().optional(),
          enabled: tool.schema.boolean().optional(),
          deleteAfterRun: tool.schema.boolean().optional(),
          agent: tool.schema.string().optional(),
          schedule: tool.schema
            .object({
              kind: tool.schema.enum(["at", "every", "cron"]).optional(),
              at: tool.schema.string().optional(),
              everyMs: tool.schema.number().optional(),
              anchorMs: tool.schema.number().optional(),
              expr: tool.schema.string().optional(),
              tz: tool.schema.string().optional(),
              staggerMs: tool.schema.number().optional(),
            })
            .optional(),
          payload: tool.schema
            .object({
              kind: tool.schema.enum(["chat", "tool"]).optional(),
              message: tool.schema.string().optional(),
              tool: tool.schema.string().optional(),
              args: tool.schema.any().optional(),
              summary: tool.schema.boolean().optional(),
            })
            .optional(),
          delivery: tool.schema
            .object({
              mode: tool.schema.enum(["none", "webhook"]).optional(),
              to: tool.schema.string().optional(),
              headers: tool.schema.record(tool.schema.string()).optional(),
            })
            .optional(),
        },
        async execute(args, context) {
          const cfg = await resolveConfig(context.worktree)
          const store = await loadStore(cfg.root)
          const job = store.jobs.find((item) => item.id === args.jobId)
          if (!job) {
            return JSON.stringify({ ok: false, error: "job not found" })
          }
          const now = Date.now()
          const next = normalizeUpdate(job, args, now)
          if (!next) {
            return JSON.stringify({ ok: false, error: "invalid update payload" })
          }
          await saveStore(cfg.root, store)
          context.metadata({ title: "Schedule Update", metadata: { id: job.id } })
          return JSON.stringify({ ok: true, job })
        },
      }),
      schedule_list: tool({
        description: "List scheduled jobs.",
        args: {
          includeDisabled: tool.schema.boolean().optional(),
          limit: tool.schema.number().optional(),
          offset: tool.schema.number().optional(),
        },
        async execute(args, context) {
          const cfg = await resolveConfig(context.worktree)
          const store = await loadStore(cfg.root)
          const filtered = args.includeDisabled
            ? store.jobs
            : store.jobs.filter((job) => job.enabled)
          const offset = clampInt(args.offset ?? 0, 0, filtered.length)
          const limit = clampInt(args.limit ?? filtered.length, 0, filtered.length)
          const items = filtered.slice(offset, offset + limit)
          context.metadata({ title: "Schedule List", metadata: { count: items.length } })
          return JSON.stringify({ ok: true, jobs: items })
        },
      }),
      schedule_remove: tool({
        description: "Remove a scheduled job.",
        args: {
          jobId: tool.schema.string(),
        },
        async execute(args, context) {
          const cfg = await resolveConfig(context.worktree)
          const store = await loadStore(cfg.root)
          const next = store.jobs.filter((item) => item.id !== args.jobId)
          if (next.length === store.jobs.length) {
            return JSON.stringify({ ok: false, error: "job not found" })
          }
          store.jobs = next
          await saveStore(cfg.root, store)
          context.metadata({ title: "Schedule Remove", metadata: { id: args.jobId } })
          return JSON.stringify({ ok: true })
        },
      }),
      schedule_run: tool({
        description: "Run a scheduled job immediately.",
        args: {
          jobId: tool.schema.string(),
          mode: tool.schema.enum(["force", "due"]).optional(),
        },
        async execute(args, context) {
          const cfg = await resolveConfig(context.worktree)
          const store = await loadStore(cfg.root)
          const job = store.jobs.find((item) => item.id === args.jobId)
          if (!job) {
            return JSON.stringify({ ok: false, error: "job not found" })
          }
          const now = Date.now()
          const due = (job.state.nextRunAtMs ?? 0) <= now
          if (args.mode === "due" && !due) {
            return JSON.stringify({ ok: true, status: "skipped" })
          }
          const result = await runJob(ctx, cfg, job, log)
          applyResult(job, result, now, cfg)
          await saveStore(cfg.root, store)
          return JSON.stringify({ ok: true, result })
        },
      }),
      schedule_runs: tool({
        description: "Read run log entries for a job.",
        args: {
          jobId: tool.schema.string(),
          limit: tool.schema.number().optional(),
        },
        async execute(args, context) {
          const cfg = await resolveConfig(context.worktree)
          const file = runLogPath(cfg.root, args.jobId)
          const text = await Bun.file(file).text().catch(() => "")
          const lines = text.split("\n").filter(Boolean)
          const limit = clampInt(args.limit ?? lines.length, 0, lines.length)
          const slice = lines.slice(Math.max(0, lines.length - limit))
          return JSON.stringify({ ok: true, lines: slice })
        },
      }),
      schedule_status: tool({
        description: "Return scheduler status.",
        args: {},
        async execute(_args, context) {
          const cfg = await resolveConfig(context.worktree)
          const store = await loadStore(cfg.root)
          const now = Date.now()
          const next = store.jobs
            .map((job) => job.state.nextRunAtMs ?? 0)
            .filter((value) => value > now)
            .sort((a, b) => a - b)[0]
          return JSON.stringify({
            ok: true,
            enabled: cfg.enabled,
            jobs: store.jobs.length,
            nextRunAtMs: next ?? null,
          })
        },
      }),
    },
  }
}

function start(
  ctx: Parameters<Plugin>[0],
  state: State,
  log: (level: "debug" | "info" | "warn" | "error", message: string, extra?: object) => void,
) {
  if (state.timer) {
    return
  }
  state.timer = setInterval(() => {
    void tick(ctx, state, log)
  }, Math.max(200, state.cfg.tickMs))
}

async function tick(
  ctx: Parameters<Plugin>[0],
  state: State,
  log: (level: "debug" | "info" | "warn" | "error", message: string, extra?: object) => void,
) {
  const cfg = await resolveConfig(ctx.worktree, state.cfg)
  state.cfg = cfg
  if (!cfg.enabled) {
    return
  }
  const store = await loadStore(cfg.root, state.store)
  state.store = store
  const now = Date.now()
  for (const job of store.jobs) {
    if (!job.enabled) {
      continue
    }
    if (!job.state || typeof job.state !== "object") {
      job.state = {}
    }
    if (job.state.consecutiveErrors === undefined) {
      job.state.consecutiveErrors = 0
    }
    if (!job.sessionID) {
      continue
    }
    if (job.state.runningAtMs) {
      continue
    }
    if (state.running.has(job.id)) {
      continue
    }
    const next = job.state.nextRunAtMs ?? computeNext(job, now, cfg)
    if (!next) {
      continue
    }
    job.state.nextRunAtMs = next
    if (next > now) {
      continue
    }
    if (state.active >= cfg.maxConcurrentRuns) {
      continue
    }
    state.running.add(job.id)
    state.active += 1
    void runAndStore(ctx, cfg, job, store, state, log)
  }
}

async function runAndStore(
  ctx: Parameters<Plugin>[0],
  cfg: Config,
  job: Job,
  store: Store,
  state: State,
  log: (level: "debug" | "info" | "warn" | "error", message: string, extra?: object) => void,
) {
  const now = Date.now()
  job.state.runningAtMs = now
  const result = await runJob(ctx, cfg, job, log)
  applyResult(job, result, now, cfg)
  job.state.runningAtMs = undefined
  state.running.delete(job.id)
  state.active = Math.max(0, state.active - 1)
  const next = finalizeJob(store, job)
  if (next) {
    store.jobs = next
  }
  await saveStore(cfg.root, store)
}

function finalizeJob(store: Store, job: Job) {
  if (job.schedule.kind !== "at") {
    return null
  }
  if (!job.deleteAfterRun) {
    job.enabled = false
    job.state.nextRunAtMs = undefined
    return null
  }
  if (job.state.lastRunStatus !== "ok") {
    job.enabled = false
    job.state.nextRunAtMs = undefined
    return null
  }
  return store.jobs.filter((item) => item.id !== job.id)
}

async function runJob(
  ctx: Parameters<Plugin>[0],
  cfg: Config,
  job: Job,
  log: (level: "debug" | "info" | "warn" | "error", message: string, extra?: object) => void,
): Promise<RunResult> {
  const startedAt = Date.now()
  const tag = `[scheduled:${job.id} ${job.name}]`
  const text = buildText(job.payload, tag)
  if (!text) {
    return { status: "error", error: "empty payload", startedAt, endedAt: Date.now() }
  }
  const body: { parts: Array<{ type: "text"; text: string }>; agent?: string } = {
    parts: [{ type: "text", text }],
  }
  if (job.agent) {
    body.agent = job.agent
  }
  const res = await ctx.client.session
    .chat({
      path: { id: job.sessionID },
      body,
    })
    .catch((err) => {
      log("warn", "scheduler job failed", { error: formatError(err), jobId: job.id })
      return null
    })
  const endedAt = Date.now()
  const status = res ? "ok" : "error"
  const error = res ? undefined : "chat failed"
  const result: RunResult = { status, error, startedAt, endedAt }
  await writeRunLog(cfg, job, result)
  await deliver(cfg, job, result)
  return result
}

function buildText(payload: Payload, tag: string) {
  if (payload.kind === "chat") {
    const msg = payload.message?.trim()
    if (!msg) {
      return ""
    }
    return `${tag}\n${msg}`
  }
  const name = payload.tool?.trim()
  if (!name) {
    return ""
  }
  const args = payload.args === undefined ? "" : JSON.stringify(payload.args, null, 2)
  const summary = payload.summary === false ? "Do not summarize." : "Summarize the tool result."
  return `${tag}\nCall the tool "${name}" with args:\n${args}\n\n${summary}`
}

function applyResult(job: Job, result: RunResult, now: number, cfg: Config) {
  job.state.lastRunAtMs = result.startedAt
  job.state.lastRunStatus = result.status
  job.state.lastError = result.error
  job.state.lastDurationMs = Math.max(0, result.endedAt - result.startedAt)
  if (result.status === "error") {
    job.state.consecutiveErrors = (job.state.consecutiveErrors ?? 0) + 1
  }
  if (result.status !== "error") {
    job.state.consecutiveErrors = 0
  }
  job.updatedAtMs = now
  if (job.schedule.kind === "at") {
    job.state.nextRunAtMs = undefined
    return
  }
  const next = computeNext(job, result.endedAt, cfg)
  if (!next) {
    job.state.nextRunAtMs = undefined
    return
  }
  if (result.status !== "error") {
    job.state.nextRunAtMs = next
    return
  }
  const idx = Math.max(0, (job.state.consecutiveErrors ?? 1) - 1)
  const backoff = ERROR_BACKOFF_MS[Math.min(idx, ERROR_BACKOFF_MS.length - 1)] ?? 60_000
  job.state.nextRunAtMs = Math.max(next, result.endedAt + backoff)
}

function computeNext(job: Job, now: number, cfg: Config) {
  if (job.schedule.kind === "at") {
    const at = parseTime(job.schedule.at)
    if (!at) {
      return
    }
    return at > now ? at : undefined
  }
  if (job.schedule.kind === "every") {
    const everyMs = Math.max(1, Math.floor(job.schedule.everyMs))
    const anchor = Math.max(0, Math.floor(job.schedule.anchorMs ?? now))
    if (now < anchor) {
      return anchor
    }
    const elapsed = now - anchor
    const steps = Math.max(1, Math.floor((elapsed + everyMs - 1) / everyMs))
    return anchor + steps * everyMs
  }
  const expr = job.schedule.expr?.trim()
  if (!expr) {
    return
  }
  const cron = parseCron(expr)
  if (!cron) {
    return
  }
  const tz = job.schedule.tz?.trim() || cfg.timezone
  const next = nextCron(cron, now, tz)
  if (!next) {
    return
  }
  const stagger = Math.max(0, Math.floor(job.schedule.staggerMs ?? 0))
  if (!stagger) {
    return next
  }
  if (!isTopHour(cron)) {
    return next
  }
  const offset = hash(job.id) % stagger
  const shifted = next + offset
  if (shifted > now) {
    return shifted
  }
  const retry = nextCron(cron, now + 1000, tz)
  if (!retry) {
    return shifted
  }
  return retry + offset
}

type CronField = { any: boolean; set: Set<number>; min: number; max: number }
type CronSpec = {
  sec: CronField
  min: CronField
  hour: CronField
  dom: CronField
  mon: CronField
  dow: CronField
  hasSeconds: boolean
}

function parseCron(expr: string): CronSpec | null {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5 && parts.length !== 6) {
    return null
  }
  const hasSeconds = parts.length === 6
  const [secRaw, minRaw, hourRaw, domRaw, monRaw, dowRaw] = hasSeconds
    ? parts
    : ["0", parts[0], parts[1], parts[2], parts[3], parts[4]]
  const sec = parseField(secRaw, 0, 59, true)
  const min = parseField(minRaw, 0, 59, false)
  const hour = parseField(hourRaw, 0, 23, false)
  const dom = parseField(domRaw, 1, 31, false)
  const mon = parseField(monRaw, 1, 12, false)
  const dow = parseField(dowRaw, 0, 6, true)
  if (!sec || !min || !hour || !dom || !mon || !dow) {
    return null
  }
  return { sec, min, hour, dom, mon, dow, hasSeconds }
}

function parseField(raw: string, min: number, max: number, wrapSunday: boolean): CronField | null {
  const text = raw.trim()
  if (!text) {
    return null
  }
  if (text === "*") {
    return { any: true, set: new Set(), min, max }
  }
  const set = new Set<number>()
  const items = text.split(",")
  for (const item of items) {
    const value = parseFieldItem(item.trim(), min, max, wrapSunday)
    if (!value) {
      return null
    }
    for (const num of value) {
      set.add(num)
    }
  }
  if (set.size === 0) {
    return null
  }
  return { any: false, set, min, max }
}

function parseFieldItem(
  raw: string,
  min: number,
  max: number,
  wrapSunday: boolean,
): number[] | null {
  if (!raw) {
    return null
  }
  const parts = raw.split("/")
  const base = parts[0]?.trim() ?? ""
  const stepRaw = parts[1]?.trim()
  const step = stepRaw ? Number(stepRaw) : 1
  if (!Number.isFinite(step) || step <= 0) {
    return null
  }
  let start = min
  let end = max
  if (base && base !== "*") {
    const range = base.split("-")
    if (range.length === 2) {
      start = parseInt(range[0] ?? "", 10)
      end = parseInt(range[1] ?? "", 10)
    } else {
      start = parseInt(base, 10)
      end = start
      if (!stepRaw) {
        end = start
      }
      if (stepRaw) {
        end = max
      }
    }
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return null
  }
  const out: number[] = []
  const low = Math.max(min, Math.min(start, end))
  const high = Math.min(max, Math.max(start, end))
  for (let i = low; i <= high; i += step) {
    const value = wrapSunday && i === 7 ? 0 : i
    if (value < min || value > max) {
      continue
    }
    out.push(value)
  }
  return out
}

function nextCron(spec: CronSpec, now: number, tz: string) {
  const step = spec.hasSeconds ? 1000 : 60_000
  let at = Math.floor(now / step) * step + step
  const end = now + MAX_LOOKAHEAD_MS
  for (; at <= end; at += step) {
    const parts = dateParts(at, tz)
    if (!parts) {
      continue
    }
    if (matchCron(spec, parts)) {
      return at
    }
  }
  return undefined
}

function dateParts(at: number, tz: string) {
  const fmt = timeFormat(tz)
  const parts = fmt.formatToParts(new Date(at))
  const map: Record<string, string> = {}
  for (const part of parts) {
    if (!part.type || !part.value) {
      continue
    }
    map[part.type] = part.value
  }
  const sec = Number(map.second)
  const min = Number(map.minute)
  const hour = Number(map.hour)
  const day = Number(map.day)
  const month = Number(map.month)
  const dow = weekday(map.weekday)
  if (
    !Number.isFinite(sec) ||
    !Number.isFinite(min) ||
    !Number.isFinite(hour) ||
    !Number.isFinite(day) ||
    !Number.isFinite(month) ||
    dow === undefined
  ) {
    return null
  }
  return { sec, min, hour, day, month, dow }
}

const FORMATTERS = new Map<string, Intl.DateTimeFormat>()

function timeFormat(tz: string) {
  const cached = FORMATTERS.get(tz)
  if (cached) {
    return cached
  }
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
  })
  FORMATTERS.set(tz, fmt)
  return fmt
}

function weekday(value: string | undefined) {
  if (!value) {
    return undefined
  }
  const key = value.slice(0, 3).toLowerCase()
  if (key === "sun") return 0
  if (key === "mon") return 1
  if (key === "tue") return 2
  if (key === "wed") return 3
  if (key === "thu") return 4
  if (key === "fri") return 5
  if (key === "sat") return 6
  return undefined
}

function matchCron(spec: CronSpec, parts: { sec: number; min: number; hour: number; day: number; month: number; dow: number }) {
  if (!matchField(spec.sec, parts.sec)) return false
  if (!matchField(spec.min, parts.min)) return false
  if (!matchField(spec.hour, parts.hour)) return false
  if (!matchField(spec.mon, parts.month)) return false
  const domOk = matchField(spec.dom, parts.day)
  const dowOk = matchField(spec.dow, parts.dow)
  if (spec.dom.any && spec.dow.any) return true
  if (spec.dom.any) return dowOk
  if (spec.dow.any) return domOk
  return domOk || dowOk
}

function matchField(field: CronField, value: number) {
  if (field.any) {
    return true
  }
  return field.set.has(value)
}

function isTopHour(spec: CronSpec) {
  return isZeroField(spec.sec) && isZeroField(spec.min)
}

function isZeroField(field: CronField) {
  if (field.any) {
    return false
  }
  return field.set.size === 1 && field.set.has(0)
}

async function deliver(cfg: Config, job: Job, result: RunResult) {
  const delivery = job.delivery ?? cfg.defaultDelivery
  if (delivery.mode !== "webhook") {
    return
  }
  const url = delivery.to?.trim()
  if (!url) {
    return
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(delivery.headers ?? {}),
  }
  const body = JSON.stringify({
    jobId: job.id,
    status: result.status,
    error: result.error,
    startedAt: result.startedAt,
    endedAt: result.endedAt,
  })
  await fetch(url, { method: "POST", headers, body }).catch(() => {})
}

async function writeRunLog(cfg: Config, job: Job, result: RunResult) {
  const file = runLogPath(cfg.root, job.id)
  await fs.mkdir(path.dirname(file), { recursive: true }).catch(() => {})
  await fs.appendFile(file, `${JSON.stringify({ ...result, jobId: job.id })}\n`, "utf8").catch(() => {})
  const stat = await fs.stat(file).catch(() => null)
  if (!stat) {
    return
  }
  if (stat.size <= cfg.runLog.maxBytes) {
    return
  }
  const text = await Bun.file(file).text().catch(() => "")
  const lines = text.split("\n").filter(Boolean)
  const keep = Math.max(0, Math.floor(cfg.runLog.keepLines))
  const trimmed = keep ? lines.slice(Math.max(0, lines.length - keep)) : []
  await fs.writeFile(file, `${trimmed.join("\n")}\n`, "utf8").catch(() => {})
}

function runLogPath(root: string, jobId: string) {
  return path.join(root, "runs", `${jobId}.jsonl`)
}

async function resolveConfig(worktree: string, prev?: Config) {
  const now = Date.now()
  const cached = prev as Config | undefined
  const cachedAt = (cached as { _at?: number })._at ?? 0
  if (cached && now - cachedAt < CFG_TTL_MS) {
    return cached
  }
  const raw = await readConfigFile(worktree)
  const base = isRecord(raw.scheduler) ? raw.scheduler : {}
  const rootRaw = readString(base.root) ?? DEFAULT_CONFIG.root
  const root = resolvePath(worktree, rootRaw)
  const enabled = readBool(base.enabled) ?? DEFAULT_CONFIG.enabled
  const timezone = readString(base.timezone) ?? DEFAULT_CONFIG.timezone
  const tickMs = clampInt(readNumber(base.tickMs) ?? DEFAULT_CONFIG.tickMs, 200, 60_000)
  const maxConcurrentRuns = clampInt(
    readNumber(base.maxConcurrentRuns) ?? DEFAULT_CONFIG.maxConcurrentRuns,
    1,
    50,
  )
  const delivery = isRecord(base.defaultDelivery) ? base.defaultDelivery : {}
  const deliveryMode = readString(delivery.mode) === "webhook" ? "webhook" : "none"
  const deliveryTo = readString(delivery.to)
  const deliveryHeaders = readStringMap(delivery.headers) ?? {}
  const runLog = isRecord(base.runLog) ? base.runLog : {}
  const maxBytes = clampInt(readNumber(runLog.maxBytes) ?? DEFAULT_CONFIG.runLog.maxBytes, 10_000, 20_000_000)
  const keepLines = clampInt(readNumber(runLog.keepLines) ?? DEFAULT_CONFIG.runLog.keepLines, 100, 20_000)
  const cfg: Config & { _at: number } = {
    enabled,
    root,
    timezone,
    tickMs,
    maxConcurrentRuns,
    defaultDelivery: { mode: deliveryMode, to: deliveryTo, headers: deliveryHeaders },
    runLog: { maxBytes, keepLines },
    _at: now,
  }
  return cfg
}

async function readConfigFile(worktree: string): Promise<Record<string, unknown>> {
  const dir = path.join(worktree, ".opencode")
  return CONFIG_FILES.reduce(async (acc, name) => {
    const value = await acc
    if (Object.keys(value).length > 0) {
      return value
    }
    const filePath = path.join(dir, name)
    const file = Bun.file(filePath)
    if (!(await file.exists())) {
      return value
    }
    const text = await file.text()
    const parsed = parseJsonWithComments(text)
    return isRecord(parsed) ? parsed : value
  }, Promise.resolve({} as Record<string, unknown>))
}

function parseJsonWithComments(text: string) {
  const withoutBlock = text.replace(/\/\*[\s\S]*?\*\//g, "")
  const withoutLine = withoutBlock.replace(/^\s*\/\/.*$/gm, "")
  return parseJsonValue(withoutLine) ?? {}
}

function parseJsonValue(text: string) {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

async function loadStore(root: string, prev?: Store) {
  const file = path.join(root, "jobs.json")
  const text = await Bun.file(file).text().catch(() => "")
  if (!text.trim()) {
    return prev ?? { version: 1, jobs: [] }
  }
  const parsed = parseJsonValue(text)
  if (!isRecord(parsed)) {
    return prev ?? { version: 1, jobs: [] }
  }
  const jobs = Array.isArray(parsed.jobs) ? parsed.jobs : []
  const items = jobs
    .map((item) => normalizeLoadedJob(item))
    .filter((item): item is Job => Boolean(item))
  const store: Store = { version: 1, jobs: items }
  return store
}

async function saveStore(root: string, store: Store) {
  await fs.mkdir(root, { recursive: true }).catch(() => {})
  const file = path.join(root, "jobs.json")
  await fs.writeFile(file, JSON.stringify(store, null, 2), "utf8").catch(() => {})
}

function normalizeCreate(
  args: {
    name: string
    schedule: Schedule
    payload: Payload
    enabled?: boolean
    deleteAfterRun?: boolean
    agent?: string
    sessionID: string
    delivery?: Delivery
  },
  input: { now: number; sessionID: string; delivery: Delivery; cfg: Config },
) {
  const name = readString(args.name)
  if (!name) {
    return null
  }
  const sessionID = readString(input.sessionID)
  if (!sessionID) {
    return null
  }
  const schedule = normalizeSchedule(args.schedule)
  if (!schedule) {
    return null
  }
  const payload = normalizePayload(args.payload)
  if (!payload) {
    return null
  }
  const id = `job_${randomUUID()}`
  const enabled = args.enabled ?? true
  const delivery = args.delivery ? normalizeDelivery(args.delivery) : input.delivery
  if (!delivery) {
    return null
  }
  const job: Job = {
    id,
    name,
    enabled,
    schedule,
    payload,
    delivery,
    deleteAfterRun: args.deleteAfterRun ?? schedule.kind === "at",
    agent: readString(args.agent),
    sessionID,
    createdAtMs: input.now,
    updatedAtMs: input.now,
    state: { nextRunAtMs: undefined, consecutiveErrors: 0 },
  }
  job.state.nextRunAtMs = computeNext(job, input.now, input.cfg)
  return job
}

function normalizeUpdate(job: Job, args: any, now: number) {
  const name = readString(args.name)
  if (name) {
    job.name = name
  }
  if (typeof args.enabled === "boolean") {
    job.enabled = args.enabled
  }
  if (typeof args.deleteAfterRun === "boolean") {
    job.deleteAfterRun = args.deleteAfterRun
  }
  if (Object.prototype.hasOwnProperty.call(args, "agent")) {
    job.agent = readString(args.agent)
  }
  if (args.schedule) {
    const schedule = normalizeSchedule(args.schedule)
    if (!schedule) {
      return null
    }
    job.schedule = schedule
  }
  if (args.payload) {
    const payload = normalizePayload(args.payload)
    if (!payload) {
      return null
    }
    job.payload = payload
  }
  if (args.delivery) {
    const delivery = normalizeDelivery(args.delivery)
    if (!delivery) {
      return null
    }
    job.delivery = delivery
  }
  job.updatedAtMs = now
  job.state.nextRunAtMs = undefined
  return job
}

function normalizeSchedule(raw: Schedule) {
  if (raw.kind === "at") {
    const at = readString(raw.at)
    if (!at) {
      return null
    }
    return { kind: "at", at }
  }
  if (raw.kind === "every") {
    const everyRaw = readNumber(raw.everyMs)
    if (!everyRaw) {
      return null
    }
    const everyMs = clampInt(everyRaw, 1, 365 * 24 * 60 * 60 * 1000)
    const anchorRaw = readNumber(raw.anchorMs)
    const anchorMs = anchorRaw ? Math.max(0, Math.floor(anchorRaw)) : undefined
    return { kind: "every", everyMs, anchorMs }
  }
  if (raw.kind === "cron") {
    const expr = readString(raw.expr)
    if (!expr) {
      return null
    }
    const tz = readString(raw.tz)
    const staggerMs = raw.staggerMs ? Math.max(0, Math.floor(raw.staggerMs)) : undefined
    return { kind: "cron", expr, tz, staggerMs }
  }
  return null
}

function normalizePayload(raw: Payload) {
  if (raw.kind === "chat") {
    const message = readString(raw.message)
    if (!message) {
      return null
    }
    return { kind: "chat", message }
  }
  if (raw.kind === "tool") {
    const name = readString(raw.tool)
    if (!name) {
      return null
    }
    return { kind: "tool", tool: name, args: raw.args, summary: raw.summary }
  }
  return null
}

function normalizeDelivery(raw: Delivery) {
  const mode = raw.mode === "webhook" ? "webhook" : "none"
  const to = readString(raw.to)
  const headers = readStringMap(raw.headers) ?? {}
  return { mode, to, headers }
}

function normalizeLoadedJob(raw: unknown): Job | null {
  if (!isRecord(raw)) {
    return null
  }
  const id = readString(raw.id)
  const name = readString(raw.name)
  const sessionID = readString(raw.sessionID)
  if (!id || !name || !sessionID) {
    return null
  }
  const schedule = normalizeSchedule(raw.schedule as Schedule)
  if (!schedule) {
    return null
  }
  const payload = normalizePayload(raw.payload as Payload)
  if (!payload) {
    return null
  }
  const enabled = typeof raw.enabled === "boolean" ? raw.enabled : true
  const createdAtMs = readNumber(raw.createdAtMs) ?? Date.now()
  const updatedAtMs = readNumber(raw.updatedAtMs) ?? createdAtMs
  const state = isRecord(raw.state) ? raw.state : {}
  const delivery = raw.delivery ? normalizeDelivery(raw.delivery as Delivery) : undefined
  return {
    id,
    name,
    enabled,
    schedule,
    payload,
    delivery,
    deleteAfterRun: typeof raw.deleteAfterRun === "boolean" ? raw.deleteAfterRun : schedule.kind === "at",
    agent: readString(raw.agent),
    sessionID,
    createdAtMs,
    updatedAtMs,
    state: {
      nextRunAtMs: readNumber(state.nextRunAtMs),
      runningAtMs: readNumber(state.runningAtMs),
      lastRunAtMs: readNumber(state.lastRunAtMs),
      lastRunStatus: readString(state.lastRunStatus) as JobState["lastRunStatus"],
      lastError: readString(state.lastError),
      lastDurationMs: readNumber(state.lastDurationMs),
      consecutiveErrors: readNumber(state.consecutiveErrors),
    },
  }
}

function resolvePath(worktree: string, value: string) {
  if (!value) {
    return worktree
  }
  if (value.startsWith("~")) {
    return path.join(os.homedir(), value.slice(1))
  }
  if (path.isAbsolute(value)) {
    return value
  }
  return path.resolve(worktree, value)
}

function parseTime(value: string) {
  const time = new Date(value).getTime()
  if (!Number.isFinite(time)) {
    return null
  }
  return time
}

function hash(text: string) {
  let out = 0
  for (let i = 0; i < text.length; i += 1) {
    out = (out << 5) - out + text.charCodeAt(i)
    out |= 0
  }
  return Math.abs(out)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return false
  }
  if (Array.isArray(value)) {
    return false
  }
  return true
}

function readString(value: unknown) {
  if (typeof value !== "string") {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function readBool(value: unknown) {
  if (typeof value !== "boolean") {
    return undefined
  }
  return value
}

function readNumber(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined
  }
  return value
}

function readStringMap(value: unknown) {
  if (!isRecord(value)) {
    return undefined
  }
  const out: Record<string, string> = {}
  for (const [key, val] of Object.entries(value)) {
    if (typeof val !== "string") {
      continue
    }
    out[key] = val
  }
  return out
}

function clampInt(value: number, min: number, max: number) {
  const num = Math.floor(value)
  if (!Number.isFinite(num)) {
    return min
  }
  if (num < min) {
    return min
  }
  if (num > max) {
    return max
  }
  return num
}

function formatError(err: unknown) {
  if (err instanceof Error) {
    return err.message
  }
  return String(err)
}
