import assert from 'node:assert/strict'
import { test } from 'node:test'

import { LIMITS } from '../src/contracts.js'
import { finalCheck, scanSecrets } from '../src/redact.js'
import {
  FILE_TOOLS,
  SHELL_TOOLS,
  buildSessionTrace,
  extractTouchedPaths
} from '../src/session-trace.js'
import {
  DSH_HOME,
  FIXED_NOW,
  WORKSPACE_ROOT,
  sampleSessionEvents,
  toolCallEvent
} from './helpers/fixtures.js'

const CONTEXTS = { workspaceRoot: WORKSPACE_ROOT, dshHome: DSH_HOME }

/** Build one synthetic session event with the fixed fixture clock. */
function rawEvent(seq, type, data) {
  return { type, seq, time: FIXED_NOW.getTime(), data }
}

/** Build a trace from events with the shared contexts/limits. */
function traceOf(events, extra = {}) {
  return buildSessionTrace({
    sessionId: 'session-test-1',
    events,
    totalEvents: events.length,
    contexts: CONTEXTS,
    limits: LIMITS,
    ...extra
  })
}

test('FILE_TOOLS and SHELL_TOOLS expose the documented tool lists', () => {
  assert.deepEqual(
    [...FILE_TOOLS],
    ['write', 'edit', 'read', 'read_image', 'str_replace_editor', 'glob', 'grep']
  )
  assert.deepEqual([...SHELL_TOOLS], ['pwsh', 'bash'])
  assert.ok(Object.isFrozen(FILE_TOOLS))
  assert.ok(Object.isFrozen(SHELL_TOOLS))
})

test('extractTouchedPaths reads the documented path keys in fixed order', () => {
  assert.deepEqual(extractTouchedPaths('write', { path: 'src/a.js' }), ['src/a.js'])
  assert.deepEqual(extractTouchedPaths('edit', { file_path: 'src/b.js' }), ['src/b.js'])
  assert.deepEqual(extractTouchedPaths('read', { filePath: 'src/c.js' }), ['src/c.js'])
  assert.deepEqual(extractTouchedPaths('read_image', { target: 'docs/d.png' }), ['docs/d.png'])
  // Fixed key order (path, file_path, filePath, target) regardless of insertion order.
  assert.deepEqual(
    extractTouchedPaths('str_replace_editor', { target: 'e.txt', path: 'f.txt' }),
    ['f.txt', 'e.txt']
  )
  // glob/grep carry their root in `path`.
  assert.deepEqual(extractTouchedPaths('glob', { pattern: '*.js', path: 'src' }), ['src'])
  assert.deepEqual(extractTouchedPaths('grep', { pattern: 'handoff', path: 'src' }), ['src'])
  // Blank strings are dropped, duplicates are removed, non-strings are ignored.
  assert.deepEqual(
    extractTouchedPaths('write', { path: ' dup.js ', file_path: 'dup.js', filePath: 7, target: '' }),
    ['dup.js']
  )
  // Shell tools and unknown tools never yield file paths.
  assert.deepEqual(extractTouchedPaths('pwsh', { command: 'ls', path: 'src' }), [])
  assert.deepEqual(extractTouchedPaths('web_search', { path: 'src' }), [])
  assert.deepEqual(extractTouchedPaths('write', null), [])
  assert.deepEqual(extractTouchedPaths('write', '{"path":"src/a.js"}'), [])
  assert.deepEqual(extractTouchedPaths(null, { path: 'src/a.js' }), [])
})

test('sample event stream yields the expected trace', () => {
  const trace = traceOf(sampleSessionEvents())
  assert.deepEqual(trace, {
    sessionId: 'session-test-1',
    eventCounts: { total: 9, toolCalls: 7, toolErrors: 1 },
    toolCalls: { total: 7, byName: { edit: 1, grep: 1, pwsh: 2, read: 2, write: 1 } },
    touchedFiles: [
      { path: 'src', tool: 'grep', count: 1, lastSeq: 90 },
      { path: 'src/util.js', tool: 'read', count: 1, lastSeq: 80 },
      { path: 'docs/design.md', tool: 'write', count: 1, lastSeq: 30 },
      { path: 'src/index.js', tool: 'edit', count: 2, lastSeq: 20 }
    ],
    commands: [
      { tool: 'pwsh', commandRedacted: 'git status', lastSeq: 60 },
      { tool: 'pwsh', commandRedacted: 'node --test 2>&1 | Select-Object -First 5', lastSeq: 40 }
    ],
    redactionHits: [],
    window: { events: 9, truncated: false }
  })
})

test('trace objects and sub-objects use the fixed key order', () => {
  const trace = traceOf(sampleSessionEvents())
  assert.deepEqual(Object.keys(trace), [
    'sessionId',
    'eventCounts',
    'toolCalls',
    'touchedFiles',
    'commands',
    'redactionHits',
    'window'
  ])
  assert.deepEqual(Object.keys(trace.eventCounts), ['total', 'toolCalls', 'toolErrors'])
  assert.deepEqual(Object.keys(trace.toolCalls), ['total', 'byName'])
  assert.deepEqual(Object.keys(trace.toolCalls.byName), ['edit', 'grep', 'pwsh', 'read', 'write'])
  assert.deepEqual(Object.keys(trace.touchedFiles[0]), ['path', 'tool', 'count', 'lastSeq'])
  assert.deepEqual(Object.keys(trace.commands[0]), ['tool', 'commandRedacted', 'lastSeq'])
  assert.deepEqual(Object.keys(trace.window), ['events', 'truncated'])
})

test('paths are relativized to the workspace or tokenized outside it', () => {
  const events = [
    toolCallEvent(1, 'write', { path: `${WORKSPACE_ROOT}\\src\\index.js` }),
    toolCallEvent(2, 'read', { path: `${DSH_HOME}\\skills\\handoff-pack\\SKILL.md` }),
    toolCallEvent(3, 'edit', { path: 'D:\\other\\notes.md' }),
    toolCallEvent(4, 'write', { path: './src\\util.js' }),
    toolCallEvent(5, 'read', { file_path: 'src/index.js' })
  ]
  const trace = traceOf(events)
  assert.deepEqual(trace.touchedFiles, [
    { path: 'src/index.js', tool: 'read', count: 2, lastSeq: 5 },
    { path: 'src/util.js', tool: 'write', count: 1, lastSeq: 4 },
    { path: 'D:/other/notes.md', tool: 'edit', count: 1, lastSeq: 3 },
    { path: '$DSH_HOME/skills/handoff-pack/SKILL.md', tool: 'read', count: 1, lastSeq: 2 }
  ])
})

test('workspace-root, blank and non-string paths are ignored; tool calls still count', () => {
  const events = [
    toolCallEvent(1, 'read', { path: WORKSPACE_ROOT }),
    toolCallEvent(2, 'write', { path: '   ' }),
    toolCallEvent(3, 'edit', { path: 42 }),
    toolCallEvent(4, 'read', { path: '.' }),
    toolCallEvent(5, 'read', { path: '   src/a.js   ' })
  ]
  const trace = traceOf(events)
  assert.deepEqual(trace.touchedFiles, [{ path: 'src/a.js', tool: 'read', count: 1, lastSeq: 5 }])
  assert.equal(trace.eventCounts.toolCalls, 5)
  assert.equal(trace.toolCalls.byName.read, 3)
})

test('repeated touches merge count/lastSeq and sort by lastSeq descending', () => {
  const events = [
    toolCallEvent(10, 'write', { path: 'src/a.js' }),
    toolCallEvent(20, 'read', { path: 'src/b.js' }),
    toolCallEvent(30, 'edit', { path: 'src/a.js' }),
    toolCallEvent(40, 'read', { path: 'src/a.js' }),
    toolCallEvent(50, 'write', { path: 'docs/x.md' })
  ]
  const trace = traceOf(events)
  assert.deepEqual(trace.touchedFiles, [
    { path: 'docs/x.md', tool: 'write', count: 1, lastSeq: 50 },
    { path: 'src/a.js', tool: 'read', count: 3, lastSeq: 40 },
    { path: 'src/b.js', tool: 'read', count: 1, lastSeq: 20 }
  ])
})

test('shell commands are redacted and aggregated into redactionHits', () => {
  const events = [
    toolCallEvent(10, 'pwsh', { command: 'export OPENAI_KEY=sk-abcdefghijklmnopqrstuvwx' }),
    toolCallEvent(20, 'bash', { command: 'node deploy.js --token=supersecretvalue12345' })
  ]
  const trace = traceOf(events)
  assert.deepEqual(trace.commands, [
    {
      tool: 'bash',
      commandRedacted: 'node deploy.js --token=«REDACTED:generic-assignment»',
      lastSeq: 20
    },
    { tool: 'pwsh', commandRedacted: 'export OPENAI_KEY=«REDACTED:cloud-key»', lastSeq: 10 }
  ])
  assert.deepEqual(trace.redactionHits, [
    { kind: 'cloud-key', count: 1 },
    { kind: 'generic-assignment', count: 1 }
  ])
  for (const row of trace.commands) {
    assert.deepEqual(scanSecrets(row.commandRedacted), [])
    assert.deepEqual(finalCheck(row.commandRedacted), [])
  }
})

test('shell command truncation keeps <=300 chars and never slices a placeholder', () => {
  const plain = traceOf([toolCallEvent(1, 'pwsh', { command: 'x'.repeat(400) })])
  assert.equal(plain.commands[0].commandRedacted.length, 300)
  assert.equal(plain.commands[0].commandRedacted, 'x'.repeat(300))

  const boundarySource = `node ${'a'.repeat(285)} --token=secretvalue123456`
  const boundary = traceOf([toolCallEvent(2, 'pwsh', { command: boundarySource })])
  const redacted = boundary.commands[0].commandRedacted
  assert.equal(redacted.length, 299)
  assert.equal(redacted, `node ${'a'.repeat(285)} --token=`)
  assert.equal(redacted.includes('«'), false)
  assert.deepEqual(boundary.redactionHits, [{ kind: 'generic-assignment', count: 1 }])
  assert.deepEqual(scanSecrets(redacted), [])
  assert.deepEqual(finalCheck(redacted), [])
})

test('touchedFiles is capped at limit.sessionMaxFiles (newest wins)', () => {
  const events = []
  for (let index = 0; index < 120; index += 1) {
    events.push(
      toolCallEvent(index + 1, 'write', { path: `src/file-${String(index).padStart(3, '0')}.js` })
    )
  }
  const trace = traceOf(events)
  assert.equal(trace.touchedFiles.length, 100)
  assert.deepEqual(trace.touchedFiles[0], {
    path: 'src/file-119.js',
    tool: 'write',
    count: 1,
    lastSeq: 120
  })
  assert.deepEqual(trace.touchedFiles.at(-1), {
    path: 'src/file-020.js',
    tool: 'write',
    count: 1,
    lastSeq: 21
  })
  for (let index = 1; index < trace.touchedFiles.length; index += 1) {
    assert.ok(trace.touchedFiles[index - 1].lastSeq > trace.touchedFiles[index].lastSeq)
  }
})

test('commands is capped at limit.sessionMaxCommands (newest wins)', () => {
  const events = []
  for (let seq = 1; seq <= 45; seq += 1) {
    events.push(toolCallEvent(seq, 'pwsh', { command: `echo ${seq}` }))
  }
  const trace = traceOf(events)
  assert.equal(trace.commands.length, 40)
  assert.equal(trace.commands[0].lastSeq, 45)
  assert.equal(trace.commands[0].commandRedacted, 'echo 45')
  assert.equal(trace.commands.at(-1).lastSeq, 6)
  assert.equal(trace.commands.at(-1).commandRedacted, 'echo 6')
})

test('custom limits are honored (files, commands, command chars, event window)', () => {
  const fileEvents = [
    toolCallEvent(1, 'write', { path: 'a.js' }),
    toolCallEvent(2, 'write', { path: 'b.js' }),
    toolCallEvent(3, 'write', { path: 'c.js' })
  ]
  const filesTrace = traceOf(fileEvents, { limits: { ...LIMITS, sessionMaxFiles: 2 } })
  assert.deepEqual(
    filesTrace.touchedFiles.map((row) => row.path),
    ['c.js', 'b.js']
  )

  const commandEvents = [
    toolCallEvent(1, 'pwsh', { command: 'echo one' }),
    toolCallEvent(2, 'pwsh', { command: 'echo two' }),
    toolCallEvent(3, 'pwsh', { command: 'echo three' })
  ]
  const commandsTrace = traceOf(commandEvents, { limits: { ...LIMITS, sessionMaxCommands: 2 } })
  assert.equal(commandsTrace.commands.length, 2)

  const charsTrace = traceOf([toolCallEvent(1, 'pwsh', { command: 'y'.repeat(50) })], {
    limits: { ...LIMITS, sessionMaxCommandChars: 10 }
  })
  assert.equal(charsTrace.commands[0].commandRedacted, 'y'.repeat(10))

  const windowTrace = traceOf(sampleSessionEvents(), {
    limits: { ...LIMITS, sessionMaxEvents: 3 }
  })
  assert.deepEqual(windowTrace.window, { events: 3, truncated: true })
  assert.equal(windowTrace.eventCounts.toolCalls, 2) // read at 80, grep at 90
  assert.equal(windowTrace.eventCounts.toolErrors, 1) // tool/result at 70
  assert.deepEqual(windowTrace.touchedFiles, [
    { path: 'src', tool: 'grep', count: 1, lastSeq: 90 },
    { path: 'src/util.js', tool: 'read', count: 1, lastSeq: 80 }
  ])
})

test('window keeps the newest events and reports truncation against totalEvents', () => {
  const events = [toolCallEvent(1, 'read', { path: 'old.js' })]
  for (let seq = 2; seq < 2100; seq += 1) {
    events.push(
      rawEvent(seq, 'tool/result', {
        message: { role: 'tool', content: [], isError: false }
      })
    )
  }
  events.push(toolCallEvent(2100, 'read', { path: 'new.js' }))
  assert.equal(events.length, 2100)

  const trace = traceOf(events)
  assert.deepEqual(trace.window, { events: 2000, truncated: true })
  assert.deepEqual(trace.touchedFiles, [{ path: 'new.js', tool: 'read', count: 1, lastSeq: 2100 }])
  assert.equal(trace.eventCounts.total, 2100)
  assert.equal(trace.eventCounts.toolCalls, 1)
  assert.equal(trace.eventCounts.toolErrors, 0)

  const declared = traceOf(sampleSessionEvents(), { totalEvents: 5000 })
  assert.deepEqual(declared.window, { events: 9, truncated: true })
  assert.equal(declared.eventCounts.total, 5000)
})

test('unavailable/empty sessions yield an empty trace', () => {
  const emptyTrace = {
    sessionId: 'session-empty',
    eventCounts: { total: 0, toolCalls: 0, toolErrors: 0 },
    toolCalls: { total: 0, byName: {} },
    touchedFiles: [],
    commands: [],
    redactionHits: [],
    window: { events: 0, truncated: false }
  }
  assert.deepEqual(
    buildSessionTrace({
      sessionId: 'session-empty',
      events: [],
      totalEvents: 0,
      contexts: CONTEXTS,
      limits: LIMITS
    }),
    emptyTrace
  )
  assert.deepEqual(buildSessionTrace(), { ...emptyTrace, sessionId: null })
  assert.deepEqual(buildSessionTrace({ sessionId: 'session-empty', events: null }), emptyTrace)
  assert.equal(buildSessionTrace({ sessionId: null, events: [] }).sessionId, null)
  assert.equal(buildSessionTrace({ sessionId: '', events: [] }).sessionId, null)
})

test('user/assistant message bodies are never read (getter trap) or mined', () => {
  const events = [
    {
      type: 'user/message',
      seq: 1,
      time: FIXED_NOW.getTime(),
      get data() {
        throw new Error('user/message body was read')
      }
    },
    {
      type: 'assistant/message',
      seq: 2,
      time: FIXED_NOW.getTime(),
      get data() {
        throw new Error('assistant/message body was read')
      }
    },
    toolCallEvent(3, 'read', { path: 'src/index.js' }),
    rawEvent(4, 'tool/result', { message: { role: 'tool', content: [], isError: true } })
  ]
  const trace = traceOf(events)
  assert.deepEqual(trace.touchedFiles, [{ path: 'src/index.js', tool: 'read', count: 1, lastSeq: 3 }])
  assert.deepEqual(trace.commands, [])
  assert.deepEqual(trace.redactionHits, [])
  assert.equal(trace.eventCounts.total, 4)
  assert.equal(trace.eventCounts.toolCalls, 1)
  assert.equal(trace.eventCounts.toolErrors, 1)
})

test('tool/result errors come from data.error or data.message.isError only', () => {
  const events = [
    rawEvent(1, 'tool/result', { error: { name: 'Error', code: 'X' } }),
    rawEvent(2, 'tool/result', { error: null, message: { isError: true } }),
    rawEvent(3, 'tool/result', { error: null, message: { isError: false } }),
    rawEvent(4, 'tool/result', { message: { isError: 'true' } }),
    rawEvent(5, 'tool/result', null),
    rawEvent(6, 'tool/result', { error: undefined, message: { isError: true } })
  ]
  const trace = traceOf(events)
  assert.equal(trace.eventCounts.toolErrors, 3) // 1, 2 and 6
  assert.equal(trace.eventCounts.toolCalls, 0)
  assert.deepEqual(trace.touchedFiles, [])
  assert.deepEqual(trace.commands, [])
})

test('malformed tool/call events are skipped without throwing', () => {
  const events = [
    rawEvent(1, 'tool/call', { name: 'read', arguments: '{not json' }),
    rawEvent(2, 'tool/call', { name: 'write' }),
    rawEvent(3, 'tool/call', { name: 'edit', arguments: null }),
    rawEvent(4, 'tool/call', { name: 'read', arguments: '{"path":"src/ok.js"}' }),
    rawEvent(5, 'tool/call', { name: 'read', arguments: { path: 'src/obj.js' } }),
    rawEvent(6, 'tool/call', { name: '  ', arguments: { path: 'ignored.js' } }),
    rawEvent(7, 'tool/call', null),
    rawEvent(8, 'tool/call', { name: 42, arguments: { path: 'ignored.js' } }),
    rawEvent(9, 'tool/call', { name: 'pwsh', arguments: '{"command":""}' }),
    rawEvent(10, 'tool/call', { name: 'pwsh', arguments: { command: 42 } })
  ]
  const trace = traceOf(events)
  assert.equal(trace.eventCounts.total, 10)
  assert.equal(trace.eventCounts.toolCalls, 7) // 1, 2, 3, 4, 5, 9, 10
  assert.deepEqual(trace.toolCalls.byName, { edit: 1, pwsh: 2, read: 3, write: 1 })
  assert.deepEqual(trace.touchedFiles, [
    { path: 'src/obj.js', tool: 'read', count: 1, lastSeq: 5 },
    { path: 'src/ok.js', tool: 'read', count: 1, lastSeq: 4 }
  ])
  assert.deepEqual(trace.commands, [])
  assert.deepEqual(trace.redactionHits, [])
})

test('file tool argument content is not read or redacted', () => {
  const events = [
    toolCallEvent(1, 'write', {
      path: 'src/new.js',
      content: 'SECRET_TOKEN=leak-through-argument\n'
    })
  ]
  const trace = traceOf(events)
  assert.deepEqual(trace.touchedFiles, [
    { path: 'src/new.js', tool: 'write', count: 1, lastSeq: 1 }
  ])
  assert.deepEqual(trace.commands, [])
  assert.deepEqual(trace.redactionHits, [])
})

test('trace building is deterministic: identical input yields identical output', () => {
  const events = sampleSessionEvents()
  assert.equal(JSON.stringify(traceOf(events)), JSON.stringify(traceOf(events)))
})
