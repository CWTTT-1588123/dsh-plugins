import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ERROR,
  LOAD_ARGUMENTS_SCHEMA,
  LOAD_OUTPUT_SCHEMA,
  LOAD_TOOL_TIMEOUT_MS,
  LOAD_TOOL_NAME,
  validateLoadArgs,
  validateToolArgs
} from '../src/contracts.js'
import { createService } from '../src/service.js'
import { createCommand, formatLoadResult, parseCommandInput } from '../src/command.js'
import { createFakeCtx } from './helpers/fake-ctx.js'
import {
  FIXED_BATCH_ID,
  GIT_HEAD,
  WORKSPACE_ROOT,
  addGitFixture,
  createFixtureFs,
  fixedClock,
  fixedRandom
} from './helpers/fixtures.js'
import { validateSchemaSubset, validateSubset } from './helpers/schema-subset.js'
import { createLoadTool, summarizeLoadResult } from '../src/tool.js'

const DSH_HOME_TEST = 'C:\\Users\\test\\.dsh'

function makeHarness({ mode = 'danger-full-access', files, events } = {}) {
  const fs = createFixtureFs(files === undefined ? {} : { files })
  addGitFixture(fs)
  const ctx = createFakeCtx({
    fs,
    mode,
    dshHome: DSH_HOME_TEST,
    session: { id: 'session-test-1', cwd: WORKSPACE_ROOT, events: events ?? [] }
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

async function createBatch(harness, raw = { action: 'create' }) {
  return harness.service.run(validateToolArgs(raw), harness.exec)
}

async function loadBatch(harness, raw) {
  const result = await harness.service.load(validateLoadArgs(raw), harness.exec)
  assert.deepEqual(validateSubset(LOAD_OUTPUT_SCHEMA, result), [], `load result violates schema: ${JSON.stringify(result).slice(0, 400)}`)
  return result
}

test('load arguments default and validate', () => {
  assert.deepEqual(validateLoadArgs(undefined), { batchId: undefined, target: 'user', verifyFirst: true, include: 'summary' })
  assert.deepEqual(validateLoadArgs({}), { batchId: undefined, target: 'user', verifyFirst: true, include: 'summary' })
  assert.equal(validateLoadArgs({ include: 'sections', verifyFirst: false }).include, 'sections')
  assert.deepEqual(validateSchemaSubset(LOAD_ARGUMENTS_SCHEMA), [])
  assert.deepEqual(validateSchemaSubset(LOAD_OUTPUT_SCHEMA), [])
  for (const raw of [{ bogus: 1 }, { include: 'all' }, { target: 'auto' }, { batchId: 'bad' }, { verifyFirst: 'yes' }]) {
    assert.throws(() => validateLoadArgs(raw), (error) => error.code === ERROR.INVALID_ARGS, JSON.stringify(raw))
  }
})

test('load reports verified for a freshly created batch and never writes', async () => {
  const harness = makeHarness()
  const created = await createBatch(harness)
  const writesAfterCreate = harness.fs.writeCount()
  const result = await loadBatch(harness, { batchId: created.batchId })
  assert.equal(result.batchId, created.batchId)
  assert.equal(result.trust, 'verified')
  assert.equal(result.verification.ok, true)
  assert.equal(result.verification.counts.errors, 0)
  assert.match(result.dir, /^\$DSH_HOME\/handoff\//)
  assert.equal(result.handoff.path.endsWith('/HANDOFF.md'), true)
  assert.equal(result.manifest.path.endsWith('/manifest.json'), true)
  assert.equal(result.pointers.length, 4)
  assert.equal(result.handoff.excerpt, undefined)
  assert.equal(result.handoff.sections, undefined)
  assert.equal(harness.fs.writeCount(), writesAfterCreate)
})

test('load defaults to the latest batch and supports target=workspace', async () => {
  const harness = makeHarness({ mode: 'workspace-write' })
  const created = await createBatch(harness, { action: 'create', target: 'workspace' })
  const latest = await loadBatch(harness, { target: 'workspace' })
  assert.equal(latest.batchId, created.batchId)
  assert.match(latest.dir, /^\$WORKSPACE\/\.dsh\/handoff\//)
  assert.equal(latest.trust, 'verified')
})

test('load include=sections returns bounded H0-H9 excerpts', async () => {
  const harness = makeHarness()
  await createBatch(harness, { action: 'create', summary: 'x'.repeat(6000) })
  const result = await loadBatch(harness, { include: 'sections' })
  assert.equal(Array.isArray(result.handoff.sections), true)
  assert.equal(result.handoff.sections[0].id, 'H0')
  assert.equal(result.handoff.sections.length >= 5, true)
  assert.equal(result.handoff.sections.length <= 11, true)
  let total = 0
  for (const section of result.handoff.sections) {
    assert.equal(section.heading.startsWith('## '), true)
    assert.equal(section.text.length <= 1500, true)
    total += section.text.length
  }
  assert.equal(total <= 4000, true)
  const last = result.handoff.sections.at(-1)
  assert.equal(last.id === 'H9' || last.id === '覆盖说明' || last.truncated === true, true)
})

test('load include=full inlines a bounded HANDOFF copy', async () => {
  const harness = makeHarness()
  const created = await createBatch(harness)
  const result = await loadBatch(harness, { batchId: created.batchId, include: 'full' })
  assert.equal(typeof result.handoff.excerpt, 'string')
  assert.equal(result.handoff.excerpt.includes('# 交接包'), true)
  assert.notEqual(result.handoff.truncated, true)
})

test('load verifyFirst=false can only report stale and warns why', async () => {
  const harness = makeHarness()
  await createBatch(harness)
  const result = await loadBatch(harness, { verifyFirst: false })
  assert.equal(result.trust, 'stale')
  assert.equal(result.verification, undefined)
  assert.equal(result.warnings.some((warning) => warning.code === 'VERIFY_SKIPPED'), true)
})

test('load reports stale when a recorded source file changed', async () => {
  const harness = makeHarness()
  await createBatch(harness, { action: 'create', files: ['src/index.js'] })
  harness.fs.addFile('C:\\ws\\src\\index.js', 'export const changed = true\n')
  const result = await loadBatch(harness)
  assert.equal(result.trust, 'stale')
  assert.equal(result.verification.counts.warnings > 0, true)
  assert.equal(
    result.verification.findings.some((finding) => finding.code === 'SOURCE_FILE_CHANGED'),
    true
  )
})

test('load reports invalid when the package was tampered with', async () => {
  const harness = makeHarness()
  const created = await createBatch(harness)
  harness.fs.addFile(`${created.displayDir}\\HANDOFF.md`, '# tampered\n')
  const result = await loadBatch(harness, { batchId: created.batchId })
  assert.equal(result.trust, 'invalid')
  assert.equal(result.verification.ok, false)
  assert.equal(
    result.verification.findings.some((finding) => finding.severity === 'error'),
    true
  )
})

test('load maps a missing batch to HANDOFF_RESUME_NOT_FOUND with a list hint', async () => {
  const harness = makeHarness()
  await assert.rejects(
    () => loadBatch(harness, { batchId: '20261022T000000Z-dead' }),
    (error) => error.code === ERROR.RESUME_NOT_FOUND && /action=list/.test(error.message)
  )
})

test('load tool definition is read-only with its own schema', () => {
  const harness = makeHarness()
  const tool = createLoadTool(harness.service)
  assert.equal(tool.name, LOAD_TOOL_NAME)
  assert.equal(tool.name, 'handoff_load')
  assert.equal(tool.parameters, LOAD_ARGUMENTS_SCHEMA)
  assert.equal(tool.output.schema, LOAD_OUTPUT_SCHEMA)
  assert.equal(tool.timeoutMs, LOAD_TOOL_TIMEOUT_MS)
  assert.equal(tool.isConcurrencySafe({ include: 'full' }), true)
  assert.equal(tool.description.includes('trust'), true)
})

test('load tool validates args and forwards agent/signal to service.load', async () => {
  const calls = []
  const tool = createLoadTool({
    async load(args, exec) {
      calls.push({ args, exec })
      return {
        ok: true,
        batchId: 'b',
        dir: '$DSH_HOME/handoff/x/b',
        displayDir: 'C:\\x',
        trust: 'verified',
        handoff: { path: '$DSH_HOME/handoff/x/b/HANDOFF.md' },
        manifest: { path: '$DSH_HOME/handoff/x/b/manifest.json' },
        pointers: [],
        next: ['read HANDOFF.md'],
        warnings: []
      }
    }
  })
  const agent = { id: 'session-1' }
  const controller = new AbortController()
  const value = await tool.execute({ include: 'sections' }, { agent, signal: controller.signal })
  assert.equal(value.trust, 'verified')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].args.include, 'sections')
  assert.equal(calls[0].args.verifyFirst, true)
  assert.equal(calls[0].exec.agent, agent)
  await assert.rejects(() => tool.execute({ include: 'bogus' }, {}), (error) => error.code === ERROR.INVALID_ARGS)
})

test('load summary text stays short and mentions trust', () => {
  const lines = summarizeLoadResult({
    batchId: '20261022T023512Z-a1b2',
    trust: 'stale',
    verification: { counts: { errors: 0, warnings: 2 } },
    handoff: { path: '$DSH_HOME/handoff/x/b/HANDOFF.md' },
    next: ['run verify']
  })
  assert.equal(lines.length, 3)
  assert.match(lines[0], /trust=stale/)
  assert.match(lines[0], /0 errors, 2 warnings/)
  assert.match(lines[1], /HANDOFF\.md/)

  const skipped = summarizeLoadResult({
    batchId: 'b',
    trust: 'stale',
    handoff: { path: '$DSH_HOME/handoff/x/b/HANDOFF.md' },
    next: ['run verify']
  })
  assert.match(skipped[0], /verification skipped/)
  assert.doesNotMatch(skipped[0], /0 errors/)
})

test('command parses and renders resume', async () => {
  assert.deepEqual(parseCommandInput('resume'), { action: 'resume' })
  assert.deepEqual(parseCommandInput('resume 20261022T023512Z-a1b2 --include sections --target workspace --no-verify'), {
    action: 'resume',
    batchId: '20261022T023512Z-a1b2',
    include: 'sections',
    target: 'workspace',
    verifyFirst: false
  })
  assert.throws(() => parseCommandInput('resume --title x'), (error) => error.code === ERROR.INVALID_ARGS)
  assert.throws(() => parseCommandInput('create --include full'), (error) => error.code === ERROR.INVALID_ARGS)

  const text = formatLoadResult({
    batchId: '20261022T023512Z-a1b2',
    trust: 'stale',
    displayDir: 'C:\\out\\b',
    verification: { counts: { errors: 0, warnings: 2 }, findings: [{ severity: 'warn', code: 'GIT_HEAD_CHANGED' }] },
    handoff: { path: '$DSH_HOME/handoff/x/b/HANDOFF.md' },
    next: ['run verify', 'read H6']
  })
  assert.match(text, /需复核/)
  assert.match(text, /GIT_HEAD_CHANGED/)
  assert.match(text, /handoff_pack verify|run verify/)
})

test('command resume handler calls service.load (not service.run)', async () => {
  const calls = []
  const command = createCommand({
    async run() {
      throw new Error('run must not be called for resume')
    },
    async load(args, exec) {
      calls.push({ args, exec })
      return {
        batchId: '20261022T023512Z-a1b2',
        trust: 'verified',
        displayDir: 'C:\\out\\b',
        verification: { counts: { errors: 0, warnings: 0 }, findings: [] },
        handoff: { path: '$DSH_HOME/handoff/x/b/HANDOFF.md' },
        next: ['read HANDOFF.md']
      }
    }
  })
  const invocation = {
    commandId: 'cmd-1',
    agent: { id: 'session-test' },
    rawInput: 'resume 20261022T023512Z-a1b2 --include sections',
    attachments: [],
    signal: new AbortController().signal
  }
  const result = await command.handler(invocation)
  assert.equal(result.kind, 'success')
  assert.match(result.text, /交接包 20261022T023512Z-a1b2：可信/)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].args.include, 'sections')
  assert.equal(calls[0].args.batchId, '20261022T023512Z-a1b2')
})

test('load reports invalid with findings when manifest is missing', async () => {
  const harness = makeHarness()
  const created = await createBatch(harness)
  harness.fs.drop(`${created.displayDir}\\manifest.json`)
  const result = await loadBatch(harness, { batchId: FIXED_BATCH_ID })
  assert.equal(result.trust, 'invalid')
  assert.equal(result.handoff.path.endsWith('/HANDOFF.md'), true)
  assert.equal(result.warnings.some((warning) => warning.code === 'MANIFEST_MISSING'), true)
})
