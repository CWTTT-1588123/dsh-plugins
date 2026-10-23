/**
 * Batch deletion helpers (P3/M5b): soft delete into the handoff recycle bin,
 * lineage reference scanning, and the physical move/remove adapter.
 *
 * Semantics (decision in P3_plan §M5b / GAPS §4):
 *   - **soft delete is the default**: the batch directory is moved to
 *     `<handoffRoot>/.trash/<projectKey>/<batchId>-<YYYYMMDDTHHmmssZ>`, so the
 *     batch disappears from list/verify/load but stays recoverable on disk;
 *   - **hard delete is CLI-only** (`handoff-kit delete --hard`): the directory
 *     is removed permanently;
 *   - **lineage protection**: a batch referenced by another batch's
 *     `lineage.previous` / `lineage.supersedes` is refused unless `force` is
 *     set, in which case the caller records a strong warning;
 *   - deletion is an explicit write: `list`/`verify`/`load` never call it.
 *
 * The Host `fs` service exposes no rename/remove primitive today, so the move
 * adapter prefers an optional `fs.rename`/`fs.remove` capability (used by the
 * in-memory test double and any future provider) and otherwise falls back to
 * `node:fs` on the local Host filesystem. All paths are already resolved and
 * contained under the handoff root by the service; this module never accepts a
 * caller-provided absolute path except through {@link parseBatchLocation}.
 *
 * @module dsh-handoff-kit/delete
 */

import { mkdirSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

import { BATCH_ID_RE, ERROR, handoffError, isPlainObject } from './contracts.js'
import { parseManifest } from './manifest.js'
import {
  compareBatchIds,
  formatBatchTimestamp,
  isBatchId,
  projectKeySlug
} from './paths.js'

/** Recycle-bin directory under the handoff root. */
export const TRASH_DIR = '.trash'
/** Project-key shape accepted for explicit historical lookups. */
export const PROJECT_KEY_RE = /^[a-z0-9][a-z0-9._-]*$/
/** Bound on manifests scanned for lineage references. */
export const MAX_REFERENCE_SCAN = 500
/** Warning code emitted when `force` deletes a referenced batch. */
export const REFERENCED_FORCE_WARNING = 'BATCH_REFERENCED_FORCE'
/** Warning code explaining an irreversible hard delete. */
export const HARD_DELETE_WARNING = 'BATCH_HARD_DELETED'

/**
 * Split an on-disk batch directory into root/project-key/batch components.
 * @param {string} batchDir absolute or relative batch directory path.
 * @returns {{dir: string, projectDir: string, root: string, projectKey: string, batchId: string}}
 * @throws {Error & {code: string}} `HANDOFF_INVALID_ARGS` when the shape is not
 *   `<handoffRoot>/<projectKey>/<batchId>`.
 */
export function parseBatchLocation(batchDir) {
  if (typeof batchDir !== 'string' || batchDir.trim() === '')
    throw handoffError(ERROR.INVALID_ARGS, 'delete requires a batch directory path')
  const dir = resolve(batchDir)
  const batchId = basename(dir)
  if (!BATCH_ID_RE.test(batchId))
    throw handoffError(
      ERROR.INVALID_ARGS,
      `not a handoff batch directory (expected <handoffRoot>/<projectKey>/<batchId>): ${dir}`
    )
  const projectDir = dirname(dir)
  const projectKey = basename(projectDir)
  if (!PROJECT_KEY_RE.test(projectKey) || projectKey === TRASH_DIR)
    throw handoffError(ERROR.INVALID_ARGS, `not a project-key directory: ${projectDir}`)
  return { dir, projectDir, root: dirname(projectDir), projectKey, batchId }
}

/**
 * Recycle-bin entry name for one deletion.
 * @param {{batchId: string, timestamp: string, attempt?: number}} input
 *   `timestamp` is `YYYYMMDDTHHmmssZ`; `attempt` disambiguates same-second names.
 * @returns {string}
 */
export function trashEntryName({ batchId, timestamp, attempt = 0 }) {
  if (typeof batchId !== 'string' || !BATCH_ID_RE.test(batchId))
    throw handoffError(ERROR.INVALID_ARGS, 'trashEntryName needs a valid batch id')
  if (typeof timestamp !== 'string' || !/^[0-9]{8}T[0-9]{6}Z$/.test(timestamp))
    throw handoffError(ERROR.INVALID_ARGS, 'trashEntryName needs a YYYYMMDDTHHmmssZ timestamp')
  if (!Number.isInteger(attempt) || attempt < 0)
    throw handoffError(ERROR.INTERNAL, 'trashEntryName attempt must be a non-negative integer')
  return attempt === 0 ? `${batchId}-${timestamp}` : `${batchId}-${timestamp}-${attempt + 1}`
}

/**
 * Find the first free recycle-bin directory for a deletion.
 * @param {{
 *   root: string, projectKey: string, batchId: string, timestamp: string,
 *   io: {lstat: (absolutePath: string) => Promise<unknown>}
 * }} input
 * @returns {Promise<{trashDir: string, attempt: number}>}
 */
export async function uniqueTrashDir({ root, projectKey, batchId, timestamp, io }) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = join(
      root,
      TRASH_DIR,
      projectKey,
      trashEntryName({ batchId, timestamp, attempt })
    )
    let info
    try {
      info = await io.lstat(candidate)
    } catch {
      info = undefined
    }
    if (info === undefined || info === null) return { trashDir: candidate, attempt }
  }
  throw handoffError(ERROR.WRITE_FAILED, `cannot allocate a unique recycle-bin directory for ${batchId}`)
}

/**
 * Scan every batch under the same workspace-slug project keys for lineage
 * references to `batchId`. Read-only and bounded; unreadable siblings are
 * ignored (they cannot make the deletion unsafe-by-omission: the target's own
 * manifest chain is the source of truth for what references what).
 * @param {{
 *   io: {listDir: Function, readText: Function},
 *   root: string,
 *   projectKey: string,
 *   batchId: string
 * }} input
 * @returns {Promise<Array<{projectKey: string, batchId: string, field: string}>>}
 */
export async function findLineageReferrers({ io, root, projectKey, batchId } = {}) {
  if (io === null || typeof io !== 'object' || typeof io.listDir !== 'function')
    throw handoffError(ERROR.INTERNAL, 'findLineageReferrers needs a filesystem io adapter')
  let rootEntries
  try {
    rootEntries = await io.listDir(root)
  } catch {
    return []
  }
  const slug = projectKeySlug(projectKey)
  const keys = (Array.isArray(rootEntries) ? rootEntries : [])
    .filter(
      (entry) =>
        entry !== null &&
        typeof entry === 'object' &&
        entry.type === 'directory' &&
        typeof entry.name === 'string' &&
        entry.name !== TRASH_DIR &&
        PROJECT_KEY_RE.test(entry.name) &&
        projectKeySlug(entry.name) === slug
    )
    .map((entry) => entry.name)
    .sort()
  const referrers = []
  let scanned = 0
  for (const key of keys) {
    const projectDir = join(root, key)
    let entries
    try {
      entries = await io.listDir(projectDir)
    } catch {
      continue
    }
    const ids = (Array.isArray(entries) ? entries : [])
      .filter(
        (entry) =>
          entry !== null &&
          typeof entry === 'object' &&
          typeof entry.name === 'string' &&
          entry.name !== batchId &&
          isBatchId(entry.name)
      )
      .map((entry) => entry.name)
      .sort((left, right) => compareBatchIds(right, left))
    for (const id of ids) {
      if (scanned >= MAX_REFERENCE_SCAN) return referrers
      scanned += 1
      let manifest
      try {
        manifest = parseManifest(await io.readText(join(projectDir, id, 'manifest.json')))
      } catch {
        continue
      }
      const lineage = isPlainObject(manifest.lineage) ? manifest.lineage : null
      if (lineage === null) continue
      for (const field of ['previous', 'supersedes']) {
        if (lineage[field] === batchId) referrers.push({ projectKey: key, batchId: id, field: `lineage.${field}` })
      }
    }
  }
  return referrers.sort((left, right) => {
    if (left.projectKey !== right.projectKey) return left.projectKey < right.projectKey ? -1 : 1
    if (left.batchId !== right.batchId) return compareBatchIds(left.batchId, right.batchId)
    return left.field < right.field ? -1 : left.field > right.field ? 1 : 0
  })
}

/** "a, b (lineage.previous)" summary used in errors and warnings. */
export function describeReferrers(referrers) {
  return (Array.isArray(referrers) ? referrers : [])
    .map((entry) => `${entry.projectKey}/${entry.batchId} (${entry.field})`)
    .join(', ')
}

/**
 * Build the historical-key locate contract shared by the UI and the service.
 * @param {unknown} value candidate project key from a caller.
 * @returns {string|undefined} normalized key, or undefined when omitted.
 * @throws {Error & {code: string}} `HANDOFF_INVALID_ARGS` for a malformed key.
 */
export function normalizeProjectKey(value) {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value === '' || value.length > 100)
    throw handoffError(ERROR.INVALID_ARGS, 'projectKey must be a non-empty string of at most 100 characters')
  if (!PROJECT_KEY_RE.test(value) || value === TRASH_DIR)
    throw handoffError(ERROR.INVALID_ARGS, 'projectKey contains unsupported characters')
  return value
}

/**
 * Physical deletion adapter.
 *
 * Prefers optional `fs.rename`/`fs.remove` capabilities (in-memory test double,
 * future providers); otherwise uses `node:fs` on the local Host filesystem.
 * @param {{fs?: any}} input
 * @returns {{move: Function, remove: Function, native: boolean}}
 */
export function createDeleteBackend({ fs } = {}) {
  const nativeMove = typeof fs?.rename === 'function'
  const nativeRemove = typeof fs?.remove === 'function'
  const move = async (fromAbsolute, toAbsolute) => {
    if (nativeMove) {
      try {
        return await fs.rename(fromAbsolute, toAbsolute)
      } catch (error) {
        throw mapDeleteError(error, `cannot move ${fromAbsolute} to ${toAbsolute}`)
      }
    }
    try {
      mkdirSync(dirname(toAbsolute), { recursive: true })
      renameSync(fromAbsolute, toAbsolute)
      return undefined
    } catch (error) {
      throw mapDeleteError(error, `cannot move ${fromAbsolute} to ${toAbsolute}`)
    }
  }
  const remove = async (absolutePath) => {
    if (nativeRemove) {
      try {
        return await fs.remove(absolutePath)
      } catch (error) {
        throw mapDeleteError(error, `cannot remove ${absolutePath}`)
      }
    }
    try {
      rmSync(absolutePath, { recursive: true, force: false })
      return undefined
    } catch (error) {
      throw mapDeleteError(error, `cannot remove ${absolutePath}`)
    }
  }
  return { move, remove, native: nativeMove && nativeRemove }
}

/** Map a filesystem failure during deletion onto the plugin's error codes. */
function mapDeleteError(error, detail) {
  const code = error !== null && typeof error === 'object' ? error.code : undefined
  if (code === 'ENOENT' || code === 'FS_NOT_FOUND')
    return handoffError(ERROR.BATCH_NOT_FOUND, `${detail}: the batch directory no longer exists`)
  return handoffError(ERROR.WRITE_FAILED, `${detail}: ${error?.message ?? String(error)}`)
}

/** Current UTC recycle-bin timestamp (`YYYYMMDDTHHmmssZ`). */
export function trashTimestamp(date = new Date()) {
  return formatBatchTimestamp(date)
}
