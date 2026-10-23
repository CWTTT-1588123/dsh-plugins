/**
 * P3/M5 signature tests (decision D7).
 *
 * Covers: envelope shape and `keyId = sha256(publicKey PEM)[:16]`; the four
 * result-level signature states (`unsigned`, `valid`, `untrusted`, `invalid`)
 * over a real fake-filesystem batch; the `SIGNATURE_INVALID` error finding and
 * its effect on `trust`; the CLI `sign` command and the `--pubkey` trust source
 * on the real filesystem; and the read-only audit receipt.
 *
 * Private keys are generated per test and only ever written into an OS temp
 * directory (CLI) or used in memory (service); none of them enters a batch.
 *
 * @module test/signature
 */

import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

import {
  ERROR,
  LOAD_OUTPUT_SCHEMA,
  PLUGIN_VERSION,
  TOOL_OUTPUT_SCHEMA,
  validateLoadArgs,
  validateToolArgs
} from '../src/contracts.js'
import {
  EXIT,
  loadBatch,
  parseArgv,
  runCli
} from '../src/cli.js'
import { createService } from '../src/service.js'
import {
  SIGNATURE_FILE,
  computeKeyId,
  createSignatureEnvelope,
  evaluateSignature,
  parseTrustedKeys,
  publicKeyEntry
} from '../src/signature.js'
import { sha256Hex } from '../src/paths.js'
import { createFakeCtx } from './helpers/fake-ctx.js'
import { writeBatchFixture } from './helpers/cli-batch-fixture.js'
import {
  FIXED_BATCH_ID,
  FIXED_NOW_ISO,
  WORKSPACE_ROOT,
  addGitFixture,
  createFixtureFs,
  fixedClock,
  fixedRandom
} from './helpers/fixtures.js'
import { validateSubset } from './helpers/schema-subset.js'

const DSH_HOME_TEST = 'C:\\Users\\test\\.dsh'
const HANDOFF_ROOT = join(resolve(DSH_HOME_TEST), 'handoff')

/** Generate an Ed25519 key pair and export both halves as PEM. */
function makeKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' })
  }
}

function makeHarness() {
  const fs = createFixtureFs()
  addGitFixture(fs)
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

async function runVerify(harness, batchId) {
  const result = await harness.service.run(validateToolArgs({ action: 'verify', batchId }), harness.exec)
  assert.deepEqual(
    validateSubset(TOOL_OUTPUT_SCHEMA, result),
    [],
    `verify result violates schema: ${JSON.stringify(result).slice(0, 400)}`
  )
  return result
}

async function createBatch(harness) {
  return harness.service.run(validateToolArgs({ action: 'create', title: 'signed batch' }), harness.exec)
}

/** Write a trusted-key list into the fake `$DSH_HOME/handoff` directory. */
function seedTrustedKeys(fs, publicKeys) {
  const keys = publicKeys.map((publicKey) => (typeof publicKey === 'string' ? { publicKey } : publicKey))
  fs.addFile(join(HANDOFF_ROOT, 'trusted-keys.json'), `${JSON.stringify({ keys }, null, 2)}\n`)
}

/** Sign one fake-filesystem batch by writing `signature.json` next to SHA256SUMS. */
function signFakeBatch(fs, created, privateKeyPem, createdAt = FIXED_NOW_ISO) {
  const sumsText = fs.readFile(`${created.displayDir}\\SHA256SUMS`)
  assert.notEqual(sumsText, undefined)
  const envelope = createSignatureEnvelope({
    sumsBytes: Buffer.from(sumsText, 'utf8'),
    privateKeyPem,
    createdAt
  })
  fs.addFile(`${created.displayDir}\\${SIGNATURE_FILE}`, `${JSON.stringify(envelope, null, 2)}\n`)
  return envelope
}

/** Read the envelope that was written into the fake batch (for tampering tests). */
function readFakeEnvelope(fs, created) {
  return JSON.parse(fs.readFile(`${created.displayDir}\\${SIGNATURE_FILE}`))
}

function writeFakeEnvelope(fs, created, envelope) {
  fs.addFile(`${created.displayDir}\\${SIGNATURE_FILE}`, `${JSON.stringify(envelope, null, 2)}\n`)
}

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-signature-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function makeIo() {
  const out = []
  const err = []
  return {
    stdout: { write: (text) => out.push(text) },
    stderr: { write: (text) => err.push(text) },
    out: () => out.join(''),
    err: () => err.join('')
  }
}

async function run(argv) {
  const io = makeIo()
  const code = await runCli(argv, { stdout: io.stdout, stderr: io.stderr })
  return { code, out: io.out(), err: io.err() }
}

// ---------------------------------------------------------------- module layer

test('envelope shape, keyId definition and signature verification are deterministic', () => {
  const pair = makeKeyPair()
  const sumsBytes = Buffer.from('a'.repeat(64) + '  HANDOFF.md\n', 'utf8')
  const envelope = createSignatureEnvelope({
    sumsBytes,
    privateKeyPem: pair.privateKeyPem,
    createdAt: FIXED_NOW_ISO
  })
  assert.deepEqual(Object.keys(envelope), [
    'alg',
    'keyId',
    'publicKey',
    'signature',
    'signedFile',
    'signedSha256',
    'createdAt'
  ])
  assert.equal(envelope.alg, 'ed25519')
  assert.equal(envelope.signedFile, 'SHA256SUMS')
  assert.equal(envelope.keyId, computeKeyId(pair.publicKeyPem))
  assert.match(envelope.keyId, /^[0-9a-f]{16}$/)
  assert.equal(envelope.publicKey, pair.publicKeyPem)
  assert.equal(envelope.signedSha256, sha256Hex(sumsBytes))
  assert.equal(Buffer.from(envelope.signature, 'base64').length, 64)
  assert.equal(envelope.createdAt, FIXED_NOW_ISO)

  const trusted = [publicKeyEntry(pair.publicKeyPem)]
  const valid = evaluateSignature({ signatureText: JSON.stringify(envelope), sumsBytes, trustedKeys: trusted })
  assert.deepEqual(valid, { status: 'valid', keyId: envelope.keyId })
  const untrusted = evaluateSignature({ signatureText: JSON.stringify(envelope), sumsBytes })
  assert.equal(untrusted.status, 'untrusted')
  assert.equal(untrusted.keyId, envelope.keyId)
  assert.match(untrusted.detail, /not in the trusted key set/)

  assert.equal(evaluateSignature({ sumsBytes }).status, 'unsigned')
  const stale = evaluateSignature({
    signatureText: JSON.stringify(envelope),
    sumsBytes: Buffer.from('different sums\n', 'utf8'),
    trustedKeys: trusted
  })
  assert.equal(stale.status, 'invalid')
  assert.match(stale.detail, /signedSha256/)
})

test('trusted-key list accepts omitted keyId and rejects malformed entries', () => {
  const pair = makeKeyPair()
  const parsed = parseTrustedKeys(JSON.stringify({ keys: [{ publicKey: pair.publicKeyPem, name: 'laptop' }] }))
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].keyId, computeKeyId(pair.publicKeyPem))
  assert.equal(parsed[0].name, 'laptop')
  assert.throws(
    () => parseTrustedKeys(JSON.stringify({ keys: [], extra: true })),
    (error) => error.code === ERROR.INVALID_ARGS
  )
  assert.throws(
    () => parseTrustedKeys(JSON.stringify({ keys: [{ publicKey: 'not a pem' }] })),
    (error) => error.code === ERROR.INVALID_ARGS
  )
  assert.throws(
    () => parseTrustedKeys(JSON.stringify({ keys: [{ publicKey: pair.publicKeyPem, keyId: 'XYZ' }] })),
    (error) => error.code === ERROR.INVALID_ARGS
  )
})

test('createSignatureEnvelope rejects non-Ed25519 and unreadable private keys', () => {
  const sumsBytes = Buffer.from('sums\n', 'utf8')
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const rsaPem = privateKey.export({ type: 'pkcs8', format: 'pem' })
  assert.throws(
    () => createSignatureEnvelope({ sumsBytes, privateKeyPem: rsaPem, createdAt: FIXED_NOW_ISO }),
    (error) => error.code === ERROR.INVALID_ARGS && /Ed25519/.test(error.message)
  )
  assert.throws(
    () => createSignatureEnvelope({ sumsBytes, privateKeyPem: 'garbage', createdAt: FIXED_NOW_ISO }),
    (error) => error.code === ERROR.INVALID_ARGS
  )
})

test('signature envelope parsing is strict: bad JSON, fields, algorithm or keyId are invalid', () => {
  const pair = makeKeyPair()
  const sumsBytes = Buffer.from('sums\n', 'utf8')
  const envelope = createSignatureEnvelope({
    sumsBytes,
    privateKeyPem: pair.privateKeyPem,
    createdAt: FIXED_NOW_ISO
  })
  const trusted = [publicKeyEntry(pair.publicKeyPem)]
  const evaluate = (value) =>
    evaluateSignature({
      signatureText: typeof value === 'string' ? value : JSON.stringify(value),
      sumsBytes,
      trustedKeys: trusted
    })
  assert.equal(evaluate('{ not json').status, 'invalid')
  assert.equal(evaluate({ ...envelope, alg: 'hmac-sha256' }).status, 'invalid')
  assert.equal(evaluate({ ...envelope, signedFile: 'HANDOFF.md' }).status, 'invalid')
  assert.equal(evaluate({ ...envelope, extra: true }).status, 'invalid')
  const missing = { ...envelope }
  delete missing.signedSha256
  assert.equal(evaluate(missing).status, 'invalid')
  const wrongKeyId = { ...envelope, keyId: '0'.repeat(16) }
  assert.equal(evaluate(wrongKeyId).status, 'invalid')
  assert.match(evaluate({ ...envelope, signedSha256: '0'.repeat(64) }).detail, /signedSha256/)
  assert.equal(evaluateSignature({}).status, 'unsigned')
})

// --------------------------------------------------------------- service layer

test('verify reports signature.status=unsigned for a batch without a signature', async () => {
  const harness = makeHarness()
  const created = await createBatch(harness)
  const result = await runVerify(harness, created.batchId)
  assert.deepEqual(result.signature, { status: 'unsigned' })
  assert.equal(result.verification.ok, true)
  assert.equal(result.verification.counts.errors, 0)
  assert.equal(
    result.verification.findings.some((finding) => finding.code === 'SIGNATURE_INVALID'),
    false
  )
  // signature.json is not a batch artifact, so signing/unsigned never changes hashes.
  assert.equal(result.receipt.inputs.sumsSha256, sha256Hex(harness.fs.readFile(`${created.displayDir}\\SHA256SUMS`)))
})

test('a signature trusted through trusted-keys.json verifies as valid without changing trust', async () => {
  const harness = makeHarness()
  const pair = makeKeyPair()
  seedTrustedKeys(harness.fs, [pair.publicKeyPem])
  const created = await createBatch(harness)
  const writesBefore = harness.fs.writeCount()
  const envelope = signFakeBatch(harness.fs, created, pair.privateKeyPem)
  const result = await runVerify(harness, created.batchId)
  assert.deepEqual(result.signature, { status: 'valid', keyId: envelope.keyId })
  assert.equal(result.verification.ok, true)
  assert.equal(result.verification.counts.errors, 0)
  assert.equal(result.verification.counts.warnings, 0)
  assert.equal(harness.fs.writeCount(), writesBefore, 'verify must never write')
})

test('a signature without a trust source is untrusted and leaves findings/trust unchanged', async () => {
  const harness = makeHarness()
  const pair = makeKeyPair()
  const created = await createBatch(harness)
  const envelope = signFakeBatch(harness.fs, created, pair.privateKeyPem)
  const result = await runVerify(harness, created.batchId)
  assert.equal(result.signature.status, 'untrusted')
  assert.equal(result.signature.keyId, envelope.keyId)
  assert.equal(result.verification.counts.errors, 0)
  assert.equal(result.verification.counts.warnings, 0)
  assert.equal(
    result.verification.findings.some((finding) => finding.code === 'SIGNATURE_INVALID'),
    false
  )
  assert.equal(result.receipt.inputs.sumsSha256, sha256Hex(harness.fs.readFile(`${created.displayDir}\\SHA256SUMS`)))
})

test('a tampered signature is invalid: SIGNATURE_INVALID error and trust=invalid', async () => {
  const harness = makeHarness()
  const pair = makeKeyPair()
  seedTrustedKeys(harness.fs, [pair.publicKeyPem])
  const created = await createBatch(harness)
  const envelope = signFakeBatch(harness.fs, created, pair.privateKeyPem)
  envelope.signature = Buffer.alloc(64).toString('base64')
  writeFakeEnvelope(harness.fs, created, envelope)
  const result = await runVerify(harness, created.batchId)
  assert.equal(result.signature.status, 'invalid')
  assert.equal(result.verification.ok, false)
  const finding = result.verification.findings.find((entry) => entry.code === 'SIGNATURE_INVALID')
  assert.ok(finding, 'missing SIGNATURE_INVALID finding')
  assert.equal(finding.severity, 'error')
  assert.equal(finding.path, SIGNATURE_FILE)
  assert.equal(result.verification.counts.errors, 1)
})

test('tampering with SHA256SUMS after signing invalidates the signature', async () => {
  const harness = makeHarness()
  const pair = makeKeyPair()
  seedTrustedKeys(harness.fs, [pair.publicKeyPem])
  const created = await createBatch(harness)
  signFakeBatch(harness.fs, created, pair.privateKeyPem)
  const sumsPath = `${created.displayDir}\\SHA256SUMS`
  harness.fs.addFile(sumsPath, `${harness.fs.readFile(sumsPath)}\n`)
  const result = await runVerify(harness, created.batchId)
  assert.equal(result.signature.status, 'invalid')
  assert.match(result.signature.detail, /signedSha256/)
  assert.equal(result.verification.ok, false)
  assert.equal(
    result.verification.findings.some(
      (finding) => finding.severity === 'error' && finding.code === 'SIGNATURE_INVALID'
    ),
    true
  )
})

test('replacing the embedded public key makes the signature invalid', async () => {
  const harness = makeHarness()
  const pair = makeKeyPair()
  const other = makeKeyPair()
  seedTrustedKeys(harness.fs, [pair.publicKeyPem])
  const created = await createBatch(harness)
  const envelope = signFakeBatch(harness.fs, created, pair.privateKeyPem)
  envelope.publicKey = other.publicKeyPem
  writeFakeEnvelope(harness.fs, created, envelope)
  const result = await runVerify(harness, created.batchId)
  assert.equal(result.signature.status, 'invalid')
  assert.equal(result.verification.ok, false)
  assert.equal(
    result.verification.findings.some((finding) => finding.code === 'SIGNATURE_INVALID'),
    true
  )
})

test('a valid signature from another key is untrusted, not invalid', async () => {
  const harness = makeHarness()
  const trustedPair = makeKeyPair()
  const otherPair = makeKeyPair()
  seedTrustedKeys(harness.fs, [trustedPair.publicKeyPem])
  const created = await createBatch(harness)
  signFakeBatch(harness.fs, created, otherPair.privateKeyPem)
  const result = await runVerify(harness, created.batchId)
  assert.equal(result.signature.status, 'untrusted')
  assert.equal(result.verification.ok, true)
  assert.equal(result.verification.counts.errors, 0)
})

// ------------------------------------------------------------- audit receipt

test('verify returns a stable audit receipt with input hashes', async () => {
  const harness = makeHarness()
  const created = await createBatch(harness)
  const first = await runVerify(harness, created.batchId)
  const second = await runVerify(harness, created.batchId)
  assert.equal(first.receipt.checker.name, 'dsh-handoff-kit')
  assert.equal(first.receipt.checker.version, PLUGIN_VERSION)
  assert.equal(first.receipt.checkedAt, first.verification.checkedAt)
  assert.deepEqual(first.receipt.inputs, {
    manifestSha256: sha256Hex(harness.fs.readFile(`${created.displayDir}\\manifest.json`)),
    sumsSha256: sha256Hex(harness.fs.readFile(`${created.displayDir}\\SHA256SUMS`)),
    handoffSha256: sha256Hex(harness.fs.readFile(`${created.displayDir}\\HANDOFF.md`))
  })
  // Everything except checkedAt is deterministic...
  assert.deepEqual(first.receipt.inputs, second.receipt.inputs)
  assert.deepEqual(first.receipt.checker, second.receipt.checker)
  // ...and a fixed clock makes even checkedAt stable.
  assert.equal(first.receipt.checkedAt, second.receipt.checkedAt)
})

test('receipt nulls a missing input file instead of inventing a hash', async () => {
  const harness = makeHarness()
  const created = await createBatch(harness)
  harness.fs.drop(`${created.displayDir}\\HANDOFF.md`)
  const result = await runVerify(harness, created.batchId)
  assert.equal(result.receipt.inputs.handoffSha256, null)
  assert.match(result.receipt.inputs.manifestSha256, /^[0-9a-f]{64}$/)
  assert.match(result.receipt.inputs.sumsSha256, /^[0-9a-f]{64}$/)
})

test('handoff_load reports the same signature/receipt, including when verify is skipped', async () => {
  const harness = makeHarness()
  const pair = makeKeyPair()
  seedTrustedKeys(harness.fs, [pair.publicKeyPem])
  const created = await createBatch(harness)
  const envelope = signFakeBatch(harness.fs, created, pair.privateKeyPem)
  const writesBefore = harness.fs.writeCount()

  const loaded = await harness.service.load(validateLoadArgs({ batchId: created.batchId }), harness.exec)
  assert.deepEqual(validateSubset(LOAD_OUTPUT_SCHEMA, loaded), [])
  assert.equal(loaded.trust, 'verified')
  assert.equal(loaded.signature.status, 'valid')
  assert.equal(loaded.signature.keyId, envelope.keyId)
  assert.equal(loaded.receipt.checkedAt, loaded.verification.checkedAt)
  assert.equal(harness.fs.writeCount(), writesBefore, 'load must never write')

  const skipped = await harness.service.load(
    validateLoadArgs({ batchId: created.batchId, verifyFirst: false }),
    harness.exec
  )
  assert.equal(skipped.trust, 'stale')
  assert.equal(skipped.verification, undefined)
  assert.equal(skipped.signature.status, 'valid')
  assert.equal(skipped.receipt.checker.name, 'dsh-handoff-kit')
  assert.equal(harness.fs.writeCount(), writesBefore, 'skipped load must never write')
})

// ---------------------------------------------------------------- CLI signing

test('CLI sign + verify --pubkey round-trip is valid; load also reports signature/receipt', async (t) => {
  const base = tempDir(t)
  const previousDshHome = process.env.DSH_HOME
  process.env.DSH_HOME = join(base, 'dsh-home')
  t.after(() => {
    if (previousDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousDshHome
  })
  const fixture = writeBatchFixture(base)
  const pair = makeKeyPair()
  const keyPath = join(base, 'private.pem')
  const publicPath = join(base, 'public.pem')
  writeFileSync(keyPath, pair.privateKeyPem, 'utf8')
  writeFileSync(publicPath, pair.publicKeyPem, 'utf8')
  const sumsBefore = readFileSync(fixture.sumsPath, 'utf8')

  const signed = await run(['sign', fixture.batchDir, '--key', keyPath, '--json'])
  assert.equal(signed.code, EXIT.VERIFIED, signed.err)
  const signedPayload = JSON.parse(signed.out)
  assert.equal(signedPayload.ok, true)
  assert.equal(signedPayload.batchDir, resolve(fixture.batchDir))
  assert.equal(signedPayload.keyId, computeKeyId(pair.publicKeyPem))
  assert.equal(signedPayload.signedSha256, sha256Hex(readFileSync(fixture.sumsPath)))
  // The signature signs SHA256SUMS; it never rewrites or joins it.
  assert.equal(readFileSync(fixture.sumsPath, 'utf8'), sumsBefore)
  assert.equal(readFileSync(join(fixture.batchDir, 'SHA256SUMS'), 'utf8').includes('signature.json'), false)
  assert.equal(existsSync(join(fixture.batchDir, SIGNATURE_FILE)), true)

  const verified = await run(['verify', fixture.batchDir, '--pubkey', publicPath, '--json'])
  assert.equal(verified.code, EXIT.VERIFIED, verified.err)
  const verifiedPayload = JSON.parse(verified.out)
  assert.equal(verifiedPayload.trust, 'verified')
  assert.deepEqual(verifiedPayload.signature, { status: 'valid', keyId: signedPayload.keyId })
  assert.equal(verifiedPayload.receipt.checker.name, 'dsh-handoff-kit')
  assert.equal(
    verifiedPayload.receipt.inputs.handoffSha256,
    sha256Hex(readFileSync(fixture.handoffPath))
  )
  assert.equal(verifiedPayload.receipt.inputs.manifestSha256, sha256Hex(readFileSync(fixture.manifestPath)))

  // Without a trust source (isolated empty DSH_HOME) the same signature is only untrusted.
  const untrusted = await run(['verify', fixture.batchDir, '--json'])
  assert.equal(untrusted.code, EXIT.VERIFIED)
  assert.equal(JSON.parse(untrusted.out).signature.status, 'untrusted')

  // The trusted-key list file is the tool/CLI fallback trust source.
  const storeDir = join(base, 'dsh-home', 'handoff')
  mkdirSync(storeDir, { recursive: true })
  writeFileSync(
    join(storeDir, 'trusted-keys.json'),
    `${JSON.stringify({ keys: [{ keyId: signedPayload.keyId, publicKey: pair.publicKeyPem }] }, null, 2)}\n`,
    'utf8'
  )
  const viaStore = await run(['verify', fixture.batchDir, '--json'])
  assert.equal(viaStore.code, EXIT.VERIFIED)
  assert.equal(JSON.parse(viaStore.out).signature.status, 'valid')

  const loaded = await run(['load', fixture.batchDir, '--pubkey', publicPath, '--json'])
  assert.equal(loaded.code, EXIT.VERIFIED)
  const loadedPayload = JSON.parse(loaded.out)
  assert.equal(loadedPayload.signature.status, 'valid')
  assert.equal(loadedPayload.receipt.checker.version, PLUGIN_VERSION)
})

test('CLI sign refuses to overwrite an existing signature without --force, and validates usage', async (t) => {
  const base = tempDir(t)
  const fixture = writeBatchFixture(base)
  const pair = makeKeyPair()
  const keyPath = join(base, 'private.pem')
  writeFileSync(keyPath, pair.privateKeyPem, 'utf8')

  assert.equal((await run(['sign', fixture.batchDir, '--key', keyPath])).code, EXIT.VERIFIED)
  const refused = await run(['sign', fixture.batchDir, '--key', keyPath, '--json'])
  assert.equal(refused.code, EXIT.INVALID)
  assert.equal(JSON.parse(refused.out).error.code, ERROR.BATCH_EXISTS)
  const forced = await run(['sign', fixture.batchDir, '--key', keyPath, '--force', '--json'])
  assert.equal(forced.code, EXIT.VERIFIED)

  // Usage/IO failures use a fresh unsigned batch so the existing-signature check
  // (exit 1) cannot mask the key-file problem.
  const fresh = writeBatchFixture(join(base, 'fresh'))
  const missingKey = await run(['sign', fresh.batchDir, '--key', join(base, 'absent.pem'), '--json'])
  assert.equal(missingKey.code, EXIT.USAGE)
  assert.equal(JSON.parse(missingKey.out).error.code, ERROR.READ_FAILED)

  const noKeyFlag = await run(['sign', fresh.batchDir, '--json'])
  assert.equal(noKeyFlag.code, EXIT.USAGE)

  const missingBatch = await run(['sign', join(base, 'nope', '20261022T023512Z-a1b2'), '--key', keyPath, '--json'])
  assert.equal(missingBatch.code, EXIT.USAGE)

  const invalidKeyPath = join(base, 'bad.pem')
  writeFileSync(invalidKeyPath, 'not a private key', 'utf8')
  const invalidKey = await run(['sign', fresh.batchDir, '--key', invalidKeyPath, '--json'])
  assert.equal(invalidKey.code, EXIT.USAGE)
})

test('CLI verify with --pubkey rejects a tampered signature (exit 1, SIGNATURE_INVALID)', async (t) => {
  const base = tempDir(t)
  const fixture = writeBatchFixture(base)
  const pair = makeKeyPair()
  const keyPath = join(base, 'private.pem')
  const publicPath = join(base, 'public.pem')
  writeFileSync(keyPath, pair.privateKeyPem, 'utf8')
  writeFileSync(publicPath, pair.publicKeyPem, 'utf8')
  assert.equal((await run(['sign', fixture.batchDir, '--key', keyPath])).code, EXIT.VERIFIED)
  const envelope = JSON.parse(readFileSync(join(fixture.batchDir, SIGNATURE_FILE), 'utf8'))
  envelope.signedSha256 = 'f'.repeat(64)
  writeFileSync(join(fixture.batchDir, SIGNATURE_FILE), `${JSON.stringify(envelope, null, 2)}\n`, 'utf8')
  const result = await run(['verify', fixture.batchDir, '--pubkey', publicPath, '--json'])
  assert.equal(result.code, EXIT.INVALID)
  const payload = JSON.parse(result.out)
  assert.equal(payload.trust, 'invalid')
  assert.equal(payload.signature.status, 'invalid')
  assert.equal(
    payload.verification.findings.some((finding) => finding.code === 'SIGNATURE_INVALID'),
    true
  )
})

test('CLI parseArgv understands sign/verify flags', () => {
  const parsed = parseArgv(['sign', 'C:\\batches\\b1', '--key', 'C:\\keys\\private.pem', '--force'])
  assert.equal(parsed.command, 'sign')
  assert.equal(parsed.flags.key, 'C:\\keys\\private.pem')
  assert.equal(parsed.flags.force, true)
  const verify = parseArgv(['verify', 'C:\\batches\\b1', '--pubkey', 'C:\\keys\\public.pem'])
  assert.equal(verify.flags.pubkey, 'C:\\keys\\public.pem')
  assert.throws(() => parseArgv(['verify', '--pubkey']), (error) => error.code === ERROR.INVALID_ARGS)
})
