/**
 * Deterministic extraction and existence checking of paths referenced by a
 * handoff narrative (P3/M5, finding `HANDOFF_PATH_MISSING`).
 *
 * A handoff package is prose plus evidence. Prose goes stale: it keeps naming
 * `docs/…`, `plugins/…`, `src/…` files that were renamed or removed after the
 * package was written. This module turns those mentions into a bounded,
 * deterministic path-reference list and checks existence against the current
 * workspace — no LLM, no network, no clock.
 *
 * Extraction rules (intentionally conservative):
 *   - only repository-relative prefixes are considered: `docs/`, `plugins/`,
 *     `scripts/`, `src/`, `test/`, `bin/`, `spec/`, `schema/`, `locale/`,
 *     `skills/`, plus the `$WORKSPACE/` and `$DSH_HOME/` tokens;
 *   - URLs (`https://…/docs/x`), plain file names (`README.md`) and paths with
 *     embedded spaces (`docs/my file.md`) are ignored;
 *   - trailing punctuation/backticks are stripped, duplicates are removed and
 *     the list is sorted;
 *   - absolute paths, drive letters, UNC paths and `..` segments are rejected
 *     by the shared path validator (`HANDOFF_PATH_ESCAPE` semantics): a
 *     malformed reference is ignored, never followed outside its root.
 *
 * @module dsh-handoff-kit/path-refs
 */

import { join } from 'node:path'

import { validateRelativePath } from './paths.js'

/** Repository-relative prefixes that count as path references. */
export const PATH_REF_PREFIXES = Object.freeze([
  'docs',
  'plugins',
  'scripts',
  'src',
  'test',
  'bin',
  'spec',
  'schema',
  'locale',
  'skills'
])

/** Hard bound on extracted references (keeps one check cheap). */
export const MAX_PATH_REFS = 300

/** Prefix pattern: a repository prefix or a token, followed by `/`. */
const START_RE = new RegExp(
  `(?<![A-Za-z0-9_./\\\\-])(?:\\$WORKSPACE|\\$DSH_HOME|${PATH_REF_PREFIXES.join('|')})\\/`,
  'g'
)

/** Characters that end a path reference (whitespace, quotes, punctuation, CJK marks). */
const STOP_CHARS = new Set([
  ' ',
  '\t',
  '\n',
  '\r',
  '\f',
  '\v',
  '"',
  "'",
  '`',
  '<',
  '>',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  '|',
  '*',
  '\\',
  '，',
  '。',
  '；',
  '：',
  '、',
  '（',
  '）',
  '「',
  '」',
  '『',
  '』',
  '\0'
])

const TRAILING_PUNCTUATION_RE = /[.,;:!?…]+$/
const EXTENSION_RE = /\.[A-Za-z0-9]{1,8}$/
/** A token that itself starts a fresh path reference (not a space-path continuation). */
const FRESH_REF_RE = new RegExp(
  `^(?:\\$WORKSPACE\\/|\\$DSH_HOME\\/|${PATH_REF_PREFIXES.join('\\/|')}\\/)`
)

/** Deterministic string comparator (no locale). */
function compareStrings(left, right) {
  return left === right ? 0 : left < right ? -1 : 1
}

/**
 * True when the text right after a space-terminated candidate continues an
 * embedded-space path (`docs/my file.md`) instead of starting a new reference.
 * A space-separated *fresh* reference (`docs/a.md src/b.js`) is not a
 * continuation, so both refs are kept.
 */
function looksLikeSpacePathContinuation(text, end) {
  let cursor = end
  while (cursor < text.length && (text[cursor] === ' ' || text[cursor] === '\t')) cursor += 1
  if (cursor >= text.length || cursor === end) return false
  let tokenEnd = cursor
  while (tokenEnd < text.length && !STOP_CHARS.has(text[tokenEnd])) tokenEnd += 1
  const token = text.slice(cursor, tokenEnd)
  if (token === '') return false
  if (FRESH_REF_RE.test(token)) return false
  return token.includes('/') || EXTENSION_RE.test(token)
}

/**
 * Extract the deterministic list of repository path references from `text`.
 * @param {unknown} text narrative text (non-strings yield an empty list).
 * @returns {Array<{ref: string, kind: 'workspace'|'dshHome', relativePath: string}>}
 */
export function extractPathRefs(text) {
  if (typeof text !== 'string' || text === '') return []
  const found = new Map()
  START_RE.lastIndex = 0
  let match
  while ((match = START_RE.exec(text)) !== null) {
    const start = match.index
    let end = start + match[0].length
    while (end < text.length && !STOP_CHARS.has(text[end])) end += 1
    const rawCandidate = text.slice(start, end)
    const candidate = rawCandidate.replace(TRAILING_PUNCTUATION_RE, '')
    if (candidate === '' || candidate === '/') continue
    // Ignore paths that visibly continued after a space (embedded-space path).
    // A candidate ending in punctuation (`,`/`.`/`）`…) is delimiter-terminated,
    // so the next word is not part of it and a fresh reference is kept.
    if (rawCandidate === candidate && looksLikeSpacePathContinuation(text, end)) continue

    let kind = 'workspace'
    let relativePath
    const tokenMatch = /^(\$WORKSPACE|\$DSH_HOME)(?:\/(.*))?$/.exec(candidate)
    if (tokenMatch !== null) {
      kind = tokenMatch[1] === '$WORKSPACE' ? 'workspace' : 'dshHome'
      relativePath = tokenMatch[2] === undefined ? '' : tokenMatch[2]
    } else {
      relativePath = candidate
    }
    if (relativePath !== '') {
      try {
        relativePath = validateRelativePath(relativePath, 'path reference')
      } catch {
        continue // absolute / traversal references are ignored, never followed
      }
    }
    const key = `${kind}\u0000${relativePath}`
    if (found.has(key)) continue
    found.set(key, {
      ref: candidate,
      kind,
      relativePath
    })
  }
  return [...found.values()].sort((left, right) => compareStrings(left.ref, right.ref))
}

/**
 * Check every referenced path against the current workspace.
 *
 * `workspaceRoot` is required for the check to be meaningful; without it (for
 * example a CLI verify that was not given `--workspace`) the result is
 * `supported:false` and no findings are produced. Existence is checked for
 * workspace-relative references (and `$WORKSPACE/…` tokens); `$DSH_HOME/…`
 * references are extracted but not checked by default because a package may be
 * verified on another machine — pass `includeDshHome:true` with a known
 * `dshHome` to include them. An unreadable path counts as missing.
 *
 * @param {{
 *   text: unknown,
 *   workspaceRoot?: string,
 *   dshHome?: string,
 *   includeDshHome?: boolean,
 *   io: {lstat: (absolutePath: string) => Promise<{type: string}|undefined>}
 * }} input
 * @returns {Promise<{supported: boolean, refs: Array<object>, missing: Array<object>}>}
 */
export async function findMissingPathRefs({
  text,
  workspaceRoot,
  dshHome,
  includeDshHome = false,
  io
} = {}) {
  const refs = extractPathRefs(text).slice(0, MAX_PATH_REFS)
  if (typeof workspaceRoot !== 'string' || workspaceRoot === '') {
    return { supported: false, refs, missing: [] }
  }
  if (io === null || typeof io !== 'object' || typeof io.lstat !== 'function') {
    return { supported: false, refs, missing: [] }
  }
  const missing = []
  for (const ref of refs) {
    let root = workspaceRoot
    if (ref.kind === 'dshHome') {
      if (includeDshHome !== true) continue
      if (typeof dshHome !== 'string' || dshHome === '') continue
      root = dshHome
    }
    const absolute = ref.relativePath === '' ? root : join(root, ...ref.relativePath.split('/'))
    let info
    try {
      info = await io.lstat(absolute)
    } catch {
      info = undefined
    }
    if (info === undefined || info === null) missing.push({ ref: ref.ref, kind: ref.kind, relativePath: ref.relativePath })
  }
  return { supported: true, refs, missing }
}

/**
 * Convert missing references into generation warnings / verification findings.
 * @param {Array<{ref: string}>} missing
 * @returns {Array<{code: string, detail: string}>} stable `HANDOFF_PATH_MISSING` warnings.
 */
export function missingPathRefWarnings(missing) {
  return (Array.isArray(missing) ? missing : []).map((entry) => ({
    code: 'HANDOFF_PATH_MISSING',
    detail: `HANDOFF references a path that no longer exists: ${String(entry?.ref ?? '')}`
  }))
}
