import type { Model, Provider } from "@opencode-ai/sdk"
import type { Plugin } from "@opencode-ai/plugin"

const CHARS_PER_TOKEN = 4
const OUTPUT_TOKEN_MAX = 32_000

const NOTE =
  "Keep the summary concise and focused on continuation. Prefer short bullet points. Use plain text only."

const readNumber = (value?: string) => {
  if (!value) return
  const num = Number(value)
  if (!Number.isFinite(num)) return
  if (num <= 0) return
  return Math.floor(num)
}

const estimate = (text: string) => Math.max(0, Math.round(text.length / CHARS_PER_TOKEN))

const trimText = (text: string, limit: number) => {
  if (limit <= 0) return ""
  if (estimate(text) <= limit) return text
  const size = Math.max(0, limit * CHARS_PER_TOKEN - 2)
  return text.slice(0, size).trimEnd()
}

const limitFromModel = (model: Model) => {
  const cap = readNumber(Bun.env.OPENCODE_COMPACTION_MAX_TOKENS)
  const reserve = readNumber(Bun.env.OPENCODE_COMPACTION_RESERVE_TOKENS) ?? 0
  const outputMax = readNumber(Bun.env.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX) ?? OUTPUT_TOKEN_MAX
  const context = model.limit.context
  const output = model.limit.output
  const allowed = output ? Math.min(output, outputMax) : 0
  const base = context ? Math.max(0, context - allowed) : outputMax
  const limit = cap ? Math.min(base, cap) : base
  const value = Math.max(0, limit - reserve)
  if (value <= 0) return
  return value
}

const note = (limit?: number) => {
  if (!limit) return NOTE
  return [NOTE, `Hard limit: ${limit} tokens. If you get close, drop lower-priority details.`].join("\n\n")
}

export const CompactionLimitPlugin: Plugin = async (ctx) => {
  const state = {
    providers: undefined as Provider[] | undefined,
  }

  const providers = async () => {
    if (state.providers) return state.providers
    const result = await ctx.client.provider.list({ responseStyle: "data" })
    if (!result) return []
    const all = result.all ?? []
    state.providers = all
    return all
  }

  const modelFor = async (providerID: string, modelID: string) => {
    const all = await providers()
    const match = all.find((item) => item.id === providerID)
    if (!match) return
    return match.models[modelID]
  }

  const sessionLimit = async (sessionID: string) => {
    const msgs = await ctx.client.session.messages({
      path: { id: sessionID },
      query: { limit: 50 },
      responseStyle: "data",
    })
    if (!msgs || msgs.length === 0) return
    const user = msgs.findLast((item) => item.info.role === "user")
    if (!user || user.info.role !== "user") return
    const model = await modelFor(user.info.model.providerID, user.info.model.modelID)
    if (!model) return
    return limitFromModel(model)
  }

  return {
    "experimental.session.compacting": async (input, output) => {
      const limit = await sessionLimit(input.sessionID)
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
      const model = await modelFor(info.providerID, info.modelID)
      if (!model) return
      const limit = limitFromModel(model)
      if (!limit) return
      const text = trimText(output.text, limit)
      if (text === output.text) return
      output.text = text
    },
  }
}
