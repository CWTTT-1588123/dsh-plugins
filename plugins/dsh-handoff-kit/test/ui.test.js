/**
 * P2 UI bridge tests: the Host route that the Client half calls.
 *
 * These tests exercise the adapter contract only — dispatch shape, argument
 * validation, read-only behavior and error envelopes — with stubbed services;
 * the real service behavior stays covered by service.test.js/load.test.js.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  UI_RPC_PATH,
  UI_RPC_PROTOCOL,
  createUiRpc,
  failureOf,
  registerUiRpc,
  remedyFor,
  renderOpeningPrompt
} from '../src/ui.js'
import { ERROR, handoffError, validateToolArgs } from '../src/contracts.js'
import { createService } from '../src/service.js'
import { createFakeCtx } from './helpers/fake-ctx.js'
import {
  FIXED_BATCH_ID,
  WORKSPACE_ROOT,
  addGitFixture,
  createFixtureFs,
  fixedClock,
  fixedRandom
} from './helpers/fixtures.js'

const DSH_HOME_TEST = 'C:\\Users\\test\\.dsh'

/** Build the same POST request the Client half sends. */
function rpcRequest(method, params, protocol = UI_RPC_PROTOCOL) {
  return new Request(`http://127.0.0.1${UI_RPC_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocol, method, params })
  })
}

/** Service double that records calls. */
function stubService(overrides = {}) {
  const calls = { run: [], load: [] }
  const service = {
    calls,
    async run(args, exec) {
      calls.run.push({ args, exec })
      if (typeof overrides.run === 'function') return await overrides.run(args, exec)
      return { action: args.action, ok: true }
    },
    async load(args, exec) {
      calls.load.push({ args, exec })
      if (typeof overrides.load === 'function') return await overrides.load(args, exec)
      return { ok: true, batchId: args.batchId, trust: 'verified', dir: '$DSH_HOME/handoff/p/b', pointers: [], next: [] }
    }
  }
  return service
}

function baseCtx(options = {}) {
  return createFakeCtx({
    fs: options.fs ?? createFixtureFs(),
    dshHome: 'C:\\Users\\test\\.dsh',
    ...options
  })
}

test('state dispatches list, binds the session exec, and reports absolute target roots', async () => {
  const ctx = baseCtx()
  const service = stubService({
    run: async (args) => ({
      action: 'list',
      dir: '$DSH_HOME/handoff/fixture-1234abcd',
      project: { key: 'fixture-1234abcd', name: 'fixture-app' },
      batches: [{ batchId: '20261022T023512Z-a1b2', complete: true, artifacts: 3, bytes: 2048 }],
      totals: { artifacts: 3, artifactBytes: 2048 },
      warnings: [],
      limits: {},
      next: ['verify']
    })
  })
  const rpc = createUiRpc({ service, env: { DSH_HOME: ctx.dshHome }, ctx })
  const response = await rpc.handle(rpcRequest('state', { sessionId: 'session-test' }))
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.ok, true)
  assert.equal(payload.protocol, UI_RPC_PROTOCOL)
  assert.equal(service.calls.run.length, 1)
  assert.deepEqual(service.calls.run[0].args, validateToolArgs({ action: 'list', target: 'user' }))
  assert.deepEqual(service.calls.run[0].exec.agent, { id: 'session-test' })
  assert.equal(payload.value.project.name, 'fixture-app')
  assert.equal(payload.value.batches.length, 1)
  assert.equal(payload.value.roots.user, 'C:\\Users\\test\\.dsh\\handoff')
  assert.equal(payload.value.roots.workspace, 'C:\\ws\\.dsh\\handoff')
  assert.equal(payload.value.session.live, true)
  assert.equal(payload.value.session.id, 'session-test')
})

test('state without a session id falls back to the newest live root session and performs no write', async () => {
  const ctx = baseCtx()
  const service = stubService({
    run: async () => ({ action: 'list', dir: '$DSH_HOME/handoff/p', batches: [], warnings: [], next: [] })
  })
  const rpc = createUiRpc({ service, env: { DSH_HOME: ctx.dshHome }, ctx })
  const payload = await (await rpc.handle(rpcRequest('state', { all: true }))).json()
  assert.equal(payload.ok, true)
  assert.deepEqual(service.calls.run[0].args, validateToolArgs({ action: 'list', target: 'user', all: true }))
  // Root-scoped UI surfaces carry no session binding: the newest live root
  // session is used instead of the deployment fallback directory.
  assert.deepEqual(service.calls.run[0].exec.agent, { id: 'session-test' })
  assert.equal(payload.value.session.id, 'session-test')
  assert.equal(payload.value.session.live, true)
  assert.equal(ctx.fs.writeCount(), 0)
})

test('state falls back to the deployment directory when no live session exists', async () => {
  const ctx = createFakeCtx({
    fs: createFixtureFs(),
    dshHome: DSH_HOME_TEST,
    session: null,
    defaultDirectory: 'C:\\fallback'
  })
  const service = stubService({
    run: async () => ({ action: 'list', dir: '$DSH_HOME/handoff/p', batches: [], warnings: [], next: [] })
  })
  const rpc = createUiRpc({ service, env: { DSH_HOME: DSH_HOME_TEST }, ctx })
  const payload = await (await rpc.handle(rpcRequest('state', {}))).json()
  assert.equal(payload.ok, true)
  assert.equal(service.calls.run[0].exec.agent, undefined)
  assert.equal(payload.value.session.live, false)
  assert.equal(payload.value.session.cwd, 'C:\\fallback')
  assert.equal(payload.value.roots.workspace, 'C:\\fallback\\.dsh\\handoff')
})

test('state rejects an unknown target with a HANDOFF_INVALID_ARGS envelope and remedy', async () => {
  const rpc = createUiRpc({ service: stubService(), env: {}, ctx: baseCtx() })
  const payload = await (await rpc.handle(rpcRequest('state', { target: 'elsewhere' }))).json()
  assert.equal(payload.ok, false)
  assert.equal(payload.error.code, ERROR.INVALID_ARGS)
  assert.match(payload.error.remedy, /参数/)
})

test('the route rejects non-POST, malformed JSON, unknown methods and unknown params', async () => {
  const rpc = createUiRpc({ service: stubService(), env: {}, ctx: baseCtx() })
  const notPost = await rpc.handle(new Request(`http://127.0.0.1${UI_RPC_PATH}`))
  assert.equal(notPost.status, 405)

  const badJson = await rpc.handle(
    new Request(`http://127.0.0.1${UI_RPC_PATH}`, { method: 'POST', body: '{not json' })
  )
  assert.equal(badJson.status, 400)

  const unknownMethod = await (await rpc.handle(rpcRequest('scan'))).json()
  assert.equal(unknownMethod.ok, false)
  assert.equal(unknownMethod.error.code, ERROR.INVALID_ARGS)

  const unknownParam = await (await rpc.handle(rpcRequest('state', { nope: 1 }))).json()
  assert.equal(unknownParam.ok, false)
  assert.match(unknownParam.error.message, /nope/)

  const wrongProtocol = await rpc.handle(rpcRequest('state', {}, 99))
  assert.equal(wrongProtocol.status, 400)
})

test('create forwards exactly the tool arguments to the existing service and never touches the manifest', async () => {
  const service = stubService({
    run: async (args) => ({
      action: args.action,
      batchId: '20261022T023512Z-a1b2',
      dir: '$DSH_HOME/handoff/p/20261022T023512Z-a1b2',
      displayDir: 'C:\\Users\\test\\.dsh\\handoff\\p\\20261022T023512Z-a1b2',
      warnings: []
    })
  })
  const rpc = createUiRpc({ service, env: {}, ctx: baseCtx() })
  const payload = await (
    await rpc.handle(
      rpcRequest('create', {
        sessionId: 'session-test',
        target: 'workspace',
        mode: 'append',
        title: 'UI 生成',
        summary: '一句话备注',
        includeDiffs: true,
        force: true,
        previousBatchId: '20261022T023512Z-ffff'
      })
    )
  ).json()
  assert.equal(payload.ok, true)
  assert.equal(payload.value.displayDir, 'C:\\Users\\test\\.dsh\\handoff\\p\\20261022T023512Z-a1b2')
  const forwarded = service.calls.run[0].args
  // The UI route must hand the service the same canonical shape the tool path
  // validates (the U1 bug: a raw args object made `args.decisions` non-iterable).
  assert.deepEqual(
    forwarded,
    validateToolArgs({
      action: 'append',
      target: 'workspace',
      title: 'UI 生成',
      summary: '一句话备注',
      includeDiffs: true,
      force: true,
      previousBatchId: '20261022T023512Z-ffff'
    })
  )
  assert.equal(Array.isArray(forwarded.decisions), true)
  assert.equal(Array.isArray(forwarded.nextSteps), true)
  assert.equal(forwarded.copyFiles, false)
  assert.deepEqual(service.calls.run[0].exec.agent, { id: 'session-test' })
})

test('create refuses a read action and unsupported mode', async () => {
  const service = stubService()
  const rpc = createUiRpc({ service, env: {}, ctx: baseCtx() })
  const scan = await (await rpc.handle(rpcRequest('create', { mode: 'scan' }))).json()
  assert.equal(scan.ok, false)
  assert.equal(scan.error.code, ERROR.INVALID_ARGS)
  assert.equal(service.calls.run.length, 0)
})

test('create maps a sandbox denial to a code + remedy envelope', async () => {
  const service = stubService({
    run: async () => {
      throw handoffError(ERROR.SANDBOX_DENIED, 'session policy read-only refuses write')
    }
  })
  const rpc = createUiRpc({ service, env: {}, ctx: baseCtx() })
  const payload = await (await rpc.handle(rpcRequest('create', {}))).json()
  assert.equal(payload.ok, false)
  assert.equal(payload.error.code, ERROR.SANDBOX_DENIED)
  assert.match(payload.error.message, /read-only/)
  assert.match(payload.error.remedy, /沙箱/)
})

test('detail loads an explicit batch with bounded sections and verify enabled', async () => {
  const service = stubService()
  const rpc = createUiRpc({ service, env: {}, ctx: baseCtx() })
  const payload = await (
    await rpc.handle(rpcRequest('detail', { batchId: '20261022T023512Z-a1b2', sessionId: 'session-test' }))
  ).json()
  assert.equal(payload.ok, true)
  assert.deepEqual(service.calls.load[0].args, {
    batchId: '20261022T023512Z-a1b2',
    target: 'user',
    include: 'sections',
    verifyFirst: true
  })
})

test('detail without a batch id selects the newest batch from list', async () => {
  const service = stubService({
    run: async () => ({ action: 'list', batches: [{ batchId: '20261022T023512Z-a1b2' }, { batchId: '20261022T000000Z-ffff' }] })
  })
  const rpc = createUiRpc({ service, env: {}, ctx: baseCtx() })
  const payload = await (await rpc.handle(rpcRequest('detail', {}))).json()
  assert.equal(payload.ok, true)
  assert.equal(service.calls.load[0].args.batchId, '20261022T023512Z-a1b2')
})

test('detail maps a missing batch to HANDOFF_RESUME_NOT_FOUND with a remedy', async () => {
  const rpc = createUiRpc({ service: stubService({ run: async () => ({ action: 'list', batches: [] }) }), env: {}, ctx: baseCtx() })
  const payload = await (await rpc.handle(rpcRequest('detail', {}))).json()
  assert.equal(payload.ok, false)
  assert.equal(payload.error.code, ERROR.RESUME_NOT_FOUND)
  assert.match(payload.error.remedy, /生成/)
})

test('copy renders the opening prompt from load output and writes nothing', async () => {
  const loadResult = {
    ok: true,
    batchId: '20261022T023512Z-a1b2',
    trust: 'verified',
    dir: '$DSH_HOME/handoff/p/20261022T023512Z-a1b2',
    displayDir: 'C:\\Users\\test\\.dsh\\handoff\\p\\20261022T023512Z-a1b2',
    manifest: { title: 'P2 UI' },
    handoff: {
      path: '$DSH_HOME/handoff/p/20261022T023512Z-a1b2/HANDOFF.md',
      sections: [
        { id: 'H0', heading: '## H0 交接摘要', text: '本包记录 P2 UI 的实现状态。' },
        { id: 'H8', heading: '## H8 下一步', text: '1. 跑浏览器验证' }
      ]
    },
    pointers: [
      { label: 'HANDOFF.md', path: '$DSH_HOME/handoff/p/b/HANDOFF.md' },
      { label: 'manifest.json', path: '$DSH_HOME/handoff/p/b/manifest.json' }
    ],
    next: ['read H2 → H3 → H4 → H8'],
    warnings: []
  }
  const service = stubService({ load: async () => loadResult })
  const ctx = baseCtx()
  const rpc = createUiRpc({ service, env: { DSH_HOME: ctx.dshHome }, ctx })
  const payload = await (await rpc.handle(rpcRequest('copy', { batchId: '20261022T023512Z-a1b2' }))).json()
  assert.equal(payload.ok, true)
  assert.equal(payload.value.trust, 'verified')
  assert.equal(payload.value.batchId, '20261022T023512Z-a1b2')
  assert.match(payload.value.text, /20261022T023512Z-a1b2/)
  assert.match(payload.value.text, /信任判定：verified/)
  assert.match(payload.value.text, /HANDOFF\.md/)
  assert.match(payload.value.text, /跑浏览器验证/)
  // 0.3.1 safety gate: the prompt itself must demand a read-only verification
  // and forbid file changes until the user explicitly asks.
  assert.match(payload.value.text, /强制边界/)
  assert.match(payload.value.text, /不要修改\/创建\/删除任何文件/)
  assert.match(payload.value.text, /第 0 步（强制，只读）/)
  assert.match(payload.value.text, /handoff_load batchId=20261022T023512Z-a1b2/)
  assert.match(payload.value.text, /等用户确认后再开始修改文件/)
  assert.equal(ctx.fs.writeCount(), 0)
})

test('renderOpeningPrompt marks stale and invalid packages as unsafe to trust', () => {
  const base = {
    batchId: '20261022T023512Z-a1b2',
    displayDir: 'D:\\handoff\\p\\b',
    pointers: [],
    next: [],
    handoff: { path: 'HANDOFF.md', sections: [] }
  }
  const stale = renderOpeningPrompt({ ...base, trust: 'stale' })
  assert.match(stale, /先核实/)
  assert.match(stale, /不要修改文件/)
  const invalid = renderOpeningPrompt({ ...base, trust: 'invalid' })
  assert.match(invalid, /不要信任/)
  assert.match(invalid, /停止操作/)
  const verified = renderOpeningPrompt({ ...base, trust: 'verified' })
  assert.match(verified, /哈希与漂移检查通过/)
})

test('opening prompt embeds a mandatory read-only gate before any work', () => {
  // Regression for the U4 incident: a new agent read the old "请先读它，再继续工作"
  // wording as permission to start editing files. The gate must come first and
  // name the exact read-only call plus the wait-for-user boundary.
  const prompt = renderOpeningPrompt({
    batchId: '20261022T131930Z-6922',
    displayDir: 'C:\\Users\\x\\.dsh\\handoff\\p\\b',
    trust: 'verified',
    pointers: [],
    next: ['继续 P3'],
    handoff: { path: 'HANDOFF.md', sections: [] }
  })
  const gateIndex = prompt.indexOf('第 0 步（强制，只读）')
  const readIndex = prompt.indexOf('第 1 步（只读）')
  assert.ok(gateIndex >= 0, 'gate present')
  assert.ok(readIndex > gateIndex, 'gate precedes reading')
  assert.match(prompt, /handoff_load batchId=20261022T131930Z-6922/)
  assert.match(prompt, /等待用户的明确指令/)
  assert.match(prompt, /不是立即开工的许可/)
  assert.match(prompt, /在收到用户的明确指令前，请只汇报、不落盘/)
  assert.match(prompt, /建议的下一步（仅供参考，仍需用户确认后再执行）/)
})

test('opening prompt requires re-grounding: read key files, compare narrative with code, report the file list', () => {
  const prompt = renderOpeningPrompt({
    batchId: '20261022T131930Z-6922',
    displayDir: 'C:\\Users\\x\\.dsh\\handoff\\p\\b',
    trust: 'verified',
    pointers: [],
    next: ['继续 P3'],
    handoff: { path: 'HANDOFF.md', sections: [] }
  })
  const gateIndex = prompt.indexOf('第 0 步（强制，只读）')
  const conceptsIndex = prompt.indexOf('第 1 步（只读）')
  const filesIndex = prompt.indexOf('第 2 步（只读）')
  const compareIndex = prompt.indexOf('第 3 步（只读，re-grounding）')
  const reportIndex = prompt.indexOf('第 4 步')
  assert.ok(gateIndex >= 0, 'read-only gate stays first')
  assert.ok(conceptsIndex > gateIndex, 'concept reading follows the gate')
  // 1. Read the package to form concepts (existing H2→H3→H4→H8 order kept).
  assert.match(prompt, /H2 → H3 → H4 → H8/)
  // 2. Actually open the files the package names (by role, bounded).
  assert.ok(filesIndex > conceptsIndex, 'file reading follows concept reading')
  assert.match(prompt, /实际打开并阅读 H4\/文件清单里的关键文件/)
  assert.match(prompt, /entry\/source\/test\/doc/)
  assert.match(prompt, /最多 8 个/)
  assert.match(prompt, /不要只核对哈希/)
  // 3. Compare the narrative with the current code/files, including broken refs.
  assert.ok(compareIndex > filesIndex, 'comparison follows file reading')
  assert.match(prompt, /HANDOFF 叙述 vs 当前代码\/文件/)
  assert.match(prompt, /引用的仓库相对路径是否仍存在/)
  assert.match(prompt, /已实现\/已完成/)
  assert.match(prompt, /引用已失效/)
  // 4. Report trust + the checked-file list + mismatches + next step, still read-only.
  assert.ok(reportIndex > compareIndex, 'reporting follows re-grounding')
  assert.match(prompt, /我实际核对过的文件列表/)
  assert.match(prompt, /叙述与现状不符/)
  assert.match(prompt, /等用户确认后再开始修改文件/)
  // The read-only boundary and "report first, write nothing" reminder survive.
  assert.match(prompt, /不要修改\/创建\/删除任何文件/)
  assert.match(prompt, /在收到用户的明确指令前，请只汇报、不落盘/)
})

test('failureOf keeps the code, drops the duplicated prefix and attaches a remedy', () => {
  const failure = failureOf(handoffError(ERROR.WRITE_FAILED, 'disk full'))
  assert.equal(failure.ok, false)
  assert.equal(failure.error.code, ERROR.WRITE_FAILED)
  assert.equal(failure.error.message, 'disk full')
  assert.equal(failure.error.remedy, remedyFor(ERROR.WRITE_FAILED))
})

test('registerUiRpc registers the POST route on the optional connection service', async () => {
  const routes = []
  const ctx = baseCtx({
    services: {
      connection: {
        fetch: {
          register(route) {
            routes.push(route)
            return () => {
              routes.splice(routes.indexOf(route), 1)
            }
          }
        }
      }
    }
  })
  const service = stubService({
    run: async () => ({ action: 'list', dir: '$DSH_HOME/handoff/p', batches: [], warnings: [], next: [] })
  })
  registerUiRpc(ctx, service, { env: { DSH_HOME: ctx.dshHome } })
  assert.equal(routes.length, 1)
  assert.equal(routes[0].path, UI_RPC_PATH)
  assert.deepEqual(routes[0].methods, ['POST'])
  assert.equal(routes[0].requestBody, 'buffered')
  const response = await routes[0].fetch(rpcRequest('state', {}))
  const payload = await response.json()
  assert.equal(payload.ok, true)
  assert.equal(payload.value.dir, '$DSH_HOME/handoff/p')
  await ctx.dispose()
  assert.equal(routes.length, 0)
})

test('registerUiRpc is inert without a connection service (host-only profiles)', () => {
  const ctx = baseCtx()
  assert.equal(typeof registerUiRpc(ctx, stubService(), { env: {} }), 'function')
  assert.equal(ctx.fs.writeCount(), 0)
})

test('apply() wires the UI route when a connection service exists', async () => {
  const routes = []
  const ctx = baseCtx({
    services: {
      connection: {
        fetch: {
          register(route) {
            routes.push(route)
            return () => {}
          }
        }
      }
    }
  })
  const { apply } = await import('../index.js')
  apply(ctx)
  assert.equal(routes.length, 1)
  const response = await routes[0].fetch(rpcRequest('state', {}))
  const payload = await response.json()
  assert.equal(payload.ok, true)
  assert.equal(payload.value.project.name, 'ws')
  assert.equal(ctx.fs.writeCount(), 0)
  await ctx.dispose()
})

test('create through the UI route runs the real service end to end (tool-path validation parity)', async () => {
  const fs = createFixtureFs()
  addGitFixture(fs)
  const ctx = createFakeCtx({
    fs,
    mode: 'danger-full-access',
    dshHome: DSH_HOME_TEST,
    session: { id: 'session-test', cwd: WORKSPACE_ROOT, events: [] }
  })
  const service = createService({
    ctx,
    env: { DSH_HOME: DSH_HOME_TEST },
    now: fixedClock,
    randomSuffix: fixedRandom,
    dshVersion: '0.2.1-rc.2',
    platform: 'win32'
  })
  const rpc = createUiRpc({ service, env: { DSH_HOME: DSH_HOME_TEST }, ctx })

  // The regression this covers: without validateToolArgs, the service received a
  // raw args object and threw `args.decisions is not iterable`.
  const created = await (
    await rpc.handle(
      rpcRequest('create', {
        sessionId: 'session-test',
        target: 'workspace',
        title: 'UI 生成',
        summary: '端到端创建'
      })
    )
  ).json()
  assert.equal(created.ok, true, JSON.stringify(created.error))
  assert.equal(created.value.action, 'create')
  assert.equal(created.value.batchId, FIXED_BATCH_ID)
  assert.match(created.value.displayDir, /^C:\\ws\\\.dsh\\handoff\\/)

  // Read-back through the same route sees the new batch (and writes nothing).
  const writesAfterCreate = fs.writeCount()
  const state = await (await rpc.handle(rpcRequest('state', { sessionId: 'session-test', target: 'workspace' }))).json()
  assert.equal(state.ok, true)
  assert.equal(state.value.batches.length, 1)
  assert.equal(state.value.batches[0].batchId, FIXED_BATCH_ID)
  assert.equal(fs.writeCount(), writesAfterCreate)
})

// --------------------------------------------------------------- UI delete

test('delete is an exposed UI RPC method and forwards the canonical tool arguments', async () => {
  const service = stubService({
    run: async (args) => ({
      action: 'delete',
      ok: true,
      batchId: args.batchId,
      projectKey: 'fixture-12345678',
      mode: 'trash',
      trashDir: '$DSH_HOME/handoff/.trash/fixture-12345678/b-1',
      warnings: []
    })
  })
  const ctx = baseCtx()
  const rpc = createUiRpc({ service, env: { DSH_HOME: ctx.dshHome }, ctx })
  assert.equal(rpc.methods.includes('delete'), true)
  const baseline = service.calls.run.length
  const payload = await (
    await rpc.handle(
      rpcRequest('delete', {
        sessionId: 'session-test',
        target: 'user',
        batchId: '20261022T023512Z-a1b2',
        force: true
      })
    )
  ).json()
  assert.equal(payload.ok, true, JSON.stringify(payload.error))
  assert.equal(payload.value.mode, 'trash')
  assert.equal(service.calls.run.length, baseline + 1)
  const forwarded = service.calls.run.at(-1).args
  assert.deepEqual(
    forwarded,
    validateToolArgs({ action: 'delete', target: 'user', batchId: '20261022T023512Z-a1b2', force: true })
  )
  assert.equal(forwarded.projectKey, undefined)
})

test('UI delete validates batchId/projectKey/force and never forwards path traversal', async () => {
  const ctx = baseCtx()
  const service = stubService()
  const rpc = createUiRpc({ service, env: { DSH_HOME: ctx.dshHome }, ctx })

  const badBatch = await (await rpc.handle(rpcRequest('delete', { batchId: '../escape' }))).json()
  assert.equal(badBatch.ok, false)
  assert.equal(badBatch.error.code, ERROR.INVALID_ARGS)

  for (const projectKey of ['../escape', 'a/b', '.trash', 'BAD KEY']) {
    const payload = await (
      await rpc.handle(
        rpcRequest('delete', { batchId: '20261022T023512Z-a1b2', projectKey })
      )
    ).json()
    assert.equal(payload.ok, false, projectKey)
    assert.equal(payload.error.code, ERROR.INVALID_ARGS, projectKey)
  }
  // A well-shaped but absent project-key directory is refused too.
  const absent = await (
    await rpc.handle(
      rpcRequest('delete', { batchId: '20261022T023512Z-a1b2', projectKey: 'no-such-11111111' })
    )
  ).json()
  assert.equal(absent.ok, false)
  assert.equal(absent.error.code, ERROR.BATCH_NOT_FOUND)

  const badForce = await (
    await rpc.handle(rpcRequest('delete', { batchId: '20261022T023512Z-a1b2', force: 'yes' }))
  ).json()
  assert.equal(badForce.ok, false)
  assert.equal(badForce.error.code, ERROR.INVALID_ARGS)
  assert.equal(service.calls.run.length, 0)
})

test('UI delete through the real service soft-deletes and refreshes the list', async () => {
  const fs = createFixtureFs()
  addGitFixture(fs)
  const ctx = createFakeCtx({
    fs,
    mode: 'danger-full-access',
    dshHome: DSH_HOME_TEST,
    session: { id: 'session-test', cwd: WORKSPACE_ROOT, events: [] }
  })
  const service = createService({
    ctx,
    env: { DSH_HOME: DSH_HOME_TEST },
    now: fixedClock,
    randomSuffix: fixedRandom,
    dshVersion: '0.2.1-rc.2',
    platform: 'win32'
  })
  const rpc = createUiRpc({ service, env: { DSH_HOME: DSH_HOME_TEST }, ctx })

  const created = await (
    await rpc.handle(rpcRequest('create', { sessionId: 'session-test', title: 'delete me' }))
  ).json()
  assert.equal(created.ok, true, JSON.stringify(created.error))
  const batchId = created.value.batchId

  const deleted = await (
    await rpc.handle(rpcRequest('delete', { sessionId: 'session-test', batchId }))
  ).json()
  assert.equal(deleted.ok, true, JSON.stringify(deleted.error))
  assert.equal(deleted.value.action, 'delete')
  assert.equal(deleted.value.batchId, batchId)
  assert.equal(deleted.value.mode, 'trash')
  assert.match(deleted.value.trashDir, /\/\.trash\/[^/]+\/20261022T023512Z-a1b2-20261022T023512Z$/)
  assert.deepEqual(fs.mutationOps(), ['rename'])

  const stateAfter = await (
    await rpc.handle(rpcRequest('state', { sessionId: 'session-test' }))
  ).json()
  assert.equal(stateAfter.ok, true)
  assert.equal(stateAfter.value.batches.length, 0)
  // The historical fallback must not resurrect the trashed batch either.
  assert.equal(stateAfter.value.history, null)
})

test('UI delete reports a lineage-referenced batch as an error envelope with a remedy', async () => {
  const service = stubService({
    run: async () => {
      throw handoffError(ERROR.BATCH_REFERENCED, 'batch is referenced by newer batch')
    }
  })
  const ctx = baseCtx()
  const rpc = createUiRpc({ service, env: { DSH_HOME: ctx.dshHome }, ctx })
  const payload = await (
    await rpc.handle(rpcRequest('delete', { batchId: '20261022T023512Z-a1b2' }))
  ).json()
  assert.equal(payload.ok, false)
  assert.equal(payload.error.code, ERROR.BATCH_REFERENCED)
  assert.match(payload.error.remedy, /lineage/)
  assert.match(payload.error.message, /referenced/)
})
