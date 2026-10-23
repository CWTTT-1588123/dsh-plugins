/**
 * Real-filesystem batch fixture shared by CLI-layer tests.
 *
 * The reference CLI runs outside the harness and therefore on the real
 * filesystem; tests materialize this deterministic schemaVersion 1 batch into
 * an OS temp directory. No subprocess is spawned anywhere: tests call `runCli`
 * (or the module functions) directly.
 *
 * @module test/helpers/cli-batch-fixture
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { artifactEntry, buildSha256Sums, createManifest, serializeManifest, setArtifacts } from '../../src/manifest.js'
import { sha256Hex } from '../../src/paths.js'
import { renderHandoff } from '../../src/render.js'

/** Fixed batch id of the fixture. */
export const BATCH_ID = '20261022T023512Z-a1b2'
/** Fixed project key of the fixture. */
export const PROJECT_KEY = 'fixture-12345678'
/** Fixed creation instant of the fixture. */
export const CREATED_AT = '2026-10-22T02:35:12.000Z'

/** Canonical pretty-printed JSON text used by the fixture evidence files. */
export function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

/**
 * Materialize a valid batch plus its workspace on the real FS.
 * @param {string} baseDir an existing temp directory.
 * @param {{
 *   batchId?: string,
 *   projectKey?: string,
 *   createdAt?: string,
 *   summary?: string,
 *   lineage?: {sequence: number, previous: string, root: string, supersedes?: string}
 * }} [options]
 * @returns {{batchDir: string, workspace: string, root: string, projectKey: string,
 *   batchId: string, handoffPath: string, manifestPath: string, sumsPath: string}}
 */
export function writeBatchFixture(baseDir, options = {}) {
  const batchId = options.batchId ?? BATCH_ID
  const projectKey = options.projectKey ?? PROJECT_KEY
  const createdAt = options.createdAt ?? CREATED_AT
  const workspace = join(baseDir, 'workspace')
  mkdirSync(workspace, { recursive: true })
  const readme = '# fixture workspace\n\nUsed by the CLI tests.\n'
  writeFileSync(join(workspace, 'README.md'), readme, 'utf8')

  const batchDir = join(baseDir, 'handoff', projectKey, batchId)
  mkdirSync(batchDir, { recursive: true })
  const readmeBytes = Buffer.byteLength(readme, 'utf8')
  const manifest = createManifest({
    batchId,
    createdAt,
    ...(options.lineage === undefined ? {} : { schemaVersion: 2, lineage: options.lineage }),
    project: { key: projectKey, name: 'fixture', workspace: '$WORKSPACE' },
    session: { id: 'session-fixture', cwd: '$WORKSPACE', agentPreset: 'standard' },
    sandbox: { mode: 'danger-full-access', workspaceRoot: '$WORKSPACE' },
    inputs: { title: 'CLI fixture', summary: options.summary ?? 'fixture for CLI tests' },
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
    root: join(baseDir, 'handoff'),
    projectKey,
    batchId,
    handoffPath: join(batchDir, 'HANDOFF.md'),
    manifestPath: join(batchDir, 'manifest.json'),
    sumsPath: join(batchDir, 'SHA256SUMS')
  }
}
