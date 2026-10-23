/**
 * Service orchestration for the four `handoff_pack` actions.
 *
 * The service owns every side effect: context resolution (session, workspace,
 * sandbox policy), evidence collection, deterministic assembly, and the write
 * plan. The tool and the `/handoff` command are thin adapters over
 * {@link createService}.
 *
 * P0 invariants enforced here:
 *   - `scan` performs zero writes;
 *   - `manifest.json` is written last; its presence means "batch complete";
 *   - every write goes through `ctx.fs.writeText` with the resolved sandbox
 *     policy, and `target=user` is refused before touching the filesystem
 *     unless the session mode is `danger-full-access`;
 *   - nothing is ever deleted (no delete primitive) — failures report partial
 *     progress and leave evidence for `verify`.
 *
 * @module dsh-handoff-kit/service
 */

import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

import {
  EVIDENCE_DIR,
  EVIDENCE_FILES_DIR,
  ERROR,
  FS_NOT_FOUND,
  HANDOFF_FILE,
  HANDOFF_SUBDIR,
  LIMITS,
  LOAD_LIMITS,
  MANIFEST_FILE,
  SCHEMA_VERSION,
  SCHEMA_VERSION_V2,
  SUMS_FILE,
  WORKSPACE_HANDOFF_SUBDIR,
  errorMessageOf,
  generatorIdentity,
  handoffError,
  isPlainObject,
  publicLimits
} from './contracts.js'
import {
  batchTimestampToIso,
  compareBatchIds,
  isBatchId,
  isInside,
  makeBatchId,
  normalizeArtifactPath,
  projectKey,
  projectKeySlug,
  resolveArtifact,
  resolveInside,
  sha256Hex,
  shortHash,
  toPosix,
  tokenizePath
} from './paths.js'
import { readGitInfo } from './git.js'
import { collectWorkspace, readCopyCandidate } from './collect.js'
import { buildSessionTrace } from './session-trace.js'
import {
  boundDiffEntries,
  buildChanges,
  buildCurrentTurn,
  buildDiffEntry,
  findLatestChangesEvent,
  findOpenTurn,
  normalizeChangePath,
  unavailableChanges
} from './changes.js'
import { buildFuel } from './fuel.js'
import { isDeniedFile, redactDeep, redactText, scanSecrets } from './redact.js'
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
import { renderHandoff } from './render.js'
import { assertBatchCreatable, orderEntries, writeBatch } from './write.js'

/** Environment-level limitations every generated handoff states honestly. */
export const ENV_WARNINGS = Object.freeze([
  {
    code: 'NO_MTIME_API',
    detail:
      'the filesystem service exposes no mtime; recency is unavailable and replaced by git reflog plus session tool/call metadata'
  },
  {
    code: 'NO_GIT_STATUS',
    detail:
      'subprocesses are disabled in P0; git status/dirty state is unavailable and must not be assumed from this package'
  }
])

const MAX_VERIFY_ARTIFACT_BYTES = 8 * 1024 * 1024
const RESULT_KEY_ORDER = [
  'ok',
  'action',
  'dir',
  'displayDir',
  'project',
  'batchId',
  'git',
  'artifacts',
  'totals',
  'redactions',
  'warnings',
  'scan',
  'changes',
  'lineage',
  'migration',
  'preview',
  'verification',
  'batches',
  'next',
  'limits'
]

function sortArtifacts(artifacts) {
  return [...artifacts].sort((left, right) => {
    if (left.path === SUMS_FILE) return 1
    if (right.path === SUMS_FILE) return -1
    if (left.path === HANDOFF_FILE) return -1
    if (right.path === HANDOFF_FILE) return 1
    return left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  })
}

/** Merge, deduplicate and sort warning records deterministically. */
export function mergeWarnings(warnings) {
  const seen = new Set()
  const merged = []
  for (const warning of warnings) {
    if (warning === null || typeof warning !== 'object') continue
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

/** Resolve the harness home without ever reading credentials. */
export function resolveDshHome(env = {}) {
  const configured = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  if (configured !== '') return resolve(configured)
  return join(homedir(), '.dsh')
}

/** Handoff root for a target (`user` default, `workspace` downgrade). */
export function handoffRootFor(target, context) {
  if (target === 'workspace') return join(context.workspaceRoot, ...WORKSPACE_HANDOFF_SUBDIR.split('/'))
  return join(context.dshHome, HANDOFF_SUBDIR)
}

/**
 * Deterministically slice the newest session events under the byte/event
 * budget (walk from the end, stop before exceeding either bound).
 * @param {readonly object[]} events
 * @param {number} maxEvents
 * @param {number} maxBytes
 * @returns {object[]}
 */
export function takeEventWindow(events, maxEvents, maxBytes) {
  const window = []
  let bytes = 0
  for (let index = events.length - 1; index >= 0 && window.length < maxEvents; index -= 1) {
    let size = 0
    try {
      size = Buffer.byteLength(JSON.stringify(events[index]), 'utf8')
    } catch {
      size = 0
    }
    if (window.length > 0 && bytes + size > maxBytes) break
    window.unshift(events[index])
    bytes += size
  }
  return window
}

/** Aggregate redaction hits by artifact file and rule, deterministically. */
export function createRedactionLedger() {
  /** @type {Map<string, Map<string, number>>} */
  const byFile = new Map()
  return {
    add(file, hits) {
      for (const hit of hits ?? []) {
        if (hit === null || typeof hit !== 'object') continue
        const kind = String(hit.kind ?? '')
        const count = Number(hit.count ?? 0)
        if (kind === '' || !Number.isFinite(count) || count <= 0) continue
        if (!byFile.has(file)) byFile.set(file, new Map())
        const kinds = byFile.get(file)
        kinds.set(kind, (kinds.get(kind) ?? 0) + count)
      }
    },
    list() {
      const rows = []
      for (const [file, kinds] of byFile) {
        for (const [kind, count] of kinds) rows.push({ file, kind, count })
      }
      rows.sort((left, right) => {
        if (left.file !== right.file) return left.file < right.file ? -1 : 1
        return left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0
      })
      return rows
    },
    count() {
      let total = 0
      for (const kinds of byFile.values()) for (const count of kinds.values()) total += count
      return total
    }
  }
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

function totalsOf(values = {}) {
  return {
    files: values.files ?? 0,
    readBytes: values.readBytes ?? 0,
    artifacts: values.artifacts ?? 0,
    artifactBytes: values.artifactBytes ?? 0,
    redactions: values.redactions ?? 0,
    warnings: values.warnings ?? 0
  }
}

function gitSummary(git) {
  if (git === null || git === undefined) return undefined
  const summary = {
    head: typeof git.head === 'string' ? git.head : null,
    branch: typeof git.branch === 'string' ? git.branch : null,
    detached: git.detached === true,
    remote: typeof git.remote === 'string' ? git.remote : null,
    indexVersion: Number.isInteger(git.indexVersion) ? git.indexVersion : null,
    packedRefsPresent: git.packedRefsPresent === true
  }
  if (isPlainObject(git.lastCommit) && typeof git.lastCommit.sha === 'string') {
    summary.lastCommit = {
      sha: git.lastCommit.sha,
      time: String(git.lastCommit.time ?? ''),
      subject: String(git.lastCommit.subject ?? '')
    }
  }
  return summary
}

function truncateText(text, maxChars) {
  if (text.length <= maxChars) return { text, truncated: false }
  return { text: `${text.slice(0, maxChars)}\n\n…（预览截断，完整内容见创建后的 HANDOFF.md）`, truncated: true }
}

function inputsRecord(args) {
  return {
    title: args.title ?? null,
    goal: args.goal ?? null,
    summary: args.summary ?? null,
    decisions: [...args.decisions],
    nextSteps: [...args.nextSteps],
    concepts: [...args.concepts],
    flow: [...args.flow],
    risks: [...args.risks],
    files: [...args.files],
    copyFiles: args.copyFiles === true
  }
}

/**
 * Create the action service.
 * @param {{
 *   ctx: any,
 *   env?: Record<string, string|undefined>,
 *   now?: () => Date,
 *   randomSuffix?: () => string,
 *   dshVersion?: string,
 *   platform?: string
 * }} input
 */
export function createService({
  ctx,
  env = {},
  now = () => new Date(),
  randomSuffix = () => randomBytes(2).toString('hex'),
  dshVersion = 'unknown',
  platform = process.platform
}) {
  if (ctx === null || typeof ctx !== 'object' || ctx.fs === undefined)
    throw handoffError(ERROR.INTERNAL, 'createService requires a context with ctx.fs')
  const dshHome = resolveDshHome(env)

  function ioFor(signal) {
    const resolveTarget = (absolutePath) =>
      signal === undefined ? ctx.fs.resolve(absolutePath) : ctx.fs.resolve(absolutePath, { signal })
    const mapEntries = (entries) =>
      (entries ?? []).map((entry) => ({
        name: entry.name,
        type: entry.type,
        ...(Number.isFinite(entry.size) ? { size: entry.size } : {})
      }))
    const readText = async (absolutePath) => ctx.fs.readText(await resolveTarget(absolutePath), signal)
    const readBytes = async (absolutePath, maxBytes) =>
      ctx.fs.readBytes(await resolveTarget(absolutePath), signal, maxBytes)
    const listDirectory = async (absolutePath) =>
      mapEntries(await ctx.fs.listDir(await resolveTarget(absolutePath), signal))
    return {
      async lstat(absolutePath) {
        return ctx.fs.lstat(absolutePath, undefined, signal)
      },
      async stat(absolutePath) {
        return ctx.fs.stat(await resolveTarget(absolutePath), signal)
      },
      readText,
      readBytes,
      listDir: listDirectory,
      list: listDirectory,
      resolve: resolveTarget
    }
  }

  async function displayOf(absolutePath) {
    try {
      const target = await ctx.fs.resolve(absolutePath)
      return target.displayPath
    } catch {
      return absolutePath
    }
  }

  async function resolveContext(exec) {
    const agent = exec?.agent
    const session =
      agent !== undefined && agent !== null && typeof ctx.sessions?.get === 'function'
        ? ctx.sessions.get(agent.id)
        : undefined
    const workingDirectory =
      typeof ctx.get === 'function' ? ctx.get('workingDirectory') : ctx.workingDirectory
    let workspaceRoot
    if (session !== undefined && session !== null) {
      workspaceRoot =
        typeof workingDirectory?.get === 'function' ? workingDirectory.get(session) : undefined
      if (typeof workspaceRoot !== 'string' || workspaceRoot === '')
        workspaceRoot = session.header?.cwd
    }
    if (typeof workspaceRoot !== 'string' || workspaceRoot === '') {
      workspaceRoot = workingDirectory?.defaultDirectory
    }
    if (typeof workspaceRoot !== 'string' || workspaceRoot === '') {
      throw handoffError(ERROR.INTERNAL, 'cannot resolve the session workspace directory')
    }
    let workspaceCanonical = workspaceRoot
    try {
      workspaceCanonical = (await ctx.fs.resolve(workspaceRoot)).targetKey
    } catch {
      workspaceCanonical = resolve(workspaceRoot)
    }
    const policy = ctx.sandboxPolicy.resolve({ session })
    return {
      session: session ?? null,
      workspaceRoot,
      workspaceCanonical,
      policy,
      dshHome,
      agentPreset: session?.header?.agentPreset ?? null,
      contexts: { workspaceRoot, dshHome, platform }
    }
  }

  async function resolveProject(context, io) {
    const gitResult = await readGitInfo({ io, workspaceRoot: context.workspaceRoot })
    const git = gitResult?.git ?? null
    const project = {
      key: projectKey({
        repoRoot: context.workspaceRoot,
        remoteUrl: git?.remote ?? null,
        workspaceCanonical: context.workspaceCanonical
      }),
      name: basename(context.workspaceRoot),
      workspace: tokenizePath(context.workspaceRoot, context.contexts)
    }
    return { project, git, warnings: Array.isArray(gitResult?.warnings) ? gitResult.warnings : [] }
  }

  async function resolveTrace(context) {
    const events = typeof context.session?.ownEvents === 'function' ? context.session.ownEvents() : []
    const windowEvents = takeEventWindow(events, LIMITS.sessionMaxEvents, LIMITS.sessionMaxBytes)
    const trace = buildSessionTrace({
      sessionId: context.session?.id ?? null,
      events: windowEvents,
      totalEvents: events.length,
      contexts: context.contexts,
      limits: LIMITS
    })
    const warnings = []
    if (context.session === null || context.session === undefined) {
      warnings.push({
        code: 'SESSION_UNAVAILABLE',
        detail: 'no live session for this call; session tool/call trace is empty'
      })
    }
    if (windowEvents.length < events.length) {
      warnings.push({
        code: 'TRACE_TRUNCATED',
        detail: `session trace window ${windowEvents.length}/${events.length} events (bounds: ${LIMITS.sessionMaxEvents} events / ${LIMITS.sessionMaxBytes} bytes)`
      })
    }
    return { trace, warnings }
  }

  async function scanWorkspace({ args, context, exec }) {
    const io = ioFor(exec?.signal)
    const projectInfo = await resolveProject(context, io)
    const traceInfo = await resolveTrace(context)
    const collect = await collectWorkspace({
      workspaceRoot: context.workspaceRoot,
      workspaceCanonical: context.workspaceCanonical,
      dshHome,
      explicitFiles: args.files,
      io,
      limits: LIMITS,
      trace: traceInfo.trace
    })
    const warnings = mergeWarnings([
      ...ENV_WARNINGS,
      ...projectInfo.warnings,
      ...traceInfo.warnings,
      ...(Array.isArray(collect.warnings) ? collect.warnings : [])
    ])
    return { io, projectInfo, traceInfo, collect, warnings }
  }

  function sessionRecord(context) {
    return {
      id: context.session?.id ?? null,
      cwd:
        context.session === null || context.session === undefined
          ? null
          : tokenizePath(context.session.header?.cwd ?? context.workspaceRoot, context.contexts),
      agentPreset: context.agentPreset ?? null
    }
  }

  function sandboxRecord(context) {
    return {
      mode: context.policy.mode,
      workspaceRoot: tokenizePath(context.policy.workspaceRoot, context.contexts)
    }
  }

  function scanRecord(collect) {
    return {
      entries: collect.entries ?? 0,
      dirs: collect.dirs ?? 0,
      denied: collect.denied ?? 0,
      symlinksSkipped: collect.symlinksSkipped ?? 0,
      readBytes: collect.readBytes ?? 0,
      explicitFiles: collect.explicitFiles ?? [],
      tree: collect.tree ?? []
    }
  }

  function assertCreateAllowed(args, context) {
    const mode = context.policy?.mode ?? 'danger-full-access'
    if (mode === 'read-only') {
      throw handoffError(
        ERROR.READ_ONLY,
        `the session sandbox is read-only; create needs a writable mode. Switch to danger-full-access (target=user) or workspace-write (target=workspace).`
      )
    }
    if (args.target === 'user' && mode !== 'danger-full-access') {
      throw handoffError(
        ERROR.SANDBOX_DENIED,
        `target=user writes outside the session workspace and requires danger-full-access (current mode: ${mode}). Either switch the session permission to danger-full-access or pass target=workspace.`
      )
    }
    const root = handoffRootFor(args.target, context)
    if (args.target === 'workspace' && !isInside(context.workspaceRoot, root, { platform })) {
      throw handoffError(ERROR.PATH_ESCAPE, `target=workspace root escapes the workspace: ${root}`)
    }
    return root
  }

  /**
   * Read the host's workspaceChanges evidence for the latest *completed* turn.
   * Session-scoped by contract: the service only serves live sessions, and the
   * open turn has no `workspace/changes` event yet.
   */
  async function collectChanges({ context, exec, includeDiffs }) {
    const collectedAt = now().toISOString()
    const events =
      context.session !== null && typeof context.session?.ownEvents === 'function'
        ? context.session.ownEvents()
        : []
    const openTurn = findOpenTurn(events)
    const currentTurn = buildCurrentTurn({
      events,
      openTurn,
      contexts: context.contexts,
      limits: LIMITS
    })
    const attach = (block) => {
      if (currentTurn !== undefined) block.currentTurn = currentTurn
      return block
    }
    if (context.session === null)
      return attach(unavailableChanges('no live session for this call', collectedAt))
    const service = typeof ctx.get === 'function' ? ctx.get('workspaceChanges') : undefined
    if (service === undefined || service === null || typeof service.summary !== 'function')
      return attach(
        unavailableChanges('workspaceChanges service is unavailable in this profile', collectedAt)
      )
    const found = findLatestChangesEvent(events)
    if (found === undefined)
      return attach(
        unavailableChanges('no completed turn with workspace changes in this session', collectedAt)
      )
    let summary
    try {
      summary = service.summary(context.session.id, found.seq)
    } catch (error) {
      return attach(
        unavailableChanges(`workspaceChanges.summary failed: ${errorMessageOf(error)}`, collectedAt)
      )
    }
    if (summary === undefined || summary === null)
      return attach(
        unavailableChanges(
          'workspaceChanges summary is no longer available (session disposed?)',
          collectedAt
        )
      )
    const block = buildChanges({
      summary,
      contexts: context.contexts,
      limits: LIMITS,
      collectedAt
    })
    if (includeDiffs !== true || block.available !== true) return attach(block)
    const rawFiles = Array.isArray(summary.files) ? summary.files : []
    const signal = exec?.signal ?? new AbortController().signal
    const entries = []
    for (let index = 0; index < rawFiles.length && entries.length < LIMITS.changesMaxDiffs; index += 1) {
      const file = rawFiles[index]
      if (file === null || typeof file !== 'object' || typeof file.path !== 'string') continue
      if (file.binary === true || file.oversized === true) continue
      const path = normalizeChangePath(file.path, context.contexts)
      if (path === undefined) continue
      try {
        const diff = await service.diff(context.session.id, found.seq, index, signal)
        const entry = buildDiffEntry({ path, diff })
        if (entry !== undefined) entries.push(entry)
      } catch {
        /* one unreadable diff must not fail the whole handoff */
      }
    }
    block.diffs = boundDiffEntries(entries, LIMITS.changesDiffTotalBytes)
    return attach(block)
  }

  /** Read optional goal/jobs fuel; every failure degrades to available:false. */
  async function collectFuel({ context, exec }) {
    const agent = exec?.agent
    const goalsService = typeof ctx.get === 'function' ? ctx.get('goals') : undefined
    let goal
    let goalAvailable = false
    let goalNote
    if (agent === undefined || agent === null) goalNote = 'no live agent for this call'
    else if (goalsService === undefined || goalsService === null || typeof goalsService.get !== 'function')
      goalNote = 'goals service is unavailable in this profile'
    else {
      try {
        goal = goalsService.get(agent)
        goalAvailable = true
      } catch (error) {
        goalNote = `goals.get failed: ${errorMessageOf(error)}`
      }
    }
    const jobsService = typeof ctx.get === 'function' ? ctx.get('jobs') : undefined
    let jobs
    let jobsNote
    if (jobsService === undefined || jobsService === null || typeof jobsService.list !== 'function')
      jobsNote = 'jobs service is unavailable in this profile'
    else {
      try {
        jobs = jobsService.list(context.session?.id)
      } catch (error) {
        jobsNote = `jobs.list failed: ${errorMessageOf(error)}`
      }
    }
    return buildFuel({
      goal,
      goalAvailable,
      jobs,
      sessionId: context.session?.id,
      limits: LIMITS,
      goalNote,
      jobsNote
    })
  }

  /**
   * Resolve the append/update lineage target: an explicit previous/superseded
   * batch id or the latest complete batch. Refuses to link a missing or
   * unreadable batch (no partial history).
   */
  async function resolveLineage({ args, context, io, root, projectKeyName, batchId }) {
    if (args.action !== 'append' && args.action !== 'update') return undefined
    const projectDir = join(root, projectKeyName)
    const requested = args.action === 'append' ? args.previousBatchId : args.supersedes
    let targetId = requested
    if (targetId === undefined) {
      let entries = []
      try {
        entries = await io.listDir(projectDir)
      } catch {
        entries = []
      }
      const ids = entries
        .map((entry) => entry.name)
        .filter((name) => isBatchId(name))
        .sort((left, right) => compareBatchIds(right, left))
      if (ids.length === 0)
        throw handoffError(
          ERROR.APPEND_TARGET_MISSING,
          `no previous batch exists for ${args.action}; create the first batch without append/update`
        )
      targetId = ids[0]
    }
    const targetDir = join(projectDir, targetId)
    const info = await io.lstat(targetDir)
    if (info === undefined)
      throw handoffError(ERROR.APPEND_TARGET_MISSING, `target batch ${targetId} not found under ${projectDir}`)
    if (targetId === batchId)
      throw handoffError(ERROR.LINEAGE_CYCLE, 'a batch cannot append to or supersede itself')
    let targetManifest
    try {
      targetManifest = parseManifest(await io.readText(join(targetDir, MANIFEST_FILE)))
    } catch (error) {
      throw handoffError(
        ERROR.APPEND_TARGET_MISSING,
        `target batch ${targetId} has no readable manifest.json (${errorMessageOf(error)}); refusing to link`
      )
    }
    const previousLineage = isPlainObject(targetManifest.lineage) ? targetManifest.lineage : null
    const sequence =
      previousLineage !== null && Number.isInteger(previousLineage.sequence)
        ? previousLineage.sequence + 1
        : 2
    const rootBatchId =
      previousLineage !== null && typeof previousLineage.root === 'string'
        ? previousLineage.root
        : targetId
    const lineage = { sequence, previous: targetId, root: rootBatchId }
    if (args.action === 'update') lineage.supersedes = targetId
    return lineage
  }

  /** Report lineage problems: broken previous link and superseded batches. */
  async function checkLineage({ manifest, located, io, findings }) {
    const lineage = isPlainObject(manifest?.lineage) ? manifest.lineage : null
    const projectDir = located.projectDir
    if (lineage !== null && typeof lineage.previous === 'string') {
      const previousDir = join(projectDir, lineage.previous)
      let info
      try {
        info = await io.lstat(previousDir)
      } catch {
        info = undefined
      }
      if (info === undefined) {
        findings.push({
          severity: 'error',
          code: 'LINEAGE_BROKEN',
          path: 'lineage.previous',
          detail: `previous batch ${lineage.previous} is missing`
        })
      } else {
        try {
          parseManifest(await io.readText(join(previousDir, MANIFEST_FILE)))
        } catch {
          findings.push({
            severity: 'error',
            code: 'LINEAGE_BROKEN',
            path: 'lineage.previous',
            detail: `previous batch ${lineage.previous} has an unreadable manifest.json`
          })
        }
      }
    }
    let entries = []
    try {
      entries = await io.listDir(projectDir)
    } catch {
      entries = []
    }
    const siblings = entries
      .map((entry) => entry.name)
      .filter((name) => isBatchId(name))
      .slice(0, 200)
    for (const siblingId of siblings) {
      if (siblingId === located.batchId) continue
      try {
        const sibling = parseManifest(await io.readText(join(projectDir, siblingId, MANIFEST_FILE)))
        if (isPlainObject(sibling.lineage) && sibling.lineage.supersedes === located.batchId) {
          findings.push({
            severity: 'warn',
            code: 'SUPERSEDED_BATCH',
            path: MANIFEST_FILE,
            detail: `this batch was superseded by ${siblingId}`
          })
          break
        }
      } catch {
        /* unreadable sibling manifests are not this batch's problem */
      }
    }
  }

  async function prepareCopies({ args, context, io, files, ledger }) {
    const entries = []
    const warnings = []
    let readBytes = 0
    if (args.copyFiles !== true) return { entries, warnings, readBytes }
    const candidates = (files ?? [])
      .filter((file) => typeof file?.path === 'string' && !isDeniedFile(file.path))
      .filter((file) => file.sha256 !== undefined && file.skippedReason === undefined)
      .slice(0, LIMITS.copyMaxFiles)
    for (const candidate of candidates) {
      let result
      try {
        result = await readCopyCandidate({
          io,
          workspaceRoot: context.workspaceRoot,
          relPath: candidate.path,
          limits: LIMITS
        })
      } catch (error) {
        warnings.push({
          code: 'COPY_FILE_SKIPPED',
          detail: `${candidate.path}: ${errorMessageOf(error)}`
        })
        continue
      }
      if (result === null || typeof result !== 'object' || typeof result.content !== 'string') {
        warnings.push({
          code: 'COPY_FILE_SKIPPED',
          detail: `${candidate.path}: ${result?.skippedReason ?? 'not a copyable text file'}`
        })
        continue
      }
      const redacted = redactText(result.content)
      ledger.add(`${EVIDENCE_FILES_DIR}/${candidate.path}`, redacted.hits)
      readBytes += Buffer.byteLength(result.content, 'utf8')
      entries.push({
        path: `${EVIDENCE_FILES_DIR}/${candidate.path}`,
        content: redacted.text
      })
    }
    return { entries, warnings, readBytes }
  }

  function buildEvidenceTexts(manifest) {
    return [
      {
        path: `${EVIDENCE_DIR}/git.json`,
        content: jsonText({ schemaVersion: SCHEMA_VERSION, generator: manifest.generator, git: manifest.git })
      },
      {
        path: `${EVIDENCE_DIR}/files.json`,
        content: jsonText({ schemaVersion: SCHEMA_VERSION, scan: manifest.scan, files: manifest.files })
      },
      {
        path: `${EVIDENCE_DIR}/session.json`,
        content: jsonText(manifest.sessionTrace)
      },
      {
        path: `${EVIDENCE_DIR}/redactions.json`,
        content: jsonText({ schemaVersion: SCHEMA_VERSION, redactions: manifest.redactions })
      }
    ]
  }

  function guardFinalSecrets(texts) {
    for (const [file, text] of texts) {
      const residue = scanSecrets(String(text ?? ''))
      if (residue.length > 0) {
        const summary = residue.map((hit) => `${hit.kind} x${hit.count}`).join(', ')
        throw handoffError(
          ERROR.SECRET_CHECK_FAILED,
          `secret residue survived redaction in ${file} (${summary}); the whole batch was NOT written`
        )
      }
    }
  }

  async function runScan(args, exec) {
    const context = await resolveContext(exec)
    const { io, projectInfo, traceInfo, collect, warnings } = await scanWorkspace({ args, context, exec })
    void io
    const createdAt = now().toISOString()
    const batchId = makeBatchId({ date: new Date(createdAt), suffix: randomSuffix() })
    const root = handoffRootFor(args.target, context)
    const batchDir = join(root, projectInfo.project.key, batchId)
    const manifest = createManifest({
      batchId,
      createdAt,
      target: args.target,
      generator: generatorIdentity({ dshVersion, platform }),
      project: projectInfo.project,
      session: sessionRecord(context),
      sandbox: sandboxRecord(context),
      inputs: inputsRecord(args),
      git: projectInfo.git,
      files: collect.files ?? [],
      sessionTrace: traceInfo.trace,
      redactions: [],
      warnings,
      limits: publicLimits(),
      scan: scanRecord(collect)
    })
    const preview = truncateText(renderHandoff(manifest), LIMITS.previewChars)
    const dirToken = tokenizePath(batchDir, context.contexts)
    return finish({
      action: 'scan',
      dir: dirToken,
      displayDir: await displayOf(batchDir),
      project: projectInfo.project,
      batchId,
      git: gitSummary(projectInfo.git),
      totals: totalsOf({
        files: (collect.files ?? []).length,
        readBytes: collect.readBytes ?? 0,
        warnings: warnings.length
      }),
      warnings,
      scan: {
        entries: collect.entries ?? 0,
        files: collect.files ?? [],
        tree: collect.tree ?? [],
        explicitFiles: (collect.explicitFiles ?? []).length
      },
      preview,
      next: [
        `review scan.files and scan.tree, then run handoff_pack action=create (planned dir: ${dirToken})`,
        'scan never writes; create writes the batch directory'
      ],
      limits: publicLimits()
    })
  }

  async function runCreate(args, exec) {
    const context = await resolveContext(exec)
    const root = assertCreateAllowed(args, context)
    const { io, projectInfo, traceInfo, collect, warnings } = await scanWorkspace({ args, context, exec })
    const ledger = createRedactionLedger()
    const copy = await prepareCopies({
      args,
      context,
      io,
      files: collect.files ?? [],
      ledger
    })
    const changes = await collectChanges({ context, exec, includeDiffs: args.includeDiffs === true })
    const fuel = await collectFuel({ context, exec })
    const fuelWarnings = []
    if (changes.available !== true) {
      fuelWarnings.push({ code: 'CHANGES_UNAVAILABLE', detail: String(changes.note ?? 'workspaceChanges unavailable') })
    } else if (changes.truncated === true) {
      fuelWarnings.push({ code: 'CHANGES_TRUNCATED', detail: String(changes.note ?? 'changed-file list truncated') })
    }
    if (fuel.goals.available !== true) {
      fuelWarnings.push({ code: 'GOAL_UNAVAILABLE', detail: String(fuel.goals.note ?? 'goal unavailable') })
    }
    if (fuel.jobs.available !== true) {
      fuelWarnings.push({ code: 'JOBS_UNAVAILABLE', detail: String(fuel.jobs.note ?? 'jobs unavailable') })
    }
    const allWarnings = mergeWarnings([...warnings, ...copy.warnings, ...fuelWarnings])

    // Redact every independently sourced string before it can reach an artifact.
    const redactedInputs = redactDeep(inputsRecord(args))
    ledger.add(HANDOFF_FILE, redactedInputs.hits)
    const redactedGit = redactDeep(projectInfo.git)
    ledger.add(`${EVIDENCE_DIR}/git.json`, redactedGit.hits)
    ledger.add(`${EVIDENCE_DIR}/session.json`, traceInfo.trace.redactionHits ?? [])

    const createdAt = now().toISOString()
    const batchId = makeBatchId({ date: new Date(createdAt), suffix: randomSuffix() })
    const projectDir = join(root, projectInfo.project.key)
    const batchDir = join(projectDir, batchId)
    await assertBatchCreatable({ fs: ctx.fs, rootDir: batchDir, force: args.force })
    const lineage = await resolveLineage({
      args,
      context,
      io,
      root,
      projectKeyName: projectInfo.project.key,
      batchId
    })

    let manifest = null
    let handoffText = ''
    let evidenceTexts = []
    for (let pass = 0; pass < 3; pass += 1) {
      const before = ledger.count()
      manifest = createManifest({
        batchId,
        createdAt,
        target: args.target,
        schemaVersion: SCHEMA_VERSION_V2,
        generator: generatorIdentity({ dshVersion, platform }),
        project: projectInfo.project,
        session: sessionRecord(context),
        sandbox: sandboxRecord(context),
        inputs: redactedInputs.value,
        git: redactedGit.value,
        files: collect.files ?? [],
        sessionTrace: traceInfo.trace,
        redactions: ledger.list(),
        warnings: allWarnings,
        limits: publicLimits(),
        scan: scanRecord(collect),
        changes,
        fuel,
        ...(lineage !== undefined ? { lineage } : {})
      })
      const handoff = redactText(renderHandoff(manifest))
      ledger.add(HANDOFF_FILE, handoff.hits)
      handoffText = handoff.text
      evidenceTexts = buildEvidenceTexts(manifest).map((entry) => {
        const redacted = redactText(entry.content)
        ledger.add(entry.path, redacted.hits)
        return { path: entry.path, content: redacted.text }
      })
      if (ledger.count() === before) break
    }

    const covered = orderEntries([
      { path: HANDOFF_FILE, content: handoffText },
      ...evidenceTexts,
      ...copy.entries
    ])
    const coveredArtifacts = covered.map((entry) => artifactEntry(entry.path, entry.content))
    const sumsText = buildSha256Sums(coveredArtifacts)
    const finalArtifacts = sortArtifacts([...coveredArtifacts, artifactEntry(SUMS_FILE, sumsText)])
    const finalManifest = setArtifacts(manifest, finalArtifacts)
    const manifestText = serializeManifest(finalManifest)
    const entries = orderEntries([
      ...covered,
      { path: SUMS_FILE, content: sumsText },
      { path: MANIFEST_FILE, content: manifestText }
    ])
    guardFinalSecrets([
      [HANDOFF_FILE, handoffText],
      ...evidenceTexts.map((entry) => [entry.path, entry.content]),
      ...copy.entries.map((entry) => [entry.path, entry.content]),
      [SUMS_FILE, sumsText],
      [MANIFEST_FILE, manifestText]
    ])
    await writeBatch({
      fs: ctx.fs,
      policy: context.policy,
      rootDir: batchDir,
      entries,
      signal: exec?.signal,
      force: args.force
    })

    const artifactBytes = finalArtifacts.reduce(
      (sum, artifact) => sum + (Number.isFinite(artifact.bytes) ? artifact.bytes : 0),
      0
    )
    const dirToken = tokenizePath(batchDir, context.contexts)
    const changesSummary = {
      available: changes.available === true,
      ...(typeof changes.source === 'string' ? { source: changes.source } : {}),
      ...(Number.isInteger(changes.turn) ? { turn: changes.turn } : {}),
      ...(isPlainObject(changes.totals) ? { totals: changes.totals } : {}),
      ...(changes.truncated === true ? { truncated: true } : {}),
      ...(typeof changes.note === 'string' ? { note: changes.note } : {})
    }
    return finish({
      action: args.action,
      dir: dirToken,
      displayDir: await displayOf(batchDir),
      project: projectInfo.project,
      batchId,
      git: gitSummary(projectInfo.git),
      artifacts: finalArtifacts,
      totals: totalsOf({
        files: (collect.files ?? []).length,
        readBytes: (collect.readBytes ?? 0) + copy.readBytes,
        artifacts: finalArtifacts.length,
        artifactBytes,
        redactions: ledger.count(),
        warnings: allWarnings.length
      }),
      redactions: ledger.list(),
      warnings: allWarnings,
      changes: changesSummary,
      ...(lineage !== undefined ? { lineage } : {}),
      next:
        args.action === 'create'
          ? [`read ${dirToken}/HANDOFF.md`, `handoff_pack action=verify batchId=${batchId}`]
          : [
              `read ${dirToken}/HANDOFF.md (lineage sequence ${lineage.sequence}, previous ${lineage.previous})`,
              `handoff_load batchId=${batchId}`,
              `handoff_pack action=verify batchId=${batchId}`
            ],
      limits: publicLimits()
    })
  }

  /** Build `evidence/migration.json` for a v1 -> v2 migration. */
  function buildMigrationEvidence(provenance) {
    return {
      path: `${EVIDENCE_DIR}/migration.json`,
      content: jsonText({ schemaVersion: SCHEMA_VERSION, migration: provenance })
    }
  }

  /**
   * Migration (P3/M2): read-only schemaVersion 1 source batch -> NEW
   * schemaVersion 2 batch in the same project directory.
   *
   * The source batch is never written: its manifest is parsed but not re-saved,
   * and every write goes under the new batch directory. Provenance (source id,
   * source SHA256SUMS digest, timestamps, tool identity) is recorded in
   * `evidence/migration.json`, which is itself listed in manifest.artifacts and
   * SHA256SUMS. v2-only evidence blocks are marked `available:false` instead of
   * being invented; the source block is verified clean before migrating.
   */
  async function runMigrate(args, exec) {
    const context = await resolveContext(exec)
    const io = ioFor(exec?.signal)
    const root = handoffRootFor(args.target, context)
    const projectInfo = await resolveProject(context, io)
    const located = await locateBatch({
      args: { batchId: args.batchId },
      root,
      projectKeyName: projectInfo.project.key,
      io
    })

    // A package that cannot be verified must not be migrated: the migration
    // would launder an untrusted batch into a "new" one.
    const sourceVerification = await runVerify(
      { action: 'verify', batchId: located.batchId, target: args.target },
      exec
    )
    if (sourceVerification.verification.counts.errors > 0) {
      const codes = [
        ...new Set(
          sourceVerification.verification.findings
            .filter((finding) => finding.severity === 'error')
            .map((finding) => finding.code)
        )
      ].join(', ')
      throw handoffError(
        ERROR.MIGRATION_SOURCE_INVALID,
        `source batch ${located.batchId} failed verification (${sourceVerification.verification.counts.errors} error findings: ${codes}); fix or regenerate it before migrating`
      )
    }

    const source = parseManifest(await io.readText(join(located.dir, MANIFEST_FILE)))
    if (source.schemaVersion !== SCHEMA_VERSION) {
      throw handoffError(
        ERROR.MIGRATION_UNSUPPORTED_VERSION,
        `source batch ${located.batchId} is schemaVersion ${String(source.schemaVersion)}; migrate upgrades schemaVersion 1 to 2 only`
      )
    }
    const sourceSumsText = await io.readText(join(located.dir, SUMS_FILE))
    const migratedAt = now().toISOString()
    const batchId = makeBatchId({ date: new Date(migratedAt), suffix: randomSuffix() })
    const batchDir = join(root, projectInfo.project.key, batchId)
    await assertBatchCreatable({ fs: ctx.fs, rootDir: batchDir, force: false })

    const provenance = {
      fromBatchId: located.batchId,
      fromSchemaVersion: source.schemaVersion,
      sourceSha256Sums: sha256Hex(sourceSumsText),
      sourceGenerator: isPlainObject(source.generator) ? source.generator : null,
      migratedAt,
      tool: generatorIdentity({ dshVersion, platform })
    }
    const warnings = mergeWarnings([
      ...(Array.isArray(source.warnings) ? source.warnings : []),
      {
        code: 'MIGRATED_FROM_V1',
        detail:
          `migrated from ${located.batchId} (schemaVersion 1); host workspaceChanges/goal/jobs ` +
          'evidence of the original session is unavailable and marked available:false'
      }
    ])
    const manifest = createManifest({
      batchId,
      createdAt: migratedAt,
      target: args.target,
      schemaVersion: SCHEMA_VERSION_V2,
      generator: generatorIdentity({ dshVersion, platform }),
      project: source.project,
      session: source.session,
      sandbox: source.sandbox,
      inputs: source.inputs,
      git: source.git,
      files: source.files,
      sessionTrace: source.sessionTrace,
      redactions: source.redactions,
      warnings,
      limits: publicLimits(),
      scan: source.scan,
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

    const ledger = createRedactionLedger()
    const handoff = redactText(renderHandoff(manifest))
    ledger.add(HANDOFF_FILE, handoff.hits)
    const evidenceTexts = buildEvidenceTexts(manifest).map((entry) => {
      const redacted = redactText(entry.content)
      ledger.add(entry.path, redacted.hits)
      return { path: entry.path, content: redacted.text }
    })
    const migrationEvidence = buildMigrationEvidence(provenance)
    const redactedMigration = redactText(migrationEvidence.content)
    ledger.add(migrationEvidence.path, redactedMigration.hits)

    const covered = orderEntries([
      { path: HANDOFF_FILE, content: handoff.text },
      ...evidenceTexts,
      { path: migrationEvidence.path, content: redactedMigration.text }
    ])
    const coveredArtifacts = covered.map((entry) => artifactEntry(entry.path, entry.content))
    const sumsText = buildSha256Sums(coveredArtifacts)
    const finalArtifacts = sortArtifacts([...coveredArtifacts, artifactEntry(SUMS_FILE, sumsText)])
    const finalManifest = setArtifacts(manifest, finalArtifacts)
    const manifestText = serializeManifest(finalManifest)
    const entries = orderEntries([
      ...covered,
      { path: SUMS_FILE, content: sumsText },
      { path: MANIFEST_FILE, content: manifestText }
    ])
    guardFinalSecrets([
      [HANDOFF_FILE, handoff.text],
      ...evidenceTexts.map((entry) => [entry.path, entry.content]),
      [migrationEvidence.path, redactedMigration.text],
      [SUMS_FILE, sumsText],
      [MANIFEST_FILE, manifestText]
    ])
    await writeBatch({
      fs: ctx.fs,
      policy: context.policy,
      rootDir: batchDir,
      entries,
      signal: exec?.signal,
      force: false
    })

    const artifactBytes = finalArtifacts.reduce(
      (sum, artifact) => sum + (Number.isFinite(artifact.bytes) ? artifact.bytes : 0),
      0
    )
    const dirToken = tokenizePath(batchDir, context.contexts)
    return finish({
      action: 'migrate',
      dir: dirToken,
      displayDir: await displayOf(batchDir),
      project: projectInfo.project,
      batchId,
      git: gitSummary(source.git),
      artifacts: finalArtifacts,
      totals: totalsOf({
        files: (source.files ?? []).length,
        artifacts: finalArtifacts.length,
        artifactBytes,
        redactions: ledger.count(),
        warnings: warnings.length
      }),
      redactions: ledger.list(),
      warnings,
      migration: {
        fromBatchId: provenance.fromBatchId,
        fromSchemaVersion: provenance.fromSchemaVersion,
        sourceSha256Sums: provenance.sourceSha256Sums,
        migratedAt: provenance.migratedAt
      },
      next: [
        'read the new HANDOFF.md and compare it with the source batch if needed',
        `handoff_pack action=verify batchId=${batchId}`,
        `handoff_load batchId=${batchId}`
      ],
      limits: publicLimits()
    })
  }

  function sortFindings(findings) {
    const severityRank = (finding) => (finding.severity === 'error' ? 0 : 1)
    return [...findings].sort((left, right) => {
      const rank = severityRank(left) - severityRank(right)
      if (rank !== 0) return rank
      if (left.code !== right.code) return left.code < right.code ? -1 : 1
      const leftPath = left.path ?? ''
      const rightPath = right.path ?? ''
      return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0
    })
  }

  /**
   * Read-only search for one explicit batch id under sibling project keys.
   *
   * A project key derives from the git remote when one exists, so adding or
   * changing a remote silently moves the current key and made previously
   * generated batches unreachable. The search never writes and never leaves
   * the configured handoff root; callers decide whether a unique hit is
   * acceptable (the UI and `verify`/`load` opt in, writes never do).
   *
   * @param {{root: string, projectKeyName: string, batchId: string, io: object}} input
   * @returns {Promise<{projectKey: string, projectDir: string, dir: string}[]>}
   */
  async function findSiblingBatchDirs({ root, projectKeyName, batchId, io }) {
    let entries = []
    try {
      entries = await io.listDir(root)
    } catch {
      return []
    }
    const projectKeys = entries
      .filter(
        (entry) =>
          entry !== null &&
          typeof entry === 'object' &&
          entry.type === 'directory' &&
          typeof entry.name === 'string' &&
          entry.name !== '' &&
          entry.name !== projectKeyName &&
          !entry.name.startsWith('.') &&
          // Only the same workspace slug can be this project under an older
          // seed; unrelated projects sharing the handoff root are ignored.
          projectKeySlug(entry.name) === projectKeySlug(projectKeyName)
      )
      .map((entry) => entry.name)
      .sort()
    const matches = []
    for (const projectKey of projectKeys) {
      const projectDir = join(root, projectKey)
      const dir = join(projectDir, batchId)
      let info
      try {
        info = await io.lstat(dir)
      } catch {
        continue
      }
      if (info !== undefined) matches.push({ projectKey, projectDir, dir })
    }
    return matches
  }

  /**
   * Locate a batch under the current project key.
   *
   * With `allowProjectFallback` an explicit batch id that is absent under the
   * current key is searched read-only across sibling project keys under the
   * same root: a unique hit is returned with a `fallback` descriptor (the
   * caller surfaces `PROJECT_KEY_FALLBACK`); zero or several hits keep the
   * original `BATCH_NOT_FOUND` error semantics. The implicit "newest batch"
   * path never falls back.
   */
  async function locateBatch({ args, root, projectKeyName, io, allowProjectFallback = false }) {
    const projectDir = join(root, projectKeyName)
    if (args.batchId !== undefined) {
      const dir = join(projectDir, args.batchId)
      const info = await io.lstat(dir)
      if (info !== undefined) {
        return { batchId: args.batchId, dir, projectDir }
      }
      if (allowProjectFallback === true) {
        const matches = await findSiblingBatchDirs({ root, projectKeyName, batchId: args.batchId, io })
        if (matches.length === 1) {
          const [match] = matches
          return {
            batchId: args.batchId,
            dir: match.dir,
            projectDir: match.projectDir,
            fallback: { projectKey: match.projectKey }
          }
        }
        if (matches.length > 1) {
          throw handoffError(
            ERROR.BATCH_NOT_FOUND,
            `batch ${args.batchId} is not under project ${projectKeyName} and exists under ` +
              `${matches.length} sibling project keys (${matches.map((match) => match.projectKey).join(', ')}); ` +
              'pass an explicit batch path/root instead'
          )
        }
      }
      throw handoffError(
        ERROR.BATCH_NOT_FOUND,
        `batch ${args.batchId} not found under ${projectDir}; run handoff_pack action=list`
      )
    }
    let entries = []
    try {
      entries = await io.listDir(projectDir)
    } catch (error) {
      throw handoffError(
        ERROR.BATCH_NOT_FOUND,
        `no batches found for project ${projectKeyName} under ${projectDir} (${errorMessageOf(error)})`
      )
    }
    const batchIds = entries
      .map((entry) => entry.name)
      .filter((name) => isBatchId(name))
      .sort((left, right) => compareBatchIds(right, left))
    if (batchIds.length === 0) {
      throw handoffError(
        ERROR.BATCH_NOT_FOUND,
        `no batches found for project ${projectKeyName} under ${projectDir}; run handoff_pack action=create`
      )
    }
    return { batchId: batchIds[0], dir: join(projectDir, batchIds[0]), projectDir }
  }

  /** Deterministic `PROJECT_KEY_FALLBACK` warning shared by load and verify. */
  function projectFallbackWarning({ batchId, projectKeyName, fallback, dirToken }) {
    return {
      code: 'PROJECT_KEY_FALLBACK',
      detail:
        `batch ${batchId} is not under the current project key ${projectKeyName}; ` +
        `loaded read-only from historical project key ${fallback.projectKey} (${dirToken})`
    }
  }

  /** Hash every artifact recorded in the manifest and reconcile SHA256SUMS. */
  async function checkArtifacts({ manifest, batchDir, io, findings }) {
    const artifactDigests = new Map()
    for (const artifact of manifest.artifacts ?? []) {
      if (artifact === null || typeof artifact !== 'object') continue
      let relative
      try {
        relative = normalizeArtifactPath(String(artifact.path ?? ''), 'artifact path')
      } catch (error) {
        findings.push({ severity: 'error', code: 'PATH_ESCAPE', path: String(artifact.path ?? ''), detail: error.message })
        continue
      }
      let absolute
      try {
        absolute = resolveArtifact(batchDir, relative)
      } catch (error) {
        findings.push({ severity: 'error', code: 'PATH_ESCAPE', path: relative, detail: error.message })
        continue
      }
      let info
      try {
        info = await io.lstat(absolute)
      } catch (error) {
        findings.push({ severity: 'error', code: 'ARTIFACT_MISSING', path: relative, detail: errorMessageOf(error) })
        continue
      }
      if (info === undefined) {
        findings.push({ severity: 'error', code: 'ARTIFACT_MISSING', path: relative })
        continue
      }
      if (info.type === 'symlink') {
        findings.push({ severity: 'error', code: 'SYMLINK_ESCAPE', path: relative, detail: 'artifact is a symlink' })
        continue
      }
      let bytes
      try {
        bytes = await io.readBytes(absolute, MAX_VERIFY_ARTIFACT_BYTES)
      } catch (error) {
        findings.push({ severity: 'error', code: 'ARTIFACT_MISSING', path: relative, detail: errorMessageOf(error) })
        continue
      }
      const digest = sha256Hex(bytes)
      artifactDigests.set(relative, digest)
      if (typeof artifact.sha256 === 'string' && artifact.sha256 !== digest) {
        findings.push({
          severity: 'error',
          code: 'ARTIFACT_HASH_MISMATCH',
          path: relative,
          detail: `manifest ${shortHash(artifact.sha256, 12)}… actual ${shortHash(digest, 12)}…`
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
      if (
        (relative.endsWith('.json') || relative.endsWith('.md') || relative.endsWith('.txt') || relative === SUMS_FILE) &&
        bytes.length <= 1024 * 1024
      ) {
        const residue = scanSecrets(bytes.toString('utf8'))
        for (const hit of residue)
          findings.push({
            severity: 'error',
            code: 'SECRET_RESIDUE',
            path: relative,
            detail: `${hit.kind} x${hit.count}`
          })
      }
    }

    let sums = null
    try {
      const sumsText = await io.readText(join(batchDir, SUMS_FILE))
      sums = parseSha256Sums(sumsText)
    } catch (error) {
      findings.push({ severity: 'error', code: 'ARTIFACT_MISSING', path: SUMS_FILE, detail: errorMessageOf(error) })
    }
    if (sums !== null) {
      const listed = new Map(sums.map((entry) => [entry.path, entry.sha256]))
      for (const [path, digest] of artifactDigests) {
        // SHA256SUMS does not hash itself; its own presence is proven by the manifest.
        if (path === SUMS_FILE) continue
        const claimed = listed.get(path)
        if (claimed === undefined) {
          findings.push({ severity: 'error', code: 'SHA256SUMS_MISMATCH', path, detail: 'artifact missing from SHA256SUMS' })
        } else if (claimed !== digest) {
          findings.push({
            severity: 'error',
            code: 'SHA256SUMS_MISMATCH',
            path,
            detail: `SHA256SUMS ${shortHash(claimed, 12)}… actual ${shortHash(digest, 12)}…`
          })
        }
      }
      for (const path of listed.keys()) {
        if (!artifactDigests.has(path))
          findings.push({ severity: 'error', code: 'SHA256SUMS_MISMATCH', path, detail: 'SHA256SUMS lists a file missing from manifest.artifacts' })
        if (path === SUMS_FILE)
          findings.push({ severity: 'error', code: 'SHA256SUMS_MISMATCH', path, detail: 'SHA256SUMS must not hash itself' })
        if (path === MANIFEST_FILE)
          findings.push({ severity: 'error', code: 'SHA256SUMS_MISMATCH', path, detail: 'manifest.json must not be listed in SHA256SUMS' })
      }
      if (!listed.has(HANDOFF_FILE))
        findings.push({ severity: 'error', code: 'SHA256SUMS_MISMATCH', path: HANDOFF_FILE, detail: 'HANDOFF.md missing from SHA256SUMS' })
    }
    return artifactDigests.size
  }

  /** Re-hash recorded source files and compare the current git HEAD. */
  async function checkDrift({ manifest, context, io, findings, artifactsChecked }) {
    const drift = {
      gitHeadChanged: false,
      sourceFilesChanged: 0,
      sourceFilesMissing: 0,
      artifactsChecked
    }
    const recordedHead = typeof manifest.git?.head === 'string' ? manifest.git.head : null
    const current = await readGitInfo({ io, workspaceRoot: context.workspaceRoot })
    const currentHead = typeof current?.git?.head === 'string' ? current.git.head : null
    if (recordedHead !== null && currentHead !== null && recordedHead !== currentHead) {
      drift.gitHeadChanged = true
      findings.push({
        severity: 'warn',
        code: 'GIT_HEAD_CHANGED',
        detail: `manifest HEAD ${shortHash(recordedHead, 12)}…, current HEAD ${shortHash(currentHead, 12)}…`
      })
    }
    for (const file of manifest.files ?? []) {
      if (file === null || typeof file !== 'object' || typeof file.path !== 'string') continue
      // Only entries that were actually hashed can be re-checked; skipped or
      // unhashed entries carry an empty sha256 and must not be reported as drift.
      if (
        typeof file.sha256 !== 'string' ||
        !/^[0-9a-f]{64}$/.test(file.sha256) ||
        typeof file.skippedReason === 'string'
      )
        continue
      let absolute
      try {
        absolute = resolveInside(context.workspaceRoot, file.path, { platform })
      } catch (error) {
        findings.push({ severity: 'error', code: 'PATH_ESCAPE', path: file.path, detail: error.message })
        continue
      }
      let info
      try {
        info = await io.lstat(absolute)
      } catch {
        info = undefined
      }
      if (info === undefined) {
        drift.sourceFilesMissing += 1
        findings.push({ severity: 'warn', code: 'SOURCE_FILE_MISSING', path: file.path })
        continue
      }
      if (info.type === 'symlink') {
        findings.push({ severity: 'error', code: 'SYMLINK_ESCAPE', path: file.path, detail: 'recorded source file is now a symlink' })
        continue
      }
      try {
        const bytes = await io.readBytes(absolute, LIMITS.maxHashBytes)
        if (sha256Hex(bytes) !== file.sha256) {
          drift.sourceFilesChanged += 1
          findings.push({ severity: 'warn', code: 'SOURCE_FILE_CHANGED', path: file.path, detail: `recorded sha256 ${shortHash(file.sha256, 12)}…` })
        }
      } catch (error) {
        if (error?.code === 'FS_TOO_LARGE') continue
        findings.push({ severity: 'warn', code: 'SOURCE_FILE_UNREADABLE', path: file.path, detail: errorMessageOf(error) })
      }
    }
    return drift
  }

  async function runVerify(args, exec) {
    const context = await resolveContext(exec)
    const io = ioFor(exec?.signal)
    const root = handoffRootFor(args.target, context)
    const projectInfo = await resolveProject(context, io)
    const located = await locateBatch({
      args,
      root,
      projectKeyName: projectInfo.project.key,
      io,
      // Explicit verify ids may live under a historical project key (the key
      // is remote-seeded); the fallback is read-only and reported as a warning.
      allowProjectFallback: args.batchId !== undefined
    })
    const findings = []
    let manifest = null
    try {
      const text = await io.readText(join(located.dir, MANIFEST_FILE))
      manifest = parseManifest(text)
    } catch (error) {
      const code = error?.code === ERROR.MANIFEST_INVALID ? 'MANIFEST_INVALID' : 'MANIFEST_MISSING'
      findings.push({
        severity: 'error',
        code,
        path: MANIFEST_FILE,
        detail: errorMessageOf(error)
      })
    }
    let artifactsChecked = 0
    let drift = { gitHeadChanged: false, sourceFilesChanged: 0, sourceFilesMissing: 0, artifactsChecked: 0 }
    if (manifest !== null) {
      const validation = validateManifest(manifest)
      for (const finding of validation.findings ?? []) {
        findings.push({
          severity: finding.severity === 'warn' ? 'warn' : 'error',
          code: finding.code ?? 'MANIFEST_INVALID',
          ...(typeof finding.path === 'string' && finding.path !== '' ? { path: finding.path } : {}),
          ...(typeof finding.detail === 'string' ? { detail: finding.detail } : {})
        })
      }
      artifactsChecked = await checkArtifacts({ manifest, batchDir: located.dir, io, findings })
      await checkLineage({ manifest, located, io, findings })
      drift = await checkDrift({ manifest, context, io, findings, artifactsChecked })
    }
    const sorted = sortFindings(findings)
    const errors = sorted.filter((finding) => finding.severity === 'error').length
    const warnings = sorted.filter((finding) => finding.severity === 'warn').length
    const checkedAt = now().toISOString()
    const dirToken = tokenizePath(located.dir, context.contexts)
    const fallbackWarnings =
      located.fallback === undefined
        ? []
        : [
            projectFallbackWarning({
              batchId: located.batchId,
              projectKeyName: projectInfo.project.key,
              fallback: located.fallback,
              dirToken
            })
          ]
    const verification = {
      ok: errors === 0,
      batchId: located.batchId,
      dir: dirToken,
      checkedAt,
      findings: sorted,
      drift,
      counts: { errors, warnings }
    }
    const project = isPlainObject(manifest?.project) ? manifest.project : projectInfo.project
    return finish({
      action: 'verify',
      dir: dirToken,
      displayDir: await displayOf(located.dir),
      project,
      batchId: located.batchId,
      git: gitSummary(projectInfo.git),
      totals: totalsOf({
        files: Array.isArray(manifest?.files) ? manifest.files.length : 0,
        artifacts: Array.isArray(manifest?.artifacts) ? manifest.artifacts.length : 0,
        artifactBytes: Array.isArray(manifest?.artifacts)
          ? manifest.artifacts.reduce((sum, artifact) => sum + (Number.isFinite(artifact?.bytes) ? artifact.bytes : 0), 0)
          : 0,
        warnings
      }),
      warnings: fallbackWarnings,
      verification,
      next:
        errors === 0
          ? [`read ${dirToken}/HANDOFF.md`, 're-hash a few H4 assertions before trusting them']
          : ['review verification.findings (errors first)', 'regenerate with handoff_pack action=create force=true if the package is stale'],
      limits: publicLimits()
    })
  }

  async function runList(args, exec) {
    const context = await resolveContext(exec)
    const io = ioFor(exec?.signal)
    const root = handoffRootFor(args.target, context)
    const projectInfo = await resolveProject(context, io)
    const projectKeys = []
    if (args.all === true) {
      let entries = []
      try {
        entries = await io.listDir(root)
      } catch {
        entries = []
      }
      projectKeys.push(
        ...entries
          .filter((entry) => entry.type === 'directory')
          .map((entry) => entry.name)
          .sort()
      )
    } else {
      projectKeys.push(projectInfo.project.key)
    }
    const batches = []
    for (const key of projectKeys) {
      const projectDir = join(root, key)
      let entries = []
      try {
        entries = await io.listDir(projectDir)
      } catch {
        continue
      }
      const batchIds = entries
        .map((entry) => entry.name)
        .filter((name) => isBatchId(name))
        .sort((left, right) => compareBatchIds(right, left))
      for (const batchId of batchIds) {
        const dir = join(projectDir, batchId)
        let manifest = null
        try {
          manifest = parseManifest(await io.readText(join(dir, MANIFEST_FILE)))
        } catch {
          manifest = null
        }
        const artifacts = Array.isArray(manifest?.artifacts) ? manifest.artifacts : []
        batches.push({
          batchId,
          dir: tokenizePath(dir, context.contexts),
          createdAt:
            typeof manifest?.createdAt === 'string'
              ? manifest.createdAt
              : (batchTimestampToIso(batchId) ?? null),
          title: typeof manifest?.inputs?.title === 'string' ? manifest.inputs.title : null,
          gitHead: typeof manifest?.git?.head === 'string' ? manifest.git.head : null,
          complete: manifest !== null,
          artifacts: artifacts.length,
          bytes: artifacts.reduce(
            (sum, artifact) => sum + (Number.isFinite(artifact?.bytes) ? artifact.bytes : 0),
            0
          )
        })
      }
    }
    batches.sort((left, right) => compareBatchIds(right.batchId, left.batchId))
    const dirToken = tokenizePath(join(root, projectInfo.project.key), context.contexts)
    return finish({
      action: 'list',
      dir: args.all === true ? tokenizePath(root, context.contexts) : dirToken,
      project: projectInfo.project,
      batches,
      totals: totalsOf({
        artifacts: batches.reduce((sum, batch) => sum + batch.artifacts, 0),
        artifactBytes: batches.reduce((sum, batch) => sum + batch.bytes, 0)
      }),
      warnings: [],
      next:
        batches.length === 0
          ? ['no batches yet; run handoff_pack action=create']
          : [`handoff_pack action=verify batchId=${batches[0].batchId}`],
      limits: publicLimits()
    })
  }

  /** Read a batch file with a byte cap; missing/oversized files degrade to flags. */
  async function readTextBounded(io, absolutePath, maxBytes) {
    let info
    try {
      info = await io.lstat(absolutePath)
    } catch {
      return { missing: true }
    }
    if (info === undefined || info.type !== 'file') return { missing: true }
    const size = Number.isFinite(info.size) ? info.size : maxBytes
    try {
      const bytes = await io.readBytes(absolutePath, Math.max(1, Math.min(size, maxBytes)))
      return { text: Buffer.from(bytes).toString('utf8'), truncated: size > maxBytes }
    } catch {
      return { missing: true }
    }
  }

  /** Split a HANDOFF.md into bounded H0-H9 + 覆盖说明 excerpts. */
  function extractHandoffSections(text) {
    const lines = String(text).split('\n')
    const sections = []
    let current
    for (const line of lines) {
      const match = /^## (H[0-9]|覆盖说明)\b/.exec(line.trimEnd())
      if (match !== null) {
        if (current !== undefined) sections.push(current)
        current = { id: match[1], heading: line.trim(), lines: [] }
        continue
      }
      if (current !== undefined) current.lines.push(line)
    }
    if (current !== undefined) sections.push(current)
    let budget = LOAD_LIMITS.sectionsMaxChars
    const out = []
    for (const section of sections) {
      if (budget <= 0) break
      let body = section.lines.join('\n').trim()
      const cap = Math.min(LOAD_LIMITS.sectionTextMaxChars, budget)
      let truncated = false
      if (body.length > cap) {
        body = body.slice(0, cap)
        truncated = true
      }
      out.push({
        id: section.id,
        heading: section.heading,
        text: body,
        ...(truncated ? { truncated: true } : {})
      })
      budget -= body.length
    }
    return out
  }

  /** Result envelope for `handoff_load` (different required keys than handoff_pack). */
  function finishLoad(parts) {
    const value = { ok: true }
    for (const key of [
      'batchId',
      'dir',
      'displayDir',
      'trust',
      'verification',
      'handoff',
      'manifest',
      'pointers',
      'next',
      'warnings'
    ]) {
      if (parts[key] !== undefined) value[key] = parts[key]
    }
    return value
  }

  /**
   * Read-only consumption: verify a batch, report a trust verdict and return
   * pointers (plus bounded HANDOFF excerpts when requested). Never writes.
   */
  async function runLoad(args, exec) {
    const context = await resolveContext(exec)
    const io = ioFor(exec?.signal)
    const root = handoffRootFor(args.target, context)
    const projectInfo = await resolveProject(context, io)
    const warnings = []
    let located
    try {
      located = await locateBatch({
        args,
        root,
        projectKeyName: projectInfo.project.key,
        io,
        // Explicit load ids may live under a historical project key (the key is
        // remote-seeded). Loading stays read-only; the caller gets a warning.
        allowProjectFallback: true
      })
    } catch (error) {
      throw handoffError(ERROR.RESUME_NOT_FOUND, `${errorMessageOf(error)}; run handoff_pack action=list`)
    }
    const dirToken = tokenizePath(located.dir, context.contexts)
    const displayDir = await displayOf(located.dir)
    if (located.fallback !== undefined) {
      warnings.push(
        projectFallbackWarning({
          batchId: located.batchId,
          projectKeyName: projectInfo.project.key,
          fallback: located.fallback,
          dirToken
        })
      )
    }
    let verification
    if (args.verifyFirst !== false) {
      const verifyResult = await runVerify(
        { action: 'verify', batchId: located.batchId, target: args.target },
        exec
      )
      verification = verifyResult.verification
    } else {
      warnings.push({
        code: 'VERIFY_SKIPPED',
        detail: 'verifyFirst=false: hashes and drift were not checked, so trust cannot exceed stale'
      })
    }

    let manifest = null
    const manifestRead = await readTextBounded(io, join(located.dir, MANIFEST_FILE), 2 * 1024 * 1024)
    let manifestSummary = { path: `${dirToken}/${MANIFEST_FILE}` }
    if (manifestRead.missing) {
      warnings.push({ code: 'MANIFEST_MISSING', detail: 'manifest.json could not be read' })
    } else {
      try {
        manifest = parseManifest(manifestRead.text)
      } catch (error) {
        warnings.push({ code: 'MANIFEST_INVALID', detail: errorMessageOf(error) })
      }
      if (manifest !== null) {
        manifestSummary = {
          path: `${dirToken}/${MANIFEST_FILE}`,
          ...(typeof manifest.batchId === 'string' ? { batchId: manifest.batchId } : {}),
          ...(typeof manifest.createdAt === 'string' ? { createdAt: manifest.createdAt } : {}),
          gitHead: typeof manifest.git?.head === 'string' ? manifest.git.head : null,
          title: typeof manifest.inputs?.title === 'string' ? manifest.inputs.title : null
        }
      }
    }

    const handoffToken = `${dirToken}/${HANDOFF_FILE}`
    const handoff = { path: handoffToken }
    const handoffRead = await readTextBounded(io, join(located.dir, HANDOFF_FILE), LOAD_LIMITS.maxHandoffBytes)
    if (handoffRead.missing) {
      warnings.push({ code: 'HANDOFF_MISSING', detail: 'HANDOFF.md could not be read' })
    } else {
      const text = handoffRead.text
      if (args.include === 'full') {
        const maxChars = LOAD_LIMITS.fullMaxBytes
        handoff.excerpt = text.length > maxChars ? text.slice(0, maxChars) : text
        if (text.length > maxChars || handoffRead.truncated === true) handoff.truncated = true
      } else if (args.include === 'sections') {
        handoff.sections = extractHandoffSections(text)
      }
    }

    let trust = 'stale'
    if (args.verifyFirst === false) {
      trust = 'stale'
    } else if (verification === undefined) {
      trust = 'invalid'
    } else if (verification.counts.errors > 0) {
      trust = 'invalid'
    } else if (
      verification.counts.warnings > 0 ||
      verification.drift.gitHeadChanged === true ||
      verification.drift.sourceFilesChanged > 0 ||
      verification.drift.sourceFilesMissing > 0
    ) {
      trust = 'stale'
    } else {
      trust = 'verified'
    }
    if (manifest === null && trust === 'verified') trust = 'stale'

    const pointers = [
      { label: 'HANDOFF.md', path: handoffToken },
      { label: 'manifest.json', path: `${dirToken}/${MANIFEST_FILE}` },
      { label: 'SHA256SUMS', path: `${dirToken}/${SUMS_FILE}` },
      { label: 'session evidence', path: `${dirToken}/${EVIDENCE_DIR}/session.json` }
    ]
    const next =
      trust === 'verified'
        ? [
            `read ${handoffToken} in order H2 → H3 → H4 → H8`,
            're-hash at least 3 H4 assertions before relying on them',
            'then continue the previous work; do not re-derive it from memory'
          ]
        : trust === 'stale'
          ? [
              `run handoff_pack action=verify batchId=${located.batchId} to inspect all drift findings`,
              `read ${handoffToken} H6 (risks) and H8 (first actions) before trusting any claim`,
              `if the package is superseded, load the newest batch instead`
            ]
          : [
              `stop: batch ${located.batchId} failed verification (see verification.findings)`,
              'run handoff_pack action=list to pick another batch',
              'regenerate with handoff_pack action=create force=true only if the package is known-stale'
            ]
    return finishLoad({
      batchId: located.batchId,
      dir: dirToken,
      displayDir,
      trust,
      ...(verification !== undefined ? { verification } : {}),
      handoff,
      manifest: manifestSummary,
      pointers,
      next,
      warnings: mergeWarnings(warnings)
    })
  }

  function finish(parts) {
    const value = {}
    for (const key of RESULT_KEY_ORDER) {
      if (key === 'ok') {
        value.ok = true
        continue
      }
      if (parts[key] !== undefined) value[key] = parts[key]
    }
    return value
  }

  async function run(args, exec = {}) {
    switch (args.action) {
      case 'scan':
        return runScan(args, exec)
      case 'create':
      case 'append':
      case 'update':
        return runCreate(args, exec)
      case 'verify':
        return runVerify(args, exec)
      case 'migrate':
        return runMigrate(args, exec)
      case 'list':
        return runList(args, exec)
      default:
        throw handoffError(ERROR.INVALID_ARGS, `unsupported action: ${String(args.action)}`)
    }
  }

  return { run, load: runLoad }
}

/** Internal helpers exposed for service tests (not part of the plugin contract). */
export const _test = {
  sortFindings: (findings) =>
    [...findings].sort((left, right) => {
      const rank = (finding) => (finding.severity === 'error' ? 0 : 1)
      const delta = rank(left) - rank(right)
      if (delta !== 0) return delta
      if (left.code !== right.code) return left.code < right.code ? -1 : 1
      const leftPath = left.path ?? ''
      const rightPath = right.path ?? ''
      return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0
    }),
  toPosix
}
