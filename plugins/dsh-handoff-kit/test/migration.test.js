/**
 * Migration tests (P3/M2): schemaVersion 1 batch -> NEW schemaVersion 2 batch.
 *
 * A v1 source batch is produced by creating a normal batch and then downgrading
 * only `manifest.json` (v1 manifests carry no changes/fuel/lineage blocks; the
 * manifest file is not itself an artifact, so artifact hashes stay valid).
 * This keeps the fixture realistic without a second code path.
 *
 * @module test/migration
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ERROR, TOOL_OUTPUT_SCHEMA, validateToolArgs } from '../src/contracts.js'
import { parseManifest, serializeManifest } from '../src/manifest.js'
import { createService } from '../src/service.js'
import { createTool } from '../src/tool.js'
import { parseCommandInput } from '../src/command.js'
import { createFakeCtx } from './helpers/fake-ctx.js'
import {
  FIXED_BATCH_ID,
  FIXED_NOW,
  WORKSPACE_ROOT,
  addGitFixture,
  createFixtureFs,
  fixedClock,
  fixedRandom,
  sampleSessionEvents
} from './helpers/fixtures.js'
import { policy } from './helpers/fake-fs.js'
import { validateSubset } from './helpers/schema-subset.js'

const DSH_HOME_TEST = 'C:\\Users\\test\\.dsh'
const MIGRATION_NOW = () => new Date(FIXED_NOW.getTime() + 60_000)
const MIGRATION_SUFFIX = () => 'c3d4'
const MIGRATION_BATCH_ID = '20261022T023612Z-c3d4'

function makeFs() {
  const fs = createFixtureFs()
  addGitFixture(fs)
  return fs
}

function makeService(fs, { now = fixedClock, suffix = fixedRandom } = {}) {
  const ctx = createFakeCtx({
    fs,
    dshHome: DSH_HOME_TEST,
    session: { id: 'session-test-1', cwd: WORKSPACE_ROOT, events: sampleSessionEvents() }
  })
  const service = createService({
    ctx,
    env: { DSH_HOME: DSH_HOME_TEST },
    now,
    randomSuffix: suffix,
    dshVersion: '0.2.1-rc.2',
    platform: 'win32'
  })
  return { ctx, service, exec: { agent: { id: 'session-test-1' }, signal: new AbortController().signal } }
}

async function run(harness, raw) {
  const result = await harness.service.run(validateToolArgs(raw), harness.exec)
  assert.deepEqual(
    validateSubset(TOOL_OUTPUT_SCHEMA, result),
    [],
    `result violates output schema: ${JSON.stringify(result).slice(0, 300)}`
  )
  return result
}

async function overwrite(fs, displayPath, text) {
  await fs.writeText(await fs.resolve(displayPath), text, undefined, undefined, policy('danger-full-access', WORKSPACE_ROOT))
}

/** Downgrade a freshly created v2 batch to a valid v1 batch (manifest only). */
async function downgradeToV1(fs, batchDir) {
  const manifestPath = `${batchDir}\\manifest.json`
  const manifest = parseManifest(fs.readFile(manifestPath))
  const v1 = structuredClone(manifest)
  v1.schemaVersion = 1
  delete v1.changes
  delete v1.fuel
  delete v1.lineage
  await overwrite(fs, manifestPath, serializeManifest(v1))
  return fs.readFile(manifestPath)
}

test('migrate v1 -> v2 writes a new batch, keeps the source byte-identical and records provenance', async () => {
  const fs = makeFs()
  const creator = makeService(fs)
  const created = await run(creator, {
    action: 'create',
    title: 'legacy v1 batch',
    summary: 'work from the old schema',
    decisions: ['keep v1 evidence']
  })
  const sourceManifestPath = `${created.displayDir}\\manifest.json`
  const sourceHandoffPath = `${created.displayDir}\\HANDOFF.md`
  const sourceSumsPath = `${created.displayDir}\\SHA256SUMS`
  const sourceBefore = {
    manifest: await downgradeToV1(fs, created.displayDir),
    handoff: fs.readFile(sourceHandoffPath),
    sums: fs.readFile(sourceSumsPath)
  }

  const writesBefore = fs.writePaths().length
  const migrator = makeService(fs, { now: MIGRATION_NOW, suffix: MIGRATION_SUFFIX })
  const migrated = await run(migrator, { action: 'migrate', batchId: FIXED_BATCH_ID })

  assert.equal(migrated.action, 'migrate')
  assert.equal(migrated.batchId, MIGRATION_BATCH_ID)
  assert.notEqual(migrated.displayDir, created.displayDir)
  assert.equal(migrated.migration.fromBatchId, FIXED_BATCH_ID)
  assert.equal(migrated.migration.fromSchemaVersion, 1)
  assert.match(migrated.migration.sourceSha256Sums, /^[0-9a-f]{64}$/)

  // Source batch is untouched (byte-identical) and no migration write went there.
  assert.equal(fs.readFile(sourceManifestPath), sourceBefore.manifest)
  assert.equal(fs.readFile(sourceHandoffPath), sourceBefore.handoff)
  assert.equal(fs.readFile(sourceSumsPath), sourceBefore.sums)
  const migrationWrites = fs.writePaths().slice(writesBefore)
  assert.equal(migrationWrites.length > 0, true)
  assert.equal(
    migrationWrites.every((path) => path.startsWith(migrated.displayDir)),
    true,
    `all migration writes must be under ${migrated.displayDir}`
  )

  // The new manifest is v2, marks v2-only evidence unavailable and keeps caller input.
  const newManifest = parseManifest(fs.readFile(`${migrated.displayDir}\\manifest.json`))
  assert.equal(newManifest.schemaVersion, 2)
  assert.equal(newManifest.changes.available, false)
  assert.equal(newManifest.fuel.goals.available, false)
  assert.equal(newManifest.fuel.jobs.available, false)
  assert.equal(newManifest.lineage, undefined)
  assert.equal(newManifest.inputs.title, 'legacy v1 batch')
  assert.equal(newManifest.warnings.some((warning) => warning.code === 'MIGRATED_FROM_V1'), true)

  const migrationEvidence = JSON.parse(fs.readFile(`${migrated.displayDir}\\evidence\\migration.json`))
  assert.equal(migrationEvidence.schemaVersion, 1)
  assert.equal(migrationEvidence.migration.fromBatchId, FIXED_BATCH_ID)
  assert.equal(migrationEvidence.migration.fromSchemaVersion, 1)
  assert.match(migrationEvidence.migration.sourceSha256Sums, /^[0-9a-f]{64}$/)
  assert.equal(migrationEvidence.migration.tool.name, 'dsh-handoff-kit')

  // The migrated batch verifies clean.
  const verifier = makeService(fs)
  const verified = await run(verifier, { action: 'verify', batchId: MIGRATION_BATCH_ID })
  assert.equal(verified.verification.ok, true)
  assert.equal(verified.verification.counts.errors, 0)
})

test('migrate refuses a source batch that fails verification', async () => {
  const fs = makeFs()
  const creator = makeService(fs)
  const created = await run(creator, { action: 'create', title: 'tampered source' })
  await downgradeToV1(fs, created.displayDir)
  await overwrite(fs, `${created.displayDir}\\HANDOFF.md`, '# tampered\n')

  const migrator = makeService(fs, { now: MIGRATION_NOW, suffix: MIGRATION_SUFFIX })
  await assert.rejects(
    () => migrator.service.run(validateToolArgs({ action: 'migrate', batchId: FIXED_BATCH_ID }), migrator.exec),
    (error) => {
      assert.equal(error.code, ERROR.MIGRATION_SOURCE_INVALID)
      return true
    }
  )
})

test('migrate refuses an already-v2 source batch', async () => {
  const fs = makeFs()
  const creator = makeService(fs)
  await run(creator, { action: 'create', title: 'already v2' })

  const migrator = makeService(fs, { now: MIGRATION_NOW, suffix: MIGRATION_SUFFIX })
  await assert.rejects(
    () => migrator.service.run(validateToolArgs({ action: 'migrate', batchId: FIXED_BATCH_ID }), migrator.exec),
    (error) => {
      assert.equal(error.code, ERROR.MIGRATION_UNSUPPORTED_VERSION)
      return true
    }
  )
})

test('migrate requires an explicit batchId and is not concurrency-safe', async () => {
  assert.throws(
    () => validateToolArgs({ action: 'migrate' }),
    (error) => error.code === ERROR.INVALID_ARGS
  )
  const tool = createTool({ run: async () => ({}) })
  assert.equal(tool.isConcurrencySafe({ action: 'migrate' }), false)
  assert.equal(tool.isConcurrencySafe({ action: 'verify' }), true)
})

test('/handoff migrate <batchId> parses to a migrate action', () => {
  const raw = parseCommandInput(`migrate ${FIXED_BATCH_ID}`)
  assert.equal(raw.action, 'migrate')
  assert.equal(raw.batchId, FIXED_BATCH_ID)
  const validated = validateToolArgs(raw)
  assert.equal(validated.action, 'migrate')
})
