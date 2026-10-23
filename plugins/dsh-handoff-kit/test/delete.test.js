/**
 * P3/M5b batch-deletion tests.
 *
 * Service/tool path: SOFT DELETE only (directory moved under
 * `<handoffRoot>/.trash/<projectKey>/<batchId>-<timestamp>`, recoverable).
 * CLI: `delete` defaults to soft delete and adds `--hard` for permanent
 * removal. Lineage-referenced batches are refused unless `force`.
 *
 * @module test/delete
 */

import assert from 'node:assert/strict'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

import { EXIT, deleteBatch, parseArgv, runCli } from '../src/cli.js'
import { ERROR, TOOL_OUTPUT_SCHEMA, validateToolArgs } from '../src/contracts.js'
import {
  parseBatchLocation,
  normalizeProjectKey,
  trashEntryName
} from '../src/delete.js'
import { createService } from '../src/service.js'
import { writeBatchFixture } from './helpers/cli-batch-fixture.js'
import { createFakeCtx } from './helpers/fake-ctx.js'
import {
  FIXED_BATCH_ID,
  FIXED_NOW,
  WORKSPACE_ROOT,
  addGitFixture,
  createFixtureFs,
  fixedClock,
  fixedRandom
} from './helpers/fixtures.js'
import { validateSubset } from './helpers/schema-subset.js'

const DSH_HOME_TEST = 'C:\\Users\\test\\.dsh'
const DSH_HOME_ABS = resolve(DSH_HOME_TEST)
const PROJECT_KEY = 'ws-12345678'

function makeServiceFor(fs, { mode = 'danger-full-access', now = fixedClock, suffix = fixedRandom } = {}) {
  const ctx = createFakeCtx({
    fs,
    mode,
    dshHome: DSH_HOME_TEST,
    session: { id: 'session-test-1', cwd: WORKSPACE_ROOT, events: [] }
  })
  const service = createService({
    ctx,
    env: { DSH_HOME: DSH_HOME_TEST },
    now,
    randomSuffix: suffix,
    dshVersion: '0.2.1-rc.2',
    platform: 'win32'
  })
  const exec = { agent: { id: 'session-test-1' }, signal: new AbortController().signal }
  return { fs, ctx, service, exec }
}

function makeHarness(options = {}) {
  const fs = createFixtureFs()
  addGitFixture(fs)
  return makeServiceFor(fs, options)
}

function laterService(fs) {
  return makeServiceFor(fs, {
    now: () => new Date(FIXED_NOW.getTime() + 60_000),
    suffix: () => 'beef'
  })
}

async function create(harness, raw = { action: 'create' }) {
  return harness.service.run(validateToolArgs(raw), harness.exec)
}

function runDelete(harness, raw) {
  return harness.service.run(validateToolArgs(raw), harness.exec)
}

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-delete-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function makeIo() {
  const out = []
  const err = []
  return {
    stdout: { write: (text) => out.push(text) },
    stderr: { write: (text) => err.push(text) },
    out: () => out.join(''),
    err: () => err.join('')
  }
}

async function run(argv) {
  const io = makeIo()
  const code = await runCli(argv, { stdout: io.stdout, stderr: io.stderr })
  return { code, out: io.out(), err: io.err() }
}

/** Absolute path behind a `$DSH_HOME/...` token produced by the service. */
function dshHomePath(token) {
  const match = /^\$DSH_HOME\/(.+)$/.exec(token)
  assert.ok(match, `expected a $DSH_HOME token, got ${token}`)
  return join(DSH_HOME_ABS, ...match[1].split('/'))
}

function readManifest(fs, batchDir) {
  return JSON.parse(fs.readFile(`${batchDir}\\manifest.json`))
}

// -------------------------------------------------------------- pure helpers

test('parseBatchLocation/normalizeProjectKey/trash naming are strict and deterministic', () => {
  const located = parseBatchLocation(`C:\\handoffs\\${PROJECT_KEY}\\${FIXED_BATCH_ID}`)
  assert.deepEqual(located, {
    dir: `C:\\handoffs\\${PROJECT_KEY}\\${FIXED_BATCH_ID}`,
    projectDir: `C:\\handoffs\\${PROJECT_KEY}`,
    root: 'C:\\handoffs',
    projectKey: PROJECT_KEY,
    batchId: FIXED_BATCH_ID
  })
  for (const bad of ['C:\\handoffs\\not-a-batch', 'C:\\handoffs\\..\\20261022T023512Z-a1b2']) {
    assert.throws(
      () => parseBatchLocation(bad),
      (error) => error.code === ERROR.INVALID_ARGS,
      bad
    )
  }
  assert.equal(
    trashEntryName({ batchId: FIXED_BATCH_ID, timestamp: '20261022T023512Z' }),
    `${FIXED_BATCH_ID}-20261022T023512Z`
  )
  assert.equal(
    trashEntryName({ batchId: FIXED_BATCH_ID, timestamp: '20261022T023512Z', attempt: 1 }),
    `${FIXED_BATCH_ID}-20261022T023512Z-2`
  )

  assert.equal(normalizeProjectKey(undefined), undefined)
  assert.equal(normalizeProjectKey(PROJECT_KEY), PROJECT_KEY)
  for (const bad of ['../escape', 'a/b', '.trash', '', 'A B', '-leading']) {
    assert.throws(() => normalizeProjectKey(bad), (error) => error.code === ERROR.INVALID_ARGS, bad)
  }
})

test('the tool contract exposes delete but never a hard-delete switch', () => {
  assert.throws(
    () => validateToolArgs({ action: 'delete' }),
    (error) => error.code === ERROR.INVALID_ARGS && /explicit batchId/.test(error.message)
  )
  assert.throws(
    () => validateToolArgs({ action: 'delete', batchId: FIXED_BATCH_ID, hard: true }),
    (error) => error.code === ERROR.INVALID_ARGS && /unknown argument/.test(error.message)
  )
  const validated = validateToolArgs({ action: 'delete', batchId: FIXED_BATCH_ID, force: true })
  assert.equal(validated.action, 'delete')
  assert.equal(validated.force, true)
})

// -------------------------------------------------------------- soft delete

test('service delete soft-deletes into .trash and hides the batch from list/verify', async () => {
  const harness = makeHarness()
  const created = await create(harness)
  const writesBefore = harness.fs.writeCount()
  const projectKey = created.project.key
  const result = await runDelete(harness, { action: 'delete', batchId: created.batchId })
  assert.deepEqual(
    validateSubset(TOOL_OUTPUT_SCHEMA, result),
    [],
    `delete result violates schema: ${JSON.stringify(result).slice(0, 400)}`
  )
  assert.equal(result.action, 'delete')
  assert.equal(result.batchId, created.batchId)
  assert.equal(result.projectKey, projectKey)
  assert.equal(result.mode, 'trash')
  const trashPath = dshHomePath(result.trashDir)
  assert.equal(
    result.trashDir,
    `$DSH_HOME/handoff/.trash/${projectKey}/${created.batchId}-20261022T023512Z`
  )
  // Original directory is gone; every artifact now lives under the trash dir.
  assert.equal(harness.fs.has(created.displayDir), false)
  assert.equal(harness.fs.has(trashPath), true)
  assert.equal(readManifest(harness.fs, trashPath).batchId, created.batchId)
  assert.equal(harness.fs.has(`${trashPath}\\HANDOFF.md`), true)
  assert.deepEqual(harness.fs.mutationOps(), ['rename'])
  assert.equal(harness.fs.writeCount(), writesBefore, 'delete moves files, it does not write content')

  const listed = await harness.service.run(validateToolArgs({ action: 'list' }), harness.exec)
  assert.equal(listed.batches.length, 0)
  await assert.rejects(
    () => harness.service.run(validateToolArgs({ action: 'verify', batchId: created.batchId }), harness.exec),
    (error) => error.code === ERROR.BATCH_NOT_FOUND
  )
})

test('soft delete leaves other batches untouched and verifiable', async () => {
  const harness = makeHarness()
  const first = await create(harness, { action: 'create', title: 'first' })
  const later = laterService(harness.fs)
  const second = await create(later, { action: 'append', title: 'second' })
  const secondManifestBefore = harness.fs.readFile(`${second.displayDir}\\manifest.json`)
  assert.notEqual(secondManifestBefore, undefined)
  const deleted = await runDelete(later, { action: 'delete', batchId: second.batchId })
  assert.equal(deleted.mode, 'trash')
  const verified = await harness.service.run(
    validateToolArgs({ action: 'verify', batchId: first.batchId }),
    harness.exec
  )
  assert.equal(verified.verification.ok, true)
  assert.equal(verified.verification.counts.errors, 0)
  // The deleted batch's manifest bytes are preserved inside the trash entry.
  const trashPath = dshHomePath(deleted.trashDir)
  assert.equal(harness.fs.readFile(`${trashPath}\\manifest.json`), secondManifestBefore)
})

// --------------------------------------------------------- lineage protection

test('a lineage-referenced batch is refused, and force deletes it with a strong warning', async () => {
  const harness = makeHarness()
  const first = await create(harness, { action: 'create', title: 'base' })
  const later = laterService(harness.fs)
  const second = await create(later, { action: 'append', title: 'descendant' })
  assert.equal(second.lineage.previous, first.batchId)

  const mutationsBefore = harness.fs.mutations.length
  await assert.rejects(
    () => runDelete(later, { action: 'delete', batchId: first.batchId }),
    (error) => {
      assert.equal(error.code, ERROR.BATCH_REFERENCED)
      assert.match(error.message, new RegExp(second.batchId))
      assert.match(error.message, /force=true/)
      return true
    }
  )
  assert.equal(harness.fs.mutations.length, mutationsBefore, 'refused delete must not move anything')
  assert.equal(harness.fs.has(first.displayDir), true)

  const forced = await runDelete(later, { action: 'delete', batchId: first.batchId, force: true })
  assert.equal(forced.mode, 'trash')
  const warning = forced.warnings.find((entry) => entry.code === 'BATCH_REFERENCED_FORCE')
  assert.ok(warning, `missing force warning: ${JSON.stringify(forced.warnings)}`)
  assert.match(warning.detail, new RegExp(second.batchId))
  assert.equal(harness.fs.has(first.displayDir), false)

  const descendant = await later.service.run(
    validateToolArgs({ action: 'verify', batchId: second.batchId }),
    later.exec
  )
  assert.equal(descendant.verification.ok, false)
  assert.equal(
    descendant.verification.findings.some(
      (finding) => finding.severity === 'error' && finding.code === 'LINEAGE_BROKEN'
    ),
    true
  )
})

// ---------------------------------------------------------------- safeguards

test('delete respects the session sandbox and refuses path-shaped project keys', async () => {
  const harness = makeHarness()
  const created = await create(harness)
  const readOnly = makeServiceFor(harness.fs, { mode: 'read-only' })
  await assert.rejects(
    () => runDelete(readOnly, { action: 'delete', batchId: created.batchId }),
    (error) => error.code === ERROR.READ_ONLY
  )
  assert.equal(harness.fs.mutations.length, 0)

  const workspaceWrite = makeServiceFor(harness.fs, { mode: 'workspace-write' })
  await assert.rejects(
    () => runDelete(workspaceWrite, { action: 'delete', batchId: created.batchId }),
    (error) => error.code === ERROR.SANDBOX_DENIED
  )
  assert.equal(harness.fs.mutations.length, 0)

  const validated = validateToolArgs({ action: 'delete', batchId: created.batchId })
  await assert.rejects(
    () => harness.service.run({ ...validated, projectKey: '../escape' }, harness.exec),
    (error) => error.code === ERROR.INVALID_ARGS
  )
  await assert.rejects(
    () => harness.service.run({ ...validated, projectKey: 'not-a-real-key' }, harness.exec),
    (error) => error.code === ERROR.BATCH_NOT_FOUND
  )
  assert.equal(harness.fs.mutations.length, 0)
})

// ---------------------------------------------------------------- CLI delete

test('CLI delete soft-deletes by default and reports the trash directory', async (t) => {
  const base = tempDir(t)
  const fixture = writeBatchFixture(base)
  const result = await run(['delete', fixture.batchDir, '--json'])
  assert.equal(result.code, EXIT.VERIFIED, result.err)
  const payload = JSON.parse(result.out)
  assert.equal(payload.ok, true)
  assert.equal(payload.batchId, fixture.batchId)
  assert.equal(payload.projectKey, fixture.projectKey)
  assert.equal(payload.mode, 'trash')
  assert.match(payload.trashDir, /[\\/]\.trash[\\/]/)
  assert.equal(existsSync(fixture.batchDir), false)
  assert.equal(existsSync(join(payload.trashDir, 'manifest.json')), true)
  assert.equal(existsSync(join(payload.trashDir, 'HANDOFF.md')), true)
  // The trash root now exists but list only reads project-key directories.
  assert.equal(readdirSync(join(fixture.root, '.trash', fixture.projectKey)).length, 1)
})

test('CLI delete --hard removes the directory permanently', async (t) => {
  const base = tempDir(t)
  const fixture = writeBatchFixture(base)
  const result = await run(['delete', fixture.batchDir, '--hard', '--json'])
  assert.equal(result.code, EXIT.VERIFIED, result.err)
  const payload = JSON.parse(result.out)
  assert.equal(payload.mode, 'hard')
  assert.equal(payload.trashDir, undefined)
  assert.equal(existsSync(fixture.batchDir), false)
  assert.equal(existsSync(join(fixture.root, '.trash')), false)
  const warning = payload.warnings.find((entry) => entry.code === 'HANDOFF_BATCH_HARD_DELETED' || entry.code === 'BATCH_HARD_DELETED')
  assert.ok(warning, `missing hard-delete warning: ${JSON.stringify(payload.warnings)}`)
  assert.match(warning.detail, /cannot be recovered/)
})

test('CLI delete refuses a lineage-referenced batch (exit 1) and --force succeeds with a warning', async (t) => {
  const base = tempDir(t)
  const older = writeBatchFixture(base)
  const newerId = '20261022T030000Z-c3d4'
  const newer = writeBatchFixture(base, {
    batchId: newerId,
    createdAt: '2026-10-22T03:00:00.000Z',
    lineage: { sequence: 2, previous: older.batchId, root: older.batchId }
  })

  const refused = await run(['delete', older.batchDir, '--json'])
  assert.equal(refused.code, EXIT.INVALID)
  const refusedPayload = JSON.parse(refused.out)
  assert.equal(refusedPayload.ok, false)
  assert.equal(refusedPayload.error.code, ERROR.BATCH_REFERENCED)
  assert.match(refusedPayload.error.message, new RegExp(newer.batchId))
  assert.equal(existsSync(older.batchDir), true)

  const forced = await run(['delete', older.batchDir, '--force', '--json'])
  assert.equal(forced.code, EXIT.VERIFIED, forced.err)
  const forcedPayload = JSON.parse(forced.out)
  assert.equal(forcedPayload.mode, 'trash')
  assert.equal(
    forcedPayload.warnings.some((entry) => entry.code === 'BATCH_REFERENCED_FORCE'),
    true
  )
  assert.equal(existsSync(older.batchDir), false)

  // The descendant now reports a broken lineage (read-only verification).
  const descendant = await run(['verify', newer.batchDir, '--json'])
  assert.equal(descendant.code, EXIT.INVALID)
  assert.equal(
    JSON.parse(descendant.out).verification.findings.some((finding) => finding.code === 'LINEAGE_BROKEN'),
    true
  )
})

test('CLI delete usage errors exit 2 and --hard parses as a flag', async () => {
  assert.equal(parseArgv(['delete', 'C:\\x\\a-12345678\\20261022T023512Z-a1b2', '--hard']).flags.hard, true)
  assert.equal(parseArgv(['delete', 'C:\\x']).flags.hard, false)

  const missing = await run(['delete'])
  assert.equal(missing.code, EXIT.USAGE)
  assert.match(missing.err, /requires <batchDir>/)

  const noDir = await run(['delete', join(tmpdir(), 'definitely-missing-dir')])
  assert.equal(noDir.code, EXIT.USAGE)

  const notBatch = await run(['delete', join(tmpdir(), 'not-a-batch'), '--json'])
  assert.equal(notBatch.code, EXIT.USAGE)

  const unknown = await run(['delete', 'C:\\x', '--bogus'])
  assert.equal(unknown.code, EXIT.USAGE)
})

test('the /handoff command parses and renders delete', async () => {
  const { parseCommandInput, formatResult } = await import('../src/command.js')
  assert.deepEqual(parseCommandInput(`delete ${FIXED_BATCH_ID}`), {
    action: 'delete',
    batchId: FIXED_BATCH_ID
  })
  const soft = formatResult({
    action: 'delete',
    batchId: FIXED_BATCH_ID,
    projectKey: PROJECT_KEY,
    mode: 'trash',
    displayDir: 'C:\\out\\b',
    trashDir: '$DSH_HOME/handoff/.trash/p/b-ts',
    warnings: []
  })
  assert.match(soft, /回收站/)
  assert.match(soft, /\.trash/)
  const hard = formatResult({
    action: 'delete',
    batchId: FIXED_BATCH_ID,
    projectKey: PROJECT_KEY,
    mode: 'hard',
    displayDir: 'C:\\out\\b',
    warnings: [{ code: 'BATCH_HARD_DELETED', detail: 'cannot be recovered' }]
  })
  assert.match(hard, /永久删除/)
  assert.match(hard, /cannot be recovered/)
})

test('deleteBatch is also callable as a module function (soft and hard)', async (t) => {
  const base = tempDir(t)
  const soft = writeBatchFixture(base)
  const softResult = await deleteBatch({ batchDir: soft.batchDir })
  assert.equal(softResult.mode, 'trash')
  assert.equal(existsSync(soft.batchDir), false)

  const hardBase = tempDir(t)
  const hard = writeBatchFixture(hardBase)
  const hardResult = await deleteBatch({ batchDir: hard.batchDir, hard: true })
  assert.equal(hardResult.mode, 'hard')
  assert.equal(existsSync(hard.batchDir), false)

  // Refuses a path that is not a batch directory.
  await assert.rejects(
    () => deleteBatch({ batchDir: hardBase }),
    (error) => error.code === ERROR.INVALID_ARGS
  )
})
