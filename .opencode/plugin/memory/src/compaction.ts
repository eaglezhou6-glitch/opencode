import type { Model, Provider } from "@opencode-ai/sdk"

export type CompactionCtx = {
  client: {
    provider: { list: (opts: { responseStyle: "data" }) => Promise<unknown> }
    session: {
      messages: (opts: unknown) => Promise<unknown>
      message: (opts: unknown) => Promise<unknown>
      summarize: (opts: unknown) => Promise<unknown>
    }
  }
}

type Msg = { info?: Record<string, unknown>; parts?: unknown[] }

const CHARS_PER_TOKEN = 4
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/g
const OUTPUT_TOKEN_MAX = 32_000
const TOOL_OUTPUT_MAX = 8_000
const TOOL_OUTPUT_MIN = 1_000
const TOOL_OUTPUT_COOLDOWN = 60_000
const PROVIDER_TTL = 60_000
const CONTEXT_CACHE_TTL = 5_000
const NOTE_PREFIX = `你是一个智能助手，负责总结对话内容。
当被要求进行总结时，请提供详细而简洁的对话摘要。重点关注对继续对话有帮助的信息，包括：
1.已完成的工作内容
2.已经搜索到的内容或已经执行的步骤
3.是否完成用户问题
4.如果没有接下来需要完成的任务

你的总结应该足够全面以提供完整的背景，同时又要足够简洁避免冗长。`

const num = (value?: string) => {
  if (!value) return
  const next = Number(value)
  if (!Number.isFinite(next)) return
  if (next <= 0) return
  return Math.floor(next)
}

export const compactionTokens = (text: string) => {
  const base = Math.max(0, Math.round(text.length / CHARS_PER_TOKEN))
  const cjk = text.match(CJK_RE)?.length ?? 0
  return Math.max(base, cjk)
}

const trim = (text: string, limit: number) => {
  if (limit <= 0) return ""
  if (compactionTokens(text) <= limit) return text
  const size = Math.max(0, limit * CHARS_PER_TOKEN - 2)
  return text.slice(0, size).trimEnd()
}

const bound = (model: Model) => {
  const cap = num(Bun.env.OPENCODE_COMPACTION_MAX_TOKENS)
  const reserve = num(Bun.env.OPENCODE_COMPACTION_RESERVE_TOKENS) ?? 0
  const outputMax = num(Bun.env.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX) ?? OUTPUT_TOKEN_MAX
  const context = model.limit.context
  const output = model.limit.output
  const allowed = output ? Math.min(output, outputMax) : 0
  const base = context ? Math.max(0, context - allowed) : outputMax
  const max = cap ? Math.min(base, cap) : base
  const value = Math.max(0, max - reserve)
  if (value <= 0) return
  return value
}

const toolCap = (model: Model) => {
  const hard = num(Bun.env.OPENCODE_TOOL_OUTPUT_COMPACT_TOKENS)
  if (hard) return hard
  const base = bound(model)
  if (!base) return TOOL_OUTPUT_MAX
  const scaled = Math.floor(base / 4)
  return Math.min(TOOL_OUTPUT_MAX, Math.max(TOOL_OUTPUT_MIN, scaled))
}

const cooldown = () => num(Bun.env.OPENCODE_TOOL_OUTPUT_COMPACT_COOLDOWN_MS) ?? TOOL_OUTPUT_COOLDOWN

const json = (value: unknown) => {
  if (value === undefined) return ""
  if (value === null) return ""
  if (typeof value === "string") return value
  return JSON.stringify(value, null, 2)
}

const partText = (item: Record<string, unknown>) => {
  if (!item) return ""
  if (item.type === "text") return `#### text\n\n${item.text ?? ""}`.trim()
  if (item.type === "reasoning") return `#### reasoning\n\n${item.text ?? ""}`.trim()
  if (item.type !== "tool") {
    const raw = json(item)
    if (!raw) return ""
    return `#### ${item.type}\n\n\`\`\`json\n${raw}\n\`\`\``
  }
  const state = (item.state ?? {}) as Record<string, unknown>
  const header = [`tool: ${item.tool ?? "unknown"}`, state.status ? `status: ${state.status}` : ""]
    .filter((value) => value)
    .join(" | ")
  const input = json(state.input)
  const output = json(state.output)
  const meta = json(state.metadata)
  const bits = [
    `#### tool\n\n${header}`,
    input ? `\n\ninput:\n\`\`\`json\n${input}\n\`\`\`` : "",
    output ? `\n\noutput:\n\`\`\`\n${output}\n\`\`\`` : "",
    meta ? `\n\nmetadata:\n\`\`\`json\n${meta}\n\`\`\`` : "",
  ].filter((value) => value)
  return bits.join("")
}

const unwrap = <T>(value: unknown, key: string): T | undefined => {
  if (!value || typeof value !== "object") return
  if (!(key in value)) return
  return (value as Record<string, unknown>)[key] as T
}

const unwrapItems = (value: unknown) => {
  if (Array.isArray(value)) return value
  const data = unwrap<unknown>(value, "data")
  if (Array.isArray(data)) return data
  return []
}

const note = (limit?: number) => {
  if (!limit) return ""
  return `${NOTE_PREFIX}\n\n总结应限制在 ${limit} 个token内，如果内容超过限制，可丢弃低优先级的内容。`
}

// --- Helpers to extract model from pre-fetched messages ---

const findLastUser = (msgs: Msg[]) => {
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    if (msgs[i]?.info?.role === "user") return msgs[i]
  }
}

const extractModelRef = (msg: Msg) => {
  const model = msg?.info?.model as { providerID?: string; modelID?: string } | undefined
  if (model?.providerID && model?.modelID) return { providerID: model.providerID, modelID: model.modelID }
}

const tokensFromMessages = (msgs: Msg[]) => {
  if (msgs.length === 0) return 0
  const text = msgs
    .map((item) => {
      const parts = (item?.parts ?? []).map((p) => partText(p as Record<string, unknown>)).filter((v) => v)
      if (parts.length === 0) return ""
      return parts.join("\n\n")
    })
    .filter((v) => v)
    .join("\n\n")
  if (!text) return 0
  return compactionTokens(text)
}

// --- State ---

export type CompactionState = {
  providers: Provider[] | undefined
  providersFetchedAt: number
  inflight: Set<string>
  last: Map<string, number>
  contextCache: Map<string, { tokens: number; at: number; count: number }>
}

export function createCompactionState(): CompactionState {
  return {
    providers: undefined,
    providersFetchedAt: 0,
    inflight: new Set(),
    last: new Map(),
    contextCache: new Map(),
  }
}

// --- Main ---

export function createCompaction(ctx: CompactionCtx, state: CompactionState) {
  const list = async () => {
    if (state.providers && Date.now() - state.providersFetchedAt < PROVIDER_TTL) return state.providers
    const result = await ctx.client.provider.list({ responseStyle: "data" })
    const items = unwrap<Provider[]>(result, "all") ?? []
    state.providers = items
    state.providersFetchedAt = Date.now()
    return items
  }

  const model = async (providerID: string, modelID: string) => {
    const items = await list()
    const provider = items.find((item) => item.id === providerID)
    if (!provider) return
    return provider.models[modelID]
  }

  const resolveModel = async (msgs: Msg[]) => {
    const user = findLastUser(msgs)
    if (!user) return
    const ref = extractModelRef(user)
    if (!ref) return
    const current = await model(ref.providerID, ref.modelID)
    if (!current) return
    return { info: ref, current }
  }

  const sessionModel = async (sessionID: string) => {
    const res = await ctx.client.session.messages({
      path: { id: sessionID },
      query: { limit: 50 },
      responseStyle: "data",
    })
    return resolveModel(unwrapItems(res) as Msg[])
  }

  const trigger = async (sessionID: string) => {
    const now = Date.now()
    const last = state.last.get(sessionID)
    const wait = cooldown()
    if (last && now - last < wait) return
    if (state.inflight.has(sessionID)) return
    const data = await sessionModel(sessionID)
    if (!data) return
    state.inflight.add(sessionID)
    state.last.set(sessionID, now)
    await ctx.client.session
      .summarize({
        path: { id: sessionID },
        body: {
          providerID: data.info.providerID,
          modelID: data.info.modelID,
          auto: true,
        },
      })
      .catch(() => {})
    state.inflight.delete(sessionID)
  }

  const contextTokens = async (sessionID: string) => {
    const cached = state.contextCache.get(sessionID)
    const limit = num(Bun.env.OPENCODE_TOOL_OUTPUT_CONTEXT_MESSAGES)
    const query = limit ? { limit } : undefined
    const res = await ctx.client.session
      .messages({
        path: { id: sessionID },
        query,
        responseStyle: "data",
      })
      .catch(() => [])
    const items = unwrapItems(res) as Msg[]
    if (items.length === 0) return 0
    // Use cache if message count unchanged and within TTL
    if (cached && cached.count === items.length && Date.now() - cached.at < CONTEXT_CACHE_TTL) {
      return cached.tokens
    }
    const tokens = tokensFromMessages(items)
    state.contextCache.set(sessionID, { tokens, at: Date.now(), count: items.length })
    return tokens
  }

  return {
    // Called from session.compacting — receives pre-fetched messages
    async onCompacting(input: { sessionID: string }, output: { context: string[]; prompt?: string }, messages: Msg[]) {
      const data = await resolveModel(messages)
      const limit = data ? bound(data.current) : undefined
      const extra = note(limit)
      if (!extra) return
      if (output.prompt) {
        output.prompt = [output.prompt, extra].join("\n\n")
        return
      }
      output.context.push(extra)
    },
    async onTextComplete(input: { sessionID: string; messageID: string }, output: { text: string }) {
      const res = await ctx.client.session.message({
        path: { id: input.sessionID, messageID: input.messageID },
        responseStyle: "data",
      })
      const msg = (unwrap<Record<string, unknown>>(res, "data") ?? res) as { info?: Record<string, unknown> } | null
      if (!msg) return
      const info = msg.info
      if (info?.role !== "assistant") return
      if (!info?.summary && info?.mode !== "compaction") return
      const current = await model((info as { providerID: string }).providerID, (info as { modelID: string }).modelID)
      if (!current) return
      const limit = bound(current)
      if (!limit) return
      const text = trim(output.text, limit)
      if (text === output.text) return
      output.text = text
    },
    async onToolAfter(input: { sessionID: string }, output: { output?: string }) {
      if (!output.output) return
      const data = await sessionModel(input.sessionID)
      if (!data) return
      const limit = toolCap(data.current)
      const size = compactionTokens(output.output)
      if (size > limit) {
        await trigger(input.sessionID)
        return
      }
      const max = bound(data.current)
      if (!max) return
      const used = await contextTokens(input.sessionID)
      if (used + size <= max) return
      await trigger(input.sessionID)
    },
  }
}
