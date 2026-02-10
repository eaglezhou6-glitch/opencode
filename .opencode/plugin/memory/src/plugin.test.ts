import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { MemoryPlugin } from "./plugin"
import os from "os"
import fs from "fs/promises"
import path from "path"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpDir = path.join(os.tmpdir(), `memory-plugin-test-${Date.now()}`)
const opencodeDir = path.join(tmpDir, ".opencode")
const memoryRootDir = path.join(tmpDir, "memory-root")

// Use small limits so we can test truncation / trigger with small strings
const SMALL_MODEL = {
  id: "small-model",
  name: "Small Model",
  release_date: "2024-01-01",
  limit: { context: 1000, output: 200 },
  attachment: {},
  reasoning: {},
  tool: {},
}

function makeMsgs(extra: Record<string, unknown>[] = []) {
  return [
    {
      info: {
        id: "m1",
        role: "user",
        model: { providerID: "test", modelID: "small-model" },
      },
      parts: [{ type: "text", text: "I prefer TypeScript over JavaScript" }],
    },
    {
      info: { id: "m2", role: "assistant" },
      parts: [{ type: "text", text: "Got it!" }],
    },
    {
      info: {
        id: "m3",
        role: "user",
        model: { providerID: "test", modelID: "small-model" },
      },
      parts: [{ type: "text", text: "I'm working on the memory plugin" }],
    },
    ...extra,
  ]
}

function createClient(overrides: {
  messages?: unknown[]
  singleMessage?: Record<string, unknown> | null
} = {}) {
  const logs: { level: string; message: string }[] = []
  const summarizeCalls: unknown[] = []
  const messages = overrides.messages ?? makeMsgs()
  const singleMessage = overrides.singleMessage ?? null

  const client = {
    app: {
      log: async (opts: { body: { level: string; message: string } }) => {
        logs.push(opts.body)
      },
    },
    session: {
      messages: async () => ({ data: messages }),
      message: async (opts: { path: { messageID: string } }) => {
        if (singleMessage) return singleMessage
        const msg = (messages as { info?: { id?: string } }[]).find(
          (m) => m.info?.id === opts.path.messageID,
        )
        return msg ?? null
      },
      summarize: async (opts: unknown) => {
        summarizeCalls.push(opts)
      },
    },
    provider: {
      list: async () => ({
        all: [
          {
            id: "test",
            env: [],
            name: "Test Provider",
            models: { "small-model": SMALL_MODEL },
          },
        ],
      }),
    },
    config: {
      get: async () => ({ model: "test/small-model" }),
    },
  }
  return { client, logs, summarizeCalls }
}

type Hooks = Awaited<ReturnType<typeof MemoryPlugin>>

async function initPlugin(cfgOverrides: Record<string, unknown> = {}) {
  const cfg = {
    memory: {
      root: memoryRootDir,
      dailyDir: "memory",
      longTermFile: "MEMORY.md",
    },
    recall: { enabled: false },
    flush: {
      enabled: true,
      mode: "heuristic",
      maxMessages: 50,
      maxItems: 6,
    },
    ...cfgOverrides,
  }
  await fs.mkdir(opencodeDir, { recursive: true })
  await Bun.write(
    path.join(opencodeDir, "memory.jsonc"),
    JSON.stringify(cfg),
  )
  const { client, logs, summarizeCalls } = createClient()
  const hooks = await (MemoryPlugin as Function)({ client, worktree: tmpDir })
  return { hooks: hooks as Hooks, client, logs, summarizeCalls }
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await fs.mkdir(opencodeDir, { recursive: true })
  await fs.mkdir(memoryRootDir, { recursive: true })
})

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
})

// ---------------------------------------------------------------------------
// 1. chat.message
// ---------------------------------------------------------------------------

describe("chat.message", () => {
  test("skips non-user messages (assistant)", async () => {
    const { hooks } = await initPlugin()
    // Should not throw — just silently skip
    await hooks["chat.message"]!(
      { sessionID: "s1" } as any,
      {
        message: { id: "x", role: "assistant" as const, agent: "" },
        parts: [{ type: "text", text: "hello" }],
      } as any,
    )
  })

  test("skips compaction agent messages", async () => {
    const { hooks } = await initPlugin()
    await hooks["chat.message"]!(
      { sessionID: "s1" } as any,
      {
        message: { id: "x", role: "user" as const, agent: "compaction" },
        parts: [{ type: "text", text: "hello from compaction" }],
      } as any,
    )
  })

  test("skips summary agent messages", async () => {
    const { hooks } = await initPlugin()
    await hooks["chat.message"]!(
      { sessionID: "s1" } as any,
      {
        message: { id: "x", role: "user" as const, agent: "summary" },
        parts: [{ type: "text", text: "hello from summary" }],
      } as any,
    )
  })

  test("skips title agent messages", async () => {
    const { hooks } = await initPlugin()
    await hooks["chat.message"]!(
      { sessionID: "s1" } as any,
      {
        message: { id: "x", role: "user" as const, agent: "title" },
        parts: [{ type: "text", text: "hello from title" }],
      } as any,
    )
  })

  test("skips when recall is disabled", async () => {
    const { hooks } = await initPlugin({ recall: { enabled: false } })
    // Should not throw — recall is off so it returns early
    await hooks["chat.message"]!(
      { sessionID: "s1" } as any,
      {
        message: { id: "x", role: "user" as const, agent: "" },
        parts: [{ type: "text", text: "a long enough user query for recall testing" }],
      } as any,
    )
  })

  test("skips queries shorter than 4 chars", async () => {
    const { hooks } = await initPlugin({ recall: { enabled: true } })
    await hooks["chat.message"]!(
      { sessionID: "s1" } as any,
      {
        message: { id: "x", role: "user" as const, agent: "" },
        parts: [{ type: "text", text: "hi" }],
      } as any,
    )
  })
})

// ---------------------------------------------------------------------------
// 2. experimental.chat.system.transform
// ---------------------------------------------------------------------------

describe("experimental.chat.system.transform", () => {
  test("does nothing when sessionID is empty", async () => {
    const { hooks } = await initPlugin()
    const output = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]!(
      { sessionID: "" } as any,
      output as any,
    )
    expect(output.system).toHaveLength(0)
  })

  test("does nothing when cache is empty", async () => {
    const { hooks } = await initPlugin()
    const output = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]!(
      { sessionID: "no-cache-session" } as any,
      output as any,
    )
    expect(output.system).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 3. experimental.session.compacting
// ---------------------------------------------------------------------------

describe("experimental.session.compacting", () => {
  test("heuristic flush extracts longTerm and daily notes", async () => {
    const { hooks, logs } = await initPlugin()

    const output = { context: [] as string[], prompt: undefined as string | undefined }
    await hooks["experimental.session.compacting"]!(
      { sessionID: "flush-test" },
      output,
    )

    // The heuristic should have found:
    // - longTerm: "I prefer TypeScript over JavaScript" (matches "prefer")
    // - daily: "I'm working on the memory plugin" (matches "working on")
    const flushLog = logs.find((l) => l.message === "memory flush wrote notes")
    expect(flushLog).toBeTruthy()
    console.log("  flush log:", flushLog)

    // Verify MEMORY.md was created
    const memoryFile = path.join(memoryRootDir, "MEMORY.md")
    const memoryExists = await fs
      .access(memoryFile)
      .then(() => true)
      .catch(() => false)
    expect(memoryExists).toBe(true)
    const memoryContent = await Bun.file(memoryFile).text()
    expect(memoryContent).toContain("prefer TypeScript")
    console.log("  MEMORY.md written:", memoryContent.length, "chars")

    // Verify daily file was created
    const dailyDir = path.join(memoryRootDir, "memory")
    const dailyFiles = await fs.readdir(dailyDir).catch(() => [])
    expect(dailyFiles.length).toBeGreaterThan(0)
    const dailyFile = dailyFiles.find((f) => f.endsWith(".md"))
    expect(dailyFile).toBeTruthy()
    if (dailyFile) {
      const dailyContent = await Bun.file(path.join(dailyDir, dailyFile)).text()
      expect(dailyContent).toContain("working on")
      console.log("  daily file written:", dailyFile, dailyContent.length, "chars")
    }
  })

  test("compaction adds context with token limit note", async () => {
    const { hooks } = await initPlugin()

    const output = { context: [] as string[], prompt: undefined as string | undefined }
    await hooks["experimental.session.compacting"]!(
      { sessionID: "ctx-test" },
      output,
    )

    // onCompacting should have pushed a note to context
    expect(output.context.length).toBeGreaterThan(0)
    const combined = output.context.join("\n")
    expect(combined).toContain("总结对话内容")
    console.log("  compaction context items:", output.context.length)
  })

  test("compaction appends to existing prompt", async () => {
    const { hooks } = await initPlugin()

    const output = { context: [] as string[], prompt: "My custom prompt" }
    await hooks["experimental.session.compacting"]!(
      { sessionID: "prompt-test" },
      output,
    )

    // Should have appended to the prompt
    expect(output.prompt).toContain("My custom prompt")
    expect(output.prompt).toContain("总结对话内容")
    console.log("  prompt after compaction:", output.prompt!.slice(0, 80), "...")
  })

  test("flush is skipped when disabled", async () => {
    const { hooks, logs } = await initPlugin({ flush: { enabled: false, mode: "heuristic" } })

    await hooks["experimental.session.compacting"]!(
      { sessionID: "no-flush" },
      { context: [], prompt: undefined },
    )

    const flushLog = logs.find((l) => l.message === "memory flush wrote notes")
    expect(flushLog).toBeUndefined()
    console.log("  flush correctly skipped when disabled")
  })
})

// ---------------------------------------------------------------------------
// 4. experimental.text.complete
// ---------------------------------------------------------------------------

describe("experimental.text.complete", () => {
  test("truncates long summary text", async () => {
    // Model: context=1000, output=200 → bound = 800
    // 800 tokens ≈ 3200 chars max
    const longText = "x".repeat(5000) // ~1250 tokens, over 800 limit

    const { client, logs } = createClient({
      singleMessage: {
        info: {
          id: "sum1",
          role: "assistant",
          summary: true,
          providerID: "test",
          modelID: "small-model",
        },
        parts: [{ type: "text", text: longText }],
      },
    })

    const hooks = await (MemoryPlugin as Function)({ client, worktree: tmpDir })
    const output = { text: longText }
    await hooks["experimental.text.complete"]!(
      { sessionID: "s1", messageID: "sum1", partID: "p1" },
      output,
    )

    expect(output.text.length).toBeLessThan(longText.length)
    // bound = 1000 - min(200, 32000) = 800; trim to 800*4-2 = 3198 chars
    expect(output.text.length).toBeLessThanOrEqual(3198)
    console.log("  truncated from", longText.length, "to", output.text.length, "chars")
  })

  test("does not truncate short summary text", async () => {
    const shortText = "Short summary"

    const { client } = createClient({
      singleMessage: {
        info: {
          id: "sum2",
          role: "assistant",
          summary: true,
          providerID: "test",
          modelID: "small-model",
        },
      },
    })

    const hooks = await (MemoryPlugin as Function)({ client, worktree: tmpDir })
    const output = { text: shortText }
    await hooks["experimental.text.complete"]!(
      { sessionID: "s1", messageID: "sum2", partID: "p1" },
      output,
    )

    expect(output.text).toBe(shortText)
    console.log("  short text unchanged:", output.text.length, "chars")
  })

  test("ignores non-assistant messages", async () => {
    const { client } = createClient({
      singleMessage: {
        info: { id: "u1", role: "user" },
        parts: [{ type: "text", text: "hello" }],
      },
    })

    const hooks = await (MemoryPlugin as Function)({ client, worktree: tmpDir })
    const output = { text: "original" }
    await hooks["experimental.text.complete"]!(
      { sessionID: "s1", messageID: "u1", partID: "p1" },
      output,
    )

    expect(output.text).toBe("original")
  })

  test("ignores assistant messages without summary or compaction mode", async () => {
    const { client } = createClient({
      singleMessage: {
        info: {
          id: "a1",
          role: "assistant",
          summary: false,
          mode: "normal",
          providerID: "test",
          modelID: "small-model",
        },
      },
    })

    const hooks = await (MemoryPlugin as Function)({ client, worktree: tmpDir })
    const output = { text: "x".repeat(5000) }
    const original = output.text
    await hooks["experimental.text.complete"]!(
      { sessionID: "s1", messageID: "a1", partID: "p1" },
      output,
    )

    expect(output.text).toBe(original)
    console.log("  non-summary message text unchanged")
  })

  test("truncates compaction mode messages", async () => {
    const longText = "y".repeat(5000)

    const { client } = createClient({
      singleMessage: {
        info: {
          id: "c1",
          role: "assistant",
          summary: false,
          mode: "compaction",
          providerID: "test",
          modelID: "small-model",
        },
      },
    })

    const hooks = await (MemoryPlugin as Function)({ client, worktree: tmpDir })
    const output = { text: longText }
    await hooks["experimental.text.complete"]!(
      { sessionID: "s1", messageID: "c1", partID: "p1" },
      output,
    )

    expect(output.text.length).toBeLessThan(longText.length)
    console.log("  compaction mode: truncated from", longText.length, "to", output.text.length)
  })
})

// ---------------------------------------------------------------------------
// 5. tool.execute.after
// ---------------------------------------------------------------------------

describe("tool.execute.after", () => {
  test("ignores empty tool output", async () => {
    const { hooks, summarizeCalls } = await initPlugin()

    await hooks["tool.execute.after"]!(
      { sessionID: "s1" } as any,
      { output: undefined } as any,
    )

    expect(summarizeCalls).toHaveLength(0)
    console.log("  empty output: no summarize triggered")
  })

  test("ignores small tool output within limits", async () => {
    const { hooks, summarizeCalls } = await initPlugin()

    await hooks["tool.execute.after"]!(
      { sessionID: "s1" } as any,
      { output: "small output" } as any,
    )

    expect(summarizeCalls).toHaveLength(0)
    console.log("  small output: no summarize triggered")
  })

  test("triggers compaction when tool output exceeds toolCap", async () => {
    // toolCap for small-model: bound=800, scaled=200, clamped to [1000, 8000] → 1000 tokens
    // 1000 tokens ≈ 4000 chars. Use 5000 chars to exceed.
    const bigOutput = "z".repeat(5000)

    const { client, summarizeCalls } = createClient()
    const hooks = await (MemoryPlugin as Function)({ client, worktree: tmpDir })

    await hooks["tool.execute.after"]!(
      { sessionID: "tool-trigger-1" } as any,
      { output: bigOutput } as any,
    )

    expect(summarizeCalls.length).toBeGreaterThan(0)
    console.log("  large output: summarize triggered!", summarizeCalls.length, "call(s)")
  })

  test("triggers compaction when context + tool output exceeds bound", async () => {
    // Even if individual tool output is under toolCap,
    // if context + output > bound (800 tokens), trigger.
    // The mock messages have some text, so context is non-zero.
    // Use a moderate output that alone is under toolCap but pushes context over.

    // The context from mockMessages is roughly:
    //   "I prefer TypeScript over JavaScript" + "Got it!" + "I'm working on the memory plugin"
    //   ≈ 35+6+33 = 74 chars ≈ 19 tokens (very small)
    // bound = 800 tokens ≈ 3200 chars
    // Use 3100 chars output — under toolCap(1000 tokens=4000 chars) but context+output ≈ 800 tokens

    const mediumOutput = "w".repeat(3100)

    const { client, summarizeCalls } = createClient()
    const hooks = await (MemoryPlugin as Function)({ client, worktree: tmpDir })

    await hooks["tool.execute.after"]!(
      { sessionID: "tool-trigger-2" } as any,
      { output: mediumOutput } as any,
    )

    expect(summarizeCalls.length).toBeGreaterThan(0)
    console.log("  context overflow: summarize triggered!", summarizeCalls.length, "call(s)")
  })

  test("respects cooldown — second call within cooldown does not trigger", async () => {
    const bigOutput = "z".repeat(5000)

    const { client, summarizeCalls } = createClient()
    const hooks = await (MemoryPlugin as Function)({ client, worktree: tmpDir })

    // First call — triggers
    await hooks["tool.execute.after"]!(
      { sessionID: "cooldown-test" } as any,
      { output: bigOutput } as any,
    )
    const firstCount = summarizeCalls.length
    expect(firstCount).toBeGreaterThan(0)

    // Second call immediately — should be within cooldown
    await hooks["tool.execute.after"]!(
      { sessionID: "cooldown-test" } as any,
      { output: bigOutput } as any,
    )
    expect(summarizeCalls.length).toBe(firstCount)
    console.log("  cooldown respected: no extra summarize call")
  })
})

// ---------------------------------------------------------------------------
// 6. event — session.created flush
// ---------------------------------------------------------------------------

describe("event — session.created flush", () => {
  test("flushes previous session on session.created", async () => {
    const { hooks, logs } = await initPlugin()

    // Simulate first user message to set activeSessionID
    await hooks["chat.message"]!(
      { sessionID: "old-session" } as any,
      {
        message: { id: "x", role: "user" as const, agent: "" },
        parts: [{ type: "text", text: "hi" }],
      } as any,
    )

    // Fire session.created for a new session
    await hooks.event!(
      { event: { type: "session.created", properties: { info: { id: "new-session" } } } } as any,
    )

    // The old session should have been flushed
    const flushLog = logs.find(
      (l) => l.message === "memory flush wrote notes" && (l as any).extra?.sessionID === "old-session",
    )
    // Heuristic should find notes from the mock messages
    expect(flushLog).toBeTruthy()
    console.log("  previous session flushed on session.created")
  })

  test("skips flush when no previous session exists", async () => {
    const { hooks, logs } = await initPlugin()

    // Fire session.created without any prior chat.message
    await hooks.event!(
      { event: { type: "session.created", properties: { info: { id: "first-session" } } } } as any,
    )

    const flushLog = logs.find((l) => l.message === "memory flush wrote notes")
    expect(flushLog).toBeUndefined()
    console.log("  no flush when no previous session")
  })

  test("skips already-flushed sessions (dedup with compaction)", async () => {
    const { hooks, logs } = await initPlugin()

    // Simulate chat.message to track session
    await hooks["chat.message"]!(
      { sessionID: "dup-session" } as any,
      {
        message: { id: "x", role: "user" as const, agent: "" },
        parts: [{ type: "text", text: "hi" }],
      } as any,
    )

    // Trigger compaction flush first — marks session as flushed
    await hooks["experimental.session.compacting"]!(
      { sessionID: "dup-session" },
      { context: [], prompt: undefined },
    )
    const flushCount = logs.filter((l) => l.message === "memory flush wrote notes").length

    // Now fire session.created — should NOT flush again
    await hooks.event!(
      { event: { type: "session.created", properties: { info: { id: "next-session" } } } } as any,
    )
    const afterCount = logs.filter((l) => l.message === "memory flush wrote notes").length
    expect(afterCount).toBe(flushCount)
    console.log("  dedup: compacted session not flushed again")
  })

  test("ignores non session.created events", async () => {
    const { hooks, logs } = await initPlugin()

    await hooks["chat.message"]!(
      { sessionID: "some-session" } as any,
      {
        message: { id: "x", role: "user" as const, agent: "" },
        parts: [{ type: "text", text: "hi" }],
      } as any,
    )

    await hooks.event!(
      { event: { type: "session.updated", properties: { info: { id: "other" } } } } as any,
    )

    const flushLog = logs.find((l) => l.message === "memory flush wrote notes")
    expect(flushLog).toBeUndefined()
    console.log("  non session.created event ignored")
  })

  test("chat.message initializes activeSessionID", async () => {
    const { hooks, logs } = await initPlugin()

    // Send chat.message for session A — sets activeSessionID
    await hooks["chat.message"]!(
      { sessionID: "session-a" } as any,
      {
        message: { id: "x", role: "user" as const, agent: "" },
        parts: [{ type: "text", text: "hello" }],
      } as any,
    )

    // Create session B — should flush session A
    await hooks.event!(
      { event: { type: "session.created", properties: { info: { id: "session-b" } } } } as any,
    )

    const flushLog = logs.find((l) => l.message === "memory flush wrote notes")
    expect(flushLog).toBeTruthy()
    console.log("  activeSessionID initialized from chat.message and flushed on new session")
  })
})

// ---------------------------------------------------------------------------
// Integration: full flow
// ---------------------------------------------------------------------------

describe("integration", () => {
  test("compacting → text.complete full pipeline", async () => {
    const longSummary = "a".repeat(5000)
    const { client, logs, summarizeCalls } = createClient({
      singleMessage: {
        info: {
          id: "int-sum",
          role: "assistant",
          summary: true,
          providerID: "test",
          modelID: "small-model",
        },
      },
    })

    const hooks = await (MemoryPlugin as Function)({ client, worktree: tmpDir })

    // Step 1: compacting fires — flush + vector sync + context
    const compactOutput = { context: [] as string[], prompt: undefined as string | undefined }
    await hooks["experimental.session.compacting"]!(
      { sessionID: "integration-test" },
      compactOutput,
    )
    expect(compactOutput.context.length).toBeGreaterThan(0)

    // Step 2: text.complete fires — truncates summary
    const textOutput = { text: longSummary }
    await hooks["experimental.text.complete"]!(
      { sessionID: "integration-test", messageID: "int-sum", partID: "p1" },
      textOutput,
    )
    expect(textOutput.text.length).toBeLessThan(longSummary.length)

    console.log("  full pipeline: compacting context items:", compactOutput.context.length)
    console.log("  full pipeline: summary truncated to:", textOutput.text.length, "chars")
    console.log("  full pipeline: flush logs:", logs.filter((l) => l.message.includes("flush")).length)
  })
})
