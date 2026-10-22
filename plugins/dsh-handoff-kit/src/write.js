/**
 * Batch writing: turn a fully assembled list of batch-relative entries into
 * `ctx.fs.writeText` calls under an injected sandbox policy.
 *
 * The writer never deletes and never cleans up (the filesystem service has no
 * delete primitive). A failure reports the files already written with
 * `partial: true` and leaves them in place, so `verify` can report the
 * incomplete batch instead of the plugin pretending nothing happened.
 *
 * @module dsh-handoff-kit/write
 */

import { join } from 'node:path'
import {
  ERROR,
  FS_SANDBOX_DENIED,
  HANDOFF_FILE,
  MANIFEST_FILE,
  SUMS_FILE,
  handoffError
} from './contracts.js'
import { normalizeArtifactPath, resolveArtifact, sha256Hex } from './paths.js'

/** Artifact write order: narrative, evidence, checksums, manifest last. */
const WRITE_ORDER = new Map([
  [HANDOFF_FILE, 0],
  [SUMS_FILE, 2],
  [MANIFEST_FILE, 3]
])

function orderKey(relativePath) {
  if (WRITE_ORDER.has(relativePath)) return WRITE_ORDER.get(relativePath)
  if (relativePath.startsWith('evidence/')) return 1
  return 1.5
}

/**
 * Order entries deterministically: `HANDOFF.md`, `evidence/**` (sorted),
 * `SHA256SUMS`, then `manifest.json` last. The last file's presence is what
 * makes a batch complete, so it must be written only after everything else.
 * @param {Array<{path: string, content: string}>} entries
 * @returns {Array<{path: string, content: string}>}
 */
export function orderEntries(entries) {
  return [...entries].sort((left, right) => {
    const orderDelta = orderKey(left.path) - orderKey(right.path)
    if (orderDelta !== 0) return orderDelta
    return left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  })
}

/**
 * Check whether a batch directory may be created.
 *
 * - absent directory → writable;
 * - present directory without `manifest.json` → incomplete batch, refused
 *   unless `force`;
 * - present directory with `manifest.json` → refused unless `force`.
 *
 * @param {{
 *   fs: {lstat: Function, resolve: Function},
 *   rootDir: string,
 *   force?: boolean
 * }} input
 * @returns {Promise<{exists: boolean, incomplete: boolean}>}
 * @throws {Error & {code: string}} `HANDOFF_BATCH_EXISTS`.
 */
export async function assertBatchCreatable({ fs, rootDir, force = false }) {
  const info = await fs.lstat(rootDir)
  if (info === undefined) return { exists: false, incomplete: false }
  if (info.type !== 'directory')
    throw handoffError(ERROR.BATCH_EXISTS, `batch path exists and is not a directory: ${rootDir}`)
  const manifestTarget = await fs.resolve(join(rootDir, MANIFEST_FILE))
  const manifestInfo = await fs.stat(manifestTarget)
  if (manifestInfo !== undefined && !force)
    throw handoffError(
      ERROR.BATCH_EXISTS,
      `batch already exists (manifest.json present); pass force=true to overwrite: ${rootDir}`
    )
  if (manifestInfo === undefined && !force)
    throw handoffError(
      ERROR.BATCH_EXISTS,
      `incomplete batch directory exists (no manifest.json, likely an interrupted write); pass force=true to overwrite: ${rootDir}`
    )
  return { exists: true, incomplete: manifestInfo === undefined }
}

/**
 * Map a filesystem write failure onto the plugin's structured error codes.
 * @param {unknown} error
 * @param {string} relativePath
 * @returns {never}
 */
function mapWriteFailure(error, relativePath) {
  const code = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : ''
  if (code === FS_SANDBOX_DENIED) {
    const mapped = handoffError(
      ERROR.SANDBOX_DENIED,
      `filesystem sandbox denied writing ${relativePath}; switch to danger-full-access or use target=workspace`
    )
    throw mapped
  }
  throw handoffError(ERROR.WRITE_FAILED, `failed to write ${relativePath}: ${error?.message ?? String(error)}`)
}

/**
 * Write every entry under `rootDir`, mapping sandbox refusals and reporting
 * partial progress on failure.
 * @param {{
 *   fs: {resolve: Function, contains: Function, writeText: Function, lstat: Function, stat: Function},
 *   policy: {mode: string, workspaceRoot: string, sessionId?: string},
 *   rootDir: string,
 *   entries: Array<{path: string, content: string}>,
 *   signal?: AbortSignal,
 *   force?: boolean
 * }} input
 * @returns {Promise<{written: Array<{path: string, bytes: number, sha256: string}>, partial: false}>}
 */
export async function writeBatch({ fs, policy, rootDir, entries, signal, force = false }) {
  const ordered = orderEntries(entries)
  const rootTarget = await fs.resolve(rootDir)
  const written = []
  for (const entry of ordered) {
    signal?.throwIfAborted?.()
    const relativePath = normalizeArtifactPath(entry.path, 'batch entry path')
    const absolute = resolveArtifact(rootDir, relativePath)
    let target
    try {
      target = await fs.resolve(absolute)
    } catch (error) {
      throw handoffError(ERROR.WRITE_FAILED, `cannot resolve ${relativePath}: ${error?.message ?? String(error)}`)
    }
    if (!fs.contains(rootTarget, target))
      throw handoffError(ERROR.PATH_ESCAPE, `batch entry ${relativePath} resolves outside ${rootDir}`)
    try {
      await fs.writeText(target, entry.content, force ? undefined : { kind: 'createIfAbsent' }, signal, policy)
    } catch (error) {
      const failure = handoffError(
        ERROR.WRITE_FAILED,
        `failed while writing ${relativePath}: ${error?.message ?? String(error)}`
      )
      failure.partial = true
      failure.written = [...written]
      if (error?.code === FS_SANDBOX_DENIED) {
        failure.code = ERROR.SANDBOX_DENIED
        failure.message = `${ERROR.SANDBOX_DENIED}: filesystem sandbox denied writing ${relativePath}; switch to danger-full-access or use target=workspace`
        failure.detail = `filesystem sandbox denied writing ${relativePath}`
      }
      throw failure
    }
    written.push({
      path: relativePath,
      bytes: Buffer.byteLength(entry.content, 'utf8'),
      sha256: sha256Hex(entry.content)
    })
  }
  return { written, partial: false }
}

/** Re-export the low-level failure mapping for service tests. */
export { mapWriteFailure }
