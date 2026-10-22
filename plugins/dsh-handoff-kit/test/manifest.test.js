import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ERROR, publicLimits } from '../src/contracts.js'
import {
  artifactEntry,
  buildSha256Sums,
  createManifest,
  isCompleteManifest,
  parseManifest,
  parseSha256Sums,
  serializeManifest,
  setArtifacts,
  validateManifest
} from '../src/manifest.js'
import { sha256Hex } from '../src/paths.js'
import { FIXED_BATCH_ID, FIXED_NOW_ISO } from './helpers/fixtures.js'
import {
  ARTIFACT_CONTENTS,
  emptyManifest,
  sampleManifest,
  sampleManifestInput
} from './helpers/manifest-fixture.js'

/** The fixed manifest key order from P0 module interfaces §5. */
const MANIFEST_KEYS = [
  'schema',
  'schemaVersion',
  'generator',
  'batchId',
  'createdAt',
  'project',
  'session',
  'sandbox',
  'inputs',
  'git',
  'artifacts',
  'files',
  'sessionTrace',
  'redactions',
  'warnings',
  'limits',
  'scan'
]

/** Minimal valid createManifest input. */
function minimalInput(overrides = {}) {
  return {
    batchId: FIXED_BATCH_ID,
    createdAt: FIXED_NOW_ISO,
    project: { key: 'demo-12345678', name: 'demo', workspace: '$WORKSPACE' },
    ...overrides
  }
}

test('createManifest emits the fixed top-level and nested key order', () => {
  const manifest = createManifest(sampleManifestInput({ target: undefined }))
  assert.equal(manifest.schema, 'dsh-handoff-kit/handoff')
  assert.equal(manifest.schemaVersion, 1)
  assert.equal(manifest.batchId, FIXED_BATCH_ID)
  assert.equal(manifest.createdAt, FIXED_NOW_ISO)
  assert.deepEqual(Object.keys(manifest), MANIFEST_KEYS)
  assert.deepEqual(manifest.artifacts, [])
  assert.deepEqual(manifest.limits, publicLimits())

  assert.deepEqual(Object.keys(manifest.generator), ['name', 'version', 'dshVersion', 'platform'])
  assert.deepEqual(Object.keys(manifest.project), ['key', 'name', 'workspace'])
  assert.deepEqual(Object.keys(manifest.session), ['id', 'cwd', 'agentPreset'])
  assert.deepEqual(Object.keys(manifest.sandbox), ['mode', 'workspaceRoot'])
  assert.deepEqual(Object.keys(manifest.inputs), [
    'title',
    'goal',
    'summary',
    'decisions',
    'nextSteps',
    'concepts',
    'flow',
    'risks',
    'files',
    'copyFiles'
  ])
  assert.deepEqual(Object.keys(manifest.git), [
    'head',
    'branch',
    'detached',
    'remote',
    'lastCommit',
    'indexVersion',
    'packedRefsPresent',
    'reflog'
  ])
  assert.deepEqual(Object.keys(manifest.git.lastCommit), ['sha', 'time', 'subject'])
  assert.deepEqual(Object.keys(manifest.git.reflog[0]), ['sha', 'time', 'subject'])
  assert.deepEqual(Object.keys(manifest.files[0]), ['path', 'role', 'bytes', 'sha256'])
  assert.deepEqual(Object.keys(manifest.sessionTrace), [
    'sessionId',
    'eventCounts',
    'toolCalls',
    'touchedFiles',
    'commands',
    'window'
  ])
  assert.deepEqual(Object.keys(manifest.sessionTrace.eventCounts), [
    'total',
    'toolCalls',
    'toolErrors'
  ])
  assert.deepEqual(Object.keys(manifest.sessionTrace.toolCalls), ['total', 'byName'])
  assert.deepEqual(Object.keys(manifest.sessionTrace.touchedFiles[0]), [
    'path',
    'tool',
    'count',
    'lastSeq'
  ])
  assert.deepEqual(Object.keys(manifest.sessionTrace.window), ['events', 'truncated'])
  assert.deepEqual(Object.keys(manifest.redactions[0]), ['file', 'kind', 'count'])
  assert.deepEqual(Object.keys(manifest.warnings[0]), ['code', 'detail'])
  assert.deepEqual(Object.keys(manifest.scan), [
    'entries',
    'dirs',
    'denied',
    'symlinksSkipped',
    'readBytes',
    'explicitFiles',
    'tree'
  ])
  assert.deepEqual(Object.keys(manifest.scan.tree[0]), ['name', 'type', 'bytes'])

  // `target` is the single extension: the documented keys stay in order and the
  // extension is appended last so a fixed-key consumer still works.
  const withTarget = createManifest(sampleManifestInput())
  assert.deepEqual(Object.keys(withTarget), [...MANIFEST_KEYS, 'target'])
  assert.equal(withTarget.target, 'user')
})

test('createManifest normalizes absent optional inputs into empty shapes', () => {
  const manifest = createManifest(minimalInput())
  assert.equal(manifest.git, null)
  assert.deepEqual(manifest.files, [])
  assert.deepEqual(manifest.redactions, [])
  assert.deepEqual(manifest.warnings, [])
  assert.deepEqual(manifest.inputs, {
    title: null,
    goal: null,
    summary: null,
    decisions: [],
    nextSteps: [],
    concepts: [],
    flow: [],
    risks: [],
    files: [],
    copyFiles: false
  })
  assert.deepEqual(manifest.session, { id: null, cwd: null, agentPreset: null })
  assert.deepEqual(manifest.sandbox, { mode: null, workspaceRoot: null })
  assert.deepEqual(manifest.sessionTrace, {
    sessionId: null,
    eventCounts: { total: 0, toolCalls: 0, toolErrors: 0 },
    toolCalls: { total: 0, byName: {} },
    touchedFiles: [],
    commands: [],
    window: { events: 0, truncated: false }
  })
  assert.equal(manifest.scan.entries, 0)
  assert.deepEqual(manifest.scan.tree, [])
  // `limits` always comes from contracts.publicLimits(); caller values are ignored.
  assert.deepEqual(
    createManifest(minimalInput({ limits: { maxEntries: 1 } })).limits,
    publicLimits()
  )
})

test('createManifest sorts warnings and tool-call names deterministically', () => {
  const base = sampleManifestInput()
  const manifest = createManifest(
    sampleManifestInput({
      sessionTrace: {
        ...base.sessionTrace,
        toolCalls: { total: 9, byName: { read: 3, edit: 2, pwsh: 2 } }
      },
      warnings: [
        { code: 'ZZZ_LIMIT', detail: 'b' },
        { code: 'AAA_LIMIT', detail: 'x' },
        { code: 'AAA_LIMIT', detail: 'a' }
      ]
    })
  )
  assert.deepEqual(
    manifest.warnings.map((warning) => `${warning.code}:${warning.detail}`),
    ['AAA_LIMIT:a', 'AAA_LIMIT:x', 'ZZZ_LIMIT:b']
  )
  assert.deepEqual(Object.keys(manifest.sessionTrace.toolCalls.byName), ['edit', 'pwsh', 'read'])
})

test('createManifest rejects malformed input with structured errors', () => {
  assert.throws(() => createManifest(null), { name: 'HandoffError', code: ERROR.INVALID_ARGS })
  assert.throws(() => createManifest([]), { code: ERROR.INVALID_ARGS })
  assert.throws(
    () => createManifest(minimalInput({ batchId: '2026-10-22T02:35:12Z-a1b2' })),
    { code: ERROR.INVALID_ARGS }
  )
  assert.throws(
    () => createManifest(minimalInput({ batchId: '20261022T023512Z-A1B2' })),
    { code: ERROR.INVALID_ARGS }
  )
  assert.throws(() => createManifest(minimalInput({ createdAt: 'not-a-date' })), {
    code: ERROR.INVALID_ARGS
  })
  assert.throws(() => createManifest(minimalInput({ createdAt: 123 })), {
    code: ERROR.INVALID_ARGS
  })
  assert.throws(() => createManifest(minimalInput({ project: null })), {
    code: ERROR.INVALID_ARGS
  })
  // A native Windows absolute path must never enter the manifest.
  assert.throws(
    () =>
      createManifest(
        minimalInput({ project: { key: 'k', name: 'n', workspace: 'C:\\repos\\demo' } })
      ),
    { code: ERROR.INVALID_ARGS }
  )
  assert.throws(() => createManifest(minimalInput({ target: 'disk' })), {
    code: ERROR.INVALID_ARGS
  })
  assert.throws(() => createManifest(minimalInput({ files: 'nope' })), {
    code: ERROR.INVALID_ARGS
  })
  assert.throws(
    () =>
      createManifest(
        minimalInput({ files: [{ path: '../escape.js', role: 'source', bytes: 1, sha256: '' }] })
      ),
    { code: ERROR.PATH_ESCAPE }
  )
  assert.throws(
    () =>
      createManifest(
        minimalInput({ sessionTrace: { touchedFiles: 'nope' } })
      ),
    { code: ERROR.INVALID_ARGS }
  )
})

test('serializeManifest is canonical, LF-only and stable', () => {
  const manifest = sampleManifest()
  const text = serializeManifest(manifest)
  assert.ok(text.endsWith('\n'))
  assert.ok(!text.endsWith('\n\n'))
  assert.ok(!text.includes('\r'))
  assert.equal(serializeManifest(manifest), text)

  const parsed = JSON.parse(text)
  assert.deepEqual(Object.keys(parsed).slice(0, MANIFEST_KEYS.length), MANIFEST_KEYS)
  // Top-level key order in the text itself (2-space indented keys).
  const topLevelKeys = [...text.matchAll(/^ {2}"([^"]+)": /gm)].map((match) => match[1])
  assert.deepEqual(topLevelKeys, [...MANIFEST_KEYS, 'target'])

  // A differently ordered input object serializes to the same canonical bytes.
  const shuffled = {}
  for (const key of Object.keys(manifest).reverse()) shuffled[key] = manifest[key]
  assert.equal(serializeManifest(shuffled), text)

  assert.throws(() => serializeManifest(null), { code: ERROR.INVALID_ARGS })
  assert.throws(() => serializeManifest('text'), { code: ERROR.INVALID_ARGS })
})

test('parseManifest/serializeManifest round-trip is exact and deep-equal', () => {
  const manifest = sampleManifest()
  const text = serializeManifest(manifest)
  const parsed = parseManifest(text)
  assert.deepEqual(parsed, manifest)
  assert.equal(serializeManifest(parsed), text)
  // The extension key survives the round-trip and stays last.
  assert.equal(parsed.target, 'user')
  assert.equal(Object.keys(parsed).at(-1), 'target')
  // Canonicalization is idempotent.
  assert.equal(serializeManifest(parseManifest(serializeManifest(parsed))), text)

  // Parsing a reordered JSON document still yields the canonical text.
  const shuffled = {}
  for (const key of Object.keys(JSON.parse(text)).reverse()) shuffled[key] = JSON.parse(text)[key]
  assert.equal(serializeManifest(parseManifest(JSON.stringify(shuffled))), text)
})

test('parseManifest rejects non-object and malformed JSON', () => {
  for (const bad of ['', '   ', '{invalid', '[]', 'null', '42', '"text"']) {
    assert.throws(() => parseManifest(bad), {
      name: 'HandoffError',
      code: ERROR.MANIFEST_INVALID
    })
  }
  assert.throws(() => parseManifest(undefined), { code: ERROR.MANIFEST_INVALID })
  assert.throws(() => parseManifest({}), { code: ERROR.MANIFEST_INVALID })
  // Readable JSON objects are not rejected here; shape problems are findings.
  assert.deepEqual(parseManifest('{}'), {})
  assert.equal(validateManifest(parseManifest('{}')).ok, false)
})

test('setArtifacts returns a new manifest with path-sorted artifacts', () => {
  const manifest = createManifest(sampleManifestInput())
  const artifacts = [
    artifactEntry('evidence/session.json', '{"a":1}\n'),
    artifactEntry('HANDOFF.md', '# h\n'),
    artifactEntry('SHA256SUMS', 'sum text\n'),
    artifactEntry('evidence/git.json', '{}\n')
  ]
  const sorted = setArtifacts(manifest, artifacts)
  assert.notEqual(sorted, manifest)
  assert.deepEqual(manifest.artifacts, [])
  assert.deepEqual(
    sorted.artifacts.map((artifact) => artifact.path),
    ['HANDOFF.md', 'SHA256SUMS', 'evidence/git.json', 'evidence/session.json']
  )
  assert.deepEqual(Object.keys(sorted.artifacts[0]), ['path', 'bytes', 'sha256'])
  assert.equal(
    serializeManifest(setArtifacts(manifest, [...artifacts].reverse())),
    serializeManifest(sorted)
  )

  assert.throws(() => setArtifacts(null, []), { code: ERROR.INVALID_ARGS })
  assert.throws(() => setArtifacts(manifest, null), { code: ERROR.INVALID_ARGS })
  assert.throws(
    () => setArtifacts(manifest, [artifactEntry('manifest.json', '{}\n')]),
    { code: ERROR.INVALID_ARGS }
  )
  assert.throws(
    () =>
      setArtifacts(manifest, [
        artifactEntry('HANDOFF.md', 'a'),
        artifactEntry('HANDOFF.md', 'b')
      ]),
    { code: ERROR.INVALID_ARGS }
  )
  assert.throws(
    () => setArtifacts(manifest, [{ path: 'HANDOFF.md', bytes: 1, sha256: 'xyz' }]),
    { code: ERROR.INVALID_ARGS }
  )
  assert.throws(
    () => setArtifacts(manifest, [{ path: 'HANDOFF.md', bytes: -1, sha256: 'a'.repeat(64) }]),
    { code: ERROR.INVALID_ARGS }
  )
})

test('artifactEntry records UTF-8 byte length and lower-case sha256', () => {
  const text = '中文'
  const entry = artifactEntry('./evidence/中文.txt', text)
  assert.equal(entry.path, 'evidence/中文.txt')
  assert.equal(entry.bytes, 6)
  assert.equal(entry.sha256, sha256Hex(text))
  assert.match(entry.sha256, /^[0-9a-f]{64}$/)
  assert.deepEqual(Object.keys(entry), ['path', 'bytes', 'sha256'])

  const raw = new Uint8Array([1, 2, 3])
  const bytesEntry = artifactEntry('evidence/raw.bin', raw)
  assert.equal(bytesEntry.bytes, 3)
  assert.equal(bytesEntry.sha256, sha256Hex(raw))

  assert.throws(() => artifactEntry('C:\\abs.txt', 'x'), { code: ERROR.PATH_ESCAPE })
  assert.throws(() => artifactEntry('../escape.txt', 'x'), { code: ERROR.PATH_ESCAPE })
  assert.throws(() => artifactEntry('a.txt', 42), { code: ERROR.INVALID_ARGS })
})

test('SHA256SUMS text round-trips, is path-sorted and parses GNU output', () => {
  const manifest = sampleManifest()
  const entries = manifest.artifacts.map(({ path, sha256 }) => ({ path, sha256 }))
  const sums = buildSha256Sums(entries)
  const lines = sums.split('\n').filter(Boolean)
  assert.equal(lines.length, entries.length)
  assert.ok(lines.every((line) => /^[0-9a-f]{64}  \S/.test(line)))
  const paths = lines.map((line) => line.slice(66))
  assert.deepEqual(paths, [...entries.map((entry) => entry.path)].sort())

  const parsed = parseSha256Sums(sums)
  assert.deepEqual(parsed, [...entries].sort((left, right) => (left.path < right.path ? -1 : 1)))
  assert.equal(buildSha256Sums(parsed), sums)
  assert.equal(buildSha256Sums([]), '')
  assert.deepEqual(parseSha256Sums(''), [])

  const sha = 'a'.repeat(64)
  const one = buildSha256Sums([{ path: 'a.txt', sha256: sha }])
  assert.equal(one, `${sha}  a.txt\n`)
  // GNU binary marker and CRLF input are accepted.
  assert.deepEqual(parseSha256Sums(one.replace(/\n/g, '\r\n')), [{ path: 'a.txt', sha256: sha }])
  assert.deepEqual(parseSha256Sums(`${'b'.repeat(64)} *a.txt\n`), [
    { path: 'a.txt', sha256: 'b'.repeat(64) }
  ])
  // Uppercase hex is normalized to lower case.
  assert.deepEqual(parseSha256Sums(`${'A'.repeat(64)}  a.txt\n`), [{ path: 'a.txt', sha256: sha }])

  assert.throws(() => parseSha256Sums('not a sums line\n'), {
    code: ERROR.MANIFEST_INVALID
  })
  assert.throws(() => parseSha256Sums(`${sha}  ../escape\n`), { code: ERROR.MANIFEST_INVALID })
  assert.throws(
    () => parseSha256Sums(`${sha}  a.txt\n${'b'.repeat(64)}  a.txt\n`),
    { code: ERROR.MANIFEST_INVALID }
  )
  assert.throws(
    () => buildSha256Sums([{ path: 'a.txt', sha256: sha }, { path: 'a.txt', sha256: sha }]),
    { code: ERROR.INVALID_ARGS }
  )
  assert.throws(() => buildSha256Sums([{ path: 'a.txt', sha256: 'nope' }]), {
    code: ERROR.INVALID_ARGS
  })
  assert.throws(() => buildSha256Sums('nope'), { code: ERROR.INVALID_ARGS })
})

test('a tampered artifact record is detected by re-hashing with artifactEntry', () => {
  const manifest = sampleManifest()
  const clean = manifest.artifacts.filter((artifact) => {
    const recomputed = artifactEntry(artifact.path, ARTIFACT_CONTENTS[artifact.path])
    return recomputed.sha256 === artifact.sha256 && recomputed.bytes === artifact.bytes
  })
  assert.equal(clean.length, manifest.artifacts.length)

  const text = serializeManifest(manifest)
  const handoffSha = manifest.artifacts.find((artifact) => artifact.path === 'HANDOFF.md').sha256
  const tamperedText = text.replace(handoffSha, '0'.repeat(64))
  assert.notEqual(tamperedText, text)
  const tampered = parseManifest(tamperedText)
  assert.equal(serializeManifest(tampered), tamperedText)
  const drifted = tampered.artifacts.filter((artifact) => {
    const recomputed = artifactEntry(artifact.path, ARTIFACT_CONTENTS[artifact.path])
    return recomputed.sha256 !== artifact.sha256
  })
  assert.deepEqual(drifted.map((artifact) => artifact.path), ['HANDOFF.md'])

  // A malformed hash is additionally reported as a shape finding.
  const malformed = parseManifest(text.replace(handoffSha, 'deadbeef'))
  const findings = validateManifest(malformed).findings
  assert.ok(
    findings.some(
      (finding) => finding.code === 'MANIFEST_ARTIFACT_ENTRY' && finding.severity === 'warn'
    )
  )
})

test('validateManifest reports structural problems, sorted and non-throwing', () => {
  const report = validateManifest({})
  assert.equal(report.ok, false)
  const codes = report.findings.map((finding) => finding.code)
  for (const code of [
    'MANIFEST_SCHEMA',
    'MANIFEST_SCHEMA_VERSION',
    'MANIFEST_BATCH_ID',
    'MANIFEST_PROJECT',
    'MANIFEST_ARTIFACTS',
    'MANIFEST_FILES',
    'MANIFEST_LIMITS'
  ]) {
    assert.ok(codes.includes(code), `missing finding code ${code}`)
  }
  for (const finding of report.findings) {
    assert.equal(typeof finding.severity, 'string')
    assert.equal(typeof finding.code, 'string')
    assert.ok(finding.severity === 'error' || finding.severity === 'warn')
  }
  // Findings are sorted: errors first, then code ascending within each severity.
  const severities = report.findings.map((finding) => finding.severity)
  assert.deepEqual(
    severities,
    [...severities].sort((left, right) => (left === right ? 0 : left === 'error' ? -1 : 1))
  )
  const errorCodes = report.findings
    .filter((finding) => finding.severity === 'error')
    .map((finding) => finding.code)
  const warningCodes = report.findings
    .filter((finding) => finding.severity === 'warn')
    .map((finding) => finding.code)
  assert.deepEqual(errorCodes, [...errorCodes].sort())
  assert.deepEqual(warningCodes, [...warningCodes].sort())
  assert.equal(isCompleteManifest({}), false)

  const sample = sampleManifest()
  assert.deepEqual(validateManifest(sample), { ok: true, findings: [] })
  assert.equal(isCompleteManifest(sample), true)

  const missingArtifacts = parseManifest(serializeManifest(sample))
  delete missingArtifacts.artifacts
  const missingReport = validateManifest(missingArtifacts)
  assert.equal(missingReport.ok, false)
  assert.ok(missingReport.findings.some((finding) => finding.code === 'MANIFEST_ARTIFACTS'))
  assert.equal(isCompleteManifest(missingArtifacts), false)

  // A createdAt that is present but unparseable is a warning, not a hard error.
  const badDate = parseManifest(serializeManifest(sample))
  badDate.createdAt = 'not-a-date'
  const dateReport = validateManifest(badDate)
  assert.equal(dateReport.ok, true)
  assert.ok(
    dateReport.findings.some(
      (finding) => finding.code === 'MANIFEST_CREATED_AT' && finding.severity === 'warn'
    )
  )
  assert.equal(isCompleteManifest(badDate), false)
})

test('validateManifest warns about non-tokenized paths and malformed entries', () => {
  const manifest = parseManifest(serializeManifest(sampleManifest()))
  manifest.project.workspace = 'C:\\ws'
  manifest.session.cwd = 'C:\\ws'
  manifest.artifacts[0].sha256 = 'not-a-hash'
  manifest.files[0].role = 'weird'
  const report = validateManifest(manifest)
  const countOf = (code) => report.findings.filter((finding) => finding.code === code).length
  assert.equal(countOf('MANIFEST_PATH_NOT_TOKENIZED'), 2)
  assert.equal(countOf('MANIFEST_ARTIFACT_ENTRY'), 1)
  assert.equal(countOf('MANIFEST_FILE_ENTRY'), 1)
  // All warnings only: the manifest is still readable.
  assert.equal(report.ok, true)
})

test('empty manifest is valid and complete', () => {
  const manifest = emptyManifest()
  assert.deepEqual(validateManifest(manifest), { ok: true, findings: [] })
  assert.equal(isCompleteManifest(manifest), true)
  assert.deepEqual(manifest.files, [])
  assert.equal(manifest.git, null)
  // Its serialized form also round-trips byte-exactly.
  const text = serializeManifest(manifest)
  assert.equal(serializeManifest(parseManifest(text)), text)
})
