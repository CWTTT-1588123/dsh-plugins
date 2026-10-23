import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ERROR } from '../src/contracts.js'
import { createManifest, parseManifest, serializeManifest } from '../src/manifest.js'
import { sha256Hex } from '../src/paths.js'
import { HANDOFF_HEADINGS, renderHandoff } from '../src/render.js'
import { FIXED_BATCH_ID, FIXED_NOW_ISO, GIT_HEAD } from './helpers/fixtures.js'
import {
  EVIDENCE_FILES,
  emptyManifest,
  sampleManifest,
  sampleManifestInput
} from './helpers/manifest-fixture.js'

/** Section heading text required by P0 module interfaces §6. */
const EXPECTED_SECTIONS = [
  ['H0', '身份与边界'],
  ['H1', '上次做了什么'],
  ['H2', '概念词典'],
  ['H3', '代码地图'],
  ['H4', '已验证事实'],
  ['H5', '端到端流程'],
  ['H6', '未决/风险/坑'],
  ['H7', '协作方式'],
  ['H8', '新会话首轮动作'],
  ['H9', '禁区']
]

/** Matches a drive-letter absolute path but not a URL scheme such as `https:`. */
const DRIVE_PATH_RE = /(?<![A-Za-z0-9+.-])[A-Za-z]:[\\/]/

/** Short hash renderer used by the HANDOFF document. */
function shortOf(content) {
  return sha256Hex(content).slice(0, 12)
}

test('HANDOFF_HEADINGS lists H0–H9 then the coverage note', () => {
  assert.deepEqual(
    HANDOFF_HEADINGS,
    ['H0', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8', 'H9', '覆盖说明']
  )
})

test('renderHandoff is deterministic: two renders are byte-identical', () => {
  const manifest = sampleManifest()
  const first = renderHandoff(manifest)
  const second = renderHandoff(sampleManifest())
  assert.equal(first, second)
  assert.ok(Buffer.from(first, 'utf8').equals(Buffer.from(second, 'utf8')))
  // Re-serialized / key-reordered manifests render the same bytes.
  assert.equal(renderHandoff(parseManifest(serializeManifest(manifest))), first)
  const reordered = {}
  for (const key of Object.keys(manifest).reverse()) reordered[key] = manifest[key]
  assert.equal(renderHandoff(reordered), first)
  // LF-only, exactly one trailing newline.
  assert.ok(first.endsWith('\n'))
  assert.ok(!first.endsWith('\n\n'))
  assert.ok(!first.includes('\r'))
})

test('renderHandoff emits H0–H9 and the coverage note in order', () => {
  const text = renderHandoff(sampleManifest())
  for (const [code, title] of EXPECTED_SECTIONS) {
    assert.ok(text.includes(`## ${code} ${title}`), `missing section ${code} ${title}`)
  }
  assert.ok(text.includes('## 覆盖说明'))
  assert.ok(!text.includes('## 覆盖说明 覆盖说明'))

  let previous = -1
  for (const code of HANDOFF_HEADINGS) {
    const needle = code === '覆盖说明' ? '## 覆盖说明' : `## ${code} `
    const index = text.indexOf(needle)
    assert.ok(index >= 0, `missing heading ${needle}`)
    assert.ok(index > previous, `${code} must come after the previous section`)
    previous = index
  }
})

test('renderHandoff uses tokenized paths only and no drive-letter absolute paths', () => {
  const text = renderHandoff(sampleManifest())
  assert.ok(text.includes('`$WORKSPACE`'))
  assert.ok(text.includes('`$WORKSPACE/AGENTS.md`'))
  assert.ok(!text.includes('C:\\'))
  assert.ok(!text.includes('\\\\'))
  assert.doesNotMatch(text, DRIVE_PATH_RE)

  // An empty manifest with no tokenized inputs still never fabricates a path.
  assert.doesNotMatch(renderHandoff(emptyManifest()), DRIVE_PATH_RE)
})

test('H0 renders identity, boundary and the optional output target', () => {
  const text = renderHandoff(sampleManifest())
  assert.ok(text.includes('`fixture-app`'))
  assert.ok(text.includes('project.key: `fixture-app-1a2b3c4d`'))
  assert.ok(text.includes(`批次：\`${FIXED_BATCH_ID}\``))
  assert.ok(text.includes(`生成时间：\`${FIXED_NOW_ISO}\``))
  assert.ok(text.includes('输出目标：user'))
  assert.ok(text.includes('沙箱：`danger-full-access`'))
  assert.ok(text.includes('`session-test-1`'))
  assert.ok(text.includes('适用边界'))

  const workspaceTarget = renderHandoff(createManifest(sampleManifestInput({ target: 'workspace' })))
  assert.ok(workspaceTarget.includes('输出目标：workspace'))

  const missingTarget = renderHandoff(emptyManifest())
  assert.ok(missingTarget.includes('manifest 未记录 target'))
})

test('H1 renders caller narrative, touched files and the latest commit', () => {
  const text = renderHandoff(sampleManifest())
  assert.ok(text.includes('Hand the fixture workspace to a fresh session.'))
  assert.ok(text.includes('Implemented the manifest and render modules; unit tests are green.'))
  assert.ok(text.includes('- Use tokenized machine paths'))
  assert.ok(text.includes('- Never invent caller narrative'))
  assert.ok(text.includes('`src/index.js` — 工具：`edit`；次数：2；lastSeq：90'))
  assert.ok(text.includes('`docs/design.md` — 工具：`write`；次数：1；lastSeq：40'))
  assert.ok(text.includes('feat: fixture handoff'))
  assert.ok(text.includes(GIT_HEAD))
  // lastSeq ordering is newest first.
  assert.ok(text.indexOf('`src/index.js` — 工具') < text.indexOf('`docs/design.md` — 工具'))
})

test('H2/H3/H5 render collected content and group files by role', () => {
  const text = renderHandoff(sampleManifest())
  // H2
  assert.ok(text.includes('handoff package = HANDOFF.md + manifest.json + evidence'))
  // H3 role groups, in the documented order.
  const roleHeadings = ['入口（entry）', '配置（config）', '测试（test）', '文档（doc）', '源码（source）', '其他（other）']
  let previous = -1
  for (const heading of roleHeadings) {
    const index = text.indexOf(`### ${heading}`)
    assert.ok(index >= 0, `missing role group ${heading}`)
    assert.ok(index > previous, `role group ${heading} out of order`)
    previous = index
  }
  for (const file of EVIDENCE_FILES) {
    assert.ok(text.includes(`\`${file.path}\``), `missing evidence path ${file.path}`)
    assert.ok(
      text.includes(`sha256:\`${shortOf(file.content)}\``),
      `missing evidence hash for ${file.path}`
    )
  }
  // scan.tree top level and session-touched paths that exist.
  assert.ok(text.includes('### 工作区顶层（scan.tree）'))
  assert.ok(text.includes('- `src`（directory）'))
  assert.ok(text.includes('### 会话触碰且已采集的路径'))
  assert.ok(text.includes('- `docs/design.md`'))
  // H5
  assert.ok(text.includes('- scan collects evidence'))
  assert.ok(text.includes('- create writes the batch'))
})

test('H4 carries all five evidence labels and only manifest-backed facts', () => {
  const text = renderHandoff(sampleManifest())
  for (const label of ['文件哈希', 'git', '会话', '输入', '待验']) {
    assert.ok(text.includes(`\`[${label}]\``), `missing evidence label [${label}]`)
  }
  assert.ok(text.includes('42 个条目'))
  assert.ok(text.includes('9 次工具调用'))
  assert.ok(text.includes('HEAD 为 `' + GIT_HEAD + '`（分支 `main`）'))
  assert.ok(text.includes('`edit`=2、`pwsh`=2、`read`=3'))
  // H4 lists three inspectable file hashes (the H8 spot-check target).
  const hashed = EVIDENCE_FILES.slice(0, 3)
  for (const file of hashed) {
    assert.ok(text.includes(sha256Hex(file.content)), `missing full hash for ${file.path}`)
  }
  assert.ok(text.includes('核对时间'))
})

test('H6 lists risks, warnings and the known limitations, but never redactions', () => {
  const text = renderHandoff(sampleManifest())
  assert.ok(text.includes('### 调用方提供的未决与风险'))
  assert.ok(text.includes('No mtime is available for change detection'))
  assert.ok(text.includes('### 生成器 warnings（2 条）'))
  assert.ok(text.includes('`COLLECT_DEPTH_LIMIT` stopped at depth 4'))
  assert.ok(text.includes('`GIT_INDEX_UNREADABLE` could not read .git/index'))
  for (const limitation of ['无 mtime', '无 git status', '无删除原语']) {
    assert.ok(text.includes(limitation), `missing known limitation ${limitation}`)
  }
  // Redaction summaries belong to verify/reporting, not to the HANDOFF body.
  assert.ok(!text.includes('generic-assignment'))
  assert.doesNotMatch(text, /redactions?|脱敏/i)
})

test('H7 points at AGENTS.md when collected and states when it is missing', () => {
  const withAgents = renderHandoff(sampleManifest())
  assert.ok(withAgents.includes('`$WORKSPACE/AGENTS.md`（本次采集已发现'))
  assert.ok(withAgents.includes('不擅自改代码'))

  const withoutAgents = renderHandoff(emptyManifest())
  // A2: an explicitly-absent collaboration entry must not look like a live path
  // reference (`$WORKSPACE/AGENTS.md` would be reported as missing by verify).
  assert.ok(withoutAgents.includes('未发现 AGENTS.md'))
  assert.ok(!withoutAgents.includes('`$WORKSPACE/AGENTS.md`'))
})

test('H8 names the batch id, the reading order, both hash commands and the drift format', () => {
  const text = renderHandoff(sampleManifest())
  assert.ok(text.includes(`handoff_pack verify batchId=${FIXED_BATCH_ID}`))
  assert.ok(text.includes('H2 → H3 → H4 → H8'))
  assert.ok(text.includes('Get-FileHash -Algorithm SHA256'))
  assert.ok(text.includes('sha256sum'))
  for (const field of ['断言：', '期望：', '实际：', '结论：']) {
    assert.ok(text.includes(field), `missing drift report field ${field}`)
  }
  // At least three concrete spot-check targets with expected short hashes.
  for (const file of EVIDENCE_FILES.slice(0, 3)) {
    assert.ok(text.includes(`\`${file.path}\` → \`${shortOf(file.content)}\``))
  }
})

test('H9 and the coverage note state the forbidden claims and the scan scope', () => {
  const text = renderHandoff(sampleManifest())
  for (const forbidden of ['不得宣称', '不得用文档', '不得省略', '不得擅自改代码']) {
    assert.ok(text.includes(forbidden), `missing H9 rule ${forbidden}`)
  }
  assert.ok(text.includes('- 扫描范围：'))
  assert.ok(text.includes('- 未扫描：'))
  assert.ok(text.includes('denylist'))
  assert.ok(text.includes('无 git status'))
  assert.ok(text.includes('待验：'))
  assert.ok(text.includes('42 个条目'))
})

test('missing caller input renders explicit 未提供 markers instead of invented facts', () => {
  const text = renderHandoff(emptyManifest())
  assert.ok(text.includes('未提供'))
  assert.ok(text.includes('未提供（P1 会话提取）'))
  assert.ok(text.includes('调用方未提供，待补（生成器不编造）'))
  assert.ok(text.includes('本次未采集到代码地图'))
  assert.ok(text.includes('manifest 未记录 target'))
  assert.ok(text.includes('本次会话未触碰到已采集的路径'))
  assert.ok(HANDOFF_HEADINGS.every((code) => text.includes(`## ${code}`)))
  // Nothing about the workspace is invented: no fake hash, no fake commit.
  assert.doesNotMatch(text, /feat: fixture handoff/)
})

test('a manifest without verifiable facts says so explicitly', () => {
  const partial = parseManifest(
    JSON.stringify({
      schema: 'dsh-handoff-kit/handoff',
      schemaVersion: 1,
      batchId: FIXED_BATCH_ID,
      createdAt: FIXED_NOW_ISO
    })
  )
  const text = renderHandoff(partial)
  assert.ok(text.includes('本次未产生可验证断言'))
  assert.ok(text.includes('`[待验]`'))
  assert.ok(text.includes(`handoff_pack verify batchId=${FIXED_BATCH_ID}`))
})

test('renderHandoff rejects non-object input', () => {
  assert.throws(() => renderHandoff(null), { name: 'HandoffError', code: ERROR.INVALID_ARGS })
  assert.throws(() => renderHandoff('text'), { code: ERROR.INVALID_ARGS })
  assert.throws(() => renderHandoff([]), { code: ERROR.INVALID_ARGS })
})
