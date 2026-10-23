/**
 * P3/M5 A2 tests: HANDOFF path-reference extraction and existence checking.
 *
 * The generator records `HANDOFF_PATH_MISSING` warnings for narrative paths that
 * no longer exist (never blocking creation); verify/load turn the same condition
 * into a `warn` finding (trust becomes stale, never invalid). URLs, plain file
 * names, embedded-space paths and absolute/traversal spellings are ignored.
 *
 * @module test/path-refs
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

import { EXIT, runCli } from '../src/cli.js'
import { ERROR, TOOL_OUTPUT_SCHEMA, validateToolArgs } from '../src/contracts.js'
import {
  extractPathRefs,
  findMissingPathRefs,
  missingPathRefWarnings
} from '../src/path-refs.js'
import { parseManifest } from '../src/manifest.js'
import { createService } from '../src/service.js'
import { writeBatchFixture } from './helpers/cli-batch-fixture.js'
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
  return { fs, ctx, service, exec }
}

function makeHarness({ files } = {}) {
  const fs = createFixtureFs(files === undefined ? {} : { files })
  addGitFixture(fs)
  return makeServiceFor(fs)
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

async function verify(harness, batchId) {
  return harness.service.run(validateToolArgs({ action: 'verify', batchId }), harness.exec)
}

function readManifest(harness, created) {
  return parseManifest(harness.fs.readFile(`${created.displayDir}\\manifest.json`))
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

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-paths-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

// ---------------------------------------------------------------- extraction

test('extractPathRefs finds repository paths, tokens and ignores noise', () => {
  const text = [
    'Read docs/design.md, src/index.js and test/foo.test.js.',
    'URLs https://example.com/docs/novel.md are not references.',
    'Plain README.md and package.json are not references either.',
    'An embedded-space path docs/my file.md is ignored; docs/ok.md stays.',
    'Tokens: `$WORKSPACE/src/a.js`, `$DSH_HOME/handoff/x` and `$WORKSPACE/`.',
    'Escapes ../docs/x.md, /abs/docs/y.md and C:/docs/z.md are ignored.',
    'Punctuation: (bin/tool.mjs), plugins/x/spec/a.json, locale/zh.json。'
  ].join('\n')
  assert.deepEqual(
    extractPathRefs(text).map((ref) => ({ ref: ref.ref, kind: ref.kind, relativePath: ref.relativePath })),
    [
      { ref: '$DSH_HOME/handoff/x', kind: 'dshHome', relativePath: 'handoff/x' },
      { ref: '$WORKSPACE/', kind: 'workspace', relativePath: '' },
      { ref: '$WORKSPACE/src/a.js', kind: 'workspace', relativePath: 'src/a.js' },
      { ref: 'bin/tool.mjs', kind: 'workspace', relativePath: 'bin/tool.mjs' },
      { ref: 'docs/design.md', kind: 'workspace', relativePath: 'docs/design.md' },
      { ref: 'docs/ok.md', kind: 'workspace', relativePath: 'docs/ok.md' },
      { ref: 'locale/zh.json', kind: 'workspace', relativePath: 'locale/zh.json' },
      { ref: 'plugins/x/spec/a.json', kind: 'workspace', relativePath: 'plugins/x/spec/a.json' },
      { ref: 'src/index.js', kind: 'workspace', relativePath: 'src/index.js' },
      { ref: 'test/foo.test.js', kind: 'workspace', relativePath: 'test/foo.test.js' }
    ]
  )
  // Non-strings and duplicates are inert / collapsed.
  assert.deepEqual(extractPathRefs(undefined), [])
  assert.deepEqual(extractPathRefs(42), [])
  assert.deepEqual(
    extractPathRefs('docs/a.md and docs/a.md').map((ref) => ref.ref),
    ['docs/a.md']
  )
})

test('findMissingPathRefs checks workspace refs, skips unknown roots and reads existence', async () => {
  const seen = []
  const io = {
    async lstat(absolutePath) {
      seen.push(absolutePath)
      return absolutePath.includes('missing') ? undefined : { type: 'file' }
    }
  }
  const text = 'docs/present.md docs/missing.md $WORKSPACE/src/a.js $DSH_HOME/handoff/x'
  const withoutRoot = await findMissingPathRefs({ text, io })
  assert.equal(withoutRoot.supported, false)
  assert.deepEqual(withoutRoot.missing, [])

  const checked = await findMissingPathRefs({ text, workspaceRoot: 'C:\\ws', io })
  assert.equal(checked.supported, true)
  assert.deepEqual(
    checked.missing.map((entry) => entry.ref),
    ['docs/missing.md']
  )
  // `$DSH_HOME` is extracted but not resolved without an explicit opt-in.
  assert.equal(seen.some((path) => path.includes('handoff')), false)

  const withHome = await findMissingPathRefs({
    text,
    workspaceRoot: 'C:\\ws',
    dshHome: 'C:\\Users\\test\\.dsh',
    includeDshHome: true,
    io: {
      async lstat(absolutePath) {
        return absolutePath.startsWith('C:\\Users\\test\\.dsh') ? { type: 'directory' } : undefined
      }
    }
  })
  assert.deepEqual(
    withHome.missing.map((entry) => entry.ref),
    ['$WORKSPACE/src/a.js', 'docs/missing.md', 'docs/present.md']
  )
  assert.deepEqual(missingPathRefWarnings([{ ref: 'docs/gone.md' }]), [
    { code: 'HANDOFF_PATH_MISSING', detail: 'HANDOFF references a path that no longer exists: docs/gone.md' }
  ])
})

// ------------------------------------------------------- generation warnings

test('create records HANDOFF_PATH_MISSING warnings for stale narrative paths without blocking', async () => {
  const harness = makeHarness()
  const created = await create(harness, {
    action: 'create',
    summary: '旧文档 docs/legacy.md 已不存在；当前实现见 src/index.js。'
  })
  const warnings = created.warnings.filter((warning) => warning.code === 'HANDOFF_PATH_MISSING')
  assert.deepEqual(
    warnings.map((warning) => warning.detail),
    ['HANDOFF references a path that no longer exists: docs/legacy.md']
  )
  // The batch was still written, and the warning is part of manifest.warnings.
  assert.equal(harness.fs.has(`${created.displayDir}\\manifest.json`), true)
  const manifest = readManifest(harness, created)
  assert.equal(manifest.warnings.some((warning) => warning.code === 'HANDOFF_PATH_MISSING'), true)
  // The existing reference in the same narrative is not reported.
  assert.equal(JSON.stringify(manifest.warnings).includes('src/index.js'), false)
})

test('create does not warn when every referenced path exists', async () => {
  const harness = makeHarness()
  const created = await create(harness, {
    action: 'create',
    summary: 'see docs/design.md and src/index.js'
  })
  assert.deepEqual(
    created.warnings.filter((warning) => warning.code === 'HANDOFF_PATH_MISSING'),
    []
  )
  const result = await verify(harness, created.batchId)
  assert.equal(result.verification.ok, true)
  assert.equal(result.verification.counts.warnings, 0)
})

test('verify turns a stale narrative reference into a warn finding (trust=stale, not invalid)', async () => {
  const harness = makeHarness()
  const created = await create(harness, { action: 'create' })
  // The package references docs/design.md; the current workspace lost it.
  harness.fs.drop('docs/design.md')
  const result = await verify(harness, created.batchId)
  const finding = result.verification.findings.find((entry) => entry.code === 'HANDOFF_PATH_MISSING')
  assert.ok(finding, 'missing HANDOFF_PATH_MISSING finding')
  assert.equal(finding.severity, 'warn')
  assert.equal(finding.path, 'docs/design.md')
  assert.equal(result.verification.ok, true)
  assert.equal(result.verification.counts.errors, 0)
  assert.equal(result.verification.counts.warnings > 0, true)
})

test('verify resolves $WORKSPACE references and does not guess $DSH_HOME paths', async () => {
  const harness = makeHarness()
  const created = await create(harness, { action: 'create' })
  // Add a token reference that resolves inside the workspace, plus one that
  // would only make sense on another host ($DSH_HOME); the latter is skipped.
  const handoffPath = `${created.displayDir}\\HANDOFF.md`
  const text = harness.fs.readFile(handoffPath)
  harness.fs.addFile(
    handoffPath,
    `${text}\n- 复核 ` +
      '`$WORKSPACE/docs/design.md`、`$WORKSPACE/docs/gone.md` 与 `$DSH_HOME/handoff/elsewhere.md`。\n'
  )
  const result = await verify(harness, created.batchId)
  const missing = result.verification.findings.filter((entry) => entry.code === 'HANDOFF_PATH_MISSING')
  assert.deepEqual(
    missing.map((entry) => entry.path),
    ['$WORKSPACE/docs/gone.md']
  )
})

// ------------------------------------------------------------------- CLI A2

test('CLI verify checks references only when --workspace is given', async (t) => {
  const base = tempDir(t)
  const fixture = writeBatchFixture(base, { summary: 'stale docs/legacy.md reference' })
  const withoutWorkspace = await run(['verify', fixture.batchDir, '--json'])
  assert.equal(withoutWorkspace.code, EXIT.VERIFIED)
  const clean = JSON.parse(withoutWorkspace.out)
  assert.equal(clean.trust, 'verified')
  assert.equal(clean.verification.findings.some((entry) => entry.code === 'HANDOFF_PATH_MISSING'), false)

  const withWorkspace = await run(['verify', fixture.batchDir, '--workspace', fixture.workspace, '--json'])
  assert.equal(withWorkspace.code, EXIT.STALE)
  const stale = JSON.parse(withWorkspace.out)
  assert.equal(stale.trust, 'stale')
  const finding = stale.verification.findings.find((entry) => entry.code === 'HANDOFF_PATH_MISSING')
  assert.equal(finding.severity, 'warn')
  assert.equal(finding.path, 'docs/legacy.md')
})

test('path-reference helpers stay deterministic for the same text', () => {
  const text = 'docs/b.md src/a.js docs/b.md plugins/x/docs/c.md'
  const first = extractPathRefs(text)
  const second = extractPathRefs(text)
  assert.deepEqual(first, second)
  assert.deepEqual(
    first.map((entry) => entry.ref),
    ['docs/b.md', 'plugins/x/docs/c.md', 'src/a.js']
  )
  // $WORKSPACE root alone is the workspace itself and always "exists".
  assert.equal(
    extractPathRefs('root `$WORKSPACE/`')[0].relativePath,
    ''
  )
})

// Keep the unused ERROR import meaningful: the warning is a finding, not an error.
test('HANDOFF_PATH_MISSING is never raised as a handoff error code', () => {
  assert.equal(Object.values(ERROR).includes('HANDOFF_PATH_MISSING'), false)
  const now = new Date(FIXED_NOW.getTime())
  assert.equal(Number.isFinite(now.getTime()), true)
})
