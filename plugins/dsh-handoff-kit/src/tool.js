/**
 * `handoff_pack` tool definition.
 *
 * The harness registers raw JSON Schema tools without validating their
 * arguments (only `output.schema` is checked at registration), so `execute`
 * validates the call itself through `validateToolArgs`. Failures throw a
 * `HandoffError` whose message is prefixed with the machine error code: the
 * registry keeps structured `{name, code}` only for its own `HarnessError`
 * class, which a zero-dependency plugin must not import.
 *
 * @module dsh-handoff-kit/tool
 */

import {
  LOAD_ARGUMENTS_SCHEMA,
  LOAD_OUTPUT_SCHEMA,
  LOAD_TOOL_DESCRIPTION,
  LOAD_TOOL_NAME,
  LOAD_TOOL_TIMEOUT_MS,
  TOOL_ARGUMENTS_SCHEMA,
  TOOL_DESCRIPTION,
  TOOL_NAME,
  TOOL_OUTPUT_SCHEMA,
  TOOL_TIMEOUT_MS,
  validateLoadArgs,
  validateToolArgs
} from './contracts.js'

/**
 * One to three lines the model sees for a settled call.
 * @param {Record<string, any>} value canonical service result.
 * @returns {string[]}
 */
export function summarizeResult(value) {
  if (value === null || typeof value !== 'object') return ['handoff_pack completed']
  const warnings = Array.isArray(value.warnings) ? value.warnings.length : 0
  const lines = []
  switch (value.action) {
    case 'scan':
      lines.push(
        `scan: ${value.scan?.entries ?? 0} entries, ${value.scan?.files?.length ?? 0} evidence files, ` +
          `preview only (nothing written)`
      )
      break
    case 'create':
    case 'append':
    case 'update':
      lines.push(
        `${value.action === 'create' ? 'created' : value.action === 'append' ? 'appended' : 'updated (supersedes)'} ` +
          `${value.batchId ?? 'batch'} at ${value.displayDir ?? value.dir ?? '(unknown dir)'} ` +
          `(${value.artifacts?.length ?? 0} artifacts, ${value.totals?.artifactBytes ?? 0} bytes)`
      )
      if (value.lineage !== undefined)
        lines.push(
          `lineage: sequence ${value.lineage.sequence}, previous ${value.lineage.previous}` +
            (value.lineage.supersedes === undefined ? '' : `, supersedes ${value.lineage.supersedes}`)
        )
      lines.push(`verify with handoff_pack action=verify batchId=${value.batchId ?? ''}`)
      break
    case 'verify':
      lines.push(
        `verify ${value.verification?.batchId ?? value.batchId ?? ''}: ` +
          `${value.verification?.ok === true ? 'ok' : 'FAILED'} ` +
          `(${value.verification?.counts?.errors ?? 0} errors, ${value.verification?.counts?.warnings ?? 0} warnings)`
      )
      break
    case 'list':
      lines.push(`list: ${value.batches?.length ?? 0} batch(es)`)
      break
    default:
      lines.push('handoff_pack completed')
  }
  if (warnings > 0) lines.push(`${warnings} warning(s) recorded in the result`)
  return lines.slice(0, 3)
}

/**
 * Build the registry-ready tool definition.
 * @param {{run: (args: Record<string, unknown>, exec: {agent?: unknown, signal?: AbortSignal}) => Promise<Record<string, any>>}} service
 */
export function createTool(service) {
  return {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: TOOL_ARGUMENTS_SCHEMA,
    output: {
      schema: TOOL_OUTPUT_SCHEMA,
      render(_args, value) {
        return [{ type: 'text', text: summarizeResult(value).join('\n') }]
      }
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    // Reads may run together; batch-writing actions are exclusive.
    isConcurrencySafe(args) {
      return !['create', 'append', 'update'].includes(args?.action)
    },
    async execute(rawArgs, exec) {
      const args = validateToolArgs(rawArgs)
      return service.run(args, { agent: exec?.agent, signal: exec?.signal })
    }
  }
}

/** One to three lines the model sees for a settled `handoff_load` call. */
export function summarizeLoadResult(value) {
  if (value === null || typeof value !== 'object') return ['handoff_load completed']
  const verification = value.verification
  const counts =
    verification === undefined || verification === null
      ? 'verification skipped'
      : `${verification.counts.errors} errors, ${verification.counts.warnings} warnings`
  const lines = [`load ${value.batchId ?? ''}: trust=${value.trust ?? 'unknown'} (${counts})`]
  if (typeof value.handoff?.path === 'string') lines.push(`handoff: ${value.handoff.path}`)
  const next = Array.isArray(value.next) ? value.next[0] : undefined
  if (typeof next === 'string') lines.push(`next: ${next}`)
  return lines.slice(0, 3)
}

/**
 * Build the registry-ready `handoff_load` tool definition (read-only).
 * @param {{load: Function}} service
 */
export function createLoadTool(service) {
  return {
    name: LOAD_TOOL_NAME,
    description: LOAD_TOOL_DESCRIPTION,
    parameters: LOAD_ARGUMENTS_SCHEMA,
    output: {
      schema: LOAD_OUTPUT_SCHEMA,
      render(_args, value) {
        return [{ type: 'text', text: summarizeLoadResult(value).join('\n') }]
      }
    },
    timeoutMs: LOAD_TOOL_TIMEOUT_MS,
    isConcurrencySafe() {
      return true
    },
    async execute(rawArgs, exec) {
      const args = validateLoadArgs(rawArgs)
      return service.load(args, { agent: exec?.agent, signal: exec?.signal })
    }
  }
}
