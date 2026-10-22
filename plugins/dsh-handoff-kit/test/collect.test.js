import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { join } from 'node:path'
import { test } from 'node:test'

import { classifyRole, collectWorkspace, readCopyCandidate } from '../src/collect.js'
import { ERROR, LIMITS } from '../src/contracts.js'
import { sha256Hex } from '../src/paths.js'
import { createFakeFs } from './helpers/fake-fs.js'
import { WORKSPACE_ROOT, addGitFixture, sampleWorkspaceFiles } from './helpers/fixtures.js'
import { createFakeIo, createReversedIo } from './helpers/git-fixture.js'

/** Sample workspace filesystem, optionally with a `.git` directory. */
function sampleFs({ git = false, overrides = {} } = {}) {
  const fs = createFakeFs({ root: WORKSPACE_ROOT, files: sampleWorkspaceFiles(overrides) })
  if (git) addGitFixture(fs)
  return fs
}

/** Simple custom workspace rooted at the fixture root. */
function customFs(files, root = WORKSPACE_ROOT) {
  return createFakeFs({ root, files })
}

function codesOf(warnings) {
  return warnings.map((warning) => warning.code)
}

test('classifyRole covers entry/config/test/doc/source/other', () => {
  const cases = [
    ['package.json', 'entry'],
    ['pyproject.toml', 'entry'],
    ['Cargo.toml', 'entry'],
    ['go.mod', 'entry'],
    ['Makefile', 'entry'],
    ['README.md', 'entry'],
    ['README.zh-CN.md', 'entry'],
    ['AGENTS.md', 'entry'],
    ['tsconfig.json', 'config'],
    ['vite.config.ts', 'config'],
    ['docker-compose.yml', 'config'],
    ['requirements-dev.txt', 'config'],
    ['config/app.yaml', 'config'],
    ['config/nested/deep.toml', 'config'],
    ['test/index.test.js', 'test'],
    ['tests/unit/foo.py', 'test'],
    ['src/__tests__/a.js', 'test'],
    ['src/util.test.ts', 'test'],
    ['pkg/foo_test.go', 'test'],
    ['docs/design.md', 'doc'],
    ['docs/api/spec.txt', 'doc'],
    ['CHANGELOG.md', 'doc'],
    ['src/index.js', 'source'],
    ['a/b/main.py', 'source'],
    ['scripts/build.ps1', 'source'],
    ['dist/bundle.js', 'source'],
    ['LICENSE', 'other'],
    ['data.bin', 'other'],
    ['', 'other']
  ]
  for (const [input, expected] of cases) {
    assert.equal(classifyRole(input), expected, `classifyRole(${JSON.stringify(input)})`)
  }
  // Backslashes are normalized to a POSIX path first.
  assert.equal(classifyRole('src\\index.js'), 'source')
})

test('collectWorkspace walks the sample workspace deterministically', async () => {
  const fs = sampleFs({ git: true })
  const io = createFakeIo(fs)
  const result = await collectWorkspace({ workspaceRoot: WORKSPACE_ROOT, io })

  assert.equal(result.entries, 23)
  assert.equal(result.dirs, 6)
  assert.equal(result.denied, 6)
  assert.equal(result.symlinksSkipped, 0)
  assert.ok(result.entries > 0)

  // Top-level tree: every direct child, sorted by name, never truncated here.
  assert.deepEqual(
    result.tree.map((row) => row.name),
    [
      '.dsh',
      '.env',
      '.git',
      '.gitignore',
      'AGENTS.md',
      'README.md',
      'cache.db',
      'config',
      'dist',
      'docs',
      'node_modules',
      'package-lock.json',
      'package.json',
      'secret.key',
      'src',
      'test',
      'tsconfig.json'
    ]
  )
  for (const row of result.tree) assert.ok(['file', 'directory', 'other'].includes(row.type))
  assert.deepEqual(
    result.tree.find((row) => row.name === 'config'),
    { name: 'config', type: 'directory' }
  )

  // Evidence files: only safe candidate files, sorted, hashed correctly.
  assert.deepEqual(
    result.files.map((file) => file.path),
    [
      'AGENTS.md',
      'README.md',
      'config/app.yaml',
      'docs/design.md',
      'package.json',
      'test/index.test.js',
      'tsconfig.json'
    ]
  )
  const files = sampleWorkspaceFiles()
  for (const file of result.files) {
    assert.equal(file.sha256, sha256Hex(Buffer.from(files[file.path], 'utf8')), file.path)
    assert.equal(file.bytes, Buffer.byteLength(files[file.path], 'utf8'), file.path)
    assert.equal(file.skippedReason, undefined)
  }
  assert.equal(
    result.readBytes,
    result.files.reduce((sum, file) => sum + file.bytes, 0)
  )
  assert.deepEqual(result.explicitFiles, [])
  assert.deepEqual(result.warnings, [])

  // Roles are attached consistently with classifyRole.
  for (const file of result.files) assert.equal(file.role, classifyRole(file.path))

  // Denied files never appear as evidence.
  const evidencePaths = new Set(result.files.map((file) => file.path))
  for (const forbidden of ['.env', 'secret.key', 'cache.db', 'node_modules/pkg/index.js']) {
    assert.ok(!evidencePaths.has(forbidden), `${forbidden} must not be collected`)
  }
  // collectWorkspace never reads file text; it only hashes selected evidence.
  assert.equal(io.calls.filter((call) => call.op === 'readText').length, 0)
  assert.equal(
    io.calls.filter((call) => call.op === 'readBytes').length,
    result.files.filter((file) => file.sha256 !== '').length
  )
})

test('collectWorkspace is independent of io.listDir ordering', async () => {
  const fs = sampleFs({ git: true })
  const io = createFakeIo(fs)
  const baseline = await collectWorkspace({ workspaceRoot: WORKSPACE_ROOT, io })
  const reversed = createReversedIo(createFakeIo(fs))
  const fromReversed = await collectWorkspace({ workspaceRoot: WORKSPACE_ROOT, io: reversed })
  assert.deepEqual(fromReversed, baseline)
})

test('collectWorkspace skips symlinks (top-level and nested) instead of following them', async () => {
  const fs = customFs({
    'package.json': '{"name":"x"}\n',
    'src/index.js': 'export const x = 1\n',
    'README.md': '# hi\n'
  })
  fs.addSymlink('linked-readme.md', 'README.md')
  fs.addSymlink('src/linked.js', 'src/index.js')
  fs.addDirectory('target-dir')
  fs.addSymlink('linked-dir', 'target-dir')

  const result = await collectWorkspace({ workspaceRoot: WORKSPACE_ROOT, io: createFakeIo(fs) })
  assert.equal(result.symlinksSkipped, 3)
  assert.deepEqual(
    result.files.map((file) => file.path),
    ['README.md', 'package.json']
  )
  for (const file of result.files) assert.ok(!file.path.includes('linked'))
  const byName = new Map(result.tree.map((row) => [row.name, row]))
  assert.equal(byName.get('linked-readme.md').type, 'other')
  assert.equal(byName.get('linked-dir').type, 'other')
})

test('collectWorkspace stops at the entry, depth and tree bounds with warnings', async () => {
  const entryFs = customFs({ 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' })
  const entryLimited = await collectWorkspace({
    workspaceRoot: WORKSPACE_ROOT,
    io: createFakeIo(entryFs),
    limits: { maxEntries: 2 }
  })
  assert.equal(entryLimited.entries, 2)
  assert.equal(entryLimited.tree.length, 2)
  assert.ok(codesOf(entryLimited.warnings).includes('COLLECT_ENTRY_LIMIT'))

  const deepFs = customFs({ 'package.json': '{}\n', 'a/b/c/d/e/leaf.txt': 'deep' })
  const depthLimited = await collectWorkspace({
    workspaceRoot: WORKSPACE_ROOT,
    io: createFakeIo(deepFs),
    limits: { maxDepth: 2 }
  })
  assert.equal(depthLimited.entries, 3) // package.json, a, a/b
  assert.equal(depthLimited.dirs, 2) // root, a
  assert.ok(codesOf(depthLimited.warnings).includes('COLLECT_DEPTH_LIMIT'))

  const treeFs = customFs({ 'a': { type: 'directory' }, 'b': { type: 'directory' }, 'c.txt': 'c' })
  const treeLimited = await collectWorkspace({
    workspaceRoot: WORKSPACE_ROOT,
    io: createFakeIo(treeFs),
    limits: { maxTreeEntries: 2 }
  })
  assert.equal(treeLimited.tree.length, 2)
  assert.equal(treeLimited.tree[0].name, 'a')
  assert.equal(treeLimited.tree[1].name, 'b')
})

test('collectWorkspace truncates the evidence list at maxEvidenceFiles', async () => {
  const fs = sampleFs()
  const result = await collectWorkspace({
    workspaceRoot: WORKSPACE_ROOT,
    io: createFakeIo(fs),
    limits: { maxEvidenceFiles: 2 }
  })
  assert.deepEqual(
    result.files.map((file) => file.path),
    ['AGENTS.md', 'README.md']
  )
  assert.ok(codesOf(result.warnings).includes('COLLECT_FILE_LIMIT'))
})

test('collectWorkspace marks oversized evidence files without hashing them', async () => {
  const fs = customFs({
    'AGENTS.md': 'a'.repeat(100),
    'README.md': '# hi\n',
    'package.json': '{"name":"x"}\n'
  })
  const result = await collectWorkspace({
    workspaceRoot: WORKSPACE_ROOT,
    io: createFakeIo(fs),
    limits: { maxHashBytes: 10 }
  })
  const byPath = new Map(result.files.map((file) => [file.path, file]))
  for (const path of ['AGENTS.md', 'package.json']) {
    assert.equal(byPath.get(path).skippedReason, 'FILE_TOO_LARGE')
    assert.equal(byPath.get(path).sha256, '')
  }
  assert.equal(byPath.get('README.md').sha256, sha256Hex('# hi\n'))
  assert.equal(result.readBytes, Buffer.byteLength('# hi\n', 'utf8'))
})

test('collectWorkspace stops hashing at maxHashTotalBytes', async () => {
  const fs = customFs({
    'AGENTS.md': 'a'.repeat(50),
    'README.md': 'b'.repeat(50),
    'package.json': 'c'.repeat(50)
  })
  const result = await collectWorkspace({
    workspaceRoot: WORKSPACE_ROOT,
    io: createFakeIo(fs),
    limits: { maxHashTotalBytes: 60 }
  })
  assert.deepEqual(
    result.files.map((file) => file.path),
    ['AGENTS.md', 'README.md', 'package.json']
  )
  assert.equal(result.files[0].sha256, sha256Hex('a'.repeat(50)))
  assert.equal(result.readBytes, 50)
  assert.equal(result.files[1].skippedReason, 'HASH_TOTAL_LIMIT')
  assert.equal(result.files[2].skippedReason, 'HASH_TOTAL_LIMIT')
  assert.ok(codesOf(result.warnings).includes('COLLECT_HASH_LIMIT'))
})

test('collectWorkspace validates explicit files and rejects escapes/denied/missing paths', async () => {
  const fs = sampleFs()
  const io = createFakeIo(fs)
  const collect = (explicitFiles, limits) =>
    collectWorkspace({ workspaceRoot: WORKSPACE_ROOT, io, explicitFiles, limits })

  const accepted = await collect(['src/index.js', './src/index.js', 'src/index.js'])
  assert.deepEqual(accepted.explicitFiles, ['src/index.js'])
  assert.ok(accepted.files.some((file) => file.path === 'src/index.js'))
  assert.equal(
    accepted.files.find((file) => file.path === 'src/index.js').sha256,
    sha256Hex('export function main() {\n  return 42\n}\n')
  )

  const rejectsWith = async (explicitFiles, code) => {
    await assert.rejects(collect(explicitFiles), (error) => {
      assert.equal(error.code, code, `${JSON.stringify(explicitFiles)} should be ${code}`)
      return true
    })
  }
  await rejectsWith(['../AGENTS.md'], ERROR.PATH_ESCAPE)
  await rejectsWith(['/etc/passwd'], ERROR.PATH_ESCAPE)
  await rejectsWith(['C:\\ws\\AGENTS.md'], ERROR.PATH_ESCAPE)
  await rejectsWith(['.env'], ERROR.PATH_ESCAPE)
  await rejectsWith(['node_modules/pkg/index.js'], ERROR.PATH_ESCAPE)
  await rejectsWith(['missing.js'], ERROR.INVALID_ARGS)
  await rejectsWith(['src'], ERROR.INVALID_ARGS)

  await assert.rejects(collect(['AGENTS.md', 'README.md'], { maxExplicitFiles: 1 }), (error) => {
    assert.equal(error.code, ERROR.INVALID_ARGS)
    return true
  })

  // A symlinked ancestor is a path escape even when the leaf exists.
  const linkedFs = sampleFs()
  linkedFs.addSymlink('linked-src', 'src')
  await assert.rejects(
    collectWorkspace({
      workspaceRoot: WORKSPACE_ROOT,
      io: createFakeIo(linkedFs),
      explicitFiles: ['linked-src/index.js']
    }),
    (error) => error.code === ERROR.PATH_ESCAPE
  )
})

test('collectWorkspace adds trace-touched files that exist and skips the rest', async () => {
  const fs = sampleFs()
  fs.addFile('deep/a/b/c/d/file.js', 'export const deep = true\n')
  const trace = {
    touchedFiles: [
      { path: 'src/util.js', tool: 'read', count: 1, lastSeq: 3 },
      { path: 'src/index.js', tool: 'edit', count: 2, lastSeq: 9 },
      { path: '.env', tool: 'write', count: 1, lastSeq: 10 },
      { path: 'missing.js', tool: 'read', count: 1, lastSeq: 11 },
      { path: '../outside.js', tool: 'read', count: 1, lastSeq: 12 },
      { path: 'deep/a/b/c/d/file.js', tool: 'write', count: 1, lastSeq: 13 },
      { path: 'README.md', tool: 'read', count: 1, lastSeq: 14 }
    ]
  }
  const result = await collectWorkspace({
    workspaceRoot: WORKSPACE_ROOT,
    io: createFakeIo(fs),
    trace
  })
  const paths = result.files.map((file) => file.path)
  assert.ok(paths.includes('src/util.js'))
  assert.ok(paths.includes('src/index.js'))
  assert.ok(paths.includes('deep/a/b/c/d/file.js'))
  assert.ok(paths.includes('README.md'))
  assert.ok(!paths.includes('.env'))
  assert.ok(!paths.includes('missing.js'))
  assert.deepEqual(paths, [...paths].sort())
})

test('collectWorkspace excludes a DSH home nested inside the workspace', async () => {
  const fs = customFs({
    'package.json': '{"name":"x"}\n',
    'local-dsh/handoff/secret-out.txt': 'produced output\n'
  })
  const dshHome = join(WORKSPACE_ROOT, 'local-dsh')
  const result = await collectWorkspace({
    workspaceRoot: WORKSPACE_ROOT,
    workspaceCanonical: WORKSPACE_ROOT,
    dshHome,
    io: createFakeIo(fs)
  })
  assert.ok(result.denied >= 1)
  assert.ok(!result.files.some((file) => file.path.startsWith('local-dsh')))
})

test('collectWorkspace degrades an unreadable subdirectory to a warning', async () => {
  const fs = customFs({ 'package.json': '{}\n', 'src/index.js': 'x\n' })
  const io = createFakeIo(fs)
  const realListDir = io.listDir
  io.listDir = async (absolutePath) => {
    if (/[\\/]src$/.test(absolutePath)) throw new Error('permission denied')
    return realListDir(absolutePath)
  }
  const result = await collectWorkspace({ workspaceRoot: WORKSPACE_ROOT, io })
  assert.ok(codesOf(result.warnings).includes('COLLECT_UNREADABLE'))
  assert.deepEqual(
    result.files.map((file) => file.path),
    ['package.json']
  )
})

test('readCopyCandidate reads small text files and reports byte length', async () => {
  const fs = sampleFs()
  const io = createFakeIo(fs)
  const content = '# Agent notes\n\n- Keep changes small.\n'
  const result = await readCopyCandidate({
    io,
    workspaceRoot: WORKSPACE_ROOT,
    relPath: 'AGENTS.md',
    limits: LIMITS
  })
  assert.deepEqual(result, {
    path: 'AGENTS.md',
    content,
    bytes: Buffer.byteLength(content, 'utf8'),
    truncated: false
  })

  fs.addFile('empty.md', '')
  const empty = await readCopyCandidate({
    io,
    workspaceRoot: WORKSPACE_ROOT,
    relPath: 'empty.md',
    limits: LIMITS
  })
  assert.equal(empty.content, '')
  assert.equal(empty.bytes, 0)
  assert.equal(empty.truncated, false)
})

test('readCopyCandidate refuses denied/symlinked/missing/oversized paths', async () => {
  const fs = sampleFs()
  fs.addSymlink('linked', 'src')
  fs.addFile('big.md', 'x'.repeat(64))
  const io = createFakeIo(fs)
  const candidate = (relPath, limits = LIMITS, denied) =>
    readCopyCandidate({ io, workspaceRoot: WORKSPACE_ROOT, relPath, limits, denied })

  assert.deepEqual(await candidate('.env'), { path: '.env', skippedReason: 'DENIED' })
  assert.deepEqual(await candidate('node_modules/pkg/index.js'), {
    path: 'node_modules/pkg/index.js',
    skippedReason: 'DENIED'
  })
  assert.deepEqual(await candidate('linked/index.js'), { path: 'linked/index.js', skippedReason: 'SYMLINK' })
  assert.deepEqual(await candidate('nope.md'), { path: 'nope.md', skippedReason: 'NOT_FOUND' })
  assert.deepEqual(await candidate('src'), { path: 'src', skippedReason: 'NOT_REGULAR_FILE' })
  assert.deepEqual(await candidate('big.md', { ...LIMITS, copyMaxFileBytes: 16 }), {
    path: 'big.md',
    skippedReason: 'FILE_TOO_LARGE'
  })
  assert.deepEqual(await candidate('AGENTS.md', LIMITS, () => 'custom-deny'), {
    path: 'AGENTS.md',
    skippedReason: 'DENIED'
  })
  await assert.rejects(candidate('../AGENTS.md'), (error) => error.code === ERROR.PATH_ESCAPE)
})

test('readCopyCandidate truncates text when the io adapter hides the size', async () => {
  const fs = customFs({ 'AGENTS.md': 'x'.repeat(40), 'uni.md': 'é'.repeat(20) })
  const baseIo = createFakeIo(fs)
  const sizeHidingIo = {
    calls: baseIo.calls,
    async lstat(absolutePath) {
      const info = await baseIo.lstat(absolutePath)
      return info === undefined || info.type !== 'file' ? info : { type: 'file' }
    },
    readText: (absolutePath) => baseIo.readText(absolutePath),
    readBytes: (absolutePath, maxBytes) => baseIo.readBytes(absolutePath, maxBytes),
    listDir: (absolutePath) => baseIo.listDir(absolutePath)
  }
  const limits = { ...LIMITS, copyMaxFileBytes: 10 }
  const ascii = await readCopyCandidate({
    io: sizeHidingIo,
    workspaceRoot: WORKSPACE_ROOT,
    relPath: 'AGENTS.md',
    limits
  })
  assert.deepEqual(ascii, { path: 'AGENTS.md', content: 'x'.repeat(10), bytes: 10, truncated: true })

  // Multi-byte characters are never split by the truncation.
  const unicode = await readCopyCandidate({
    io: sizeHidingIo,
    workspaceRoot: WORKSPACE_ROOT,
    relPath: 'uni.md',
    limits
  })
  assert.equal(unicode.truncated, true)
  assert.equal(unicode.bytes, 10)
  assert.equal(unicode.content, 'é'.repeat(5))
})
