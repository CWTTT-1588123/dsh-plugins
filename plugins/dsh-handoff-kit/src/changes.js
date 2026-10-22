/**
 * P1/M2 `workspaceChanges` evidence: turn selection and normalization.
 *
 * The host records one `workspace/changes` Session event per completed top-level
 * turn that changed files, and serves the summary/diff through the
 * `workspaceChanges` service while the Session is alive (`cordis_inspect`
 * Service contract + `dsh-workspace-changes` source, verified 2026-10-22).
 * This module is pure: the service adapter and all data are injected.
 *
 * Documented limitation (also rendered into HANDOFF H6): the current, still-open
 * turn has no `workspace/changes` event yet, so a mid-turn create only sees
 * completed turns; and summaries are unreadable once the Session is disposed.
 *
 * @module dsh-handoff-kit/changes
 */

import { LIMITS } from './contracts.js'
import { isAbsoluteAny, tokenizePath } from './paths.js'

/** Session event type that announces one turn's change summary. */
export const CHANGES_EVENT_TYPE = 'workspace/changes'

/**
 * Find the latest completed-turn `workspace/changes` event in an ordered event
 * list (the caller passes `session.ownEvents()`).
 * @param {readonly object[]} events
 * @returns {{seq: number, turn: number|undefined}|undefined}
 */
export function findLatestChangesEvent(events) {
  if (!Array.isArray(events)) return undefined
  let latest
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    if (event.type !== CHANGES_EVENT_TYPE) continue
    if (!Number.isInteger(event.seq)) continue
    latest = {
      seq: event.seq,
      turn: Number.isInteger(event.data?.turn) ? event.data.turn : undefined
    }
  }
  return latest
}

/** An `available:false` changes block carrying an honest reason. */
export function unavailableChanges(reason, collectedAt) {
  const block = { available: false, source: 'workspace-changes' }
  if (typeof collectedAt === 'string') block.collectedAt = collectedAt
  block.note = typeof reason === 'string' && reason !== '' ? reason : 'workspaceChanges evidence is unavailable'
  return block
}

function integerOr(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback
}

/** Normalize one changed-file path to a tokenized or workspace-relative POSIX path. */
export function normalizeChangePath(path, contexts = {}) {
  if (typeof path !== 'string' || path === '') return undefined
  const posix = path.replace(/\\/g, '/').replace(/^\.\//, '')
  if (isAbsoluteAny(posix)) {
    try {
      return tokenizePath(posix, contexts)
    } catch {
      return undefined
    }
  }
  return posix
}

/**
 * Build the canonical `manifest.changes` block from a host summary.
 * @param {{summary: object|null|undefined, contexts?: {workspaceRoot?: string, dshHome?: string}, limits?: typeof LIMITS, collectedAt?: string}} input
 * @returns {Record<string, unknown>}
 */
export function buildChanges({ summary, contexts = {}, limits = LIMITS, collectedAt } = {}) {
  if (summary === null || typeof summary !== 'object') {
    return unavailableChanges('workspaceChanges summary is unavailable', collectedAt)
  }
  const rawFiles = Array.isArray(summary.files) ? summary.files : []
  const files = []
  for (const entry of rawFiles) {
    if (entry === null || typeof entry !== 'object' || typeof entry.path !== 'string') continue
    const path = normalizeChangePath(entry.path, contexts)
    if (path === undefined) continue
    const file = {
      path,
      added: integerOr(entry.added, 0),
      deleted: integerOr(entry.deleted, 0)
    }
    if (entry.binary === true) file.binary = true
    if (entry.oversized === true) file.oversized = true
    files.push(file)
  }
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  const listed = files.slice(0, limits.changesMaxFiles)
  const truncated = files.length > limits.changesMaxFiles
  const total = integerOr(summary.total, files.length)
  const added = integerOr(summary.added, listed.reduce((sum, file) => sum + file.added, 0))
  const deleted = integerOr(summary.deleted, listed.reduce((sum, file) => sum + file.deleted, 0))
  const block = {
    available: true,
    source: 'workspace-changes',
    ...(Number.isInteger(summary.turn) ? { turn: summary.turn } : {}),
    totals: {
      files: total,
      added,
      deleted,
      binary: listed.filter((file) => file.binary === true).length,
      oversized: listed.filter((file) => file.oversized === true).length
    },
    files: listed
  }
  if (typeof collectedAt === 'string') block.collectedAt = collectedAt
  if (truncated) {
    block.truncated = true
    block.note = `only the first ${limits.changesMaxFiles} of ${files.length} changed files are listed`
  }
  return block
}

/** Select files eligible for diff capture (text-ish, bounded). */
export function selectDiffTargets(files, limits = LIMITS) {
  if (!Array.isArray(files)) return []
  return files
    .filter((file) => file !== null && typeof file === 'object' && typeof file.path === 'string')
    .filter((file) => file.binary !== true && file.oversized !== true)
    .slice(0, limits.changesMaxDiffs)
}

/** Normalize one host `WorkspaceFileDiff` into a manifest diff entry. */
export function buildDiffEntry({ path, diff, hunksMax = 50, linesMax = 200 } = {}) {
  if (typeof path !== 'string' || path === '') return undefined
  if (diff === null || typeof diff !== 'object') return undefined
  if (diff.kind === 'binary') return { path, kind: 'binary' }
  if (diff.kind === 'oversized') return { path, kind: 'oversized' }
  if (diff.kind !== 'text') return undefined
  const hunks = (Array.isArray(diff.hunks) ? diff.hunks : [])
    .slice(0, hunksMax)
    .map((hunk) => ({
      oldStart: integerOr(hunk?.oldStart, 0),
      oldLines: integerOr(hunk?.oldLines, 0),
      newStart: integerOr(hunk?.newStart, 0),
      newLines: integerOr(hunk?.newLines, 0),
      lines: (Array.isArray(hunk?.lines) ? hunk.lines : []).slice(0, linesMax).map((line) => String(line))
    }))
  const entry = { path, kind: 'text', hunks }
  if (diff.coarse === true) entry.truncated = true
  return entry
}

/**
 * Bound the total serialized size of diff entries; the first entry that would
 * exceed the budget is included with `truncated:true`, the rest are dropped.
 * @param {Array<Record<string, unknown>>} entries
 * @param {number} maxBytes
 * @returns {Array<Record<string, unknown>>}
 */
export function boundDiffEntries(entries, maxBytes) {
  const out = []
  let used = 0
  for (const entry of entries) {
    if (entry === undefined) continue
    let size = 0
    try {
      size = Buffer.byteLength(JSON.stringify(entry), 'utf8')
    } catch {
      size = 0
    }
    if (used + size > maxBytes) {
      const truncated = { ...entry, truncated: true }
      if (out.length === 0 || used + size <= maxBytes * 2) out.push(truncated)
      break
    }
    out.push(entry)
    used += size
  }
  return out
}
