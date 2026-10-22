import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ERROR } from '../src/contracts.js'
import {
  REDACTION_RULES,
  deniedReason,
  finalCheck,
  isDeniedFile,
  redactDeep,
  redactText,
  scanSecrets
} from '../src/redact.js'
import { FIXED_NOW } from './helpers/fixtures.js'

/** The placeholder a rule writes into redacted text. */
function placeholder(kind) {
  return `«REDACTED:${kind}»`
}

/** The sorted kinds of a hits array. */
function kindsOf(hits) {
  return hits.map((hit) => hit.kind)
}

/** True when `error` is the structured pure-logic misuse failure. */
function isInternalError(error) {
  return error instanceof Error && error.name === 'HandoffError' && error.code === ERROR.INTERNAL
}

/** Assert an exact hits list (order and counts). */
function assertHits(actual, expected) {
  assert.deepEqual(actual, expected)
}

test('REDACTION_RULES exposes the seven documented kinds in their fixed order', () => {
  assert.deepEqual(
    REDACTION_RULES.map((rule) => rule.kind),
    [
      'private-key-block',
      'bearer',
      'cloud-key',
      'url-credentials',
      'conn-string-password',
      'env-assignment',
      'generic-assignment'
    ]
  )
  const seen = new Set()
  for (const rule of REDACTION_RULES) {
    assert.equal(typeof rule.kind, 'string')
    assert.ok(rule.pattern instanceof RegExp, `${rule.kind} pattern must be a RegExp`)
    assert.equal(rule.pattern.global, true, `${rule.kind} pattern must be global`)
    assert.equal(seen.has(rule.kind), false, `duplicate kind ${rule.kind}`)
    seen.add(rule.kind)
    if (rule.replacement !== undefined) assert.equal(typeof rule.replacement, 'string')
  }
  assert.equal(seen.size, 7)
  assert.ok(Object.isFrozen(REDACTION_RULES))
})

test('private-key-block redacts PEM, OpenSSH, PGP and unterminated key blocks', () => {
  const blocks = [
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEfakeKEYMATERIAL\n-----END RSA PRIVATE KEY-----',
    '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----',
    '-----BEGIN PGP PRIVATE KEY BLOCK-----\nVersion: x\n\nMIIEpgp\n-----END PGP PRIVATE KEY BLOCK-----'
  ]
  for (const block of blocks) {
    const result = redactText(`before\n${block}\nafter`)
    assert.equal(result.text, `before\n${placeholder('private-key-block')}\nafter`)
    assertHits(result.hits, [{ kind: 'private-key-block', count: 1 }])
    assert.deepEqual(scanSecrets(result.text), [])
  }
  // A truncated block (no END marker) is still a secret: it runs to end of text.
  const truncated = redactText('before\n-----BEGIN PRIVATE KEY-----\nMIIEtruncated')
  assert.equal(truncated.text, `before\n${placeholder('private-key-block')}`)
  assertHits(truncated.hits, [{ kind: 'private-key-block', count: 1 }])
})

test('bearer rule redacts the whole authorization token, case-insensitively', () => {
  const result = redactText(
    'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig\n' +
      'proxy: bearer abcdefgh12345678\n'
  )
  assert.equal(
    result.text,
    `Authorization: ${placeholder('bearer')}\nproxy: ${placeholder('bearer')}\n`
  )
  assertHits(result.hits, [{ kind: 'bearer', count: 2 }])
  assert.deepEqual(scanSecrets(result.text), [])
})

test('cloud-key rule redacts OpenAI, AWS and GitHub key shapes', () => {
  const result = redactText(
    'keys: sk-abcdefghijklmnopqrstuvwxyz AKIAABCDEFGHIJKLMNOP ghp_abcdefghijklmnopqrst\n'
  )
  assert.equal(
    result.text,
    `keys: ${placeholder('cloud-key')} ${placeholder('cloud-key')} ${placeholder('cloud-key')}\n`
  )
  assertHits(result.hits, [{ kind: 'cloud-key', count: 3 }])
  // Too-short lookalikes are not keys.
  assert.deepEqual(kindsOf(redactText('sk-short AKIASHORT').hits), [])
})

test('url-credentials rule hides user:password and keeps the host readable', () => {
  const result = redactText(
    'postgres://app:hunter2@db.example.com:5432/app\nhttps://user:pa55w0rd@example.com/x\n'
  )
  assert.equal(
    result.text,
    `${placeholder('url-credentials')}@db.example.com:5432/app\n` +
      `${placeholder('url-credentials')}@example.com/x\n`
  )
  assertHits(result.hits, [{ kind: 'url-credentials', count: 2 }])
  assert.deepEqual(scanSecrets(result.text), [])
})

test('conn-string-password rule hides Password/Pwd/Passwd values in connection strings', () => {
  const text =
    'connect via "Server=db;Database=app;Password=Pa55w0rd;User Id=sa;"\n' +
    'fallback: "Server=db2;Pwd = quotedsecret;Passwd=\'singlequoted\'"\n'
  const result = redactText(text)
  assert.equal(
    result.text,
    'connect via "Server=db;Database=app;Password=' +
      `${placeholder('conn-string-password')};User Id=sa;"\n` +
      'fallback: "Server=db2;Pwd = ' +
      `${placeholder('conn-string-password')};Passwd='${placeholder('conn-string-password')}'"\n`
  )
  assertHits(result.hits, [{ kind: 'conn-string-password', count: 3 }])
  assert.deepEqual(scanSecrets(result.text), [])
})

test('env-assignment rule redacts dotenv lines and keeps the variable name', () => {
  const result = redactText(
    '# dotenv fixture\nexport API_KEY=supersecretvalue\nSECRET_TOKEN=super-secret-token-value\nDSH_TEST=1\n'
  )
  assert.equal(
    result.text,
    '# dotenv fixture\nexport API_KEY=' +
      `${placeholder('env-assignment')}\n` +
      `SECRET_TOKEN=${placeholder('env-assignment')}\n` +
      `DSH_TEST=${placeholder('env-assignment')}\n`
  )
  assertHits(result.hits, [{ kind: 'env-assignment', count: 3 }])
  // Code lines with spaces around `=` are assignments but not dotenv lines.
  assert.deepEqual(kindsOf(redactText('const total = compute()').hits), [])
})

test('generic-assignment rule redacts key/token/secret/password style assignments', () => {
  const cases = [
    '  apiKey: "abcd1234efgh"',
    '  db_password = hunter2secure',
    '{"client_secret": "s3cr3t-value"}',
    'meta.auth_token: abcd1234efgh',
    'API_KEY = abcd1234efgh'
  ]
  for (const source of cases) {
    const result = redactText(source)
    assert.ok(
      result.text.includes(placeholder('generic-assignment')),
      `expected a generic-assignment placeholder in: ${result.text}`
    )
    assertHits(result.hits, [{ kind: 'generic-assignment', count: 1 }])
    assert.deepEqual(scanSecrets(result.text), [])
  }
})

test('generic-assignment ignores bare key/keys field names but catches compound key names', () => {
  // Structural fields named exactly `key`/`keys` (e.g. manifest project.key) are
  // not secret assignments and must pass through untouched.
  const structural = [
    '{"key": "ws-abcd1234", "name": "ws"}',
    '{"keys": ["a", "b"]}',
    '"key": "ws-abcd1234"',
    '"KEY": "ws-abcd1234"',
    'key: ws-abcd1234',
    '{"keyId": "kid-1234"}',
    '{"keyword": "value"}',
    'keys = [a, b]',
    // Dotted namespaces are paths, not compound key names: the rendered H0
    // header and manifest.json both spell the project key this way.
    'project.key: ws-abcd1234',
    '{"project.key": "ws-abcd1234"}',
    '- 项目：`ws`（project.key: ws-abcd1234；换项目需重新生成。'
  ]
  for (const source of structural) {
    const result = redactText(source)
    assert.equal(result.text, source, `unexpected redaction of ${source}`)
    assert.deepEqual(result.hits, [], `unexpected hits for ${source}`)
    assert.deepEqual(scanSecrets(source), [])
  }
  // Compound key names still name a secret and must be redacted.
  const compound = [
    '{"apiKey": "abc123456789"}',
    '{"api_key": "abc123456789"}',
    '{"access_key": "abc123456789"}',
    '{"secret_key": "abc123456789"}',
    '{"private_key": "abc123456789"}',
    '{"signing_key": "abc123456789"}',
    '{"encryption_key": "abc123456789"}',
    '{"privateKey": "abc123456789"}',
    '{"api_keys": "abc123456789"}',
    // A dotted namespace whose final segment is a compound key name still names
    // a secret (only a bare `.key` segment is structural).
    'server.api_key: abc123456789'
  ]
  for (const source of compound) {
    const result = redactText(source)
    assertHits(result.hits, [{ kind: 'generic-assignment', count: 1 }])
    assert.ok(
      result.text.includes(placeholder('generic-assignment')),
      `expected a generic-assignment placeholder in: ${result.text}`
    )
    assert.deepEqual(scanSecrets(result.text), [])
  }
  // The non-key keywords keep their permissive bare-name behavior.
  for (const name of ['token', 'secret', 'password', 'authorization', 'bearer', 'credential']) {
    const source = `{"${name}": "abc123456789"}`
    assertHits(redactText(source).hits, [{ kind: 'generic-assignment', count: 1 }])
  }
})

test('minimal manifest-shaped JSON has no secret residue', () => {
  const manifestShaped = JSON.stringify(
    {
      schema: 'dsh-handoff-kit/handoff',
      schemaVersion: 1,
      generator: { name: 'dsh-handoff-kit', version: '0.1.0', dshVersion: 'unknown', platform: 'win32' },
      batchId: '20261022T023512Z-a1b2',
      createdAt: '2026-10-22T02:35:12.000Z',
      project: { key: 'ws-abcd1234', name: 'ws', workspace: '$WORKSPACE' },
      session: { id: 'session-test-1', cwd: '$WORKSPACE', agentPreset: null },
      sandbox: { mode: 'danger-full-access', workspaceRoot: '$WORKSPACE' },
      inputs: { title: 'Fixture handoff', goal: null, summary: null, files: [], copyFiles: false },
      git: {
        head: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
        branch: 'main',
        detached: false,
        remote: 'https://example.com/acme/fixture.git',
        lastCommit: { sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', time: '2026-10-22T02:00:00.000Z', subject: 'feat: fixture' },
        indexVersion: 2,
        packedRefsPresent: false
      },
      artifacts: [{ path: 'HANDOFF.md', bytes: 1024, sha256: 'b'.repeat(64) }],
      files: [{ path: 'src/index.js', role: 'source', bytes: 42, sha256: 'c'.repeat(64) }],
      sessionTrace: {
        sessionId: 'session-test-1',
        eventCounts: { total: 9, toolCalls: 7, toolErrors: 1 },
        toolCalls: { total: 7, byName: { read: 5, write: 2 } },
        touchedFiles: [{ path: 'src/index.js', tool: 'read', count: 2, lastSeq: 80 }],
        commands: [{ tool: 'pwsh', commandRedacted: 'git status', lastSeq: 60 }],
        redactionHits: [],
        window: { events: 9, truncated: false }
      },
      redactions: [],
      warnings: [{ code: 'NO_GIT_STATUS', detail: 'subprocesses are disabled in P0' }],
      limits: {
        maxEntries: 4000,
        maxDepth: 4,
        maxHashFiles: 200,
        maxFileBytes: 4194304,
        maxTotalBytes: 16777216,
        maxSessionEvents: 2000,
        maxCommandChars: 300
      }
    },
    null,
    2
  )
  assert.deepEqual(scanSecrets(manifestShaped), [])
  assert.deepEqual(finalCheck(manifestShaped), [])
  assert.deepEqual(redactText(manifestShaped).hits, [])
  assert.equal(redactText(manifestShaped).text, manifestShaped)
})

test('a combined document hits all seven kinds once each, sorted by kind', () => {
  const source = [
    'prose before',
    '-----BEGIN PRIVATE KEY-----',
    'MIIEfake',
    '-----END PRIVATE KEY-----',
    'Authorization: Bearer abcdefghijklmnop',
    'api_key: sk-abcdefghijklmnop',
    'postgres://u:p@h/db',
    'connect "Server=db;Password=hunter2;"',
    'SECRET=top',
    '  token: "abcdefgh"'
  ].join('\n')
  const first = redactText(source)
  assert.equal(
    first.text,
    'prose before\n' +
      `${placeholder('private-key-block')}\n` +
      `Authorization: ${placeholder('bearer')}\n` +
      `api_key: ${placeholder('cloud-key')}\n` +
      `${placeholder('url-credentials')}@h/db\n` +
      `connect "Server=db;Password=${placeholder('conn-string-password')};"\n` +
      `SECRET=${placeholder('env-assignment')}\n` +
      `  token: "${placeholder('generic-assignment')}"`
  )
  assertHits(first.hits, [
    { kind: 'bearer', count: 1 },
    { kind: 'cloud-key', count: 1 },
    { kind: 'conn-string-password', count: 1 },
    { kind: 'env-assignment', count: 1 },
    { kind: 'generic-assignment', count: 1 },
    { kind: 'private-key-block', count: 1 },
    { kind: 'url-credentials', count: 1 }
  ])
  const second = redactText(first.text)
  assert.equal(second.text, first.text)
  assert.deepEqual(second.hits, [])
  assert.deepEqual(scanSecrets(first.text), [])
  assert.deepEqual(finalCheck(first.text), [])
})

test('hits aggregate repeated matches per kind and stay sorted by kind', () => {
  const result = redactText(
    'SECRET_A=1\nSECRET_B=2\nsk-abcdefghijklmnop sk-zyxwvutsrqponmlk Bearer abcdefghijkl\n'
  )
  assert.deepEqual(result.hits, [
    { kind: 'bearer', count: 1 },
    { kind: 'cloud-key', count: 2 },
    { kind: 'env-assignment', count: 2 }
  ])
})

test('redaction is idempotent: a second pass is a byte-identical no-op', () => {
  const sources = [
    'SECRET_TOKEN=super-secret-token-value\n',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEfake\n-----END RSA PRIVATE KEY-----\n',
    'Authorization: Bearer abcdefghijklmnop\n',
    'OPENAI_KEY=sk-abcdefghijklmnopqrst\n',
    'postgres://u:p@example.com/db\n',
    'connect "Server=db;Password=hunter2;"\n',
    '{"client_secret": "s3cr3t-value"}\n',
    'plain clean text with no secrets\n'
  ]
  for (const source of sources) {
    const first = redactText(source)
    const second = redactText(first.text)
    assert.equal(second.text, first.text)
    assert.deepEqual(second.hits, [])
    assert.deepEqual(scanSecrets(first.text), [])
    assert.deepEqual(finalCheck(first.text), [])
  }
})

test('existing placeholders are never re-matched by any rule', () => {
  const text =
    `TOKEN=${placeholder('env-assignment')}\n` +
    `api_key: "${placeholder('generic-assignment')}"\n` +
    `Bearer ${placeholder('bearer')}\n`
  const result = redactText(text)
  assert.equal(result.text, text)
  assert.deepEqual(result.hits, [])
  assert.deepEqual(scanSecrets(text), [])
})

test('rule order prevents one secret from being counted under two kinds', () => {
  // bearer is removed before the generic `Authorization:` pattern can see it
  assertHits(redactText('Authorization: Bearer abcdefghijklmnop').hits, [
    { kind: 'bearer', count: 1 }
  ])
  // a password inside a private-key block is part of the block
  assertHits(
    redactText('-----BEGIN RSA PRIVATE KEY-----\nPassword=hunter2\n-----END RSA PRIVATE KEY-----')
      .hits,
    [{ kind: 'private-key-block', count: 1 }]
  )
  // url-credentials is removed before env-assignment can re-count the URL value
  assertHits(redactText('export DATABASE_URL=postgres://u:p@h/db').hits, [
    { kind: 'url-credentials', count: 1 }
  ])
})

test('scanSecrets only detects; finalCheck reports the same hits', () => {
  const dirty = 'SECRET=abc123\nAuthorization: Bearer abcdefghijklmnop\n'
  assert.deepEqual(scanSecrets(dirty), [
    { kind: 'bearer', count: 1 },
    { kind: 'env-assignment', count: 1 }
  ])
  assert.deepEqual(finalCheck(dirty), scanSecrets(dirty))
  assert.deepEqual(scanSecrets(''), [])
  assert.deepEqual(finalCheck(''), [])
})

test('finalCheck accepts a clean artifact and rejects residual secrets', () => {
  const clean =
    '# HANDOFF\n\n## H1 上次做了什么\n\n' +
    '- 路径: src/index.js\n' +
    '- sha256: ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad\n' +
    '- 生成时间: 2026-10-22T02:35:12.000Z\n' +
    '- node --test: 42 passed\n'
  assert.deepEqual(finalCheck(clean), [])
  assert.deepEqual(finalCheck(`api_key: "${placeholder('generic-assignment')}"`), [])
  assert.deepEqual(finalCheck('DB_PASSWORD=hunter2'), [{ kind: 'env-assignment', count: 1 }])
})

test('isDeniedFile covers the full denylist table with stable reasons', () => {
  const denied = [
    ['.env', 'dot-env'],
    ['.env.local', 'dot-env'],
    ['.env.production', 'dot-env'],
    ['.ENV', 'dot-env'],
    ['config/.env', 'dot-env'],
    ['config\\.env.local', 'dot-env'],
    ['server.pem', 'private-key'],
    ['CERT.PEM', 'private-key'],
    ['server.key', 'private-key'],
    ['.ssh/id_rsa', 'private-key'],
    ['.ssh/id_rsa.pub', 'private-key'],
    ['keys/id_rsa_backup', 'private-key'],
    ['client.p12', 'private-key'],
    ['client.pfx', 'private-key'],
    ['credentials.json', 'credential'],
    ['config/my-Credential-file.txt', 'credential'],
    ['cache.db', 'database'],
    ['CACHE.DB', 'database'],
    ['app.sqlite', 'database'],
    ['app.sqlite3', 'database'],
    ['app.sqlite-wal', 'database'],
    ['node_modules/pkg/index.js', 'directory:node_modules'],
    ['src/node_modules/x.js', 'directory:node_modules'],
    ['NODE_MODULES/x.js', 'directory:node_modules'],
    ['node_modules', 'directory:node_modules'],
    ['node_modules/', 'directory:node_modules'],
    ['.venv/lib/python3.12/site.py', 'directory:.venv'],
    ['.GIT/HEAD', 'directory:.git'],
    ['.git', 'directory:.git'],
    ['.dsh/handoff/x/HANDOFF.md', 'directory:.dsh'],
    ['.dsh/x', 'directory:.dsh'],
    ['.DSH/HANDOFF.md', 'directory:.dsh']
  ]
  for (const [relativePath, reason] of denied) {
    assert.equal(deniedReason(relativePath), reason, `reason for ${relativePath}`)
    assert.equal(isDeniedFile(relativePath), true, `isDeniedFile(${relativePath})`)
  }
})

test('isDeniedFile allows ordinary project files', () => {
  const allowed = [
    'package.json',
    'src/index.js',
    'README.md',
    'docs/design.md',
    '.gitignore',
    'environment.md',
    'keyboard.md',
    'server.pem.txt',
    'notes.db.txt',
    'lockfile.json'
  ]
  for (const relativePath of allowed) {
    assert.equal(deniedReason(relativePath), null, `reason for ${relativePath}`)
    assert.equal(isDeniedFile(relativePath), false, `isDeniedFile(${relativePath})`)
  }
  assert.equal(deniedReason(''), null)
  assert.equal(isDeniedFile(''), false)
})

test('redactText, scanSecrets, finalCheck and denylist helpers reject non-strings', () => {
  for (const fn of [redactText, scanSecrets, finalCheck]) {
    assert.throws(() => fn(42), isInternalError)
    assert.throws(() => fn(undefined), isInternalError)
  }
  assert.throws(() => isDeniedFile(undefined), isInternalError)
  assert.throws(() => deniedReason(null), isInternalError)
})

test('redactDeep walks strings/arrays/plain objects and leaves everything else as-is', () => {
  const input = {
    title: 'Deploy notes',
    token: 'SECRET=abc123',
    nested: { bearer: 'Bearer abcdefghijkl', url: 'https://u:p@example.com/x' },
    list: ['clean', 42, null, { api_key: 'sk-abcdefghijklmnop' }],
    when: FIXED_NOW,
    count: 7,
    flag: true
  }
  const result = redactDeep(input)
  assertHits(result.hits, [
    { kind: 'bearer', count: 1 },
    { kind: 'cloud-key', count: 1 },
    { kind: 'env-assignment', count: 1 },
    { kind: 'url-credentials', count: 1 }
  ])
  assert.notEqual(result.value, input)
  assert.notEqual(result.value.nested, input.nested)
  assert.deepEqual(Object.keys(result.value), Object.keys(input))
  assert.equal(result.value.when, FIXED_NOW)
  assert.equal(result.value.count, 7)
  assert.equal(result.value.flag, true)
  assert.equal(result.value.list[1], 42)
  assert.equal(result.value.list[2], null)
  assert.match(result.value.nested.bearer, new RegExp(placeholder('bearer')))
  // The input object is never mutated.
  assert.equal(input.token, 'SECRET=abc123')
  assert.equal(input.list[3].api_key, 'sk-abcdefghijklmnop')
  assert.deepEqual(redactDeep({ clean: 'plain text' }).hits, [])
  assert.deepEqual(redactDeep('SECRET=abc123').hits, [{ kind: 'env-assignment', count: 1 }])
  // Non-plain objects (Buffer) are structural leaves, not traversed.
  const buffer = Buffer.from('SECRET=abc123')
  assert.equal(redactDeep(buffer).value, buffer)
})

test('redaction is deterministic: identical input yields identical output', () => {
  const source = 'SECRET_TOKEN=abc123\nAuthorization: Bearer abcdefghijklmnop\n'
  assert.equal(JSON.stringify(redactText(source)), JSON.stringify(redactText(source)))
})

test('prose assignments and identifier assignments are not mistaken for credentials', () => {
  // Real integration output (manifest inputs.concepts / HANDOFF H1) regressed
  // while these patterns matched too loosely, losing caller text. Keep them
  // readable while the actual secret forms below still redact.
  const prose = [
    'target=user 需 danger-full-access；read-only 直接拒绝',
    'project-key = basename(repoRoot) + sha256(git remote ‖ canonical workspace)[:8]',
    'batch-id = YYYYMMDDTHHmmssZ-4hex，定宽字典序=时间序',
    'copyFiles 默认 false；target=workspace 显式降级',
    'maxEntries=4000、maxDepth=4、maxFileBytes=4194304',
    'HANDOFF.md H0-H9 + 覆盖说明；证据标签 [文件哈希]/[git]/[会话]/[输入]/[待验]',
    'const total = compute()',
    'copyFiles: false'
  ]
  for (const source of prose) {
    const result = redactText(source)
    assert.equal(result.text, source, `unexpected redaction of ${source}`)
    assert.deepEqual(result.hits, [], `unexpected hits for ${source}`)
    assert.deepEqual(scanSecrets(source), [])
  }
  // Actual credentials keep being detected under the tightened rules.
  assert.deepEqual(redactText('connect postgres://user:pw@host/db').hits, [
    { kind: 'url-credentials', count: 1 }
  ])
  assert.deepEqual(redactText('export API_KEY=supersecretvalue').hits, [
    { kind: 'env-assignment', count: 1 }
  ])
  assert.deepEqual(redactText('db_password = hunter2secure').hits, [
    { kind: 'generic-assignment', count: 1 }
  ])
  assert.deepEqual(redactText('{"apiKey": "abc123456789"}').hits, [
    { kind: 'generic-assignment', count: 1 }
  ])
})
