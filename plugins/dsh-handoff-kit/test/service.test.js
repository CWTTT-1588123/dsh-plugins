import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ERROR, TOOL_OUTPUT_SCHEMA, validateToolArgs } from '../src/contracts.js'
import { parseManifest, parseSha256Sums, serializeManifest } from '../src/manifest.js'
import { sha256Hex } from '../src/paths.js'
import { createService } from '../src/service.js'
import { createFakeCtx } from './helpers/fake-ctx.js'
import {
  FIXED_BATCH_ID,
  FIXED_NOW,
  GIT_HEAD,
  WORKSPACE_ROOT,
  addGitFixture,
  createFixtureFs,
  fixedClock,
  fixedRandom,
  sampleSessionEvents,
  sampleWorkspaceFiles,
  toolCallEvent,
  toolResultEvent
} from './helpers/fixtures.js'
import { validateSubset } from './helpers/schema-subset.js'

const DSH_HOME_TEST = 'C:\\Users\\test\\.dsh'

function makeHarness({ mode = 'danger-full-access', files, events, session = true } = {}) {
  const fs = createFixtureFs(files === undefined ? {} : { files })
  addGitFixture(fs)
  const ctx = createFakeCtx({
    fs,
    mode,
    dshHome: DSH_HOME_TEST,
    session: session === false ? null : { id: 'session-test-1', cwd: WORKSPACE_ROOT, events: events ?? [] }
  })
  const service = createService({
    ctx,
    env: { DSH_HOME: DSH_HOME_TEST },
    now: fixedClock,
    randomSuffix: fixedRandom,
    dshVersion: '0.2.1-rc.2',
    platform: 'win32'
  })
  const exec = {
    agent: session === false ? undefined : { id: 'session-test-1' },
    signal: new AbortController().signal
  }
  return { fs, ctx, service, exec }
}

async function run(harness, raw) {
  const result = await harness.service.run(validateToolArgs(raw), harness.exec)
  assert.deepEqual(validateSubset(TOOL_OUTPUT_SCHEMA, result), [], `result violates output schema: ${JSON.stringify(result).slice(0, 300)}`)
  return result
}

test('scan collects evidence, previews HANDOFF.md and performs zero writes', async () => {
  const harness = makeHarness({ events: sampleSessionEvents() })
  const before = harness.fs.snapshot()
  const result = await run(harness, { action: 'scan' })
  assert.equal(result.action, 'scan')
  assert.equal(result.batchId, FIXED_BATCH_ID)
  assert.match(result.dir, new RegExp(`^\\$DSH_HOME/handoff/ws-[0-9a-f]{8}/${FIXED_BATCH_ID}$`))
  assert.match(result.project.key, /^ws-[0-9a-f]{8}$/)
  assert.equal(result.scan.entries > 1, true)
  assert.equal(result.scan.files.length > 0, true)
  assert.equal(result.preview.text.includes('H0'), true)
  assert.equal(result.preview.truncated, false)
  assert.equal(result.warnings.some((warning) => warning.code === 'NO_MTIME_API'), true)
  assert.equal(result.warnings.some((warning) => warning.code === 'NO_GIT_STATUS'), true)
  assert.equal(harness.fs.writeCount(), 0)
  assert.deepEqual(harness.fs.snapshot(), before)
})

test('scan records the session tool/call trace from ownEvents only', async () => {
  const harness = makeHarness({ events: sampleSessionEvents() })
  const result = await run(harness, { action: 'scan' })
  assert.equal(result.scan.files.length > 0, true)
  const manifest = await buildAndReadManifest(harness, { action: 'create', summary: 'did things' })
  assert.equal(manifest.sessionTrace.eventCounts.total, 9)
  assert.equal(manifest.sessionTrace.toolCalls.total, 7)
  assert.equal(manifest.sessionTrace.eventCounts.toolErrors, 1)
  assert.equal(manifest.sessionTrace.touchedFiles.length > 0, true)
  const touched = manifest.sessionTrace.touchedFiles.map((file) => file.path)
  assert.equal(touched.includes('src/index.js'), true)
  assert.equal(touched.includes('docs/design.md'), true)
  assert.equal(touched.every((path) => !path.includes('\\') && !path.includes('C:')), true)
  assert.equal(manifest.sessionTrace.commands[0].tool, 'pwsh')
  assert.equal(manifest.sessionTrace.commands[0].commandRedacted.includes('git status'), true)
})

async function buildAndReadManifest(harness, raw) {
  const result = await run(harness, raw)
  const manifestPath = `${result.displayDir}\\manifest.json`
  const text = harness.fs.readFile(manifestPath)
  assert.notEqual(text, undefined, `manifest missing at ${manifestPath}`)
  return parseManifest(text)
}

test('create writes HANDOFF.md, evidence, SHA256SUMS and manifest last in the default user root', async () => {
  const harness = makeHarness({ events: sampleSessionEvents() })
  const result = await run(harness, {
    action: 'create',
    title: 'P0 handoff',
    goal: 'ship it',
    summary: 'implemented modules',
    decisions: ['no subprocess'],
    nextSteps: ['install'],
    concepts: ['batch-id'],
    flow: ['scan', 'create'],
    risks: ['no mtime'],
    files: ['README.md']
  })
  assert.equal(result.action, 'create')
  assert.equal(result.batchId, FIXED_BATCH_ID)
  assert.match(result.dir, /^\$DSH_HOME\/handoff\/ws-[0-9a-f]{8}\/20261022T023512Z-a1b2$/)
  assert.equal(result.displayDir, `C:\\Users\\test\\.dsh\\handoff\\${result.project.key}\\${FIXED_BATCH_ID}`)

  const written = harness.fs.writePaths().map((path) => path.replace(`${result.displayDir}\\`, '').replace(/\\/g, '/'))
  assert.deepEqual(written, [
    'HANDOFF.md',
    'evidence/files.json',
    'evidence/git.json',
    'evidence/redactions.json',
    'evidence/session.json',
    'SHA256SUMS',
    'manifest.json'
  ])
  assert.equal(written.at(-1), 'manifest.json')
  assert.equal(harness.fs.has(`${result.displayDir}\\HANDOFF.md`), true)
  assert.equal(harness.fs.has(`${result.displayDir}\\manifest.json`), true)

  const handoff = harness.fs.readFile(`${result.displayDir}\\HANDOFF.md`)
  assert.match(handoff, /H0/)
  assert.match(handoff, /H9/)
  assert.match(handoff, /ship it/)
  assert.match(handoff, /implemented modules/)
  assert.match(handoff, /20261022T023512Z-a1b2/)
  assert.match(handoff, /覆盖说明/)
  assert.doesNotMatch(handoff, /C:\\ws/)

  const manifest = parseManifest(harness.fs.readFile(`${result.displayDir}\\manifest.json`))
  assert.equal(manifest.batchId, FIXED_BATCH_ID)
  assert.equal(manifest.project.key, result.project.key)
  assert.equal(manifest.project.workspace, '$WORKSPACE')
  assert.equal(manifest.sandbox.mode, 'danger-full-access')
  assert.equal(manifest.inputs.title, 'P0 handoff')
  assert.equal(manifest.git.head, GIT_HEAD)
  assert.equal(manifest.artifacts.length, result.artifacts.length)
  assert.equal(manifest.files.some((file) => file.path === 'README.md'), true)
  assert.equal(manifest.files.every((file) => file.sha256 === undefined || /^[0-9a-f]{64}$/.test(file.sha256)), true)

  // External-style hash recomputation from the fake filesystem.
  for (const artifact of result.artifacts) {
    const content = harness.fs.readFile(`${result.displayDir}\\${artifact.path.replace(/\//g, '\\')}`)
    assert.notEqual(content, undefined, `missing artifact ${artifact.path}`)
    assert.equal(sha256Hex(content), artifact.sha256, `hash mismatch for ${artifact.path}`)
    assert.equal(Buffer.byteLength(content), artifact.bytes)
  }
  const sums = parseSha256Sums(harness.fs.readFile(`${result.displayDir}\\SHA256SUMS`))
  const sumsMap = new Map(sums.map((entry) => [entry.path, entry.sha256]))
  for (const artifact of result.artifacts) {
    if (artifact.path === 'SHA256SUMS') continue
    assert.equal(sumsMap.get(artifact.path), artifact.sha256, `SHA256SUMS mismatch for ${artifact.path}`)
  }
  assert.equal(result.totals.artifacts, result.artifacts.length)
  assert.equal(result.totals.artifactBytes, result.artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0))
})

test('create is byte-for-byte deterministic under a fixed clock and suffix', async () => {
  const first = makeHarness()
  const second = makeHarness()
  const args = { action: 'create', summary: 'same input', decisions: ['a'] }
  const left = await run(first, args)
  const right = await run(second, args)
  assert.deepEqual(left.artifacts, right.artifacts)
  assert.equal(
    first.fs.readFile(`${left.displayDir}\\HANDOFF.md`),
    second.fs.readFile(`${right.displayDir}\\HANDOFF.md`)
  )
  assert.equal(
    first.fs.readFile(`${left.displayDir}\\manifest.json`),
    second.fs.readFile(`${right.displayDir}\\manifest.json`)
  )
})

test('create refuses read-only and non-full-access user targets before writing', async () => {
  const readOnly = makeHarness({ mode: 'read-only' })
  await assert.rejects(
    () => run(readOnly, { action: 'create' }),
    (error) => error.code === ERROR.READ_ONLY
  )
  assert.equal(readOnly.fs.writeCount(), 0)

  const workspaceWrite = makeHarness({ mode: 'workspace-write' })
  await assert.rejects(
    () => run(workspaceWrite, { action: 'create' }),
    (error) => error.code === ERROR.SANDBOX_DENIED && /danger-full-access/.test(error.message)
  )
  assert.equal(workspaceWrite.fs.writeCount(), 0)
})

test('create with target=workspace works in workspace-write and writes inside the workspace', async () => {
  const harness = makeHarness({ mode: 'workspace-write' })
  const result = await run(harness, { action: 'create', target: 'workspace' })
  assert.match(result.dir, /^\$WORKSPACE\/\.dsh\/handoff\/ws-[0-9a-f]{8}\//)
  assert.equal(harness.fs.has(`C:\\ws\\.dsh\\handoff\\${result.project.key}\\${FIXED_BATCH_ID}\\manifest.json`), true)
  assert.equal(harness.fs.writes.every((write) => write.path.startsWith('C:\\ws\\')), true)
})

test('create refuses to overwrite an existing batch unless force is set', async () => {
  const harness = makeHarness()
  const args = { action: 'create' }
  const first = await run(harness, args)
  await assert.rejects(
    () => run(harness, args),
    (error) => error.code === ERROR.BATCH_EXISTS
  )
  const forced = await run(harness, { action: 'create', force: true })
  assert.equal(forced.batchId, first.batchId)
  const entriesPerBatch = first.artifacts.length + 1 // artifacts + manifest.json
  assert.equal(harness.fs.writeCount(), entriesPerBatch * 2)
})

test('create rejects explicit paths that escape the workspace', async () => {
  const harness = makeHarness()
  for (const files of [['../AGENTS.md'], ['C:\\Windows\\win.ini'], ['a/../../b']]) {
    await assert.rejects(
      () => run(harness, { action: 'create', files }),
      (error) => error.code === ERROR.PATH_ESCAPE
    )
  }
  assert.equal(harness.fs.writeCount(), 0)
})

test('verify reports ok and is stable across two runs on an unchanged batch', async () => {
  const harness = makeHarness()
  const created = await run(harness, { action: 'create', summary: 'x' })
  const first = await run(harness, { action: 'verify', batchId: created.batchId })
  const second = await run(harness, { action: 'verify', batchId: created.batchId })
  assert.equal(first.verification.ok, true)
  assert.equal(first.verification.counts.errors, 0)
  assert.deepEqual(first.verification, second.verification)
  assert.equal(first.verification.drift.artifactsChecked > 0, true)

  const latest = await run(harness, { action: 'verify' })
  assert.equal(latest.batchId, created.batchId)
  assert.equal(latest.verification.ok, true)
})

test('verify detects a tampered artifact, a stale SHA256SUMS and secret residue', async () => {
  const harness = makeHarness()
  const created = await run(harness, { action: 'create' })
  harness.fs.addFile(`${created.displayDir}\\HANDOFF.md`, '# tampered\npassword=hunter2secret\n')
  const result = await run(harness, { action: 'verify', batchId: created.batchId })
  assert.equal(result.verification.ok, false)
  const codes = result.verification.findings.map((finding) => finding.code)
  assert.equal(codes.includes('ARTIFACT_HASH_MISMATCH'), true)
  assert.equal(codes.includes('SHA256SUMS_MISMATCH'), true)
  assert.equal(codes.includes('SECRET_RESIDUE'), true)
})

test('verify reports git and source file drift as warnings', async () => {
  const harness = makeHarness()
  const created = await run(harness, { action: 'create', files: ['src/index.js'] })
  harness.fs.addFile('C:\\ws\\src\\index.js', 'export const changed = 1\n')
  harness.fs.addFile('C:\\ws\\.git\\refs\\heads\\main', `${'b'.repeat(40)}\n`)
  const result = await run(harness, { action: 'verify', batchId: created.batchId })
  assert.equal(result.verification.ok, true)
  const codes = result.verification.findings.map((finding) => finding.code)
  assert.equal(codes.includes('GIT_HEAD_CHANGED'), true)
  assert.equal(codes.includes('SOURCE_FILE_CHANGED'), true)
  assert.equal(result.verification.drift.gitHeadChanged, true)
  assert.equal(result.verification.drift.sourceFilesChanged, 1)
})

test('verify raises BATCH_NOT_FOUND for an unknown batch id', async () => {
  const harness = makeHarness()
  await assert.rejects(
    () => run(harness, { action: 'verify', batchId: '20261022T023512Z-dead' }),
    (error) => error.code === ERROR.BATCH_NOT_FOUND
  )
})

test('list returns batches newest first and can include every project', async () => {
  const harness = makeHarness()
  const created = await run(harness, { action: 'create', title: 'first' })
  const secondHarness = makeHarness()
  // Another clock for a later batch, reusing the same filesystem to keep both batches.
  const laterService = createService({
    ctx: createFakeCtx({
      fs: harness.fs,
      mode: 'danger-full-access',
      dshHome: DSH_HOME_TEST,
      session: { id: 'session-test-1', cwd: WORKSPACE_ROOT, events: [] }
    }),
    env: { DSH_HOME: DSH_HOME_TEST },
    now: () => new Date('2026-10-22T02:36:00.000Z'),
    randomSuffix: () => 'beef',
    dshVersion: '0.2.1-rc.2',
    platform: 'win32'
  })
  const later = await laterService.run(validateToolArgs({ action: 'create', title: 'second' }), {
    agent: { id: 'session-test-1' },
    signal: new AbortController().signal
  })
  void secondHarness

  const listed = await run(harness, { action: 'list' })
  assert.equal(listed.action, 'list')
  assert.deepEqual(
    listed.batches.map((batch) => batch.batchId),
    [later.batchId, created.batchId]
  )
  assert.equal(listed.batches[0].title, 'second')
  assert.equal(listed.batches[0].complete, true)
  assert.equal(listed.batches[0].artifacts, later.artifacts.length)

  const all = await run(harness, { action: 'list', all: true })
  assert.equal(all.batches.length, 2)
})

test('copyFiles redacts secrets before writing and records them in the manifest', async () => {
  const files = sampleWorkspaceFiles({
    'src/secret-config.js': [
      'export const password = "hunter2secret"',
      'export const apiKey = "sk-abcdefghijklmnopqrstuvwxyz"',
      ''
    ].join('\n')
  })
  const harness = makeHarness({ files })
  const result = await run(harness, {
    action: 'create',
    copyFiles: true,
    files: ['src/secret-config.js']
  })
  assert.equal(result.redactions.length > 0, true)
  assert.equal(result.totals.redactions > 0, true)
  const copied = harness.fs.readFile(`${result.displayDir}\\evidence\\files\\src\\secret-config.js`)
  assert.notEqual(copied, undefined)
  assert.doesNotMatch(copied, /hunter2secret/)
  assert.doesNotMatch(copied, /sk-abcdefghijklmnopqrstuvwxyz/)
  assert.match(copied, /«REDACTED:/)
  const manifestText = harness.fs.readFile(`${result.displayDir}\\manifest.json`)
  assert.doesNotMatch(manifestText, /hunter2secret/)
  assert.doesNotMatch(manifestText, /sk-abcdefghijklmnopqrstuvwxyz/)
  const handoff = harness.fs.readFile(`${result.displayDir}\\HANDOFF.md`)
  assert.doesNotMatch(handoff, /hunter2secret/)
})

test('denylisted files are refused as explicit evidence paths', async () => {
  const harness = makeHarness()
  for (const files of [['.env'], ['.env.local'], ['secret.key'], ['cache.db'], ['node_modules/pkg/index.js']]) {
    await assert.rejects(
      () => run(harness, { action: 'create', copyFiles: true, files }),
      (error) => error.code === ERROR.PATH_ESCAPE,
      `expected ${files[0]} to be refused`
    )
  }
  assert.equal(harness.fs.writeCount(), 0)
})

test('agentless calls fall back to the default directory and warn about the missing session', async () => {
  const harness = makeHarness({ session: false })
  const scan = await run(harness, { action: 'scan' })
  assert.equal(scan.warnings.some((warning) => warning.code === 'SESSION_UNAVAILABLE'), true)
  assert.equal(scan.project.name, 'ws')
})

test('write failure leaves a partial batch that verify reports as incomplete', async () => {
  const harness = makeHarness()
  const original = harness.fs.writeText.bind(harness.fs)
  let calls = 0
  harness.fs.writeText = async (...args) => {
    calls += 1
    if (calls === 4) throw new Error('simulated disk fault')
    return original(...args)
  }
  await assert.rejects(
    () => run(harness, { action: 'create' }),
    (error) => {
      assert.equal(error.code, ERROR.WRITE_FAILED)
      assert.equal(error.partial, true)
      assert.equal(error.written.length, 3)
      return true
    }
  )
  harness.fs.writeText = original
  const result = await run(harness, { action: 'verify', batchId: FIXED_BATCH_ID })
  assert.equal(result.verification.ok, false)
  assert.equal(
    result.verification.findings.some((finding) => finding.code === 'MANIFEST_MISSING'),
    true
  )
})
