/**
 * Manifest construction, canonical serialization, parsing, and shape validation.
 *
 * A manifest is the authoritative machine-readable record of one handoff batch.
 * Its top-level key order is fixed (P0 module interfaces §5, implementation plan
 * §8.2); serialization is UTF-8 with LF line endings and one trailing newline;
 * and `serializeManifest(parseManifest(text)) === text` holds for every text
 * this module produced.
 *
 * The module is pure: no clock, no randomness, no filesystem access, no
 * environment reads. Timestamps and identities are injected through `input`.
 *
 * Error policy:
 * - construction / serialization helpers reject caller bugs with
 *   `HANDOFF_INVALID_ARGS`;
 * - parsing helpers reject malformed external text with
 *   `HANDOFF_MANIFEST_INVALID`;
 * - shape problems inside an otherwise readable manifest are reported by
 *   {@link validateManifest} as findings instead of thrown.
 *
 * @module dsh-handoff-kit/manifest
 */

import { Buffer } from 'node:buffer'

import {
  BATCH_ID_RE,
  ERROR,
  MANIFEST_FILE,
  SCHEMA_ID,
  SCHEMA_VERSION,
  SCHEMA_VERSION_V2,
  SUPPORTED_SCHEMA_VERSIONS,
  TARGETS,
  generatorIdentity,
  handoffError,
  isPlainObject,
  publicLimits
} from './contracts.js'
import { normalizeArtifactPath, sha256Hex } from './paths.js'

/** Fixed top-level key order of every manifest.json. */
const MANIFEST_KEYS = Object.freeze([
  'schema',
  'schemaVersion',
  'generator',
  'batchId',
  'createdAt',
  'project',
  'session',
  'sandbox',
  'inputs',
  'git',
  'artifacts',
  'files',
  'sessionTrace',
  'redactions',
  'warnings',
  'limits',
  'scan',
  'changes',
  'fuel',
  'lineage'
])

/** Key order of the generator identity block. */
const GENERATOR_KEYS = Object.freeze(['name', 'version', 'dshVersion', 'platform'])
/** Key order of the project block. */
const PROJECT_KEYS = Object.freeze(['key', 'name', 'workspace'])
/** Key order of the session block. */
const SESSION_KEYS = Object.freeze(['id', 'cwd', 'agentPreset'])
/** Key order of the sandbox block. */
const SANDBOX_KEYS = Object.freeze(['mode', 'workspaceRoot'])
/** Key order of the caller-input block. */
const INPUT_KEYS = Object.freeze([
  'title',
  'goal',
  'summary',
  'decisions',
  'nextSteps',
  'concepts',
  'flow',
  'risks',
  'files',
  'copyFiles'
])
/** Key order of the git block (mirrors §3 `gitInfo`). */
const GIT_KEYS = Object.freeze([
  'head',
  'branch',
  'detached',
  'remote',
  'lastCommit',
  'indexVersion',
  'packedRefsPresent',
  'reflog'
])
/** Key order of one `git.lastCommit` entry. */
const LAST_COMMIT_KEYS = Object.freeze(['sha', 'time', 'subject'])
/** Key order of one `git.reflog` entry. */
const REFLOG_KEYS = Object.freeze(['sha', 'time', 'subject'])
/** Key order of one artifact entry. */
const ARTIFACT_KEYS = Object.freeze(['path', 'bytes', 'sha256'])
/** Key order of one evidence file entry. */
const FILE_KEYS = Object.freeze(['path', 'role', 'bytes', 'sha256', 'truncated', 'skippedReason'])
/** Key order of the session trace block (mirrors §2). */
const SESSION_TRACE_KEYS = Object.freeze([
  'sessionId',
  'eventCounts',
  'toolCalls',
  'touchedFiles',
  'commands',
  'window'
])
/** Key order of `sessionTrace.eventCounts`. */
const EVENT_COUNTS_KEYS = Object.freeze(['total', 'toolCalls', 'toolErrors'])
/** Key order of `sessionTrace.toolCalls`. */
const TOOL_CALLS_KEYS = Object.freeze(['total', 'byName'])
/** Key order of one touched-file entry. */
const TOUCHED_FILE_KEYS = Object.freeze(['path', 'tool', 'count', 'lastSeq'])
/** Key order of one command entry. */
const COMMAND_KEYS = Object.freeze(['tool', 'commandRedacted', 'lastSeq'])
/** Key order of `sessionTrace.window`. */
const WINDOW_KEYS = Object.freeze(['events', 'truncated'])
/** Key order of one redaction summary entry. */
const REDACTION_KEYS = Object.freeze(['file', 'kind', 'count'])
/** Key order of one warning entry. */
const WARNING_KEYS = Object.freeze(['code', 'detail'])
/** Key order of the public limits block. */
const LIMITS_KEYS = Object.freeze([
  'maxEntries',
  'maxDepth',
  'maxHashFiles',
  'maxFileBytes',
  'maxTotalBytes',
  'maxSessionEvents',
  'maxCommandChars'
])
/** Key order of the scan summary block (agreed with the service owner). */
const SCAN_KEYS = Object.freeze([
  'entries',
  'dirs',
  'denied',
  'symlinksSkipped',
  'readBytes',
  'explicitFiles',
  'tree'
])
/** Key order of one `scan.tree` entry. */
const TREE_ENTRY_KEYS = Object.freeze(['name', 'type', 'bytes'])
/** Key order of the P1 changes block. */
const CHANGES_KEYS = Object.freeze([
  'available',
  'source',
  'turn',
  'totals',
  'files',
  'diffs',
  'collectedAt',
  'note'
])
const CHANGE_TOTALS_KEYS = Object.freeze(['files', 'added', 'deleted', 'binary', 'oversized'])
const CHANGE_FILE_KEYS = Object.freeze(['path', 'added', 'deleted', 'binary', 'oversized'])
const CHANGE_DIFF_KEYS = Object.freeze(['path', 'kind', 'hunks', 'truncated'])
const HUNK_KEYS = Object.freeze(['oldStart', 'oldLines', 'newStart', 'newLines', 'lines'])
/** Key order of the P1 fuel block. */
const FUEL_KEYS = Object.freeze(['goals', 'jobs'])
const GOAL_FUEL_KEYS = Object.freeze(['available', 'goal', 'note'])
const GOAL_KEYS = Object.freeze([
  'id',
  'objective',
  'phase',
  'roundsStarted',
  'maxGoalRounds',
  'activation',
  'updatedAt'
])
const JOBS_FUEL_KEYS = Object.freeze(['available', 'count', 'statusCounts', 'items', 'note'])
const JOB_KEYS = Object.freeze(['id', 'kind', 'label', 'status', 'startedAt', 'finishedAt', 'progress'])
/** Key order of the P1 lineage block. */
const LINEAGE_KEYS = Object.freeze(['sequence', 'previous', 'root', 'supersedes'])

/** Evidence file roles, in the fixed display order used by HANDOFF H3. */
const FILE_ROLES = Object.freeze(['entry', 'config', 'test', 'doc', 'source', 'other'])

/** Lower-case hex sha256 as written into `artifacts[]` / `SHA256SUMS`. */
const SHA256_RE = /^[0-9a-f]{64}$/

/** Native Windows absolute / UNC / drive-relative spelling that must never be stored. */
const WINDOWS_ABSOLUTE_RE = /^(?:[A-Za-z]:|[\\/]{2})/

/** Severity ordering for findings; `error` sorts before `warn`. */
const SEVERITY_RANK = Object.freeze({ error: 0, warn: 1 })

/* ────────────────────────────── small helpers ────────────────────────────── */

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Rebuild one plain object with a fixed leading key order: known keys first in
 * `keys` order, then unknown keys lexicographically. Values equal to `undefined`
 * are skipped because `JSON.stringify` would drop them anyway.
 * @param {Record<string, unknown>} source
 * @param {readonly string[]} keys
 * @returns {Record<string, unknown>}
 */
function orderedObject(source, keys) {
  const out = {}
  for (const key of keys) {
    if (Object.hasOwn(source, key) && source[key] !== undefined) out[key] = source[key]
  }
  const extras = Object.keys(source)
    .filter((key) => !keys.includes(key))
    .sort(compareStrings)
  for (const key of extras) {
    if (source[key] !== undefined) out[key] = source[key]
  }
  return out
}

function invalid(detail) {
  return handoffError(ERROR.INVALID_ARGS, detail)
}

function manifestInvalid(detail) {
  return handoffError(ERROR.MANIFEST_INVALID, detail)
}

function requireString(value, label) {
  if (typeof value !== 'string' || value === '') throw invalid(`${label} must be a non-empty string`)
  return value
}

function nullableStringValue(value, label) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw invalid(`${label} must be a string or null`)
  return value
}

function integerOr(value, fallback, label) {
  if (value === undefined || value === null) return fallback
  if (!Number.isInteger(value) || value < 0) throw invalid(`${label} must be a non-negative integer`)
  return value
}

function optionalInteger(value, label) {
  if (value === undefined || value === null) return undefined
  if (!Number.isInteger(value) || value < 0) throw invalid(`${label} must be a non-negative integer`)
  return value
}

/**
 * Accept a string-or-null path that must already be tokenized. Native Windows
 * absolute spellings are rejected here so an absolute machine path can never
 * leak into HANDOFF.md; POSIX spellings are left alone because
 * `paths.tokenizePath` may legitimately return an absolute POSIX path for
 * locations outside both token roots.
 * @param {unknown} value
 * @param {string} label
 * @returns {string|null}
 */
function nullableTokenizedPath(value, label) {
  const text = nullableStringValue(value, label)
  if (text === null) return null
  if (WINDOWS_ABSOLUTE_RE.test(text))
    throw invalid(`${label} must be a tokenized path ($WORKSPACE/$DSH_HOME), got a native Windows path`)
  return text
}

function requireStringArray(value, label) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw invalid(`${label} must be an array of strings`)
  return value.map((item, index) => {
    if (typeof item !== 'string') throw invalid(`${label}[${index}] must be a string`)
    return item
  })
}

function requireSha256(value, label) {
  if (typeof value !== 'string' || !SHA256_RE.test(value))
    throw invalid(`${label} must be a lower-case hex sha256 (64 characters)`)
  return value
}

/* ──────────────────────── canonical (de)serialization ───────────────────── */

function canonicalGitValue(value) {
  if (!isPlainObject(value)) return value
  const out = orderedObject(value, GIT_KEYS)
  if (isPlainObject(out.lastCommit)) out.lastCommit = orderedObject(out.lastCommit, LAST_COMMIT_KEYS)
  if (Array.isArray(out.reflog)) {
    out.reflog = out.reflog.map((entry) =>
      isPlainObject(entry) ? orderedObject(entry, REFLOG_KEYS) : entry
    )
  }
  return out
}

function artifactPathOf(entry) {
  return isPlainObject(entry) && typeof entry.path === 'string' ? entry.path : ''
}

function compareArtifactEntries(left, right) {
  return compareStrings(artifactPathOf(left), artifactPathOf(right))
}

function canonicalArtifactsValue(value) {
  if (!Array.isArray(value)) return value
  return value
    .map((entry) => (isPlainObject(entry) ? orderedObject(entry, ARTIFACT_KEYS) : entry))
    .sort(compareArtifactEntries)
}

function canonicalFilesValue(value) {
  if (!Array.isArray(value)) return value
  return value.map((entry) => (isPlainObject(entry) ? orderedObject(entry, FILE_KEYS) : entry))
}

function canonicalSessionTraceValue(value) {
  if (!isPlainObject(value)) return value
  const out = orderedObject(value, SESSION_TRACE_KEYS)
  if (isPlainObject(out.eventCounts)) out.eventCounts = orderedObject(out.eventCounts, EVENT_COUNTS_KEYS)
  if (isPlainObject(out.toolCalls)) {
    const calls = orderedObject(out.toolCalls, TOOL_CALLS_KEYS)
    if (isPlainObject(calls.byName)) {
      const byName = {}
      for (const key of Object.keys(calls.byName).sort(compareStrings)) byName[key] = calls.byName[key]
      calls.byName = byName
    }
    out.toolCalls = calls
  }
  if (Array.isArray(out.touchedFiles)) {
    out.touchedFiles = out.touchedFiles.map((entry) =>
      isPlainObject(entry) ? orderedObject(entry, TOUCHED_FILE_KEYS) : entry
    )
  }
  if (Array.isArray(out.commands)) {
    out.commands = out.commands.map((entry) =>
      isPlainObject(entry) ? orderedObject(entry, COMMAND_KEYS) : entry
    )
  }
  if (isPlainObject(out.window)) out.window = orderedObject(out.window, WINDOW_KEYS)
  return out
}

function warningCodeOf(entry) {
  return isPlainObject(entry) && typeof entry.code === 'string' ? entry.code : ''
}

function warningDetailOf(entry) {
  return isPlainObject(entry) && typeof entry.detail === 'string' ? entry.detail : ''
}

function compareWarnings(left, right) {
  return (
    compareStrings(warningCodeOf(left), warningCodeOf(right)) ||
    compareStrings(warningDetailOf(left), warningDetailOf(right))
  )
}

function canonicalWarningsValue(value) {
  if (!Array.isArray(value)) return value
  return value
    .map((entry) => (isPlainObject(entry) ? orderedObject(entry, WARNING_KEYS) : entry))
    .sort(compareWarnings)
}

function canonicalRedactionsValue(value) {
  if (!Array.isArray(value)) return value
  return value.map((entry) => (isPlainObject(entry) ? orderedObject(entry, REDACTION_KEYS) : entry))
}

function canonicalLimitsValue(value) {
  return isPlainObject(value) ? orderedObject(value, LIMITS_KEYS) : value
}

function canonicalScanValue(value) {
  if (!isPlainObject(value)) return value
  const out = orderedObject(value, SCAN_KEYS)
  if (Array.isArray(out.tree)) {
    out.tree = out.tree.map((entry) =>
      isPlainObject(entry) ? orderedObject(entry, TREE_ENTRY_KEYS) : entry
    )
  }
  if (Array.isArray(out.files)) out.files = canonicalFilesValue(out.files)
  if (Array.isArray(out.warnings)) out.warnings = canonicalWarningsValue(out.warnings)
  return out
}

function comparePaths(left, right) {
  const leftPath = isPlainObject(left) && typeof left.path === 'string' ? left.path : ''
  const rightPath = isPlainObject(right) && typeof right.path === 'string' ? right.path : ''
  return compareStrings(leftPath, rightPath)
}

function canonicalDiffsValue(value) {
  if (!Array.isArray(value)) return value
  return [...value]
    .map((entry) => {
      if (!isPlainObject(entry)) return entry
      const out = orderedObject(entry, CHANGE_DIFF_KEYS)
      if (Array.isArray(out.hunks)) {
        out.hunks = out.hunks.map((hunk) =>
          isPlainObject(hunk) ? orderedObject(hunk, HUNK_KEYS) : hunk
        )
      }
      return out
    })
    .sort(comparePaths)
}

function canonicalChangesValue(value) {
  if (!isPlainObject(value)) return value
  const out = orderedObject(value, CHANGES_KEYS)
  if (isPlainObject(out.totals)) out.totals = orderedObject(out.totals, CHANGE_TOTALS_KEYS)
  if (Array.isArray(out.files)) {
    out.files = [...out.files]
      .map((entry) => (isPlainObject(entry) ? orderedObject(entry, CHANGE_FILE_KEYS) : entry))
      .sort(comparePaths)
  }
  if (Array.isArray(out.diffs)) out.diffs = canonicalDiffsValue(out.diffs)
  return out
}

function canonicalFuelValue(value) {
  if (!isPlainObject(value)) return value
  const out = orderedObject(value, FUEL_KEYS)
  if (isPlainObject(out.goals)) {
    const goals = orderedObject(out.goals, GOAL_FUEL_KEYS)
    if (isPlainObject(goals.goal)) goals.goal = orderedObject(goals.goal, GOAL_KEYS)
    out.goals = goals
  }
  if (isPlainObject(out.jobs)) {
    const jobs = orderedObject(out.jobs, JOBS_FUEL_KEYS)
    if (isPlainObject(jobs.statusCounts)) {
      const statusCounts = {}
      for (const key of Object.keys(jobs.statusCounts).sort(compareStrings))
        statusCounts[key] = jobs.statusCounts[key]
      jobs.statusCounts = statusCounts
    }
    if (Array.isArray(jobs.items)) {
      jobs.items = jobs.items.map((entry) =>
        isPlainObject(entry) ? orderedObject(entry, JOB_KEYS) : entry
      )
    }
    out.jobs = jobs
  }
  return out
}

function canonicalLineageValue(value) {
  return isPlainObject(value) ? orderedObject(value, LINEAGE_KEYS) : value
}

/** Per-key canonicalizers used by serialization and parsing. */
const VALUE_CANONICALIZERS = Object.freeze({
  generator: (value) => (isPlainObject(value) ? orderedObject(value, GENERATOR_KEYS) : value),
  project: (value) => (isPlainObject(value) ? orderedObject(value, PROJECT_KEYS) : value),
  session: (value) => (isPlainObject(value) ? orderedObject(value, SESSION_KEYS) : value),
  sandbox: (value) => (isPlainObject(value) ? orderedObject(value, SANDBOX_KEYS) : value),
  inputs: (value) => (isPlainObject(value) ? orderedObject(value, INPUT_KEYS) : value),
  git: canonicalGitValue,
  artifacts: canonicalArtifactsValue,
  files: canonicalFilesValue,
  sessionTrace: canonicalSessionTraceValue,
  redactions: canonicalRedactionsValue,
  warnings: canonicalWarningsValue,
  limits: canonicalLimitsValue,
  scan: canonicalScanValue,
  changes: canonicalChangesValue,
  fuel: canonicalFuelValue,
  lineage: canonicalLineageValue
})

/**
 * Rebuild a manifest with the fixed key order. Known nested blocks get their own
 * fixed order (including lexicographically sorted `byName` keys); arrays whose
 * order is part of the contract (artifacts, warnings) are sorted here, so the
 * output is canonical regardless of the input object's insertion order. Unknown
 * keys are preserved after the known ones, sorted lexicographically, so a
 * forward-compatible extension field never breaks the documented order.
 * @param {Record<string, unknown>} value
 * @returns {Record<string, unknown>}
 */
function canonicalizeManifest(value) {
  const out = {}
  for (const key of MANIFEST_KEYS) {
    if (!Object.hasOwn(value, key) || value[key] === undefined) continue
    const canonicalizer = VALUE_CANONICALIZERS[key]
    out[key] = canonicalizer === undefined ? value[key] : canonicalizer(value[key])
  }
  const extras = Object.keys(value)
    .filter((key) => !MANIFEST_KEYS.includes(key))
    .sort(compareStrings)
  for (const key of extras) {
    if (value[key] !== undefined) out[key] = value[key]
  }
  return out
}

/* ─────────────────────────── creation / normalization ───────────────────── */

function normalizeProject(value) {
  if (!isPlainObject(value))
    throw invalid('project must be an object with key/name/workspace')
  return {
    key: requireString(value.key, 'project.key'),
    name: requireString(value.name, 'project.name'),
    workspace: nullableTokenizedPath(value.workspace, 'project.workspace')
  }
}

function normalizeSession(value) {
  if (value === undefined || value === null) return { id: null, cwd: null, agentPreset: null }
  if (!isPlainObject(value)) throw invalid('session must be an object or null')
  return {
    id: nullableStringValue(value.id, 'session.id'),
    cwd: nullableTokenizedPath(value.cwd, 'session.cwd'),
    agentPreset: nullableStringValue(value.agentPreset, 'session.agentPreset')
  }
}

function normalizeSandbox(value) {
  if (value === undefined || value === null) return { mode: null, workspaceRoot: null }
  if (!isPlainObject(value)) throw invalid('sandbox must be an object or null')
  return {
    mode: nullableStringValue(value.mode, 'sandbox.mode'),
    workspaceRoot: nullableTokenizedPath(value.workspaceRoot, 'sandbox.workspaceRoot')
  }
}

function normalizeInputs(value) {
  if (value === undefined || value === null) value = {}
  if (!isPlainObject(value)) throw invalid('inputs must be an object or null')
  return {
    title: nullableStringValue(value.title, 'inputs.title'),
    goal: nullableStringValue(value.goal, 'inputs.goal'),
    summary: nullableStringValue(value.summary, 'inputs.summary'),
    decisions: requireStringArray(value.decisions, 'inputs.decisions'),
    nextSteps: requireStringArray(value.nextSteps, 'inputs.nextSteps'),
    concepts: requireStringArray(value.concepts, 'inputs.concepts'),
    flow: requireStringArray(value.flow, 'inputs.flow'),
    risks: requireStringArray(value.risks, 'inputs.risks'),
    files: requireStringArray(value.files, 'inputs.files'),
    copyFiles: value.copyFiles === true
  }
}

function normalizeReflogEntry(entry, index) {
  if (!isPlainObject(entry)) throw invalid(`git.reflog[${index}] must be an object`)
  return {
    sha: requireString(entry.sha, `git.reflog[${index}].sha`),
    time: requireString(entry.time, `git.reflog[${index}].time`),
    subject: typeof entry.subject === 'string' ? entry.subject : ''
  }
}

function normalizeGit(value) {
  if (value === undefined || value === null) return null
  if (!isPlainObject(value)) throw invalid('git must be an object or null')
  return {
    head: nullableStringValue(value.head, 'git.head'),
    branch: nullableStringValue(value.branch, 'git.branch'),
    detached: value.detached === true,
    remote: nullableStringValue(value.remote, 'git.remote'),
    lastCommit: isPlainObject(value.lastCommit)
      ? {
          sha: requireString(value.lastCommit.sha, 'git.lastCommit.sha'),
          time: requireString(value.lastCommit.time, 'git.lastCommit.time'),
          subject: typeof value.lastCommit.subject === 'string' ? value.lastCommit.subject : ''
        }
      : null,
    indexVersion: optionalInteger(value.indexVersion, 'git.indexVersion') ?? null,
    packedRefsPresent: value.packedRefsPresent === true,
    reflog: Array.isArray(value.reflog)
      ? value.reflog.map((entry, index) => normalizeReflogEntry(entry, index))
      : []
  }
}

function normalizeFileEntry(entry, index) {
  if (!isPlainObject(entry)) throw invalid(`files[${index}] must be an object`)
  const role = entry.role
  if (!FILE_ROLES.includes(role))
    throw invalid(`files[${index}].role must be one of ${FILE_ROLES.join(', ')}`)
  const out = {
    path: normalizeArtifactPath(entry.path, `files[${index}].path`),
    role,
    bytes: integerOr(entry.bytes, 0, `files[${index}].bytes`),
    sha256: typeof entry.sha256 === 'string' ? entry.sha256 : ''
  }
  if (entry.truncated === true) out.truncated = true
  if (typeof entry.skippedReason === 'string' && entry.skippedReason !== '')
    out.skippedReason = entry.skippedReason
  return out
}

function normalizeFiles(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw invalid('files must be an array')
  return value.map((entry, index) => normalizeFileEntry(entry, index))
}

function emptySessionTrace() {
  return {
    sessionId: null,
    eventCounts: { total: 0, toolCalls: 0, toolErrors: 0 },
    toolCalls: { total: 0, byName: {} },
    touchedFiles: [],
    commands: [],
    window: { events: 0, truncated: false }
  }
}

function normalizeByName(value) {
  if (value === undefined || value === null) return {}
  if (!isPlainObject(value)) throw invalid('sessionTrace.toolCalls.byName must be an object')
  const out = {}
  for (const key of Object.keys(value).sort(compareStrings)) {
    const count = value[key]
    if (!Number.isInteger(count) || count < 0)
      throw invalid(`sessionTrace.toolCalls.byName.${key} must be a non-negative integer`)
    out[key] = count
  }
  return out
}

function normalizeTouchedFile(entry, index) {
  if (!isPlainObject(entry)) throw invalid(`sessionTrace.touchedFiles[${index}] must be an object`)
  return {
    path: requireString(entry.path, `sessionTrace.touchedFiles[${index}].path`),
    tool: requireString(entry.tool, `sessionTrace.touchedFiles[${index}].tool`),
    count: integerOr(entry.count, 0, `sessionTrace.touchedFiles[${index}].count`),
    lastSeq: integerOr(entry.lastSeq, 0, `sessionTrace.touchedFiles[${index}].lastSeq`)
  }
}

function normalizeCommand(entry, index) {
  if (!isPlainObject(entry)) throw invalid(`sessionTrace.commands[${index}] must be an object`)
  return {
    tool: requireString(entry.tool, `sessionTrace.commands[${index}].tool`),
    // The redacted command may legitimately be empty (e.g. a blank command
    // string); the redaction/truncation stage already bounds it.
    commandRedacted:
      typeof entry.commandRedacted === 'string' ? entry.commandRedacted : '',
    lastSeq: integerOr(entry.lastSeq, 0, `sessionTrace.commands[${index}].lastSeq`)
  }
}

function normalizeSessionTrace(value) {
  if (value === undefined || value === null) return emptySessionTrace()
  if (!isPlainObject(value)) throw invalid('sessionTrace must be an object or null')
  const eventCounts = isPlainObject(value.eventCounts) ? value.eventCounts : {}
  const toolCalls = isPlainObject(value.toolCalls) ? value.toolCalls : {}
  const window = isPlainObject(value.window) ? value.window : {}
  const touchedFiles = value.touchedFiles === undefined || value.touchedFiles === null ? [] : value.touchedFiles
  const commands = value.commands === undefined || value.commands === null ? [] : value.commands
  if (!Array.isArray(touchedFiles)) throw invalid('sessionTrace.touchedFiles must be an array')
  if (!Array.isArray(commands)) throw invalid('sessionTrace.commands must be an array')
  return {
    sessionId: nullableStringValue(value.sessionId, 'sessionTrace.sessionId'),
    eventCounts: {
      total: integerOr(eventCounts.total, 0, 'sessionTrace.eventCounts.total'),
      toolCalls: integerOr(eventCounts.toolCalls, 0, 'sessionTrace.eventCounts.toolCalls'),
      toolErrors: integerOr(eventCounts.toolErrors, 0, 'sessionTrace.eventCounts.toolErrors')
    },
    toolCalls: {
      total: integerOr(toolCalls.total, 0, 'sessionTrace.toolCalls.total'),
      byName: normalizeByName(toolCalls.byName)
    },
    touchedFiles: touchedFiles.map((entry, index) => normalizeTouchedFile(entry, index)),
    commands: commands.map((entry, index) => normalizeCommand(entry, index)),
    window: {
      events: integerOr(window.events, 0, 'sessionTrace.window.events'),
      truncated: window.truncated === true
    }
  }
}

function normalizeRedactionEntry(entry, index) {
  if (!isPlainObject(entry)) throw invalid(`redactions[${index}] must be an object`)
  return {
    file: requireString(entry.file, `redactions[${index}].file`),
    kind: requireString(entry.kind, `redactions[${index}].kind`),
    count: integerOr(entry.count, 0, `redactions[${index}].count`)
  }
}

function normalizeRedactions(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw invalid('redactions must be an array')
  return value.map((entry, index) => normalizeRedactionEntry(entry, index))
}

function normalizeWarningEntry(entry, index) {
  if (!isPlainObject(entry)) throw invalid(`warnings[${index}] must be an object`)
  return {
    code: requireString(entry.code, `warnings[${index}].code`),
    detail: typeof entry.detail === 'string' ? entry.detail : ''
  }
}

function normalizeWarnings(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw invalid('warnings must be an array')
  return value.map((entry, index) => normalizeWarningEntry(entry, index)).sort(compareWarnings)
}

function normalizeTreeEntry(entry, index) {
  if (!isPlainObject(entry)) throw invalid(`scan.tree[${index}] must be an object`)
  const type = entry.type
  if (type !== 'file' && type !== 'directory' && type !== 'other')
    throw invalid(`scan.tree[${index}].type must be file, directory or other`)
  const out = { name: requireString(entry.name, `scan.tree[${index}].name`), type }
  const bytes = optionalInteger(entry.bytes, `scan.tree[${index}].bytes`)
  if (bytes !== undefined) out.bytes = bytes
  return out
}

function normalizeExplicitFiles(value) {
  if (value === undefined || value === null) return []
  if (Array.isArray(value))
    return value.map((item, index) => requireString(item, `scan.explicitFiles[${index}]`))
  if (Number.isInteger(value) && value >= 0) return value
  throw invalid('scan.explicitFiles must be an array of strings or a non-negative integer')
}

function normalizeScan(value) {
  if (value === undefined || value === null) value = {}
  if (!isPlainObject(value)) throw invalid('scan must be an object or null')
  const tree = value.tree === undefined || value.tree === null ? [] : value.tree
  if (!Array.isArray(tree)) throw invalid('scan.tree must be an array')
  const out = {
    entries: integerOr(value.entries, 0, 'scan.entries'),
    dirs: integerOr(value.dirs, 0, 'scan.dirs'),
    denied: integerOr(value.denied, 0, 'scan.denied'),
    symlinksSkipped: integerOr(value.symlinksSkipped, 0, 'scan.symlinksSkipped'),
    readBytes: integerOr(value.readBytes, 0, 'scan.readBytes'),
    explicitFiles: normalizeExplicitFiles(value.explicitFiles),
    tree: tree.map((entry, index) => normalizeTreeEntry(entry, index))
  }
  const extras = Object.keys(value)
    .filter((key) => !SCAN_KEYS.includes(key))
    .sort(compareStrings)
  for (const key of extras) out[key] = value[key]
  return out
}

/** Normalize the P1 `changes` block (host workspaceChanges evidence). */
function normalizeChanges(value) {
  if (value === undefined || value === null) return undefined
  if (!isPlainObject(value)) throw invalid('changes must be an object or null')
  const out = { available: value.available === true }
  if (typeof value.source === 'string') out.source = value.source
  if (Number.isInteger(value.turn)) out.turn = value.turn
  if (isPlainObject(value.totals)) {
    out.totals = {
      files: integerOr(value.totals.files, 0, 'changes.totals.files'),
      added: integerOr(value.totals.added, 0, 'changes.totals.added'),
      deleted: integerOr(value.totals.deleted, 0, 'changes.totals.deleted'),
      binary: integerOr(value.totals.binary, 0, 'changes.totals.binary'),
      oversized: integerOr(value.totals.oversized, 0, 'changes.totals.oversized')
    }
  }
  if (Array.isArray(value.files)) {
    out.files = value.files
      .map((entry, index) => {
        if (!isPlainObject(entry)) throw invalid(`changes.files[${index}] must be an object`)
        const file = {
          path: requireString(entry.path, `changes.files[${index}].path`),
          added: integerOr(entry.added, 0, `changes.files[${index}].added`),
          deleted: integerOr(entry.deleted, 0, `changes.files[${index}].deleted`)
        }
        if (entry.binary === true) file.binary = true
        if (entry.oversized === true) file.oversized = true
        return file
      })
      .sort(comparePaths)
  }
  if (Array.isArray(value.diffs)) {
    out.diffs = value.diffs
      .map((entry, index) => {
        if (!isPlainObject(entry)) throw invalid(`changes.diffs[${index}] must be an object`)
        const diff = {
          path: requireString(entry.path, `changes.diffs[${index}].path`),
          kind: requireString(entry.kind, `changes.diffs[${index}].kind`)
        }
        if (Array.isArray(entry.hunks)) {
          diff.hunks = entry.hunks.map((hunk, hunkIndex) => {
            if (!isPlainObject(hunk)) throw invalid(`changes.diffs[${index}].hunks[${hunkIndex}] must be an object`)
            return {
              oldStart: integerOr(hunk.oldStart, 0, `changes.diffs[${index}].hunks[${hunkIndex}].oldStart`),
              oldLines: integerOr(hunk.oldLines, 0, `changes.diffs[${index}].hunks[${hunkIndex}].oldLines`),
              newStart: integerOr(hunk.newStart, 0, `changes.diffs[${index}].hunks[${hunkIndex}].newStart`),
              newLines: integerOr(hunk.newLines, 0, `changes.diffs[${index}].hunks[${hunkIndex}].newLines`),
              lines: Array.isArray(hunk.lines) ? hunk.lines.map((line) => String(line)) : []
            }
          })
        }
        if (entry.truncated === true) diff.truncated = true
        return diff
      })
      .sort(comparePaths)
  }
  if (typeof value.collectedAt === 'string') out.collectedAt = value.collectedAt
  if (typeof value.note === 'string') out.note = value.note
  return out
}

/** Normalize the P1 `fuel` block (goal/jobs read-only evidence). */
function normalizeFuel(value) {
  if (value === undefined || value === null) return undefined
  if (!isPlainObject(value)) throw invalid('fuel must be an object or null')
  const out = {}
  if (isPlainObject(value.goals)) {
    const goals = { available: value.goals.available === true }
    if (isPlainObject(value.goals.goal)) {
      const goal = value.goals.goal
      goals.goal = {
        id: typeof goal.id === 'string' ? goal.id : '',
        objective: typeof goal.objective === 'string' ? goal.objective : '',
        phase: typeof goal.phase === 'string' ? goal.phase : '',
        roundsStarted: integerOr(goal.roundsStarted, 0, 'fuel.goals.goal.roundsStarted'),
        maxGoalRounds: integerOr(goal.maxGoalRounds, 0, 'fuel.goals.goal.maxGoalRounds'),
        updatedAt: integerOr(goal.updatedAt, 0, 'fuel.goals.goal.updatedAt')
      }
      if (typeof goal.activation === 'string') goals.goal.activation = goal.activation
    }
    if (typeof value.goals.note === 'string') goals.note = value.goals.note
    out.goals = goals
  }
  if (isPlainObject(value.jobs)) {
    const jobs = {
      available: value.jobs.available === true,
      count: integerOr(value.jobs.count, 0, 'fuel.jobs.count'),
      statusCounts: {},
      items: []
    }
    if (isPlainObject(value.jobs.statusCounts)) {
      for (const key of Object.keys(value.jobs.statusCounts).sort(compareStrings)) {
        const count = value.jobs.statusCounts[key]
        if (Number.isInteger(count) && count >= 0) jobs.statusCounts[key] = count
      }
    }
    if (Array.isArray(value.jobs.items)) {
      jobs.items = value.jobs.items
        .map((entry) => {
          if (!isPlainObject(entry)) return undefined
          const item = {
            id: typeof entry.id === 'string' ? entry.id : '',
            kind: typeof entry.kind === 'string' ? entry.kind : '',
            label: typeof entry.label === 'string' ? entry.label : '',
            status: typeof entry.status === 'string' ? entry.status : '',
            startedAt: integerOr(entry.startedAt, 0, 'fuel.jobs.items.startedAt')
          }
          if (Number.isInteger(entry.finishedAt)) item.finishedAt = entry.finishedAt
          if (typeof entry.progress === 'string') item.progress = entry.progress
          return item
        })
        .filter((entry) => entry !== undefined)
    }
    if (typeof value.jobs.note === 'string') jobs.note = value.jobs.note
    out.jobs = jobs
  }
  return out
}

/** Normalize the P1 `lineage` block (append/update chain). */
function normalizeLineage(value) {
  if (value === undefined || value === null) return undefined
  if (!isPlainObject(value)) throw invalid('lineage must be an object or null')
  const sequence = integerOr(value.sequence, 0, 'lineage.sequence')
  if (sequence < 2) throw invalid('lineage.sequence must be an integer >= 2')
  const previous = requireString(value.previous, 'lineage.previous')
  const root = requireString(value.root, 'lineage.root')
  if (!BATCH_ID_RE.test(previous)) throw invalid('lineage.previous must be a batch id')
  if (!BATCH_ID_RE.test(root)) throw invalid('lineage.root must be a batch id')
  const out = { sequence, previous, root }
  if (value.supersedes !== undefined && value.supersedes !== null) {
    if (typeof value.supersedes !== 'string' || !BATCH_ID_RE.test(value.supersedes))
      throw invalid('lineage.supersedes must be a batch id')
    out.supersedes = value.supersedes
  }
  return out
}

/* ───────────────────────────── public API ───────────────────────────────── */

/**
 * Build a canonical manifest from fully assembled service inputs.
 *
 * `artifacts` always starts as an empty array; the writer fills it with
 * {@link setArtifacts} once every other batch file has been written. `limits`
 * always comes from `contracts.publicLimits()` and cannot be overridden.
 *
 * Required: `batchId` (fixed-width batch id), `createdAt` (parseable ISO
 * timestamp), `project{key,name,workspace}`. Everything else is optional and
 * normalized to a deterministic empty shape; git-unavailable is `git: null`.
 * Tokenized paths must not be native Windows absolute paths.
 *
 * @param {{
 *   batchId: string,
 *   createdAt: string,
 *   generator?: Record<string, unknown>,
 *   project: {key: string, name: string, workspace: string},
 *   session?: Record<string, unknown>|null,
 *   sandbox?: Record<string, unknown>|null,
 *   inputs?: Record<string, unknown>|null,
 *   git?: Record<string, unknown>|null,
 *   files?: unknown[]|null,
 *   sessionTrace?: Record<string, unknown>|null,
 *   redactions?: unknown[]|null,
 *   warnings?: unknown[]|null,
 *   scan?: Record<string, unknown>|null,
 *   target?: 'user'|'workspace'
 * }} input
 * @returns {Record<string, unknown>} canonical manifest (fixed key order).
 * @throws {Error & {code: string}} `HANDOFF_INVALID_ARGS` on malformed input.
 */
export function createManifest(input) {
  if (!isPlainObject(input)) throw invalid('createManifest input must be an object')
  if (typeof input.batchId !== 'string' || !BATCH_ID_RE.test(input.batchId))
    throw invalid('batchId must match YYYYMMDDTHHmmssZ-xxxx (lower-case hex suffix)')
  if (typeof input.createdAt !== 'string' || Number.isNaN(Date.parse(input.createdAt)))
    throw invalid('createdAt must be a parseable ISO timestamp string')
  if (input.target !== undefined && !TARGETS.includes(input.target))
    throw invalid(`target must be one of ${TARGETS.join(', ')}`)

  const hasV2Blocks =
    input.changes !== undefined || input.fuel !== undefined || input.lineage !== undefined
  const schemaVersion =
    input.schemaVersion === undefined
      ? hasV2Blocks
        ? SCHEMA_VERSION_V2
        : SCHEMA_VERSION
      : input.schemaVersion
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(schemaVersion))
    throw invalid(`schemaVersion must be one of ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}`)
  if (schemaVersion === SCHEMA_VERSION && hasV2Blocks)
    throw invalid('changes/fuel/lineage require schemaVersion 2')

  const manifest = {
    schema: SCHEMA_ID,
    schemaVersion,
    generator: isPlainObject(input.generator)
      ? orderedObject(input.generator, GENERATOR_KEYS)
      : generatorIdentity(),
    batchId: input.batchId,
    createdAt: input.createdAt,
    project: normalizeProject(input.project),
    session: normalizeSession(input.session),
    sandbox: normalizeSandbox(input.sandbox),
    inputs: normalizeInputs(input.inputs),
    git: normalizeGit(input.git),
    artifacts: [],
    files: normalizeFiles(input.files),
    sessionTrace: normalizeSessionTrace(input.sessionTrace),
    redactions: normalizeRedactions(input.redactions),
    warnings: normalizeWarnings(input.warnings),
    limits: publicLimits(),
    scan: normalizeScan(input.scan)
  }
  if (schemaVersion === SCHEMA_VERSION_V2) {
    const changes = normalizeChanges(input.changes)
    if (changes !== undefined) manifest.changes = changes
    const fuel = normalizeFuel(input.fuel)
    if (fuel !== undefined) manifest.fuel = fuel
    const lineage = normalizeLineage(input.lineage)
    if (lineage !== undefined) manifest.lineage = lineage
  }
  // `target` is the single documented extension: the HANDOFF renderer needs the
  // user/workspace output target for H0, but the §5 fixed key order does not
  // carry it. Serialization keeps declared keys first and appends `target` last.
  if (input.target !== undefined) manifest.target = input.target
  return manifest
}

/**
 * Attach the written-artifact list, returning a new manifest.
 *
 * Entries are validated, must not include `manifest.json` (the manifest never
 * hashes itself), and are sorted by path. Input order is irrelevant.
 *
 * @param {Record<string, unknown>} manifest canonical manifest.
 * @param {Array<{path: string, bytes: number, sha256: string}>} artifacts written artifacts.
 * @returns {Record<string, unknown>} new canonical manifest.
 * @throws {Error & {code: string}} `HANDOFF_INVALID_ARGS` on malformed input.
 */
export function setArtifacts(manifest, artifacts) {
  if (!isPlainObject(manifest)) throw invalid('manifest must be an object')
  if (!Array.isArray(artifacts)) throw invalid('artifacts must be an array')
  const seen = new Set()
  const normalized = artifacts.map((entry, index) => {
    if (!isPlainObject(entry)) throw invalid(`artifacts[${index}] must be an object`)
    const path = normalizeArtifactPath(entry.path, `artifacts[${index}].path`)
    if (path === MANIFEST_FILE)
      throw invalid('artifacts must not include manifest.json (the manifest does not hash itself)')
    if (seen.has(path)) throw invalid(`artifacts contains duplicate path "${path}"`)
    seen.add(path)
    const bytes = integerOr(entry.bytes, undefined, `artifacts[${index}].bytes`)
    if (bytes === undefined) throw invalid(`artifacts[${index}].bytes must be a non-negative integer`)
    return { path, bytes, sha256: requireSha256(entry.sha256, `artifacts[${index}].sha256`) }
  })
  normalized.sort(compareArtifactEntries)
  return canonicalizeManifest({ ...manifest, artifacts: normalized })
}

/**
 * Serialize a manifest canonically: fixed key order, nested key order fixed,
 * 2-space indentation, LF newlines, one trailing newline. Serialization is
 * idempotent and stable for equal input values.
 *
 * @param {Record<string, unknown>} manifest manifest to serialize.
 * @returns {string} canonical JSON text.
 * @throws {Error & {code: string}} `HANDOFF_INVALID_ARGS` when not an object.
 */
export function serializeManifest(manifest) {
  if (!isPlainObject(manifest)) throw invalid('manifest must be an object')
  return `${JSON.stringify(canonicalizeManifest(manifest), null, 2)}\n`
}

/**
 * Parse manifest JSON text into a canonical manifest object.
 *
 * Only JSON syntax and the top-level object shape are enforced here; missing or
 * suspicious fields are reported by {@link validateManifest} instead, so a
 * verifier can report every problem in one pass. For any text produced by
 * {@link serializeManifest}, `serializeManifest(parseManifest(text)) === text`.
 *
 * @param {string} text manifest.json contents.
 * @returns {Record<string, unknown>} canonical manifest object.
 * @throws {Error & {code: string}} `HANDOFF_MANIFEST_INVALID` for unreadable text.
 */
export function parseManifest(text) {
  if (typeof text !== 'string') throw manifestInvalid('manifest text must be a string')
  if (text.trim() === '') throw manifestInvalid('manifest text is empty')
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    throw manifestInvalid(`manifest is not valid JSON: ${message}`)
  }
  if (!isPlainObject(parsed)) throw manifestInvalid('manifest must be a JSON object')
  return canonicalizeManifest(parsed)
}

/**
 * Shape-validate a parsed manifest without throwing.
 *
 * `error` findings are structural (a verifier should not trust the batch);
 * `warn` findings are suspicious but readable. Findings are sorted by severity
 * (`error` first), then code, then path, then detail.
 *
 * @param {unknown} value candidate manifest.
 * @returns {{ok: boolean, findings: Array<{severity: 'error'|'warn', code: string, path?: string, detail?: string}>}}
 */
export function validateManifest(value) {
  const findings = []

  /**
   * @param {'error'|'warn'} severity
   * @param {string} code
   * @param {string} [path]
   * @param {string} [detail]
   */
  const add = (severity, code, path, detail) => {
    const item = { severity, code }
    if (typeof path === 'string' && path !== '') item.path = path
    if (typeof detail === 'string' && detail !== '') item.detail = detail
    findings.push(item)
  }

  if (!isPlainObject(value)) {
    add('error', 'MANIFEST_NOT_OBJECT', undefined, 'manifest must be a JSON object')
    return { ok: false, findings }
  }

  if (value.schema !== SCHEMA_ID)
    add('error', 'MANIFEST_SCHEMA', 'schema', `schema must be "${SCHEMA_ID}"`)
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(value.schemaVersion))
    add(
      'error',
      'MANIFEST_SCHEMA_VERSION',
      'schemaVersion',
      `schemaVersion must be one of ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}`
    )
  if (typeof value.batchId !== 'string' || !BATCH_ID_RE.test(value.batchId))
    add('error', 'MANIFEST_BATCH_ID', 'batchId', 'batchId must match YYYYMMDDTHHmmssZ-xxxx')
  if (typeof value.createdAt !== 'string' || Number.isNaN(Date.parse(value.createdAt)))
    add('warn', 'MANIFEST_CREATED_AT', 'createdAt', 'createdAt must be a parseable timestamp string')

  if (!isPlainObject(value.project)) {
    add('error', 'MANIFEST_PROJECT', 'project', 'project must be an object')
  } else {
    for (const key of PROJECT_KEYS) {
      if (typeof value.project[key] !== 'string' || value.project[key] === '')
        add('error', 'MANIFEST_PROJECT', `project.${key}`, 'must be a non-empty string')
    }
  }

  for (const [key, code] of [
    ['generator', 'MANIFEST_GENERATOR'],
    ['session', 'MANIFEST_SESSION'],
    ['sandbox', 'MANIFEST_SANDBOX'],
    ['inputs', 'MANIFEST_INPUTS'],
    ['sessionTrace', 'MANIFEST_SESSION_TRACE'],
    ['scan', 'MANIFEST_SCAN']
  ]) {
    if (value[key] !== undefined && value[key] !== null && !isPlainObject(value[key]))
      add('warn', code, key, 'must be an object')
  }
  for (const [key, code] of [
    ['redactions', 'MANIFEST_REDACTIONS'],
    ['warnings', 'MANIFEST_WARNINGS']
  ]) {
    if (value[key] !== undefined && value[key] !== null && !Array.isArray(value[key]))
      add('warn', code, key, 'must be an array')
  }

  if (!Array.isArray(value.artifacts)) {
    add('error', 'MANIFEST_ARTIFACTS', 'artifacts', 'artifacts must be an array')
  } else {
    for (const [index, entry] of value.artifacts.entries()) {
      const path = `artifacts[${index}]`
      if (!isPlainObject(entry)) {
        add('warn', 'MANIFEST_ARTIFACT_ENTRY', path, 'must be an object')
        continue
      }
      if (typeof entry.path !== 'string' || !isSafeRelativePath(entry.path))
        add('warn', 'MANIFEST_ARTIFACT_ENTRY', `${path}.path`, 'must be a batch-relative POSIX path')
      if (!Number.isInteger(entry.bytes) || entry.bytes < 0)
        add('warn', 'MANIFEST_ARTIFACT_ENTRY', `${path}.bytes`, 'must be a non-negative integer')
      if (typeof entry.sha256 !== 'string' || !SHA256_RE.test(entry.sha256))
        add('warn', 'MANIFEST_ARTIFACT_ENTRY', `${path}.sha256`, 'must be a lower-case hex sha256')
    }
  }

  if (!Array.isArray(value.files)) {
    add('error', 'MANIFEST_FILES', 'files', 'files must be an array')
  } else {
    for (const [index, entry] of value.files.entries()) {
      const path = `files[${index}]`
      if (!isPlainObject(entry)) {
        add('warn', 'MANIFEST_FILE_ENTRY', path, 'must be an object')
        continue
      }
      if (typeof entry.path !== 'string' || !isSafeRelativePath(entry.path))
        add('warn', 'MANIFEST_FILE_ENTRY', `${path}.path`, 'must be a workspace-relative POSIX path')
      if (typeof entry.role !== 'string' || !FILE_ROLES.includes(entry.role))
        add('warn', 'MANIFEST_FILE_ENTRY', `${path}.role`, `must be one of ${FILE_ROLES.join(', ')}`)
      if (!Number.isInteger(entry.bytes) || entry.bytes < 0)
        add('warn', 'MANIFEST_FILE_ENTRY', `${path}.bytes`, 'must be a non-negative integer')
      if (
        typeof entry.sha256 !== 'string' ||
        (entry.sha256 !== '' && !SHA256_RE.test(entry.sha256))
      )
        add('warn', 'MANIFEST_FILE_ENTRY', `${path}.sha256`, 'must be a lower-case hex sha256')
    }
  }

  if (!isPlainObject(value.limits)) {
    add('error', 'MANIFEST_LIMITS', 'limits', 'limits must be an object')
  } else {
    for (const key of LIMITS_KEYS) {
      if (!Number.isInteger(value.limits[key]) || value.limits[key] < 0)
        add('warn', 'MANIFEST_LIMITS', `limits.${key}`, 'must be a non-negative integer')
    }
  }

  for (const [path, candidate] of [
    ['project.workspace', isPlainObject(value.project) ? value.project.workspace : undefined],
    ['session.cwd', isPlainObject(value.session) ? value.session.cwd : undefined],
    ['sandbox.workspaceRoot', isPlainObject(value.sandbox) ? value.sandbox.workspaceRoot : undefined]
  ]) {
    if (typeof candidate === 'string' && WINDOWS_ABSOLUTE_RE.test(candidate))
      add(
        'warn',
        'MANIFEST_PATH_NOT_TOKENIZED',
        path,
        'expected a $WORKSPACE/$DSH_HOME tokenized path, got a native Windows path'
      )
  }

  if (value.target !== undefined && !TARGETS.includes(value.target))
    add('warn', 'MANIFEST_TARGET', 'target', `target must be one of ${TARGETS.join(', ')}`)

  // P1 v2 optional blocks: presence only at schemaVersion 2; light shape checks
  // so a verifier can report every problem in one pass.
  const v2Blocks = ['changes', 'fuel', 'lineage'].filter((key) => value[key] !== undefined)
  if (value.schemaVersion === SCHEMA_VERSION && v2Blocks.length > 0) {
    add(
      'warn',
      'MANIFEST_VERSION_BLOCK',
      v2Blocks.join(','),
      `schemaVersion 1 must not carry ${v2Blocks.join('/')} blocks`
    )
  }
  if (value.changes !== undefined) {
    if (!isPlainObject(value.changes)) {
      add('warn', 'MANIFEST_CHANGES', 'changes', 'must be an object')
    } else {
      if (typeof value.changes.available !== 'boolean')
        add('warn', 'MANIFEST_CHANGES', 'changes.available', 'must be a boolean')
      if (value.changes.totals !== undefined && !isPlainObject(value.changes.totals))
        add('warn', 'MANIFEST_CHANGES', 'changes.totals', 'must be an object')
      if (value.changes.files !== undefined) {
        if (!Array.isArray(value.changes.files))
          add('warn', 'MANIFEST_CHANGES', 'changes.files', 'must be an array')
        else {
          for (const [index, entry] of value.changes.files.entries()) {
            if (!isPlainObject(entry) || typeof entry.path !== 'string')
              add('warn', 'MANIFEST_CHANGES', `changes.files[${index}]`, 'entry must carry a string path')
          }
        }
      }
      if (value.changes.diffs !== undefined && !Array.isArray(value.changes.diffs))
        add('warn', 'MANIFEST_CHANGES', 'changes.diffs', 'must be an array')
    }
  }
  if (value.fuel !== undefined) {
    if (!isPlainObject(value.fuel)) {
      add('warn', 'MANIFEST_FUEL', 'fuel', 'must be an object')
    } else {
      for (const key of ['goals', 'jobs']) {
        if (value.fuel[key] !== undefined && !isPlainObject(value.fuel[key]))
          add('warn', 'MANIFEST_FUEL', `fuel.${key}`, 'must be an object')
      }
      if (isPlainObject(value.fuel.jobs) && typeof value.fuel.jobs.available !== 'boolean')
        add('warn', 'MANIFEST_FUEL', 'fuel.jobs.available', 'must be a boolean')
    }
  }
  if (value.lineage !== undefined) {
    if (!isPlainObject(value.lineage)) {
      add('warn', 'MANIFEST_LINEAGE', 'lineage', 'must be an object')
    } else {
      if (!Number.isInteger(value.lineage.sequence) || value.lineage.sequence < 2)
        add('warn', 'MANIFEST_LINEAGE', 'lineage.sequence', 'must be an integer >= 2')
      for (const key of ['previous', 'root']) {
        if (typeof value.lineage[key] !== 'string' || !BATCH_ID_RE.test(value.lineage[key]))
          add('warn', 'MANIFEST_LINEAGE', `lineage.${key}`, 'must be a batch id')
      }
      if (
        value.lineage.supersedes !== undefined &&
        (typeof value.lineage.supersedes !== 'string' || !BATCH_ID_RE.test(value.lineage.supersedes))
      )
        add('warn', 'MANIFEST_LINEAGE', 'lineage.supersedes', 'must be a batch id when present')
    }
  }

  findings.sort(
    (left, right) =>
      SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity] ||
      compareStrings(left.code, right.code) ||
      compareStrings(left.path ?? '', right.path ?? '') ||
      compareStrings(left.detail ?? '', right.detail ?? '')
  )
  return { ok: findings.every((finding) => finding.severity !== 'error'), findings }
}

/**
 * True when a manifest carries every structural element the writer promises:
 * correct schema/version, valid batch id, project identity, artifact/file/limit
 * containers, and a parseable creation timestamp.
 * @param {unknown} value candidate manifest.
 * @returns {boolean}
 */
export function isCompleteManifest(value) {
  if (!isPlainObject(value)) return false
  if (!validateManifest(value).ok) return false
  return typeof value.createdAt === 'string' && !Number.isNaN(Date.parse(value.createdAt))
}

/** True for a safe batch/workspace-relative POSIX path (no drive, no `..`, no NUL). */
function isSafeRelativePath(value) {
  if (typeof value !== 'string' || value === '' || value.includes('\0')) return false
  if (WINDOWS_ABSOLUTE_RE.test(value) || value.startsWith('/') || value.startsWith('\\')) return false
  const segments = value.split(/[\\/]+/).filter((segment) => segment !== '' && segment !== '.')
  if (segments.length === 0) return false
  return segments.every((segment) => segment !== '..')
}

/* ───────────────────────────── artifacts / sums ─────────────────────────── */

/**
 * Build one artifact record from in-memory content. `bytes` is the UTF-8 byte
 * length (not the character count) and `sha256` is lower-case hex.
 *
 * @param {string} path batch-relative POSIX artifact path.
 * @param {string|Uint8Array} content artifact text or bytes.
 * @returns {{path: string, bytes: number, sha256: string}}
 * @throws {Error & {code: string}} `HANDOFF_INVALID_ARGS` for a bad path/content.
 */
export function artifactEntry(path, content) {
  const normalizedPath = normalizeArtifactPath(path)
  if (typeof content === 'string') {
    return { path: normalizedPath, bytes: Buffer.byteLength(content, 'utf8'), sha256: sha256Hex(content) }
  }
  if (content instanceof Uint8Array) {
    return { path: normalizedPath, bytes: content.byteLength, sha256: sha256Hex(content) }
  }
  throw invalid('artifactEntry content must be a string or Uint8Array')
}

/**
 * Render the canonical `SHA256SUMS` text: `<sha256>  <path>` per line (two
 * spaces), paths sorted lexicographically by code unit. Empty input renders the
 * empty string.
 *
 * @param {Array<{path: string, sha256: string}>} entries artifact/sums rows.
 * @returns {string} SHA256SUMS text (LF, trailing newline per row).
 * @throws {Error & {code: string}} `HANDOFF_INVALID_ARGS` for malformed rows.
 */
export function buildSha256Sums(entries) {
  if (!Array.isArray(entries)) throw invalid('buildSha256Sums entries must be an array')
  const seen = new Set()
  const rows = entries.map((entry, index) => {
    if (!isPlainObject(entry)) throw invalid(`entries[${index}] must be an object`)
    const path = normalizeArtifactPath(entry.path, `entries[${index}].path`)
    if (seen.has(path)) throw invalid(`entries contains duplicate path "${path}"`)
    seen.add(path)
    return { path, sha256: requireSha256(entry.sha256, `entries[${index}].sha256`) }
  })
  rows.sort((left, right) => compareStrings(left.path, right.path))
  return rows.map((row) => `${row.sha256}  ${row.path}\n`).join('')
}

/**
 * Parse `SHA256SUMS` text. GNU `sha256sum` output is accepted, including the
 * `*` binary marker and CRLF line endings; blank lines are ignored. Paths are
 * normalized to batch-relative POSIX form and must be unique.
 *
 * @param {string} text SHA256SUMS contents.
 * @returns {Array<{path: string, sha256: string}>} rows in file order.
 * @throws {Error & {code: string}} `HANDOFF_MANIFEST_INVALID` for malformed text.
 */
export function parseSha256Sums(text) {
  if (typeof text !== 'string') throw manifestInvalid('SHA256SUMS text must be a string')
  const seen = new Set()
  const rows = []
  const lines = text.split('\n')
  for (const [index, raw] of lines.entries()) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line.trim() === '') continue
    const match = /^([0-9a-fA-F]{64})[ \t]+\*?(.+)$/.exec(line)
    if (match === null) throw manifestInvalid(`SHA256SUMS line ${index + 1} is malformed`)
    let path
    try {
      path = normalizeArtifactPath(match[2], `SHA256SUMS line ${index + 1} path`)
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      throw manifestInvalid(`SHA256SUMS line ${index + 1} has an invalid path: ${detail}`)
    }
    if (seen.has(path)) throw manifestInvalid(`SHA256SUMS contains duplicate path "${path}"`)
    seen.add(path)
    rows.push({ path, sha256: match[1].toLowerCase() })
  }
  return rows
}
