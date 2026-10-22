/**
 * Pure path, identity and hashing helpers for dsh-handoff-kit.
 *
 * Everything here is deterministic and synchronous: no filesystem access, no
 * clock, no randomness. Identity inputs (timestamps, random suffixes, canonical
 * workspace paths) are injected by the caller so tests can pin them.
 *
 * @module dsh-handoff-kit/paths
 */

import { createHash } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { BATCH_ID_RE, ERROR, GIT_SHA_RE, handoffError } from './contracts.js'

const WINDOWS_DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/
const WINDOWS_DRIVE_RELATIVE = /^[A-Za-z]:(?![\\/])/
const UNC_PREFIX = /^[\\/]{2}/
const TOKEN_PREFIX = /^\$(WORKSPACE|DSH_HOME)(?:[\\/]|$)/
const HEX_SUFFIX = /^[0-9a-f]{4}$/

function misuse(detail) {
  return handoffError(ERROR.INTERNAL, detail)
}

function platformCaseInsensitive(platform) {
  return platform === 'win32' || platform === undefined
}

/**
 * Lower-case hex sha256 of a string (UTF-8), Uint8Array, or Buffer.
 * @param {string|Uint8Array} input
 * @returns {string}
 */
export function sha256Hex(input) {
  const hash = createHash('sha256')
  if (typeof input === 'string') hash.update(input, 'utf8')
  else if (input instanceof Uint8Array) hash.update(input)
  else throw misuse('sha256Hex expects a string or Uint8Array')
  return hash.digest('hex')
}

/** First `length` characters of a hash, for compact display. */
export function shortHash(hash, length = 8) {
  if (typeof hash !== 'string') throw misuse('shortHash expects a string')
  return hash.slice(0, Math.max(1, length))
}

/** Convert native separators to POSIX separators (manifest/HANDOFF convention). */
export function toPosix(value) {
  return String(value).replace(/\\/g, '/')
}

/**
 * Sanitize a directory basename into the project-key slug charset
 * `[a-z0-9._-]`. Never returns an empty string.
 * @param {string} name
 * @returns {string}
 */
export function slugifyName(name) {
  const normalized = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-._]+/, '')
    .replace(/[-._]+$/, '')
  const bounded = normalized.slice(0, 40)
  return bounded === '' ? 'workspace' : bounded
}

/**
 * Stable project key: `<slug>-<sha256(seed)[:8]>`.
 *
 * The seed prefers the git remote origin URL (stable across clones) and falls
 * back to the canonical workspace path (stable for one checkout, no remote).
 * @param {{repoRoot: string, remoteUrl?: string|null, workspaceCanonical: string}} input
 * @returns {string}
 */
export function projectKey({ repoRoot, remoteUrl, workspaceCanonical }) {
  if (typeof repoRoot !== 'string' || repoRoot === '') throw misuse('projectKey needs repoRoot')
  if (typeof workspaceCanonical !== 'string' || workspaceCanonical === '')
    throw misuse('projectKey needs workspaceCanonical')
  const remote = typeof remoteUrl === 'string' ? remoteUrl.trim() : ''
  const seed = remote !== '' ? `remote:${remote}` : `workspace:${toPosix(workspaceCanonical)}`
  return `${slugifyName(basename(repoRoot))}-${sha256Hex(seed).slice(0, 8)}`
}

function pad2(value) {
  return String(value).padStart(2, '0')
}

/**
 * UTC batch timestamp `YYYYMMDDTHHmmssZ`.
 * @param {Date|number} date
 * @returns {string}
 */
export function formatBatchTimestamp(date) {
  const d = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(d.getTime())) throw misuse('formatBatchTimestamp needs a valid date')
  return (
    `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}` +
    `T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`
  )
}

/**
 * Build a fixed-width batch id from an injected clock and random suffix.
 * @param {{date: Date|number, suffix: string}} input
 * @returns {string}
 */
export function makeBatchId({ date, suffix }) {
  const candidate = suffix === undefined ? '0000' : String(suffix)
  if (!HEX_SUFFIX.test(candidate)) throw misuse('batch id suffix must be four lower-case hex characters')
  return `${formatBatchTimestamp(date)}-${candidate}`
}

/**
 * Convert a batch timestamp prefix back into an ISO instant, or undefined.
 * @param {string} batchId
 * @returns {string|undefined}
 */
export function batchTimestampToIso(batchId) {
  if (typeof batchId !== 'string') return undefined
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(batchId)
  if (match === null) return undefined
  const [, year, month, day, hour, minute, second] = match
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`
  return Number.isNaN(Date.parse(iso)) ? undefined : iso
}

/** True when `value` has the fixed batch-id shape. */
export function isBatchId(value) {
  return typeof value === 'string' && BATCH_ID_RE.test(value)
}

/** Lexicographic comparator for fixed-width batch ids (ascending). */
export function compareBatchIds(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/** True when `value` looks like a full git object id. */
export function isGitSha(value) {
  return typeof value === 'string' && GIT_SHA_RE.test(value)
}

/**
 * True when the input is absolute, drive-relative, or UNC — in either Windows
 * or POSIX spelling, so escape attempts are rejected regardless of host OS.
 * @param {string} value
 * @returns {boolean}
 */
export function isAbsoluteAny(value) {
  if (typeof value !== 'string') return false
  return (
    isAbsolute(value) ||
    WINDOWS_DRIVE_ABSOLUTE.test(value) ||
    WINDOWS_DRIVE_RELATIVE.test(value) ||
    UNC_PREFIX.test(value) ||
    value.startsWith('/') ||
    value.startsWith('\\')
  )
}

/**
 * Validate a workspace-relative path and return its canonical POSIX form.
 * Rejects absolute paths, drive letters, UNC, NUL, empty paths and `..`
 * segments. `.` segments are dropped.
 * @param {unknown} input raw path.
 * @param {string} [label] diagnostic label.
 * @returns {string} relative POSIX path, never empty.
 * @throws {Error & {code: string}} `HANDOFF_PATH_ESCAPE`.
 */
export function validateRelativePath(input, label = 'path') {
  if (typeof input !== 'string') throw handoffError(ERROR.PATH_ESCAPE, `${label} must be a string`)
  const raw = input.trim()
  if (raw === '') throw handoffError(ERROR.PATH_ESCAPE, `${label} must not be empty`)
  if (raw.includes('\0')) throw handoffError(ERROR.PATH_ESCAPE, `${label} contains a NUL byte`)
  if (isAbsoluteAny(raw))
    throw handoffError(ERROR.PATH_ESCAPE, `${label} must be workspace-relative, got absolute "${raw}"`)
  const segments = raw.split(/[\\/]+/).filter((segment) => segment !== '' && segment !== '.')
  if (segments.length === 0) throw handoffError(ERROR.PATH_ESCAPE, `${label} resolves to the workspace root`)
  for (const segment of segments) {
    if (segment === '..')
      throw handoffError(ERROR.PATH_ESCAPE, `${label} must not contain ".." ("${raw}")`)
  }
  return segments.join('/')
}

/**
 * Compare two absolute paths for containment, honoring host case rules.
 * Both paths are resolved first, so `.`/`..` and trailing separators are safe.
 * @param {string} parent
 * @param {string} child
 * @param {{platform?: string}} [options]
 * @returns {boolean}
 */
export function isInside(parent, child, options = {}) {
  const caseInsensitive = platformCaseInsensitive(options.platform)
  let left = resolve(parent)
  let right = resolve(child)
  if (caseInsensitive) {
    left = left.toLowerCase()
    right = right.toLowerCase()
  }
  if (left === right) return true
  const prefix = left.endsWith(sep) ? left : left + sep
  return right.startsWith(prefix)
}

/**
 * Resolve a validated relative path under `root` and assert containment.
 * @param {string} root absolute workspace/handoff root.
 * @param {string} relPath workspace-relative path.
 * @param {{platform?: string}} [options]
 * @returns {string} absolute path.
 * @throws {Error & {code: string}} `HANDOFF_PATH_ESCAPE`.
 */
export function resolveInside(root, relPath, options = {}) {
  if (typeof root !== 'string' || root === '') throw misuse('resolveInside needs an absolute root')
  const relativePath = validateRelativePath(relPath)
  const absolute = resolve(root, ...relativePath.split('/'))
  if (!isInside(root, absolute, options))
    throw handoffError(ERROR.PATH_ESCAPE, `${relPath} escapes ${root}`)
  return absolute
}

/**
 * Convert an absolute path into a tokenized machine path using `$WORKSPACE` /
 * `$DSH_HOME`, preserving POSIX separators. Paths outside both contexts stay
 * absolute (POSIX spelling).
 * @param {string} absolutePath
 * @param {{workspaceRoot?: string, dshHome?: string, platform?: string}} contexts
 * @returns {string}
 */
export function tokenizePath(absolutePath, contexts = {}) {
  if (typeof absolutePath !== 'string' || absolutePath === '')
    throw misuse('tokenizePath needs an absolute path')
  const absolute = resolve(absolutePath)
  for (const [token, root] of [
    ['$WORKSPACE', contexts.workspaceRoot],
    ['$DSH_HOME', contexts.dshHome]
  ]) {
    if (typeof root !== 'string' || root === '') continue
    if (!isInside(root, absolute, contexts)) continue
    const rest = relative(resolve(root), absolute)
    return rest === '' ? token : `${token}/${toPosix(rest)}`
  }
  return toPosix(absolute)
}

/**
 * Inverse of {@link tokenizePath}. Unknown tokens are rejected rather than
 * silently kept, so a malformed manifest cannot smuggle an opaque prefix.
 * @param {string} tokenized path beginning with `$WORKSPACE`/`$DSH_HOME`, or absolute.
 * @param {{workspaceRoot?: string, dshHome?: string}} contexts
 * @returns {string} absolute native path.
 * @throws {Error & {code: string}} `HANDOFF_PATH_ESCAPE` for unknown tokens.
 */
export function detokenizePath(tokenized, contexts = {}) {
  if (typeof tokenized !== 'string' || tokenized === '')
    throw handoffError(ERROR.PATH_ESCAPE, 'path must be a non-empty string')
  const match = TOKEN_PREFIX.exec(tokenized)
  if (match === null) {
    if (!isAbsoluteAny(tokenized)) throw handoffError(ERROR.PATH_ESCAPE, `path "${tokenized}" is not absolute or tokenized`)
    return resolve(tokenized)
  }
  const token = `$${match[1]}`
  const root = token === '$WORKSPACE' ? contexts.workspaceRoot : contexts.dshHome
  if (typeof root !== 'string' || root === '')
    throw handoffError(ERROR.PATH_ESCAPE, `${token} is not available in this context`)
  const rest = tokenized.slice(token.length).replace(/^[\\/]+/, '')
  return rest === '' ? resolve(root) : resolve(root, ...rest.split(/[\\/]+/))
}

/**
 * Workspace-relative POSIX path for an absolute path, or undefined when the
 * path lies outside the workspace.
 * @param {string} workspaceRoot
 * @param {string} absolutePath
 * @param {{platform?: string}} [options]
 * @returns {string|undefined}
 */
export function relativeToWorkspace(workspaceRoot, absolutePath, options = {}) {
  if (!isInside(workspaceRoot, absolutePath, options)) return undefined
  const rest = relative(resolve(workspaceRoot), resolve(absolutePath))
  return rest === '' ? '' : toPosix(rest)
}

/** Normalize a manifest artifact path (batch-relative, POSIX). */
export function normalizeArtifactPath(input, label = 'artifact path') {
  const value = validateRelativePath(input, label)
  return value
}

/** Directory of a batch-relative artifact path (`''` for top-level files). */
export function artifactDirname(artifactPath) {
  const normalized = toPosix(artifactPath)
  const index = normalized.lastIndexOf('/')
  return index < 0 ? '' : normalized.slice(0, index)
}

/** Resolve a batch-relative artifact path under a batch directory. */
export function resolveArtifact(batchDir, artifactPath) {
  return resolveInside(batchDir, normalizeArtifactPath(artifactPath))
}

/** Re-export for tests: platform-agnostic dirname of a POSIX path. */
export function posixDirname(value) {
  const normalized = toPosix(value)
  const index = normalized.lastIndexOf('/')
  return index < 0 ? '.' : normalized.slice(0, index) || '/'
}

/** Re-export for tests: platform-native directory join helper. */
export function joinNative(root, posixPath) {
  return join(root, ...toPosix(posixPath).split('/'))
}

/** Re-export for tests: native dirname. */
export function nativeDirname(value) {
  return dirname(value)
}
