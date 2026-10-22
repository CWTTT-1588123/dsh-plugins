/**
 * `/handoff` human command: direct UI handler, never a model message.
 *
 * Chinese output (ADR decision 10); the tool description stays English.
 *
 * @module dsh-handoff-kit/command
 */

import {
  ACTIONS,
  COMMAND_NAME,
  ERROR,
  TOOL_NAME,
  errorCodeOf,
  errorMessageOf,
  handoffError,
  validateLoadArgs,
  validateToolArgs
} from './contracts.js'

/** Input hint shown by the slash-command palette. */
export const COMMAND_DESCRIPTION = '生成/校验/消费会话交接包（HANDOFF.md + manifest.json）'
export const COMMAND_HINT =
  '[create|append|update|scan|verify|list|migrate|resume] [--target user|workspace] [--title TEXT] [--batch ID] [--previous ID] [--supersedes ID] [--force] [--include-diffs] [--include summary|sections|full] [--no-verify]'

/** Command-only actions on top of the tool actions. */
const COMMAND_ACTIONS = [...ACTIONS, 'resume']

/** Tokenize a command line, honoring double quotes. */
function tokenize(rawInput) {
  const matches = String(rawInput ?? '').match(/(?:[^\s"]+|"[^"]*")+/g) ?? []
  return matches.map((token) => token.replace(/^"|"$/g, ''))
}

/** Flags that take a value. */
const VALUED_FLAGS = new Map([
  ['--target', 'target'],
  ['--title', 'title'],
  ['--batch', 'batchId'],
  ['--include', 'include'],
  ['--previous', 'previousBatchId'],
  ['--supersedes', 'supersedes']
])
/** Boolean flags. */
const FLAGS = new Map([
  ['--force', 'force'],
  ['--all', 'all'],
  ['--copy-files', 'copyFiles'],
  ['--include-diffs', 'includeDiffs'],
  ['--no-verify', 'noVerify']
])

/**
 * Parse `/handoff ...` input into raw tool arguments.
 * @param {string} rawInput
 * @returns {Record<string, unknown>} raw arguments for {@link validateToolArgs}.
 * @throws {Error & {code: string}} `HANDOFF_INVALID_ARGS`.
 */
export function parseCommandInput(rawInput) {
  const tokens = tokenize(rawInput)
  const raw = {}
  let action
  const positional = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (VALUED_FLAGS.has(token)) {
      const key = VALUED_FLAGS.get(token)
      const value = tokens[index + 1]
      if (value === undefined) throw handoffError(ERROR.INVALID_ARGS, `${token} 需要一个值`)
      raw[key] = value
      index += 1
      continue
    }
    if (FLAGS.has(token)) {
      raw[FLAGS.get(token)] = true
      continue
    }
    if (token.startsWith('--'))
      throw handoffError(ERROR.INVALID_ARGS, `未知选项 ${token}；可用：--target --title --batch --force --all --copy-files`)
    positional.push(token)
  }
  if (positional.length > 0) {
    const first = positional.shift()
    if (COMMAND_ACTIONS.includes(first)) action = first
    else if (!first.startsWith('-')) {
      raw.batchId = first
      action = 'verify'
    }
  }
  if (positional.length > 0) {
    if ((action === 'verify' || action === 'resume' || action === 'migrate') && raw.batchId === undefined)
      raw.batchId = positional.shift()
    if (positional.length > 0)
      throw handoffError(ERROR.INVALID_ARGS, `多余的参数：${positional.join(' ')}`)
  }
  raw.action = action ?? 'create'
  if (raw.action === 'resume') {
    if (raw.title !== undefined || raw.force !== undefined || raw.all !== undefined || raw.copyFiles !== undefined)
      throw handoffError(ERROR.INVALID_ARGS, '--title/--force/--all/--copy-files 不适用于 resume')
    if (raw.noVerify === true) raw.verifyFirst = false
    delete raw.noVerify
  } else if (raw.include !== undefined) {
    throw handoffError(ERROR.INVALID_ARGS, '--include 仅适用于 resume')
  } else if (raw.noVerify !== undefined) {
    throw handoffError(ERROR.INVALID_ARGS, '--no-verify 仅适用于 resume')
  }
  return raw
}

/**
 * Render a canonical result as the Chinese command text.
 * @param {Record<string, any>} result
 * @returns {string}
 */
export function formatResult(result) {
  const warnings = Array.isArray(result.warnings) ? result.warnings.length : 0
  switch (result.action) {
    case 'scan': {
      const preview = String(result.preview?.text ?? '').split('\n').slice(0, 6).join('\n')
      return (
        `扫描完成（未写盘）：${result.scan?.entries ?? 0} 个条目，` +
        `${result.scan?.files?.length ?? 0} 个证据文件，${warnings} 个 warning。\n` +
        `预览前几行：\n${preview}\n` +
        `下一步：/handoff create --title "..." 生成正式批次。`
      )
    }
    case 'create':
    case 'append':
    case 'update': {
      const handoff = Array.isArray(result.artifacts)
        ? result.artifacts.find((artifact) => artifact.path === 'HANDOFF.md')
        : undefined
      const hash = handoff?.sha256 === undefined ? '' : `HANDOFF.md sha256 ${handoff.sha256.slice(0, 12)}… · `
      const lineage =
        result.lineage === undefined
          ? ''
          : `血缘：第 ${result.lineage.sequence} 代，承接 ${result.lineage.previous}` +
            (result.lineage.supersedes === undefined ? '' : `（替代 ${result.lineage.supersedes}）`) +
            '。\n'
      const changes =
        result.changes === undefined
          ? ''
          : `本会话改动（已完成 turn）：${result.changes.totals?.files ?? 0} 个文件 ` +
            `(+${result.changes.totals?.added ?? 0} / −${result.changes.totals?.deleted ?? 0})` +
            `${result.changes.available === true ? '' : '（不可用，见 warnings）'}。\n`
      return (
        `${result.action === 'create' ? '交接包已生成' : result.action === 'append' ? '交接包已追加（append）' : '交接包已更新（update，supersede）'}：${result.displayDir ?? result.dir}\n` +
        lineage +
        changes +
        `${hash}${result.artifacts?.length ?? 0} 个产物 / ${result.totals?.artifactBytes ?? 0} 字节，` +
        `${warnings} 个 warning。\n` +
        `下一步：新会话先运行 handoff_load batchId=${result.batchId}，再读 HANDOFF.md。`
      )
    }
    case 'verify': {
      const verification = result.verification ?? {}
      const problems = (verification.findings ?? [])
        .filter((finding) => finding.severity === 'error')
        .slice(0, 5)
        .map((finding) => `${finding.code}${finding.path === undefined ? '' : ` (${finding.path})`}`)
      return (
        `校验 ${verification.batchId ?? result.batchId ?? ''}：` +
        `${verification.ok === true ? '通过' : '失败'}；` +
        `${verification.counts?.errors ?? 0} errors / ${verification.counts?.warnings ?? 0} warnings。\n` +
        (problems.length > 0 ? `错误：${problems.join('；')}\n` : '') +
        `目录：${result.displayDir ?? result.dir}`
      )
    }
    case 'list': {
      const batches = Array.isArray(result.batches) ? result.batches : []
      const rows = batches
        .slice(0, 8)
        .map((batch) => `- ${batch.batchId} ${batch.complete ? '' : '（不完整）'}${batch.title === null || batch.title === undefined ? '' : ` ${batch.title}`}`)
        .join('\n')
      return `交接批次 ${batches.length} 个：\n${rows === '' ? '（无）' : rows}`
    }
    case 'migrate': {
      const sourceSums = typeof result.migration?.sourceSha256Sums === 'string'
        ? `${result.migration.sourceSha256Sums.slice(0, 12)}…`
        : '(unknown)'
      return (
        `交接包已迁移（schemaVersion ${result.migration?.fromSchemaVersion ?? '?'} → 2）：` +
        `源 ${result.migration?.fromBatchId ?? '?'} → 新批次 ${result.batchId}\n` +
        `目录：${result.displayDir ?? result.dir}\n` +
        `源 SHA256SUMS 哈希：${sourceSums}（源批次未被修改）；${result.artifacts?.length ?? 0} 个产物。\n` +
        `下一步：handoff_load batchId=${result.batchId} 复核新批次。`
      )
    }
    default:
      return `handoff_pack ${String(result.action)} 完成。`
  }
}

/** Remedy text per error code, shown by the command (never thrown). */
const REMEDIES = {
  [ERROR.INVALID_ARGS]: `用法：/handoff ${COMMAND_HINT}`,
  [ERROR.READ_ONLY]: '当前会话是 read-only：切到 danger-full-access（target=user），或用 workspace-write + target=workspace 降级。',
  [ERROR.SANDBOX_DENIED]: '当前会话不能写用户目录：切到 danger-full-access（target=user），或改用 target=workspace 做工作区级降级。',
  [ERROR.PATH_ESCAPE]: '只接受工作区内相对路径：不能含 ..、盘符、UNC 或经 symlink 逃逸。',
  [ERROR.BATCH_EXISTS]: '该批次已存在：换一个批次（重跑 create）或加 --force 覆盖。',
  [ERROR.BATCH_NOT_FOUND]: '找不到批次：先 /handoff list 查看 batchId，再 /handoff verify <batchId>。',
  [ERROR.RESUME_NOT_FOUND]: '找不到可加载的批次：先 /handoff list（或 handoff_pack action=list）确认 batchId/target；必要时先 create。',
  [ERROR.APPEND_TARGET_MISSING]: 'append/update 的目标批次不存在或不可读：先 /handoff list 确认，或先 create 第一版；可用 --previous/--supersedes 显式指定。',
  [ERROR.LINEAGE_CYCLE]: '血缘目标非法（批次不能 append/update 到自身或形成环）：换一个目标批次。',
  [ERROR.MIGRATION_SOURCE_INVALID]: '源批次校验未通过（存在 error）：不能迁移不可信的包；先修复或重新生成源批次。',
  [ERROR.MIGRATION_UNSUPPORTED_VERSION]: '迁移只支持 schemaVersion 1 → 2：确认源批次版本（已是 2 的批次无需迁移）。',
  [ERROR.MANIFEST_MISSING]: '批次缺少 manifest.json（不完整）：不要采信；可重跑 create --force。',
  [ERROR.MANIFEST_INVALID]: 'manifest.json 无法解析/校验：批次已损坏，不要采信；重新生成。',
  [ERROR.SECRET_CHECK_FAILED]: '终检发现密钥残留：整批已放弃写入，请缩小 files 范围或先清理敏感内容。',
  [ERROR.WRITE_FAILED]: '写入失败：查看错误详情；已写入文件保留（无删除 API），可用 --force 重试。',
  [ERROR.READ_FAILED]: '读取失败：确认工作区路径可读且未被删除。',
  [ERROR.INTERNAL]: '内部错误：保留完整错误信息并报告给插件维护者。'
}

/**
 * Render a thrown failure as the Chinese command error text.
 * @param {unknown} error
 * @returns {string}
 */
export function formatError(error) {
  const code = errorCodeOf(error)
  const message = errorMessageOf(error)
  const remedy = REMEDIES[code] ?? REMEDIES[ERROR.INTERNAL]
  return `[${code}] ${message}\n修法：${remedy}`
}

/** Chinese labels for the `handoff_load` trust verdict. */
const TRUST_LABELS = {
  verified: '可信（校验通过，0 error / 0 warning）',
  stale: '需复核（已漂移或有 warning）',
  invalid: '不可信（校验存在 error）'
}

/**
 * Render a `handoff_load` result as the Chinese command text.
 * @param {Record<string, any>} result
 * @returns {string}
 */
export function formatLoadResult(result) {
  const label = TRUST_LABELS[result.trust] ?? String(result.trust)
  const verification = result.verification
  const counts =
    verification === undefined || verification === null
      ? '未校验（--no-verify）'
      : `${verification.counts.errors} errors / ${verification.counts.warnings} warnings`
  const findings = (verification?.findings ?? [])
    .slice(0, 4)
    .map((finding) => `${finding.severity === 'error' ? '✗' : '!'} ${finding.code}${finding.path === undefined ? '' : ` (${finding.path})`}`)
    .join('；')
  const next = (result.next ?? []).slice(0, 2).join('\n- ')
  return (
    `交接包 ${result.batchId}：${label}；${counts}。\n` +
    `目录：${result.displayDir}\n` +
    (findings === '' ? '' : `发现：${findings}\n`) +
    `HANDOFF：${result.handoff?.path ?? '(missing)'}\n` +
    (next === '' ? '' : `下一步：- ${next}`)
  )
}

/**
 * Build the registry-ready command definition.
 * @param {{run: Function, load: Function}} service
 */
export function createCommand(service) {
  return {
    name: COMMAND_NAME,
    description: COMMAND_DESCRIPTION,
    input: { hint: COMMAND_HINT },
    async handler(invocation) {
      try {
        const raw = parseCommandInput(invocation.rawInput)
        if (raw.action === 'resume') {
          const loadArgs = validateLoadArgs({
            batchId: raw.batchId,
            target: raw.target,
            verifyFirst: raw.verifyFirst,
            include: raw.include
          })
          const result = await service.load(loadArgs, {
            agent: invocation.agent,
            signal: invocation.signal
          })
          return { kind: 'success', text: formatLoadResult(result) }
        }
        const args = validateToolArgs(raw)
        const result = await service.run(args, {
          agent: invocation.agent,
          signal: invocation.signal
        })
        return { kind: 'success', text: formatResult(result) }
      } catch (error) {
        return { kind: 'error', text: formatError(error) }
      }
    }
  }
}
