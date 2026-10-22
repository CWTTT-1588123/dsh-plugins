/**
 * CLI tests (P3/M3): reference `handoff-kit` verifier/consumer.
 *
 * The CLI runs on the real filesystem (it is the out-of-harness entry point),
 * so fixtures are materialized into an OS temp directory and removed per test.
 * The core `runCli` is imported directly — no subprocess is spawned anywhere.
 *
 * @module test/cli
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import {
  EXIT,
  loadBatch,
  listBatches,
  migrateBatch,
  parseArgv,
  runCli,
  verifyBatch
} from '../src/cli.js'
import { artifactEntry, buildSha256Sums, createManifest, serializeManifest, setArtifacts } from '../src/manifest.js'
import { sha256Hex } from '../src/paths.js'
import { renderHandoff } from '../src/render.js'

const BATCH_ID = '20261022T023512Z-a1b2'
const PROJECT_KEY = 'fixture-12345678'
const CREATED_AT = '2026-10-22T02:35:12.000Z'

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-cli-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/**
 * Materialize a valid schemaVersion 1 batch plus its workspace on the real FS.
 * @returns {{batchDir: string, workspace: string, handoffPath: string, manifestPath: string}}
 */
function writeBatchFixture(baseDir) {
  const workspace = join(baseDir, 'workspace')
  mkdirSync(workspace, { recursive: true })
  const readme = '# fixture workspace\n\nUsed by the CLI tests.\n'
  writeFileSync(join(workspace, 'README.md'), readme, 'utf8')

  const batchDir = join(baseDir, 'handoff', PROJECT_KEY, BATCH_ID)
  mkdirSync(batchDir, { recursive: true })
  const readmeBytes = Buffer.byteLength(readme, 'utf8')
  const manifest = createManifest({
    batchId: BATCH_ID,
    createdAt: CREATED_AT,
    project: { key: PROJECT_KEY, name: 'fixture', workspace: '$WORKSPACE' },
    session: { id: 'session-fixture', cwd: '$WORKSPACE', agentPreset: 'standard' },
    sandbox: { mode: 'danger-full-access', workspaceRoot: '$WORKSPACE' },
    inputs: { title: 'CLI fixture', summary: 'fixture for CLI tests' },
    files: [{ path: 'README.md', role: 'doc', bytes: readmeBytes, sha256: sha256Hex(readme) }],
    scan: {
      entries: 3,
      dirs: 1,
      denied: 0,
      symlinksSkipped: 0,
      readBytes: readmeBytes,
      explicitFiles: [],
      tree: [{ name: 'README.md', type: 'file', bytes: readmeBytes }]
    }
  })
  const handoff = renderHandoff(manifest)
  const evidence = [
    { path: 'evidence/git.json', content: jsonText({ schemaVersion: 1, generator: manifest.generator, git: manifest.git }) },
    { path: 'evidence/files.json', content: jsonText({ schemaVersion: 1, scan: manifest.scan, files: manifest.files }) },
    { path: 'evidence/session.json', content: jsonText(manifest.sessionTrace) },
    { path: 'evidence/redactions.json', content: jsonText({ schemaVersion: 1, redactions: manifest.redactions }) }
  ]
  const covered = [{ path: 'HANDOFF.md', content: handoff }, ...evidence]
  const artifacts = covered.map((entry) => artifactEntry(entry.path, entry.content))
  const sums = buildSha256Sums(artifacts)
  const finalManifest = serializeManifest(setArtifacts(manifest, [...artifacts, artifactEntry('SHA256SUMS', sums)]))
  for (const entry of covered) {
    const target = join(batchDir, ...entry.path.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, entry.content, 'utf8')
  }
  writeFileSync(join(batchDir, 'SHA256SUMS'), sums, 'utf8')
  writeFileSync(join(batchDir, 'manifest.json'), finalManifest, 'utf8')
  return {
    batchDir,
    workspace,
    handoffPath: join(batchDir, 'HANDOFF.md'),
    manifestPath: join(batchDir, 'manifest.json')
  }
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

test('parseArgv splits commands, positionals and valued flags', () => {
  const parsed = parseArgv(['verify', 'C:\\batches\\b1', '--workspace', 'C:\\ws', '--json'])
  assert.equal(parsed.command, 'verify')
  assert.deepEqual(parsed.positional, ['C:\\batches\\b1'])
  assert.equal(parsed.flags.workspace, 'C:\\ws')
  assert.equal(parsed.flags.json, true)
  assert.throws(() => parseArgv(['verify', '--workspace']), (error) => error.code === 'HANDOFF_INVALID_ARGS')
  assert.throws(() => parseArgv(['verify', '--nope']), (error) => error.code === 'HANDOFF_INVALID_ARGS')
})

test('verify: valid batch with workspace exits 0 and reports trust=verified', async (t) => {
  const base = tempDir(t)
  const fixture = writeBatchFixture(base)
  const human = await run(['verify', fixture.batchDir, '--workspace', fixture.workspace])
  assert.equal(human.code, EXIT.VERIFIED)
  assert.match(human.out, /trust=verified/)
  assert.match(human.out, /0 errors, 0 warnings/)

  const json = await run(['verify', fixture.batchDir, '--workspace', fixture.workspace, '--json'])
  assert.equal(json.code, EXIT.VERIFIED)
  const payload = JSON.parse(json.out)
  assert.equal(payload.trust, 'verified')
  assert.equal(payload.verification.counts.errors, 0)
  assert.equal(payload.verification.drift.artifactsChecked >= 6, true)
})

test('verify: tampered artifact exits 1 (invalid) with hash findings', async (t) => {
  const base = tempDir(t)
  const fixture = writeBatchFixture(base)
  writeFileSync(fixture.handoffPath, '# tampered handoff\n', 'utf8')
  const result = await run(['verify', fixture.batchDir, '--json'])
  assert.equal(result.code, EXIT.INVALID)
  const payload = JSON.parse(result.out)
  assert.equal(payload.trust, 'invalid')
  const codes = payload.verification.findings.map((finding) => finding.code)
  assert.equal(codes.includes('ARTIFACT_HASH_MISMATCH'), true)
  assert.equal(codes.includes('SHA256SUMS_MISMATCH'), true)
})

test('verify: source drift (workspace changed) downgrades trust to stale (exit 3)', async (t) => {
  const base = tempDir(t)
  const fixture = writeBatchFixture(base)
  writeFileSync(join(fixture.workspace, 'README.md'), '# changed after handoff\n', 'utf8')
  const result = await run(['verify', fixture.batchDir, '--workspace', fixture.workspace, '--json'])
  assert.equal(result.code, EXIT.STALE)
  const payload = JSON.parse(result.out)
  assert.equal(payload.trust, 'stale')
  const codes = payload.verification.findings.map((finding) => finding.code)
  assert.equal(codes.includes('SOURCE_FILE_CHANGED'), true)
})

test('load: returns trust, pointers and bounded sections; verifyBatch/listBatches work as functions', async (t) => {
  const base = tempDir(t)
  const fixture = writeBatchFixture(base)
  const result = await run(['load', fixture.batchDir, '--sections', '--json'])
  assert.equal(result.code, EXIT.VERIFIED)
  const payload = JSON.parse(result.out)
  assert.equal(payload.trust, 'verified')
  assert.equal(payload.pointers.length, 4)
  assert.equal(Array.isArray(payload.handoff.sections), true)
  assert.equal(payload.handoff.sections.some((section) => section.id === 'H0'), true)

  const direct = await loadBatch({ batchDir: fixture.batchDir, include: 'full' })
  assert.equal(direct.trust, 'verified')
  assert.equal(typeof direct.handoff.excerpt, 'string')

  const listed = listBatches({ root: join(base, 'handoff') })
  assert.equal(listed.batches.length, 1)
  assert.equal(listed.batches[0].batchId, BATCH_ID)
  assert.equal(listed.batches[0].complete, true)

  const verified = await verifyBatch({ batchDir: fixture.batchDir, workspaceRoot: fixture.workspace })
  assert.equal(verified.trust, 'verified')
})

test('migrate: v1 -> new v2 batch, source untouched, new batch verifies', async (t) => {
  const base = tempDir(t)
  const fixture = writeBatchFixture(base)
  const sourceManifestBefore = readFileSync(fixture.manifestPath, 'utf8')
  const sourceHandoffBefore = readFileSync(fixture.handoffPath, 'utf8')
  const outDir = join(base, 'out', '20261023T010203Z-abcd')

  const result = await run(['migrate', fixture.batchDir, '--out', outDir])
  assert.equal(result.code, EXIT.VERIFIED)
  assert.match(result.out, /migrated 20261022T023512Z-a1b2 -> 20261023T010203Z-abcd/)

  assert.equal(readFileSync(fixture.manifestPath, 'utf8'), sourceManifestBefore)
  assert.equal(readFileSync(fixture.handoffPath, 'utf8'), sourceHandoffBefore)

  const migratedManifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'))
  assert.equal(migratedManifest.schemaVersion, 2)
  assert.equal(migratedManifest.changes.available, false)
  assert.equal(migratedManifest.warnings.some((warning) => warning.code === 'MIGRATED_FROM_V1'), true)
  const migration = JSON.parse(readFileSync(join(outDir, 'evidence', 'migration.json'), 'utf8'))
  assert.equal(migration.schemaVersion, 1)
  assert.equal(migration.migration.fromBatchId, BATCH_ID)
  assert.match(migration.migration.sourceSha256Sums, /^[0-9a-f]{64}$/)

  const verified = await run(['verify', outDir, '--json'])
  assert.equal(verified.code, EXIT.VERIFIED)
  assert.equal(JSON.parse(verified.out).trust, 'verified')
})

test('migrate: refuses already-v2 sources and non-empty output directories', async (t) => {
  const base = tempDir(t)
  const fixture = writeBatchFixture(base)
  const outDir = join(base, 'out', '20261023T010203Z-abcd')
  const first = await migrateBatch({ batchDir: fixture.batchDir, outDir })
  assert.equal(first.batchId, '20261023T010203Z-abcd')

  const again = await run(['migrate', outDir, '--out', join(base, 'out', '20261023T010204Z-abce'), '--json'])
  assert.equal(again.code, EXIT.INVALID)
  const payload = JSON.parse(again.out)
  assert.equal(payload.ok, false)
  assert.equal(payload.error.code, 'HANDOFF_MIGRATION_UNSUPPORTED_VERSION')

  const busyOut = join(base, 'busy', '20261023T010205Z-abcf')
  mkdirSync(busyOut, { recursive: true })
  writeFileSync(join(busyOut, 'keep.txt'), 'occupied\n', 'utf8')
  const busy = await run(['migrate', fixture.batchDir, '--out', busyOut, '--json'])
  assert.equal(busy.code, EXIT.INVALID)
  assert.equal(JSON.parse(busy.out).error.code, 'HANDOFF_BATCH_EXISTS')
})

test('migrate: rejects a tampered source batch as invalid', async (t) => {
  const base = tempDir(t)
  const fixture = writeBatchFixture(base)
  writeFileSync(join(fixture.batchDir, 'HANDOFF.md'), '# tampered\n', 'utf8')
  const result = await run(['migrate', fixture.batchDir, '--out', join(base, 'out', '20261023T010203Z-abcd'), '--json'])
  assert.equal(result.code, EXIT.INVALID)
  assert.equal(JSON.parse(result.out).error.code, 'HANDOFF_MIGRATION_SOURCE_INVALID')
})

test('CLI usage errors exit 2; --help exits 0', async () => {
  const missing = await run(['verify'])
  assert.equal(missing.code, EXIT.USAGE)
  assert.match(missing.err, /requires <batchDir>/)

  const unknown = await run(['frobnicate'])
  assert.equal(unknown.code, EXIT.USAGE)

  const noRoot = await run(['list'])
  assert.equal(noRoot.code, EXIT.USAGE)

  const help = await run(['--help'])
  assert.equal(help.code, EXIT.VERIFIED)
  assert.match(help.out, /Usage:/)

  const version = await run(['--version'])
  assert.equal(version.code, EXIT.VERIFIED)
  assert.match(version.out, /^\d+\.\d+\.\d+/)
})

test('CLI module honors the 1.0 boundary: no network, no subprocess, no harness import', () => {
  const cliSource = readFileSync(new URL('../src/cli.js', import.meta.url), 'utf8')
  const binSource = readFileSync(new URL('../bin/handoff-kit.mjs', import.meta.url), 'utf8')
  for (const source of [cliSource, binSource]) {
    assert.doesNotMatch(source, /from\s+['"]node:(?:child_process|http|https|net|dgram|http2)['"]/)
    assert.doesNotMatch(source, /from\s+['"]@deepseek-ai\//)
    assert.doesNotMatch(source, /require\(\s*['"](?:node:)?(?:child_process|http|https|net)['"]\s*\)/)
  }
})
