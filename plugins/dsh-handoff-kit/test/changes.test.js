import assert from 'node:assert/strict'
import { test } from 'node:test'

import { LIMITS } from '../src/contracts.js'
import {
  boundDiffEntries,
  buildChanges,
  buildDiffEntry,
  buildCurrentTurn,
  findLatestChangesEvent,
  findOpenTurn,
  normalizeChangePath,
  selectDiffTargets,
  unavailableChanges
} from '../src/changes.js'

const CONTEXTS = { workspaceRoot: 'C:\\ws', dshHome: 'C:\\Users\\test\\.dsh' }
const COLLECTED_AT = '2026-10-22T02:35:12.000Z'

function changesEvent(seq, turn) {
  return { type: 'workspace/changes', seq, time: 0, data: { turn } }
}

test('findLatestChangesEvent picks the newest workspace/changes event', () => {
  const events = [
    { type: 'tool/call', seq: 5, data: {} },
    changesEvent(10, 1),
    { type: 'user/message', seq: 12, data: {} },
    changesEvent(20, 4)
  ]
  assert.deepEqual(findLatestChangesEvent(events), { seq: 20, turn: 4 })
  assert.equal(findLatestChangesEvent([]), undefined)
  assert.equal(findLatestChangesEvent([{ type: 'tool/call', seq: 1 }]), undefined)
  assert.equal(findLatestChangesEvent('nope'), undefined)
})

test('unavailableChanges carries an honest reason', () => {
  const block = unavailableChanges('service missing', COLLECTED_AT)
  assert.equal(block.available, false)
  assert.equal(block.source, 'workspace-changes')
  assert.equal(block.note, 'service missing')
  assert.equal(block.collectedAt, COLLECTED_AT)
  assert.equal(typeof unavailableChanges().note, 'string')
})

test('normalizeChangePath keeps relative paths and tokenizes absolute ones', () => {
  assert.equal(normalizeChangePath('src/index.js', CONTEXTS), 'src/index.js')
  assert.equal(normalizeChangePath('.\\docs\\a.md', CONTEXTS), 'docs/a.md')
  assert.equal(normalizeChangePath('C:\\ws\\src\\a.js', CONTEXTS), '$WORKSPACE/src/a.js')
  assert.equal(normalizeChangePath('C:\\Users\\test\\.dsh\\x', CONTEXTS), '$DSH_HOME/x')
  assert.equal(normalizeChangePath('', CONTEXTS), undefined)
  assert.equal(normalizeChangePath(42, CONTEXTS), undefined)
})

test('buildChanges normalizes a host summary and sorts files', () => {
  const block = buildChanges({
    summary: {
      turn: 3,
      cwd: 'C:\\ws',
      total: 2,
      added: 12,
      deleted: 4,
      files: [
        { path: 'src/b.js', display: 'src/b.js', added: 9, deleted: 3 },
        { path: 'src/a.js', display: 'src/a.js', added: 3, deleted: 1 },
        { path: 'binary.dat', display: 'binary.dat', added: 0, deleted: 0, binary: true },
        { path: 'huge.bin', display: 'huge.bin', added: 0, deleted: 0, oversized: true }
      ]
    },
    contexts: CONTEXTS,
    limits: LIMITS,
    collectedAt: COLLECTED_AT
  })
  assert.equal(block.available, true)
  assert.equal(block.source, 'workspace-changes')
  assert.equal(block.turn, 3)
  assert.deepEqual(block.files.map((file) => file.path), ['binary.dat', 'huge.bin', 'src/a.js', 'src/b.js'])
  assert.deepEqual(block.totals, { files: 2, added: 12, deleted: 4, binary: 1, oversized: 1 })
  assert.equal(block.collectedAt, COLLECTED_AT)
  assert.equal(block.truncated, undefined)
})

test('buildChanges caps the file list and reports truncation', () => {
  const files = Array.from({ length: 12 }, (_, index) => ({
    path: `src/f${String(index).padStart(2, '0')}.js`,
    added: index,
    deleted: 0
  }))
  const limits = { ...LIMITS, changesMaxFiles: 5 }
  const block = buildChanges({
    summary: { turn: 2, total: 12, added: 66, deleted: 0, files },
    contexts: CONTEXTS,
    limits,
    collectedAt: COLLECTED_AT
  })
  assert.equal(block.files.length, 5)
  assert.equal(block.truncated, true)
  assert.match(block.note, /first 5 of 12/)
  assert.equal(block.totals.files, 12)
  assert.equal(block.totals.added, 66)
})

test('buildChanges degrades for missing summaries and skips malformed files', () => {
  assert.equal(buildChanges({ summary: undefined }).available, false)
  const block = buildChanges({
    summary: { turn: 1, files: [null, {}, { path: '' }, { path: 'ok.js', added: 1 }] },
    contexts: CONTEXTS
  })
  assert.deepEqual(block.files, [{ path: 'ok.js', added: 1, deleted: 0 }])
  assert.equal(block.turn, 1)
})

test('diff helpers normalize text/binary/oversized and cap hunks', () => {
  assert.deepEqual(buildDiffEntry({ path: 'a.js', diff: { kind: 'binary' } }), {
    path: 'a.js',
    kind: 'binary'
  })
  assert.deepEqual(buildDiffEntry({ path: 'a.js', diff: { kind: 'oversized' } }), {
    path: 'a.js',
    kind: 'oversized'
  })
  const text = buildDiffEntry({
    path: 'a.js',
    diff: {
      kind: 'text',
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-a', '+b', '+c'] }]
    }
  })
  assert.equal(text.kind, 'text')
  assert.equal(text.hunks[0].lines.length, 3)
  assert.equal(buildDiffEntry({ path: '', diff: { kind: 'text' } }), undefined)
  assert.equal(buildDiffEntry({ path: 'a', diff: null }), undefined)
  assert.equal(buildDiffEntry({ path: 'a', diff: { kind: 'weird' } }), undefined)
})

test('boundDiffEntries enforces a serialized-byte budget', () => {
  const entries = Array.from({ length: 5 }, (_, index) => ({
    path: `f${index}.js`,
    kind: 'text',
    hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['+x'.repeat(10)] }]
  }))
  const bounded = boundDiffEntries(entries, 400)
  assert.equal(bounded.length > 0, true)
  assert.equal(bounded.length < entries.length, true)
  assert.equal(bounded.at(-1).truncated, true)
  assert.deepEqual(boundDiffEntries([], 100), [])
})

test('selectDiffTargets skips binary/oversized and caps count', () => {
  const files = [
    { path: 'a', added: 1, deleted: 0 },
    { path: 'b', added: 1, deleted: 0, binary: true },
    { path: 'c', added: 1, deleted: 0, oversized: true },
    { path: 'd', added: 1, deleted: 0 }
  ]
  assert.deepEqual(selectDiffTargets(files, { ...LIMITS, changesMaxDiffs: 5 }).map((f) => f.path), ['a', 'd'])
  assert.equal(selectDiffTargets(files, { ...LIMITS, changesMaxDiffs: 1 }).length, 1)
  assert.deepEqual(selectDiffTargets(null), [])
})

test('findOpenTurn detects a started turn without an end', () => {
  const events = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'turn/end', seq: 5, data: { turn: 1 } },
    { type: 'turn/start', seq: 6, data: { turn: 2 } },
    { type: 'tool/call', seq: 7, data: { turn: 2, name: 'read', arguments: '{}' } }
  ]
  assert.equal(findOpenTurn(events), 2)
  assert.equal(
    findOpenTurn([
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'turn/end', seq: 2, data: { turn: 1 } }
    ]),
    undefined
  )
  assert.equal(findOpenTurn([]), undefined)
  assert.equal(findOpenTurn('nope'), undefined)
})

test('buildCurrentTurn aggregates file-tool paths of the open turn only', () => {
  const events = [
    { type: 'turn/start', seq: 1, data: { turn: 2 } },
    { type: 'tool/call', seq: 2, data: { turn: 2, name: 'read', arguments: JSON.stringify({ path: 'src/a.js' }) } },
    { type: 'tool/call', seq: 3, data: { turn: 2, name: 'write', arguments: JSON.stringify({ file_path: 'src/a.js' }) } },
    { type: 'tool/call', seq: 4, data: { turn: 2, name: 'pwsh', arguments: JSON.stringify({ command: 'git status' }) } },
    { type: 'tool/call', seq: 5, data: { turn: 1, name: 'write', arguments: JSON.stringify({ path: 'old.js' }) } }
  ]
  const block = buildCurrentTurn({ events, openTurn: 2, contexts: CONTEXTS })
  assert.equal(block.turn, 2)
  assert.deepEqual(block.files.map((file) => file.path), ['src/a.js'])
  assert.equal(block.files[0].count, 2)
  assert.equal(block.files[0].tool, 'write')
  assert.equal(block.files[0].lastSeq, 3)
  assert.match(block.note, /没有 added\/deleted/)
  assert.equal(buildCurrentTurn({ events, openTurn: 3, contexts: CONTEXTS }), undefined)
  assert.equal(buildCurrentTurn({ events, openTurn: undefined }), undefined)
})
