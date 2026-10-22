import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  COMMAND_DESCRIPTION,
  COMMAND_HINT,
  createCommand,
  formatError,
  formatResult,
  parseCommandInput
} from '../src/command.js'
import { ERROR, handoffError, validateToolArgs } from '../src/contracts.js'

function invocation(rawInput) {
  const controller = new AbortController()
  return {
    commandId: 'command-1',
    agent: { id: 'session-test' },
    rawInput,
    attachments: [],
    signal: controller.signal
  }
}

test('parseCommandInput defaults to create and understands actions', () => {
  assert.deepEqual(parseCommandInput(''), { action: 'create' })
  assert.deepEqual(parseCommandInput('   '), { action: 'create' })
  assert.deepEqual(parseCommandInput('scan'), { action: 'scan' })
  assert.deepEqual(parseCommandInput('create'), { action: 'create' })
  assert.deepEqual(parseCommandInput('verify 20261022T023512Z-a1b2'), {
    action: 'verify',
    batchId: '20261022T023512Z-a1b2'
  })
  assert.deepEqual(parseCommandInput('20261022T023512Z-a1b2'), {
    action: 'verify',
    batchId: '20261022T023512Z-a1b2'
  })
  assert.deepEqual(parseCommandInput('list'), { action: 'list' })
})

test('parseCommandInput parses value flags, quoted text and booleans', () => {
  const raw = parseCommandInput('create --target workspace --title "P0 交接 包" --force')
  assert.deepEqual(raw, {
    action: 'create',
    target: 'workspace',
    title: 'P0 交接 包',
    force: true
  })
  const list = parseCommandInput('list --all')
  assert.deepEqual(list, { action: 'list', all: true })
  const verify = parseCommandInput('verify --batch 20261022T023512Z-a1b2')
  assert.deepEqual(verify, { action: 'verify', batchId: '20261022T023512Z-a1b2' })
  const copy = parseCommandInput('create --copy-files')
  assert.deepEqual(copy, { action: 'create', copyFiles: true })
})

test('parseCommandInput rejects unknown options, missing values and extra positionals', () => {
  for (const input of ['create --unknown', 'create --target', 'scan extra', 'list a b']) {
    assert.throws(
      () => parseCommandInput(input),
      (error) => error.code === ERROR.INVALID_ARGS,
      `expected HANDOFF_INVALID_ARGS for ${JSON.stringify(input)}`
    )
  }
})

test('parseCommandInput output runs through the shared argument validator', () => {
  const raw = parseCommandInput('create --target workspace --title hi --force')
  const args = validateToolArgs(raw)
  assert.equal(args.action, 'create')
  assert.equal(args.target, 'workspace')
  assert.equal(args.force, true)
  assert.throws(
    () => validateToolArgs(parseCommandInput('scan --target auto')),
    (error) => error.code === ERROR.INVALID_ARGS
  )
})

test('command definition exposes the documented name, description and hint', () => {
  const command = createCommand({ async run() {} })
  assert.equal(command.name, 'handoff')
  assert.equal(command.description, COMMAND_DESCRIPTION)
  assert.equal(command.input.hint, COMMAND_HINT)
  assert.match(COMMAND_HINT, /--target user\|workspace/)
})

test('handler returns a Chinese success summary and never throws', async () => {
  const calls = []
  const command = createCommand({
    async run(args, exec) {
      calls.push({ args, exec })
      return {
        ok: true,
        action: 'create',
        dir: '$DSH_HOME/handoff/demo-1234abcd/20261022T023512Z-a1b2',
        displayDir: 'C:\\Users\\test\\.dsh\\handoff\\demo-1234abcd\\20261022T023512Z-a1b2',
        batchId: '20261022T023512Z-a1b2',
        artifacts: [{ path: 'HANDOFF.md', bytes: 10, sha256: 'abcdef0123456789' }],
        totals: { artifactBytes: 10 },
        warnings: [{ code: 'NO_MTIME_API', detail: 'x' }],
        next: ['read HANDOFF.md']
      }
    }
  })
  const result = await command.handler(invocation('create --title demo'))
  assert.equal(result.kind, 'success')
  assert.match(result.text, /交接包已生成/)
  assert.match(result.text, /abcdef012345/)
  assert.match(result.text, /1 个 warning/)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].args.action, 'create')
  assert.equal(calls[0].exec.agent.id, 'session-test')
})

test('handler converts thrown failures into kind:error text with code and remedy', async () => {
  const command = createCommand({
    async run() {
      throw handoffError(ERROR.SANDBOX_DENIED, 'target=user needs danger-full-access')
    }
  })
  const result = await command.handler(invocation('create'))
  assert.equal(result.kind, 'error')
  assert.match(result.text, /HANDOFF_SANDBOX_DENIED/)
  assert.match(result.text, /修法/)
  assert.match(result.text, /target=workspace/)
})

test('formatError covers every documented error code', () => {
  for (const code of Object.values(ERROR)) {
    const text = formatError(handoffError(code, 'boom'))
    assert.match(text, new RegExp(code))
    assert.match(text, /修法/)
  }
  const unknown = formatError(new Error('plain failure'))
  assert.match(unknown, /HANDOFF_INTERNAL/)
})

test('formatResult covers verify and list output', () => {
  const verify = formatResult({
    action: 'verify',
    displayDir: 'C:\\out\\batch',
    verification: {
      ok: false,
      batchId: '20261022T023512Z-a1b2',
      counts: { errors: 1, warnings: 2 },
      findings: [{ severity: 'error', code: 'ARTIFACT_HASH_MISMATCH', path: 'HANDOFF.md' }]
    }
  })
  assert.match(verify, /失败/)
  assert.match(verify, /ARTIFACT_HASH_MISMATCH/)
  const list = formatResult({
    action: 'list',
    batches: [
      { batchId: '20261022T023512Z-a1b2', complete: true, title: 'demo' },
      { batchId: '20261021T000000Z-0000', complete: false, title: null }
    ]
  })
  assert.match(list, /2 个/)
  assert.match(list, /不完整/)
})
