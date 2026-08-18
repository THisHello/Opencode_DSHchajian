/**
 * router-flash-deepseek.js — opencode port of dsh-router-standard, synced to
 * upstream v0.1.1 (main 9727510), scoped to DeepSeek V4 Flash only.
 *
 * Reads the session's first top-level user message, classifies the task into
 * one of the measured behavior bands (spec / mixed / react) or weak (the
 * model routes itself), and applies the matching persona + first-turn core
 * tool surface. After the first durable tool call the full catalog opens.
 *
 * Upstream v0.1.1 (current) behavior ported here:
 *  - classify -> persona + sections preserved + core tool surface.
 *  - No RL-interface, no PTC/Code Mode, no We-Team protocol injection.
 *  - Near-field weak-mode guidance is the simple Router classify text
 *    (GUIDE_DEEP for complex tasks, GUIDE_WEAK otherwise).
 *  - weak band first-turn core = read/write/edit + bash.
 *
 * opencode adaptations:
 *  - `run_code` is retained as an opencode convenience tool (one-shot program
 *    execution with bun/node/deno/python/bash). Upstream v0.1.1 itself does
 *    not define run_code; it is not part of the routed first-turn surface and
 *    is only visible after promotion.
 *  - opencode has no DSH section model; the router persona is kept in the
 *    system prompt for the whole session.
 *  - str_replace_editor analogue is `edit` (same mapping as anchor-deepseek.js).
 *
 * In all modes:
 *  - the persona stays in the system prompt for the WHOLE session,
 *  - near-field routing guidance follows every real user message in weak
 *    mode (depth-adaptive: GUIDE_DEEP for complex tasks, GUIDE_WEAK
 *    otherwise),
 *  - the session promotes to the full catalog after the first durable tool
 *    call (upstream promotes on tool/call only, NOT on a text-only reply).
 *  Mode and override are per-session and derived from durable history on
 *  resume.
 *
 * Model matching is provider-agnostic: only the model id matters
 * (deepseek + v4 + flash). dev_router_status / dev_router_mode expose the
 * routing to the agent. dev_mode_subagent is NOT ported: opencode plugins
 * have no raw LLM streaming API to run a mode-isolated subagent.
 */

import { tool } from "@opencode-ai/plugin"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"

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
  + "Before acting, briefly review what you have already done in this session and continue from where you left off; do not repeat completed steps. Do not run environment checks (echo, whoami, uname, node --version, date) or exhaustive grep/glob scans."

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

/** First-turn core tools (shell added dynamically by the plugin); upstream
 *  v0.1.1 `coreFor`. */
function coreFor(mode) {
  switch (bandOf(mode)) {
    case "spec":
      return ["read", "edit", "glob", "grep"] // read-first
    case "transition":
      return ["read", "edit", "write", "glob", "grep"] // union
    default:
      return ["read", "write", "edit"] // write-first
  }
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

/**
 * run_code opencode adaptation.
 *
 * DSH's run_code executes a TypeScript program against the generated SDK in
 * one shot. opencode has no SDK and no presentation switch, so this helper
 * writes the supplied program to a temp file and runs it once with the best
 * available runtime. The one-shot "program execution" semantics are preserved;
 * the SDK-specific surface is not available outside DSH Harness.
 */
async function resolveRunCodeRuntime($, language) {
  const candidates =
    language === "python" ? ["python3", "python"]
      : language === "shell" ? ["bash", "sh"]
        : ["bun", "node", "deno"]
  for (const name of candidates) {
    const probe = await $`command -v ${name}`.nothrow().quiet()
    if (probe.exitCode === 0) return name
  }
  throw new Error(`run_code: no runtime found for ${language}; tried: ${candidates.join(", ")}`)
}

async function executeRunCode($, runtime, language, file, workdir) {
  const runArgs = language === "typescript" && runtime === "deno"
    ? [runtime, "run", file]
    : [runtime, file]
  const result = await $`${runArgs}`.cwd(workdir).nothrow().quiet()
  const stdout = result.stdout ? result.stdout.toString() : ""
  const stderr = result.stderr ? result.stderr.toString() : ""
  const output = [stdout, stderr].filter((part) => part.length > 0).join("\n")
  if (result.exitCode !== 0) {
    throw new Error(output || `run_code exited with code ${result.exitCode} (no output)`)
  }
  return output || `run_code exited with code 0 (no output)`
}

export const RouterFlashDeepSeek = async (input = {}, options = {}) => {
  const client = input.client
  const $ = input.$

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
      const keep = new Set(coreFor(effective))
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
     *  Upstream v0.1.1 preserves the non-persona sections and injects the
     *  router persona; opencode's system parts have no stable section names,
     *  so replace the first part (the default persona) and keep any
     *  additional system parts. */
    "experimental.chat.system.transform": async (hookInput, output) => {
      if (!isDeepSeekFlash(hookInput.model)) return
      if (!Array.isArray(output.system)) return
      const state = sessions.get(hookInput.sessionID)
      if (!state) return
      const effective = state.override !== null ? state.override : state.mode ?? MODE_WEAK
      const persona = personaFor(effective)
      if (output.system.length === 0) output.system.push(persona)
      else output.system[0] = persona
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
          const persona = personaFor(mode)
          const core = [...coreFor(mode), "bash"]
          return [
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
      run_code: tool({
        description: [
          "Execute a program in one shot (opencode adaptation of DSH Harness's run_code).",
          "",
          "Writes the supplied code to a temporary file and runs it once with the best available runtime: bun/node/deno for TypeScript or JavaScript, python3/python for Python, bash for shell.",
          "",
          "Use for batched multi-step operations that would otherwise take many tool round-trips — write one program, run it, read the result, iterate.",
          "",
          "The generated-SDK surface of DSH's run_code is not available in opencode; this is plain program execution against the session environment.",
        ].join("\n"),
        args: {
          code: tool.schema
            .string()
            .describe("the program source to execute"),
          language: tool.schema
            .enum(["typescript", "javascript", "python", "shell"])
            .optional()
            .describe("program language (default: typescript)"),
          workdir: tool.schema
            .string()
            .optional()
            .describe("working directory for the run (default: session directory)"),
        },
        async execute(args, ctx) {
          if (!$) return "run_code: no shell available in this plugin context"
          const code = String(args?.code ?? "")
          if (!code.trim()) return "run_code: empty `code` — provide a program to execute"
          const language = args?.language ?? "typescript"
          const workdir = args?.workdir
            ? (isAbsolute(args.workdir) ? args.workdir : resolve(ctx.directory, args.workdir))
            : ctx.directory
          const ext =
            language === "python" ? "py"
              : language === "shell" ? "sh"
                : language === "javascript" ? "js"
                  : "ts"
          let dir
          try {
            dir = await mkdtemp(join(tmpdir(), "opencode-run-code-"))
            const file = join(dir, `main.${ext}`)
            await writeFile(file, code, "utf8")
            const runtime = await resolveRunCodeRuntime($, language)
            return await executeRunCode($, runtime, language, file, workdir)
          } catch (error) {
            return `run_code failed: ${String((error && error.message) || error)}`
          } finally {
            if (dir) {
              try { await rm(dir, { recursive: true, force: true }) } catch { /* best-effort cleanup */ }
            }
          }
        },
      }),
    },
  }
}
