import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ERROR, handoffError } from '../src/contracts.js'
import {
  artifactDirname,
  batchTimestampToIso,
  compareBatchIds,
  detokenizePath,
  formatBatchTimestamp,
  isAbsoluteAny,
  isBatchId,
  isGitSha,
  isInside,
  makeBatchId,
  normalizeArtifactPath,
  projectKey,
  relativeToWorkspace,
  resolveArtifact,
  resolveInside,
  sha256Hex,
  shortHash,
  slugifyName,
  tokenizePath,
  toPosix,
  validateRelativePath
} from '../src/paths.js'
import {
  DSH_HOME,
  FIXED_BATCH_ID,
  FIXED_NOW,
  FIXED_SUFFIX,
  GIT_HEAD,
  GIT_REMOTE,
  WORKSPACE_ROOT
} from './helpers/fixtures.js'

test('sha256Hex hashes UTF-8 strings and byte arrays identically and deterministically', () => {
  assert.equal(
    sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  )
  assert.equal(sha256Hex(new TextEncoder().encode('abc')), sha256Hex('abc'))
  assert.equal(sha256Hex('abc'), sha256Hex('abc'))
  assert.notEqual(sha256Hex('abc'), sha256Hex('abd'))
  assert.equal(shortHash(sha256Hex('abc'), 8), 'ba7816bf')
})

test('slugifyName produces the documented charset and never an empty slug', () => {
  assert.equal(slugifyName('stand'), 'stand')
  assert.equal(slugifyName('My Repo (v2)'), 'my-repo-v2')
  assert.equal(slugifyName('UPPER_case.name'), 'upper_case.name')
  assert.equal(slugifyName('---'), 'workspace')
  assert.equal(slugifyName(''), 'workspace')
  assert.equal(slugifyName('a'.repeat(80)).length, 40)
  assert.match(slugifyName('  weird -- name  '), /^[a-z0-9._-]+$/)
})

test('project key prefers the remote URL and falls back to the canonical workspace', () => {
  const key = projectKey({
    repoRoot: 'D:\\repos\\demo',
    remoteUrl: GIT_REMOTE,
    workspaceCanonical: 'D:\\repos\\demo'
  })
  assert.match(key, /^demo-[0-9a-f]{8}$/)
  const sameRemoteElsewhere = projectKey({
    repoRoot: 'D:\\repos\\demo',
    remoteUrl: GIT_REMOTE,
    workspaceCanonical: 'E:\\other\\demo'
  })
  assert.equal(key, sameRemoteElsewhere)

  const withoutRemote = projectKey({
    repoRoot: 'D:\\repos\\demo',
    remoteUrl: '',
    workspaceCanonical: 'D:\\repos\\demo'
  })
  assert.match(withoutRemote, /^demo-[0-9a-f]{8}$/)
  assert.notEqual(withoutRemote, key)
  const differentPath = projectKey({
    repoRoot: 'D:\\repos\\demo',
    remoteUrl: '   ',
    workspaceCanonical: 'D:\\repos\\other'
  })
  assert.notEqual(withoutRemote, differentPath)
})

test('batch ids are fixed width, time sortable and UTC based', () => {
  const id = makeBatchId({ date: FIXED_NOW, suffix: FIXED_SUFFIX })
  assert.equal(id, FIXED_BATCH_ID)
  assert.equal(formatBatchTimestamp(FIXED_NOW), '20261022T023512Z')
  assert.equal(isBatchId(id), true)
  assert.equal(isBatchId('20261022T023512Z-abcd-extra'), false)
  assert.equal(isBatchId('2026102T023512Z-a1b2'), false)
  const earlier = makeBatchId({ date: new Date('2026-10-22T02:35:11.000Z'), suffix: 'ffff' })
  const later = makeBatchId({ date: new Date('2026-10-22T02:35:12.000Z'), suffix: '0000' })
  assert.equal(compareBatchIds(earlier, later), -1)
  assert.equal(compareBatchIds(later, earlier), 1)
  assert.equal(compareBatchIds(earlier, earlier), 0)
  assert.equal(batchTimestampToIso(id), '2026-10-22T02:35:12.000Z')
  assert.equal(batchTimestampToIso('nope'), undefined)
  assert.throws(
    () => makeBatchId({ date: FIXED_NOW, suffix: 'XYZ1' }),
    (error) => error.code === ERROR.INTERNAL
  )
})

test('git sha helper accepts only 40 lower-case hex characters', () => {
  assert.equal(isGitSha(GIT_HEAD), true)
  assert.equal(isGitSha(GIT_HEAD.toUpperCase()), false)
  assert.equal(isGitSha('abc'), false)
  assert.equal(isGitSha(undefined), false)
})

test('absolute detection covers Windows, POSIX and UNC spellings', () => {
  for (const value of ['C:\\ws', 'c:/ws', 'C:ws', '\\\\server\\share', '/etc/passwd', '\\rooted', '..\\x'])
    assert.equal(isAbsoluteAny(value), value === '..\\x' ? false : true, value)
  for (const value of ['a/b', './a', 'a\\b', '..'])
    assert.equal(isAbsoluteAny(value), false, value)
})

test('validateRelativePath accepts workspace-relative paths only', () => {
  assert.equal(validateRelativePath('docs/design.md'), 'docs/design.md')
  assert.equal(validateRelativePath('a\\b\\c.txt'), 'a/b/c.txt')
  assert.equal(validateRelativePath('./a/b'), 'a/b')
  assert.equal(validateRelativePath('  README.md  '), 'README.md')
  assert.equal(validateRelativePath('a//b'), 'a/b')

  for (const raw of [
    '',
    '   ',
    '.',
    '..',
    '../AGENTS.md',
    'a/../../b',
    'C:\\ws\\a',
    'C:relative',
    '/etc/passwd',
    '\\\\server\\share\\file',
    'a\0b'
  ]) {
    assert.throws(
      () => validateRelativePath(raw),
      (error) => error.code === ERROR.PATH_ESCAPE,
      `expected HANDOFF_PATH_ESCAPE for ${JSON.stringify(raw)}`
    )
  }
  assert.throws(() => validateRelativePath(42), (error) => error.code === ERROR.PATH_ESCAPE)
})

test('isInside handles boundaries, siblings, casing and dot segments', () => {
  const root = 'C:\\ws'
  assert.equal(isInside(root, root), true)
  assert.equal(isInside(root, 'C:\\ws\\a\\b'), true)
  assert.equal(isInside(root, 'C:\\ws\\..\\ws2'), false)
  assert.equal(isInside(root, 'C:\\ws2'), false)
  assert.equal(isInside(root, 'C:\\ws\\a'), true)
  assert.equal(isInside(root, 'c:\\WS\\A'), true)
  assert.equal(isInside(root, 'c:\\WS\\A', { platform: 'linux' }), false)
  assert.equal(isInside('/opt/ws', '/opt/ws/a'), true)
  assert.equal(isInside('/opt/ws', '/opt/ws2'), false)
  assert.equal(isInside('C:\\ws', 'C:\\ws\\..\\x'), false)
})

test('resolveInside rejects escapes with HANDOFF_PATH_ESCAPE', () => {
  assert.equal(resolveInside('C:\\ws', 'a/b.txt'), 'C:\\ws\\a\\b.txt')
  assert.throws(
    () => resolveInside('C:\\ws', '..\\outside.txt'),
    (error) => error.code === ERROR.PATH_ESCAPE
  )
})

test('tokenizePath and detokenizePath round-trip workspace and DSH home paths', () => {
  const contexts = { workspaceRoot: WORKSPACE_ROOT, dshHome: DSH_HOME }
  assert.equal(tokenizePath('C:\\ws', contexts), '$WORKSPACE')
  assert.equal(tokenizePath('C:\\ws\\src\\index.js', contexts), '$WORKSPACE/src/index.js')
  assert.equal(tokenizePath('C:\\Users\\test\\.dsh\\handoff\\x', contexts), '$DSH_HOME/handoff/x')
  assert.equal(tokenizePath('D:\\elsewhere\\x', contexts), 'D:/elsewhere/x')
  assert.equal(tokenizePath('c:\\WS\\src\\a.js', contexts), '$WORKSPACE/src/a.js')
  assert.equal(detokenizePath('$WORKSPACE/src/a.js', contexts), 'C:\\ws\\src\\a.js')
  assert.equal(detokenizePath('$DSH_HOME/handoff', contexts), 'C:\\Users\\test\\.dsh\\handoff')
  assert.equal(detokenizePath('D:\\elsewhere\\x', contexts), 'D:\\elsewhere\\x')
  assert.throws(
    () => detokenizePath('$HOME/x', contexts),
    (error) => error.code === ERROR.PATH_ESCAPE
  )
  assert.throws(
    () => detokenizePath('relative/x', contexts),
    (error) => error.code === ERROR.PATH_ESCAPE
  )
})

test('relativeToWorkspace returns POSIX relative paths or undefined', () => {
  assert.equal(relativeToWorkspace(WORKSPACE_ROOT, 'C:\\ws'), '')
  assert.equal(relativeToWorkspace(WORKSPACE_ROOT, 'C:\\ws\\docs\\a.md'), 'docs/a.md')
  assert.equal(relativeToWorkspace(WORKSPACE_ROOT, 'C:\\other\\a.md'), undefined)
  assert.equal(toPosix('a\\b\\c'), 'a/b/c')
})

test('artifact path helpers normalize and resolve batch-relative paths', () => {
  assert.equal(normalizeArtifactPath('evidence\\git.json'), 'evidence/git.json')
  assert.equal(artifactDirname('evidence/git.json'), 'evidence')
  assert.equal(artifactDirname('HANDOFF.md'), '')
  assert.equal(resolveArtifact('C:\\out\\batch', 'HANDOFF.md'), 'C:\\out\\batch\\HANDOFF.md')
  assert.throws(
    () => resolveArtifact('C:\\out\\batch', '..\\evil.json'),
    (error) => error.code === ERROR.PATH_ESCAPE
  )
  assert.throws(() => resolveArtifact('C:\\out\\batch', 'C:\\x'), (error) => error.code === ERROR.PATH_ESCAPE)
  assert.equal(handoffError(ERROR.PATH_ESCAPE, 'x').code, 'HANDOFF_PATH_ESCAPE')
})
