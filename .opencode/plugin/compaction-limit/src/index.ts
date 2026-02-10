import type { Model, Provider } from "@opencode-ai/sdk"
import type { Plugin } from "@opencode-ai/plugin"
import fs from "fs/promises"
import path from "path"

const CHARS_PER_TOKEN = 4
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/g
const OUTPUT_TOKEN_MAX = 32_000
const TOOL_OUTPUT_MAX = 8_000
const TOOL_OUTPUT_MIN = 1_000
const TOOL_OUTPUT_COOLDOWN = 60_000
const NOTE = "Keep the summary concise and focused on continuation. Prefer short bullet points. Use plain text only."

const num = (value?: string) => {
  if (!value) return
  const next = Number(value)
  if (!Number.isFinite(next)) return
  if (next <= 0) return
  return Math.floor(next)
}

const tokens = (text: string) => {
  const base = Math.max(0, Math.round(text.length / CHARS_PER_TOKEN))
  const cjk = text.match(CJK_RE)?.length ?? 0
  return Math.max(base, cjk)
}

const trim = (text: string, limit: number) => {
  if (limit <= 0) return ""
  if (tokens(text) <= limit) return text
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

const pad = (value: number) => value.toString().padStart(2, "0")

const day = (value = new Date()) => {
  const year = value.getFullYear()
  const month = pad(value.getMonth() + 1)
  const date = pad(value.getDate())
  return `${year}-${month}-${date}`
}

const name = (info: any) => {
  if (info?.model?.providerID && info?.model?.modelID) {
    return `${info.model.providerID}/${info.model.modelID}`
  }
  if (info?.providerID && info?.modelID) {
    return `${info.providerID}/${info.modelID}`
  }
}

const json = (value: unknown) => {
  if (value === undefined) return ""
  if (value === null) return ""
  if (typeof value === "string") return value
  return JSON.stringify(value, null, 2)
}

const part = (item: any) => {
  if (!item) return ""
  if (item.type === "text") return `#### text\n\n${item.text ?? ""}`.trim()
  if (item.type === "reasoning") return `#### reasoning\n\n${item.text ?? ""}`.trim()
  if (item.type !== "tool") {
    const raw = json(item)
    if (!raw) return ""
    return `#### ${item.type}\n\n\`\`\`json\n${raw}\n\`\`\``
  }
  const state = item.state ?? {}
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

const message = (item: any) => {
  if (!item?.info) return ""
  const info = item.info
  const meta = [
    info.summary ? "summary" : "",
    name(info),
    info.time?.created ? new Date(info.time.created).toISOString() : "",
  ].filter((value) => value)
  const parts = (item.parts ?? []).map(part).filter((value) => value)
  const header = `### ${info.role} ${info.id}`
  const extra = meta.length ? `\n\n- ${meta.join(" | ")}` : ""
  const body = parts.length ? `\n\n${parts.join("\n\n")}` : ""
  return `${header}${extra}${body}`.trim()
}

const snapshot = async (root: string, sessionID: string, items: any[]) => {
  if (items.length === 0) return
  const dir = path.join(root, "memory")
  await fs.mkdir(dir, { recursive: true }).catch(() => {})
  const file = path.join(dir, `${day()}.md`)
  const exists = await Bun.file(file).exists().catch(() => false)
  const header = exists ? "" : `# ${day()}\n`
  const now = new Date().toISOString()
  const body = [
    header,
    `\n## Session ${sessionID} @ ${now}\n`,
    ...items.map(message).filter((value) => value),
    "\n---\n",
  ].join("\n")
  await fs.appendFile(file, body, "utf8").catch(() => {})
}

const note = (limit?: number) => {
  if (!limit) return NOTE
  return [NOTE, `Hard limit: ${limit} tokens. If you get close, drop lower-priority details.`].join("\n\n")
}

export const CompactionLimitPlugin: Plugin = async (ctx) => {
  const state = {
    providers: undefined as Provider[] | undefined,
    inflight: new Set<string>(),
    last: new Map<string, number>(),
    memory: new Map<string, string>(),
  }

  const list = async () => {
    if (state.providers) return state.providers
    const result = await ctx.client.provider.list({ responseStyle: "data" })
    const items = result?.all ?? []
    state.providers = items
    return items
  }

  const model = async (providerID: string, modelID: string) => {
    const items = await list()
    const provider = items.find((item) => item.id === providerID)
    if (!provider) return
    return provider.models[modelID]
  }

  const sessionModel = async (sessionID: string) => {
    const msgs = await ctx.client.session.messages({
      path: { id: sessionID },
      query: { limit: 50 },
      responseStyle: "data",
    })
    if (!msgs || msgs.length === 0) return
    const user = msgs.findLast((item) => item.info.role === "user")
    if (!user || user.info.role !== "user") return
    const info = user.info.model
    const current = await model(info.providerID, info.modelID)
    if (!current) return
    return { info, current }
  }

  const remember = async (sessionID: string) => {
    const msgs = await ctx.client.session.messages({
      path: { id: sessionID },
      responseStyle: "data",
    })
    if (!msgs || msgs.length === 0) return
    const tail = msgs[msgs.length - 1]?.info?.id
    if (!tail) return
    if (state.memory.get(sessionID) === tail) return
    state.memory.set(sessionID, tail)
    await snapshot(ctx.worktree, sessionID, msgs)
  }

  const cap = async (sessionID: string) => {
    const data = await sessionModel(sessionID)
    if (!data) return
    return bound(data.current)
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
    const limit = num(Bun.env.OPENCODE_TOOL_OUTPUT_CONTEXT_MESSAGES)
    const query = limit ? { limit } : undefined
    const msgs = await ctx.client.session
      .messages({
        path: { id: sessionID },
        query,
        responseStyle: "data",
      })
      .catch(() => [])
    const items = Array.isArray(msgs) ? msgs : []
    if (items.length === 0) return 0
    const text = items
      .map((item) => {
        const parts = (item?.parts ?? []).map(part).filter((value) => value)
        if (parts.length === 0) return ""
        return parts.join("\n\n")
      })
      .filter((value) => value)
      .join("\n\n")
    if (!text) return 0
    return tokens(text)
  }

  return {
    "experimental.session.compacting": async (input, output) => {
      await remember(input.sessionID)
      const limit = await cap(input.sessionID)
      const extra = note(limit)
      if (output.prompt) {
        output.prompt = [output.prompt, extra].join("\n\n")
        return
      }
      output.context.push(extra)
    },
    "experimental.text.complete": async (input, output) => {
      const msg = await ctx.client.session.message({
        path: { id: input.sessionID, messageID: input.messageID },
        responseStyle: "data",
      })
      if (!msg) return
      const info = msg.info
      if (info.role !== "assistant") return
      if (!info.summary && info.mode !== "compaction") return
      const current = await model(info.providerID, info.modelID)
      if (!current) return
      const limit = bound(current)
      if (!limit) return
      const text = trim(output.text, limit)
      if (text === output.text) return
      output.text = text
    },
    "tool.execute.after": async (input, output) => {
      if (!output.output) return
      const data = await sessionModel(input.sessionID)
      if (!data) return
      const limit = toolCap(data.current)
      const size = tokens(output.output)
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
