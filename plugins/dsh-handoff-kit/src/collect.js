/**
 * Bounded, deterministic workspace collection for dsh-handoff-kit.
 *
 * `collectWorkspace` walks the workspace exactly once (BFS, stable order),
 * skips denylisted directories, symlinks and non-regular files, selects a
 * bounded evidence-file list, and hashes the survivors under per-file and total
 * byte caps. It never throws for filesystem problems: individual read failures
 * degrade to warnings plus a `skippedReason`. The only throwing paths are
 * caller-argument violations (explicit `files` entries) and programmer misuse.
 *
 * Filesystem access goes exclusively through the injected `io` adapter:
 *
 * ```js
 * io = {
 *   async lstat(absPath) -> {type: 'file'|'directory'|'symlink'|'other', size?: number} | undefined,
 *   async readText(absPath) -> string,
 *   async readBytes(absPath, maxBytes) -> Uint8Array,
 *   async listDir(absPath) -> Array<{name, type: 'file'|'directory'|'other', size?: number}>
 * }
 * ```
 *
 * The module never spawns processes, never reads the clock and never uses
 * randomness; equal inputs produce byte-identical outputs.
 *
 * @module dsh-handoff-kit/collect
 */

import { Buffer } from 'node:buffer'
import { join } from 'node:path'

import {
  ERROR,
  FS_NOT_FOUND,
  FS_TOO_LARGE,
  LIMITS,
  errorMessageOf,
  handoffError,
  isPlainObject
} from './contracts.js'
import { relativeToWorkspace, sha256Hex, toPosix, validateRelativePath } from './paths.js'
import { isDeniedFile } from './redact.js'

/** Entry-file basenames (lower-case). */
const ENTRY_FILES = new Set([
  'package.json',
  'pyproject.toml',
  'cargo.toml',
  'go.mod',
  'makefile',
  'agents.md'
])
/** Config-file basenames (lower-case). */
const CONFIG_FILES = new Set(['tsconfig.json'])
/** Directory segments that are always skipped, regardless of the redaction list. */
const DENIED_DIRECTORIES = new Set(['node_modules', '.venv', '.git', '.dsh'])
/** Directory segments whose matching files are test evidence. */
const TEST_DIRECTORIES = new Set(['test', 'tests', '__tests__'])
/** Test-file basename patterns: `*.test.*`, `*.spec.*`, `*_test.*`, `test_*.py`, `*Test.java`. */
const TEST_FILE_RE =
  /(?:^test[-_].*|.+[._-](?:test|spec)\.[^/]+$|[A-Za-z0-9]Test\.[A-Za-z]+$)/
/** Candidate evidence is only searched at most this many path segments deep. */
const EVIDENCE_MAX_DEPTH = 3
/** Source-code extensions understood by {@link classifyRole}. */
const SOURCE_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.cs',
  '.c',
  '.h',
  '.cpp',
  '.rb',
  '.php',
  '.sh',
  '.ps1'
])

/** Deterministic code-point comparator (no `localeCompare`, no ICU). */
function compareStrings(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/**
 * Merge caller overrides on top of the frozen global {@link LIMITS} table so a
 * partial `limits` object (tests) keeps every default.
 * @param {Record<string, number>|undefined} limits
 * @returns {typeof LIMITS}
 */
function mergeLimits(limits) {
  const overrides = isPlainObject(limits) ? limits : {}
  return { ...LIMITS, ...overrides }
}

/** True when `error` is the io adapter's "path does not exist" signal. */
function isNotFound(error) {
  return (
    error !== null &&
    typeof error === 'object' &&
    (error.code === FS_NOT_FOUND || error.code === 'ENOENT')
  )
}

/** Human-readable reason from a boolean-or-string denylist predicate. */
function deniedReasonFor(relativePath, denied) {
  if (typeof denied === 'function') {
    let answer
    try {
      answer = denied(relativePath)
    } catch {
      answer = null
    }
    if (answer === true) return 'denylist'
    if (typeof answer === 'string' && answer !== '') return answer
  }
  // Structural backstop: these directories must never be walked even if a
  // caller-supplied denylist predicate only classifies files.
  for (const segment of relativePath.split('/')) {
    const lower = segment.toLowerCase()
    if (DENIED_DIRECTORIES.has(lower)) return `directory:${lower}`
  }
  return null
}

/** True when `relativePath` is the excluded prefix itself or inside it. */
function isExcluded(relativePath, excludedPrefixes) {
  for (const prefix of excludedPrefixes) {
    if (relativePath === prefix || relativePath.startsWith(`${prefix}/`)) return true
  }
  return false
}

/**
 * Derive workspace-relative prefixes that must not be collected because they
 * are the handoff output home (possible when `$DSH_HOME` lives inside the
 * workspace). `workspaceCanonical` is the realpath of `workspaceRoot`.
 * @param {{workspaceRoot: string, workspaceCanonical?: string, dshHome?: string}} input
 * @returns {string[]}
 */
function excludedWorkspacePrefixes({ workspaceRoot, workspaceCanonical, dshHome }) {
  if (typeof dshHome !== 'string' || dshHome.trim() === '') return []
  const root =
    typeof workspaceCanonical === 'string' && workspaceCanonical !== ''
      ? workspaceCanonical
      : workspaceRoot
  let relative
  try {
    relative = relativeToWorkspace(root, dshHome)
  } catch {
    relative = undefined
  }
  if (relative === undefined || relative === '') return []
  const normalized = relative.replace(/\/+$/, '')
  return normalized === '' ? [] : [normalized]
}

/**
 * Classify a workspace-relative path into the handoff evidence role.
 *
 * Rule order (first match wins): entry/manifest → config → test → doc → source
 * → other. The function is pure and locale-independent.
 *
 * @param {string} relativePath workspace-relative POSIX path.
 * @returns {'entry'|'config'|'test'|'doc'|'source'|'other'}
 */
export function classifyRole(relativePath) {
  const normalized = toPosix(String(relativePath ?? '')).replace(/^\.\//, '')
  const segments = normalized.split('/').filter((segment) => segment !== '' && segment !== '.')
  if (segments.length === 0) return 'other'
  const basename = segments[segments.length - 1]
  const lowerBasename = basename.toLowerCase()
  const firstSegment = segments[0].toLowerCase()

  // entry / manifest
  if (ENTRY_FILES.has(lowerBasename) || lowerBasename.startsWith('readme')) return 'entry'
  // config
  if (CONFIG_FILES.has(lowerBasename)) return 'config'
  if (lowerBasename.includes('.config.')) return 'config'
  if (/^docker-compose/.test(lowerBasename)) return 'config'
  if (/^requirements.*\.txt$/.test(lowerBasename)) return 'config'
  if (firstSegment === 'config') return 'config'
  // test
  if (segments.slice(0, -1).some((segment) => TEST_DIRECTORIES.has(segment.toLowerCase())))
    return 'test'
  if (TEST_FILE_RE.test(basename)) return 'test'
  // doc
  if (segments.slice(0, -1).some((segment) => segment.toLowerCase() === 'docs')) return 'doc'
  if (lowerBasename.endsWith('.md')) return 'doc'
  // source
  const dotIndex = lowerBasename.lastIndexOf('.')
  const extension = dotIndex < 0 ? '' : lowerBasename.slice(dotIndex)
  if (SOURCE_EXTENSIONS.has(extension)) return 'source'
  return 'other'
}

/**
 * True when a path found during the walk is an automatic evidence candidate.
 * @param {string} relativePath workspace-relative POSIX path.
 * @param {number} depth path depth (top-level children are 1).
 * @returns {boolean}
 */
function isEvidenceCandidate(relativePath, depth) {
  if (depth > EVIDENCE_MAX_DEPTH) return false
  const segments = relativePath.split('/')
  const basename = segments[segments.length - 1]
  const lowerBasename = basename.toLowerCase()
  const directories = segments.slice(0, -1).map((segment) => segment.toLowerCase())

  if (ENTRY_FILES.has(lowerBasename) || lowerBasename.startsWith('readme')) return true
  if (CONFIG_FILES.has(lowerBasename)) return true
  if (lowerBasename.includes('.config.')) return true
  if (/^docker-compose/.test(lowerBasename) || /^requirements.*\.txt$/.test(lowerBasename)) return true
  if (directories.includes('config')) return true
  if (directories.some((segment) => TEST_DIRECTORIES.has(segment)) && TEST_FILE_RE.test(basename))
    return true
  if (directories.includes('docs')) return true
  return false
}

/**
 * lstat every segment of a workspace-relative path, without following
 * symlinks, and report whether the leaf is a regular file.
 * @param {{io: {lstat(absPath: string): Promise<{type: string, size?: number}|undefined>},
 *   workspaceRoot: string, relPath: string}} input
 * @returns {Promise<{status: 'file'|'symlink'|'missing'|'not-file'|'unreadable',
 *   info?: {type: string, size?: number}, detail?: string}>}
 */
async function inspectRegularFile({ io, workspaceRoot, relPath }) {
  const segments = relPath.split('/')
  let current = workspaceRoot
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment)
    const last = index === segments.length - 1
    let info
    try {
      info = await io.lstat(current)
    } catch (error) {
      if (isNotFound(error)) return { status: 'missing' }
      return { status: 'unreadable', detail: errorMessageOf(error) }
    }
    if (info === undefined || info === null) return { status: 'missing' }
    if (info.type === 'symlink') return { status: 'symlink' }
    if (!last && info.type !== 'directory') return { status: 'missing' }
    if (last) return info.type === 'file' ? { status: 'file', info } : { status: 'not-file' }
  }
  return { status: 'missing' }
}

/**
 * Validate caller-supplied explicit evidence paths.
 *
 * Absolute paths, drive letters, UNC paths and `..` are rejected with
 * `HANDOFF_PATH_ESCAPE` (via `paths.validateRelativePath`); a denylisted path
 * or any symlinked segment is also `HANDOFF_PATH_ESCAPE`; a missing or
 * non-regular path is `HANDOFF_INVALID_ARGS`.
 *
 * @param {{io: object, workspaceRoot: string, explicitFiles: unknown[],
 *   limits: typeof LIMITS, excluded: string[]}} input
 * @returns {Promise<string[]>} validated, deduplicated, sorted relative POSIX paths.
 * @throws {Error & {code: string}}
 */
async function validateExplicitFiles({ io, workspaceRoot, explicitFiles, limits, excluded }) {
  if (explicitFiles.length > limits.maxExplicitFiles)
    throw handoffError(
      ERROR.INVALID_ARGS,
      `files must contain at most ${limits.maxExplicitFiles} paths`
    )
  const validated = []
  const seen = new Set()
  for (const [index, raw] of explicitFiles.entries()) {
    const relativePath = validateRelativePath(raw, `files[${index}]`)
    if (seen.has(relativePath)) continue
    const denied = deniedReasonFor(relativePath, isDeniedFile)
    if (denied !== null)
      throw handoffError(
        ERROR.PATH_ESCAPE,
        `files[${index}] "${relativePath}" is denied by the handoff denylist (${denied})`
      )
    if (isExcluded(relativePath, excluded))
      throw handoffError(
        ERROR.PATH_ESCAPE,
        `files[${index}] "${relativePath}" is inside the excluded handoff home directory`
      )
    const segments = relativePath.split('/')
    let current = workspaceRoot
    for (const [segmentIndex, segment] of segments.entries()) {
      current = join(current, segment)
      const last = segmentIndex === segments.length - 1
      const prefix = segments.slice(0, segmentIndex + 1).join('/')
      let info
      try {
        info = await io.lstat(current)
      } catch (error) {
        throw handoffError(
          ERROR.READ_FAILED,
          `files[${index}] "${relativePath}" could not be inspected: ${errorMessageOf(error)}`
        )
      }
      if (info === undefined || info === null)
        throw handoffError(
          ERROR.INVALID_ARGS,
          `files[${index}] "${relativePath}" does not exist (missing "${prefix}")`
        )
      if (info.type === 'symlink')
        throw handoffError(
          ERROR.PATH_ESCAPE,
          `files[${index}] "${relativePath}" traverses symlink "${prefix}"; symlinked paths are not collectable`
        )
      if (!last && info.type !== 'directory')
        throw handoffError(
          ERROR.INVALID_ARGS,
          `files[${index}] "${relativePath}" does not exist ("${prefix}" is not a directory)`
        )
      if (last && info.type !== 'file')
        throw handoffError(
          ERROR.INVALID_ARGS,
          `files[${index}] "${relativePath}" is not a regular file`
        )
    }
    seen.add(relativePath)
    validated.push(relativePath)
  }
  validated.sort(compareStrings)
  return validated
}

/**
 * Truncate UTF-8 text to at most `maxBytes` bytes without splitting a code
 * point. Returns the clipped text plus its byte length and truncation flag.
 * @param {string} text
 * @param {number} maxBytes
 * @returns {{text: string, bytes: number, truncated: boolean}}
 */
function truncateUtf8(text, maxBytes) {
  const buffer = Buffer.from(String(text), 'utf8')
  if (buffer.length <= maxBytes) return { text: String(text), bytes: buffer.length, truncated: false }
  let end = Math.max(0, Math.floor(maxBytes))
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1
  return { text: buffer.subarray(0, end).toString('utf8'), bytes: end, truncated: true }
}

/**
 * Read one workspace file as a `copyFiles` candidate.
 *
 * Denylisted paths, symlinked paths (including symlinked ancestors), missing /
 * non-regular paths and files above `limits.copyMaxFileBytes` are reported as
 * `{path, skippedReason}` instead of throwing. Text is read as UTF-8 and
 * truncated (with `truncated: true`) if it turns out larger than the cap — a
 * safety net for an io adapter that cannot report file sizes.
 *
 * @param {{io: {
 *   lstat(absPath: string): Promise<{type: string, size?: number}|undefined>,
 *   readText(absPath: string): Promise<string>
 * }, workspaceRoot: string, relPath: string, limits?: Record<string, number>,
 * denied?: (relativePath: string) => boolean|string}} input
 * @returns {Promise<{path: string, content: string, bytes: number, truncated: boolean}
 *   | {path: string, skippedReason: string}>}
 * @throws {Error & {code: string}} `HANDOFF_PATH_ESCAPE` for an invalid relative path.
 */
export async function readCopyCandidate(input = {}) {
  const {
    io,
    workspaceRoot,
    relPath,
    limits,
    denied = isDeniedFile
  } = input ?? {}
  if (typeof workspaceRoot !== 'string' || workspaceRoot === '')
    throw handoffError(ERROR.INTERNAL, 'readCopyCandidate needs an absolute workspaceRoot')
  if (io === null || typeof io !== 'object' || typeof io.readText !== 'function')
    throw handoffError(ERROR.INTERNAL, 'readCopyCandidate needs a filesystem io adapter')
  const merged = mergeLimits(limits)
  const relativePath = validateRelativePath(relPath, 'copy path')

  if (deniedReasonFor(relativePath, denied) !== null)
    return { path: relativePath, skippedReason: 'DENIED' }

  const inspected = await inspectRegularFile({ io, workspaceRoot, relPath: relativePath })
  if (inspected.status === 'symlink') return { path: relativePath, skippedReason: 'SYMLINK' }
  if (inspected.status === 'missing') return { path: relativePath, skippedReason: 'NOT_FOUND' }
  if (inspected.status === 'not-file')
    return { path: relativePath, skippedReason: 'NOT_REGULAR_FILE' }
  if (inspected.status === 'unreadable')
    return { path: relativePath, skippedReason: 'READ_FAILED' }

  const size =
    Number.isFinite(inspected.info?.size) && inspected.info.size >= 0
      ? inspected.info.size
      : undefined
  if (size !== undefined && size > merged.copyMaxFileBytes)
    return { path: relativePath, skippedReason: 'FILE_TOO_LARGE' }

  const absolutePath = join(workspaceRoot, ...relativePath.split('/'))
  let text
  try {
    text = await io.readText(absolutePath)
  } catch (error) {
    if (error?.code === FS_TOO_LARGE) return { path: relativePath, skippedReason: 'FILE_TOO_LARGE' }
    return { path: relativePath, skippedReason: 'READ_FAILED' }
  }
  const clipped = truncateUtf8(text, merged.copyMaxFileBytes)
  return { path: relativePath, content: clipped.text, bytes: clipped.bytes, truncated: clipped.truncated }
}

/**
 * Collect bounded workspace evidence for a handoff package.
 *
 * The walk is BFS over `io.listDir`, deepest path `limits.maxDepth`, no more
 * than `limits.maxEntries` visited entries. Directory listings are re-sorted
 * here, so adapter order never leaks into the result. Denylisted paths,
 * symlinks and non-regular files are skipped (`denied` / `symlinksSkipped`),
 * never fatal. Hitting a bound stops the walk and records
 * `COLLECT_ENTRY_LIMIT` / `COLLECT_DEPTH_LIMIT` / `COLLECT_FILE_LIMIT`; a
 * per-file hash cap records `skippedReason: 'FILE_TOO_LARGE'`, and hitting the
 * total read cap records `COLLECT_HASH_LIMIT` and `skippedReason:
 * 'HASH_TOTAL_LIMIT'`. Unreadable directories/files degrade to
 * `COLLECT_UNREADABLE` warnings.
 *
 * Explicit `files` are validated strictly and may throw (see
 * `validateExplicitFiles`); trace-touched paths are best-effort and never
 * throw.
 *
 * @param {{
 *   workspaceRoot: string,
 *   workspaceCanonical?: string,
 *   dshHome?: string,
 *   explicitFiles?: unknown[],
 *   io: {
 *     lstat(absPath: string): Promise<{type: string, size?: number}|undefined>,
 *     readText(absPath: string): Promise<string>,
 *     readBytes(absPath: string, maxBytes: number): Promise<Uint8Array>,
 *     listDir(absPath: string): Promise<Array<{name: string, type: string, size?: number}>>
 *   },
 *   limits?: Record<string, number>,
 *   trace?: {touchedFiles?: Array<{path: string}>}|null
 * }} input
 * @returns {Promise<{
 *   entries: number, dirs: number, denied: number, symlinksSkipped: number,
 *   tree: Array<{name: string, type: 'file'|'directory'|'other', bytes?: number}>,
 *   files: Array<{path: string, role: string, bytes: number, sha256: string,
 *     skippedReason?: string}>,
 *   readBytes: number, explicitFiles: string[],
 *   warnings: Array<{code: string, detail: string}>
 * }>}
 * @throws {Error & {code: string}} `HANDOFF_PATH_ESCAPE` / `HANDOFF_INVALID_ARGS`
 *   / `HANDOFF_READ_FAILED` for invalid explicit `files` entries, and
 *   `HANDOFF_INTERNAL` for programmer misuse.
 */
export async function collectWorkspace(input = {}) {
  const {
    workspaceRoot,
    workspaceCanonical,
    dshHome,
    explicitFiles = [],
    io,
    limits,
    trace
  } = input ?? {}
  if (typeof workspaceRoot !== 'string' || workspaceRoot === '')
    throw handoffError(ERROR.INTERNAL, 'collectWorkspace needs an absolute workspaceRoot')
  if (
    io === null ||
    typeof io !== 'object' ||
    typeof io.listDir !== 'function' ||
    typeof io.lstat !== 'function' ||
    typeof io.readBytes !== 'function'
  )
    throw handoffError(ERROR.INTERNAL, 'collectWorkspace needs a filesystem io adapter')
  if (!Array.isArray(explicitFiles))
    throw handoffError(ERROR.INVALID_ARGS, 'files must be an array of strings')
  const merged = mergeLimits(limits)
  const excluded = excludedWorkspacePrefixes({ workspaceRoot, workspaceCanonical, dshHome })

  const state = {
    entries: 0,
    dirs: 0,
    denied: 0,
    symlinksSkipped: 0,
    readBytes: 0
  }
  const warnings = []
  const tree = []
  const candidateSet = new Set()

  const explicit = await validateExplicitFiles({
    io,
    workspaceRoot,
    explicitFiles,
    limits: merged,
    excluded
  })

  // ── BFS walk ──────────────────────────────────────────────────────────────
  let entryLimitHit = false
  let depthLimitHit = false
  const queue = [{ absolutePath: workspaceRoot, relativePath: '', depth: 0 }]
  while (queue.length > 0) {
    if (entryLimitHit) break
    const directory = queue.shift()
    let listing
    try {
      listing = await io.listDir(directory.absolutePath)
    } catch (error) {
      if (!isNotFound(error))
        warnings.push({
          code: 'COLLECT_UNREADABLE',
          detail: `cannot list "${directory.relativePath === '' ? '.' : directory.relativePath}": ${errorMessageOf(error)}`
        })
      continue
    }
    state.dirs += 1
    const entries = (Array.isArray(listing) ? listing : [])
      .filter(
        (entry) =>
          isPlainObject(entry) &&
          typeof entry.name === 'string' &&
          entry.name !== '' &&
          entry.name !== '.' &&
          entry.name !== '..' &&
          !entry.name.includes('/') &&
          !entry.name.includes('\\') &&
          !entry.name.includes('\0')
      )
      .sort((left, right) => compareStrings(left.name, right.name))
    const isTopLevel = directory.depth === 0

    for (const child of entries) {
      if (state.entries >= merged.maxEntries) {
        if (!entryLimitHit) {
          entryLimitHit = true
          warnings.push({
            code: 'COLLECT_ENTRY_LIMIT',
            detail: `stopped after ${merged.maxEntries} visited entries`
          })
        }
        break
      }
      const relativePath =
        directory.relativePath === '' ? child.name : `${directory.relativePath}/${child.name}`
      state.entries += 1

      if (isTopLevel && tree.length < merged.maxTreeEntries) {
        tree.push({
          name: child.name,
          type:
            child.type === 'directory' ? 'directory' : child.type === 'file' ? 'file' : 'other',
          ...(child.type === 'file' && Number.isFinite(child.size) ? { bytes: child.size } : {})
        })
      }

      if (deniedReasonFor(relativePath, isDeniedFile) !== null) {
        state.denied += 1
        continue
      }
      if (isExcluded(relativePath, excluded)) {
        state.denied += 1
        continue
      }

      let info
      try {
        info = await io.lstat(join(directory.absolutePath, child.name))
      } catch (error) {
        if (!isNotFound(error))
          warnings.push({
            code: 'COLLECT_UNREADABLE',
            detail: `cannot inspect "${relativePath}": ${errorMessageOf(error)}`
          })
        continue
      }
      if (info === undefined || info === null) continue
      if (info.type === 'symlink') {
        state.symlinksSkipped += 1
        continue
      }
      if (info.type === 'directory') {
        const childDepth = directory.depth + 1
        if (childDepth >= merged.maxDepth) {
          if (!depthLimitHit) {
            depthLimitHit = true
            warnings.push({
              code: 'COLLECT_DEPTH_LIMIT',
              detail: `stopped descending at depth ${merged.maxDepth}`
            })
          }
          continue
        }
        queue.push({
          absolutePath: join(directory.absolutePath, child.name),
          relativePath,
          depth: childDepth
        })
      } else if (info.type === 'file') {
        if (isEvidenceCandidate(relativePath, directory.depth + 1)) candidateSet.add(relativePath)
      }
    }
  }

  // ── trace-touched paths (best effort, never fatal) ────────────────────────
  const touchedFiles = Array.isArray(trace?.touchedFiles) ? trace.touchedFiles : []
  for (const touched of touchedFiles) {
    const rawPath = isPlainObject(touched) ? touched.path : undefined
    if (typeof rawPath !== 'string' || rawPath === '') continue
    let relativePath
    try {
      relativePath = validateRelativePath(rawPath, 'trace path')
    } catch {
      continue
    }
    if (candidateSet.has(relativePath)) continue
    if (deniedReasonFor(relativePath, isDeniedFile) !== null) continue
    if (isExcluded(relativePath, excluded)) continue
    const inspected = await inspectRegularFile({ io, workspaceRoot, relPath: relativePath })
    if (inspected.status === 'file') candidateSet.add(relativePath)
  }

  // ── evidence-file selection and hashing ───────────────────────────────────
  for (const relativePath of explicit) candidateSet.add(relativePath)
  const candidatePaths = [...candidateSet].sort(compareStrings)
  const selected = candidatePaths.slice(0, merged.maxEvidenceFiles)
  if (candidatePaths.length > merged.maxEvidenceFiles) {
    warnings.push({
      code: 'COLLECT_FILE_LIMIT',
      detail: `evidence file list truncated to ${merged.maxEvidenceFiles} of ${candidatePaths.length} candidates`
    })
  }

  const files = []
  let hashStopped = false
  let hashWarningAdded = false
  const stopHashing = (message) => {
    hashStopped = true
    if (!hashWarningAdded) {
      hashWarningAdded = true
      warnings.push({ code: 'COLLECT_HASH_LIMIT', detail: message })
    }
  }
  const pushSkipped = (relativePath, role, size, skippedReason) => {
    files.push({
      path: relativePath,
      role,
      bytes: size ?? 0,
      sha256: '',
      skippedReason
    })
  }

  for (const relativePath of selected) {
    const role = classifyRole(relativePath)
    const absolutePath = join(workspaceRoot, ...relativePath.split('/'))
    let info
    try {
      info = await io.lstat(absolutePath)
    } catch (error) {
      if (!isNotFound(error))
        warnings.push({
          code: 'COLLECT_UNREADABLE',
          detail: `cannot inspect evidence file "${relativePath}": ${errorMessageOf(error)}`
        })
      continue
    }
    if (info === undefined || info === null || info.type !== 'file') continue
    const size = Number.isFinite(info.size) && info.size >= 0 ? info.size : undefined

    if (size !== undefined && size > merged.maxHashBytes) {
      pushSkipped(relativePath, role, size, 'FILE_TOO_LARGE')
      continue
    }
    if (hashStopped || (size !== undefined && state.readBytes + size > merged.maxHashTotalBytes)) {
      if (!hashStopped)
        stopHashing(
          `stopped hashing after ${state.readBytes} bytes (limit ${merged.maxHashTotalBytes})`
        )
      pushSkipped(relativePath, role, size, 'HASH_TOTAL_LIMIT')
      continue
    }

    const maxBytes = size === undefined ? merged.maxHashBytes : Math.max(size, 1)
    let bytes
    try {
      bytes = await io.readBytes(absolutePath, maxBytes)
    } catch (error) {
      if (error?.code === FS_TOO_LARGE) {
        pushSkipped(relativePath, role, size, 'FILE_TOO_LARGE')
      } else {
        warnings.push({
          code: 'COLLECT_UNREADABLE',
          detail: `cannot read evidence file "${relativePath}": ${errorMessageOf(error)}`
        })
        pushSkipped(relativePath, role, size, 'READ_FAILED')
      }
      continue
    }
    state.readBytes += bytes.length
    files.push({
      path: relativePath,
      role,
      bytes: bytes.length,
      sha256: sha256Hex(bytes)
    })
    if (state.readBytes > merged.maxHashTotalBytes) {
      stopHashing(
        `stopped hashing after ${state.readBytes} bytes (limit ${merged.maxHashTotalBytes})`
      )
    }
  }

  warnings.sort((left, right) => {
    if (left.code !== right.code) return compareStrings(left.code, right.code)
    return compareStrings(left.detail, right.detail)
  })

  return {
    entries: state.entries,
    dirs: state.dirs,
    denied: state.denied,
    symlinksSkipped: state.symlinksSkipped,
    tree,
    files,
    readBytes: state.readBytes,
    explicitFiles: explicit,
    warnings
  }
}
