/**
 * Deterministic manifest / HANDOFF.md fixtures shared by `manifest.test.js` and
 * `render.test.js`.
 *
 * All identities, timestamps and hashes are pinned so two runs produce identical
 * bytes. Caller-provided content mirrors what the collector/service would pass
 * into `createManifest`.
 *
 * @module test/helpers/manifest-fixture
 */

import { Buffer } from 'node:buffer'

import { artifactEntry, createManifest, setArtifacts } from '../../src/manifest.js'
import { sha256Hex } from '../../src/paths.js'
import { FIXED_BATCH_ID, FIXED_NOW_ISO, GIT_HEAD, GIT_PREV, GIT_REMOTE } from './fixtures.js'

/** Tokenized workspace path used by every fixture. */
export const WORKSPACE_TOKEN = '$WORKSPACE'
/** Tokenized DSH-home path used by every fixture. */
export const DSH_HOME_TOKEN = '$DSH_HOME'

/**
 * Evidence files collected for the sample workspace, sorted by path as the
 * collector would return them.
 */
export const EVIDENCE_FILES = Object.freeze([
  { path: 'AGENTS.md', role: 'entry', content: '# Agent notes\n\n- Keep changes small.\n' },
  { path: 'README.md', role: 'doc', content: '# Fixture app\n\nA small fixture workspace.\n' },
  { path: 'config/app.yaml', role: 'config', content: 'name: fixture\nport: 8080\n' },
  { path: 'dist/bundle.js', role: 'other', content: 'console.log("built")\n' },
  { path: 'docs/design.md', role: 'doc', content: '# Design\n\nThe fixture has one module.\n' },
  {
    path: 'package.json',
    role: 'entry',
    content: '{\n  "name": "fixture-app",\n  "version": "1.2.3"\n}\n'
  },
  { path: 'src/index.js', role: 'source', content: 'export function main() {\n  return 42\n}\n' },
  { path: 'src/util.js', role: 'source', content: 'export const twice = (value) => value * 2\n' },
  {
    path: 'test/index.test.js',
    role: 'test',
    content: "import test from 'node:test'\ntest('ok', () => {})\n"
  },
  { path: 'tsconfig.json', role: 'config', content: '{"compilerOptions":{"strict":true}}\n' }
])

/** Artifact contents written into the sample batch (path -> text). */
export const ARTIFACT_CONTENTS = Object.freeze({
  'HANDOFF.md': '# Fixture handoff\n\n(placeholder body)\n',
  'SHA256SUMS': `${'0'.repeat(64)}  HANDOFF.md\n`,
  'evidence/files.json': '{"files":[]}\n',
  'evidence/git.json': '{"head":null}\n',
  'evidence/redactions.json': '[]\n',
  'evidence/session.json': '{"eventCounts":{"total":0}}\n'
})

/** Evidence-file entries as the collector would hand them to the manifest. */
export function evidenceFileEntries() {
  return EVIDENCE_FILES.map((file) => ({
    path: file.path,
    role: file.role,
    bytes: Buffer.byteLength(file.content, 'utf8'),
    sha256: sha256Hex(file.content)
  }))
}

/**
 * Fully populated `createManifest` input. `overrides` is a shallow merge, so a
 * test that changes one block must pass the whole replacement block.
 * @param {Record<string, unknown>} [overrides]
 * @returns {Record<string, unknown>}
 */
export function sampleManifestInput(overrides = {}) {
  return {
    batchId: FIXED_BATCH_ID,
    createdAt: FIXED_NOW_ISO,
    generator: {
      name: 'dsh-handoff-kit',
      version: '0.1.0',
      dshVersion: '0.2.0-test',
      platform: 'win32'
    },
    project: {
      key: 'fixture-app-1a2b3c4d',
      name: 'fixture-app',
      workspace: WORKSPACE_TOKEN
    },
    session: { id: 'session-test-1', cwd: WORKSPACE_TOKEN, agentPreset: 'default' },
    sandbox: { mode: 'danger-full-access', workspaceRoot: WORKSPACE_TOKEN },
    inputs: {
      title: 'Fixture handoff',
      goal: 'Hand the fixture workspace to a fresh session.',
      summary: 'Implemented the manifest and render modules; unit tests are green.',
      decisions: ['Use tokenized machine paths', 'Never invent caller narrative'],
      nextSteps: ['Run the full suite'],
      concepts: ['handoff package = HANDOFF.md + manifest.json + evidence'],
      flow: ['scan collects evidence', 'create writes the batch'],
      risks: ['No mtime is available for change detection'],
      files: ['src/index.js'],
      copyFiles: false
    },
    git: {
      head: GIT_HEAD,
      branch: 'main',
      detached: false,
      remote: GIT_REMOTE,
      lastCommit: {
        sha: GIT_HEAD,
        time: FIXED_NOW_ISO,
        subject: 'feat: fixture handoff'
      },
      indexVersion: 2,
      packedRefsPresent: false,
      reflog: [{ sha: GIT_PREV, time: FIXED_NOW_ISO, subject: 'feat: fixture handoff' }]
    },
    files: evidenceFileEntries(),
    sessionTrace: {
      sessionId: 'session-test-1',
      eventCounts: { total: 120, toolCalls: 9, toolErrors: 1 },
      toolCalls: { total: 9, byName: { edit: 2, pwsh: 2, read: 3 } },
      touchedFiles: [
        { path: 'src/index.js', tool: 'edit', count: 2, lastSeq: 90 },
        { path: 'docs/design.md', tool: 'write', count: 1, lastSeq: 40 }
      ],
      commands: [{ tool: 'pwsh', commandRedacted: 'node --test', lastSeq: 50 }],
      window: { events: 120, truncated: false }
    },
    redactions: [{ file: 'evidence/files/config/app.yaml', kind: 'generic-assignment', count: 1 }],
    warnings: [
      { code: 'GIT_INDEX_UNREADABLE', detail: 'could not read .git/index' },
      { code: 'COLLECT_DEPTH_LIMIT', detail: 'stopped at depth 4' }
    ],
    scan: {
      entries: 42,
      dirs: 8,
      denied: 5,
      symlinksSkipped: 1,
      readBytes: 8192,
      explicitFiles: ['src/index.js'],
      tree: [
        { name: 'AGENTS.md', type: 'file', bytes: 37 },
        { name: 'README.md', type: 'file', bytes: 42 },
        { name: 'config', type: 'directory' },
        { name: 'dist', type: 'directory' },
        { name: 'docs', type: 'directory' },
        { name: 'package.json', type: 'file', bytes: 50 },
        { name: 'src', type: 'directory' },
        { name: 'test', type: 'directory' },
        { name: 'tsconfig.json', type: 'file', bytes: 36 }
      ]
    },
    target: 'user',
    ...overrides
  }
}

/**
 * Build the fully populated sample manifest with every artifact attached.
 * @returns {Record<string, unknown>}
 */
export function sampleManifest() {
  const manifest = createManifest(sampleManifestInput())
  const artifacts = Object.keys(ARTIFACT_CONTENTS).map((path) =>
    artifactEntry(path, ARTIFACT_CONTENTS[path])
  )
  return setArtifacts(manifest, artifacts)
}

/**
 * Build a minimal manifest: identity only, every optional block normalized to
 * its empty shape (this is what "caller provided nothing" looks like).
 * @param {Record<string, unknown>} [overrides]
 * @returns {Record<string, unknown>}
 */
export function emptyManifest(overrides = {}) {
  return createManifest({
    batchId: FIXED_BATCH_ID,
    createdAt: FIXED_NOW_ISO,
    project: { key: 'demo-12345678', name: 'demo', workspace: WORKSPACE_TOKEN },
    ...overrides
  })
}
