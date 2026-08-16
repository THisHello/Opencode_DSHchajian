/**
 * anchor-deepseek.js — local opencode port of the DSH anchored presets,
 * synced to upstream main (ffb845c, incl. PR #29 resident set + compaction
 * epoch). Scoped to DeepSeek V4 Pro only; v4 Flash is handled by
 * router-flash-deepseek.js.
 *
 * Modes (default: "zero"; override with ANCHOR_MODE=whoami opencode):
 *
 *  "zero"     : port of zero-anchored-standard.
 *               The FIRST user message of a fresh top-level session is
 *               replaced by a fixed anchor turn (zero tools). Once the anchor
 *               assistant reply is durable (or the session goes idle), the
 *               plugin re-sends the real message with the full catalog.
 *
 *  "whoami"   : same zero-tool flow as "zero", but the anchor text is the
 *               whoami self-introduction prompt (default "你是谁"; override
 *               with ANCHOR_WHOAMI_TEXT).
 *
 *  "anchored" : port of anchored-standard.
 *               bootstrap  : first request sees the Minimal-aligned pair
 *                            (bash + edit, the opencode analogue of the
 *                            official bash + str_replace_editor) and a minimal
 *                            system prompt; no output cap by default
 *                            (ANCHOR_BOOTSTRAP_MAX_OUTPUT_TOKENS is opt-in).
 *               promoted   : instead of dumping the whole catalog, the session
 *                            keeps a minimal RESIDENT set — the bootstrap pair
 *                            + skill + dev_tool_search + whatever the model
 *                            explicitly unlocked via dev_tool_search — and the
 *                            normal opencode system context returns.
 *               contracted : after a compaction the session falls back to the
 *                            bootstrap pair plus a compaction work set
 *                            (read/write/edit/glob/grep/todowrite) until a NEW
 *                            durable promotion signal (either).
 *
 *  "off"      : disable this plugin (alias "none") while keeping the file
 *               installed.
 *
 * Subagents are never anchored. Model matching is provider-agnostic: only the
 * model id matters (deepseek + v4 + pro).
 */

import { tool } from "@opencode-ai/plugin"

const BOOTSTRAP_TOOLS = new Set(["bash", "edit"])
const RESIDENT_DISCOVERY_TOOLS = ["skill", "dev_tool_search"]
// Upstream compactionTools: read/write/edit/glob/grep/todo_write/ask_user_question.
const COMPACTION_TOOLS = ["read", "write", "edit", "glob", "grep", "todowrite", "question"]
const MINIMAL_SYSTEM = ["You are a helpful software engineer assistant."]
const ANCHOR_TEXT = "This round is a test. Tools are not open yet; all tools will open next round."
const WHOAMI_TEXT = "你是谁"
const TOP_LEVEL_AGENT = "build"
const MAX_SEARCH_RESULTS = 25

const UNLOCKABLE_INDEX = [
  "webfetch — internet retrieval",
  "search — web search",
  "task — delegate work to subagents",
  "todowrite — task tracking",
  "question — ask the user",
  "write / read / glob / grep — broader filesystem work",
  "patch — apply patches",
  "lsp — language server commands",
]

function readBootstrapMaxTokens(options) {
  const raw = options?.bootstrapMaxTokens ?? process.env.ANCHOR_BOOTSTRAP_MAX_OUTPUT_TOKENS
  if (raw === undefined || raw === null || raw === "") return undefined
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`[anchor-deepseek] invalid bootstrapMaxTokens ${JSON.stringify(raw)}, disabling the cap`)
    return undefined
  }
  return Math.floor(value)
}

function pickMode(options) {
  const value = String(options?.mode ?? process.env.ANCHOR_MODE ?? "zero").trim().toLowerCase()
  if (value === "zero" || value === "anchored" || value === "whoami" || value === "off" || value === "none") {
    return value === "none" ? "off" : value
  }
  console.error(`[anchor-deepseek] unknown mode ${JSON.stringify(value)}, falling back to "zero"`)
  return "zero"
}

function readWhoamiText(options) {
  const value = options?.whoamiText ?? process.env.ANCHOR_WHOAMI_TEXT
  if (value === undefined || value === null || String(value).trim() === "") return WHOAMI_TEXT
  return String(value)
}

function isDeepSeekPro(model) {
  if (!model) return false
  // Provider-agnostic: only the model id matters.
  const id = String(model.id ?? model.modelID ?? "").toLowerCase()
  return id.includes("deepseek") && id.includes("v4") && id.includes("pro")
}

function isTopLevel(agent) {
  return (agent ?? TOP_LEVEL_AGENT) === TOP_LEVEL_AGENT
}

/** Map persisted parts back to the prompt input shape accepted by the API. */
function toPromptParts(parts) {
  if (!Array.isArray(parts)) return []
  const result = []
  for (const part of parts) {
    if (!part) continue
    switch (part.type) {
      case "text":
        result.push({
          type: "text",
          text: part.text,
          ...(part.synthetic !== undefined ? { synthetic: part.synthetic } : {}),
          ...(part.ignored !== undefined ? { ignored: part.ignored } : {}),
          ...(part.metadata !== undefined ? { metadata: part.metadata } : {}),
        })
        break
      case "file":
        result.push({
          type: "file",
          mime: part.mime,
          url: part.url,
          ...(part.filename !== undefined ? { filename: part.filename } : {}),
          ...(part.source !== undefined ? { source: part.source } : {}),
        })
        break
      case "agent":
        result.push({
          type: "agent",
          name: part.name,
          ...(part.source !== undefined ? { source: part.source } : {}),
        })
        break
      case "subtask":
        result.push({
          type: "subtask",
          prompt: part.prompt,
          description: part.description,
          agent: part.agent,
        })
        break
    }
  }
  return result
}

/** Tool names the model explicitly unlocked via dev_tool_search (resume-safe). */
function unlockedFromMessages(messages) {
  const unlocked = new Set()
  for (const item of messages ?? []) {
    for (const part of item?.parts ?? []) {
      if (part?.type !== "tool-invocation") continue
      const invocation = part.toolInvocation
      if (invocation?.toolName !== "dev_tool_search") continue
      let args = invocation.args
      if (typeof args === "string") {
        try {
          args = JSON.parse(args)
        } catch {
          continue
        }
      }
      const names = args?.toolNames
      if (Array.isArray(names)) for (const name of names) if (typeof name === "string" && name.length > 0) unlocked.add(name)
    }
  }
  return unlocked
}

export const AnchorDeepSeek = async (input = {}, options = {}) => {
  const client = input.client
  const mode = pickMode(options)
  const bootstrapMaxTokens = readBootstrapMaxTokens(options)
  const whoamiText = readWhoamiText(options)

  if (mode === "off") return {}

  /** sessionID -> per-session bootstrap state (process local, like DSH plugins). */
  const sessions = new Map()

  const ensureState = async (sessionID) => {
    if (!sessionID) return undefined
    const existing = sessions.get(sessionID)
    if (existing) return existing

    let hasUser = false
    let hasAssistant = false
    let hasToolCall = false
    let compactionSeen = false
    let promotedAfterCompaction = false
    const messages = []
    try {
      if (client?.session?.messages) {
        const raw = await client.session.messages({ path: { id: sessionID }, query: { limit: 100 } })
        const list = Array.isArray(raw) ? raw : raw?.data
        if (Array.isArray(list)) {
          for (const item of list) {
            messages.push(item)
            const info = item?.info
            const parts = Array.isArray(item?.parts) ? item.parts : []
            if (info?.role === "user") hasUser = true
            if (info?.role === "assistant") hasAssistant = true
            if (parts.some((p) => p?.type === "compaction")) {
              compactionSeen = true
              promotedAfterCompaction = false
              continue
            }
            if (info?.role === "assistant" || parts.some((p) => p?.type === "tool-invocation")) {
              hasToolCall = hasToolCall || parts.some((p) => p?.type === "tool-invocation")
              promotedAfterCompaction = true
            }
          }
        }
      }
    } catch (error) {
      // A history probe failure must never break the message being sent.
      console.error("[anchor-deepseek] session history probe failed:", error)
    }

    const history = hasUser || hasAssistant
    let phase
    if (mode === "zero" || mode === "whoami") {
      phase = history ? "promoted" : "bootstrap"
    } else if (!history) {
      phase = "bootstrap"
    } else if (promotedAfterCompaction) {
      phase = "promoted"
    } else if (compactionSeen) {
      phase = "contracted"
    } else {
      phase = "bootstrap"
    }

    const state = {
      mode,
      // "bootstrap"  = first request on the restricted surface
      // "contracted" = post-compaction controlled phase
      // "promoted"   = resident catalog
      phase,
      compacted: compactionSeen,
      unlocked: unlockedFromMessages(messages),
      catalog: undefined,
      anchored: false,
      stashed: undefined,
      sent: false,
      assistantDone: hasAssistant,
      model: undefined,
      agent: TOP_LEVEL_AGENT,
      variant: undefined,
      bootstrapMaxTokens,
    }
    sessions.set(sessionID, state)
    return state
  }

  const sendRealPrompt = async (sessionID, state) => {
    const body = { parts: toPromptParts(state.stashed) }
    if (state.agent) body.agent = state.agent
    if (state.model) body.model = state.model
    if (state.variant) body.variant = state.variant
    try {
      if (!client?.session?.promptAsync) throw new Error("plugin client is unavailable")
      await client.session.promptAsync({ path: { id: sessionID }, body })
    } catch (error) {
      console.error(`[anchor-deepseek] failed to re-send real prompt for session ${sessionID}:`, error)
    }
  }

  const keepSetFor = (state) => {
    const keep = new Set(BOOTSTRAP_TOOLS)
    if (state.phase === "contracted") {
      for (const name of COMPACTION_TOOLS) keep.add(name)
      return keep
    }
    if (state.phase === "promoted") {
      for (const name of RESIDENT_DISCOVERY_TOOLS) keep.add(name)
      for (const name of state.unlocked) keep.add(name)
    }
    return keep
  }

  return {
    /**
     * Called when a new message is received, BEFORE it is persisted.
     * zero/whoami mode: swap the first top-level user message for the anchor
     * turn, stash the real parts, and re-send them once the anchor reply is
     * durable.
     */
    "chat.message": async (hookInput, output) => {
      if (!isDeepSeekPro(hookInput.model)) return
      if (!isTopLevel(hookInput.agent)) return
      if (!Array.isArray(output?.parts) || output.parts.length === 0) return

      const state = await ensureState(hookInput.sessionID)
      if ((mode !== "zero" && mode !== "whoami") || state.phase !== "bootstrap" || state.anchored) return

      const realParts = structuredClone(output.parts)
      const sourcePart = output.parts[0]
      const anchorPart = {
        // TextPart requires id/sessionID/messageID; reuse the original part's
        // identity so the persisted anchor turn passes the schema check.
        id: sourcePart?.id,
        type: "text",
        text: mode === "whoami" ? whoamiText : ANCHOR_TEXT,
        sessionID: sourcePart?.sessionID ?? hookInput.sessionID,
        messageID: sourcePart?.messageID ?? hookInput.messageID ?? output.message?.id,
      }

      // Must mutate the array in place: the caller keeps the same reference.
      output.parts.splice(0, output.parts.length, anchorPart)

      state.anchored = true
      state.stashed = realParts
      state.agent = hookInput.agent ?? TOP_LEVEL_AGENT
      state.model = hookInput.model
        ? { providerID: hookInput.model.providerID, modelID: hookInput.model.modelID ?? hookInput.model.id }
        : undefined
      state.variant = hookInput.variant
    },

    /** Track durable promotion signals, compaction boundaries, and re-send the stashed real prompt. */
    event: async ({ event }) => {
      if (!event?.type || !event?.properties) return
      const properties = event.properties
      const sessionID = properties.sessionID ?? properties.info?.sessionID
      if (!sessionID) return
      const state = sessions.get(sessionID)
      if (!state) return

      if (event.type === "message.updated") {
        const info = properties.info
        if (info?.role === "assistant" && typeof info.time?.completed === "number") {
          state.assistantDone = true
          if (state.phase === "bootstrap" || state.phase === "contracted") state.phase = "promoted"
        }
        return
      }

      if (event.type === "session.compacted") {
        // A compaction rewrites the whole surface: the first post-compaction
        // request is a "second first request" (upstream compaction epoch).
        if (state.mode === "anchored") {
          state.phase = "contracted"
          state.compacted = true
        }
        return
      }

      if (event.type === "session.idle" && (mode === "zero" || mode === "whoami") && state.stashed && !state.sent) {
        state.sent = true
        // Degrade-safe: never leave the user's real message unsent, even if
        // the anchor reply was aborted before becoming durable.
        if (!state.assistantDone) state.phase = "promoted"
        await sendRealPrompt(sessionID, state)
      }
    },

    /** Restrict the tool catalog while the session is not yet promoted. */
    "chat.tools": async (hookInput, output) => {
      if (!isDeepSeekPro(hookInput.model)) return
      if (!isTopLevel(hookInput.agent)) return

      const state = sessions.get(hookInput.sessionID)
      if (!state) return

      // Snapshot the FULL catalog before filtering: dev_tool_search searches
      // the whole surface, not the restricted one.
      state.catalog = { ...(output.tools ?? {}) }

      if (mode === "zero" || mode === "whoami") {
        if (state.phase === "promoted") return
        if (hookInput.hasToolCalls) {
          state.phase = "promoted"
          return
        }
        // The anchor request carries no tools at all.
        for (const key of Object.keys(output.tools ?? {})) delete output.tools[key]
        return
      }

      // anchored mode: every request is filtered to the current keep-set.
      // Promotion is not a one-shot dump — the promoted phase stays on the
      // resident set (upstream: full catalog is NEVER dumped at once).
      if (hookInput.hasToolCalls) state.phase = "promoted"
      const keep = keepSetFor(state)
      for (const key of Object.keys(output.tools ?? {})) {
        if (!keep.has(key)) delete output.tools[key]
      }
    },

    /** anchored mode: optionally cap unpromoted requests (bootstrap + post-compaction). */
    "chat.params": async (hookInput, output) => {
      if (!isDeepSeekPro(hookInput.model)) return
      if (mode !== "anchored") return
      if (!isTopLevel(hookInput.agent)) return
      const state = sessions.get(hookInput.sessionID)
      const cap = state?.bootstrapMaxTokens
      if (cap && state?.phase !== "promoted") output.maxOutputTokens = cap
    },

    /** A running tool is a promotion signal; dev_tool_search unlocks names. */
    "tool.execute.before": async (hookInput, output) => {
      const state = sessions.get(hookInput.sessionID)
      if (!state) return
      if (hookInput.tool === "dev_tool_search") {
        const names = output?.args?.toolNames
        if (Array.isArray(names)) {
          for (const name of names) {
            if (typeof name === "string" && name.length > 0) state.unlocked.add(name)
          }
        }
      }
      if (state.phase === "bootstrap" || state.phase === "contracted") state.phase = "promoted"
    },

    /**
     * Keep the minimal system prompt while unpromoted (bootstrap AND
     * post-compaction contracted). After promotion, the normal opencode system
     * context returns, matching upstream's "injections return unchanged after
     * promotion" behavior.
     */
    "experimental.chat.system.transform": async (hookInput, output) => {
      if (!isDeepSeekPro(hookInput.model)) return
      if (!Array.isArray(output.system)) return
      const state = sessions.get(hookInput.sessionID)
      if (state?.phase === "promoted") return
      if ((mode === "zero" || mode === "whoami") && state?.phase !== "bootstrap") return
      output.system.splice(0, output.system.length, ...MINIMAL_SYSTEM)
    },

    /** On-demand tool discovery: search the full catalog and unlock names. */
    tool: {
      dev_tool_search: tool({
        description: [
          "Discover and unlock tools that are NOT currently available.",
          "",
          "This session starts with a minimal resident set: bash, edit, skill, dev_tool_search. Everything else is unlocked on demand through this tool.",
          "",
          "If the current task needs any of the following, call dev_tool_search FIRST — do not try to work around them with bash:",
          ...UNLOCKABLE_INDEX.map((line) => `- ${line}`),
          "",
          'Usage: pass `query` to search the catalog (returns matching tool names + descriptions), then pass `toolNames` with exact names to unlock them. Unlocked tools appear from the next request on and stay unlocked for the session.',
        ].join("\n"),
        args: {
          query: tool.schema.string().optional().describe('search keywords (e.g. "web", "subagent")'),
          toolNames: tool.schema.array(tool.schema.string()).optional().describe("exact tool names to unlock"),
        },
        async execute(args, ctx) {
          const state = sessions.get(ctx.sessionID)
          const catalog = state?.catalog ?? {}
          const query = String(args?.query ?? "").trim()
          const unlock = Array.isArray(args?.toolNames)
            ? args.toolNames.filter((name) => typeof name === "string" && name.length > 0)
            : []

          const lines = []
          if (unlock.length > 0) {
            if (state) for (const name of unlock) state.unlocked.add(name)
            lines.push(`Unlocked for the next request: ${unlock.join(", ")}`)
          }
          if (query.length === 0) {
            if (lines.length === 0) lines.push("Provide `query` to search the catalog, or `toolNames` to unlock tools.")
            return lines.join("\n")
          }

          const wanted = query.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean)
          const matches = Object.entries(catalog)
            .filter(([name, def]) => {
              const haystack = `${name} ${String(def?.description ?? "")}`.toLowerCase()
              return wanted.every((token) => haystack.includes(token))
            })
            .slice(0, MAX_SEARCH_RESULTS)

          if (matches.length === 0) {
            lines.push(`No tools match "${query}".`)
          } else {
            lines.push(`Matching tools (${matches.length}):`)
            for (const [name, def] of matches) {
              const desc = String(def?.description ?? "").split("\n")[0].slice(0, 90)
              lines.push(`- ${name}: ${desc}`)
            }
          }
          return lines.join("\n")
        },
      }),
    },
  }
}
