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
  TOOL_ARGUMENTS_SCHEMA,
  TOOL_DESCRIPTION,
  TOOL_NAME,
  TOOL_OUTPUT_SCHEMA,
  TOOL_TIMEOUT_MS,
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
      lines.push(
        `created ${value.batchId ?? 'batch'} at ${value.displayDir ?? value.dir ?? '(unknown dir)'} ` +
          `(${value.artifacts?.length ?? 0} artifacts, ${value.totals?.artifactBytes ?? 0} bytes)`
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
    // Reads may run together; `create` writes one batch directory, so it stays exclusive.
    isConcurrencySafe(args) {
      return args?.action !== 'create'
    },
    async execute(rawArgs, exec) {
      const args = validateToolArgs(rawArgs)
      return service.run(args, { agent: exec?.agent, signal: exec?.signal })
    }
  }
}
