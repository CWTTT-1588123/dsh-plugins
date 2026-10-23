import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import {
  ACTIONS,
  ERROR,
  LIMITS,
  PLUGIN_VERSION,
  SCHEMA_VERSION,
  TARGETS,
  TOOL_ARGUMENTS_SCHEMA,
  TOOL_DESCRIPTION,
  TOOL_NAME,
  TOOL_OUTPUT_SCHEMA,
  detectDshVersion,
  errorCodeOf,
  generatorIdentity,
  handoffError,
  isHandoffError,
  publicLimits,
  validateToolArgs
} from '../src/contracts.js'
import { validateSchemaSubset } from './helpers/schema-subset.js'

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('package metadata matches the contracts version and bundle marker', () => {
  assert.equal(packageJson.name, 'dsh-handoff-kit')
  assert.equal(packageJson.version, PLUGIN_VERSION)
  // M4: the package is publishable (private removed) and carries release metadata.
  assert.notEqual(packageJson.private, true)
  assert.equal(packageJson.license, 'MIT')
  assert.match(packageJson.repository.url, /github\.com[:/]CWTTT-1588123\/dsh-plugins/)
  assert.equal(packageJson.repository.directory, 'plugins/dsh-handoff-kit')
  assert.equal(packageJson.bin['handoff-kit'], './bin/handoff-kit.mjs')
  assert.equal(packageJson.engines.node, '>=20')
  assert.equal(packageJson.type, 'module')
  assert.equal(packageJson.main, 'index.js')
  assert.deepEqual(packageJson.dsh.bundle, { patch: './cordis.patch.yml' })
  // P2: the same package carries a plain-JS Client half (no build step).
  assert.equal(packageJson.dsh.client.platform, 'web')
  assert.equal(packageJson.dsh.client.immediately, true)
  assert.deepEqual(packageJson.dsh.client.inject, ['@deepseek-ai/dsh-client-ui-conversation'])
  assert.equal(packageJson.exports['./client'], './client.js')
  assert.equal(packageJson.dependencies, undefined)
  assert.equal(packageJson.devDependencies, undefined)
})

test('tool identity is stable', () => {
  assert.equal(TOOL_NAME, 'handoff_pack')
  assert.deepEqual([...ACTIONS], ['scan', 'create', 'verify', 'list', 'append', 'update', 'migrate', 'delete'])
  assert.deepEqual([...TARGETS], ['user', 'workspace'])
  assert.equal(SCHEMA_VERSION, 1)
  assert.equal(typeof TOOL_DESCRIPTION, 'string')
  assert.match(TOOL_DESCRIPTION, /HANDOFF\.md/)
  assert.match(TOOL_DESCRIPTION, /manifest\.json/)
})

test('argument schema belongs to the enforced JSON Schema subset', () => {
  assert.deepEqual(validateSchemaSubset(TOOL_ARGUMENTS_SCHEMA), [])
  assert.equal(TOOL_ARGUMENTS_SCHEMA.type, 'object')
  assert.equal(TOOL_ARGUMENTS_SCHEMA.additionalProperties, false)
  assert.deepEqual(TOOL_ARGUMENTS_SCHEMA.required, ['action'])
  assert.deepEqual(TOOL_ARGUMENTS_SCHEMA.properties.action.enum, ['scan', 'create', 'verify', 'list', 'append', 'update', 'migrate', 'delete'])
  assert.deepEqual(TOOL_ARGUMENTS_SCHEMA.properties.target.enum, ['user', 'workspace'])
})

test('output schema belongs to the enforced JSON Schema subset and is object-rooted', () => {
  assert.deepEqual(validateSchemaSubset(TOOL_OUTPUT_SCHEMA), [])
  assert.equal(TOOL_OUTPUT_SCHEMA.type, 'object')
  assert.equal(TOOL_OUTPUT_SCHEMA.additionalProperties, false)
})

test('validateToolArgs applies documented defaults without mutating input', () => {
  const raw = { action: 'scan' }
  const args = validateToolArgs(raw)
  assert.deepEqual(raw, { action: 'scan' })
  assert.equal(args.action, 'scan')
  assert.equal(args.target, 'user')
  assert.equal(args.copyFiles, false)
  assert.equal(args.all, false)
  assert.equal(args.force, false)
  assert.equal(args.title, undefined)
  assert.deepEqual(args.decisions, [])
  assert.deepEqual(args.files, [])
})

test('validateToolArgs accepts a full create argument set', () => {
  const args = validateToolArgs({
    action: 'create',
    target: 'workspace',
    title: 'P0 handoff',
    goal: 'Ship the plugin',
    summary: 'Implemented modules and tests.',
    decisions: ['no subprocess', 'hash evidence'],
    nextSteps: ['install'],
    concepts: ['batch-id'],
    flow: ['scan', 'create', 'verify'],
    risks: ['no mtime'],
    files: ['README.md', 'src/index.js'],
    copyFiles: true,
    force: true
  })
  assert.equal(args.target, 'workspace')
  assert.equal(args.copyFiles, true)
  assert.equal(args.force, true)
  assert.deepEqual(args.files, ['README.md', 'src/index.js'])
  assert.equal(args.batchId, undefined)
})

test('validateToolArgs rejects malformed calls', () => {
  const cases = [
    undefined,
    null,
    'create',
    [],
    {},
    { action: 'generate' },
    { action: 'scan', target: 'auto' },
    { action: 'scan', unknown: true },
    { action: 'scan', title: 'x'.repeat(201) },
    { action: 'scan', goal: 'x'.repeat(4001) },
    { action: 'scan', summary: 'x'.repeat(8001) },
    { action: 'scan', decisions: 'not-an-array' },
    { action: 'scan', decisions: new Array(51).fill('x') },
    { action: 'scan', decisions: [42] },
    { action: 'create', batchId: '20261022T023512Z-a1b2' },
    { action: 'scan', batchId: '20261022T023512Z-a1b2' },
    { action: 'verify', batchId: 'bad' },
    { action: 'scan', all: true },
    { action: 'verify', force: true },
    { action: 'scan', copyFiles: 'yes' },
    { action: 'scan', files: new Array(201).fill('a') }
  ]
  for (const raw of cases) {
    assert.throws(
      () => validateToolArgs(raw),
      (error) => error.code === ERROR.INVALID_ARGS,
      `expected HANDOFF_INVALID_ARGS for ${JSON.stringify(raw)?.slice(0, 60)}`
    )
  }
})

test('batchId is accepted for verify and list only', () => {
  const batchId = '20261022T023512Z-a1b2'
  assert.equal(validateToolArgs({ action: 'verify', batchId }).batchId, batchId)
  assert.equal(validateToolArgs({ action: 'list', batchId }).batchId, batchId)
})

test('handoffError is structured and routable', () => {
  const error = handoffError(ERROR.READ_ONLY, 'session is read-only')
  assert.equal(error.name, 'HandoffError')
  assert.equal(error.code, 'HANDOFF_READ_ONLY')
  assert.equal(error.message, 'HANDOFF_READ_ONLY: session is read-only')
  assert.equal(error.detail, 'session is read-only')
  assert.equal(isHandoffError(error), true)
  assert.equal(errorCodeOf(error), ERROR.READ_ONLY)
  assert.equal(errorCodeOf(new Error('plain')), ERROR.INTERNAL)
  assert.equal(errorCodeOf({ code: 'FS_SANDBOX_DENIED' }), 'FS_SANDBOX_DENIED')
})

test('generator identity and public limits are stable', () => {
  assert.deepEqual(generatorIdentity(), {
    name: 'dsh-handoff-kit',
    version: PLUGIN_VERSION,
    dshVersion: 'unknown',
    platform: 'unknown'
  })
  const limits = publicLimits()
  assert.equal(limits.maxEntries, LIMITS.maxEntries)
  assert.equal(limits.maxDepth, 4)
  assert.equal(limits.maxSessionEvents, 2000)
  assert.equal(limits.maxCommandChars, 300)
  assert.equal(limits.maxFileBytes, 4 * 1024 * 1024)
})

test('detectDshVersion prefers an explicit environment value then the reader', () => {
  assert.equal(detectDshVersion({ DSH_VERSION: ' 0.9.9 ' }), '0.9.9')
  assert.equal(detectDshVersion({}), 'unknown')
  assert.equal(detectDshVersion({}, () => '0.2.1-rc.2'), '0.2.1-rc.2')
  assert.equal(
    detectDshVersion({}, () => {
      throw new Error('no installation manifest')
    }),
    'unknown'
  )
  assert.equal(detectDshVersion({}, () => '  '), 'unknown')
})
