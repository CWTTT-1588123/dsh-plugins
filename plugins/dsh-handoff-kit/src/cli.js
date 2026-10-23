/**
 * Reference CLI (P3/M3): zero-dependency handoff package verifier/consumer.
 *
 * This entry point runs OUTSIDE DeepSeek Harness (npm/npx/plain Node), so it
 * uses `node:fs` directly and never imports `@deepseek-ai/*`. It shares the
 * pure modules with the plugin: manifest parsing/serialization, rendering,
 * redaction and path helpers are the same code the plugin uses.
 *
 * Constraints (frozen for 1.0):
 *   - no network, no subprocess, no LLM call;
 *   - `verify`/`load`/`list` are read-only and deterministic;
 *   - `migrate` writes only to an explicit `--out` directory (source is
 *     read-only);
 *   - exit codes: 0 verified/ok, 3 stale, 1 invalid, 2 usage/IO error.
 *
 * Spec: plugins/dsh-handoff-kit/spec/verify.md §4.
 *
 * @module dsh-handoff-kit/cli
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import {
  BATCH_ID_RE,
  ERROR,
  EVIDENCE_DIR,
  HANDOFF_FILE,
  HANDOFF_SUBDIR,
  MANIFEST_FILE,
  PLUGIN_VERSION,
  SCHEMA_VERSION,
  SCHEMA_VERSION_V2,
  SUMS_FILE,
  errorCodeOf,
  errorMessageOf,
  generatorIdentity,
  handoffError,
  isPlainObject,
  publicLimits
} from './contracts.js'
import { readGitInfo } from './git.js'
import {
  artifactEntry,
  buildSha256Sums,
  createManifest,
  parseManifest,
  parseSha256Sums,
  serializeManifest,
  setArtifacts,
  validateManifest
} from './manifest.js'
import { normalizeArtifactPath, resolveInside, sha256Hex } from './paths.js'
import { redactText, scanSecrets } from './redact.js'
import { renderHandoff } from './render.js'
import {
  SIGNATURE_FILE,
  TRUSTED_KEYS_FILE,
  createSignatureEnvelope,
  evaluateSignature,
  parseTrustedKeys,
  publicKeyEntry
} from './signature.js'
import { findMissingPathRefs } from './path-refs.js'
import {
  HARD_DELETE_WARNING,
  REFERENCED_FORCE_WARNING,
  describeReferrers,
  findLineageReferrers,
  parseBatchLocation,
  trashEntryName,
  trashTimestamp
} from './delete.js'

/** Exit codes shared with `spec/verify.md`. */
export const EXIT = Object.freeze({ VERIFIED: 0, INVALID: 1, USAGE: 2, STALE: 3 })

/** Per-artifact read cap for verification. */
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024
/** Text artifacts are secret-scanned only below this size. */
const SECRET_SCAN_MAX_BYTES = 1024 * 1024
/** `load --full` inline cap. */
const FULL_MAX_CHARS = 24 * 1024
/** Per-section cap for `load --sections`. */
const SECTION_MAX_CHARS = 1500

const CLI_USAGE = `handoff-kit ${PLUGIN_VERSION} — deterministic handoff package CLI (zero dependencies)

Usage:
  handoff-kit verify <batchDir> [--workspace <dir>] [--pubkey <publicKey.pem>] [--json]
  handoff-kit load   <batchDir> [--workspace <dir>] [--pubkey <publicKey.pem>] [--sections|--full] [--json]
  handoff-kit list   --root <handoffRoot> [--json]
  handoff-kit migrate <batchDir> --out <newBatchDir> [--json]
  handoff-kit sign   <batchDir> --key <privateKey.pem> [--force] [--json]
  handoff-kit delete <batchDir> [--hard] [--force] [--json]
  handoff-kit --help | --version

Signature verification is opt-in: without --pubkey the read-only trusted-key list
$DSH_HOME/handoff/trusted-keys.json is used; otherwise a valid signature is "untrusted".

Delete moves the batch to <handoffRoot>/.trash/ by default (recoverable); --hard
removes it permanently. A lineage-referenced batch is refused unless --force.

Exit codes: 0 verified/ok, 3 stale, 1 invalid, 2 usage/IO error.`

/* ────────────────────────────── small helpers ────────────────────────────── */

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

/** Node-fs adapter for the pure git reader (`io.lstat/readText/readBytes`). */
function createNodeIo() {
  return {
    async lstat(absolutePath) {
      try {
        const stat = lstatSync(absolutePath)
        const type = stat.isSymbolicLink()
          ? 'symlink'
          : stat.isDirectory()
            ? 'directory'
            : stat.isFile()
              ? 'file'
              : 'other'
        return { type, size: stat.size }
      } catch {
        return undefined
      }
    },
    async readText(absolutePath) {
      return readFileSync(absolutePath, 'utf8')
    },
    async readBytes(absolutePath, maxBytes) {
      const bytes = readFileSync(absolutePath)
      if (typeof maxBytes === 'number' && bytes.length > maxBytes) {
        const error = new Error(`file exceeds ${maxBytes} bytes`)
        error.code = 'FS_TOO_LARGE'
        throw error
      }
      return bytes
    },
    async listDir(absolutePath) {
      return readdirSync(absolutePath, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other'
      }))
    },
    async resolve(absolutePath) {
      return { targetKey: resolve(absolutePath), displayPath: resolve(absolutePath) }
    }
  }
}

function sortFindings(findings) {
  const rank = (finding) => (finding.severity === 'error' ? 0 : 1)
  return [...findings].sort((left, right) => {
    const delta = rank(left) - rank(right)
    if (delta !== 0) return delta
    if (left.code !== right.code) return left.code < right.code ? -1 : 1
    const leftPath = left.path ?? ''
    const rightPath = right.path ?? ''
    return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0
  })
}

function isTextArtifact(relativePath) {
  return (
    relativePath === SUMS_FILE ||
    relativePath.endsWith('.json') ||
    relativePath.endsWith('.md') ||
    relativePath.endsWith('.txt')
  )
}

function readManifestIfPossible(batchDir) {
  try {
    return { manifest: parseManifest(readFileSync(join(batchDir, MANIFEST_FILE), 'utf8')) }
  } catch (error) {
    return {
      manifest: null,
      error,
      code: errorCodeOf(error) === ERROR.MANIFEST_INVALID ? 'MANIFEST_INVALID' : 'MANIFEST_MISSING'
    }
  }
}

/* ──────────────────────── signature / audit receipt (P3/M5) ──────────────── */

/** Resolve `$DSH_HOME` for the CLI (the CLI reads trusted keys from the same root). */
function resolveDshHomeFromEnv(env = process.env) {
  const configured = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  if (configured !== '') return resolve(configured)
  return join(homedir(), '.dsh')
}

/** Read a text file, or `undefined` when it does not exist / cannot be read. */
function readTextIfPossible(absolutePath) {
  try {
    return readFileSync(absolutePath, 'utf8')
  } catch {
    return undefined
  }
}

/** Read file bytes, or `undefined` when it does not exist / cannot be read. */
function readBytesIfPossible(absolutePath) {
  try {
    return readFileSync(absolutePath)
  } catch {
    return undefined
  }
}

/**
 * Resolve the CLI trust source for one verify/load call.
 *
 * Priority (decision D7): explicit `--pubkey` file → read-only
 * `$DSH_HOME/handoff/trusted-keys.json` → no trust source (valid signatures
 * stay `untrusted`). An explicitly supplied but unreadable `--pubkey` is a
 * usage error (exit 2), never a silent downgrade.
 */
function resolveCliTrustedKeys({ publicKeyPath }) {
  if (publicKeyPath !== undefined) {
    const text = readTextIfPossible(resolve(publicKeyPath))
    if (text === undefined)
      throw handoffError(ERROR.INVALID_ARGS, `--pubkey file cannot be read: ${resolve(publicKeyPath)}`)
    return { keys: [publicKeyEntry(text)] }
  }
  const storePath = join(resolveDshHomeFromEnv(), HANDOFF_SUBDIR, TRUSTED_KEYS_FILE)
  const storeText = readTextIfPossible(storePath)
  if (storeText === undefined) return { keys: [] }
  try {
    return { keys: parseTrustedKeys(storeText) }
  } catch (error) {
    return { keys: [], detail: errorMessageOf(error) }
  }
}

/** Evaluate `signature.json` of one batch against the CLI trust source. */
function verifyBatchSignature({ batchDir, publicKeyPath }) {
  const signatureText = readTextIfPossible(join(batchDir, SIGNATURE_FILE))
  const trusted = resolveCliTrustedKeys({ publicKeyPath })
  return evaluateSignature({
    signatureText,
    sumsBytes: readBytesIfPossible(join(batchDir, SUMS_FILE)),
    trustedKeys: trusted.keys,
    ...(typeof trusted.detail === 'string' ? { trustedKeysError: trusted.detail } : {})
  })
}

/**
 * Build the read-only audit receipt (D8): checker identity/version, check
 * instant and sha256 hashes of the three input files (`null` when missing).
 */
function buildReceiptFor({ batchDir, checkedAt }) {
  const inputs = { manifestSha256: null, sumsSha256: null, handoffSha256: null }
  for (const [file, key] of [
    [MANIFEST_FILE, 'manifestSha256'],
    [SUMS_FILE, 'sumsSha256'],
    [HANDOFF_FILE, 'handoffSha256']
  ]) {
    const bytes = readBytesIfPossible(join(batchDir, file))
    if (bytes !== undefined) inputs[key] = sha256Hex(bytes)
  }
  return {
    checker: { name: 'dsh-handoff-kit', version: PLUGIN_VERSION },
    checkedAt,
    inputs
  }
}

/* ─────────────────────────────── verification ────────────────────────────── */

function checkArtifacts({ manifest, batchDir, findings }) {
  const artifactDigests = new Map()
  for (const artifact of Array.isArray(manifest.artifacts) ? manifest.artifacts : []) {
    if (!isPlainObject(artifact)) continue
    let relative
    try {
      relative = normalizeArtifactPath(String(artifact.path ?? ''), 'artifact path')
    } catch (error) {
      findings.push({ severity: 'error', code: 'PATH_ESCAPE', path: String(artifact.path ?? ''), detail: errorMessageOf(error) })
      continue
    }
    let absolute
    try {
      absolute = resolveInside(batchDir, relative)
    } catch (error) {
      findings.push({ severity: 'error', code: 'PATH_ESCAPE', path: relative, detail: errorMessageOf(error) })
      continue
    }
    let stat
    try {
      stat = lstatSync(absolute)
    } catch {
      stat = undefined
    }
    if (stat === undefined) {
      findings.push({ severity: 'error', code: 'ARTIFACT_MISSING', path: relative })
      continue
    }
    if (stat.isSymbolicLink()) {
      findings.push({ severity: 'error', code: 'SYMLINK_ESCAPE', path: relative, detail: 'artifact is a symlink' })
      continue
    }
    if (!stat.isFile()) {
      findings.push({ severity: 'error', code: 'ARTIFACT_MISSING', path: relative, detail: 'artifact is not a regular file' })
      continue
    }
    if (stat.size > MAX_ARTIFACT_BYTES) {
      findings.push({ severity: 'error', code: 'ARTIFACT_MISSING', path: relative, detail: `artifact exceeds ${MAX_ARTIFACT_BYTES} bytes` })
      continue
    }
    const bytes = readFileSync(absolute)
    const digest = sha256Hex(bytes)
    artifactDigests.set(relative, digest)
    if (typeof artifact.sha256 === 'string' && artifact.sha256 !== digest) {
      findings.push({
        severity: 'error',
        code: 'ARTIFACT_HASH_MISMATCH',
        path: relative,
        detail: `manifest ${String(artifact.sha256).slice(0, 12)}…, actual ${digest.slice(0, 12)}…`
      })
    }
    if (Number.isFinite(artifact.bytes) && artifact.bytes !== bytes.length) {
      findings.push({
        severity: 'warn',
        code: 'ARTIFACT_SIZE_MISMATCH',
        path: relative,
        detail: `manifest ${artifact.bytes} bytes, actual ${bytes.length} bytes`
      })
    }
    if (isTextArtifact(relative) && bytes.length <= SECRET_SCAN_MAX_BYTES) {
      for (const hit of scanSecrets(bytes.toString('utf8'))) {
        findings.push({ severity: 'error', code: 'SECRET_RESIDUE', path: relative, detail: `${hit.kind} x${hit.count}` })
      }
    }
  }
  return artifactDigests
}

function reconcileSums({ manifest, batchDir, artifactDigests, findings }) {
  let sums
  try {
    sums = parseSha256Sums(readFileSync(join(batchDir, SUMS_FILE), 'utf8'))
  } catch (error) {
    findings.push({ severity: 'error', code: 'ARTIFACT_MISSING', path: SUMS_FILE, detail: errorMessageOf(error) })
    return
  }
  const listed = new Map(sums.map((entry) => [entry.path, entry.sha256]))
  for (const [relative, digest] of artifactDigests) {
    if (relative === SUMS_FILE) continue
    const claimed = listed.get(relative)
    if (claimed === undefined) {
      findings.push({ severity: 'error', code: 'SHA256SUMS_MISMATCH', path: relative, detail: 'artifact missing from SHA256SUMS' })
    } else if (claimed !== digest) {
      findings.push({
        severity: 'error',
        code: 'SHA256SUMS_MISMATCH',
        path: relative,
        detail: `SHA256SUMS ${claimed.slice(0, 12)}…, actual ${digest.slice(0, 12)}…`
      })
    }
  }
  for (const path of listed.keys()) {
    if (!artifactDigests.has(path)) {
      findings.push({ severity: 'error', code: 'SHA256SUMS_MISMATCH', path, detail: 'SHA256SUMS lists a file missing from manifest.artifacts' })
    }
    if (path === SUMS_FILE) {
      findings.push({ severity: 'error', code: 'SHA256SUMS_MISMATCH', path, detail: 'SHA256SUMS must not hash itself' })
    }
    if (path === MANIFEST_FILE) {
      findings.push({ severity: 'error', code: 'SHA256SUMS_MISMATCH', path, detail: 'manifest.json must not be listed in SHA256SUMS' })
    }
  }
  if (!listed.has(HANDOFF_FILE)) {
    findings.push({ severity: 'error', code: 'SHA256SUMS_MISMATCH', path: HANDOFF_FILE, detail: 'HANDOFF.md missing from SHA256SUMS' })
  }
}

function checkLineage({ manifest, batchDir, findings }) {
  const lineage = isPlainObject(manifest.lineage) ? manifest.lineage : null
  const projectDir = dirname(resolve(batchDir))
  if (lineage !== null && typeof lineage.previous === 'string') {
    const previousDir = join(projectDir, lineage.previous)
    let ok = false
    try {
      ok = lstatSync(previousDir).isDirectory() && existsSync(join(previousDir, MANIFEST_FILE))
    } catch {
      ok = false
    }
    if (!ok) {
      findings.push({ severity: 'error', code: 'LINEAGE_BROKEN', path: 'lineage.previous', detail: `previous batch ${lineage.previous} is missing` })
    }
  }
  const batchId = basename(resolve(batchDir))
  let siblings = []
  try {
    siblings = readdirSync(projectDir).filter((name) => BATCH_ID_RE.test(name))
  } catch {
    siblings = []
  }
  for (const siblingId of siblings.slice(0, 200)) {
    if (siblingId === batchId) continue
    try {
      const sibling = parseManifest(readFileSync(join(projectDir, siblingId, MANIFEST_FILE), 'utf8'))
      if (isPlainObject(sibling.lineage) && sibling.lineage.supersedes === batchId) {
        findings.push({ severity: 'warn', code: 'SUPERSEDED_BATCH', path: MANIFEST_FILE, detail: `this batch was superseded by ${siblingId}` })
        break
      }
    } catch {
      /* unreadable sibling manifests are not this batch's problem */
    }
  }
}

async function finishDrift({ manifest, workspaceRoot, findings, artifactDigests }) {
  const drift = {
    gitHeadChanged: false,
    sourceFilesChanged: 0,
    sourceFilesMissing: 0,
    artifactsChecked: artifactDigests.size
  }
  if (typeof workspaceRoot !== 'string' || workspaceRoot === '') return drift
  const io = createNodeIo()
  const current = await readGitInfo({ io, workspaceRoot })
  const recordedHead = typeof manifest.git?.head === 'string' ? manifest.git.head : null
  const currentHead = typeof current?.git?.head === 'string' ? current.git.head : null
  if (recordedHead !== null && currentHead !== null && recordedHead !== currentHead) {
    drift.gitHeadChanged = true
    findings.push({
      severity: 'warn',
      code: 'GIT_HEAD_CHANGED',
      detail: `manifest HEAD ${recordedHead.slice(0, 12)}…, current HEAD ${currentHead.slice(0, 12)}…`
    })
  }
  for (const file of Array.isArray(manifest.files) ? manifest.files : []) {
    if (!isPlainObject(file) || typeof file.path !== 'string') continue
    if (
      typeof file.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(file.sha256) ||
      typeof file.skippedReason === 'string'
    )
      continue
    let absolute
    try {
      absolute = resolveInside(workspaceRoot, file.path)
    } catch (error) {
      findings.push({ severity: 'error', code: 'PATH_ESCAPE', path: file.path, detail: errorMessageOf(error) })
      continue
    }
    let stat
    try {
      stat = lstatSync(absolute)
    } catch {
      stat = undefined
    }
    if (stat === undefined) {
      drift.sourceFilesMissing += 1
      findings.push({ severity: 'warn', code: 'SOURCE_FILE_MISSING', path: file.path })
      continue
    }
    if (stat.isSymbolicLink()) {
      findings.push({ severity: 'error', code: 'SYMLINK_ESCAPE', path: file.path, detail: 'recorded source file is now a symlink' })
      continue
    }
    try {
      if (sha256Hex(readFileSync(absolute)) !== file.sha256) {
        drift.sourceFilesChanged += 1
        findings.push({ severity: 'warn', code: 'SOURCE_FILE_CHANGED', path: file.path, detail: `recorded sha256 ${file.sha256.slice(0, 12)}…` })
      }
    } catch (error) {
      if (error?.code === 'FS_TOO_LARGE') continue
      findings.push({ severity: 'warn', code: 'SOURCE_FILE_UNREADABLE', path: file.path, detail: errorMessageOf(error) })
    }
  }
  return drift
}

/**
 * A2: warn when the HANDOFF narrative references workspace paths that no
 * longer exist. Skipped (no findings) when `--workspace` was not supplied, so a
 * cross-tool consumer without the workspace never gets false positives.
 */
async function checkHandoffPathRefsForCli({ batchDir, workspaceRoot, findings }) {
  if (typeof workspaceRoot !== 'string' || workspaceRoot === '') return
  const text = readTextIfPossible(join(batchDir, HANDOFF_FILE))
  if (text === undefined) return
  const checked = await findMissingPathRefs({ text, workspaceRoot, io: createNodeIo() })
  if (!checked.supported) return
  for (const entry of checked.missing) {
    findings.push({
      severity: 'warn',
      code: 'HANDOFF_PATH_MISSING',
      path: entry.ref,
      detail: `HANDOFF references a path that no longer exists: ${entry.ref}`
    })
  }
}

/**
 * Verify one batch directory (read-only).
 * @param {{batchDir: string, workspaceRoot?: string, publicKeyPath?: string}} input
 * @returns {Promise<{trust: string, verification: object, manifest: object|null,
 *   batchId: string, signature: object, receipt: object}>}
 */
export async function verifyBatch({ batchDir, workspaceRoot, publicKeyPath } = {}) {
  const absoluteDir = resolve(batchDir)
  const batchId = basename(absoluteDir)
  const findings = []
  const { manifest, error, code } = readManifestIfPossible(absoluteDir)
  if (manifest === null) {
    findings.push({ severity: 'error', code: code ?? 'MANIFEST_MISSING', path: MANIFEST_FILE, detail: errorMessageOf(error) })
  }
  let artifactDigests = new Map()
  let drift = { gitHeadChanged: false, sourceFilesChanged: 0, sourceFilesMissing: 0, artifactsChecked: 0 }
  if (manifest !== null) {
    for (const finding of validateManifest(manifest).findings ?? []) {
      findings.push({
        severity: finding.severity === 'warn' ? 'warn' : 'error',
        code: finding.code ?? 'MANIFEST_INVALID',
        ...(typeof finding.path === 'string' && finding.path !== '' ? { path: finding.path } : {}),
        ...(typeof finding.detail === 'string' ? { detail: finding.detail } : {})
      })
    }
    artifactDigests = checkArtifacts({ manifest, batchDir: absoluteDir, findings })
    reconcileSums({ manifest, batchDir: absoluteDir, artifactDigests, findings })
    checkLineage({ manifest, batchDir: absoluteDir, findings })
    drift = await finishDrift({ manifest, workspaceRoot, findings, artifactDigests })
  }
  // A2: narrative paths that no longer exist are warnings (trust becomes stale,
  // never invalid). Only possible when the caller supplies the workspace;
  // without it the check is skipped and the finding set is unchanged.
  await checkHandoffPathRefsForCli({ batchDir: absoluteDir, workspaceRoot, findings })
  // P3/M5/D7: only an invalid signature changes trust (error finding); unsigned
  // and untrusted packages are informational and leave findings/counts untouched.
  const signature = verifyBatchSignature({ batchDir: absoluteDir, publicKeyPath })
  if (signature.status === 'invalid') {
    findings.push({
      severity: 'error',
      code: 'SIGNATURE_INVALID',
      path: SIGNATURE_FILE,
      detail: signature.detail ?? 'signature.json does not verify against SHA256SUMS'
    })
  }
  const sorted = sortFindings(findings)
  const counts = {
    errors: sorted.filter((finding) => finding.severity === 'error').length,
    warnings: sorted.filter((finding) => finding.severity === 'warn').length
  }
  const trust =
    counts.errors > 0
      ? 'invalid'
      : counts.warnings > 0 ||
          drift.gitHeadChanged === true ||
          drift.sourceFilesChanged > 0 ||
          drift.sourceFilesMissing > 0
        ? 'stale'
        : 'verified'
  const checkedAt = new Date().toISOString()
  const receipt = buildReceiptFor({ batchDir: absoluteDir, checkedAt })
  const verification = {
    ok: counts.errors === 0,
    batchId,
    dir: absoluteDir,
    checkedAt,
    findings: sorted,
    drift,
    counts
  }
  return { trust, verification, manifest, batchId, signature, receipt }
}

/* ───────────────────────────────── load ──────────────────────────────────── */

function extractSections(text) {
  const sections = []
  let current
  for (const line of String(text).split('\n')) {
    const match = /^## (H[0-9]|覆盖说明)\b/.exec(line.trimEnd())
    if (match !== null) {
      if (current !== undefined) sections.push(current)
      current = { id: match[1], heading: line.trim(), lines: [] }
      continue
    }
    if (current !== undefined) current.lines.push(line)
  }
  if (current !== undefined) sections.push(current)
  let budget = 4000
  const out = []
  for (const section of sections) {
    if (budget <= 0) break
    let body = section.lines.join('\n').trim()
    const cap = Math.min(SECTION_MAX_CHARS, budget)
    let truncated = false
    if (body.length > cap) {
      body = body.slice(0, cap)
      truncated = true
    }
    out.push({ id: section.id, heading: section.heading, text: body, ...(truncated ? { truncated: true } : {}) })
    budget -= body.length
  }
  return out
}

/**
 * Verify and summarize one batch (read-only consumer view).
 */
export async function loadBatch({ batchDir, workspaceRoot, include = 'summary', publicKeyPath } = {}) {
  const verified = await verifyBatch({ batchDir, workspaceRoot, publicKeyPath })
  const dir = resolve(batchDir)
  const handoffPath = join(dir, HANDOFF_FILE)
  let handoff = { path: handoffPath }
  try {
    const text = readFileSync(handoffPath, 'utf8')
    if (include === 'full') {
      handoff.excerpt = text.length > FULL_MAX_CHARS ? text.slice(0, FULL_MAX_CHARS) : text
      if (text.length > FULL_MAX_CHARS) handoff.truncated = true
    } else if (include === 'sections') {
      handoff.sections = extractSections(text)
    }
  } catch {
    /* missing HANDOFF.md is a verification finding, not a load failure */
  }
  const manifest = verified.manifest
  return {
    batchId: verified.batchId,
    dir,
    trust: verified.trust,
    verification: verified.verification,
    signature: verified.signature,
    receipt: verified.receipt,
    handoff,
    manifest: {
      path: join(dir, MANIFEST_FILE),
      ...(manifest !== null
        ? {
            batchId: manifest.batchId,
            createdAt: manifest.createdAt,
            gitHead: typeof manifest.git?.head === 'string' ? manifest.git.head : null,
            title: typeof manifest.inputs?.title === 'string' ? manifest.inputs.title : null
          }
        : {})
    },
    pointers: [
      { label: 'HANDOFF.md', path: handoffPath },
      { label: 'manifest.json', path: join(dir, MANIFEST_FILE) },
      { label: 'SHA256SUMS', path: join(dir, SUMS_FILE) },
      { label: 'session evidence', path: join(dir, EVIDENCE_DIR, 'session.json') }
    ]
  }
}

/* ───────────────────────────────── list ──────────────────────────────────── */

/** List batches under a handoff root: `<root>/<project-key>/<batch-id>/`. */
export function listBatches({ root }) {
  const absoluteRoot = resolve(root)
  const projects = []
  let projectEntries = []
  try {
    projectEntries = readdirSync(absoluteRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    projectEntries = []
  }
  for (const projectKey of projectEntries) {
    const projectDir = join(absoluteRoot, projectKey)
    let batchIds = []
    try {
      batchIds = readdirSync(projectDir)
        .filter((name) => BATCH_ID_RE.test(name))
        .sort()
        .reverse()
    } catch {
      continue
    }
    for (const batchId of batchIds) {
      const batchDir = join(projectDir, batchId)
      const { manifest } = readManifestIfPossible(batchDir)
      const artifacts = Array.isArray(manifest?.artifacts) ? manifest.artifacts : []
      projects.push({
        batchId,
        projectKey,
        dir: batchDir,
        createdAt: typeof manifest?.createdAt === 'string' ? manifest.createdAt : null,
        title: typeof manifest?.inputs?.title === 'string' ? manifest.inputs.title : null,
        complete: manifest !== null,
        artifacts: artifacts.length,
        bytes: artifacts.reduce((sum, artifact) => sum + (Number.isFinite(artifact?.bytes) ? artifact.bytes : 0), 0)
      })
    }
  }
  return { root: absoluteRoot, batches: projects }
}

/* ─────────────────────────────── migrate ─────────────────────────────────── */

function evidenceTextsForManifest(manifest) {
  return [
    { path: `${EVIDENCE_DIR}/git.json`, content: jsonText({ schemaVersion: SCHEMA_VERSION, generator: manifest.generator, git: manifest.git }) },
    { path: `${EVIDENCE_DIR}/files.json`, content: jsonText({ schemaVersion: SCHEMA_VERSION, scan: manifest.scan, files: manifest.files }) },
    { path: `${EVIDENCE_DIR}/session.json`, content: jsonText(manifest.sessionTrace) },
    {
      path: `${EVIDENCE_DIR}/redactions.json`,
      content: jsonText({
        schemaVersion: SCHEMA_VERSION,
        redactions: manifest.redactions,
        // The out-of-harness CLI has no policy context, so migrations record the
        // same explicit "no policy" provenance as an unpolicied plugin batch.
        policy: { sha256: null, source: null }
      })
    }
  ]
}

function guardSecrets(texts) {
  for (const [file, text] of texts) {
    const residue = scanSecrets(String(text ?? ''))
    if (residue.length > 0) {
      throw handoffError(ERROR.SECRET_CHECK_FAILED, `secret residue in ${file}; the batch was not written`)
    }
  }
}

/**
 * Migrate one v1 batch into a NEW v2 batch directory (source is read-only).
 * @param {{batchDir: string, outDir: string, workspaceRoot?: string}} input
 */
export async function migrateBatch({ batchDir, outDir, workspaceRoot }) {
  const verified = await verifyBatch({ batchDir, workspaceRoot })
  if (verified.verification.counts.errors > 0) {
    const codes = [...new Set(verified.verification.findings.filter((f) => f.severity === 'error').map((f) => f.code))].join(', ')
    throw handoffError(
      ERROR.MIGRATION_SOURCE_INVALID,
      `source batch ${verified.batchId} failed verification (${codes}); refusing to migrate an untrusted batch`
    )
  }
  const manifest = verified.manifest
  if (manifest === null) throw handoffError(ERROR.MIGRATION_SOURCE_INVALID, `source batch ${verified.batchId} has no readable manifest`)
  if (manifest.schemaVersion !== SCHEMA_VERSION) {
    throw handoffError(
      ERROR.MIGRATION_UNSUPPORTED_VERSION,
      `source batch ${verified.batchId} is schemaVersion ${String(manifest.schemaVersion)}; migrate upgrades schemaVersion 1 to 2 only`
    )
  }
  const absoluteOut = resolve(outDir)
  if (existsSync(absoluteOut) && readdirSync(absoluteOut).length > 0) {
    throw handoffError(ERROR.BATCH_EXISTS, `output directory is not empty: ${absoluteOut}; choose a new directory`)
  }
  const sourceSums = readFileSync(join(resolve(batchDir), SUMS_FILE), 'utf8')
  const migratedAt = new Date().toISOString()
  const batchId = basename(absoluteOut)
  if (!BATCH_ID_RE.test(batchId)) {
    throw handoffError(
      ERROR.INVALID_ARGS,
      `--out must end with a batch id (YYYYMMDDTHHmmssZ-xxxx), got "${batchId}"`
    )
  }
  const provenance = {
    fromBatchId: verified.batchId,
    fromSchemaVersion: manifest.schemaVersion,
    sourceSha256Sums: sha256Hex(sourceSums),
    sourceGenerator: isPlainObject(manifest.generator) ? manifest.generator : null,
    migratedAt,
    tool: generatorIdentity({ dshVersion: 'cli', platform: process.platform })
  }
  const warnings = mergeWarningsCli([
    ...(Array.isArray(manifest.warnings) ? manifest.warnings : []),
    {
      code: 'MIGRATED_FROM_V1',
      detail: `migrated from ${verified.batchId} (schemaVersion 1); host workspaceChanges/goal/jobs evidence of the original session is unavailable and marked available:false`
    }
  ])
  const migratedManifest = createManifest({
    batchId,
    createdAt: migratedAt,
    schemaVersion: SCHEMA_VERSION_V2,
    generator: generatorIdentity({ dshVersion: 'cli', platform: process.platform }),
    project: manifest.project,
    session: manifest.session,
    sandbox: manifest.sandbox,
    inputs: manifest.inputs,
    git: manifest.git,
    files: manifest.files,
    sessionTrace: manifest.sessionTrace,
    redactions: manifest.redactions,
    warnings,
    limits: publicLimits(),
    scan: manifest.scan,
    changes: {
      available: false,
      note: 'migrated from schemaVersion 1: host workspaceChanges evidence for the original session is unavailable',
      collectedAt: migratedAt
    },
    fuel: {
      goals: { available: false, note: 'migrated from schemaVersion 1: goal snapshot unavailable' },
      jobs: { available: false, note: 'migrated from schemaVersion 1: jobs snapshot unavailable' }
    }
  })
  const handoff = redactText(renderHandoff(migratedManifest))
  const migratedEvidence = {
    path: `${EVIDENCE_DIR}/migration.json`,
    content: jsonText({ schemaVersion: SCHEMA_VERSION, migration: provenance })
  }
  const redactedMigration = redactText(migratedEvidence.content)
  const covered = [
    { path: HANDOFF_FILE, content: handoff.text },
    ...evidenceTextsForManifest(migratedManifest).map((entry) => {
      const redacted = redactText(entry.content)
      return { path: entry.path, content: redacted.text }
    }),
    { path: migratedEvidence.path, content: redactedMigration.text }
  ].sort((left, right) => {
    if (left.path === HANDOFF_FILE) return -1
    if (right.path === HANDOFF_FILE) return 1
    return left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  })
  const artifacts = covered.map((entry) => artifactEntry(entry.path, entry.content))
  const sumsText = buildSha256Sums(artifacts)
  const manifestText = serializeManifest(setArtifacts(migratedManifest, [...artifacts, artifactEntry(SUMS_FILE, sumsText)]))
  const entries = [
    ...covered,
    { path: SUMS_FILE, content: sumsText },
    { path: MANIFEST_FILE, content: manifestText }
  ]
  guardSecrets([
    [HANDOFF_FILE, handoff.text],
    ...covered.map((entry) => [entry.path, entry.content]),
    [SUMS_FILE, sumsText],
    [MANIFEST_FILE, manifestText]
  ])
  mkdirSync(absoluteOut, { recursive: true })
  for (const entry of entries) {
    const target = resolveInside(absoluteOut, entry.path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, entry.content, 'utf8')
  }
  return {
    batchId,
    dir: absoluteOut,
    sourceDir: resolve(batchDir),
    migration: {
      fromBatchId: provenance.fromBatchId,
      fromSchemaVersion: provenance.fromSchemaVersion,
      sourceSha256Sums: provenance.sourceSha256Sums,
      migratedAt: provenance.migratedAt
    },
    artifacts: [...artifacts, artifactEntry(SUMS_FILE, sumsText)],
    warnings
  }
}

/* ───────────────────────────────── sign ──────────────────────────────────── */

/**
 * Sign one existing batch (opt-in, write-once).
 *
 * Writes exactly one file, `signature.json`, and never touches `SHA256SUMS` or
 * any other artifact: the envelope signs the current `SHA256SUMS` bytes, so the
 * batch's existing hash semantics are unchanged. The private key is read from
 * the explicit `--key` path only and never echoed or persisted.
 *
 * @param {{batchDir: string, keyPath: string, force?: boolean}} input
 * @returns {{batchDir: string, keyId: string, signedSha256: string}}
 * @throws {Error & {code: string}} usage/IO (`HANDOFF_INVALID_ARGS` /
 *   `HANDOFF_READ_FAILED` / `HANDOFF_WRITE_FAILED`), `HANDOFF_BATCH_EXISTS` when
 *   a signature already exists and `force` is not set.
 */
export function signBatch({ batchDir, keyPath, force = false } = {}) {
  if (typeof batchDir !== 'string' || batchDir === '')
    throw handoffError(ERROR.INVALID_ARGS, 'sign requires <batchDir>')
  if (typeof keyPath !== 'string' || keyPath === '')
    throw handoffError(ERROR.INVALID_ARGS, 'sign requires --key <privateKey.pem>')
  const absoluteDir = resolve(batchDir)
  let dirStat
  try {
    dirStat = lstatSync(absoluteDir)
  } catch {
    dirStat = undefined
  }
  if (dirStat === undefined || !dirStat.isDirectory())
    throw handoffError(ERROR.INVALID_ARGS, `batch directory not found: ${absoluteDir}`)
  const sumsPath = join(absoluteDir, SUMS_FILE)
  let sumsBytes
  try {
    sumsBytes = readFileSync(sumsPath)
  } catch (error) {
    throw handoffError(ERROR.READ_FAILED, `cannot read ${sumsPath}: ${errorMessageOf(error)}`)
  }
  const signaturePath = join(absoluteDir, SIGNATURE_FILE)
  if (existsSync(signaturePath) && force !== true)
    throw handoffError(
      ERROR.BATCH_EXISTS,
      `${SIGNATURE_FILE} already exists in ${absoluteDir}; pass --force to replace it`
    )
  const absoluteKeyPath = resolve(keyPath)
  let privateKeyPem
  try {
    privateKeyPem = readFileSync(absoluteKeyPath, 'utf8')
  } catch (error) {
    throw handoffError(ERROR.READ_FAILED, `cannot read private key file ${absoluteKeyPath}: ${errorMessageOf(error)}`)
  }
  const envelope = createSignatureEnvelope({
    sumsBytes,
    privateKeyPem,
    createdAt: new Date().toISOString()
  })
  try {
    writeFileSync(signaturePath, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8')
  } catch (error) {
    throw handoffError(ERROR.WRITE_FAILED, `cannot write ${signaturePath}: ${errorMessageOf(error)}`)
  }
  return {
    batchDir: absoluteDir,
    keyId: envelope.keyId,
    signedSha256: envelope.signedSha256
  }
}

/* ──────────────────────────────── delete ─────────────────────────────────── */

/**
 * Delete one batch (P3/M5b).
 *
 * Soft delete (default) moves the directory to
 * `<handoffRoot>/.trash/<projectKey>/<batchId>-<YYYYMMDDTHHmmssZ>` and stays
 * recoverable; `hard=true` removes it permanently. A batch referenced by
 * another batch's lineage is refused unless `force` is set.
 *
 * @param {{batchDir: string, hard?: boolean, force?: boolean}} input
 * @returns {Promise<{batchId: string, projectKey: string, mode: 'trash'|'hard',
 *   dir: string, trashDir?: string, warnings: Array<{code: string, detail: string}>}>}
 * @throws {Error & {code: string}} `HANDOFF_INVALID_ARGS` for a malformed batch
 *   path, `HANDOFF_BATCH_REFERENCED` for a referenced batch without force,
 *   `HANDOFF_BATCH_NOT_FOUND` / `HANDOFF_WRITE_FAILED` for IO failures.
 */
export async function deleteBatch({ batchDir, hard = false, force = false } = {}) {
  const located = parseBatchLocation(batchDir)
  let stat
  try {
    stat = lstatSync(located.dir)
  } catch {
    stat = undefined
  }
  if (stat === undefined || !stat.isDirectory())
    throw handoffError(ERROR.BATCH_NOT_FOUND, `batch directory not found: ${located.dir}`)
  const io = createNodeIo()
  const referrers = await findLineageReferrers({
    io,
    root: located.root,
    projectKey: located.projectKey,
    batchId: located.batchId
  })
  const warnings = []
  if (referrers.length > 0) {
    if (force !== true) {
      throw handoffError(
        ERROR.BATCH_REFERENCED,
        `batch ${located.batchId} is referenced by other batches (${describeReferrers(referrers)}); ` +
          'delete the newer batch(es) first or pass --force'
      )
    }
    warnings.push({
      code: REFERENCED_FORCE_WARNING,
      detail:
        `deleted batch ${located.batchId} is still referenced by ${describeReferrers(referrers)}; ` +
        'those batches will now report a LINEAGE_BROKEN finding'
    })
  }

  if (hard === true) {
    try {
      rmSync(located.dir, { recursive: true, force: false })
    } catch (error) {
      throw handoffError(ERROR.WRITE_FAILED, `cannot permanently delete ${located.dir}: ${errorMessageOf(error)}`)
    }
    warnings.push({
      code: HARD_DELETE_WARNING,
      detail: `batch ${located.batchId} was deleted permanently; the files cannot be recovered`
    })
    return {
      batchId: located.batchId,
      projectKey: located.projectKey,
      mode: 'hard',
      dir: located.dir,
      warnings: mergeWarningsCli(warnings)
    }
  }

  const timestamp = trashTimestamp(new Date())
  let trashDir
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = join(
      located.root,
      '.trash',
      located.projectKey,
      trashEntryName({ batchId: located.batchId, timestamp, attempt })
    )
    if (!existsSync(candidate)) {
      trashDir = candidate
      break
    }
  }
  if (trashDir === undefined)
    throw handoffError(ERROR.WRITE_FAILED, `cannot allocate a recycle-bin directory for ${located.batchId}`)
  try {
    mkdirSync(dirname(trashDir), { recursive: true })
    renameSync(located.dir, trashDir)
  } catch (error) {
    throw handoffError(ERROR.WRITE_FAILED, `cannot move ${located.dir} to ${trashDir}: ${errorMessageOf(error)}`)
  }
  return {
    batchId: located.batchId,
    projectKey: located.projectKey,
    mode: 'trash',
    dir: located.dir,
    trashDir,
    warnings: mergeWarningsCli(warnings)
  }
}

/** Merge/deduplicate/sort warning records (same rule as the plugin service). */
function mergeWarningsCli(warnings) {
  const seen = new Set()
  const merged = []
  for (const warning of warnings) {
    if (!isPlainObject(warning)) continue
    const code = String(warning.code ?? '')
    const detail = String(warning.detail ?? '')
    if (code === '') continue
    const key = `${code}\u0000${detail}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push({ code, detail })
  }
  merged.sort((left, right) => {
    if (left.code !== right.code) return left.code < right.code ? -1 : 1
    return left.detail < right.detail ? -1 : left.detail > right.detail ? 1 : 0
  })
  return merged
}

/* ───────────────────────────── argument parsing ──────────────────────────── */

/** Parse CLI argv into `{command, positional, flags}`. */
export function parseArgv(argv) {
  const flags = {
    json: false,
    help: false,
    version: false,
    sections: false,
    full: false,
    force: false,
    hard: false
  }
  const positional = []
  const valued = new Map([
    ['--workspace', 'workspace'],
    ['--out', 'out'],
    ['--root', 'root'],
    ['--key', 'key'],
    ['--pubkey', 'pubkey']
  ])
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--json') flags.json = true
    else if (token === '--help' || token === '-h') flags.help = true
    else if (token === '--version' || token === '-v') flags.version = true
    else if (token === '--sections') flags.sections = true
    else if (token === '--full') flags.full = true
    else if (token === '--force') flags.force = true
    else if (token === '--hard') flags.hard = true
    else if (valued.has(token)) {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw handoffError(ERROR.INVALID_ARGS, `${token} requires a value`)
      flags[valued.get(token)] = value
      index += 1
    } else if (token.startsWith('--')) {
      throw handoffError(ERROR.INVALID_ARGS, `unknown option ${token}`)
    } else {
      positional.push(token)
    }
  }
  const command = positional.shift() ?? null
  return { command, positional, flags }
}

const COMMANDS = new Set(['verify', 'load', 'list', 'migrate', 'sign', 'delete'])

function assertNoExtra(positional) {
  if (positional.length > 0) throw handoffError(ERROR.INVALID_ARGS, `unexpected argument: ${positional.join(' ')}`)
}

function assertBatchDir(positional, command) {
  const batchDir = positional.shift()
  if (batchDir === undefined) throw handoffError(ERROR.INVALID_ARGS, `${command} requires <batchDir>`)
  assertNoExtra(positional)
  return batchDir
}

/* ─────────────────────────────── output ──────────────────────────────────── */

function printVerify(result, flags, io) {
  if (flags.json) {
    io.stdout.write(jsonText({
      ok: result.trust !== 'invalid',
      batchId: result.batchId,
      dir: result.verification.dir,
      trust: result.trust,
      verification: result.verification,
      signature: result.signature,
      receipt: result.receipt
    }))
    return
  }
  const { verification } = result
  io.stdout.write(`verify ${result.batchId}: trust=${result.trust} (${verification.counts.errors} errors, ${verification.counts.warnings} warnings)\n`)
  io.stdout.write(`dir: ${verification.dir}\n`)
  for (const finding of verification.findings.slice(0, 10)) {
    io.stdout.write(`  ${finding.severity === 'error' ? 'ERROR' : 'WARN '} ${finding.code}${finding.path === undefined ? '' : ` (${finding.path})`}${finding.detail === undefined ? '' : `: ${finding.detail}`}\n`)
  }
  if (verification.findings.length > 10) io.stdout.write(`  … ${verification.findings.length - 10} more finding(s)\n`)
  if (verification.drift.artifactsChecked === 0 && !flags.workspace) {
    io.stdout.write('note: no --workspace given; git/source drift checks were skipped\n')
  }
}

function printLoad(result, flags, io) {
  if (flags.json) {
    io.stdout.write(jsonText({ ok: result.trust !== 'invalid', batchId: result.batchId, dir: result.dir, trust: result.trust, verification: result.verification, signature: result.signature, receipt: result.receipt, handoff: result.handoff, manifest: result.manifest, pointers: result.pointers }))
    return
  }
  io.stdout.write(`load ${result.batchId}: trust=${result.trust} (${result.verification.counts.errors} errors, ${result.verification.counts.warnings} warnings)\n`)
  io.stdout.write(`dir: ${result.dir}\n`)
  for (const pointer of result.pointers) io.stdout.write(`  ${pointer.label}: ${pointer.path}\n`)
}

function printList(result, flags, io) {
  if (flags.json) {
    io.stdout.write(jsonText({ ok: true, root: result.root, batches: result.batches }))
    return
  }
  io.stdout.write(`handoff root: ${result.root}\n`)
  io.stdout.write(`batches: ${result.batches.length}\n`)
  for (const batch of result.batches) {
    io.stdout.write(`  ${batch.projectKey}/${batch.batchId} ${batch.complete ? '' : '(incomplete) '}${batch.title === null ? '' : `${batch.title} `}(${batch.artifacts} artifacts, ${batch.bytes} bytes)\n`)
  }
}

function printMigrate(result, flags, io) {
  if (flags.json) {
    io.stdout.write(jsonText({ ok: true, batchId: result.batchId, dir: result.dir, sourceDir: result.sourceDir, migration: result.migration, artifacts: result.artifacts.length }))
    return
  }
  io.stdout.write(`migrated ${result.migration.fromBatchId} -> ${result.batchId} (schemaVersion 1 -> 2)\n`)
  io.stdout.write(`dir: ${result.dir}\nsource (unchanged): ${result.sourceDir}\n`)
}

function printSign(result, flags, io) {
  if (flags.json) {
    io.stdout.write(jsonText({
      ok: true,
      batchDir: result.batchDir,
      keyId: result.keyId,
      signedSha256: result.signedSha256
    }))
    return
  }
  io.stdout.write(`signed ${result.batchDir}\n`)
  io.stdout.write(`keyId: ${result.keyId}\n`)
  io.stdout.write(`signedSha256 (SHA256SUMS): ${result.signedSha256}\n`)
}

function printDelete(result, flags, io) {
  const warnings = Array.isArray(result.warnings) ? result.warnings : []
  if (flags.json) {
    io.stdout.write(jsonText({
      ok: true,
      batchId: result.batchId,
      projectKey: result.projectKey,
      mode: result.mode,
      ...(typeof result.trashDir === 'string' ? { trashDir: result.trashDir } : {}),
      ...(warnings.length > 0 ? { warnings } : {})
    }))
    return
  }
  if (result.mode === 'hard') {
    io.stdout.write(`PERMANENTLY DELETED ${result.batchId} (project ${result.projectKey}); this cannot be undone\n`)
    io.stdout.write(`dir: ${result.dir}\n`)
  } else {
    io.stdout.write(`moved ${result.batchId} (project ${result.projectKey}) to the recycle bin\n`)
    io.stdout.write(`trash dir: ${result.trashDir}\n`)
    io.stdout.write(`original dir (now gone): ${result.dir}\n`)
    io.stdout.write('restore by moving the trash directory back under its project key\n')
  }
  for (const warning of warnings) io.stdout.write(`WARN ${warning.code}: ${warning.detail}\n`)
}

function exitCodeForTrust(trust) {
  if (trust === 'verified') return EXIT.VERIFIED
  if (trust === 'stale') return EXIT.STALE
  return EXIT.INVALID
}

/**
 * Run the CLI. Returns the process exit code; never calls process.exit so the
 * entry point stays testable.
 * @param {string[]} argv
 * @param {{stdout?: {write: Function}, stderr?: {write: Function}}} [io]
 */
export async function runCli(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout
  const stderr = io.stderr ?? process.stderr
  const output = { stdout, stderr }
  let flags = { json: false }
  let command = null
  try {
    const parsed = parseArgv(argv)
    flags = parsed.flags
    command = parsed.command
    if (flags.version) {
      stdout.write(`${PLUGIN_VERSION}\n`)
      return EXIT.VERIFIED
    }
    if (flags.help || parsed.command === null) {
      stdout.write(`${CLI_USAGE}\n`)
      return flags.help ? EXIT.VERIFIED : EXIT.USAGE
    }
    if (!COMMANDS.has(parsed.command)) {
      throw handoffError(
        ERROR.INVALID_ARGS,
        `unknown command "${parsed.command}"; expected verify/load/list/migrate/sign/delete`
      )
    }
    if (flags.sections && flags.full) {
      throw handoffError(ERROR.INVALID_ARGS, '--sections and --full are mutually exclusive')
    }
    const assertBatchDirExists = (batchDir) => {
      if (!existsSync(resolve(batchDir))) {
        throw handoffError(ERROR.INVALID_ARGS, `batch directory not found: ${resolve(batchDir)}`)
      }
      return batchDir
    }
    if (parsed.command === 'verify') {
      const batchDir = assertBatchDirExists(assertBatchDir(parsed.positional, 'verify'))
      const result = await verifyBatch({ batchDir, workspaceRoot: flags.workspace, publicKeyPath: flags.pubkey })
      printVerify(result, flags, output)
      return exitCodeForTrust(result.trust)
    }
    if (parsed.command === 'load') {
      const batchDir = assertBatchDirExists(assertBatchDir(parsed.positional, 'load'))
      const include = flags.full ? 'full' : flags.sections ? 'sections' : 'summary'
      const result = await loadBatch({ batchDir, workspaceRoot: flags.workspace, include, publicKeyPath: flags.pubkey })
      printLoad(result, flags, output)
      return exitCodeForTrust(result.trust)
    }
    if (parsed.command === 'list') {
      assertNoExtra(parsed.positional)
      if (typeof flags.root !== 'string') throw handoffError(ERROR.INVALID_ARGS, 'list requires --root <handoffRoot>')
      printList(listBatches({ root: flags.root }), flags, output)
      return EXIT.VERIFIED
    }
    if (parsed.command === 'sign') {
      const batchDir = assertBatchDirExists(assertBatchDir(parsed.positional, 'sign'))
      if (typeof flags.key !== 'string') throw handoffError(ERROR.INVALID_ARGS, 'sign requires --key <privateKey.pem>')
      const result = signBatch({ batchDir, keyPath: flags.key, force: flags.force === true })
      printSign(result, flags, output)
      return EXIT.VERIFIED
    }
    if (parsed.command === 'delete') {
      const batchDir = assertBatchDirExists(assertBatchDir(parsed.positional, 'delete'))
      const result = await deleteBatch({
        batchDir,
        hard: flags.hard === true,
        force: flags.force === true
      })
      printDelete(result, flags, output)
      return EXIT.VERIFIED
    }
    // migrate
    const batchDir = assertBatchDirExists(assertBatchDir(parsed.positional, 'migrate'))
    if (typeof flags.out !== 'string') throw handoffError(ERROR.INVALID_ARGS, 'migrate requires --out <newBatchDir>')
    const result = await migrateBatch({ batchDir, outDir: flags.out, workspaceRoot: flags.workspace })
    printMigrate(result, flags, output)
    return EXIT.VERIFIED
  } catch (error) {
    const code = errorCodeOf(error)
    const usage = code === ERROR.INVALID_ARGS || code === ERROR.INTERNAL
    // `sign`/`delete` promise 1 = refusal (existing signature / referenced
    // batch), 2 = usage OR IO (spec/verify.md).
    const signIo = command === 'sign' && (code === ERROR.READ_FAILED || code === ERROR.WRITE_FAILED)
    const deleteIo =
      command === 'delete' && (code === ERROR.READ_FAILED || code === ERROR.WRITE_FAILED)
    const exitCode = usage || signIo || deleteIo ? EXIT.USAGE : EXIT.INVALID
    if (flags.json) {
      stdout.write(jsonText({ ok: false, error: { code, message: errorMessageOf(error) } }))
    } else {
      stderr.write(`[${code}] ${errorMessageOf(error)}\n`)
      if (usage) stderr.write(`${CLI_USAGE}\n`)
    }
    return exitCode
  }
}
