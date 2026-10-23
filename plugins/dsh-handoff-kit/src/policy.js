/**
 * Optional redaction policy configuration (P3/M5, decision D8).
 *
 * Location is fixed and user-level: `$DSH_HOME/handoff/policy.json`, even when
 * the batch target is `workspace`. A **missing** file is the rc.2 behavior; a
 * present but unreadable/invalid file is **fail-closed**: the caller refuses to
 * create any batch directory/file and throws `HANDOFF_POLICY_INVALID`.
 *
 * Strict schema (unknown keys anywhere → invalid):
 *
 * ```json
 * {
 *   "version": 1,
 *   "denylist": { "paths": ["secrets", "config/private"], "extensions": [".kdbx"] },
 *   "redaction": {
 *     "rules": [{ "kind": "ticket-id", "pattern": "TICKET-[0-9]{4}", "flags": "g", "replacement": "«REDACTED:ticket-id»" }]
 *   }
 * }
 * ```
 *
 * Merge rule (security floor): the built-in `REDACTION_RULES` and the built-in
 * file denylist are **never disabled or overridden**. A policy can only append
 * denylist entries and extra redaction rules, which run *after* the built-ins.
 * There is deliberately no "disable built-ins" switch.
 *
 * Provenance: when a batch is generated with a policy, the policy file bytes'
 * sha256 and the tokenized `$DSH_HOME` path are recorded in
 * `evidence/redactions.json` under `policy: {sha256, source}` (never in
 * `manifest.json`). Without a policy both values are `null`.
 *
 * @module dsh-handoff-kit/policy
 */

import { Buffer } from 'node:buffer'
import { join } from 'node:path'

import { ERROR, HANDOFF_SUBDIR, handoffError, isPlainObject } from './contracts.js'
import { sha256Hex, toPosix } from './paths.js'
import { deniedReason, isDeniedFile } from './redact.js'

/** Fixed user-level policy file name. */
export const POLICY_FILE = 'policy.json'
/** The only policy schema version this module accepts. */
export const POLICY_SCHEMA_VERSION = 1
/** Refuse to read a policy file larger than this (fail-closed). */
export const MAX_POLICY_BYTES = 64 * 1024

const ROOT_FIELDS = Object.freeze(['version', 'denylist', 'redaction'])
const DENYLIST_FIELDS = Object.freeze(['paths', 'extensions'])
const REDACTION_FIELDS = Object.freeze(['rules'])
const RULE_FIELDS = Object.freeze(['kind', 'pattern', 'flags', 'replacement'])
const KIND_RE = /^[a-z][a-z0-9-]*$/
const EXTENSION_RE = /^\.[^\s/\\\0]+$/
const FLAGS_RE = /^[gi]*$/

function policyInvalid(detail) {
  return handoffError(ERROR.POLICY_INVALID, `policy.json: ${detail}`)
}

/** Deterministic string comparator (no locale). */
function compareStrings(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/** Deduplicate + sort a validated string array so policy order cannot change output. */
function canonicalList(values) {
  return [...new Set(values)].sort(compareStrings)
}

/** Validate one workspace-relative POSIX denylist path. */
function normalizeDenyPath(value, label) {
  if (typeof value !== 'string') throw policyInvalid(`${label} must be a string`)
  const trimmed = value.trim()
  if (trimmed === '') throw policyInvalid(`${label} must not be empty`)
  if (trimmed.includes('\0')) throw policyInvalid(`${label} must not contain a NUL byte`)
  if (trimmed.includes('\\'))
    throw policyInvalid(`${label} must use POSIX separators ("/"), got ${JSON.stringify(trimmed)}`)
  if (trimmed.startsWith('/'))
    throw policyInvalid(`${label} must be workspace-relative, got absolute ${JSON.stringify(trimmed)}`)
  if (/^[A-Za-z]:/.test(trimmed))
    throw policyInvalid(`${label} must be workspace-relative, got drive path ${JSON.stringify(trimmed)}`)
  const segments = trimmed.split('/').filter((segment) => segment !== '')
  if (segments.length === 0) throw policyInvalid(`${label} resolves to the workspace root`)
  for (const segment of segments) {
    if (segment === '..') throw policyInvalid(`${label} must not contain ".." (${JSON.stringify(trimmed)})`)
    if (segment === '.') throw policyInvalid(`${label} must not contain "." segments (${JSON.stringify(trimmed)})`)
  }
  return segments.join('/')
}

/** Validate one appended file extension (must start with a dot). */
function normalizeExtension(value, label) {
  if (typeof value !== 'string') throw policyInvalid(`${label} must be a string`)
  const trimmed = value.trim()
  if (!EXTENSION_RE.test(trimmed))
    throw policyInvalid(
      `${label} must start with "." and contain no whitespace/path separator, got ${JSON.stringify(trimmed)}`
    )
  return trimmed
}

/** Validate one custom redaction rule and return its normalized form. */
function normalizeRule(rule, label) {
  if (!isPlainObject(rule)) throw policyInvalid(`${label} must be an object`)
  for (const field of Object.keys(rule)) {
    if (!RULE_FIELDS.includes(field))
      throw policyInvalid(`${label} contains an unexpected field "${field}"`)
  }
  if (typeof rule.kind !== 'string' || !KIND_RE.test(rule.kind))
    throw policyInvalid(
      `${label}.kind must match ^[a-z][a-z0-9-]*$, got ${JSON.stringify(rule.kind)}`
    )
  if (typeof rule.pattern !== 'string' || rule.pattern === '')
    throw policyInvalid(`${label}.pattern must be a non-empty string`)
  const flags = rule.flags === undefined ? 'g' : rule.flags
  if (typeof flags !== 'string' || !FLAGS_RE.test(flags))
    throw policyInvalid(
      `${label}.flags may only contain "g" and/or "i", got ${JSON.stringify(rule.flags)}`
    )
  if (new Set(flags.split('')).size !== flags.length)
    throw policyInvalid(`${label}.flags must not repeat a flag, got ${JSON.stringify(flags)}`)
  try {
    new RegExp(rule.pattern, flags)
  } catch (error) {
    throw policyInvalid(
      `${label}.pattern is not a valid regular expression with flags "${flags}": ${error?.message ?? String(error)}`
    )
  }
  if (rule.replacement !== undefined && typeof rule.replacement !== 'string')
    throw policyInvalid(`${label}.replacement must be a string when present`)
  if (typeof rule.replacement === 'string' && rule.replacement.length > 500)
    throw policyInvalid(`${label}.replacement must be at most 500 characters`)
  return {
    kind: rule.kind,
    pattern: rule.pattern,
    flags,
    ...(rule.replacement === undefined ? {} : { replacement: rule.replacement })
  }
}

/**
 * Validate a parsed policy document against the strict schema.
 * @param {unknown} doc parsed JSON value.
 * @returns {{version: 1, denylist: {paths: string[], extensions: string[]},
 *   redaction: {rules: Array<{kind: string, pattern: string, flags: string, replacement?: string}>}}}
 * @throws {Error & {code: string}} `HANDOFF_POLICY_INVALID`.
 */
export function validatePolicyDocument(doc) {
  if (!isPlainObject(doc)) throw policyInvalid('the document must be a JSON object')
  for (const field of Object.keys(doc)) {
    if (!ROOT_FIELDS.includes(field))
      throw policyInvalid(`unexpected field "${field}" (only version/denylist/redaction are allowed)`)
  }
  if (doc.version !== POLICY_SCHEMA_VERSION)
    throw policyInvalid(`version must be ${POLICY_SCHEMA_VERSION}, got ${JSON.stringify(doc.version)}`)

  const denylist = { paths: [], extensions: [] }
  if (doc.denylist !== undefined) {
    if (!isPlainObject(doc.denylist)) throw policyInvalid('denylist must be an object')
    for (const field of Object.keys(doc.denylist)) {
      if (!DENYLIST_FIELDS.includes(field))
        throw policyInvalid(`denylist contains an unexpected field "${field}"`)
    }
    if (doc.denylist.paths !== undefined) {
      if (!Array.isArray(doc.denylist.paths)) throw policyInvalid('denylist.paths must be an array')
      denylist.paths = canonicalList(
        doc.denylist.paths.map((value, index) =>
          normalizeDenyPath(value, `denylist.paths[${index}]`)
        )
      )
    }
    if (doc.denylist.extensions !== undefined) {
      if (!Array.isArray(doc.denylist.extensions))
        throw policyInvalid('denylist.extensions must be an array')
      denylist.extensions = canonicalList(
        doc.denylist.extensions.map((value, index) =>
          normalizeExtension(value, `denylist.extensions[${index}]`)
        )
      )
    }
  }

  const rules = []
  if (doc.redaction !== undefined) {
    if (!isPlainObject(doc.redaction)) throw policyInvalid('redaction must be an object')
    for (const field of Object.keys(doc.redaction)) {
      if (!REDACTION_FIELDS.includes(field))
        throw policyInvalid(`redaction contains an unexpected field "${field}"`)
    }
    if (doc.redaction.rules !== undefined) {
      if (!Array.isArray(doc.redaction.rules)) throw policyInvalid('redaction.rules must be an array')
      doc.redaction.rules.forEach((rule, index) => {
        rules.push(normalizeRule(rule, `redaction.rules[${index}]`))
      })
    }
  }
  return { version: POLICY_SCHEMA_VERSION, denylist, redaction: { rules } }
}

/**
 * Parse policy JSON text (fail-closed).
 * @param {string} text raw UTF-8 policy text.
 * @param {string} [label] diagnostic label (usually the absolute file path).
 * @returns {ReturnType<typeof validatePolicyDocument>}
 * @throws {Error & {code: string}} `HANDOFF_POLICY_INVALID`.
 */
export function parsePolicyText(text, label = POLICY_FILE) {
  let doc
  try {
    doc = JSON.parse(String(text))
  } catch (error) {
    throw handoffError(
      ERROR.POLICY_INVALID,
      `${label} is not valid JSON: ${error?.message ?? String(error)}`
    )
  }
  try {
    return validatePolicyDocument(doc)
  } catch (error) {
    if (error?.code === ERROR.POLICY_INVALID)
      throw handoffError(ERROR.POLICY_INVALID, error.detail ?? error.message)
    throw error
  }
}

/** Absolute path of the user-level policy file. */
export function policyPathFor(dshHome) {
  if (typeof dshHome !== 'string' || dshHome === '')
    throw handoffError(ERROR.INTERNAL, 'policyPathFor needs an absolute dshHome')
  return join(dshHome, HANDOFF_SUBDIR, POLICY_FILE)
}

/** True when `error` means "file does not exist" from either fs layer. */
function isNotFound(error) {
  const code = error !== null && typeof error === 'object' ? error.code : undefined
  return code === 'FS_NOT_FOUND' || code === 'ENOENT'
}

/**
 * Read and validate the user-level policy file.
 *
 * Returns `null` when the file does not exist (default behavior). Any other
 * problem — inspection failure, non-regular file, read failure, oversize,
 * invalid JSON or schema violation — throws `HANDOFF_POLICY_INVALID` so the
 * caller can refuse to write anything.
 * @param {{io: {lstat: Function, readBytes: Function}, dshHome: string}} input
 * @returns {Promise<null | {sha256: string, absolutePath: string,
 *   policy: ReturnType<typeof validatePolicyDocument>}>}
 * @throws {Error & {code: string}} `HANDOFF_POLICY_INVALID`.
 */
export async function readPolicyFile({ io, dshHome }) {
  const absolutePath = policyPathFor(dshHome)
  let info
  try {
    info = await io.lstat(absolutePath)
  } catch (error) {
    if (isNotFound(error)) return null
    throw policyInvalid(`cannot inspect ${absolutePath}: ${error?.message ?? String(error)}`)
  }
  if (info === undefined || info === null) return null
  if (info.type !== 'file')
    throw policyInvalid(`${absolutePath} must be a regular file (policy is never read through symlinks)`)
  let bytes
  try {
    bytes = await io.readBytes(absolutePath, MAX_POLICY_BYTES)
  } catch (error) {
    throw policyInvalid(`cannot read ${absolutePath}: ${error?.message ?? String(error)}`)
  }
  let text
  try {
    text = Buffer.from(bytes).toString('utf8')
  } catch (error) {
    throw policyInvalid(`cannot decode ${absolutePath} as UTF-8: ${error?.message ?? String(error)}`)
  }
  return { sha256: sha256Hex(bytes), absolutePath, policy: parsePolicyText(text, absolutePath) }
}

/**
 * Build the merged file-denylist predicate: built-in rules first, then the
 * policy's paths (prefix match) and extensions (suffix match, case-insensitive).
 * Returns a stable reason string or `null`; `isDeniedFile` remains the floor.
 * @param {{denylist?: {paths?: string[], extensions?: string[]}}|null} policy
 * @returns {(relativePath: string) => string|null}
 */
export function createPolicyDenied(policy) {
  const paths = (policy?.denylist?.paths ?? []).map((value) => value.toLowerCase())
  const extensions = (policy?.denylist?.extensions ?? []).map((value) => value.toLowerCase())
  return (relativePath) => {
    const builtin = deniedReason(relativePath)
    if (builtin !== null) return builtin
    if (typeof relativePath !== 'string') return null
    const normalized = toPosix(relativePath).replace(/^\.\/+/, '').replace(/\/+$/, '')
    if (normalized === '' || normalized === '.') return null
    const lowered = normalized.toLowerCase()
    for (const path of paths) {
      if (lowered === path || lowered.startsWith(`${path}/`)) return `policy:path:${path}`
    }
    const segments = lowered.split('/')
    const basename = segments[segments.length - 1] ?? ''
    for (const extension of extensions) {
      if (basename.endsWith(extension)) return `policy:extension:${extension}`
    }
    return null
  }
}

/**
 * Build the appended redaction rules (built-ins stay first and unchanged).
 * @param {{redaction?: {rules?: Array<{kind: string, pattern: string, flags: string, replacement?: string}>}}|null} policy
 * @returns {Array<{kind: string, pattern: RegExp, replacement?: string}>}
 * @throws {Error & {code: string}} `HANDOFF_INTERNAL` for programmer misuse.
 */
export function buildPolicyRedactionRules(policy) {
  const rules = policy?.redaction?.rules
  if (rules === undefined) return []
  if (!Array.isArray(rules))
    throw handoffError(ERROR.INTERNAL, 'policy redaction rules must be an array')
  return rules.map((rule) => ({
    kind: rule.kind,
    pattern: new RegExp(rule.pattern, rule.flags),
    ...(rule.replacement === undefined ? {} : { replacement: rule.replacement })
  }))
}

/**
 * The "no policy file" runtime value. `denied` is exactly the built-in floor,
 * so an absent policy reproduces rc.2 behavior byte-for-byte.
 */
export const EMPTY_POLICY = Object.freeze({
  present: false,
  sha256: null,
  source: null,
  denylist: Object.freeze({ paths: Object.freeze([]), extensions: Object.freeze([]) }),
  rules: Object.freeze([]),
  denied: isDeniedFile
})

/**
 * Build the runtime policy value from a loaded policy file.
 * @param {{sha256: string, source: string|null, policy: ReturnType<typeof validatePolicyDocument>}} input
 */
export function createPolicy({ sha256, source, policy }) {
  return {
    present: true,
    sha256,
    source,
    denylist: Object.freeze({
      paths: Object.freeze([...policy.denylist.paths]),
      extensions: Object.freeze([...policy.denylist.extensions])
    }),
    rules: Object.freeze(buildPolicyRedactionRules(policy)),
    denied: createPolicyDenied(policy)
  }
}

/**
 * Provenance block recorded in `evidence/redactions.json`.
 * @param {{sha256: string|null, source: string|null}} policy runtime policy (or {@link EMPTY_POLICY}).
 * @returns {{sha256: string|null, source: string|null}}
 */
export function policyProvenance(policy) {
  return {
    sha256: typeof policy?.sha256 === 'string' ? policy.sha256 : null,
    source: typeof policy?.source === 'string' ? policy.source : null
  }
}

/** True when a denylist predicate (boolean or reason-string style) denies the path. */
export function isPolicyDenied(denied, relativePath) {
  const answer = typeof denied === 'function' ? denied(relativePath) : false
  return answer === true || (typeof answer === 'string' && answer !== '')
}
