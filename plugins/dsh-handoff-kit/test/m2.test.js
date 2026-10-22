import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ERROR,
  LOAD_OUTPUT_SCHEMA,
  SCHEMA_VERSION_V2,
  TOOL_OUTPUT_SCHEMA,
  validateToolArgs
} from '../src/contracts.js'
import { createCommand, formatResult, parseCommandInput } from '../src/command.js'
import { createManifest, parseManifest, serializeManifest, validateManifest } from '../src/manifest.js'
import { renderHandoff } from '../src/render.js'
import { createService } from '../src/service.js'
import { createLoadTool, createTool } from '../src/tool.js'
import { createFakeCtx } from './helpers/fake-ctx.js'
import {
  FIXED_BATCH_ID,
  WORKSPACE_ROOT,
  addGitFixture,
  createFixtureFs,
  fixedClock,
  fixedRandom
} from './helpers/fixtures.js'
import { validateSchemaSubset, validateSubset } from './helpers/schema-subset.js'

const DSH_HOME_TEST = 'C:\\Users\\test\\.dsh'

function changeSummary(overrides = {}) {
  return {
    turn: 2,
    cwd: WORKSPACE_ROOT,
    total: 2,
    added: 5,
    deleted: 1,
    files: [
      { path: 'src/index.js', display: 'src/index.js', added: 3, deleted: 1 },
      { path: 'docs/design.md', display: 'docs/design.md', added: 2, deleted: 0 }
    ],
    ...overrides
  }
}

function makeHarness({ mode = 'danger-full-access', services, summary } = {}) {
  const fs = createFixtureFs()
  addGitFixture(fs)
  const events = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'tool/call', seq: 2, data: { turn: 1, name: 'read', arguments: JSON.stringify({ path: 'src/index.js' }) } },
    { type: 'turn/end', seq: 5, data: { turn: 1 } },
    { type: 'turn/start', seq: 6, data: { turn: 2 } },
    { type: 'tool/call', seq: 7, data: { turn: 2, name: 'write', arguments: JSON.stringify({ path: 'docs/design.md' }) } },
    { type: 'workspace/changes', seq: 10, time: 0, data: { turn: 2 } },
    { type: 'turn/end', seq: 11, data: { turn: 2 } },
    { type: 'turn/start', seq: 12, data: { turn: 3 } },
    { type: 'tool/call', seq: 13, data: { turn: 3, name: 'write', arguments: JSON.stringify({ path: 'src/new.js' }) } },
    { type: 'tool/call', seq: 14, data: { turn: 3, name: 'read', arguments: JSON.stringify({ path: 'src/new.js' }) } }
  ]
  const injected = { ...(services ?? {}) }
  if (summary !== undefined) {
    injected.workspaceChanges = {
      summary: () => summary,
      diff: async () => ({
        kind: 'text',
        hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-old', '+new'] }]
      })
    }
  }
  const ctx = createFakeCtx({
    fs,
    mode,
    dshHome: DSH_HOME_TEST,
    session: { id: 'session-test-1', cwd: WORKSPACE_ROOT, events },
    services: injected
  })
  const service = createService({
    ctx,
    env: { DSH_HOME: DSH_HOME_TEST },
    now: fixedClock,
    randomSuffix: (() => {
      let counter = 0
      return () => {
        counter += 1
        return counter.toString(16).padStart(4, '0')
      }
    })(),
    dshVersion: '0.2.1-rc.2',
    platform: 'win32'
  })
  const exec = { agent: { id: 'session-test-1' }, signal: new AbortController().signal }
  return { fs, ctx, service, exec }
}

async function run(harness, raw) {
  const args = validateToolArgs(raw)
  const result = await harness.service.run(args, harness.exec)
  assert.deepEqual(
    validateSubset(TOOL_OUTPUT_SCHEMA, result),
    [],
    `result violates output schema: ${JSON.stringify(result).slice(0, 400)}`
  )
  return result
}

function readManifest(harness, result) {
  return parseManifest(harness.fs.readFile(`${result.displayDir}\\manifest.json`))
}

test('create with workspaceChanges/goal/jobs writes manifest@2 with P1 blocks and [改动] assertions', async () => {
  const harness = makeHarness({
    summary: changeSummary(),
    services: {
      goals: { get: () => ({ id: 'g1', objective: 'ship it', phase: 'active', roundsStarted: 1, maxGoalRounds: 5, activation: 'resumed', updatedAt: 1 }) },
      jobs: { list: () => [{ id: 'j1', kind: 'bash', label: 'run tests', status: 'running', owner: 'session-test-1', startedAt: 1 }] }
    }
  })
  const result = await run(harness, { action: 'create', summary: 'did work' })
  assert.equal(result.changes.available, true)
  assert.equal(result.changes.turn, 2)
  assert.deepEqual(result.changes.totals, { files: 2, added: 5, deleted: 1, binary: 0, oversized: 0 })
  assert.equal(result.changes.totals.binary, 0)

  const manifest = readManifest(harness, result)
  assert.equal(manifest.schemaVersion, SCHEMA_VERSION_V2)
  assert.equal(manifest.changes.available, true)
  assert.equal(manifest.changes.files.length, 2)
  assert.equal(manifest.changes.currentTurn.turn, 3)
  assert.deepEqual(manifest.changes.currentTurn.files.map((file) => file.path), ['src/new.js'])
  assert.equal(manifest.changes.currentTurn.files[0].count, 2)
  assert.equal(manifest.fuel.goals.available, true)
  assert.equal(manifest.fuel.goals.goal.id, 'g1')
  assert.equal(manifest.fuel.jobs.available, true)
  assert.equal(manifest.fuel.jobs.count, 1)
  assert.equal(validateManifest(manifest).ok, true)

  const handoff = harness.fs.readFile(`${result.displayDir}\\HANDOFF.md`)
  assert.match(handoff, /### 本会话改动（workspaceChanges，仅已完成 turn）/)
  assert.match(handoff, /已完成 turn 共 2 个文件/)
  assert.match(handoff, /#### 当前未完成 turn 的触碰（会话 tool\/call，仅路径）/)
  assert.match(handoff, /`src\/new\.js`/)
  assert.match(handoff, /`\[改动\]`/)
  assert.match(handoff, /workspaceChanges 只覆盖\*\*已完成 turn\*\*/)

  const written = JSON.parse(harness.fs.readFile(`${result.displayDir}\\manifest.json`))
  assert.equal(written.schemaVersion, 2)
  assert.deepEqual(Object.keys(written).slice(0, 17), [
    'schema',
    'schemaVersion',
    'generator',
    'batchId',
    'createdAt',
    'project',
    'session',
    'sandbox',
    'inputs',
    'git',
    'artifacts',
    'files',
    'sessionTrace',
    'redactions',
    'warnings',
    'limits',
    'scan'
  ])
  assert.equal(written.changes.available, true)
})

test('create without optional services degrades to available:false + warnings (v2 still valid)', async () => {
  const harness = makeHarness()
  const result = await run(harness, { action: 'create' })
  assert.equal(result.changes.available, false)
  const codes = result.warnings.map((warning) => warning.code)
  assert.equal(codes.includes('CHANGES_UNAVAILABLE'), true)
  assert.equal(codes.includes('GOAL_UNAVAILABLE'), true)
  assert.equal(codes.includes('JOBS_UNAVAILABLE'), true)
  const manifest = readManifest(harness, result)
  assert.equal(manifest.schemaVersion, 2)
  assert.equal(manifest.changes.available, false)
  assert.equal(manifest.changes.currentTurn.turn, 3)
  assert.equal(validateManifest(manifest).ok, true)
  const handoff = harness.fs.readFile(`${result.displayDir}\\HANDOFF.md`)
  assert.match(handoff, /本会话 workspaceChanges 不可用/)
  assert.match(handoff, /当前未完成 turn 的触碰/)
})

test('create includeDiffs captures bounded diff hunks', async () => {
  const harness = makeHarness({ summary: changeSummary() })
  const result = await run(harness, { action: 'create', includeDiffs: true })
  const manifest = readManifest(harness, result)
  assert.equal(Array.isArray(manifest.changes.diffs), true)
  assert.equal(manifest.changes.diffs.length, 2)
  assert.equal(manifest.changes.diffs[0].kind, 'text')
  assert.deepEqual(manifest.changes.diffs[0].hunks[0].lines, ['-old', '+new'])
})

test('append creates a new batch with lineage and leaves the base batch untouched', async () => {
  const harness = makeHarness({ summary: changeSummary() })
  const first = await run(harness, { action: 'create', summary: 'base' })
  const firstManifestText = harness.fs.readFile(`${first.displayDir}\\manifest.json`)
  const appended = await run(harness, { action: 'append', previousBatchId: first.batchId, summary: 'continuation' })
  const manifest = readManifest(harness, appended)
  assert.deepEqual(manifest.lineage, { sequence: 2, previous: first.batchId, root: first.batchId })
  assert.deepEqual(appended.lineage, { sequence: 2, previous: first.batchId, root: first.batchId })
  // Base batch untouched.
  assert.equal(harness.fs.readFile(`${first.displayDir}\\manifest.json`), firstManifestText)
  // Base verifies clean (append is a continuation, not a supersede).
  const baseVerify = await harness.service.run(validateToolArgs({ action: 'verify', batchId: first.batchId }), harness.exec)
  assert.equal(baseVerify.verification.findings.some((finding) => finding.code === 'SUPERSEDED_BATCH'), false)
})

test('append defaults to the latest batch and rejects missing targets before writing', async () => {
  const harness = makeHarness()
  const first = await run(harness, { action: 'create' })
  const appended = await run(harness, { action: 'append', summary: 'next' })
  assert.equal(readManifest(harness, appended).lineage.previous, first.batchId)

  const writes = harness.fs.writeCount()
  await assert.rejects(
    () => run(harness, { action: 'append', previousBatchId: '20261022T000000Z-dead' }),
    (error) => error.code === ERROR.APPEND_TARGET_MISSING
  )
  assert.equal(harness.fs.writeCount(), writes)
})

test('update supersedes the target batch; verify marks the old batch superseded', async () => {
  const harness = makeHarness()
  const first = await run(harness, { action: 'create' })
  const updated = await run(harness, { action: 'update', supersedes: first.batchId, summary: 'replacement' })
  const manifest = readManifest(harness, updated)
  assert.deepEqual(manifest.lineage, {
    sequence: 2,
    previous: first.batchId,
    root: first.batchId,
    supersedes: first.batchId
  })
  const oldVerify = await harness.service.run(validateToolArgs({ action: 'verify', batchId: first.batchId }), harness.exec)
  const superseded = oldVerify.verification.findings.filter((finding) => finding.code === 'SUPERSEDED_BATCH')
  assert.equal(superseded.length, 1)
  assert.equal(superseded[0].severity, 'warn')
  assert.match(superseded[0].detail, new RegExp(updated.batchId))
})

test('update can supersede an explicit batch; self-link is refused', async () => {
  const harness = makeHarness()
  const first = await run(harness, { action: 'create' })
  const updated = await run(harness, { action: 'update', supersedes: first.batchId })
  assert.equal(readManifest(harness, updated).lineage.supersedes, first.batchId)
  // Both append/update must exist on the tool definition's action enum.
  const tool = createTool(harness.service)
  assert.equal(tool.parameters.properties.action.enum.includes('append'), true)
  assert.equal(tool.parameters.properties.action.enum.includes('update'), true)
  assert.equal(tool.isConcurrencySafe({ action: 'append' }), false)
  assert.equal(tool.isConcurrencySafe({ action: 'update' }), false)
})

test('manifest@2 round-trips canonically and v1 batches remain readable', () => {
  const v1 = createManifest({
    batchId: FIXED_BATCH_ID,
    createdAt: '2026-10-22T02:35:12.000Z',
    project: { key: 'p-12345678', name: 'p', workspace: '$WORKSPACE' }
  })
  assert.equal(v1.schemaVersion, 1)
  assert.equal(validateManifest(v1).ok, true)
  const v1Text = serializeManifest(v1)
  assert.equal(serializeManifest(parseManifest(v1Text)), v1Text)

  const v2 = createManifest({
    batchId: FIXED_BATCH_ID,
    createdAt: '2026-10-22T02:35:12.000Z',
    schemaVersion: 2,
    project: { key: 'p-12345678', name: 'p', workspace: '$WORKSPACE' },
    changes: { available: false, source: 'workspace-changes', note: 'n/a' },
    fuel: { goals: { available: false, note: 'none' }, jobs: { available: false, count: 0, statusCounts: {}, items: [], note: 'none' } },
    lineage: { sequence: 2, previous: FIXED_BATCH_ID, root: FIXED_BATCH_ID }
  })
  assert.equal(v2.schemaVersion, 2)
  assert.equal(validateManifest(v2).ok, true)
  const v2Text = serializeManifest(v2)
  assert.equal(serializeManifest(parseManifest(v2Text)), v2Text)
  // v1 cannot carry v2 blocks when the version is explicit.
  assert.throws(
    () =>
      createManifest({
        batchId: FIXED_BATCH_ID,
        createdAt: '2026-10-22T02:35:12.000Z',
        schemaVersion: 1,
        project: { key: 'p', name: 'p', workspace: '$WORKSPACE' },
        changes: { available: false }
      }),
    (error) => error.code === ERROR.INVALID_ARGS
  )
  // v1 + blocks is a warn-only finding.
  const mixed = serializeManifest(v2)
  const parsed = JSON.parse(mixed)
  parsed.schemaVersion = 1
  const validation = validateManifest(parsed)
  assert.equal(validation.ok, true)
  assert.equal(validation.findings.some((finding) => finding.code === 'MANIFEST_VERSION_BLOCK'), true)
})

test('append/update arguments are cross-validated', () => {
  assert.equal(validateToolArgs({ action: 'append' }).previousBatchId, undefined)
  assert.equal(validateToolArgs({ action: 'append', previousBatchId: FIXED_BATCH_ID }).previousBatchId, FIXED_BATCH_ID)
  assert.equal(validateToolArgs({ action: 'update', supersedes: FIXED_BATCH_ID }).supersedes, FIXED_BATCH_ID)
  assert.equal(validateToolArgs({ action: 'create', includeDiffs: true }).includeDiffs, true)
  for (const raw of [
    { action: 'append', supersedes: FIXED_BATCH_ID },
    { action: 'update', previousBatchId: FIXED_BATCH_ID },
    { action: 'create', previousBatchId: FIXED_BATCH_ID },
    { action: 'scan', includeDiffs: true },
    { action: 'append', previousBatchId: 'bad' },
    { action: 'update', supersedes: 'bad' }
  ]) {
    assert.throws(() => validateToolArgs(raw), (error) => error.code === ERROR.INVALID_ARGS, JSON.stringify(raw))
  }
})

test('load accepts manifest@2 batches and keeps working on v1 batches', async () => {
  const harness = makeHarness({ summary: changeSummary() })
  const created = await run(harness, { action: 'create' })
  const loaded = await harness.service.load(
    { batchId: created.batchId, target: 'user', verifyFirst: true, include: 'summary' },
    harness.exec
  )
  assert.equal(loaded.trust, 'verified')
  assert.equal(loaded.manifest.batchId, created.batchId)
  assert.deepEqual(validateSchemaSubset(LOAD_OUTPUT_SCHEMA), [])
})

test('command parses append/update and renders lineage text', async () => {
  assert.deepEqual(parseCommandInput('append'), { action: 'append' })
  assert.deepEqual(parseCommandInput(`append --previous ${FIXED_BATCH_ID}`), {
    action: 'append',
    previousBatchId: FIXED_BATCH_ID
  })
  assert.deepEqual(parseCommandInput(`update --supersedes ${FIXED_BATCH_ID} --include-diffs`), {
    action: 'update',
    supersedes: FIXED_BATCH_ID,
    includeDiffs: true
  })
  const text = formatResult({
    action: 'append',
    displayDir: 'C:\\out\\b',
    batchId: 'b2',
    linege: undefined,
    lineage: { sequence: 2, previous: 'b1', root: 'b1' },
    changes: { available: true, totals: { files: 2, added: 3, deleted: 1 } },
    artifacts: [{ path: 'HANDOFF.md', sha256: 'a'.repeat(64) }],
    totals: { artifactBytes: 100 },
    warnings: []
  })
  assert.match(text, /交接包已追加（append）/)
  assert.match(text, /血缘：第 2 代，承接 b1/)
  assert.match(text, /本会话改动（已完成 turn）：2 个文件/)
})
