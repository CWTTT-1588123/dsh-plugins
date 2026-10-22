import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

import {
  buildGitInfo,
  parseGitConfig,
  parseGitHead,
  parseIndexVersion,
  parsePackedRefs,
  parseReflog,
  readGitInfo
} from '../src/git.js'
import { createFakeFs } from './helpers/fake-fs.js'
import {
  GIT_BRANCH,
  GIT_HEAD,
  GIT_PREV,
  GIT_REMOTE,
  GIT_TIME_SECONDS,
  WORKSPACE_ROOT,
  addGitFixture
} from './helpers/fixtures.js'
import { createFakeIo } from './helpers/git-fixture.js'

const NEWEST_ISO = new Date(GIT_TIME_SECONDS * 1000).toISOString()
const OLDEST_ISO = new Date((GIT_TIME_SECONDS - 3600) * 1000).toISOString()

/** A valid `DIRC` index header with the given version plus padding. */
function indexBytes(version) {
  return Buffer.concat([
    Buffer.from('DIRC', 'ascii'),
    Buffer.from([(version >>> 24) & 0xff, (version >>> 16) & 0xff, (version >>> 8) & 0xff, version & 0xff]),
    Buffer.alloc(24)
  ])
}

/** Build a deterministic 40-hex sha for the given integer. */
function shaOf(value) {
  return value.toString(16).padStart(40, '0')
}

test('parseGitHead understands symbolic, detached and malformed HEAD files', () => {
  assert.deepEqual(parseGitHead(`ref: refs/heads/${GIT_BRANCH}\n`), {
    head: null,
    branch: GIT_BRANCH,
    detached: false
  })
  assert.deepEqual(parseGitHead('ref: refs/heads/feature/nested-branch'), {
    head: null,
    branch: 'feature/nested-branch',
    detached: false
  })
  assert.deepEqual(parseGitHead(`${GIT_HEAD}\n`), {
    head: GIT_HEAD,
    branch: null,
    detached: true
  })
  assert.deepEqual(parseGitHead('garbage'), { head: null, branch: null, detached: false })
  assert.deepEqual(parseGitHead(''), { head: null, branch: null, detached: false })
  assert.deepEqual(parseGitHead(null), { head: null, branch: null, detached: false })
  assert.deepEqual(parseGitHead('ref: refs/tags/v1'), {
    head: null,
    branch: null,
    detached: false
  })
})

test('parsePackedRefs reads refs, sorts keys and tolerates comments/peeled/corrupt lines', () => {
  const text = [
    '# pack-refs with: peeled fully-peeled sorted',
    `${GIT_HEAD} refs/heads/main`,
    `${GIT_PREV} refs/tags/v1`,
    `${GIT_PREV} refs/tags/v1^{}`,
    'this line is corrupt',
    '',
    '  not-a-sha refs/heads/broken  '
  ].join('\n')
  const refs = parsePackedRefs(text)
  assert.deepEqual(refs, {
    'refs/heads/main': GIT_HEAD,
    'refs/tags/v1': GIT_PREV
  })
  assert.deepEqual(Object.keys(refs), ['refs/heads/main', 'refs/tags/v1'])
  assert.deepEqual(parsePackedRefs(null), {})
  assert.deepEqual(parsePackedRefs(''), {})
})

test('parseReflog parses actor/time/message, strips commit prefixes and skips corrupt lines', () => {
  const text = [
    `${GIT_PREV} ${GIT_PREV} Test User <test@example.com> ${GIT_TIME_SECONDS - 3600} +0800\tcommit (initial): chore: init`,
    'garbage line',
    `${GIT_PREV} ${GIT_HEAD} Test User <test@example.com> ${GIT_TIME_SECONDS} +0800\tcommit: feat: fixture handoff`,
    `${GIT_HEAD} ${GIT_HEAD} Test User <test@example.com> not-a-number +0000\tcommit: bad time`
  ].join('\n')
  const entries = parseReflog(text)
  assert.equal(entries.length, 2)
  assert.deepEqual(entries[0], {
    oldSha: GIT_PREV,
    newSha: GIT_PREV,
    actor: 'Test User <test@example.com>',
    time: OLDEST_ISO,
    message: 'commit (initial): chore: init',
    subject: 'chore: init'
  })
  assert.deepEqual(entries[1], {
    oldSha: GIT_PREV,
    newSha: GIT_HEAD,
    actor: 'Test User <test@example.com>',
    time: NEWEST_ISO,
    message: 'commit: feat: fixture handoff',
    subject: 'feat: fixture handoff'
  })
  assert.deepEqual(parseReflog(undefined), [])
  // A line without a tab is still tolerated; the message is then empty.
  assert.equal(parseReflog(`${GIT_PREV} ${GIT_HEAD} A <a@b> 123 +0000`).length, 1)
})

test('parseGitConfig extracts only the origin remote URL', () => {
  assert.deepEqual(parseGitConfig(`[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${GIT_REMOTE}\n`), {
    remoteOriginUrl: GIT_REMOTE
  })
  assert.deepEqual(parseGitConfig(`[Remote "origin"]\n\tURL = "https://example.com/quoted.git"\n`), {
    remoteOriginUrl: 'https://example.com/quoted.git'
  })
  assert.deepEqual(parseGitConfig('[remote "origin"]\n\turl =   # comment only\n'), {
    remoteOriginUrl: null
  })
  assert.deepEqual(parseGitConfig(`[remote "upstream"]\n\turl = ${GIT_REMOTE}\n`), {
    remoteOriginUrl: null
  })
  assert.deepEqual(parseGitConfig(`[remote "origin"]\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`), {
    remoteOriginUrl: null
  })
  assert.deepEqual(parseGitConfig(`[core]\n\turl = ${GIT_REMOTE}\n`), { remoteOriginUrl: null })
  assert.deepEqual(parseGitConfig(''), { remoteOriginUrl: null })
  assert.deepEqual(parseGitConfig(null), { remoteOriginUrl: null })
})

test('parseIndexVersion returns DIRC v2/v3/v4 or null', () => {
  assert.equal(parseIndexVersion(indexBytes(2)), 2)
  assert.equal(parseIndexVersion(indexBytes(3)), 3)
  assert.equal(parseIndexVersion(indexBytes(4)), 4)
  assert.equal(parseIndexVersion(indexBytes(5)), null)
  assert.equal(parseIndexVersion(Buffer.from('NOPE0000')), null)
  assert.equal(parseIndexVersion(Buffer.from('DIRC')), null)
  assert.equal(parseIndexVersion(new Uint8Array(0)), null)
  assert.equal(parseIndexVersion(null), null)
  assert.equal(parseIndexVersion('DIRC'), null)
})

test('buildGitInfo assembles the fixed-shape git block from loose refs', () => {
  const git = buildGitInfo({
    headText: `ref: refs/heads/${GIT_BRANCH}\n`,
    refs: { [`refs/heads/${GIT_BRANCH}`]: GIT_HEAD },
    packedRefs: null,
    reflog: `${GIT_PREV} ${GIT_HEAD} Test User <test@example.com> ${GIT_TIME_SECONDS} +0800\tcommit: feat: fixture handoff\n`,
    config: `[remote "origin"]\n\turl = ${GIT_REMOTE}\n`,
    indexBytes: indexBytes(2)
  })
  assert.deepEqual(git, {
    head: GIT_HEAD,
    branch: GIT_BRANCH,
    detached: false,
    remote: GIT_REMOTE,
    lastCommit: { sha: GIT_HEAD, time: NEWEST_ISO, subject: 'feat: fixture handoff' },
    indexVersion: 2,
    packedRefsPresent: false,
    reflog: [{ sha: GIT_HEAD, time: NEWEST_ISO, subject: 'feat: fixture handoff' }]
  })
  assert.deepEqual(Object.keys(git), [
    'head',
    'branch',
    'detached',
    'remote',
    'lastCommit',
    'indexVersion',
    'packedRefsPresent',
    'reflog'
  ])
})

test('buildGitInfo resolves a symbolic HEAD from packed-refs and honors detached HEAD', () => {
  const packed = buildGitInfo({
    headText: `ref: refs/heads/${GIT_BRANCH}\n`,
    refs: {},
    packedRefs: `# pack-refs with: peeled\n${GIT_HEAD} refs/heads/${GIT_BRANCH}\n`
  })
  assert.equal(packed.head, GIT_HEAD)
  assert.equal(packed.branch, GIT_BRANCH)
  assert.equal(packed.packedRefsPresent, true)

  const detached = buildGitInfo({ headText: `${GIT_HEAD}\n`, refs: {} })
  assert.deepEqual(
    { head: detached.head, branch: detached.branch, detached: detached.detached },
    { head: GIT_HEAD, branch: null, detached: true }
  )

  const unresolved = buildGitInfo({ headText: `ref: refs/heads/${GIT_BRANCH}\n`, refs: {} })
  assert.equal(unresolved.head, null)
  assert.equal(unresolved.branch, GIT_BRANCH)
  assert.equal(unresolved.detached, false)
  assert.equal(unresolved.lastCommit, null)
  assert.equal(unresolved.indexVersion, null)
})

test('buildGitInfo caps reflog at the 10 newest entries, newest first', () => {
  const lines = []
  for (let value = 1; value <= 12; value += 1) {
    lines.push(`${shaOf(value - 1)} ${shaOf(value)} A <a@b> ${GIT_TIME_SECONDS + value} +0000\tcommit: c${value}`)
  }
  const git = buildGitInfo({
    headText: `ref: refs/heads/${GIT_BRANCH}\n`,
    refs: { [`refs/heads/${GIT_BRANCH}`]: GIT_HEAD },
    reflog: lines.join('\n')
  })
  assert.equal(git.reflog.length, 10)
  assert.equal(git.reflog[0].sha, shaOf(12))
  assert.equal(git.reflog[0].subject, 'c12')
  assert.equal(git.reflog[9].sha, shaOf(3))
  assert.deepEqual(git.lastCommit, {
    sha: shaOf(12),
    time: new Date((GIT_TIME_SECONDS + 12) * 1000).toISOString(),
    subject: 'c12'
  })
})

test('readGitInfo reads a complete repository using only .git paths', async () => {
  const fs = createFakeFs({ root: WORKSPACE_ROOT, files: { 'package.json': '{"name":"x"}\n' } })
  addGitFixture(fs)
  const io = createFakeIo(fs)
  const result = await readGitInfo({ io, workspaceRoot: WORKSPACE_ROOT })

  assert.deepEqual(result.warnings, [])
  assert.deepEqual(result.git, {
    head: GIT_HEAD,
    branch: GIT_BRANCH,
    detached: false,
    remote: GIT_REMOTE,
    lastCommit: { sha: GIT_HEAD, time: NEWEST_ISO, subject: 'feat: fixture handoff' },
    indexVersion: 2,
    packedRefsPresent: false,
    reflog: [
      { sha: GIT_HEAD, time: NEWEST_ISO, subject: 'feat: fixture handoff' },
      { sha: GIT_PREV, time: OLDEST_ISO, subject: 'chore: init' }
    ]
  })

  const gitDir = resolve(WORKSPACE_ROOT, '.git').toLowerCase()
  assert.ok(io.calls.length > 0)
  for (const call of io.calls) {
    assert.ok(
      call.path.toLowerCase().startsWith(gitDir),
      `readGitInfo must only touch .git, touched ${call.path}`
    )
  }
})

test('readGitInfo handles a detached HEAD', async () => {
  const fs = createFakeFs({ root: WORKSPACE_ROOT })
  addGitFixture(fs, { detached: true })
  const { git, warnings } = await readGitInfo({ io: createFakeIo(fs), workspaceRoot: WORKSPACE_ROOT })
  assert.deepEqual(warnings, [])
  assert.equal(git.head, GIT_HEAD)
  assert.equal(git.branch, null)
  assert.equal(git.detached, true)
})

test('readGitInfo resolves a symbolic HEAD from packed-refs when no loose ref exists', async () => {
  const fs = createFakeFs({ root: WORKSPACE_ROOT })
  addGitFixture(fs, {
    refs: {},
    packedRefs: `# pack-refs with: peeled fully-peeled sorted\n${GIT_HEAD} refs/heads/${GIT_BRANCH}\n`
  })
  const { git, warnings } = await readGitInfo({ io: createFakeIo(fs), workspaceRoot: WORKSPACE_ROOT })
  assert.deepEqual(warnings, [])
  assert.equal(git.head, GIT_HEAD)
  assert.equal(git.packedRefsPresent, true)
})

test('readGitInfo without a .git directory degrades to GIT_UNAVAILABLE', async () => {
  const fs = createFakeFs({ root: WORKSPACE_ROOT, files: { 'README.md': '# x\n' } })
  const result = await readGitInfo({ io: createFakeIo(fs), workspaceRoot: WORKSPACE_ROOT })
  assert.equal(result.git, null)
  assert.deepEqual(
    result.warnings.map((warning) => warning.code),
    ['GIT_UNAVAILABLE']
  )
})

test('readGitInfo treats a symlinked or foreign .git entry as unavailable', async () => {
  const fs = createFakeFs({
    root: WORKSPACE_ROOT,
    files: { '.git': { type: 'symlink', target: '.git-real' }, '.git-real/HEAD': 'x' }
  })
  const result = await readGitInfo({ io: createFakeIo(fs), workspaceRoot: WORKSPACE_ROOT })
  assert.equal(result.git, null)
  assert.equal(result.warnings[0].code, 'GIT_UNAVAILABLE')
})

test('readGitInfo follows a relative "gitdir:" pointer from a .git file', async () => {
  const fs = createFakeFs({ root: WORKSPACE_ROOT })
  addGitFixture(fs, { worktreeGitdir: '.git-worktrees/wt' })
  fs.addFile('.git-worktrees/wt/HEAD', `ref: refs/heads/feature/nested\n`)
  fs.addFile('.git-worktrees/wt/refs/heads/feature/nested', `${GIT_HEAD}\n`)
  fs.addFile('.git-worktrees/wt/config', `[remote "origin"]\n\turl = ${GIT_REMOTE}\n`)
  fs.addFile('.git-worktrees/wt/index', indexBytes(4))

  const { git, warnings } = await readGitInfo({ io: createFakeIo(fs), workspaceRoot: WORKSPACE_ROOT })
  assert.deepEqual(warnings, [])
  assert.equal(git.head, GIT_HEAD)
  assert.equal(git.branch, 'feature/nested')
  assert.equal(git.indexVersion, 4)
  assert.equal(git.remote, GIT_REMOTE)
})

test('readGitInfo follows an absolute "gitdir:" pointer from a .git file', async () => {
  const fs = createFakeFs({ root: WORKSPACE_ROOT })
  const externalGitDir = resolve(WORKSPACE_ROOT, '..', 'external-wt')
  fs.addFile('.git', `gitdir: ${externalGitDir}\n`)
  fs.addFile(join(externalGitDir, 'HEAD'), `ref: refs/heads/${GIT_BRANCH}\n`)
  fs.addFile(join(externalGitDir, 'refs', 'heads', GIT_BRANCH), `${GIT_HEAD}\n`)

  const { git, warnings } = await readGitInfo({ io: createFakeIo(fs), workspaceRoot: WORKSPACE_ROOT })
  assert.deepEqual(warnings, [])
  assert.equal(git.head, GIT_HEAD)
  assert.equal(git.branch, GIT_BRANCH)
})

test('readGitInfo warns GIT_HEAD_UNRESOLVED for an empty .git directory', async () => {
  const fs = createFakeFs({ root: WORKSPACE_ROOT })
  fs.addDirectory('.git')
  const { git, warnings } = await readGitInfo({ io: createFakeIo(fs), workspaceRoot: WORKSPACE_ROOT })
  assert.equal(git.head, null)
  assert.equal(git.branch, null)
  assert.deepEqual(
    warnings.map((warning) => warning.code),
    ['GIT_HEAD_UNRESOLVED']
  )
})

test('readGitInfo tolerates corrupt HEAD/packed-refs/reflog lines', async () => {
  const fs = createFakeFs({ root: WORKSPACE_ROOT })
  addGitFixture(fs, {
    refs: {},
    packedRefs: `nonsense line\n${GIT_HEAD} refs/heads/${GIT_BRANCH}\n`,
    reflog:
      'totally corrupt reflog line\n' +
      `${GIT_PREV} ${GIT_HEAD} Test User <test@example.com> ${GIT_TIME_SECONDS} +0800\tcommit: feat: recovered\n`
  })
  fs.addFile('.git/HEAD', 'ref: refs/heads/main\n')
  const { git, warnings } = await readGitInfo({ io: createFakeIo(fs), workspaceRoot: WORKSPACE_ROOT })
  assert.deepEqual(warnings, [])
  assert.equal(git.head, GIT_HEAD)
  assert.equal(git.lastCommit.subject, 'feat: recovered')
  assert.equal(git.reflog.length, 1)

  const garbageFs = createFakeFs({ root: WORKSPACE_ROOT })
  addGitFixture(garbageFs)
  garbageFs.addFile('.git/HEAD', 'not a valid HEAD\n')
  const broken = await readGitInfo({ io: createFakeIo(garbageFs), workspaceRoot: WORKSPACE_ROOT })
  assert.equal(broken.git.head, null)
  assert.deepEqual(
    broken.warnings.map((warning) => warning.code),
    ['GIT_HEAD_UNRESOLVED']
  )
})

test('readGitInfo degrades unreadable HEAD/reflog/config/index to warnings', async () => {
  const fs = createFakeFs({ root: WORKSPACE_ROOT })
  addGitFixture(fs)
  fs.setReadFailure('.git/HEAD')
  fs.setReadFailure('.git/logs/HEAD')
  fs.setReadFailure('.git/config')
  const io = createFakeIo(fs)
  // fake-fs only models read failures for text reads; simulate a denied byte
  // read for the index so the GIT_INDEX_UNREADABLE branch is exercised too.
  io.readBytes = async (absolutePath, maxBytes) => {
    if (absolutePath.toLowerCase().endsWith('index')) {
      const error = new Error('denied')
      error.code = 'FS_DENIED'
      throw error
    }
    const target = await fs.resolve(absolutePath)
    return fs.readBytes(target, undefined, maxBytes)
  }
  const { git, warnings } = await readGitInfo({ io, workspaceRoot: WORKSPACE_ROOT })
  assert.equal(git.head, null)
  assert.equal(git.remote, null)
  assert.equal(git.indexVersion, null)
  assert.equal(git.lastCommit, null)
  assert.deepEqual(
    warnings.map((warning) => warning.code),
    ['GIT_HEAD_UNRESOLVED', 'GIT_REFLOG_UNREADABLE', 'GIT_CONFIG_UNREADABLE', 'GIT_INDEX_UNREADABLE']
  )
})

test('readGitInfo reports a corrupt or truncated index header without throwing', async () => {
  const corruptFs = createFakeFs({ root: WORKSPACE_ROOT })
  addGitFixture(corruptFs, { index: Buffer.alloc(32, 0x58) })
  const corrupt = await readGitInfo({ io: createFakeIo(corruptFs), workspaceRoot: WORKSPACE_ROOT })
  assert.equal(corrupt.git.indexVersion, null)
  assert.deepEqual(
    corrupt.warnings.map((warning) => warning.code),
    ['GIT_INDEX_UNREADABLE']
  )

  const truncatedFs = createFakeFs({ root: WORKSPACE_ROOT })
  addGitFixture(truncatedFs, { index: Buffer.from('DIR') })
  const truncated = await readGitInfo({ io: createFakeIo(truncatedFs), workspaceRoot: WORKSPACE_ROOT })
  assert.equal(truncated.git.indexVersion, null)
  assert.deepEqual(
    truncated.warnings.map((warning) => warning.code),
    ['GIT_INDEX_UNREADABLE']
  )
})

test('readGitInfo never throws when the io adapter fails entirely', async () => {
  const result = await readGitInfo({ io: null, workspaceRoot: WORKSPACE_ROOT })
  assert.equal(result.git, null)
  assert.equal(result.warnings[0].code, 'GIT_UNAVAILABLE')

  const throwingIo = {
    async lstat() {
      throw new Error('boom')
    },
    async readText() {
      throw new Error('boom')
    },
    async readBytes() {
      throw new Error('boom')
    },
    async listDir() {
      throw new Error('boom')
    }
  }
  const thrown = await readGitInfo({ io: throwingIo, workspaceRoot: WORKSPACE_ROOT })
  assert.equal(thrown.git, null)
  assert.equal(thrown.warnings[0].code, 'GIT_UNAVAILABLE')
  assert.match(thrown.warnings[0].detail, /cannot inspect \.git/)
})
