/**
 * Deterministic HANDOFF.md renderer.
 *
 * `renderHandoff(manifest)` turns one canonical manifest into the H0–H9 handoff
 * document plus the closing coverage note (P0 module interfaces §6,
 * implementation plan §8.3). It reads the manifest only: no clock, no
 * randomness, no filesystem, no environment, no network. Every path is the
 * tokenized (`$WORKSPACE` / `$DSH_HOME`) form stored in the manifest, and every
 * fact in the output comes from the manifest — missing caller input is written
 * as `未提供` / `调用方未提供，待补（生成器不编造）` instead of being invented.
 *
 * @module dsh-handoff-kit/render
 */

import { ERROR, handoffError, isPlainObject, publicLimits } from './contracts.js'
import { shortHash } from './paths.js'

/** Section codes in render order: H0–H9 then the closing coverage note. */
export const HANDOFF_HEADINGS = Object.freeze([
  'H0',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'H7',
  'H8',
  'H9',
  '覆盖说明'
])

/** Chinese section titles; the rendered heading is `<code> <title>`. */
const SECTION_TITLES = Object.freeze({
  H0: '身份与边界',
  H1: '上次做了什么',
  H2: '概念词典',
  H3: '代码地图',
  H4: '已验证事实',
  H5: '端到端流程',
  H6: '未决/风险/坑',
  H7: '协作方式',
  H8: '新会话首轮动作',
  H9: '禁区',
  覆盖说明: '覆盖说明'
})

/** Evidence-file role display order for H3 (implementation plan §8.3). */
const ROLE_ORDER = Object.freeze(['entry', 'config', 'test', 'doc', 'source', 'other'])
/** Chinese labels for the H3 role groups. */
const ROLE_LABELS = Object.freeze({
  entry: '入口',
  config: '配置',
  test: '测试',
  doc: '文档',
  source: '源码',
  other: '其他'
})

/** Marker for any input the manifest does not carry. */
const MISSING = '未提供'
/** Marker for caller narrative the generator must never invent. */
const MISSING_CALLER = '调用方未提供，待补（生成器不编造）'
/** H2 marker: glossary extraction is a P1 capability, not a P0 one. */
const MISSING_CONCEPTS = '未提供（P1 会话提取）'
/** H3 marker when no evidence file was collected at all. */
const MISSING_CODE_MAP = '本次未采集到代码地图'
/** H4 marker when no assertion at all could be made. */
const NO_ASSERTIONS = '本次未产生可验证断言'

/** SHA256 hex produced by the manifest layer. */
const SHA256_RE = /^[0-9a-f]{64}$/

/* ────────────────────────────── small helpers ────────────────────────────── */

function sectionHeading(code) {
  // The closing section is titled by its own name; H0–H9 carry `编号 中文名`.
  if (code === '覆盖说明') return `## ${code}`
  return `## ${code} ${SECTION_TITLES[code]}`
}

function objectOf(value) {
  return isPlainObject(value) ? value : {}
}

/** Non-empty trimmed string, or null. */
function stringOf(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/** String items of an array, preserving order; non-arrays yield `[]`. */
function stringsOf(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item !== '') : []
}

/** Non-negative integer, or null. */
function integerOf(value) {
  return Number.isInteger(value) && value >= 0 ? value : null
}

/** Render a path-like value as inline code, or the missing marker. */
function pathInline(value) {
  const text = stringOf(value)
  return text === null ? MISSING : `\`${text}\``
}

/** Render an arbitrary required scalar as inline code, or the missing marker. */
function codeInline(value) {
  const text = stringOf(value)
  return text === null ? MISSING : `\`${text}\``
}

/* ─────────────────────────────── H0–H9 sections ──────────────────────────── */

/**
 * Resolve the documented output target. The manifest's fixed key set does not
 * include `target`, so the optional extension key (or `scan.target`) is the only
 * place it can come from; without it the renderer says so instead of guessing.
 */
function resolveTarget(manifest) {
  const scan = objectOf(manifest.scan)
  const direct = manifest.target ?? scan.target
  if (direct === 'user') return 'user（输出到 `$DSH_HOME/handoff/…`）'
  if (direct === 'workspace') return 'workspace（输出到 `$WORKSPACE/.dsh/handoff/…`）'
  return `${MISSING}（manifest 未记录 target；以本批次实际所在目录为准）`
}

function renderIntro(manifest) {
  const project = objectOf(manifest.project)
  const name = stringOf(project.name) ?? stringOf(project.key) ?? MISSING
  const key = stringOf(project.key) ?? MISSING
  const createdAt = stringOf(manifest.createdAt) ?? MISSING
  return [
    `# 交接包 · ${name}`,
    '',
    `> 本交接包针对项目 \`${name}\`（project.key: \`${key}\`），生成于 \`${createdAt}\`；换项目需重新生成。`,
    '> 机器路径统一使用 `$WORKSPACE` / `$DSH_HOME` 令牌；manifest.json 与 SHA256SUMS 是权威数据源，HANDOFF.md 只是阅读入口。'
  ].join('\n')
}

function renderH0(manifest) {
  const project = objectOf(manifest.project)
  const generator = objectOf(manifest.generator)
  const session = isPlainObject(manifest.session) ? manifest.session : null
  const sandbox = isPlainObject(manifest.sandbox) ? manifest.sandbox : null
  const scan = objectOf(manifest.scan)
  const files = Array.isArray(manifest.files) ? manifest.files : []
  const lines = [sectionHeading('H0'), '']
  lines.push(`- 项目：\`${stringOf(project.name) ?? MISSING}\`（project.key: \`${stringOf(project.key) ?? MISSING}\`）`)
  lines.push(`- 工作区：${pathInline(project.workspace)}（token 化；实际盘符由调用方环境决定）`)
  lines.push(`- 批次：${codeInline(manifest.batchId)}`)
  lines.push(`- 生成时间：${codeInline(manifest.createdAt)}`)
  lines.push(`- 输出目标：${resolveTarget(manifest)}`)
  const lineage = isPlainObject(manifest.lineage) ? manifest.lineage : null
  if (lineage !== null) {
    const sequence = integerOf(lineage.sequence)
    const previous = stringOf(lineage.previous)
    const supersedes = stringOf(lineage.supersedes)
    if (sequence !== null && previous !== null) {
      lines.push(
        `- 批次血缘：第 ${sequence} 代，承接 ${codeInline(previous)}` +
          (supersedes === null ? '' : `（替代 ${codeInline(supersedes)}；旧批次保持只读）`)
      )
    }
  }
  const generatorName = stringOf(generator.name)
  lines.push(
    generatorName === null
      ? '- 生成器：未提供'
      : `- 生成器：${codeInline(generatorName)} ${stringOf(generator.version) ?? MISSING}` +
          `（DSH ${stringOf(generator.dshVersion) ?? MISSING}，平台 ${stringOf(generator.platform) ?? MISSING}）`
  )
  lines.push(
    session === null
      ? '- 会话：未提供'
      : `- 会话：${codeInline(session.id)}（agentPreset: ${stringOf(session.agentPreset) ?? MISSING}；cwd: ${pathInline(session.cwd)}）`
  )
  lines.push(
    sandbox === null
      ? '- 沙箱：未提供'
      : `- 沙箱：${codeInline(sandbox.mode)}（workspaceRoot: ${pathInline(sandbox.workspaceRoot)}）`
  )
  lines.push(
    `- 适用边界：只覆盖本批次采集到的 ${integerOf(scan.entries) ?? MISSING} 个条目 / ${files.length} 个证据文件；` +
      '未采集的路径、未运行的行为、未列出的结论都不在覆盖范围内（详见「覆盖说明」）。'
  )
  return lines.join('\n')
}

function renderH1(manifest) {
  const inputs = objectOf(manifest.inputs)
  const trace = objectOf(manifest.sessionTrace)
  const git = isPlainObject(manifest.git) ? manifest.git : null
  const lines = [sectionHeading('H1'), '']

  lines.push('### 目标', '', stringOf(inputs.goal) ?? MISSING_CALLER, '')
  lines.push('### 摘要', '', stringOf(inputs.summary) ?? MISSING_CALLER, '')

  lines.push('### 关键决策', '')
  const decisions = stringsOf(inputs.decisions)
  if (decisions.length === 0) lines.push(`- ${MISSING_CALLER}`)
  else for (const decision of decisions) lines.push(`- ${decision}`)
  lines.push('')

  lines.push('### 本会话改动（workspaceChanges，仅已完成 turn）', '')
  const changes = isPlainObject(manifest.changes) ? manifest.changes : null
  if (changes === null || changes.available !== true) {
    lines.push(
      `- ${MISSING}（${stringOf(changes?.note) ?? '本会话没有可用的 workspaceChanges 证据'}）`
    )
  } else {
    const totals = objectOf(changes.totals)
    lines.push(
      `- 已完成 turn 共 ${integerOf(totals.files) ?? 0} 个文件：` +
        `+${integerOf(totals.added) ?? 0} / −${integerOf(totals.deleted) ?? 0}` +
        `（binary ${integerOf(totals.binary) ?? 0}，oversized ${integerOf(totals.oversized) ?? 0}）`
    )
    const changed = (Array.isArray(changes.files) ? changes.files : [])
      .filter((entry) => isPlainObject(entry))
      .slice(0, 15)
    if (changed.length === 0) lines.push(`- ${MISSING}`)
    else {
      for (const file of changed) {
        lines.push(
          `- \`${stringOf(file.path) ?? MISSING}\`：+${integerOf(file.added) ?? 0} / −${integerOf(file.deleted) ?? 0}`
        )
      }
      if (changes.truncated === true) lines.push('- （改动文件列表已截断，完整上限见 manifest.limits / changes.note）')
    }
  }
  lines.push('')

  const currentTurn =
    changes !== null && isPlainObject(changes.currentTurn) ? changes.currentTurn : null
  if (currentTurn !== null && Array.isArray(currentTurn.files) && currentTurn.files.length > 0) {
    lines.push('#### 当前未完成 turn 的触碰（会话 tool/call，仅路径）', '')
    lines.push(
      `- ${stringOf(currentTurn.note) ?? '仅路径与计数'}（turn ${integerOf(currentTurn.turn) ?? MISSING}）`
    )
    for (const file of currentTurn.files.slice(0, 10)) {
      lines.push(
        `- \`${stringOf(file.path) ?? MISSING}\` — 工具：${codeInline(file.tool)}；` +
          `次数：${integerOf(file.count) ?? MISSING}；lastSeq：${integerOf(file.lastSeq) ?? MISSING}`
      )
    }
    lines.push('')
  }

  lines.push('### 会话触碰的文件（按 lastSeq 降序，最多 15 条）', '')
  const touchedFiles = Array.isArray(trace.touchedFiles)
    ? trace.touchedFiles.filter((entry) => isPlainObject(entry))
    : []
  const latestFirst = [...touchedFiles]
    .map((entry) => ({ entry, lastSeq: integerOf(entry.lastSeq) ?? 0 }))
    .sort((left, right) => right.lastSeq - left.lastSeq)
    .slice(0, 15)
  if (latestFirst.length === 0) lines.push(`- ${MISSING_CALLER}`)
  else {
    for (const { entry } of latestFirst) {
      lines.push(
        `- \`${stringOf(entry.path) ?? MISSING}\` — 工具：${codeInline(entry.tool)}；` +
          `次数：${integerOf(entry.count) ?? MISSING}；lastSeq：${integerOf(entry.lastSeq) ?? MISSING}`
      )
    }
  }
  lines.push('')

  lines.push('### 最近一次 git 提交', '')
  if (git !== null && isPlainObject(git.lastCommit)) {
    const commit = git.lastCommit
    lines.push(
      `- ${codeInline(commit.sha)}（${stringOf(commit.time) ?? MISSING}）：` +
        `${stringOf(commit.subject) ?? '（无提交标题）'}`
    )
  } else if (git !== null) {
    lines.push(`- ${MISSING}（未采集到提交详情；HEAD: ${codeInline(git.head)}）。`)
  } else {
    lines.push(`- ${MISSING}（未采集到 git 信息，原因见 H6 的 warnings）。`)
  }
  return lines.join('\n')
}

function renderH2(manifest) {
  const concepts = stringsOf(objectOf(manifest.inputs).concepts)
  const lines = [
    sectionHeading('H2'),
    '',
    '> 来源：调用方输入；缺失时为 P1 会话提取的占位，生成器不编造。',
    ''
  ]
  if (concepts.length === 0) lines.push(`- ${MISSING_CONCEPTS}`)
  else for (const concept of concepts) lines.push(`- ${concept}`)
  return lines.join('\n')
}

function renderH3(manifest) {
  const files = (Array.isArray(manifest.files) ? manifest.files : []).filter((entry) =>
    isPlainObject(entry)
  )
  const trace = objectOf(manifest.sessionTrace)
  const scan = objectOf(manifest.scan)
  const tree = Array.isArray(scan.tree) ? scan.tree.filter((entry) => isPlainObject(entry)) : []
  const lines = [
    sectionHeading('H3'),
    '',
    '> 只列实际采集到的路径；`sha256:<前 12 位>` 是文件内容证据哈希，完整值见 manifest.json / SHA256SUMS。',
    ''
  ]

  if (files.length === 0) {
    lines.push(`- ${MISSING_CODE_MAP}。`, '')
  } else {
    for (const role of ROLE_ORDER) {
      const group = files.filter((entry) => entry.role === role)
      if (group.length === 0) continue
      lines.push(`### ${ROLE_LABELS[role]}（${role}）`, '')
      for (const file of group) {
        const sha256 = stringOf(file.sha256)
        const shaText = sha256 === null ? `sha256:${MISSING}` : `sha256:\`${shortHash(sha256, 12)}\``
        let detail = `；${integerOf(file.bytes) ?? MISSING} bytes`
        if (file.truncated === true) detail += '；内容已截断'
        if (typeof file.skippedReason === 'string' && file.skippedReason !== '')
          detail += `；跳过原因：${file.skippedReason}`
        lines.push(`- \`${stringOf(file.path) ?? MISSING}\` — ${shaText}${detail}`)
      }
      lines.push('')
    }
  }

  lines.push('### 工作区顶层（scan.tree）', '')
  if (tree.length === 0) lines.push(`- ${MISSING}（未采集到顶层清单）。`)
  else {
    for (const entry of tree) {
      const bytes = integerOf(entry.bytes)
      lines.push(
        `- \`${stringOf(entry.name) ?? MISSING}\`（${stringOf(entry.type) ?? MISSING}` +
          `${bytes === null ? '' : `，${bytes} bytes`}）`
      )
    }
  }
  lines.push('')

  lines.push('### 会话触碰且已采集的路径', '')
  const collected = new Set(
    files.map((file) => stringOf(file.path)).filter((path) => path !== null)
  )
  const touchedFiles = Array.isArray(trace.touchedFiles)
    ? trace.touchedFiles.filter((entry) => isPlainObject(entry))
    : []
  const existing = [
    ...new Set(
      touchedFiles
        .map((entry) => stringOf(entry.path))
        .filter((path) => path !== null && collected.has(path))
    )
  ]
  if (existing.length === 0) lines.push('- 本次会话未触碰到已采集的路径。')
  else for (const path of existing) lines.push(`- \`${path}\``)
  return lines.join('\n')
}

/**
 * Build the H4 assertion list: four evidence labels plus explicit `[待验]`
 * items. Caller-provided narrative is labeled `[输入]` and never presented as
 * independently verified; anything the collector did not observe becomes
 * `[待验]` instead of an invented fact.
 * @param {Record<string, unknown>} manifest
 * @returns {Array<{label: string, text: string}>}
 */
function buildAssertions(manifest) {
  const scan = objectOf(manifest.scan)
  const files = (Array.isArray(manifest.files) ? manifest.files : []).filter((entry) =>
    isPlainObject(entry)
  )
  const git = isPlainObject(manifest.git) ? manifest.git : null
  const trace = objectOf(manifest.sessionTrace)
  const inputs = objectOf(manifest.inputs)
  const assertions = []

  const entries = integerOf(scan.entries)
  if (entries !== null) {
    assertions.push({
      label: '文件哈希',
      text:
        `本次工作区扫描访问 ${entries} 个条目（目录 ${integerOf(scan.dirs) ?? MISSING}），` +
        `证据文件 ${files.length} 个，累计哈希读取 ${integerOf(scan.readBytes) ?? 0} bytes。`
    })
  } else {
    assertions.push({ label: '待验', text: '工作区扫描条目数未提供，无法核对采集范围。' })
  }

  const changes = isPlainObject(manifest.changes) ? manifest.changes : null
  if (changes !== null && changes.available === true) {
    const totals = objectOf(changes.totals)
    assertions.push({
      label: '改动',
      text:
        `本会话已完成 turn 的 workspaceChanges：${integerOf(totals.files) ?? 0} 个文件，` +
        `+${integerOf(totals.added) ?? 0} / −${integerOf(totals.deleted) ?? 0}` +
        `${changes.truncated === true ? '（列表已截断）' : ''}；` +
        '来源为宿主 workspaceChanges 快照，只覆盖已完成 turn。'
    })
    const changed = (Array.isArray(changes.files) ? changes.files : [])
      .filter((entry) => isPlainObject(entry))
      .slice(0, 3)
    for (const file of changed) {
      assertions.push({
        label: '改动',
        text:
          `文件 \`${stringOf(file.path) ?? MISSING}\` 在已完成 turn 中 +${integerOf(file.added) ?? 0} / −${integerOf(file.deleted) ?? 0}` +
          `${file.binary === true ? '（binary）' : ''}${file.oversized === true ? '（oversized，未取全文）' : ''}。`
      })
    }
  } else {
    assertions.push({
      label: '待验',
      text: `本会话 workspaceChanges 不可用（${stringOf(changes?.note) ?? '原因见 H6 warnings'}），不产出“本会话改动”断言。`
    })
  }
  const currentTurn =
    changes !== null && isPlainObject(changes.currentTurn) ? changes.currentTurn : null
  if (currentTurn !== null && Array.isArray(currentTurn.files) && currentTurn.files.length > 0) {
    const sample = currentTurn.files
      .slice(0, 5)
      .map((file) => `\`${stringOf(file.path) ?? MISSING}\`（${stringOf(file.tool) ?? MISSING}×${integerOf(file.count) ?? 0}）`)
      .join('、')
    assertions.push({
      label: '改动',
      text:
        `当前未完成 turn（turn ${integerOf(currentTurn.turn) ?? MISSING}）的 file-tool 触碰 ` +
        `${currentTurn.files.length} 个路径：${sample}；` +
        '只有路径与计数（来自 tool/call 元数据），没有 added/deleted 行数。'
    })
  }

  const fuel = isPlainObject(manifest.fuel) ? manifest.fuel : null
  if (fuel !== null && isPlainObject(fuel.goals)) {
    if (fuel.goals.available === true && isPlainObject(fuel.goals.goal)) {
      const goal = fuel.goals.goal
      assertions.push({
        label: 'goal',
        text:
          `当前 goal \`${stringOf(goal.id) ?? MISSING}\`（${stringOf(goal.phase) ?? MISSING}，` +
          `rounds ${integerOf(goal.roundsStarted) ?? 0}/${integerOf(goal.maxGoalRounds) ?? 0}）：` +
          `${stringOf(goal.objective) ?? '（无 objective）'}`
      })
    } else if (fuel.goals.available === true) {
      assertions.push({
        label: 'goal',
        text: `当前会话没有 goal（goals 服务可用；${stringOf(fuel.goals.note) ?? '无'}）。`
      })
    } else {
      assertions.push({
        label: '待验',
        text: `goal 燃料不可用（${stringOf(fuel.goals.note) ?? '原因见 H6 warnings'}）。`
      })
    }
  }
  if (fuel !== null && isPlainObject(fuel.jobs)) {
    if (fuel.jobs.available === true) {
      const statusCounts = objectOf(fuel.jobs.statusCounts)
      const parts = Object.keys(statusCounts)
        .filter((status) => Number.isInteger(statusCounts[status]))
        .sort()
        .map((status) => `${status}=${statusCounts[status]}`)
      assertions.push({
        label: 'job',
        text:
          `后台 jobs：${integerOf(fuel.jobs.count) ?? 0} 个` +
          (parts.length > 0 ? `（${parts.join('、')}）` : '（无）') +
          '；只读快照，未执行任何 job。'
      })
    } else {
      assertions.push({
        label: '待验',
        text: `jobs 燃料不可用（${stringOf(fuel.jobs.note) ?? '原因见 H6 warnings'}）。`
      })
    }
  }

  const hashed = files.filter(
    (file) => typeof file.sha256 === 'string' && SHA256_RE.test(file.sha256)
  )
  for (const sample of hashed.slice(0, 3)) {
    assertions.push({
      label: '文件哈希',
      text: `证据文件 \`${stringOf(sample.path) ?? MISSING}\` 的 sha256 为 \`${sample.sha256}\`（完整值见 SHA256SUMS）。`
    })
  }

  if (git !== null && typeof git.head === 'string' && git.head !== '') {
    const branch =
      git.detached === true
        ? 'detached HEAD'
        : `分支 ${codeInline(git.branch)}`
    assertions.push({
      label: 'git',
      text: `HEAD 为 \`${git.head}\`（${branch}）；remote: ${codeInline(git.remote)}。`
    })
    if (isPlainObject(git.lastCommit)) {
      assertions.push({
        label: 'git',
        text:
          `最近提交 \`${stringOf(git.lastCommit.sha) ?? MISSING}\`（${stringOf(git.lastCommit.time) ?? MISSING}）：` +
          `${stringOf(git.lastCommit.subject) ?? '（无提交标题）'}`
      })
    }
  } else {
    assertions.push({ label: '待验', text: '未采集到 git 元数据（原因见 H6 的 warnings）。' })
  }

  const toolCalls = objectOf(trace.toolCalls)
  const totalCalls = integerOf(toolCalls.total)
  if (totalCalls !== null) {
    const eventCounts = objectOf(trace.eventCounts)
    assertions.push({
      label: '会话',
      text:
        `会话 \`${stringOf(trace.sessionId) ?? MISSING}\` 共 ${totalCalls} 次工具调用` +
        `（事件 ${integerOf(eventCounts.total) ?? 0}，工具错误 ${integerOf(eventCounts.toolErrors) ?? 0}）；` +
        '只统计 tool/call 元数据，不含消息正文。'
    })
    const byName = objectOf(toolCalls.byName)
    const names = Object.keys(byName)
      .filter((name) => Number.isInteger(byName[name]))
      .sort()
    if (names.length > 0) {
      assertions.push({
        label: '会话',
        text: `工具调用分布：${names.map((name) => `\`${name}\`=${byName[name]}`).join('、')}。`
      })
    }
  } else {
    assertions.push({ label: '待验', text: '会话工具调用计数未提供。' })
  }

  const summary = stringOf(inputs.summary)
  const decisions = stringsOf(inputs.decisions)
  if (summary !== null || decisions.length > 0) {
    assertions.push({
      label: '输入',
      text:
        `调用方提供了 ${summary !== null ? 1 : 0} 段摘要、${decisions.length} 条决策；` +
        '这些是调用方陈述，生成器未独立核验。'
    })
  } else {
    assertions.push({ label: '待验', text: '调用方未提供 summary / decisions。' })
  }

  assertions.push({
    label: '待验',
    text: '文档与代码的一致性未裁决：生成器只采集元数据与哈希，不判断业务语义。'
  })
  assertions.push({
    label: '待验',
    text: '未运行测试 / 构建 / 命令（工具只做只读采集）；本文档中不存在“已验证通过”的运行结论。'
  })
  if (files.length === 0) {
    assertions.push({ label: '待验', text: '本次未采集到可抽查的证据文件哈希。' })
  }
  return assertions
}

function renderH4(manifest, assertions) {
  const lines = [
    sectionHeading('H4'),
    '',
    '> 证据标签：`[文件哈希]`=本次对文件内容计算的 sha256；`[git]`=读取 `.git` 元数据；' +
      '`[会话]`=会话工具事件计数（不含消息正文）；`[改动]`=宿主 workspaceChanges 的已完成 turn 改动；' +
      '`[goal]`/`[job]`=goal 与后台 jobs 的只读快照；' +
      '`[输入]`=调用方陈述，生成器未独立核验；`[待验]`=本次未覆盖，需新会话按 H8 复核。',
    `> 核对时间：${codeInline(manifest.createdAt)}（读取与哈希均发生在该批次采集窗口内）。`,
    ''
  ]
  const factual = assertions.filter((assertion) => assertion.label !== '待验')
  if (factual.length === 0) lines.push(`- ${NO_ASSERTIONS}（manifest 未包含可核对的事实）。`)
  for (const assertion of assertions) lines.push(`- \`[${assertion.label}]\` ${assertion.text}`)
  return lines.join('\n')
}

function renderH5(manifest) {
  const flow = stringsOf(objectOf(manifest.inputs).flow)
  const lines = [sectionHeading('H5'), '']
  if (flow.length === 0) lines.push(`- ${MISSING}`)
  else for (const step of flow) lines.push(`- ${step}`)
  return lines.join('\n')
}

function renderH6(manifest) {
  const inputs = objectOf(manifest.inputs)
  const risks = stringsOf(inputs.risks)
  const warnings = (Array.isArray(manifest.warnings) ? manifest.warnings : []).filter((entry) =>
    isPlainObject(entry)
  )
  const lines = [sectionHeading('H6'), '']

  lines.push('### 调用方提供的未决与风险', '')
  if (risks.length === 0) lines.push(`- ${MISSING}`)
  else for (const risk of risks) lines.push(`- ${risk}`)
  lines.push('')

  lines.push(`### 生成器 warnings（${warnings.length} 条）`, '')
  if (warnings.length === 0) lines.push('- 无（本次采集未产生 warning）。')
  else {
    for (const warning of warnings) {
      const code = stringOf(warning.code) ?? MISSING
      const detail = stringOf(warning.detail)
      lines.push(detail === null ? `- \`${code}\`` : `- \`${code}\` ${detail}`)
    }
  }
  lines.push('')

  lines.push('### 已知限制（生成器如实声明）', '')
  lines.push('- 无 mtime：采集不产出“最近改动时间”，H1 以会话 trace 与 git reflog 替代。')
  lines.push('- 无 git status：不报告未提交 / 未跟踪改动；只读取 `.git` 元数据。')
  lines.push(
    '- workspaceChanges 只覆盖**已完成 turn**：create 发生在 turn 中时，当前 turn 的改动尚未记录；' +
      'H1 用会话 `tool/call` 的「当前未完成 turn 的触碰」补充路径与计数（无行数统计）；' +
      'Session 结束后宿主不再提供 summary（新会话只能读包内证据，不能回读旧 Session 的改动）。'
  )
  lines.push('- 无删除原语：写入失败时不做清理，可能留下不完整批次（以 manifest.json 是否存在判断完成）。')
  lines.push(
    '- 不执行代码：不运行测试 / 构建 / 命令；H4 中未标注 `[文件哈希]` / `[git]` / `[会话]` / `[输入]` 的断言不可当作已验证。'
  )
  return lines.join('\n')
}

function renderH7(manifest) {
  const files = (Array.isArray(manifest.files) ? manifest.files : []).filter((entry) =>
    isPlainObject(entry)
  )
  const scan = objectOf(manifest.scan)
  const tree = Array.isArray(scan.tree) ? scan.tree.filter((entry) => isPlainObject(entry)) : []
  const hasAgents =
    files.some((file) => stringOf(file.path) === 'AGENTS.md') ||
    tree.some((entry) => stringOf(entry.name) === 'AGENTS.md')
  const lines = [sectionHeading('H7'), '']
  if (hasAgents) {
    lines.push('- 协作入口：`$WORKSPACE/AGENTS.md`（本次采集已发现，先读它再动代码）。')
  } else {
    lines.push(
      '- 协作入口：本次采集范围内未发现 AGENTS.md；请先向用户确认协作规范，不要自行假定。'
    )
  }
  lines.push('- 先问后答：需求或约束不明确时先提问，不臆测、不扩大改动范围。')
  lines.push('- 不擅自改代码：任何写操作先说明计划与影响，取得用户确认后再执行。')
  lines.push('- 结论与证据分开：区分事实、推断与待验，结论必须附证据或标注 `[待验]`。')
  return lines.join('\n')
}

function renderH8(manifest) {
  const batchId = stringOf(manifest.batchId) ?? MISSING
  const files = (Array.isArray(manifest.files) ? manifest.files : []).filter((entry) =>
    isPlainObject(entry)
  )
  const hashed = files.filter(
    (file) => typeof file.sha256 === 'string' && SHA256_RE.test(file.sha256)
  )
  const samples = hashed.slice(0, 3)
  const lines = [sectionHeading('H8'), '']
  lines.push(
    `1. 先运行 \`handoff_load batchId=${batchId}\`（缺省=最新批次；内部 verify + trust 判定）；` +
      '只有 trust=verified 才继续，stale/invalid 先看 findings。' +
      `需要纯哈希校验时运行 \`handoff_pack verify batchId=${batchId}\`。`
  )
  lines.push('2. 按 H2 → H3 → H4 → H8 顺序阅读：先建立概念与代码地图，再核对事实。')
  lines.push('3. 抽查至少 3 条 H4 断言的文件哈希（先把 `$WORKSPACE` 替换为实际工作区绝对路径再执行）：')
  lines.push(
    '   - PowerShell：`Get-FileHash -Algorithm SHA256 -LiteralPath "$WORKSPACE/<relative-path>" | Select-Object -ExpandProperty Hash`'
  )
  lines.push('   - POSIX：`sha256sum "$WORKSPACE/<relative-path>"`')
  if (samples.length > 0) {
    lines.push('   - 可从以下证据文件开始（前 12 位期望值见 H3，完整值见 SHA256SUMS）：')
    for (const file of samples) {
      lines.push(`     - \`${stringOf(file.path) ?? MISSING}\` → \`${shortHash(file.sha256, 12)}\``)
    }
  } else {
    lines.push('   - 本次 manifest 未包含可抽查的文件哈希；此时以 verify 报告的 artifacts 哈希为准。')
  }
  lines.push('4. 发现漂移时按以下格式报告：')
  lines.push('   - 断言：<引用的 H4 断言或文件路径>')
  lines.push('   - 期望：<HANDOFF / manifest 中记录的值>')
  lines.push('   - 实际：<本次复算 / 读取得到的值>')
  lines.push('   - 结论：<一致 / 漂移 / 无法判定（说明原因）>')
  return lines.join('\n')
}

function renderH9() {
  return [
    sectionHeading('H9'),
    '',
    '- 不得宣称“已验证 / 已通过”但本次没有实际运行验证命令。',
    '- 不得用文档或旧交接包覆盖当前代码事实；代码与文档冲突时列差异，不裁决。',
    '- 不得省略 `[待验]` 项，也不得把推断 / 文档陈述写成事实。',
    '- 不得擅自改代码、重启服务、改数据库、commit / push；需要时先取得用户确认。'
  ].join('\n')
}

function renderCoverage(manifest, assertions) {
  const scan = objectOf(manifest.scan)
  const project = objectOf(manifest.project)
  const git = isPlainObject(manifest.git) ? manifest.git : null
  const files = (Array.isArray(manifest.files) ? manifest.files : []).filter((entry) =>
    isPlainObject(entry)
  )
  const warnings = Array.isArray(manifest.warnings) ? manifest.warnings : []
  const limits = isPlainObject(manifest.limits) ? manifest.limits : publicLimits()
  const reflog = git !== null && Array.isArray(git.reflog) ? git.reflog : []
  const gitCoverage =
    git === null
      ? 'git 元数据（未采集，见 H6 的 warnings）'
      : `git 元数据（HEAD / 分支 / 远端 / 最近提交 / reflog ${reflog.length} 条）`
  const pending = assertions.filter((assertion) => assertion.label === '待验').length
  const lines = [sectionHeading('覆盖说明'), '']
  lines.push(
    `- 扫描范围：工作区 ${pathInline(project.workspace)}；访问 ${integerOf(scan.entries) ?? MISSING} 个条目` +
      `（目录 ${integerOf(scan.dirs) ?? MISSING}），证据文件 ${files.length} 个，` +
      `累计哈希读取 ${integerOf(scan.readBytes) ?? MISSING} bytes。`
  )
  lines.push(
    `- 已采集：manifest.files 中的证据文件哈希与字节数；${gitCoverage}；` +
      `会话工具事件计数（不含消息正文）；warnings ${warnings.length} 条。`
  )
  lines.push(
    `- 未扫描：denylist 路径（.env*、*.pem、*.key、id_rsa*、*.p12、*.pfx、含 credential 的文件、*.db、*.sqlite*、` +
      `node_modules/、.venv/、.git/、.dsh/）；symlink 跳过 ${integerOf(scan.symlinksSkipped) ?? MISSING} 个；` +
      `受上限（maxEntries=${integerOf(limits.maxEntries) ?? MISSING}、maxDepth=${integerOf(limits.maxDepth) ?? MISSING}、` +
      `maxHashFiles=${integerOf(limits.maxHashFiles) ?? MISSING}、maxFileBytes=${integerOf(limits.maxFileBytes) ?? MISSING}）` +
      '而未纳入的条目。'
  )
  lines.push('- 无 mtime：不提供“最近改动时间”；替代证据是会话 trace 与 git reflog。')
  lines.push('- 无 git status：不报告未提交 / 未跟踪改动；只读取 `.git` 元数据。')
  lines.push(
    `- 待验：H4 中 ${pending} 条 \`[待验]\` 项需新会话按 H8 复核；未运行的测试 / 命令不在已验证范围内。`
  )
  return lines.join('\n')
}

/* ─────────────────────────────── public API ──────────────────────────────── */

/**
 * Render HANDOFF.md from a manifest.
 *
 * Deterministic: the same manifest always renders the exact same bytes. No
 * clock, randomness, filesystem or network is consulted; all content comes from
 * `manifest` and all paths are the manifest's tokenized forms. Missing caller
 * input is rendered as `未提供` / `调用方未提供，待补（生成器不编造）`.
 *
 * The output covers H0–H9 plus a closing coverage note, uses LF line endings and
 * ends with exactly one newline.
 *
 * @param {Record<string, unknown>} manifest canonical manifest (see `manifest.js`).
 * @returns {string} HANDOFF.md text (UTF-8).
 * @throws {Error & {code: string}} `HANDOFF_INVALID_ARGS` when not an object.
 */
export function renderHandoff(manifest) {
  if (!isPlainObject(manifest))
    throw handoffError(ERROR.INVALID_ARGS, 'renderHandoff expects a manifest object')
  const assertions = buildAssertions(manifest)
  const sections = [
    renderIntro(manifest),
    renderH0(manifest),
    renderH1(manifest),
    renderH2(manifest),
    renderH3(manifest),
    renderH4(manifest, assertions),
    renderH5(manifest),
    renderH6(manifest),
    renderH7(manifest),
    renderH8(manifest),
    renderH9(manifest),
    renderCoverage(manifest, assertions)
  ]
  return `${sections.join('\n\n')}\n`
}
