/**
 * P3/M5 redaction-policy tests (decision D8).
 *
 * Covers: the strict `$DSH_HOME/handoff/policy.json` schema; append-only merging
 * where built-in rules remain the security floor; denylist extension for
 * collection/copying; custom redaction rules applied to every artifact;
 * `evidence/redactions.json.policy` provenance; and fail-closed behavior
 * (`HANDOFF_POLICY_INVALID`, zero writes) for invalid configurations.
 *
 * @module test/policy
 */

import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

import { ERROR, TOOL_OUTPUT_SCHEMA, validateToolArgs } from '../src/contracts.js'
import { parseManifest } from '../src/manifest.js'
import { sha256Hex } from '../src/paths.js'
import {
  EMPTY_POLICY,
  MAX_POLICY_BYTES,
  POLICY_FILE,
  buildPolicyRedactionRules,
  createPolicyDenied,
  parsePolicyText,
  policyPathFor,
  validatePolicyDocument
} from '../src/policy.js'
import { createService } from '../src/service.js'
import { createFakeCtx } from './helpers/fake-ctx.js'
import {
  FIXED_NOW,
  WORKSPACE_ROOT,
  addGitFixture,
  createFixtureFs,
  fixedClock,
  fixedRandom,
  sampleWorkspaceFiles
} from './helpers/fixtures.js'
import { validateSubset } from './helpers/schema-subset.js'

const DSH_HOME_TEST = 'C:\\Users\\test\\.dsh'
const DSH_HOME_ABS = resolve(DSH_HOME_TEST)

function policyAbsolutePath() {
  return policyPathFor(DSH_HOME_ABS)
}

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
  return { fs, service, exec }
}

function makeHarness({ files, mode = 'danger-full-access' } = {}) {
  const fs = createFixtureFs(files === undefined ? {} : { files })
  addGitFixture(fs)
  return makeServiceFor(fs, { mode })
}

function seedPolicy(fs, policy) {
  const text = typeof policy === 'string' ? policy : `${JSON.stringify(policy, null, 2)}\n`
  fs.addFile(policyAbsolutePath(), text)
  return text
}

async function create(harness, raw = { action: 'create' }) {
  const result = await harness.service.run(validateToolArgs(raw), harness.exec)
  assert.deepEqual(
    validateSubset(TOOL_OUTPUT_SCHEMA, result),
    [],
    `create result violates schema: ${JSON.stringify(result).slice(0, 400)}`
  )
  return result
}

function evidenceFor(harness, created, relativePath) {
  return harness.fs.readFile(
    `${created.displayDir}\\${relativePath.replace(/\//g, '\\')}`
  )
}

function readEvidenceJson(harness, created, relativePath) {
  return JSON.parse(evidenceFor(harness, created, relativePath))
}

function readManifest(harness, created) {
  return parseManifest(evidenceFor(harness, created, 'manifest.json'))
}

// ------------------------------------------------------------- schema + merge

test('the policy schema accepts valid documents and normalizes order/flags', () => {
  assert.deepEqual(validatePolicyDocument({ version: 1 }), {
    version: 1,
    denylist: { paths: [], extensions: [] },
    redaction: { rules: [] }
  })
  const full = validatePolicyDocument({
    version: 1,
    denylist: { paths: ['secrets/', 'config/private'], extensions: ['.KDBX'] },
    redaction: {
      rules: [
        { kind: 'ticket-id', pattern: 'TICKET-[0-9]{4}' },
        { kind: 'employee-id', pattern: 'EMP[0-9]+', flags: 'gi', replacement: '<id>' }
      ]
    }
  })
  assert.deepEqual(full.denylist.paths, ['config/private', 'secrets'])
  assert.deepEqual(full.denylist.extensions, ['.KDBX'])
  assert.deepEqual(full.redaction.rules[0], {
    kind: 'ticket-id',
    pattern: 'TICKET-[0-9]{4}',
    flags: 'g'
  })
  assert.equal(full.redaction.rules[1].flags, 'gi')
  assert.equal(full.redaction.rules[1].replacement, '<id>')

  const rules = buildPolicyRedactionRules(full)
  assert.equal(rules.length, 2)
  assert.equal(rules[0].pattern instanceof RegExp, true)
  assert.equal(rules[0].pattern.flags, 'g')
  assert.equal(rules[1].pattern.flags, 'gi')
})

test('the policy schema is strict and fail-closed on every malformed shape', () => {
  const invalidDocuments = [
    {},
    { version: 2 },
    { version: '1' },
    // Attempts to switch off the built-in safety floor are unknown fields.
    { version: 1, disableBuiltins: true },
    { version: 1, denylist: { files: ['x'] } },
    { version: 1, denylist: { paths: 'secrets' } },
    { version: 1, denylist: { paths: [''] } },
    { version: 1, denylist: { paths: ['../escape'] } },
    { version: 1, denylist: { paths: ['./relative'] } },
    { version: 1, denylist: { paths: ['/absolute'] } },
    { version: 1, denylist: { paths: ['C:/absolute'] } },
    { version: 1, denylist: { paths: ['a\\b'] } },
    { version: 1, denylist: { extensions: ['pem'] } },
    { version: 1, denylist: { extensions: ['.p em'] } },
    { version: 1, denylist: { extensions: ['.a/b'] } },
    { version: 1, redaction: { rules: [{ kind: 'Bad Kind', pattern: 'x' }] } },
    { version: 1, redaction: { rules: [{ kind: 'ok', pattern: '(' }] } },
    { version: 1, redaction: { rules: [{ kind: 'ok', pattern: 'x', flags: 'x' }] } },
    { version: 1, redaction: { rules: [{ kind: 'ok', pattern: 'x', flags: 'gg' }] } },
    { version: 1, redaction: { rules: [{ kind: 'ok', pattern: 'x', extra: 1 }] } },
    { version: 1, redaction: { rules: [{ kind: 'ok', pattern: 'x', replacement: 5 }] } },
    { version: 1, redaction: { rules: 'nope' } }
  ]
  for (const document of invalidDocuments) {
    assert.throws(
      () => validatePolicyDocument(document),
      (error) => error.code === ERROR.POLICY_INVALID,
      `expected HANDOFF_POLICY_INVALID for ${JSON.stringify(document)}`
    )
  }
  assert.throws(
    () => parsePolicyText('{ not json'),
    (error) => error.code === ERROR.POLICY_INVALID
  )
})

test('denylist predicates keep built-ins first and append policy paths/extensions', () => {
  const document = validatePolicyDocument({
    version: 1,
    denylist: { paths: ['secrets/'], extensions: ['.kdbx'] }
  })
  const denied = createPolicyDenied(document)
  // Built-in floor is untouched.
  assert.equal(denied('.env'), 'dot-env')
  assert.equal(denied('node_modules/pkg/index.js'), 'directory:node_modules')
  assert.equal(denied('secret.pem'), 'private-key')
  // Policy additions.
  assert.equal(denied('secrets'), 'policy:path:secrets')
  assert.equal(denied('secrets/notes.txt'), 'policy:path:secrets')
  assert.equal(denied('docs/Secrets/notes.txt'), null) // prefix, not substring
  assert.equal(denied('vault.KDBX'), 'policy:extension:.kdbx')
  assert.equal(denied('src/index.js'), null)
  // The no-policy runtime value is exactly the built-in floor.
  assert.equal(EMPTY_POLICY.denied('.env'), true)
  assert.equal(EMPTY_POLICY.denied('src/index.js'), false)
  assert.deepEqual(buildPolicyRedactionRules(EMPTY_POLICY), [])
})

// ---------------------------------------------------------------- applied policy

test('a valid policy appends denylist entries and custom redaction rules, and records provenance', async () => {
  const files = sampleWorkspaceFiles({
    'docs/runbook.md': 'Escalation: TICKET-1234 only.\n',
    'secrets/notes.txt': 'do not collect me\n',
    'archive.data': 'raw data\n'
  })
  const harness = makeHarness({ files })
  const policy = {
    version: 1,
    denylist: { paths: ['secrets/'], extensions: ['.DATA'] },
    redaction: { rules: [{ kind: 'ticket-id', pattern: 'TICKET-[0-9]{4}', flags: 'g' }] }
  }
  const policyText = seedPolicy(harness.fs, policy)
  const created = await create(harness, {
    action: 'create',
    summary: 'blocked by TICKET-1234',
    copyFiles: true,
    files: ['docs/runbook.md']
  })

  // Appended denylist: policy paths and extensions never reach the evidence list.
  const manifest = readManifest(harness, created)
  const evidencePaths = manifest.files.map((file) => file.path)
  assert.equal(evidencePaths.some((path) => path.startsWith('secrets/')), false)
  assert.equal(evidencePaths.includes('archive.data'), false)
  assert.equal(evidencePaths.includes('docs/runbook.md'), true)

  // Appended redaction rules apply after the built-ins across artifacts.
  const copied = evidenceFor(harness, created, 'evidence/files/docs/runbook.md')
  assert.doesNotMatch(copied, /TICKET-1234/)
  assert.match(copied, /«REDACTED:ticket-id»/)
  const handoff = evidenceFor(harness, created, 'HANDOFF.md')
  assert.doesNotMatch(handoff, /TICKET-1234/)
  assert.match(handoff, /«REDACTED:ticket-id»/)
  assert.equal(
    created.redactions.some((row) => row.kind === 'ticket-id' && row.count > 0),
    true
  )

  // Provenance lives in evidence/redactions.json only (manifest schema unchanged).
  const redactions = readEvidenceJson(harness, created, 'evidence/redactions.json')
  assert.deepEqual(redactions.policy, {
    sha256: sha256Hex(policyText),
    source: '$DSH_HOME/handoff/policy.json'
  })
  assert.equal(manifest.policy, undefined)
  assert.equal(readManifest(harness, created).schemaVersion, 2)
})

test('without a policy the batch keeps rc.2 behavior with explicit null provenance', async () => {
  const harness = makeHarness()
  const created = await create(harness, { action: 'create', summary: 'plain batch' })
  const redactions = readEvidenceJson(harness, created, 'evidence/redactions.json')
  assert.deepEqual(redactions.policy, { sha256: null, source: null })
  assert.deepEqual(redactions.redactions, created.redactions)
  assert.equal(harness.fs.has(policyAbsolutePath()), false)
})

test('the policy denylist rejects explicit evidence paths and applies to target=workspace too', async () => {
  const harness = makeHarness()
  seedPolicy(harness.fs, { version: 1, denylist: { paths: ['secrets'] } })
  await assert.rejects(
    () =>
      harness.service.run(
        validateToolArgs({ action: 'create', files: ['secrets/notes.txt'] }),
        harness.exec
      ),
    (error) => error.code === ERROR.PATH_ESCAPE && /policy:path:secrets/.test(error.message)
  )
  assert.equal(harness.fs.writeCount(), 0)

  const workspaceHarness = makeHarness({ mode: 'workspace-write' })
  const policyText = seedPolicy(workspaceHarness.fs, {
    version: 1,
    redaction: { rules: [{ kind: 'ticket-id', pattern: 'TICKET-[0-9]{4}' }] }
  })
  const created = await create(workspaceHarness, {
    action: 'create',
    target: 'workspace',
    summary: 'TICKET-9999'
  })
  assert.match(created.dir, /^\$WORKSPACE\/\.dsh\/handoff\//)
  const redactions = readEvidenceJson(workspaceHarness, created, 'evidence/redactions.json')
  // The policy file is always user-level, even for a workspace-target batch.
  assert.deepEqual(redactions.policy, {
    sha256: sha256Hex(policyText),
    source: '$DSH_HOME/handoff/policy.json'
  })
  assert.doesNotMatch(evidenceFor(workspaceHarness, created, 'HANDOFF.md'), /TICKET-9999/)
})

test('built-in redaction rules cannot be disabled or overridden by a policy', async () => {
  const files = sampleWorkspaceFiles({
    'src/secret-config.js': 'export const password = "hunter2secret"\n'
  })
  const harness = makeHarness({ files })
  // A rule that tries to catch the same secret with a weaker replacement is
  // appended AFTER the built-ins: the built-in placeholder is already in place,
  // so the custom rule cannot "win" and no secret text survives.
  seedPolicy(harness.fs, {
    version: 1,
    redaction: {
      rules: [
        { kind: 'env-assignment', pattern: 'hunter2secret', flags: 'g', replacement: 'LEAKED' }
      ]
    }
  })
  const created = await create(harness, {
    action: 'create',
    copyFiles: true,
    files: ['src/secret-config.js']
  })
  const copied = evidenceFor(harness, created, 'evidence/files/src/secret-config.js')
  assert.doesNotMatch(copied, /hunter2secret/)
  assert.match(copied, /«REDACTED:conn-string-password»/)
  assert.doesNotMatch(copied, /LEAKED/)
  // The appended rule never matched, so it is not recorded under its own kind.
  const kinds = created.redactions.map((row) => row.kind)
  assert.equal(kinds.includes('conn-string-password'), true)
  assert.equal(kinds.includes('env-assignment'), false)
})

// ------------------------------------------------------------- fail-closed

test('invalid or unreadable policy files fail closed with HANDOFF_POLICY_INVALID and zero writes', async () => {
  const cases = [
    ['malformed JSON', '{ not json'],
    ['unknown key', JSON.stringify({ version: 1, allowDisablingBuiltins: true })],
    ['bad version', JSON.stringify({ version: 3 })],
    ['bad regex', JSON.stringify({ version: 1, redaction: { rules: [{ kind: 'x', pattern: '(' }] } })],
    ['bad flags', JSON.stringify({ version: 1, redaction: { rules: [{ kind: 'x', pattern: 'a', flags: 'u' }] } })],
    ['absolute denylist path', JSON.stringify({ version: 1, denylist: { paths: ['C:/Windows'] } })],
    ['traversal denylist path', JSON.stringify({ version: 1, denylist: { paths: ['../up'] } })]
  ]
  for (const [label, text] of cases) {
    const harness = makeHarness()
    seedPolicy(harness.fs, text)
    const before = harness.fs.snapshot()
    await assert.rejects(
      () => harness.service.run(validateToolArgs({ action: 'create' }), harness.exec),
      (error) => error.code === ERROR.POLICY_INVALID,
      `expected fail-closed for ${label}`
    )
    assert.equal(harness.fs.writeCount(), 0, `no writes for ${label}`)
    assert.deepEqual(harness.fs.snapshot(), before, `tree unchanged for ${label}`)
  }

  // A directory where the policy file is expected, and an oversized file, are
  // also fail-closed instead of silently ignored.
  const directoryHarness = makeHarness()
  directoryHarness.fs.addDirectory(policyAbsolutePath())
  await assert.rejects(
    () => directoryHarness.service.run(validateToolArgs({ action: 'create' }), directoryHarness.exec),
    (error) => error.code === ERROR.POLICY_INVALID
  )
  assert.equal(directoryHarness.fs.writeCount(), 0)

  const oversizeHarness = makeHarness()
  seedPolicy(oversizeHarness.fs, 'x'.repeat(MAX_POLICY_BYTES + 1))
  await assert.rejects(
    () => oversizeHarness.service.run(validateToolArgs({ action: 'create' }), oversizeHarness.exec),
    (error) => error.code === ERROR.POLICY_INVALID
  )
  assert.equal(oversizeHarness.fs.writeCount(), 0)
})

test('scan surfaces an invalid policy (fail-closed) without writing', async () => {
  const harness = makeHarness()
  seedPolicy(harness.fs, '{}')
  await assert.rejects(
    () => harness.service.run(validateToolArgs({ action: 'scan' }), harness.exec),
    (error) => error.code === ERROR.POLICY_INVALID
  )
  assert.equal(harness.fs.writeCount(), 0)
})

test('append/update read the policy and fail closed when it becomes invalid', async () => {
  const harness = makeHarness()
  const first = await create(harness, { action: 'create', title: 'base' })
  // A later clock/suffix mints a distinct batch id for append/update.
  const later = makeServiceFor(harness.fs, {
    now: () => new Date(FIXED_NOW.getTime() + 60_000),
    suffix: () => 'beef'
  })

  const policyText = seedPolicy(harness.fs, {
    version: 1,
    redaction: { rules: [{ kind: 'ticket-id', pattern: 'TICKET-[0-9]{4}' }] }
  })
  const appended = await create(later, {
    action: 'append',
    title: 'next',
    summary: 'follow-up TICKET-4321'
  })
  assert.equal(appended.action, 'append')
  assert.equal(appended.lineage.previous, first.batchId)
  const appendedRedactions = readEvidenceJson(harness, appended, 'evidence/redactions.json')
  assert.equal(appendedRedactions.policy.sha256, sha256Hex(policyText))
  assert.equal(appendedRedactions.policy.source, '$DSH_HOME/handoff/policy.json')
  assert.doesNotMatch(evidenceFor(harness, appended, 'HANDOFF.md'), /TICKET-4321/)

  const writesBefore = harness.fs.writeCount()
  seedPolicy(harness.fs, JSON.stringify({ version: 1, redaction: { rules: [{ kind: 'x', pattern: '(' }] } }))
  await assert.rejects(
    () => later.service.run(validateToolArgs({ action: 'update' }), later.exec),
    (error) => error.code === ERROR.POLICY_INVALID
  )
  assert.equal(harness.fs.writeCount(), writesBefore, 'fail-closed update must not write')
})
