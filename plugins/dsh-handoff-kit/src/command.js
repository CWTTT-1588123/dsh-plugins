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
  validateToolArgs
} from './contracts.js'

/** Input hint shown by the slash-command palette. */
export const COMMAND_DESCRIPTION = '生成/校验会话交接包（HANDOFF.md + manifest.json）'
export const COMMAND_HINT =
  '[create|scan|verify|list] [--target user|workspace] [--title TEXT] [--batch ID] [--force]'

/** Tokenize a command line, honoring double quotes. */
function tokenize(rawInput) {
  const matches = String(rawInput ?? '').match(/(?:[^\s"]+|"[^"]*")+/g) ?? []
  return matches.map((token) => token.replace(/^"|"$/g, ''))
}

/** Flags that take a value. */
const VALUED_FLAGS = new Map([
  ['--target', 'target'],
  ['--title', 'title'],
  ['--batch', 'batchId']
])
/** Boolean flags. */
const FLAGS = new Map([
  ['--force', 'force'],
  ['--all', 'all'],
  ['--copy-files', 'copyFiles']
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
    if (ACTIONS.includes(first)) action = first
    else if (!first.startsWith('-')) {
      raw.batchId = first
      action = 'verify'
    }
  }
  if (positional.length > 0) {
    if (action === 'verify' && raw.batchId === undefined) raw.batchId = positional.shift()
    if (positional.length > 0)
      throw handoffError(ERROR.INVALID_ARGS, `多余的参数：${positional.join(' ')}`)
  }
  raw.action = action ?? 'create'
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
    case 'create': {
      const handoff = Array.isArray(result.artifacts)
        ? result.artifacts.find((artifact) => artifact.path === 'HANDOFF.md')
        : undefined
      const hash = handoff?.sha256 === undefined ? '' : `HANDOFF.md sha256 ${handoff.sha256.slice(0, 12)}… · `
      return (
        `交接包已生成：${result.displayDir ?? result.dir}\n` +
        `${hash}${result.artifacts?.length ?? 0} 个产物 / ${result.totals?.artifactBytes ?? 0} 字节，` +
        `${warnings} 个 warning。\n` +
        `下一步：新会话先运行 handoff_pack action=verify batchId=${result.batchId}，再读 HANDOFF.md。\n` +
        `提示：${result.next?.[0] ?? 'read HANDOFF.md'}`
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

/**
 * Build the registry-ready command definition.
 * @param {{run: Function}} service
 */
export function createCommand(service) {
  return {
    name: COMMAND_NAME,
    description: COMMAND_DESCRIPTION,
    input: { hint: COMMAND_HINT },
    async handler(invocation) {
      try {
        const raw = parseCommandInput(invocation.rawInput)
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
