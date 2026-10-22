/**
 * Shared deterministic fixtures: fixed clock/random, a representative
 * workspace tree, a `.git` fixture writer, and session-event builders.
 *
 * Every test that needs "now" or a batch suffix must import the fixed values
 * here so two runs produce byte-identical artifacts.
 *
 * @module test/helpers/fixtures
 */

import { Buffer } from 'node:buffer'
import { createFakeFs } from './fake-fs.js'

/** One frozen instant for every generated artifact in tests. */
export const FIXED_NOW = new Date('2026-10-22T02:35:12.000Z')
/** ISO form of {@link FIXED_NOW}. */
export const FIXED_NOW_ISO = FIXED_NOW.toISOString()
/** Deterministic random suffix for batch ids. */
export const FIXED_SUFFIX = 'a1b2'
/** The batch id the service mints under the fixed clock/suffix. */
export const FIXED_BATCH_ID = '20261022T023512Z-a1b2'
/** Default fake workspace root (Windows style, as the real target is Windows). */
export const WORKSPACE_ROOT = 'C:\\ws'
/** Default fake user handoff home parent. */
export const DSH_HOME = 'C:\\Users\\test\\.dsh'

/** 40-hex git object ids used by the git fixtures. */
export const GIT_HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
export const GIT_PREV = '0f1e2d3c4b5a69788796a5b4c3d2e1f001234567'
export const GIT_BRANCH = 'main'
export const GIT_REMOTE = 'https://example.com/acme/fixture.git'
/** Epoch seconds of {@link FIXED_NOW}, as a reflog line stores it. */
export const GIT_TIME_SECONDS = Math.floor(FIXED_NOW.getTime() / 1000)

/** A clock function returning the fixed instant. */
export function fixedClock() {
  return FIXED_NOW
}

/** A random-suffix function returning the fixed suffix. */
export function fixedRandom() {
  return FIXED_SUFFIX
}

/**
 * Representative workspace tree. Sensitive, denied and ignored paths are
 * intentionally present so collector/redaction tests can prove they are
 * skipped or redacted.
 * @param {Record<string, string|Uint8Array|{type: string, target?: string}>} [overrides]
 * @returns {Record<string, string|Uint8Array|{type: string, target?: string}>}
 */
export function sampleWorkspaceFiles(overrides = {}) {
  return {
    'package.json': `${JSON.stringify(
      {
        name: 'fixture-app',
        version: '1.2.3',
        type: 'module',
        scripts: { test: 'node --test', build: 'node build.js' },
        dsh: { bundle: { patch: './cordis.patch.yml' } }
      },
      null,
      2
    )}\n`,
    'package-lock.json': '{"lockfileVersion": 3}\n',
    'README.md': '# Fixture app\n\nA small fixture workspace used by unit tests.\n',
    'AGENTS.md': '# Agent notes\n\n- Keep changes small.\n',
    'tsconfig.json': '{"compilerOptions": {"strict": true}}\n',
    'config/app.yaml': 'name: fixture\nport: 8080\n',
    'src/index.js': 'export function main() {\n  return 42\n}\n',
    'src/util.js': 'export const twice = (value) => value * 2\n',
    'test/index.test.js': "import test from 'node:test'\nimport assert from 'node:assert/strict'\ntest('ok', () => assert.equal(1, 1))\n",
    'docs/design.md': '# Design\n\nThe fixture has one module.\n',
    'dist/bundle.js': 'console.log("built")\n',
    '.gitignore': 'node_modules/\n.env\n',
    '.env': 'SECRET_TOKEN=super-secret-token-value\nDSH_TEST=1\n',
    'secret.key': '-----BEGIN PRIVATE KEY-----\nMIIEfake\n-----END PRIVATE KEY-----\n',
    'cache.db': 'SQLite format 3\u0000\n',
    'node_modules/pkg/index.js': 'module.exports = 1\n',
    '.dsh/handoff/old-batch/HANDOFF.md': '# previous output\n',
    ...overrides
  }
}

/**
 * Create a fake filesystem seeded with {@link sampleWorkspaceFiles}.
 * @param {{root?: string, files?: Record<string, unknown>, platform?: string}} [options]
 */
export function createFixtureFs(options = {}) {
  const root = options.root ?? WORKSPACE_ROOT
  const files = options.files === undefined ? sampleWorkspaceFiles() : options.files
  return createFakeFs({ root, files, platform: options.platform })
}

/**
 * Write a realistic `.git` directory into the fake filesystem.
 * @param {ReturnType<typeof createFakeFs>} fs
 * @param {{
 *   head?: string, branch?: string, detached?: boolean, refs?: Record<string, string>,
 *   packedRefs?: string|null, reflog?: string|null, config?: string|null,
 *   index?: Uint8Array|null, worktreeGitdir?: string|null
 * }} [options]
 */
export function addGitFixture(fs, options = {}) {
  const head = options.head ?? GIT_HEAD
  const branch = options.branch ?? GIT_BRANCH
  const refs = options.refs ?? { [`refs/heads/${branch}`]: head }
  const packedRefs =
    options.packedRefs === undefined ? null : options.packedRefs
  const reflog =
    options.reflog === undefined
      ? `${GIT_PREV} ${GIT_PREV} Test User <test@example.com> ${GIT_TIME_SECONDS - 3600} +0800\tcommit (initial): chore: init\n` +
        `${GIT_PREV} ${head} Test User <test@example.com> ${GIT_TIME_SECONDS} +0800\tcommit: feat: fixture handoff\n`
      : options.reflog
  const config =
    options.config === undefined
      ? '[core]\n\trepositoryformatversion = 0\n\tfilemode = false\n[remote "origin"]\n\turl = ' +
        GIT_REMOTE +
        '\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n'
      : options.config
  const index =
    options.index === undefined
      ? Buffer.concat([Buffer.from('DIRC', 'ascii'), Buffer.from([0, 0, 0, 2]), Buffer.alloc(24)])
      : options.index

  const write = (path, content) => {
    if (content !== null && content !== undefined) fs.addFile(path, content)
  }
  if (options.worktreeGitdir !== undefined) {
    fs.addFile('.git', `gitdir: ${options.worktreeGitdir}\n`)
    return
  }
  fs.addDirectory('.git')
  write('.git/HEAD', options.detached === true ? `${head}\n` : `ref: refs/heads/${branch}\n`)
  for (const [ref, sha] of Object.entries(refs)) write(`.git/${ref}`, `${sha}\n`)
  write('.git/packed-refs', packedRefs)
  write('.git/logs/HEAD', reflog)
  write('.git/config', config)
  if (index !== null) fs.addFile('.git/index', index)
}

/** Build one session-like object for the trace collector. */
export function makeSession({ id = 'session-test-1', cwd = WORKSPACE_ROOT, events = [] } = {}) {
  return {
    id,
    header: { cwd, version: 4, createdAt: FIXED_NOW.getTime(), isSeeded: false },
    events,
    ownEvents() {
      return this.events
    }
  }
}

let nextCallId = 0
/** A `tool/call` session event. */
export function toolCallEvent(seq, name, args) {
  nextCallId += 1
  return {
    type: 'tool/call',
    seq,
    time: FIXED_NOW.getTime(),
    data: {
      turn: 1,
      step: 1,
      callId: `call-${nextCallId}`,
      name,
      arguments: typeof args === 'string' ? args : JSON.stringify(args)
    }
  }
}

/** A `tool/result` session event. */
export function toolResultEvent(seq, { isError = false } = {}) {
  return {
    type: 'tool/result',
    seq,
    time: FIXED_NOW.getTime(),
    data: {
      turn: 1,
      step: 1,
      message: { role: 'tool', content: [], isError },
      ...(isError ? { error: { name: 'Error', code: 'SOME_ERROR' } } : {})
    }
  }
}

/** A representative tool/call sequence used by session-trace tests. */
export function sampleSessionEvents() {
  return [
    toolCallEvent(10, 'read', { path: 'src/index.js' }),
    toolCallEvent(20, 'edit', { path: 'src/index.js' }),
    toolCallEvent(30, 'write', { path: 'docs/design.md' }),
    toolCallEvent(40, 'pwsh', { command: 'node --test 2>&1 | Select-Object -First 5' }),
    toolResultEvent(50),
    toolCallEvent(60, 'pwsh', { command: 'git status' }),
    toolResultEvent(70, { isError: true }),
    toolCallEvent(80, 'read', { file_path: 'src/util.js' }),
    toolCallEvent(90, 'grep', { pattern: 'handoff', path: 'src' })
  ]
}
