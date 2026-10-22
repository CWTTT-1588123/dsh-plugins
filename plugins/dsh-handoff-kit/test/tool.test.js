import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ERROR, TOOL_ARGUMENTS_SCHEMA, TOOL_NAME, TOOL_OUTPUT_SCHEMA } from '../src/contracts.js'
import { createTool, summarizeResult } from '../src/tool.js'
import { validateSchemaSubset } from './helpers/schema-subset.js'

function serviceStub(result = { ok: true, action: 'scan', warnings: [], totals: {}, next: [], limits: {} }) {
  const calls = []
  return {
    calls,
    async run(args, exec) {
      calls.push({ args, exec })
      return result
    }
  }
}

test('tool definition carries the documented schema, timeout and concurrency flag', () => {
  const tool = createTool(serviceStub())
  assert.equal(tool.name, TOOL_NAME)
  assert.match(tool.description, /HANDOFF\.md/)
  assert.equal(tool.parameters, TOOL_ARGUMENTS_SCHEMA)
  assert.equal(tool.output.schema, TOOL_OUTPUT_SCHEMA)
  assert.equal(typeof tool.output.render, 'function')
  assert.equal(tool.timeoutMs, 120000)
  assert.deepEqual(validateSchemaSubset(tool.output.schema), [])
})

test('isConcurrencySafe keeps create exclusive and reads parallel', () => {
  const tool = createTool(serviceStub())
  assert.equal(tool.isConcurrencySafe({ action: 'create' }), false)
  assert.equal(tool.isConcurrencySafe({ action: 'scan' }), true)
  assert.equal(tool.isConcurrencySafe({ action: 'verify' }), true)
  assert.equal(tool.isConcurrencySafe({ action: 'list' }), true)
  assert.equal(tool.isConcurrencySafe(null), true)
})

test('execute validates arguments and forwards the agent/signal to the service', async () => {
  const service = serviceStub({ ok: true, action: 'verify', warnings: [], totals: {}, next: [], limits: {} })
  const tool = createTool(service)
  const agent = { id: 'session-1' }
  const controller = new AbortController()
  const value = await tool.execute(
    { action: 'verify', batchId: '20261022T023512Z-a1b2' },
    { agent, signal: controller.signal }
  )
  assert.equal(value.action, 'verify')
  assert.equal(service.calls.length, 1)
  assert.equal(service.calls[0].args.action, 'verify')
  assert.equal(service.calls[0].args.batchId, '20261022T023512Z-a1b2')
  assert.equal(service.calls[0].args.target, 'user')
  assert.equal(service.calls[0].args.copyFiles, false)
  assert.equal(service.calls[0].exec.agent, agent)
  assert.equal(service.calls[0].exec.signal, controller.signal)
})

test('execute rejects malformed arguments before the service runs', async () => {
  const service = serviceStub()
  const tool = createTool(service)
  for (const args of [undefined, {}, { action: 'generate' }, { action: 'scan', unknown: 1 }]) {
    await assert.rejects(
      () => tool.execute(args, {}),
      (error) => error.code === ERROR.INVALID_ARGS
    )
  }
  assert.equal(service.calls.length, 0)
})

test('summarizeResult renders one to three lines per action', () => {
  const scan = summarizeResult({
    action: 'scan',
    warnings: [],
    scan: { entries: 10, files: [1, 2] },
    totals: {}
  })
  assert.equal(scan.length, 1)
  assert.match(scan[0], /10 entries/)
  assert.match(scan[0], /nothing written/)

  const create = summarizeResult({
    action: 'create',
    batchId: '20261022T023512Z-a1b2',
    displayDir: 'C:\\out\\batch',
    artifacts: [{}, {}, {}],
    totals: { artifactBytes: 1234 },
    warnings: [{ code: 'X', detail: 'y' }]
  })
  assert.equal(create.length, 3)
  assert.match(create[0], /20261022T023512Z-a1b2/)
  assert.match(create[1], /verify/)
  assert.match(create[2], /1 warning/)

  const append = summarizeResult({
    action: 'append',
    batchId: 'b2',
    displayDir: 'C:\\out\\b2',
    artifacts: [{}],
    totals: { artifactBytes: 10 },
    lineage: { sequence: 2, previous: 'b1', root: 'b1' },
    warnings: []
  })
  assert.match(append[0], /appended/)
  assert.match(append[1], /sequence 2, previous b1/)

  const verify = summarizeResult({
    action: 'verify',
    verification: { batchId: 'b1', ok: false, counts: { errors: 2, warnings: 1 } },
    warnings: []
  })
  assert.match(verify[0], /FAILED/)
  assert.match(verify[0], /2 errors/)

  const list = summarizeResult({ action: 'list', batches: [{}, {}], warnings: [] })
  assert.match(list[0], /2 batch/)
})

test('output.render returns a single text content block', () => {
  const tool = createTool(serviceStub())
  const blocks = tool.output.render({}, { action: 'list', batches: [], warnings: [] })
  assert.equal(Array.isArray(blocks), true)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'text')
  assert.equal(typeof blocks[0].text, 'string')
})
