/**
 * eternal-minimal-deepseek.js — opencode port of dsh-anchored-standard's
 * eternal-minimal preset (upstream commit a58b9c4, 2026-08-17; originally
 * 83494b7, plus dev-tool-search truncation and the frozen-design context-gate
 * note).
 *
 * ================================== deviation note ==================================
 * Upstream eternal-minimal hides the whole catalog behind a `dshx` bash
 * gateway: a `tools/pre-execute` listener intercepts `dshx <tool> '<json>'`
 * shell commands, dispatches through `ctx.tools.execute(...)` (the full
 * DeepSeek Harness registry pipeline), and returns the rendered output via
 * the deny channel as the bash result. opencode's `tool.execute.before`
 * hook can only `throw` (fail the tool) — it has no deny-and-return
 * short-circuit, and the plugin layer exposes no way to invoke another
 * registered tool's execute().  opencode also lacks the `tools/pre-execute`
 * + `ctx.tools.execute()` seam entirely.
 *
 * This port keeps the Minimal pair (bash + edit) plus ONE extra resident:
 * `dev_tool_search`. dev_tool_search exposes the full opencode registered
 * catalog to the model so heavier tools (webfetch, search, task, todowrite,
 * question, write/read/glob/grep, patch, lsp) unlock on demand and execute
 * through opencode's normal pipeline — the closest API-equivalent to the
 * upstream "dshx dispatches the real tool" pattern.
 *
 * Trade-off: the model sees 3 tools, not 2. Eternal-Minimal's core upstream
 * invariant — "the model-visible catalog NEVER grows past the Minimal pair" —
 * is therefore PARTIALLY violated. The invariant that DOES hold: the
 * visible catalog never grows by ITSELF; each heavier tool requires an
 * explicit dev_tool_search call to unlock. Persona byte-purity (Minimal
 *  sentence + no auto-injected context restored after promotion is N/A here
 *  because there is never a promotion boundary) is preserved.
 *
 * FROZEN DESIGN NOTE (upstream 2026-08-17): the permanent per-request
 * context strip is intentionally NOT migrated to the shared context-gate in
 * the upstream repository; this port keeps the same permanent Minimal
 * persona and resident set.
 * ====================================================================================
 *
 * Mode (default "eternal"; override with COMBO_MODE / ETERNAL_MODE env):

 *  "eternal": the model-visible catalog stays {bash, edit, dev_tool_search}
 *    for the WHOLE session. Auto-injected context is stripped on every
 *    request (no promotion boundary). Heavier Standard tools unlock on
 *    demand through dev_tool_search. "skill" stays visible as the one
 *    resident discovery tool besides dev_tool_search.
 *  "off": disable this plugin while keeping the file installed (alias "none").
 *
 * Subagents are never eternal. Model matching is provider-agnostic: only the
 * model id matters (deepseek + v4 + pro). v4 Flash is handled by
 * router-flash-deepseek.js. This plugin does NOT modify existing presets
 * (anchor-deepseek.js / router-flash-deepseek.js): both can coexist.
 */

import { tool } from "@opencode-ai/plugin"

const BOOTSTRAP_TOOLS = new Set(["bash", "edit"])
// Share the resident discovery roster with anchor-deepseek.js so heavier
// tools unlock through the same mechanism in both modes.
const RESIDENT_DISCOVERY_TOOLS = ["skill", "dev_tool_search"]

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

const MINIMAL_SYSTEM = ["You are a helpful software engineer assistant."]
const TOP_LEVEL_AGENT = "build"
const MAX_SEARCH_RESULTS = 25

// Default is OFF so anchor-deepseek.js stays the session's owner unless the
// user requests eternal-minimal explicitly. Setting ETERNAL_MODE=eternal (or
// ANCHOR_MODE=eternal if ETERNAL_MODE is unset) activates this plugin; the
// user MUST also disable anchor-deepseek (ANCHOR_MODE=off or one of the new
// aliases anchor-deepseek now recognizes: "eternal"/"combo").
function pickMode(options) {
  const value = String(
    options?.mode ?? process.env.ETERNAL_MODE ?? process.env.ANCHOR_MODE ?? "off",
  ).trim().toLowerCase()
  if (value === "eternal") return "eternal"
  if (value === "off" || value === "none") return "off"
  // All other recognized modes (zero/anchored/whoami/combo) mean: let
  // anchor-deepseek or combo-deepseek own this session; stand down.
  return "off"
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
      if (Array.isArray(names)) {
        for (const name of names) {
          if (typeof name === "string" && name.length > 0) unlocked.add(name)
        }
      }
    }
  }
  return unlocked
}

export const EternalMinimalDeepSeek = async (input = {}, options = {}) => {
  const client = input.client
  const mode = pickMode(options)

  if (mode === "off") return {}

  /** sessionID -> per-session eternal state (process local, like DSH plugins). */
  const sessions = new Map()

  const ensureState = async (sessionID) => {
    if (!sessionID) return undefined
    const existing = sessions.get(sessionID)
    if (existing) return existing

    const messages = []
    try {
      if (client?.session?.messages) {
        const raw = await client.session.messages({ path: { id: sessionID }, query: { limit: 100 } })
        const list = Array.isArray(raw) ? raw : raw?.data
        if (Array.isArray(list)) {
          for (const item of list) messages.push(item)
        }
      }
    } catch (error) {
      console.error("[eternal-minimal-deepseek] session history probe failed:", error)
    }

    const state = {
      mode,
      unlocked: unlockedFromMessages(messages),
      catalog: undefined,
    }
    sessions.set(sessionID, state)
    return state
  }

  return {
    /** Restrict the tool catalog to the eternal Minimal pair on EVERY request. */
    "chat.tools": async (hookInput, output) => {
      if (!isDeepSeekPro(hookInput.model)) return
      if (!isTopLevel(hookInput.agent)) return

      const state = await ensureState(hookInput.sessionID)
      if (!state) return

      // Snapshot the FULL catalog before filtering: dev_tool_search searches
      // the whole surface, not the restricted one.
      state.catalog = { ...(output.tools ?? {}) }

      const keep = new Set([...BOOTSTRAP_TOOLS, ...RESIDENT_DISCOVERY_TOOLS, ...state.unlocked])
      for (const key of Object.keys(output.tools ?? {})) {
        if (!keep.has(key)) delete output.tools[key]
      }
    },

    /** Minimal persona on every request — no promotion boundary, ever. */
    "experimental.chat.system.transform": async (hookInput, output) => {
      if (!isDeepSeekPro(hookInput.model)) return
      if (!isTopLevel(hookInput.agent)) return
      if (!Array.isArray(output.system)) return
      output.system.splice(0, output.system.length, ...MINIMAL_SYSTEM)
    },

    /** A running dev_tool_search unlocks names for the rest of the session. */
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
    },

    /** On-demand tool discovery: search the full catalog and unlock names. */
    tool: {
      dev_tool_search: tool({
        description: [
          "Discover and unlock tools that are NOT currently available.",
          "",
          "This session is in Eternal Minimal mode: only bash, edit, skill, and dev_tool_search are visible by default. Everything else is unlocked on demand through this tool.",
          "",
          "If the current task needs any of the following, call dev_tool_search FIRST — do not try to work around them with bash:",
          ...UNLOCKABLE_INDEX.map((line) => `- ${line}`),
          "",
          'Usage: pass `query` to search the catalog (returns matching tool names + descriptions), then pass `toolNames` with exact names to unlock them. Unlocked tools appear from the next request on and stay unlocked for the session.',
        ].join("\n"),
        args: {
          query: tool.schema.string().optional().describe('search keywords (e.g. "web", "subagent")'),
          toolNames: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe("exact tool names to unlock"),
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
            if (state) {
              for (const name of unlock) state.unlocked.add(name)
            }
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