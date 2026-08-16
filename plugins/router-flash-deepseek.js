/**
 * router-flash-deepseek.js — opencode port of dsh-router-standard (v0.2.0),
 * scoped to DeepSeek V4 Flash only.
 *
 * Reads the session's first top-level user message, classifies the task into
 * one of the measured behavior bands (spec / mixed / react) or weak (the
 * model routes itself), and applies one of two ROUTER MODES:
 *
 *  "standard" (default, v0.2.0): RL interface restoration — the first-turn
 *    system prompt is ONLY the RL training sentence and the first-turn tool
 *    surface is the RL shape (shell + editor). Measured: 25 steps / 24 tool
 *    calls / real artifacts vs 101K reasoning chars with zero action on the
 *    old read/write/edit surface. The near-field weak-mode guidance and the
 *    mode/band classification stay active.
 *
 *  "spec" (v0.1.1 behavior): deep-think-first — mode-matched persona
 *    (WEAK/REACT/SPEC) + mode-matched first-turn core tool set. The long
 *    first-turn reasoning chain is a feature, not a defect.
 *
 *  Select via ROUTER_MODE=spec (env) or the plugin options { routerMode }.
 *
 * In both modes:
 *  - the persona stays in the system prompt for the WHOLE session,
 *  - near-field routing guidance follows every real user message in weak
 *    mode (depth-adaptive: GUIDE_DEEP for complex tasks, GUIDE_WEAK
 *    otherwise),
 *  - the session promotes to the full catalog after the first durable tool
 *    call (upstream promotes on tool/call only, NOT on a text-only reply).
 *  Mode and override are per-session and derived from durable history on
 *  resume. opencode's str_replace_editor analogue is `edit` (same mapping
 *  as anchor-deepseek.js).
 *
 * Model matching is provider-agnostic: only the model id matters
 * (deepseek + v4 + flash). dev_router_status / dev_router_mode expose the
 * routing to the agent. dev_mode_subagent is NOT ported: opencode plugins
 * have no raw LLM streaming API to run a mode-isolated subagent.
 */

import { tool } from "@opencode-ai/plugin"

const MODE_SPEC = 0
const MODE_MIXED = 0.3
const MODE_REACT = 1
const MODE_WEAK = "weak"

const SPEC_PERSONA = "You are a helpful software engineer assistant."

const MIXED_PERSONA =
  "You are a helpful software engineer assistant.\n"
  + "Work directly: prefer writing or editing code over describing plans. "
  + "Verify your changes by reading and running them."

const REACT_PERSONA =
  "You are a hands-on software engineer who delivers working output fast.\n"
  + "Work directly: write or edit code, then verify it by reading and running. "
  + "Keep the loop tight — produce, verify, fix — and do not build test "
  + "harnesses, scaffolding, or ceremony the user did not ask for. "
  + "Finish with a usable deliverable and a short summary."

const WEAK_FLASH =
  "You are a helpful assistant.\n"
  + "Before acting, decide the task type (build or fix) and adopt the matching "
  + "style: build → hands-on production; fix → inspect-and-plan.\n"
  + "Before acting, briefly review what you have already done in this session and continue from where you left off; do not repeat completed steps. Do not run environment checks (echo, whoami, uname, node --version, date) or exhaustive grep/glob scans.\n"
  + "Think deeply first, then produce."

/** v0.2.0 standard router mode: the RL training sentence alone. */
const RL_PERSONA = "You are a helpful software engineer assistant."

const GUIDE_WEAK =
  "\nRouter: classify this task (build or fix) now, then adopt the matching style — build: direct production; fix: inspect-first. Think deeply first, then commit and act."
const GUIDE_DEEP =
  "\nRouter: classify this task (build or fix) now, then adopt the matching style — build: direct production; fix: inspect-first. Think deeply about the architecture, edge cases, and integration points. Do not spend reasoning on the environment or tooling. Produce when your information is complete. End each reasoning block with a decision or an information need."

const COMPLEX_RE = /(重构|架构|全面|详细|设计|系统|优化|分析|survey|overview|architecture|refactor|comprehensive|detailed|design|system|optimize|analyze)/i
const REACT_RE = /(开发|创建|写一个|生成|从零|做一个|游戏|网页|网站|构建|新项目|搭建|实现|做出|上线|落地|脚本|工具|应用|build|create|develop|generate|implement|make a|new project)/gi
const SPEC_RE = /(修复|修一下|调试|重构|维护|排查|报错|出错|崩溃|优化|审查|review|fix|debug|refactor|maintain|repair|broken|break|为什么|异常|故障|迁移|升级|兼容)/gi

const TOP_LEVEL_AGENT = "build"

function isDeepSeekFlash(model) {
  if (!model) return false
  // Provider-agnostic: only the model id matters.
  const id = String(model.id ?? model.modelID ?? "").toLowerCase()
  return id.includes("deepseek") && id.includes("v4") && id.includes("flash")
}

function isTopLevel(agent) {
  return (agent ?? TOP_LEVEL_AGENT) === TOP_LEVEL_AGENT
}

function clamp01(value) {
  return Math.min(1, Math.max(0, Number(value) || 0))
}

function countHits(regex, text) {
  const re = new RegExp(regex.source, regex.flags.replace("g", "") + "g")
  return [...String(text ?? "").matchAll(re)].length
}

function bandOf(mode) {
  if (mode === MODE_WEAK) return "weak"
  const m = clamp01(mode)
  if (m < 0.2) return "spec"
  if (m < 0.5) return "transition"
  return "react"
}

function bandFor(mode) {
  return bandOf(mode) === "transition" ? "mixed" : bandOf(mode)
}

function personaFor(mode) {
  switch (bandOf(mode)) {
    case "spec":
      return SPEC_PERSONA
    case "transition":
      return MIXED_PERSONA
    case "weak":
      return WEAK_FLASH
    default:
      return REACT_PERSONA
  }
}

/** spec router mode: the v0.1.1 first-turn surface (weak walks the default
 *  branch; upstream v0.2.0 `legacyCore`). */
function legacyCore(mode) {
  switch (bandOf(mode)) {
    case "spec":
      return ["read", "edit", "glob", "grep"]
    default:
      return ["read", "write", "edit"]
  }
}

/** v0.2.0 router mode: "standard" (RL interface restoration, default) or
 *  "spec" (deep-think-first, the v0.1.1 behavior). */
function pickRouterMode(options) {
  const value = String(options?.routerMode ?? process.env.ROUTER_MODE ?? "standard").trim().toLowerCase()
  if (value === "standard" || value === "spec") return value
  console.error(`[router-flash-deepseek] unknown routerMode ${JSON.stringify(value)}, falling back to "standard"`)
  return "standard"
}

function testinessFor(mode) {
  switch (bandOf(mode)) {
    case "react":
      return "suppressed"
    case "spec":
      return "normal"
    default:
      return "light"
  }
}

function isComplexTask(text) {
  return typeof text === "string" && (text.length > 120 || COMPLEX_RE.test(text))
}

function extractText(parts) {
  return (parts ?? [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
}

function classifyTask(text) {
  const react = countHits(REACT_RE, text)
  const spec = countHits(SPEC_RE, text)
  if (react > spec) return MODE_REACT
  if (spec > react) return MODE_SPEC
  return MODE_WEAK
}

function parseMode(token) {
  if (token === undefined || token === null) return null
  const t = String(token).trim().toLowerCase()
  if (t === "auto") return "auto"
  if (t === "weak" || t === "router") return MODE_WEAK
  if (t === "spec" || t === "spec-lean") return MODE_SPEC
  if (t === "balanced" || t === "mixed") return MODE_MIXED
  if (t === "react" || t === "react-lean") return MODE_REACT
  const n = Number(t)
  if (!Number.isFinite(n)) return null
  if (t.includes(".")) return clamp01(n)
  return clamp01(n / 100)
}

function fmtMode(mode) {
  return typeof mode === "string" ? mode : mode.toFixed(2)
}

function randomToken(length) {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
  let out = ""
  for (let i = 0; i < length; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)]
  return out
}

/**
 * Part id for the injected guide that sorts AFTER every part already in the
 * message: opencode persists parts ordered by id, and native ids are
 * `prt_...` (26 chars), so extending the message's max part id by one
 * character both passes the `prt` prefix check and guarantees the guide
 * renders at the END of the user message (upstream near-field: guidance
 * follows the message). A `prt-<uuid>` id sorts BEFORE every native `prt_`
 * id ('-' < '_') and made the guide appear at the head of the message.
 */
function guidePartId(parts) {
  const ids = (parts ?? [])
    .map((part) => part?.id)
    .filter((id) => typeof id === "string" && id.startsWith("prt"))
  if (ids.length === 0) return `prt_${Date.now().toString(36)}${randomToken(10)}`
  const maxId = ids.reduce((a, b) => (a < b ? b : a))
  return `${maxId}g`
}

export const RouterFlashDeepSeek = async (input = {}, options = {}) => {
  const client = input.client
  const routerMode = pickRouterMode(options)

  /** sessionID -> per-session router state (process local, like DSH plugins). */
  const sessions = new Map()

  const ensureState = async (sessionID) => {
    if (!sessionID) return undefined
    const existing = sessions.get(sessionID)
    if (existing) return existing

    let hasUser = false
    let hasToolCall = false
    let firstText = ""
    try {
      if (client?.session?.messages) {
        const raw = await client.session.messages({ path: { id: sessionID }, query: { limit: 100 } })
        const list = Array.isArray(raw) ? raw : raw?.data
        if (Array.isArray(list)) {
          for (const item of list) {
            const info = item?.info
            const parts = Array.isArray(item?.parts) ? item.parts : []
            if (info?.role === "user") {
              hasUser = true
              if (firstText === "") firstText = extractText(parts)
            }
            if (parts.some((p) => p?.type === "tool-invocation")) hasToolCall = true
          }
        }
      }
    } catch (error) {
      console.error("[router-flash-deepseek] session history probe failed:", error)
    }

    const state = {
      mode: hasUser ? classifyTask(firstText) : undefined,
      override: null, // number | 'weak' | null
      phase: hasToolCall ? "promoted" : "bootstrap",
    }
    sessions.set(sessionID, state)
    return state
  }

  return {
    /** Called when a new message is received, BEFORE it is persisted. */
    "chat.message": async (hookInput, output) => {
      if (!isDeepSeekFlash(hookInput.model)) return
      if (!isTopLevel(hookInput.agent)) return
      if (!Array.isArray(output?.parts) || output.parts.length === 0) return

      const state = await ensureState(hookInput.sessionID)
      if (!state) return

      if (state.mode === undefined) state.mode = classifyTask(extractText(output.parts))
      const effective = state.override !== null ? state.override : state.mode
      if (effective !== MODE_WEAK) return

      // Near-field guidance: one fixed message after every real user message.
      if (output.parts.some((part) => part?.type === "text" && String(part.text).startsWith("Router:"))) return
      const text = extractText(output.parts)
      if (!text.trim()) return // upstream: never guide on empty/text-less messages
      const guide = isComplexTask(text) ? GUIDE_DEEP : GUIDE_WEAK
      output.parts.push({
        // Must sort after every existing part so the guide renders at the END
        // of the message (see guidePartId).
        id: guidePartId(output.parts),
        type: "text",
        text: guide,
        sessionID: hookInput.sessionID,
        messageID: hookInput.messageID ?? output.message?.id,
      })
    },

    /** Restrict the tool catalog until the first durable tool call. */
    "chat.tools": async (hookInput, output) => {
      if (!isDeepSeekFlash(hookInput.model)) return
      if (!isTopLevel(hookInput.agent)) return

      const state = sessions.get(hookInput.sessionID)
      if (!state) return
      if (state.phase === "promoted") return
      if (hookInput.hasToolCalls) {
        state.phase = "promoted"
        return
      }

      const effective = state.override !== null ? state.override : state.mode ?? MODE_WEAK
      // standard = RL shape (shell + editor); spec = the v0.1.1 surface.
      const core = routerMode === "standard" ? ["edit"] : legacyCore(effective)
      const keep = new Set(core)
      keep.add("bash")
      for (const key of Object.keys(output.tools ?? {})) {
        if (!keep.has(key)) delete output.tools[key]
      }
    },

    /** A durable tool call promotes the full catalog. */
    "tool.execute.before": async (hookInput) => {
      const state = sessions.get(hookInput.sessionID)
      if (state?.phase === "bootstrap") state.phase = "promoted"
    },

    /** The routed persona stays in the system prompt for the whole session.
     *  standard: only the RL training sentence (upstream strips every other
     *  section — minimal `complete: true` semantics). */
    "experimental.chat.system.transform": async (hookInput, output) => {
      if (!isDeepSeekFlash(hookInput.model)) return
      if (!Array.isArray(output.system)) return
      const state = sessions.get(hookInput.sessionID)
      if (!state) return
      const effective = state.override !== null ? state.override : state.mode ?? MODE_WEAK
      const persona = routerMode === "standard" ? RL_PERSONA : personaFor(effective)
      output.system.splice(0, output.system.length, persona)
    },

    /** Routing visibility and tuning (agent self-optimization). */
    tool: {
      dev_router_status: tool({
        description:
          "Show this session's reasoning-mode routing: mode, band, persona, first-turn core tools, test-suppression, and whether an override is active.",
        args: {},
        async execute(_args, ctx) {
          const state = sessions.get(ctx.sessionID)
          if (!state) return "no router state for this session"
          const mode = state.override !== null ? state.override : state.mode ?? MODE_WEAK
          // Effective values for the active router mode (upstream v0.2.0 shows
          // the classification view; here persona/core reflect what is really
          // injected so standard mode does not report a persona it never sent).
          const persona = routerMode === "standard" ? RL_PERSONA : personaFor(mode)
          const core = routerMode === "standard" ? ["edit", "bash"] : [...legacyCore(mode), "bash"]
          return [
            `router-mode=${routerMode} (standard=RL接口还原 / spec=深度思考优先)`,
            `mode=${fmtMode(mode)} (band=${bandFor(mode)})`,
            `persona=${persona.replace(/\n/g, " / ")}`,
            `core=[${core.join(", ")}]`,
            `testiness=${testinessFor(mode)}`,
            `override=${state.override !== null ? "yes" : "no"}`,
            `promoted=${state.phase === "promoted" ? "yes" : "no"}`,
          ].join("\n")
        },
      }),
      dev_router_mode: tool({
        description:
          "Set this session's reasoning mode: spec (plan-first) / weak (internal routing, model decides per task) / mixed (transition, trap) / react (doer). Accepts band names, 0-100, or 0.0-1.0; use auto to return to task classification. The next request applies it.",
        args: {
          mode: tool.schema
            .string()
            .describe("band name (spec / weak / mixed / react), a 0-100 number, a 0.0-1.0 number, or auto to clear the override"),
        },
        async execute(args, ctx) {
          const state = sessions.get(ctx.sessionID)
          if (!state) return "no router state for this session"
          const parsed = parseMode(args?.mode)
          if (parsed === null) {
            return `invalid mode "${args?.mode}": use spec/weak/mixed/react, 0-100, 0.0-1.0, or auto`
          }
          if (parsed === "auto") {
            state.override = null
          } else {
            state.override = parsed === MODE_WEAK ? MODE_WEAK : clamp01(parsed)
          }
          const current = state.override !== null ? state.override : state.mode ?? MODE_WEAK
          return `mode=${fmtMode(current)} (band=${bandFor(current)}) — next request applies`
        },
      }),
    },
  }
}
