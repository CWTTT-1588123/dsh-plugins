/**
 * Read-only `.git` metadata extraction for dsh-handoff-kit.
 *
 * Every parser here is pure: no filesystem access, no clock (the only date
 * construction converts an epoch stored inside the reflog text), no randomness,
 * and no `git` subprocess. {@link readGitInfo} receives an injected `io`
 * adapter so unit tests never touch the real disk, and it only ever reads files
 * inside the resolved git directory (`HEAD`, `refs/…`, `packed-refs`,
 * `logs/HEAD`, `config`, `index`) — never workspace files and never `git status`.
 *
 * All read failures degrade to `null` fields plus a warning; the function does
 * not throw for a missing or unreadable `.git`.
 *
 * @module dsh-handoff-kit/git
 */

import { join, resolve } from 'node:path'

import { FS_NOT_FOUND, GIT_SHA_RE, LIMITS, errorMessageOf, isPlainObject } from './contracts.js'
import { isAbsoluteAny } from './paths.js'

/** Prefix of the symbolic ref form of HEAD understood here. */
const BRANCH_REF_PREFIX = 'refs/heads/'
/** Upper bound on `gitInfo.reflog` entries (newest first). */
const MAX_REFLOG_ENTRIES = 10
/** `DIRC` + uint32BE version. */
const INDEX_HEADER_BYTES = 8
/**
 * A git index larger than this is not read at all (the version lives in the
 * first 8 bytes, but `io.readBytes` has no partial-read contract, so the whole
 * file would be materialized). Reuse the global per-file read bound.
 */
const MAX_INDEX_READ_BYTES = LIMITS.maxHashBytes

const ATTACHED_HEAD_RE = /^ref:\s*(\S+)\s*$/
const PACKED_REF_LINE_RE = /^([0-9a-f]{40})\s+(\S+)$/
const REFLOG_LINE_RE = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+) (\d{1,12}) ([+-]\d{4})$/
const GITDIR_LINE_RE = /^\s*gitdir:\s*(.+?)\s*$/
const CONFIG_HEADER_RE = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]$/
const CONFIG_ENTRY_RE = /^([A-Za-z][A-Za-z0-9-]*)\s*=\s*(.*)$/
const COMMIT_MESSAGE_PREFIX_RE = /^commit(?: \([^)]*\))?:\s*(.*)$/

/** Deterministic code-point comparator (no `localeCompare`, no ICU). */
function compareStrings(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/**
 * True when `error` is the io adapter's "path does not exist" signal.
 * @param {unknown} error
 * @returns {boolean}
 */
function isNotFound(error) {
  return (
    error !== null &&
    typeof error === 'object' &&
    (error.code === FS_NOT_FOUND || error.code === 'ENOENT')
  )
}

/** Strip the `commit: ` (and `commit (initial): `) reflog prefix. */
function reflogSubject(message) {
  const text = typeof message === 'string' ? message.trim() : ''
  const match = COMMIT_MESSAGE_PREFIX_RE.exec(text)
  return match === null ? text : match[1].trim()
}

/**
 * Parse a `.git/HEAD` file.
 *
 * - `ref: refs/heads/<branch>` → `{head: null, branch: '<branch>', detached: false}`
 *   (the commit is resolved later from the loose ref or `packed-refs`);
 * - a full 40-hex object id → detached HEAD;
 * - anything else → all-null (unresolved).
 *
 * @param {string|null|undefined} text raw HEAD contents.
 * @returns {{head: string|null, branch: string|null, detached: boolean}}
 */
export function parseGitHead(text) {
  const value = typeof text === 'string' ? text.trim() : ''
  if (value === '') return { head: null, branch: null, detached: false }
  const attached = ATTACHED_HEAD_RE.exec(value)
  if (attached !== null) {
    const ref = attached[1]
    const branch = ref.startsWith(BRANCH_REF_PREFIX) ? ref.slice(BRANCH_REF_PREFIX.length) : null
    return { head: null, branch: branch === '' ? null : branch, detached: false }
  }
  if (GIT_SHA_RE.test(value)) return { head: value, branch: null, detached: true }
  return { head: null, branch: null, detached: false }
}

/**
 * Parse a `.git/packed-refs` file into a `ref → sha` record.
 *
 * The header line (starting with `#`) and peeled-tag lines (`…^{}`) are
 * skipped; malformed lines are tolerated and ignored. Keys are sorted
 * lexicographically so two parses of the same text serialize identically.
 *
 * @param {string|null|undefined} text raw packed-refs contents.
 * @returns {Record<string, string>}
 */
export function parsePackedRefs(text) {
  const refs = {}
  if (typeof text !== 'string') return refs
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const match = PACKED_REF_LINE_RE.exec(trimmed)
    if (match === null) continue
    const [, sha, ref] = match
    if (ref.endsWith('^{}')) continue
    refs[ref] = sha
  }
  const sorted = {}
  for (const ref of Object.keys(refs).sort(compareStrings)) sorted[ref] = refs[ref]
  return sorted
}

/**
 * Parse a `.git/logs/HEAD` reflog. The last line is the newest entry.
 *
 * Reflog timestamp columns are epoch seconds; the stored `time` is the UTC ISO
 * instant (`new Date(seconds * 1000).toISOString()`). Malformed lines are
 * tolerated and skipped.
 *
 * @param {string|null|undefined} text raw reflog contents.
 * @returns {Array<{oldSha: string, newSha: string, actor: string, time: string, message: string, subject: string}>}
 */
export function parseReflog(text) {
  const entries = []
  if (typeof text !== 'string') return entries
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    const tabIndex = line.indexOf('\t')
    const meta = tabIndex < 0 ? line.trimEnd() : line.slice(0, tabIndex)
    const message = tabIndex < 0 ? '' : line.slice(tabIndex + 1)
    const match = REFLOG_LINE_RE.exec(meta)
    if (match === null) continue
    const seconds = Number(match[4])
    if (!Number.isFinite(seconds)) continue
    const when = new Date(seconds * 1000)
    if (Number.isNaN(when.getTime())) continue
    entries.push({
      oldSha: match[1],
      newSha: match[2],
      actor: match[3].trim(),
      time: when.toISOString(),
      message,
      subject: reflogSubject(message)
    })
  }
  return entries
}

/** Decode a git-config quoted value fragment (only the escapes we may see). */
function unescapeConfigValue(value) {
  return String(value).replace(/\\(["\\nt])/g, (_match, code) =>
    code === 'n' ? '\n' : code === 't' ? '\t' : code
  )
}

/** Trim whitespace, surrounding quotes and trailing inline comments. */
function normalizeConfigValue(raw) {
  const value = String(raw).trim()
  if (value === '' || value.startsWith('#') || value.startsWith(';')) return ''
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"'))
    return unescapeConfigValue(value.slice(1, -1))
  const comment = value.search(/\s[#;]/)
  return (comment < 0 ? value : value.slice(0, comment)).trim()
}

/**
 * Parse the one config field this package needs: the `url` of the
 * `[remote "origin"]` section.
 *
 * Section and key names are matched case-insensitively; subsystem names are
 * matched exactly. Missing sections, malformed lines and unrelated sections are
 * ignored. If several `url` keys exist the first non-empty one wins.
 *
 * @param {string|null|undefined} text raw `.git/config` contents.
 * @returns {{remoteOriginUrl: string|null}}
 */
export function parseGitConfig(text) {
  const info = { remoteOriginUrl: null }
  if (typeof text !== 'string') return info
  let section = null
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue
    const header = CONFIG_HEADER_RE.exec(line)
    if (header !== null) {
      section = {
        name: header[1].toLowerCase(),
        subsection: header[2] === undefined ? null : unescapeConfigValue(header[2])
      }
      continue
    }
    if (section === null) continue
    const entry = CONFIG_ENTRY_RE.exec(line)
    if (entry === null) continue
    if (section.name !== 'remote' || section.subsection !== 'origin') continue
    if (entry[1].toLowerCase() !== 'url') continue
    if (info.remoteOriginUrl !== null) continue
    const value = normalizeConfigValue(entry[2])
    if (value !== '') info.remoteOriginUrl = value
  }
  return info
}

/**
 * Parse the version field of a git index (`.git/index`).
 *
 * Returns the `DIRC` header version (2, 3 or 4) when the magic and the version
 * range are valid; otherwise `null` (missing file, truncated bytes, foreign
 * magic, or an unsupported future version).
 *
 * @param {Uint8Array|null|undefined} bytes first bytes of the index file.
 * @returns {number|null}
 */
export function parseIndexVersion(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < INDEX_HEADER_BYTES) return null
  if (bytes[0] !== 0x44 || bytes[1] !== 0x49 || bytes[2] !== 0x52 || bytes[3] !== 0x43) return null
  const version = ((bytes[4] << 24) | (bytes[5] << 16) | (bytes[6] << 8) | bytes[7]) >>> 0
  return version >= 2 && version <= 4 ? version : null
}

/** Keep only full 40-hex ref values, keyed by the ref name supplied. */
function normalizeRefs(refs) {
  const normalized = {}
  if (!isPlainObject(refs)) return normalized
  for (const name of Object.keys(refs).sort(compareStrings)) {
    const value = refs[name]
    if (typeof name !== 'string' || name === '') continue
    if (typeof value !== 'string') continue
    const sha = value.trim()
    if (GIT_SHA_RE.test(sha)) normalized[name] = sha
  }
  return normalized
}

/** Coerce a parsed-or-raw reflog value into the parsed entry array. */
function normalizeReflogEntries(reflog) {
  if (typeof reflog === 'string') return parseReflog(reflog)
  if (!Array.isArray(reflog)) return []
  const entries = []
  for (const entry of reflog) {
    if (!isPlainObject(entry) || typeof entry.newSha !== 'string') continue
    entries.push(entry)
  }
  return entries
}

/** Coerce a parsed-or-raw config value into `{remoteOriginUrl}`. */
function normalizeConfig(config) {
  if (typeof config === 'string') return parseGitConfig(config)
  if (isPlainObject(config) && typeof config.remoteOriginUrl === 'string')
    return { remoteOriginUrl: config.remoteOriginUrl }
  if (isPlainObject(config)) return { remoteOriginUrl: null }
  return { remoteOriginUrl: null }
}

/**
 * Assemble the deterministic `gitInfo` block from already-read `.git` inputs.
 *
 * Raw text inputs (`headText`, and string forms of `packedRefs`, `reflog`,
 * `config`) are parsed here; an already-parsed form is also accepted for
 * callers/tests that built it directly. The returned key order is fixed:
 * `head, branch, detached, remote, lastCommit, indexVersion, packedRefsPresent,
 * reflog`.
 *
 * @param {{
 *   headText?: string|null,
 *   refs?: Record<string, string>,
 *   packedRefs?: string|Record<string, string>|null,
 *   reflog?: string|Array<object>|null,
 *   config?: string|{remoteOriginUrl?: string|null}|null,
 *   indexBytes?: Uint8Array|null
 * }} [input]
 * @returns {{head: string|null, branch: string|null, detached: boolean,
 *   remote: string|null, lastCommit: {sha: string, time: string, subject: string}|null,
 *   indexVersion: number|null, packedRefsPresent: boolean,
 *   reflog: Array<{sha: string, time: string, subject: string}>}}
 */
export function buildGitInfo(input = {}) {
  const { headText = null, refs = {}, packedRefs = null, reflog = null, config = null, indexBytes = null } =
    input ?? {}
  const head = parseGitHead(headText)
  const looseRefs = normalizeRefs(refs)
  const packed =
    typeof packedRefs === 'string'
      ? parsePackedRefs(packedRefs)
      : normalizeRefs(packedRefs)
  const reflogEntries = normalizeReflogEntries(reflog)
  const configInfo = normalizeConfig(config)

  let resolvedHead = head.head
  if (resolvedHead === null && head.branch !== null) {
    const refName = `${BRANCH_REF_PREFIX}${head.branch}`
    resolvedHead = looseRefs[refName] ?? packed[refName] ?? null
  }

  // Order newest first. A well-formed reflog is append-only, so the last line
  // is the newest; sorting by the recorded timestamp (with later lines winning
  // timestamp ties) is equivalent for real reflogs and also tolerates a
  // reflog fixture that lists entries in descending order.
  const orderedReflog = reflogEntries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => {
      const leftTime = typeof left.entry.time === 'string' ? left.entry.time : ''
      const rightTime = typeof right.entry.time === 'string' ? right.entry.time : ''
      if (leftTime !== rightTime) return leftTime < rightTime ? 1 : -1
      return right.index - left.index
    })
    .map((item) => item.entry)
  const newest = orderedReflog.length > 0 ? orderedReflog[0] : null
  const recentReflog = orderedReflog.slice(0, MAX_REFLOG_ENTRIES).map((entry) => ({
    sha: entry.newSha,
    time: entry.time,
    subject: entry.subject
  }))

  return {
    head: resolvedHead,
    branch: head.branch,
    detached: head.detached,
    remote: configInfo.remoteOriginUrl,
    lastCommit:
      newest === null
        ? null
        : { sha: newest.newSha, time: newest.time, subject: newest.subject },
    indexVersion: parseIndexVersion(indexBytes),
    packedRefsPresent: packedRefs !== null && packedRefs !== undefined,
    reflog: recentReflog
  }
}

/** Extract the `gitdir:` target from a `.git` file (worktree/submodule). */
function parseGitdirPointer(text) {
  if (typeof text !== 'string') return null
  for (const line of text.split(/\r?\n/)) {
    const match = GITDIR_LINE_RE.exec(line)
    if (match !== null && match[1].trim() !== '') return match[1].trim()
  }
  return null
}

/**
 * Best-effort, warning-degrading read of the workspace's `.git` metadata.
 *
 * Supports both a `.git` directory and a `.git` file containing
 * `gitdir: <path>` (relative targets resolve against `workspaceRoot`). Every
 * individual read failure degrades to a `null` field plus a warning:
 * `GIT_HEAD_UNRESOLVED`, `GIT_REFLOG_UNREADABLE`, `GIT_CONFIG_UNREADABLE`,
 * `GIT_INDEX_UNREADABLE`. A missing/unusable `.git` returns
 * `{git: null, warnings: [{code: 'GIT_UNAVAILABLE', detail}]}`.
 *
 * The function never throws for filesystem problems and never reads workspace
 * files outside the resolved git directory.
 *
 * @param {{io: {
 *   lstat(absPath: string): Promise<{type: 'file'|'directory'|'symlink'|'other', size?: number}|undefined>,
 *   readText(absPath: string): Promise<string>,
 *   readBytes(absPath: string, maxBytes: number): Promise<Uint8Array>,
 *   listDir(absPath: string): Promise<Array<{name: string, type: string, size?: number}>>
 * }, workspaceRoot: string}} input
 * @returns {Promise<{git: ReturnType<typeof buildGitInfo>|null, warnings: Array<{code: string, detail: string}>}>}
 */
export async function readGitInfo(input = {}) {
  const { io, workspaceRoot } = input ?? {}
  const unavailable = (detail) => ({ git: null, warnings: [{ code: 'GIT_UNAVAILABLE', detail }] })

  if (typeof workspaceRoot !== 'string' || workspaceRoot.trim() === '')
    return unavailable('workspace root is unavailable')
  if (io === null || typeof io !== 'object' || typeof io.lstat !== 'function')
    return unavailable('filesystem io is unavailable')

  let dotGit
  try {
    dotGit = await io.lstat(join(workspaceRoot, '.git'))
  } catch (error) {
    return unavailable(`cannot inspect .git: ${errorMessageOf(error)}`)
  }
  if (dotGit === undefined || dotGit === null)
    return unavailable('.git was not found in the workspace root')

  let gitDir
  if (dotGit.type === 'directory') {
    gitDir = join(workspaceRoot, '.git')
  } else if (dotGit.type === 'file') {
    let pointerText
    try {
      pointerText = await io.readText(join(workspaceRoot, '.git'))
    } catch (error) {
      return unavailable(`cannot read the .git pointer file: ${errorMessageOf(error)}`)
    }
    const pointer = parseGitdirPointer(pointerText)
    if (pointer === null) return unavailable('.git file has no valid "gitdir:" pointer')
    gitDir = isAbsoluteAny(pointer) ? resolve(pointer) : resolve(workspaceRoot, pointer)
  } else {
    return unavailable(`.git is a ${String(dotGit.type ?? 'non-directory')} entry, not a directory`)
  }

  // HEAD (required for a usable repo; a failure is reported as unresolved HEAD).
  let headText = null
  let headReadDetail = null
  try {
    headText = await io.readText(join(gitDir, 'HEAD'))
  } catch (error) {
    headReadDetail = `cannot read HEAD: ${errorMessageOf(error)}`
  }

  // Loose ref for a symbolic HEAD. Absence is normal (packed-refs may hold it).
  const head = parseGitHead(headText)
  const refs = {}
  if (head.branch !== null) {
    const refName = `${BRANCH_REF_PREFIX}${head.branch}`
    try {
      const refText = await io.readText(join(gitDir, ...refName.split('/')))
      const sha = typeof refText === 'string' ? refText.trim() : ''
      if (GIT_SHA_RE.test(sha)) refs[refName] = sha
    } catch {
      /* packed-refs is the other legal location */
    }
  }

  let packedRefsText = null
  try {
    packedRefsText = await io.readText(join(gitDir, 'packed-refs'))
  } catch {
    /* no packed-refs file is the common case */
  }

  let reflogText = null
  let reflogError = null
  try {
    reflogText = await io.readText(join(gitDir, 'logs', 'HEAD'))
  } catch (error) {
    if (!isNotFound(error)) reflogError = `cannot read reflog: ${errorMessageOf(error)}`
  }

  let configText = null
  let configError = null
  try {
    configText = await io.readText(join(gitDir, 'config'))
  } catch (error) {
    if (!isNotFound(error)) configError = `cannot read config: ${errorMessageOf(error)}`
  }

  let indexBytes = null
  let indexError = null
  const indexPath = join(gitDir, 'index')
  let indexStat
  try {
    indexStat = await io.lstat(indexPath)
  } catch (error) {
    if (!isNotFound(error)) indexError = `cannot inspect index: ${errorMessageOf(error)}`
  }
  if (indexError === null && indexStat !== undefined && indexStat !== null) {
    if (indexStat.type !== 'file') {
      indexError = 'index is not a regular file'
    } else {
      const size =
        typeof indexStat.size === 'number' && Number.isFinite(indexStat.size)
          ? Math.max(0, Math.floor(indexStat.size))
          : undefined
      if (size !== undefined && size < INDEX_HEADER_BYTES) {
        indexError = `index header is truncated (${size} bytes)`
      } else if (size !== undefined && size > MAX_INDEX_READ_BYTES) {
        indexError = `index is larger than ${MAX_INDEX_READ_BYTES} bytes; version unavailable`
      } else {
        try {
          indexBytes = await io.readBytes(indexPath, size === undefined ? INDEX_HEADER_BYTES : size)
          if (parseIndexVersion(indexBytes) === null)
            indexError = 'index header is not a DIRC v2/3/4 header'
        } catch (error) {
          indexBytes = null
          indexError = `cannot read index: ${errorMessageOf(error)}`
        }
      }
    }
  }

  const git = buildGitInfo({
    headText,
    refs,
    packedRefs: packedRefsText,
    reflog: reflogText,
    config: configText,
    indexBytes
  })

  // Fixed warning order: head, reflog, config, index.
  const warnings = []
  if (git.head === null && git.detached !== true) {
    const detail =
      headReadDetail !== null
        ? headReadDetail
        : git.branch === null
          ? 'HEAD contains no resolvable commit'
          : `cannot resolve "${BRANCH_REF_PREFIX}${git.branch}" from loose refs or packed-refs`
    warnings.push({ code: 'GIT_HEAD_UNRESOLVED', detail })
  }
  if (reflogError !== null) warnings.push({ code: 'GIT_REFLOG_UNREADABLE', detail: reflogError })
  if (configError !== null) warnings.push({ code: 'GIT_CONFIG_UNREADABLE', detail: configError })
  if (indexError !== null) warnings.push({ code: 'GIT_INDEX_UNREADABLE', detail: indexError })

  return { git, warnings }
}
