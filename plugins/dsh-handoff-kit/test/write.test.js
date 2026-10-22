import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ERROR } from '../src/contracts.js'
import { sha256Hex } from '../src/paths.js'
import { assertBatchCreatable, orderEntries, writeBatch } from '../src/write.js'
import { createFakeFs, policy } from './helpers/fake-fs.js'

function batchFs(extra = {}) {
  return createFakeFs({
    root: 'C:\\ws',
    files: {
      'src/index.js': 'export const x = 1\n',
      ...extra
    }
  })
}

const ENTRIES = [
  { path: 'manifest.json', content: '{"a":1}\n' },
  { path: 'HANDOFF.md', content: '# handoff\n' },
  { path: 'evidence/redactions.json', content: '{}\n' },
  { path: 'evidence/git.json', content: '{"git":null}\n' },
  { path: 'SHA256SUMS', content: 'abc  HANDOFF.md\n' }
]

test('orderEntries writes HANDOFF first, evidence sorted, SHA256SUMS, manifest last', () => {
  const ordered = orderEntries(ENTRIES).map((entry) => entry.path)
  assert.deepEqual(ordered, [
    'HANDOFF.md',
    'evidence/git.json',
    'evidence/redactions.json',
    'SHA256SUMS',
    'manifest.json'
  ])
  // Stable for equal ranks:
  const twice = orderEntries([...ENTRIES].reverse()).map((entry) => entry.path)
  assert.deepEqual(twice, ordered)
})

test('assertBatchCreatable accepts an absent directory and refuses complete/incomplete batches', async () => {
  const fs = batchFs()
  const fresh = await assertBatchCreatable({ fs, rootDir: 'C:\\out\\batch' })
  assert.deepEqual(fresh, { exists: false, incomplete: false })

  fs.addFile('C:\\out\\incomplete\\HANDOFF.md', '# x\n')
  await assert.rejects(
    () => assertBatchCreatable({ fs, rootDir: 'C:\\out\\incomplete' }),
    (error) => error.code === ERROR.BATCH_EXISTS && /incomplete/.test(error.message)
  )
  assert.deepEqual(await assertBatchCreatable({ fs, rootDir: 'C:\\out\\incomplete', force: true }), {
    exists: true,
    incomplete: true
  })

  fs.addFile('C:\\out\\complete\\manifest.json', '{}\n')
  await assert.rejects(
    () => assertBatchCreatable({ fs, rootDir: 'C:\\out\\complete' }),
    (error) => error.code === ERROR.BATCH_EXISTS && /manifest\.json/.test(error.message)
  )
  assert.deepEqual(await assertBatchCreatable({ fs, rootDir: 'C:\\out\\complete', force: true }), {
    exists: true,
    incomplete: false
  })

  fs.addFile('C:\\out\\file-not-dir', 'x')
  await assert.rejects(
    () => assertBatchCreatable({ fs, rootDir: 'C:\\out\\file-not-dir' }),
    (error) => error.code === ERROR.BATCH_EXISTS
  )
})

test('writeBatch writes every entry under the root and reports verified hashes', async () => {
  const fs = batchFs()
  const result = await writeBatch({
    fs,
    policy: policy('danger-full-access', 'C:\\ws'),
    rootDir: 'C:\\out\\batch-1',
    entries: ENTRIES
  })
  assert.equal(result.partial, false)
  assert.equal(result.written.length, 5)
  assert.deepEqual(
    fs.writePaths().map((path) => path.replace('C:\\out\\batch-1\\', '').replace(/\\/g, '/')),
    ['HANDOFF.md', 'evidence/git.json', 'evidence/redactions.json', 'SHA256SUMS', 'manifest.json']
  )
  for (const entry of result.written) {
    assert.equal(entry.bytes, Buffer.byteLength(ENTRIES.find((candidate) => candidate.path === entry.path).content))
    assert.equal(entry.sha256, sha256Hex(ENTRIES.find((candidate) => candidate.path === entry.path).content))
  }
  assert.equal(fs.readFile('C:\\out\\batch-1\\HANDOFF.md'), '# handoff\n')
})

test('writeBatch refuses to overwrite without force and allows it with force', async () => {
  const fs = batchFs()
  const rootDir = 'C:\\out\\batch-2'
  await writeBatch({ fs, policy: policy('danger-full-access', 'C:\\ws'), rootDir, entries: ENTRIES })
  await assert.rejects(
    () => writeBatch({ fs, policy: policy('danger-full-access', 'C:\\ws'), rootDir, entries: ENTRIES }),
    (error) => error.code === ERROR.WRITE_FAILED
  )
  const forced = await writeBatch({
    fs,
    policy: policy('danger-full-access', 'C:\\ws'),
    rootDir,
    entries: [{ path: 'HANDOFF.md', content: '# replaced\n' }],
    force: true
  })
  assert.equal(forced.partial, false)
  assert.equal(fs.readFile('C:\\out\\batch-2\\HANDOFF.md'), '# replaced\n')
})

test('writeBatch rejects escaping entry paths', async () => {
  const fs = batchFs()
  await assert.rejects(
    () =>
      writeBatch({
        fs,
        policy: policy('danger-full-access', 'C:\\ws'),
        rootDir: 'C:\\out\\batch-3',
        entries: [{ path: '..\\evil.md', content: 'x' }]
      }),
    (error) => error.code === ERROR.PATH_ESCAPE
  )
  assert.equal(fs.writeCount(), 0)
})

test('writeBatch maps sandbox refusals to HANDOFF_SANDBOX_DENIED', async () => {
  const fs = batchFs()
  await assert.rejects(
    () =>
      writeBatch({
        fs,
        policy: policy('workspace-write', 'C:\\ws'),
        rootDir: 'C:\\Users\\test\\.dsh\\handoff\\x',
        entries: [{ path: 'HANDOFF.md', content: '# x\n' }]
      }),
    (error) => error.code === ERROR.SANDBOX_DENIED && /danger-full-access|target=workspace/.test(error.message)
  )
  assert.equal(fs.writeCount(), 0)
})

test('writeBatch reports partial progress when a later write fails', async () => {
  const fs = batchFs()
  const originalWrite = fs.writeText.bind(fs)
  let calls = 0
  fs.writeText = async (...args) => {
    calls += 1
    if (calls === 2) throw new Error('disk fault')
    return originalWrite(...args)
  }
  await assert.rejects(
    () =>
      writeBatch({
        fs,
        policy: policy('danger-full-access', 'C:\\ws'),
        rootDir: 'C:\\out\\batch-partial',
        entries: [
          { path: 'HANDOFF.md', content: '# x\n' },
          { path: 'evidence/git.json', content: '{}\n' },
          { path: 'manifest.json', content: '{}\n' }
        ]
      }),
    (error) => {
      assert.equal(error.code, ERROR.WRITE_FAILED)
      assert.equal(error.partial, true)
      assert.equal(error.written.length, 1)
      assert.equal(error.written[0].path, 'HANDOFF.md')
      return true
    }
  )
  assert.equal(fs.readFile('C:\\out\\batch-partial\\HANDOFF.md'), '# x\n')
  assert.equal(fs.has('C:\\out\\batch-partial\\evidence\\git.json'), false)
})

test('read-only policy is refused by the fake sandbox before any write', async () => {
  const fs = batchFs()
  await assert.rejects(
    () =>
      writeBatch({
        fs,
        policy: policy('read-only', 'C:\\ws'),
        rootDir: 'C:\\out\\batch-ro',
        entries: [{ path: 'HANDOFF.md', content: '# x\n' }]
      }),
    (error) => error.code === ERROR.SANDBOX_DENIED
  )
})
