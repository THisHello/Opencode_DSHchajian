/**
 * combo-deepseek.js — opencode port of dsh-anchored-standard's combo-anchored
 * preset (upstream commit a58b9c4, 2026-08-17; originally 770b6e2, plus
 * dev-tool-search truncation and context-gate documentation updates). Three
 * orthogonal anchoring mechanisms composed as independent toggles, each
 * attacking the pre-tool deliberation collapse at a different moment of a turn.
 *
 * ==================== deviation notes (one per mechanism) ====================
 *
 *   think-phase (turn opening)
 *     - Upstream: every user turn opens with step 0 on a zero-tool surface;
 *       agent.steer() injects a user-role notice IN-SIDE THE SAME turn to open
 *       the execute phase.
 *     - opencode port: there is no `agent/turn-stopping` / `agent.steer()`
 *       seam and no per-step catalog rebuild. Each user turn is therefore
 *       split into TWO chat rounds — the think round (zero-tool surface,
 *       real user message rewritten to a "plan first; do not call tools"
 *       prompt) and the execute round (the original user parts are re-sent
 *       verbatim via client.session.promptAsync once the think reply is
 *       durable). The cost is one extra LLM round per turn, matching the
 *       upstream "+1 model call/turn" budget.
 *
 *   deliberation-gate (first action)
 *     - Upstream: tools/pre-execute emits { kind: 'deny', reason:
 *       planning-prompt } to short-circuit the call with a planning
 *       directive. The deny channel materializes the payload as a tool
 *       result carrying the error flag, so the model reads "the tool
 *       executed but here's what to do next".
 *     - opencode port: tool.execute.before cannot deny-and-return — it can
 *       only `throw`. The thrown error is delivered to the model as a tool
 *       failure carrying the planning prompt. Functionally equivalent: the
 *       observable effect on the model's next round is identical to DSH's
 *       deny channel (a tool-result carrying "write out your reasoning
 *       first…" that the model reads before retrying the call).
 *
 *   cot-drip (long middle)
 *     - Upstream: tools/post-execute emits
 *       { kind: 'accept', additionalContexts: [notice] }, appending a
 *       user-role notice to the tool-result batch in the NEXT request of
 *       the SAME turn.
 *     - opencode port: there is no tools/post-execute and no in-turn
 *       additionalContexts seam. This port defers the drip notice to the
 *       NEXT chat.tools / system.transform invocation following every Nth
 *       tool result and prepends it to the system prompt instead of a user
 *       message. The invariant "never blocks, never errors" holds; the
 *       cadence per-turn (every / maxPerTurn) holds; the delivery surface
 *       differs (system prompt instead of in-turn user notice).
 *
 * Wire-think-standard (the OTHER upstream preset, deepseek-wire-think sibling
 * route with tool_choice:"none" on the wire) is NOT ported here. opencode's
 * plugin layer has no llm registry, no per-step provider routing, and no
 * wire-level tool_choice seam — the preset's entire mechanism cannot reach
 * the opencode plugin boundary. The wire-think condition is statically
 * equivalent at the model's observable surface to the zero-tool think
 * condition this port already supplies (tools hidden + think-only notice),
 * so combo's think-phase is also the closest opencode approximation of
 * wire-think-standard's standalone behavior.
 *
 * ============================ switches ====================================
 *
 *   COMBO_MODE env (default "combo"):
 *     "combo" | "all"                    — all three mechanisms on
 *     "think" | "think-phase"             — think-phase only
 *     "gate" | "deliberation-gate"        — deliberation-gate only
 *     "drip" | "cot-drip"                 — cot-drip only
 *     "think,gate" comma-separated list  — pick a subset
 *     "off" | "none"                      — disable the whole plugin
 *
 *   Per-mechanism tunables:
 *     COMBO_GATE_MIN_CHARS (default 400)
 *     COMBO_GATE_MAX_PER_TURN (default 1)
 *     COMBO_DRIP_EVERY (default 4; 0 disables)
 *     COMBO_DRIP_MAX_PER_TURN (default 1)
 *
 * Subagents are never combo'd: only top-level DeepSeek V4 Pro sessions are
 * touched. v4 Flash is handled by router-flash-deepseek.js. This file does
 * NOT modify anchor-deepseek.js / router-flash-deepseek.js / eternal-minimal-
 * deepseek.js — they can coexist (each plugin owns its own session-state map).
 */

// ── mechanism defaults ─────────────────────────────────────────────────────

const THINK_PREFIX = [
  "Your FIRST reply must be pure reasoning only — write the full 'We …' plan",
  "for the task below; do not call any tools in this round. After your plan,",
  "close the reply. Execution is enabled in the very next round; do not start",
  "it here.",
  "",
  "TASK:",
].join("\n")

const STEER_TEXT = [
  "The thinking round is complete and all tools are now open.",
  "Proceed to execute the plan you laid out in your previous message, using the available tools.",
  "If that message already fully answers the user and no file, command, or verification work remains,",
  "restate the final answer concisely and finish.",
].join(" ")

const GATE_TEXT = [
  "Deliberation gate: this turn has not shown its reasoning yet.",
  "Before retrying this tool call, write out your full reasoning in your reply —",
  "start with \"We\", restate the goal, weigh the approaches, and lay out the concrete steps and risks",
  "— then issue the tool call again. This message is a planning prompt, not a tool failure.",
].join(" ")

const DRIP_TEXT = [
  "Progress check: before the next action, restate in one \"We …\" sentence",
  "what remains of the goal and why the next step is the right one.",
].join(" ")

const BOOTSTRAP_TOOLS = new Set(["bash", "edit"])
const RESIDENT_DISCOVERY_TOOLS = ["skill", "dev_tool_search"]
const MINIMAL_SYSTEM = ["You are a helpful software engineer assistant."]
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

const DEFAULT_GATE_MIN_CHARS = 400
const DEFAULT_GATE_MAX_PER_TURN = 1
const DEFAULT_DRIP_EVERY = 4
const DEFAULT_DRIP_MAX_PER_TURN = 1

const TRUTHY = (value) => value === "1" || value === "true" || value === "yes"

// ── option parsing ─────────────────────────────────────────────────────────

// Default is OFF so anchor-deepseek.js stays the session's owner unless the
// user requests combo explicitly. Setting COMBO_MODE=combo (or "all", or a
// comma-separated subset) activates this plugin; the user MUST also disable
// anchor-deepseek (ANCHOR_MODE=off or "combo"/"eternal" which anchor's
// pickMode now recognizes as "off").
function pickCombo(options) {
  const raw = String(options?.comboMode ?? process.env.COMBO_MODE ?? "off").trim().toLowerCase()
  if (raw === "off" || raw === "none") return { think: false, gate: false, drip: false }
  if (raw === "combo" || raw === "all") return { think: true, gate: true, drip: true }
  const list = raw.split(/[,\s]+/).filter(Boolean)
  return {
    think: list.includes("think") || list.includes("think-phase"),
    gate: list.includes("gate") || list.includes("deliberation-gate"),
    drip: list.includes("drip") || list.includes("cot-drip"),
  }
}

function gateMinChars(options) {
  const raw = options?.gateMinChars ?? process.env.COMBO_GATE_MIN_CHARS ?? DEFAULT_GATE_MIN_CHARS
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) return DEFAULT_GATE_MIN_CHARS
  return Math.floor(value)
}

function gateMaxPerTurn(options) {
  const raw = options?.gateMaxPerTurn ?? process.env.COMBO_GATE_MAX_PER_TURN ?? DEFAULT_GATE_MAX_PER_TURN
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) return DEFAULT_GATE_MAX_PER_TURN
  return value
}

function dripEvery(options) {
  const raw = options?.dripEvery ?? process.env.COMBO_DRIP_EVERY ?? DEFAULT_DRIP_EVERY
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) return DEFAULT_DRIP_EVERY
  return value
}

function dripMaxPerTurn(options) {
  const raw = options?.dripMaxPerTurn ?? process.env.COMBO_DRIP_MAX_PER_TURN ?? DEFAULT_DRIP_MAX_PER_TURN
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) return DEFAULT_DRIP_MAX_PER_TURN
  return value
}

// ── model + scope gates ─────────────────────────────────────────────────────

function isDeepSeekPro(model) {
  if (!model) return false
  const id = String(model.id ?? model.modelID ?? "").toLowerCase()
  return id.includes("deepseek") && id.includes("v4") && id.includes("pro")
}

function isTopLevel(agent) {
  return (agent ?? TOP_LEVEL_AGENT) === TOP_LEVEL_AGENT
}

function extractText(parts) {
  return (parts ?? [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
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

/** count reasoning/text chars of one assistant message from its parts list. */
function assistantChars(parts) {
  if (!Array.isArray(parts)) return 0
  let sum = 0
  for (const part of parts) {
    if (part?.type === "text" && typeof part.text === "string") sum += part.text.length
    else if (part?.type === "reasoning" && typeof part.text === "string") sum += part.text.length
  }
  return sum
}

// ── plugin ──────────────────────────────────────────────────────────────────

export const ComboDeepSeek = async (input = {}, options = {}) => {
  const client = input.client
  const flags = pickCombo(options)
  const gateMin = gateMinChars(options)
  const gateMax = gateMaxPerTurn(options)
  const dripCadence = dripEvery(options)
  const dripMax = dripMaxPerTurn(options)

  if (!flags.think && !flags.gate && !flags.drip) return {}

  /** sessionID -> per-session combo state (process local, like DSH plugins). */
  const sessions = new Map()

  const ensureState = (sessionID) => {
    if (!sessionID) return undefined
    const existing = sessions.get(sessionID)
    if (existing) return existing
    const state = {
      phase: "execute",
      anchored: false,
      stashed: undefined,
      agent: TOP_LEVEL_AGENT,
      model: undefined,
      variant: undefined,
      sent: false,             // think → execute handoff already done for the current turn
      assistantDone: false,
      expectingExecuteRound: false,
      unlocked: new Set(),     // names explicitly unlocked via dev_tool_search
      catalog: undefined,
      recentChars: 0,          // per-turn deliberation-depth proxy
      recentGates: 0,          // per-turn gates already fired
      toolResults: 0,          // per-turn executed-tool-result count
      drips: 0,                // per-turn drip notices already injected
      dripPending: false,      // next system.transform should prepend a drip
    }
    sessions.set(sessionID, state)
    return state
  }

  const sendRealPrompt = async (sessionID, state) => {
    // Tell the next chat.message to treat the incoming message as the
    // execute round (skip the think-phase rewrite).
    state.expectingExecuteRound = true
    const body = { parts: toPromptParts(state.stashed) }
    if (state.agent) body.agent = state.agent
    if (state.model) body.model = state.model
    if (state.variant) body.variant = state.variant
    try {
      if (!client?.session?.promptAsync) throw new Error("plugin client is unavailable")
      await client.session.promptAsync({ path: { id: sessionID }, body })
    } catch (error) {
      // Roll back the flag so the next real user message can still think-phase.
      state.expectingExecuteRound = false
      console.error(`[combo-deepseek] failed to forward execute round for ${sessionID}:`, error)
    }
  }

  return {
    /**
     * Called when a new user message is received, BEFORE it is persisted.
     * think-phase: rewrite the FIRST real user round of a turn into a
     * "plan only; no tools" prompt, stash the real parts, and re-send them
     * as a second round once the think reply is durable.
     */
    "chat.message": async (hookInput, output) => {
      if (!isDeepSeekPro(hookInput.model)) return
      if (!isTopLevel(hookInput.agent)) return
      if (!Array.isArray(output?.parts) || output.parts.length === 0) return

      const state = ensureState(hookInput.sessionID)
      if (!state) return

      // Per-turn cleanup (any new user message starts a fresh combo turn).
      state.recentChars = 0
      state.recentGates = 0
      state.toolResults = 0
      state.drips = 0
      state.dripPending = false
      state.assistantDone = false
      state.sent = false
      state.anchored = false

      // Track model / agent / variant for handoff promptAsync.
      state.agent = hookInput.agent ?? TOP_LEVEL_AGENT
      state.model = hookInput.model
        ? { providerID: hookInput.model.providerID, modelID: hookInput.model.modelID ?? hookInput.model.id }
        : undefined
      state.variant = hookInput.variant

      // Always record the real user parts in case think-phase rewrites them.
      state.stashed = structuredClone(output.parts)

      if (!flags.think) {
        state.phase = "execute"
        return
      }

      // PLUGIN-emitted execute round: skip think-phase rewrite so the real
      // user message reaches the engine on its second round.
      if (state.expectingExecuteRound) {
        state.expectingExecuteRound = false
        state.phase = "execute"
        return
      }

      // Real user round → rewrite into a think-phase prompt.
      state.phase = "think"
      state.anchored = true
      const realText = extractText(output.parts)
      const thinkText = `${THINK_PREFIX}\n\n${realText}`
      const sourcePart = output.parts[0]
      const thinkPart = {
        id: sourcePart?.id,
        type: "text",
        text: thinkText,
        sessionID: sourcePart?.sessionID ?? hookInput.sessionID,
        messageID: sourcePart?.messageID ?? hookInput.messageID ?? output.message?.id,
      }
      output.parts.splice(0, output.parts.length, thinkPart)
    },

    /** Restrict the catalog per phase. THINK: zero tools. EXECUTE: resident set. */
    "chat.tools": async (hookInput, output) => {
      if (!isDeepSeekPro(hookInput.model)) return
      if (!isTopLevel(hookInput.agent)) return

      const state = sessions.get(hookInput.sessionID)
      if (!state) return
      state.catalog = { ...(output.tools ?? {}) }

      if (flags.think && state.phase === "think") {
        // Zero-tool condition during the think round.
        for (const key of Object.keys(output.tools ?? {})) delete output.tools[key]
        return
      }
      // Otherwise (execute phase, or think disabled): the resident set —
      // bootstrap pair + discovery tools + explicitly unlocked names.
      if (hookInput.hasToolCalls) state.phase = "execute"
      const keep = new Set([...BOOTSTRAP_TOOLS, ...RESIDENT_DISCOVERY_TOOLS, ...state.unlocked])
      for (const key of Object.keys(output.tools ?? {})) {
        if (!keep.has(key)) delete output.tools[key]
      }
    },

    /**
     * think-phase Minimal persona during thinking; cot-drip system-injection
     * once a drip is pending. Combined here so the two mechanisms share one
     * transform pipeline step instead of stacking two system rewrites.
     */
    "experimental.chat.system.transform": async (hookInput, output) => {
      if (!isDeepSeekPro(hookInput.model)) return
      if (!isTopLevel(hookInput.agent)) return
      if (!Array.isArray(output.system)) return

      const state = sessions.get(hookInput.sessionID)
      if (!state) return

      if (flags.think && state.phase === "think") {
        output.system.splice(0, output.system.length, ...MINIMAL_SYSTEM)
      }
      if (flags.drip && dripCadence > 0 && state.dripPending && state.phase !== "think") {
        state.dripPending = false
        state.drips += 1
        // Prepend a "We …" beat to the assembled system so the model reads it
        // before its next deliberation, mirroring upstream's additionalContexts.
        output.system.unshift(DRIP_TEXT)
      }
    },

    /**
     * Two mechanisms meet here:
     *   deliberation-gate — deny the call with the planning directive while
     *     the turn has not shown reasoning past the gate threshold.
     *   think-phase       — any tool call during the think round is forbidden
     *     by construction (catalog is empty there), but a model that mentions
     *     a tool anyway gets a clear fail reason.
     * dev_tool_search also records unlocks here.
     */
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

      if (flags.think && state.phase === "think") {
        const error = new Error(
          "Think-phase round: tools are not open yet. Finish your reasoning reply and close it; execution opens in the next round.",
        )
        throw error
      }

      if (!flags.gate) return
      if (state.recentGates >= gateMax) return
      if (state.recentChars >= gateMin) return

      state.recentGates += 1
      const error = new Error(GATE_TEXT)
      // Tag the error so the failure reads as a planning prompt, not a crash.
      error.code = "DELIBERATION_GATE"
      throw error
    },

    /** cot-drip cadence: increment per tool result; arm a drip on every Nth. */
    "tool.execute.after": async (hookInput) => {
      const state = sessions.get(hookInput.sessionID)
      if (!state) return
      if (!flags.drip || dripCadence === 0) return
      if (state.phase === "think") return  // never drip mid-think

      state.toolResults += 1
      if (state.toolResults % dripCadence === 0 && state.drips < dripMax) {
        state.dripPending = true
      }
    },

    /** Track durable promotion + handoff signals; re-send the stashed prompt. */
    "event": async ({ event }) => {
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
          if (flags.think && state.phase === "think") state.phase = "execute"
          // Refresh per-turn deliberation-depth proxy from the finalized
          // parts the server attached to the update event.
          const parts = Array.isArray(properties.parts) ? properties.parts : []
          state.recentChars = assistantChars(parts)
        }
        return
      }

      if (event.type === "message.part.updated") {
        // Per-part recomputation: more reactive than message.updated but
        // only adjusts monotonically (we always take the whole-message sum).
        const info = properties.info
        const parts = Array.isArray(properties.parts)
          ? properties.parts
          : (properties.part ? [properties.part] : [])
        if (info?.role === "assistant" || info === undefined) {
          const chars = assistantChars(parts)
          if (chars > state.recentChars) state.recentChars = chars
        }
        return
      }

      if (event.type === "session.compacted") {
        // Drop phase bookkeeping so the post-compaction first request reboots
        // cleanly; the resident set is identical upstream, so no contracted
        // phase handling is needed in this port.
        state.phase = "execute"
        state.anchored = false
        state.sent = false
        state.expectingExecuteRound = false
        state.recentChars = 0
        state.recentGates = 0
        state.toolResults = 0
        state.drips = 0
        state.dripPending = false
        return
      }

      if (event.type === "session.idle") {
        if (flags.think && state.phase === "think" && state.stashed && !state.sent) {
          state.sent = true
          state.phase = "execute"
          if (!state.assistantDone) state.phase = "execute"
          await sendRealPrompt(sessionID, state)
        }
      }
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
          const all = Object.entries(catalog)
            .filter(([name, def]) => {
              const haystack = `${name} ${String(def?.description ?? "")}`.toLowerCase()
              return wanted.every((token) => haystack.includes(token))
            })
          const matches = all.slice(0, MAX_SEARCH_RESULTS)

          if (all.length === 0) {
            lines.push(`No tools match "${query}".`)
          } else {
            lines.push(`Matching tools (${matches.length}${all.length > MAX_SEARCH_RESULTS ? ` of ${all.length}` : ""}):`)
            for (const [name, def] of matches) {
              const desc = String(def?.description ?? "").split("\n")[0].slice(0, 90)
              lines.push(`- ${name}: ${desc}`)
            }
            if (all.length > MAX_SEARCH_RESULTS) {
              lines.push(`(truncated at ${MAX_SEARCH_RESULTS} — add tokens to narrow the query, e.g. "mcp browser" or "mcp tavily")`)
            }
            lines.push('Unlock with dev_tool_search({"toolNames": ["<exact name>"]}).')
          }
          return lines.join("\n")
        },
      }),
    },
  }
}