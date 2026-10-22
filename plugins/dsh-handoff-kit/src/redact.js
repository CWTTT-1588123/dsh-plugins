/**
 * Deterministic secret redaction, file denylist and artifact final check.
 *
 * Every rule is a plain regular expression applied in a fixed order. A match is
 * replaced by a stable placeholder (`«REDACTED:<kind>»`) so two renderings of the
 * same input are byte-identical. Placeholders are opaque to every later rule,
 * which makes redaction idempotent: `redactText(redactText(x).text).hits` is
 * always empty and a redacted artifact never fails {@link finalCheck}.
 *
 * This module is pure logic: no filesystem, no clock, no randomness, no
 * environment reads. Callers inject all input text.
 *
 * @module dsh-handoff-kit/redact
 */

import { ERROR, handoffError } from './contracts.js'
import { toPosix } from './paths.js'

/** Opening delimiter of a redaction placeholder. */
const PLACEHOLDER_OPEN = '«REDACTED:'
/** Closing delimiter of a redaction placeholder. */
const PLACEHOLDER_CLOSE = '»'
/** Matches a complete redaction placeholder. Global; cloned before use. */
const PLACEHOLDER_RE = /«REDACTED:[a-z0-9-]+»/g

/** Per-kind replacement used when a rule has no custom replacement. */
function placeholderFor(kind) {
  return `${PLACEHOLDER_OPEN}${kind}${PLACEHOLDER_CLOSE}`
}

/** Deterministic ASCII/locale-independent string comparator. */
function compareStrings(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/** Build a structured pure-logic misuse failure. */
function misuse(detail) {
  return handoffError(ERROR.INTERNAL, detail)
}

/** True for `{}` and `Object.create(null)` only (not Date/Buffer/class instances). */
function isPlainRecord(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Redaction rules in their fixed application order.
 *
 * Each entry has `{kind, pattern, replacement?}`. Requirements:
 *   - `kind` is one of the documented literals and is used in the placeholder;
 *   - `pattern` is a global `RegExp`; internal code clones it before every use
 *     so iterating this exported array never mutates `lastIndex`;
 *   - `replacement` is an optional `String.prototype.replace` template. It may
 *     reference capture groups (for example `$1`) to keep the non-secret part
 *     of the match (key name, URL scheme, message prefix) readable. When it is
 *     omitted the whole match becomes `«REDACTED:<kind>»`.
 *
 * Order is significant: blocks and credentials are removed before generic
 * `NAME=value` patterns so one secret is counted under the most specific kind,
 * and replacement placeholders are never re-matched by later rules.
 *
 * @type {ReadonlyArray<{kind: string, pattern: RegExp, replacement?: string}>}
 */
export const REDACTION_RULES = Object.freeze([
  Object.freeze({
    kind: 'private-key-block',
    // Whole PEM/OpenSSH/PGP private key block, including an unterminated block
    // that runs to the end of the text (a truncated key is still a secret).
    pattern:
      /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|$)/g
  }),
  Object.freeze({
    kind: 'bearer',
    // "Bearer <token>"; the whole match is replaced so the scheme word cannot
    // be re-read as the value of a later `Authorization: …` generic assignment.
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi
  }),
  Object.freeze({
    kind: 'cloud-key',
    // OpenAI-style sk-…, AWS access key id, GitHub personal access token.
    pattern: /(?:\bsk-[A-Za-z0-9_-]{8,}|\bAKIA[0-9A-Z]{16}\b|\bghp_[A-Za-z0-9]{8,})/g
  }),
  Object.freeze({
    kind: 'url-credentials',
    // scheme://user:password@ → placeholder + `@`; dropping the scheme leaves no
    // `NAME=value`-looking fragment that env/generic rules could re-count.
    pattern: /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/@:"']+:[^\s/@"']+@/g,
    replacement: `${placeholderFor('url-credentials')}@`
  }),
  Object.freeze({
    kind: 'conn-string-password',
    // Password=… segment of a connection string; the key is kept.
    pattern: /(\b(?:password|passwd|pwd)\s*=\s*)(?:(["'])([^"'\n]+)\2|([^;'"\s]+))/gi,
    replacement: `$1$2${placeholderFor('conn-string-password')}$2`
  }),
  Object.freeze({
    kind: 'env-assignment',
    // dotenv style `KEY=value` line (optionally with a leading `export `).
    // Environment names are upper-case by convention; requiring that keeps
    // prose such as `target=user …` from being mistaken for a secret.
    pattern: /^([ \t]*(?:export[ \t]+)?)([A-Z][A-Z0-9_]{2,})=(.+)$/gm,
    replacement: `$1$2=${placeholderFor('env-assignment')}`
  }),
  Object.freeze({
    kind: 'generic-assignment',
    // JSON/YAML/config assignments whose key names a secret-ish thing.
    //
    // Identifier grammar matters: bare `key`/`keys` and dotted namespaces such
    // as `project.key` (manifest.json, rendered HANDOFF H0) are structural and
    // must NOT be treated as secret assignments, while word-compound names
    // (`api_key`, `apiKey`, `access_key`, `secret_key`, `private_key`,
    // `signing_key`, `encryption_key`, `server.api_key`, …) must. So the `key`
    // branch requires at least one identifier character before `key`, and that
    // character must not be a namespace dot. The other keywords
    // (token/secret/password/authorization/bearer/credential) keep the permissive
    // bare-name behavior.
    //
    // Unquoted values must look like a credential: at least 8 token characters
    // including a digit/symbol, or a 16+ character run of letters. Prose such as
    // `project-key = basename(repoRoot)` is therefore not redacted, while
    // `db_password = hunter2secure` still is.
    pattern:
      /((?:"|')?(?<![A-Za-z0-9_.-])(?:[A-Za-z0-9_.-]+(?<!\.)key(?:s)?|[A-Za-z0-9_.-]*(?:token|secret|password|passwd|pwd|authorization|bearer|credential)[A-Za-z0-9_.-]*)["']?\s*[:=]\s*)(?:(["'])([^"'\n]+)\2|((?=[A-Za-z0-9_\-+/=.]{8,})(?=[A-Za-z0-9_\-+/=.]*[0-9+=/._-])[A-Za-z0-9_\-+/=.]{8,}|[A-Za-z0-9_\-+/=.]{16,}))/gi,
    replacement: `$1$2${placeholderFor('generic-assignment')}$2`
  })
])

/**
 * Split `text` into plain-text fragments and opaque placeholder tokens.
 *
 * Rules are applied to fragments only, so a placeholder produced by an earlier
 * rule (or present in caller text) can never be matched again.
 * @param {string} text
 * @returns {Array<{text: string}|{placeholder: string}>}
 */
function splitOnPlaceholders(text) {
  const pieces = []
  const regex = new RegExp(PLACEHOLDER_RE.source, PLACEHOLDER_RE.flags)
  let cursor = 0
  let match
  while ((match = regex.exec(text)) !== null) {
    if (match.index > cursor) pieces.push({ text: text.slice(cursor, match.index) })
    pieces.push({ placeholder: match[0] })
    cursor = match.index + match[0].length
  }
  if (cursor < text.length) pieces.push({ text: text.slice(cursor) })
  return pieces
}

/** Count non-overlapping matches of `pattern` in `text` without mutating state. */
function countMatches(text, pattern) {
  const matches = text.match(new RegExp(pattern.source, pattern.flags))
  return matches === null ? 0 : matches.length
}

/**
 * Apply one rule to the non-placeholder fragments of `text`.
 * @param {string} text
 * @param {{kind: string, pattern: RegExp, replacement?: string}} rule
 * @returns {{text: string, count: number}}
 */
function applyRule(text, rule) {
  const replacement = rule.replacement ?? placeholderFor(rule.kind)
  let count = 0
  let output = ''
  for (const piece of splitOnPlaceholders(text)) {
    if (piece.placeholder !== undefined) {
      output += piece.placeholder
      continue
    }
    const matches = countMatches(piece.text, rule.pattern)
    if (matches === 0) {
      output += piece.text
      continue
    }
    count += matches
    output += piece.text.replace(new RegExp(rule.pattern.source, rule.pattern.flags), replacement)
  }
  return { text: output, count }
}

/**
 * Turn a kind→count map into the canonical `[{kind, count}]` list: only
 * non-zero counts, sorted by `kind` ascending (code-unit order).
 * @param {Map<string, number>} counts
 * @returns {Array<{kind: string, count: number}>}
 */
function sortHits(counts) {
  const hits = []
  for (const [kind, count] of counts) {
    if (count > 0) hits.push({ kind, count })
  }
  hits.sort((left, right) => compareStrings(left.kind, right.kind))
  return hits
}

/** Throw a structured misuse error when a text helper receives a non-string. */
function requireText(text, functionName) {
  if (typeof text !== 'string') throw misuse(`${functionName} expects a string`)
}

/**
 * Redact every known secret in `text`.
 *
 * A rule hit is replaced with `«REDACTED:<kind>»`; `hits` reports only rules
 * that actually matched, sorted by `kind`. The operation is idempotent and
 * deterministic: redacting an already redacted text returns that text unchanged
 * with `hits: []`.
 * @param {string} text input text (UTF-8 string).
 * @returns {{text: string, hits: Array<{kind: string, count: number}>}}
 * @throws {Error & {code: string}} `HANDOFF_INTERNAL` when `text` is not a string.
 */
export function redactText(text) {
  requireText(text, 'redactText')
  const counts = new Map()
  let current = text
  for (const rule of REDACTION_RULES) {
    const result = applyRule(current, rule)
    current = result.text
    if (result.count > 0) counts.set(rule.kind, (counts.get(rule.kind) ?? 0) + result.count)
  }
  return { text: current, hits: sortHits(counts) }
}

/**
 * Detect secrets without returning modified text.
 *
 * Detection follows the same fixed rule order and placeholder protection as
 * {@link redactText}, so the reported kinds/counts are exactly the ones a
 * redaction would perform (a secret is never double-counted under a specific
 * and a generic rule). A clean text — including already redacted text — yields
 * an empty array.
 * @param {string} text input text.
 * @returns {Array<{kind: string, count: number}>} only non-zero hits, sorted by kind.
 * @throws {Error & {code: string}} `HANDOFF_INTERNAL` when `text` is not a string.
 */
export function scanSecrets(text) {
  requireText(text, 'scanSecrets')
  return redactText(text).hits
}

/**
 * Final pre-write check for artifact text. Semantically identical to
 * {@link scanSecrets}: an empty array means the artifact is safe to write;
 * a non-empty array must be mapped by the caller to
 * `HANDOFF_SECRET_CHECK_FAILED` and the whole batch must not be written.
 * @param {string} text artifact text about to be written.
 * @returns {Array<{kind: string, count: number}>} only non-zero hits, sorted by kind.
 * @throws {Error & {code: string}} `HANDOFF_INTERNAL` when `text` is not a string.
 */
export function finalCheck(text) {
  return scanSecrets(text)
}

/**
 * Recursively redact strings inside `value`.
 *
 * Strings are redacted with {@link redactText}; arrays and plain objects are
 * rebuilt (never mutated in place) so the caller keeps ownership of its input.
 * Object keys are structural and are not redacted. Any other value (number,
 * boolean, null, Date, Buffer, class instance, …) is returned as-is.
 * @param {unknown} value arbitrary JSON-ish value.
 * @returns {{value: unknown, hits: Array<{kind: string, count: number}>}}
 *   a structurally cloned value plus aggregated hits sorted by kind.
 */
export function redactDeep(value) {
  const counts = new Map()
  const walk = (node) => {
    if (typeof node === 'string') {
      const result = redactText(node)
      for (const hit of result.hits) counts.set(hit.kind, (counts.get(hit.kind) ?? 0) + hit.count)
      return result.text
    }
    if (Array.isArray(node)) return node.map(walk)
    if (isPlainRecord(node)) {
      const output = {}
      for (const key of Object.keys(node)) output[key] = walk(node[key])
      return output
    }
    return node
  }
  return { value: walk(value), hits: sortHits(counts) }
}

/** Path segments that are denied as directories, with their stable reason. */
const DENIED_DIRECTORY_REASONS = Object.freeze([
  ['node_modules', 'directory:node_modules'],
  ['.venv', 'directory:.venv'],
  ['.git', 'directory:.git'],
  ['.dsh', 'directory:.dsh']
])

/**
 * Why a workspace-relative path must never be read or copied, or `null` when it
 * is allowed.
 *
 * Matching is case-insensitive and host-separator agnostic. The checks run in a
 * fixed order so the reason is stable: denied directory segments first, then
 * dot-env files, private keys, credential-named files and databases.
 *
 * Recognized reasons: `directory:node_modules`, `directory:.venv`,
 * `directory:.git`, `directory:.dsh`, `dot-env`, `private-key`, `credential`,
 * `database`.
 * @param {string} relativePath workspace-relative or otherwise shaped path.
 * @returns {string|null} stable English reason, or `null` when not denied.
 * @throws {Error & {code: string}} `HANDOFF_INTERNAL` when `relativePath` is not a string.
 */
export function deniedReason(relativePath) {
  if (typeof relativePath !== 'string') throw misuse('deniedReason expects a relative path string')
  const normalized = toPosix(relativePath).replace(/^\.\/+/, '').replace(/\/+$/, '')
  if (normalized === '' || normalized === '.') return null
  const segments = normalized.split('/').filter((segment) => segment !== '' && segment !== '.')
  if (segments.length === 0) return null

  for (const segment of segments) {
    const lowered = segment.toLowerCase()
    for (const [directory, reason] of DENIED_DIRECTORY_REASONS) {
      if (lowered === directory) return reason
    }
  }

  const base = segments[segments.length - 1].toLowerCase()
  if (base === '.env' || base.startsWith('.env.')) return 'dot-env'
  if (base.startsWith('id_rsa')) return 'private-key'
  if (base.endsWith('.pem') || base.endsWith('.key')) return 'private-key'
  if (base.endsWith('.p12') || base.endsWith('.pfx')) return 'private-key'
  if (base.includes('credential')) return 'credential'
  if (base.endsWith('.db')) return 'database'
  if (base.includes('.sqlite')) return 'database'
  return null
}

/**
 * True when `relativePath` matches the file-level denylist and must be skipped
 * by collection/copying (`node_modules`, `.venv`, `.git`, dot-env files,
 * private keys, credential-named files and databases).
 * @param {string} relativePath workspace-relative path.
 * @returns {boolean}
 * @throws {Error & {code: string}} `HANDOFF_INTERNAL` when `relativePath` is not a string.
 */
export function isDeniedFile(relativePath) {
  return deniedReason(relativePath) !== null
}
