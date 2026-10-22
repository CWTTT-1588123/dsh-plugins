/**
 * Spec-vector regression tests (P3/M1).
 *
 * Proves that the published manifest schemas agree with the canonical
 * manifests this package produces, and that the version boundary is enforced:
 * v1 manifests validate against `manifest.v1.json`, v2 manifests against
 * `manifest.v2.json`, v2-only blocks are rejected by the v1 schema, and
 * malformed required fields are rejected.
 *
 * The schemas are consumer-facing JSON Schema (draft 2020-12); validation here
 * uses the in-repo bounded validator (`helpers/json-schema-lite.js`).
 *
 * @module test/spec
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { createManifest } from '../src/manifest.js'
import { validateJsonSchema } from './helpers/json-schema-lite.js'
import { sampleManifest, sampleManifestInput } from './helpers/manifest-fixture.js'
import { FIXED_BATCH_ID } from './helpers/fixtures.js'

function loadSchema(file) {
  return JSON.parse(readFileSync(new URL(`../schema/${file}`, import.meta.url), 'utf8'))
}

function assertValid(schema, value, label) {
  const violations = validateJsonSchema(schema, value)
  assert.deepEqual(violations, [], `${label} should validate:\n- ${violations.join('\n- ')}`)
}

function assertInvalid(schema, value, label) {
  const violations = validateJsonSchema(schema, value)
  assert.ok(violations.length > 0, `${label} should be rejected but validated`)
  return violations
}

/** Build a fully populated schemaVersion 2 manifest with every optional block. */
function sampleV2Manifest() {
  return createManifest({
    ...sampleManifestInput(),
    changes: {
      available: true,
      source: 'workspace-changes',
      turn: 3,
      totals: { files: 2, added: 10, deleted: 1, binary: 0, oversized: 0 },
      files: [{ path: 'src/index.js', added: 10, deleted: 1 }],
      collectedAt: '2026-10-22T00:00:00.000Z'
    },
    fuel: {
      goals: { available: false, note: 'goals service is unavailable' },
      jobs: { available: true, count: 0, statusCounts: {}, items: [] }
    },
    lineage: { sequence: 2, previous: FIXED_BATCH_ID, root: FIXED_BATCH_ID }
  })
}

test('published schemas parse and pin their schema versions', () => {
  const v1 = loadSchema('manifest.v1.json')
  const v2 = loadSchema('manifest.v2.json')
  for (const [schema, expected] of [
    [v1, 1],
    [v2, 2]
  ]) {
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema')
    assert.equal(schema.properties.schemaVersion.const, expected)
    assert.equal(schema.properties.schema.const, 'dsh-handoff-kit/handoff')
    for (const key of ['batchId', 'project', 'artifacts', 'files', 'sessionTrace', 'limits', 'scan']) {
      assert.ok(schema.required.includes(key), `schema v${expected} must require ${key}`)
    }
  }
  assert.ok(!('changes' in v1.properties), 'v1 schema must not declare changes')
  assert.ok(!('fuel' in v1.properties), 'v1 schema must not declare fuel')
  assert.ok(!('lineage' in v1.properties), 'v1 schema must not declare lineage')
  for (const key of ['changes', 'fuel', 'lineage']) {
    assert.ok('changes' !== key || key in v2.properties)
    assert.ok(key in v2.properties, `v2 schema must declare ${key}`)
  }
})

test('canonical v1 manifest validates against manifest.v1.json', () => {
  const manifest = sampleManifest()
  assert.equal(manifest.schemaVersion, 1)
  assertValid(loadSchema('manifest.v1.json'), manifest, 'canonical v1 manifest')
})

test('canonical v2 manifest validates against manifest.v2.json', () => {
  const manifest = sampleV2Manifest()
  assert.equal(manifest.schemaVersion, 2)
  assert.ok('changes' in manifest && 'fuel' in manifest && 'lineage' in manifest)
  assertValid(loadSchema('manifest.v2.json'), manifest, 'canonical v2 manifest')
})

test('v1 schema rejects v2-only blocks (version boundary)', () => {
  const v1Schema = loadSchema('manifest.v1.json')
  const v2Manifest = sampleV2Manifest()
  const asV1 = { ...v2Manifest, schemaVersion: 1 }
  const violations = assertInvalid(v1Schema, asV1, 'v1 manifest carrying changes/fuel/lineage')
  assert.ok(violations.some((line) => line.includes('changes')), 'violation should mention changes')
})

test('each schema is version-pinned (v1 rejects v2 and vice versa)', () => {
  const v1Schema = loadSchema('manifest.v1.json')
  const v2Schema = loadSchema('manifest.v2.json')
  assertInvalid(v1Schema, sampleV2Manifest(), 'v2 manifest under v1 schema')
  assertInvalid(v2Schema, sampleManifest(), 'v1 manifest under v2 schema')
})

test('schemas reject malformed batch ids, digests and missing required blocks', () => {
  const v2Schema = loadSchema('manifest.v2.json')
  const base = sampleV2Manifest()

  const badBatchId = structuredClone(base)
  badBatchId.batchId = 'not-a-batch-id'
  assertInvalid(v2Schema, badBatchId, 'malformed batch id')

  const badDigest = structuredClone(base)
  badDigest.artifacts = [{ path: 'HANDOFF.md', bytes: 1, sha256: 'xyz' }]
  assertInvalid(v2Schema, badDigest, 'malformed artifact digest')

  const missingProject = structuredClone(base)
  delete missingProject.project
  assertInvalid(v2Schema, missingProject, 'missing required project block')

  const badVersion = structuredClone(base)
  badVersion.schemaVersion = 3
  assertInvalid(v2Schema, badVersion, 'unsupported schema version')
})
