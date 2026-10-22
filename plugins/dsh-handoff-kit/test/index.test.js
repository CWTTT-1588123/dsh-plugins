import assert from 'node:assert/strict'
import { test } from 'node:test'

import { name, inject, apply, detectInstalledDshVersion } from '../index.js'
import { createFakeCtx } from './helpers/fake-ctx.js'
import { createFixtureFs } from './helpers/fixtures.js'

test('index exports the bundle identity and hard dependencies', () => {
  assert.equal(name, 'dsh-handoff-kit')
  assert.deepEqual(inject, ['tools', 'commands', 'skills', 'fs', 'sessions', 'sandboxPolicy'])
})

test('apply registers exactly one tool, one command and one skill provider', () => {
  const ctx = createFakeCtx({ fs: createFixtureFs() })
  apply(ctx)
  assert.equal(ctx.registered.tools.length, 1)
  assert.equal(ctx.registered.tools[0].name, 'handoff_pack')
  assert.equal(ctx.registered.commands.length, 1)
  assert.equal(ctx.registered.commands[0].name, 'handoff')
  assert.equal(ctx.registered.skillProviders.length, 1)
  assert.equal(typeof ctx.registered.skillProviders[0], 'function')
})

test('the registered tool works end to end against the fake context (scan only, no writes)', async () => {
  const ctx = createFakeCtx({ fs: createFixtureFs(), mode: 'danger-full-access' })
  apply(ctx)
  const tool = ctx.registered.tools[0]
  const result = await tool.execute(
    { action: 'scan' },
    { agent: { id: 'session-test' }, signal: new AbortController().signal }
  )
  assert.equal(result.ok, true)
  assert.equal(result.action, 'scan')
  assert.equal(result.preview.truncated, false)
  assert.equal(ctx.fs.writeCount(), 0)
})

test('the registered command returns a Chinese error for an invalid option', async () => {
  const ctx = createFakeCtx({ fs: createFixtureFs() })
  apply(ctx)
  const command = ctx.registered.commands[0]
  const result = await command.handler({
    commandId: 'command-1',
    agent: { id: 'session-test' },
    rawInput: 'create --unknown',
    attachments: [],
    signal: new AbortController().signal
  })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /HANDOFF_INVALID_ARGS/)
})

test('dispose unregisters every effect without throwing', async () => {
  const ctx = createFakeCtx({ fs: createFixtureFs() })
  apply(ctx)
  await ctx.dispose()
})

test('detectInstalledDshVersion returns a string or undefined and never throws', () => {
  const value = detectInstalledDshVersion()
  assert.equal(value === undefined || typeof value === 'string', true)
  if (typeof value === 'string') assert.match(value, /^\d+\.\d+\.\d+/)
})
