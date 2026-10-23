/**
 * Project-key fallback tests (P3 follow-up).
 *
 * A project key is seeded from the git remote, so adding or changing a remote
 * moves the live key and orphans earlier batches under the old key. These
 * tests pin the two read-only fallbacks:
 *   - `handoff_load` / `handoff_pack verify` with an explicit batchId search
 *     sibling project keys under the same root (unique hit + warning);
 *   - the UI `state` RPC lists those historical batches grouped by key when
 *     the current key has none.
 * Writes must never follow the fallback: create/append/update still target the
 * current project key.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ERROR, TOOL_OUTPUT_SCHEMA, validateLoadArgs, validateToolArgs } from '../src/contracts.js'
import { createService } from '../src/service.js'
import { LOAD_OUTPUT_SCHEMA } from '../src/contracts.js'
import { createUiRpc, projectKeyFromBatchDir } from '../src/ui.js'
import { createFakeCtx } from './helpers/fake-ctx.js'
import {
  FIXED_BATCH_ID,
  GIT_REMOTE,
  WORKSPACE_ROOT,
  addGitFixture,
  createFixtureFs,
  fixedClock,
  fixedRandom
} from './helpers/fixtures.js'
import { validateSubset } from './helpers/schema-subset.js'

const DSH_HOME_TEST = 'C:\\Users\\test\\.dsh'
const HANDOFF_ROOT = `${DSH_HOME_TEST}\\handoff`
/** `.git/config` with no remote: the project key falls back to the workspace seed. */
const CONFIG_WITHOUT_REMOTE = '[core]\n\trepositoryformatversion = 0\n\tfilemode = false\n'
/** `.git/config` with a remote: the project key switches to the remote seed. */
const CONFIG_WITH_REMOTE =
  '[core]\n\trepositoryformatversion = 0\n\tfilemode = false\n[remote "origin"]\n\turl = ' +
  GIT_REMOTE +
  '\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n'

function makeHarness() {
  const fs = createFixtureFs()
  addGitFixture(fs, { config: CONFIG_WITHOUT_REMOTE })
  const ctx = createFakeCtx({
    fs,
    mode: 'danger-full-access',
    dshHome: DSH_HOME_TEST,
    session: { id: 'session-test-1', cwd: WORKSPACE_ROOT, events: [] }
  })
  const service = createService({
    ctx,
    env: { DSH_HOME: DSH_HOME_TEST },
    now: fixedClock,
    randomSuffix: fixedRandom,
    dshVersion: '0.2.1-rc.2',
    platform: 'win32'
  })
  const exec = { agent: { id: 'session-test-1' }, signal: new AbortController().signal }
  return { fs, ctx, service, exec }
}

/** Project key is the second-to-last segment of a tokenized batch dir. */
function projectKeyOf(dirToken) {
  const segments = String(dirToken).split('/')
  return segments.length >= 2 ? segments[segments.length - 2] : ''
}

/** Flip the workspace git fixture to a remote-seeded project key. */
function addRemote(fs) {
  fs.addFile('.git/config', CONFIG_WITH_REMOTE)
}

/** Create one batch with the workspace-seeded key, then move the key. */
async function orphanOneBatch(harness, raw = { action: 'create' }) {
  const created = await harness.service.run(validateToolArgs(raw), harness.exec)
  const oldKey = projectKeyOf(created.dir)
  assert.notEqual(oldKey, '')
  addRemote(harness.fs)
  const current = await harness.service.run(validateToolArgs({ action: 'list' }), harness.exec)
  assert.equal(current.batches.length, 0)
  assert.notEqual(current.project.key, oldKey)
  return { created, oldKey, current }
}

function rpcRequest(method, params) {
  return new Request(`http://127.0.0.1/api/handoff-kit/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocol: 1, method, params })
  })
}

// ------------------------------------------------------------- service layer

test('load falls back to a sibling project key read-only and warns', async () => {
  const harness = makeHarness()
  const { created, oldKey } = await orphanOneBatch(harness)
  const writesBefore = harness.fs.writeCount()

  const result = await harness.service.load(validateLoadArgs({ batchId: created.batchId }), harness.exec)
  assert.deepEqual(validateSubset(LOAD_OUTPUT_SCHEMA, result), [])
  assert.equal(result.batchId, created.batchId)
  assert.equal(result.trust, 'verified')
  assert.equal(result.dir, `$DSH_HOME/handoff/${oldKey}/${created.batchId}`)
  const warning = result.warnings.find((entry) => entry.code === 'PROJECT_KEY_FALLBACK')
  assert.ok(warning, `missing PROJECT_KEY_FALLBACK: ${JSON.stringify(result.warnings)}`)
  assert.match(warning.detail, new RegExp(oldKey))
  assert.match(warning.detail, /read-only/)
  // Loading a historical batch never writes (neither in the old nor the new key).
  assert.equal(harness.fs.writeCount(), writesBefore)
})

test('verify falls back to a sibling project key read-only and warns', async () => {
  const harness = makeHarness()
  const { created, oldKey } = await orphanOneBatch(harness)
  const writesBefore = harness.fs.writeCount()

  const result = await harness.service.run(
    validateToolArgs({ action: 'verify', batchId: created.batchId }),
    harness.exec
  )
  assert.deepEqual(validateSubset(TOOL_OUTPUT_SCHEMA, result), [])
  assert.equal(result.batchId, created.batchId)
  assert.equal(result.verification.ok, true)
  assert.equal(result.dir, `$DSH_HOME/handoff/${oldKey}/${created.batchId}`)
  const warning = result.warnings.find((entry) => entry.code === 'PROJECT_KEY_FALLBACK')
  assert.ok(warning, `missing PROJECT_KEY_FALLBACK: ${JSON.stringify(result.warnings)}`)
  assert.match(warning.detail, new RegExp(oldKey))
  // The fallback itself is not a package-integrity finding: trust/findings stay
  // untouched and the batch remains verified.
  assert.equal(result.verification.counts.errors, 0)
  assert.equal(result.verification.counts.warnings, 0)
  assert.equal(harness.fs.writeCount(), writesBefore)
})

test('load/verify keep the original error semantics when no sibling matches', async () => {
  const harness = makeHarness()
  await orphanOneBatch(harness)
  const missing = '20200101T000000Z-ffff'

  await assert.rejects(harness.service.load(validateLoadArgs({ batchId: missing }), harness.exec), (error) => {
    assert.equal(error.code, ERROR.RESUME_NOT_FOUND)
    assert.match(error.message, new RegExp(missing))
    return true
  })
  await assert.rejects(
    harness.service.run(validateToolArgs({ action: 'verify', batchId: missing }), harness.exec),
    (error) => {
      assert.equal(error.code, ERROR.BATCH_NOT_FOUND)
      assert.match(error.message, new RegExp(missing))
      return true
    }
  )
})

test('load without an explicit batch id never crosses project keys', async () => {
  const harness = makeHarness()
  await orphanOneBatch(harness)
  await assert.rejects(harness.service.load(validateLoadArgs({}), harness.exec), (error) => {
    assert.equal(error.code, ERROR.RESUME_NOT_FOUND)
    return true
  })
})

test('an ambiguous cross-key batch id keeps BATCH_NOT_FOUND and names the keys', async () => {
  const harness = makeHarness()
  await orphanOneBatch(harness)
  const ambiguous = '20260101T000000Z-ffff'
  harness.fs.addDirectory(`${HANDOFF_ROOT}\\zz-history-one-11111111\\${ambiguous}`)
  harness.fs.addDirectory(`${HANDOFF_ROOT}\\zz-history-two-22222222\\${ambiguous}`)

  await assert.rejects(
    harness.service.run(validateToolArgs({ action: 'verify', batchId: ambiguous }), harness.exec),
    (error) => {
      assert.equal(error.code, ERROR.BATCH_NOT_FOUND)
      assert.match(error.message, /zz-history-one-11111111/)
      assert.match(error.message, /zz-history-two-22222222/)
      return true
    }
  )
})

test('projectKeyFromBatchDir only accepts tokens under the given root', () => {
  const root = '$DSH_HOME/handoff'
  const batchId = FIXED_BATCH_ID
  assert.equal(projectKeyFromBatchDir(`${root}/ws-cb7aa4e5/${batchId}`, root, batchId), 'ws-cb7aa4e5')
  assert.equal(projectKeyFromBatchDir(`${root}/${batchId}`, root, batchId), null)
  assert.equal(projectKeyFromBatchDir(`${root}/a/b/${batchId}`, root, batchId), null)
  assert.equal(projectKeyFromBatchDir(`$WORKSPACE/.dsh/handoff/ws/${batchId}`, root, batchId), null)
  assert.equal(projectKeyFromBatchDir(`${root}/ws/${batchId}-other`, root, batchId), null)
  assert.equal(projectKeyFromBatchDir('', root, batchId), null)
  assert.equal(projectKeyFromBatchDir(`${root}/ws/${batchId}`, '', batchId), null)
  assert.equal(projectKeyFromBatchDir(`${root}/ws/${batchId}`, root, ''), null)
})

// ------------------------------------------------------------------ UI layer

test('state lists historical project-key batches read-only when the current key is empty', async () => {
  const harness = makeHarness()
  const { created, oldKey, current } = await orphanOneBatch(harness)
  const writesBefore = harness.fs.writeCount()
  const rpc = createUiRpc({ service: harness.service, env: { DSH_HOME: DSH_HOME_TEST }, ctx: harness.ctx })

  const payload = await (await rpc.handle(rpcRequest('state', {}))).json()
  assert.equal(payload.ok, true)
  const value = payload.value
  assert.equal(value.project.key, current.project.key)
  assert.equal(value.history.active, true)
  assert.deepEqual(value.history.projectKeys, [oldKey])
  assert.equal(value.batches.length, 1)
  assert.equal(value.batches[0].batchId, created.batchId)
  assert.equal(value.batches[0].projectKey, oldKey)
  const warning = value.warnings.find((entry) => entry.code === 'PROJECT_KEY_FALLBACK')
  assert.ok(warning, `missing PROJECT_KEY_FALLBACK: ${JSON.stringify(value.warnings)}`)
  assert.match(warning.detail, new RegExp(oldKey))
  assert.equal(harness.fs.writeCount(), writesBefore)
})

test('state keeps current-key batches first and skips the fallback when the key has batches', async () => {
  const harness = makeHarness()
  const created = await harness.service.run(validateToolArgs({ action: 'create' }), harness.exec)
  const rpc = createUiRpc({ service: harness.service, env: { DSH_HOME: DSH_HOME_TEST }, ctx: harness.ctx })
  const value = (await (await rpc.handle(rpcRequest('state', {}))).json()).value
  assert.equal(value.history, null)
  assert.equal(value.batches.length, 1)
  assert.equal(value.batches[0].batchId, created.batchId)
  assert.equal(value.batches[0].projectKey, undefined)
  assert.equal(value.warnings.some((entry) => entry.code === 'PROJECT_KEY_FALLBACK'), false)
})

test('detail and copy read a historical batch without writing', async () => {
  const harness = makeHarness()
  const { created } = await orphanOneBatch(harness)
  const writesBefore = harness.fs.writeCount()
  const rpc = createUiRpc({ service: harness.service, env: { DSH_HOME: DSH_HOME_TEST }, ctx: harness.ctx })

  const detail = (await (await rpc.handle(rpcRequest('detail', { batchId: created.batchId }))).json()).value
  assert.equal(detail.batchId, created.batchId)
  assert.equal(detail.trust, 'verified')
  assert.ok(detail.warnings.some((entry) => entry.code === 'PROJECT_KEY_FALLBACK'))

  const copy = (await (await rpc.handle(rpcRequest('copy', { batchId: created.batchId }))).json()).value
  assert.equal(copy.batchId, created.batchId)
  assert.match(copy.text, new RegExp(created.batchId))
  assert.equal(harness.fs.writeCount(), writesBefore)
})

test('create still writes only to the current project key after a fallback', async () => {
  const harness = makeHarness()
  const { oldKey } = await orphanOneBatch(harness)
  const rpc = createUiRpc({ service: harness.service, env: { DSH_HOME: DSH_HOME_TEST }, ctx: harness.ctx })
  const newKey = (await (await rpc.handle(rpcRequest('state', {}))).json()).value.project.key
  assert.notEqual(newKey, oldKey)

  const created = (
    await (await rpc.handle(rpcRequest('create', { mode: 'create', title: 'after fallback' }))).json()
  ).value
  assert.equal(created.action, 'create')
  assert.match(created.displayDir, new RegExp(newKey))
  assert.doesNotMatch(created.displayDir, new RegExp(oldKey))
  // The write landed under the new key only: the historical directory was not
  // touched (its batch still lists through the read-only fallback).
  const state = (await (await rpc.handle(rpcRequest('state', {}))).json()).value
  assert.equal(state.history, null)
  assert.equal(state.batches.length, 1)
  assert.equal(state.batches[0].batchId, created.batchId)
})

test('target=workspace applies the same read-only list fallback', async () => {
  const harness = makeHarness()
  const created = await harness.service.run(
    validateToolArgs({ action: 'create', target: 'workspace' }),
    harness.exec
  )
  const oldKey = projectKeyOf(created.dir)
  addRemote(harness.fs)
  const writesBefore = harness.fs.writeCount()
  const rpc = createUiRpc({ service: harness.service, env: { DSH_HOME: DSH_HOME_TEST }, ctx: harness.ctx })

  const value = (await (await rpc.handle(rpcRequest('state', { target: 'workspace' }))).json()).value
  assert.equal(value.history.active, true)
  assert.deepEqual(value.history.projectKeys, [oldKey])
  assert.equal(value.batches[0].batchId, created.batchId)
  assert.equal(value.batches[0].projectKey, oldKey)
  assert.equal(harness.fs.writeCount(), writesBefore)
})
