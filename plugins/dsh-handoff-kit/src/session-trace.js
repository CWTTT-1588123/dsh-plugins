/**
 * Deterministic session metadata mining for `evidence/session.json`.
 *
 * The trace is built exclusively from `tool/call` and `tool/result` event
 * metadata: file paths touched by file tools, redacted+truncated shell
 * commands, tool-call counts and tool errors. Message bodies (`user/message`,
 * `assistant/message`, and the content of `tool/result` messages) are never
 * read, so prompt/answer text can not leak into a handoff package.
 *
 * This module is pure logic: events are supplied by the caller, time never
 * comes from a clock, ordering is derived from `event.seq`, and two runs over
 * the same input produce byte-identical output.
 *
 * @module dsh-handoff-kit/session-trace
 */

import { LIMITS, isPlainObject } from './contracts.js'
import { isAbsoluteAny, isInside, relativeToWorkspace, toPosix, tokenizePath } from './paths.js'
import { redactText } from './redact.js'

/**
 * Model-facing file tools whose path arguments describe touched files.
 * @type {ReadonlyArray<string>}
 */
export const FILE_TOOLS = Object.freeze([
  'write',
  'edit',
  'read',
  'read_image',
  'str_replace_editor',
  'glob',
  'grep'
])

/**
 * Shell tools whose `command` argument is recorded (redacted and truncated).
 * @type {ReadonlyArray<string>}
 */
export const SHELL_TOOLS = Object.freeze(['pwsh', 'bash'])

/** Set form of {@link FILE_TOOLS}. */
const FILE_TOOL_SET = new Set(FILE_TOOLS)
/** Set form of {@link SHELL_TOOLS}. */
const SHELL_TOOL_SET = new Set(SHELL_TOOLS)
/**
 * Path-argument keys recognized on file tools, in fixed precedence order.
 * `glob`/`grep` also carry their root in `path`.
 */
const PATH_ARGUMENT_KEYS = Object.freeze(['path', 'file_path', 'filePath', 'target'])
/** Opening delimiter of a redaction placeholder (kept in sync with redact.js). */
const PLACEHOLDER_OPEN = '«'
/** Closing delimiter of a redaction placeholder. */
const PLACEHOLDER_CLOSE = '»'

/** Deterministic ASCII/locale-independent string comparator. */
function compareStrings(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/** First `count` characters of a string, without locale-sensitive helpers. */
function sliceChars(value, count) {
  return value.slice(0, Math.max(0, count))
}

/**
 * Truncate redacted command text to `maxChars` without slicing a redaction
 * placeholder in half. A half placeholder such as `«REDACTED:generic-assign`
 * is not a secret, but it would look like an unredacted assignment to the
 * artifact final check, so the fragment is dropped instead.
 * @param {string} text redacted command text.
 * @param {number} maxChars maximum number of characters to keep.
 * @returns {string}
 */
function truncateRedacted(text, maxChars) {
  if (text.length <= maxChars) return text
  let cut = sliceChars(text, maxChars)
  const lastOpen = cut.lastIndexOf(PLACEHOLDER_OPEN)
  if (lastOpen >= 0 && cut.indexOf(PLACEHOLDER_CLOSE, lastOpen) < 0) cut = cut.slice(0, lastOpen)
  return cut
}

/**
 * Parse the raw `arguments` payload of a tool/call event.
 *
 * Real session events store the JSON string the model produced; tests may pass
 * an already parsed plain object. Anything else (missing, malformed JSON,
 * arrays, scalars) yields `null` and is ignored.
 * @param {unknown} raw
 * @returns {Record<string, unknown>|null}
 */
function parseEventArgs(raw) {
  if (isPlainObject(raw)) return raw
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed === '') return null
  try {
    const parsed = JSON.parse(trimmed)
    return isPlainObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Normalize the caller-provided bounds, falling back to
 * {@link LIMITS} for anything missing or invalid.
 * @param {unknown} limits
 * @returns {{sessionMaxEvents:number, sessionMaxFiles:number,
 *   sessionMaxCommands:number, sessionMaxCommandChars:number}}
 */
function resolveSessionLimits(limits) {
  const source = isPlainObject(limits) ? limits : {}
  const pick = (key, fallback) =>
    Number.isInteger(source[key]) && source[key] >= 0 ? source[key] : fallback
  return {
    sessionMaxEvents: pick('sessionMaxEvents', LIMITS.sessionMaxEvents),
    sessionMaxFiles: pick('sessionMaxFiles', LIMITS.sessionMaxFiles),
    sessionMaxCommands: pick('sessionMaxCommands', LIMITS.sessionMaxCommands),
    sessionMaxCommandChars: pick('sessionMaxCommandChars', LIMITS.sessionMaxCommandChars)
  }
}

/** `sessionId` as written into the trace: a non-empty string or `null`. */
function normalizeSessionId(sessionId) {
  return typeof sessionId === 'string' && sessionId !== '' ? sessionId : null
}

/** `event.seq` when it is a finite number, else the window index (defensive fallback). */
function sequenceOf(event, index) {
  return Number.isFinite(event.seq) ? event.seq : index
}

/**
 * Render one touched path for the trace: workspace paths become relative POSIX
 * paths, `$DSH_HOME` paths are tokenized, anything else stays a POSIX absolute
 * path; relative input is kept (with `./` removed and separators normalized).
 * @param {string} rawPath path string extracted from tool arguments.
 * @param {{workspaceRoot?: string, dshHome?: string}} contexts
 * @returns {string|null} display path, or `null` when it carries no file.
 */
function displayTouchedPath(rawPath, contexts) {
  const trimmed = rawPath.trim()
  if (trimmed === '') return null
  const workspaceRoot = typeof contexts.workspaceRoot === 'string' ? contexts.workspaceRoot : ''
  const dshHome = typeof contexts.dshHome === 'string' ? contexts.dshHome : ''

  if (isAbsoluteAny(trimmed)) {
    if (workspaceRoot !== '' && isInside(workspaceRoot, trimmed)) {
      const relativePath = relativeToWorkspace(workspaceRoot, trimmed)
      if (relativePath === undefined || relativePath === '') return null
      return relativePath
    }
    return tokenizePath(trimmed, { workspaceRoot, dshHome })
  }

  let normalized = toPosix(trimmed)
  while (normalized.startsWith('./')) normalized = normalized.slice(2)
  if (normalized === '' || normalized === '.') return null
  return normalized
}

/**
 * `tool/result` error rule: `data.error != null` or `data.message?.isError === true`.
 * Only these two metadata fields are inspected; message content is ignored.
 * @param {unknown} data
 * @returns {boolean}
 */
function isToolResultError(data) {
  if (!isPlainObject(data)) return false
  if (data.error !== undefined && data.error !== null) return true
  const message = data.message
  return isPlainObject(message) && message.isError === true
}

/**
 * Turn a name→count map into a plain object with keys in lexicographic order
 * (object key order is observable in serialized JSON, so it must be stable).
 * @param {Map<string, number>} counts
 * @returns {Record<string, number>}
 */
function sortedCountsObject(counts) {
  const output = {}
  const names = [...counts.keys()].sort(compareStrings)
  for (const name of names) output[name] = counts.get(name)
  return output
}

/**
 * Extract the path arguments of one file-tool call.
 *
 * Only string arguments named `path`, `file_path`, `filePath` or `target` are
 * considered (fixed key order, duplicates removed). `glob`/`grep` expose their
 * root through `path`, so they are covered by the same rule. Shell tools and
 * unknown tools return an empty array.
 * @param {string} toolName tool name from the `tool/call` event.
 * @param {unknown} args already parsed tool arguments.
 * @returns {string[]} raw (not normalized or tokenized) path strings.
 */
export function extractTouchedPaths(toolName, args) {
  if (typeof toolName !== 'string' || !FILE_TOOL_SET.has(toolName)) return []
  if (!isPlainObject(args)) return []
  const paths = []
  const seen = new Set()
  for (const key of PATH_ARGUMENT_KEYS) {
    const value = args[key]
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed === '' || seen.has(trimmed)) continue
    seen.add(trimmed)
    paths.push(trimmed)
  }
  return paths
}

/**
 * Build the deterministic session trace written to `evidence/session.json`.
 *
 * Event reading is deliberately narrow: `tool/call` metadata (name, seq,
 * arguments) and `tool/result` error flags only. Every other event type is
 * ignored without touching its `data`, so message bodies can never enter the
 * trace. `events` is the caller-provided newest window (already sorted by
 * time); this function additionally enforces `limit.sessionMaxEvents` by
 * keeping the newest events.
 *
 * Trace fields, in fixed key order:
 *   - `sessionId`: string or `null`;
 *   - `eventCounts`: `{total, toolCalls, toolErrors}` where `total` is the
 *     number of session events known to the caller (`totalEvents` when
 *     supplied, otherwise the provided window length) and the tool counters are
 *     counted inside the analyzed window;
 *   - `toolCalls`: `{total, byName}` with `byName` keys in lexicographic order;
 *   - `touchedFiles`: `{path, tool, count, lastSeq}` sorted by `lastSeq`
 *     descending (ties by `path` ascending), capped at `limit.sessionMaxFiles`;
 *   - `commands`: `{tool, commandRedacted, lastSeq}` sorted by `lastSeq`
 *     descending (ties by `tool`, then command), capped at
 *     `limit.sessionMaxCommands`;
 *   - `redactionHits`: aggregated command redaction hits, sorted by `kind`;
 *   - `window`: `{events, truncated}` — events analyzed and whether the
 *     session held more events than the analyzed window.
 *
 * An unavailable session (no events) yields an empty trace; `sessionId` is
 * still written as passed (or `null`). The caller adds the warning.
 *
 * @param {{
 *   sessionId?: string|null,
 *   events?: unknown[],
 *   totalEvents?: number,
 *   contexts?: {workspaceRoot?: string, dshHome?: string},
 *   limits?: {sessionMaxEvents?: number, sessionMaxFiles?: number,
 *     sessionMaxCommands?: number, sessionMaxCommandChars?: number},
 *   redactionRules?: ReadonlyArray<{kind: string, pattern: RegExp, replacement?: string}>
 * }} [input]
 * @returns {{
 *   sessionId: string|null,
 *   eventCounts: {total: number, toolCalls: number, toolErrors: number},
 *   toolCalls: {total: number, byName: Record<string, number>},
 *   touchedFiles: Array<{path: string, tool: string, count: number, lastSeq: number}>,
 *   commands: Array<{tool: string, commandRedacted: string, lastSeq: number}>,
 *   redactionHits: Array<{kind: string, count: number}>,
 *   window: {events: number, truncated: boolean}
 * }}
 */
export function buildSessionTrace({
  sessionId = null,
  events = [],
  totalEvents,
  contexts = {},
  limits,
  redactionRules
} = {}) {
  const context = isPlainObject(contexts) ? contexts : {}
  const bounds = resolveSessionLimits(limits)
  const provided = Array.isArray(events) ? events : []
  const windowEvents =
    provided.length > bounds.sessionMaxEvents
      ? provided.slice(provided.length - bounds.sessionMaxEvents)
      : provided
  const declaredTotal =
    Number.isFinite(totalEvents) && totalEvents >= 0 ? Math.floor(totalEvents) : 0
  const knownTotal = Math.max(declaredTotal, provided.length, windowEvents.length)

  let toolCalls = 0
  let toolErrors = 0
  const callsByName = new Map()
  const filesByPath = new Map()
  const commands = []
  const redactionCounts = new Map()

  for (const [index, event] of windowEvents.entries()) {
    if (!isPlainObject(event)) continue
    if (event.type === 'tool/call') {
      const data = event.data
      if (!isPlainObject(data)) continue
      const name = typeof data.name === 'string' ? data.name.trim() : ''
      if (name === '') continue
      const seq = sequenceOf(event, index)
      toolCalls += 1
      callsByName.set(name, (callsByName.get(name) ?? 0) + 1)
      const args = parseEventArgs(data.arguments)
      if (args === null) continue

      if (FILE_TOOL_SET.has(name)) {
        for (const rawPath of extractTouchedPaths(name, args)) {
          const path = displayTouchedPath(rawPath, context)
          if (path === null) continue
          const existing = filesByPath.get(path)
          if (existing === undefined) {
            filesByPath.set(path, { path, tool: name, count: 1, lastSeq: seq })
          } else {
            existing.tool = name
            existing.count += 1
            existing.lastSeq = Math.max(existing.lastSeq, seq)
          }
        }
      } else if (SHELL_TOOL_SET.has(name)) {
        const command = typeof args.command === 'string' ? args.command : ''
        if (command.trim() === '') continue
        const redacted = redactText(command, redactionRules)
        for (const hit of redacted.hits) {
          redactionCounts.set(hit.kind, (redactionCounts.get(hit.kind) ?? 0) + hit.count)
        }
        commands.push({
          tool: name,
          commandRedacted: truncateRedacted(redacted.text, bounds.sessionMaxCommandChars),
          lastSeq: seq
        })
      }
    } else if (event.type === 'tool/result') {
      if (isToolResultError(event.data)) toolErrors += 1
    }
    // Any other event type (user/message, assistant/message, …) is ignored on
    // purpose: only `type`/`seq` metadata is read, never the message body.
  }

  const touchedFiles = [...filesByPath.values()]
    .sort(
      (left, right) => right.lastSeq - left.lastSeq || compareStrings(left.path, right.path)
    )
    .slice(0, bounds.sessionMaxFiles)

  const orderedCommands = [...commands]
    .sort(
      (left, right) =>
        right.lastSeq - left.lastSeq ||
        compareStrings(left.tool, right.tool) ||
        compareStrings(left.commandRedacted, right.commandRedacted)
    )
    .slice(0, bounds.sessionMaxCommands)

  const redactionHits = [...redactionCounts.entries()]
    .filter(([, count]) => count > 0)
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([kind, count]) => ({ kind, count }))

  return {
    sessionId: normalizeSessionId(sessionId),
    eventCounts: { total: knownTotal, toolCalls, toolErrors },
    toolCalls: { total: toolCalls, byName: sortedCountsObject(callsByName) },
    touchedFiles,
    commands: orderedCommands,
    redactionHits,
    window: { events: windowEvents.length, truncated: knownTotal > windowEvents.length }
  }
}
