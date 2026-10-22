/**
 * Shared contracts for dsh-handoff-kit.
 *
 * This module is the single source of truth for the model-facing tool schema,
 * the canonical result schema, every numeric bound, every error code, and the
 * argument self-validation the raw-JSON-Schema tool must perform itself.
 *
 * Constraints (P0): no `@deepseek-ai/*` imports, no runtime dependencies, no
 * network, no subprocesses, no LLM calls, and no environment-secret reads.
 *
 * @module dsh-handoff-kit/contracts
 */

/** Package name; also the Cordis plugin name. */
export const PLUGIN_NAME = 'dsh-handoff-kit'
/** One semantic version for the generator, mirrored in package.json. */
export const PLUGIN_VERSION = '0.1.0'
/** Manifest schema version owned by this generator. */
export const SCHEMA_VERSION = 1
/** `schema` identifier written into every manifest. */
export const SCHEMA_ID = 'dsh-handoff-kit/handoff'
/** Model-facing tool name. */
export const TOOL_NAME = 'handoff_pack'
/** Human command name (without the leading slash). */
export const COMMAND_NAME = 'handoff'
/** Bundled skill name. */
export const SKILL_NAME = 'handoff-pack'

/** Fixed artifact file names inside one batch directory. */
export const HANDOFF_FILE = 'HANDOFF.md'
export const SUMS_FILE = 'SHA256SUMS'
export const MANIFEST_FILE = 'manifest.json'
export const EVIDENCE_DIR = 'evidence'
export const EVIDENCE_FILES_DIR = 'evidence/files'

/** The four tool actions, in a stable order. */
export const ACTIONS = Object.freeze(['scan', 'create', 'verify', 'list'])
/** Output targets. `user` is the default; `workspace` is the explicit downgrade. */
export const TARGETS = Object.freeze(['user', 'workspace'])
/** Target directory suffixes under each root. */
export const HANDOFF_SUBDIR = 'handoff'
export const WORKSPACE_HANDOFF_SUBDIR = '.dsh/handoff'

/** Batch ids are fixed width so lexicographic order equals time order. */
export const BATCH_ID_RE = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{4}$/
/** A git object id as parsed from a loose ref / reflog / packed-refs line. */
export const GIT_SHA_RE = /^[0-9a-f]{40}$/

/** Session sandbox modes understood by the tool layer. */
export const SANDBOX_MODES = Object.freeze(['read-only', 'workspace-write', 'danger-full-access'])

/**
 * Structured error codes. Every thrown failure in this package is a
 * `HandoffError` carrying one of these codes; the message is prefixed with the
 * code because the tool registry only preserves structured `{name, code}` for
 * its own `HarnessError` class, which a zero-dependency plugin must not import.
 */
export const ERROR = Object.freeze({
  INVALID_ARGS: 'HANDOFF_INVALID_ARGS',
  READ_ONLY: 'HANDOFF_READ_ONLY',
  SANDBOX_DENIED: 'HANDOFF_SANDBOX_DENIED',
  PATH_ESCAPE: 'HANDOFF_PATH_ESCAPE',
  BATCH_EXISTS: 'HANDOFF_BATCH_EXISTS',
  BATCH_NOT_FOUND: 'HANDOFF_BATCH_NOT_FOUND',
  MANIFEST_MISSING: 'HANDOFF_MANIFEST_MISSING',
  MANIFEST_INVALID: 'HANDOFF_MANIFEST_INVALID',
  WRITE_FAILED: 'HANDOFF_WRITE_FAILED',
  READ_FAILED: 'HANDOFF_READ_FAILED',
  SECRET_CHECK_FAILED: 'HANDOFF_SECRET_CHECK_FAILED',
  INTERNAL: 'HANDOFF_INTERNAL'
})

/** Error codes raised by the filesystem sandbox below us. */
export const FS_SANDBOX_DENIED = 'FS_SANDBOX_DENIED'
export const FS_ABORTED = 'FS_ABORTED'
export const FS_TOO_LARGE = 'FS_TOO_LARGE'
export const FS_NOT_FOUND = 'FS_NOT_FOUND'
export const FS_NOT_OBSERVED = 'FS_NOT_OBSERVED'
export const FS_STALE_VERSION = 'FS_STALE_VERSION'

/**
 * Every bound that keeps one run cheap and deterministic. Values follow the
 * P0 implementation plan §5/§8.8; changing one is a behavior change.
 */
export const LIMITS = Object.freeze({
  /** Entries visited while walking the workspace. */
  maxEntries: 4000,
  /** Maximum directory depth below the workspace root. */
  maxDepth: 4,
  /** Maximum files whose content is read for redaction (copyFiles path). */
  maxTextFiles: 60,
  /** Per-file text read cap. */
  maxTextBytes: 128 * 1024,
  /** Total text read cap. */
  maxTotalTextBytes: 1.5 * 1024 * 1024,
  /** Per-file hash/read cap; larger files are skipped with a reason. */
  maxHashBytes: 4 * 1024 * 1024,
  /** Total bytes read while hashing evidence files. */
  maxHashTotalBytes: 16 * 1024 * 1024,
  /** Maximum evidence files listed and hashed. */
  maxEvidenceFiles: 200,
  /** Maximum entries in the top-level directory listing (H3). */
  maxTreeEntries: 100,
  /** Maximum paths accepted from the `files` argument (same as schema). */
  maxExplicitFiles: 200,
  /** copyFiles bounds. */
  copyMaxFiles: 20,
  copyMaxFileBytes: 256 * 1024,
  copyMaxTotalBytes: 2 * 1024 * 1024,
  /** Session trace bounds. */
  sessionMaxEvents: 2000,
  sessionMaxBytes: 400 * 1024,
  sessionMaxFiles: 100,
  sessionMaxCommands: 40,
  sessionMaxCommandChars: 300,
  /** scan preview text cap (characters). */
  previewChars: 12000,
  /** Declared tool timeout; enforced by dsh-tool-call-timeout-policy. */
  toolTimeoutMs: 120000
})

/** Declared tool timeout; enforced by dsh-tool-call-timeout-policy. */
export const TOOL_TIMEOUT_MS = LIMITS.toolTimeoutMs

/** Tool description shown to the model (English, per ADR decision 10). */
export const TOOL_DESCRIPTION =
  'Create, scan, verify, or list deterministic session handoff packages ' +
  '(HANDOFF.md + manifest.json) for the current workspace. Use before ending a long ' +
  'session or handing work to a new session; a new session should verify and read ' +
  'HANDOFF.md before trusting its claims.'

/** A scalar that may be absent as `null` when a file captured it that way. */
const nullableString = () => ({ oneOf: [{ type: 'string' }, { type: 'null' }] })
const nullableInteger = () => ({ oneOf: [{ type: 'integer' }, { type: 'null' }] })

/** One artifact entry as reported to the model. */
const ARTIFACT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['path', 'bytes', 'sha256'],
  properties: {
    path: { type: 'string', description: 'Batch-relative artifact path.' },
    bytes: { type: 'integer', description: 'UTF-8 byte length of the artifact.' },
    sha256: { type: 'string', description: 'Lower-case hex sha256 of the artifact bytes.' }
  }
})

/** One collected evidence file. */
const FILE_ENTRY_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['path', 'role', 'bytes', 'sha256'],
  properties: {
    path: { type: 'string', description: 'Workspace-relative POSIX path.' },
    role: { type: 'string', enum: ['entry', 'config', 'test', 'doc', 'source', 'other'] },
    bytes: { type: 'integer' },
    sha256: { type: 'string' },
    truncated: { type: 'boolean' },
    skippedReason: { type: 'string' }
  }
})

/** One tree row of the workspace top level. */
const TREE_ENTRY_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['name', 'type'],
  properties: {
    name: { type: 'string' },
    type: { type: 'string', enum: ['file', 'directory', 'other'] },
    bytes: { type: 'integer' }
  }
})

/** One verify finding. */
const FINDING_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['severity', 'code'],
  properties: {
    severity: { type: 'string', enum: ['error', 'warn'] },
    code: { type: 'string' },
    path: { type: 'string' },
    detail: { type: 'string' }
  }
})

/** One redaction hit summary. */
const REDACTION_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['file', 'kind', 'count'],
  properties: {
    file: { type: 'string', description: 'Batch-relative file that was redacted.' },
    kind: { type: 'string', description: 'Redaction rule id.' },
    count: { type: 'integer' }
  }
})

/** One warning. */
const WARNING_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['code', 'detail'],
  properties: {
    code: { type: 'string' },
    detail: { type: 'string' }
  }
})

/**
 * Canonical tool output schema. It belongs to the enforced JSON Schema subset
 * the harness accepts for tool outputs, so it uses only
 * type/oneOf/properties/required/additionalProperties/items/enum plus
 * annotations. Optional keys are omitted rather than sent as null.
 */
export const TOOL_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'action', 'warnings', 'totals', 'next', 'limits'],
  properties: {
    ok: { type: 'boolean' },
    action: { type: 'string', enum: [...ACTIONS] },
    dir: { type: 'string', description: 'Tokenized batch (or project) directory.' },
    displayDir: { type: 'string', description: 'Absolute human-readable directory.' },
    project: {
      type: 'object',
      additionalProperties: false,
      required: ['key', 'name', 'workspace'],
      properties: {
        key: { type: 'string' },
        name: { type: 'string' },
        workspace: { type: 'string', description: 'Tokenized workspace path.' }
      }
    },
    batchId: { type: 'string' },
    git: {
      type: 'object',
      additionalProperties: false,
      required: ['detached', 'packedRefsPresent'],
      properties: {
        head: nullableString(),
        branch: nullableString(),
        detached: { type: 'boolean' },
        remote: nullableString(),
        indexVersion: nullableInteger(),
        packedRefsPresent: { type: 'boolean' },
        lastCommit: {
          type: 'object',
          additionalProperties: false,
          required: ['sha', 'time', 'subject'],
          properties: {
            sha: { type: 'string' },
            time: { type: 'string' },
            subject: { type: 'string' }
          }
        }
      }
    },
    artifacts: { type: 'array', items: ARTIFACT_SCHEMA },
    totals: {
      type: 'object',
      additionalProperties: false,
      required: ['files', 'readBytes', 'artifacts', 'artifactBytes', 'redactions', 'warnings'],
      properties: {
        files: { type: 'integer' },
        readBytes: { type: 'integer' },
        artifacts: { type: 'integer' },
        artifactBytes: { type: 'integer' },
        redactions: { type: 'integer' },
        warnings: { type: 'integer' }
      }
    },
    redactions: { type: 'array', items: REDACTION_SCHEMA },
    warnings: { type: 'array', items: WARNING_SCHEMA },
    scan: {
      type: 'object',
      additionalProperties: false,
      required: ['entries', 'files', 'tree'],
      properties: {
        entries: { type: 'integer' },
        files: { type: 'array', items: FILE_ENTRY_SCHEMA },
        tree: { type: 'array', items: TREE_ENTRY_SCHEMA },
        explicitFiles: { type: 'integer' }
      }
    },
    preview: {
      type: 'object',
      additionalProperties: false,
      required: ['text', 'truncated'],
      properties: {
        text: { type: 'string' },
        truncated: { type: 'boolean' }
      }
    },
    verification: {
      type: 'object',
      additionalProperties: false,
      required: ['ok', 'batchId', 'dir', 'checkedAt', 'findings', 'drift', 'counts'],
      properties: {
        ok: { type: 'boolean' },
        batchId: { type: 'string' },
        dir: { type: 'string' },
        checkedAt: { type: 'string' },
        findings: { type: 'array', items: FINDING_SCHEMA },
        drift: {
          type: 'object',
          additionalProperties: false,
          required: ['gitHeadChanged', 'sourceFilesChanged', 'sourceFilesMissing', 'artifactsChecked'],
          properties: {
            gitHeadChanged: { type: 'boolean' },
            sourceFilesChanged: { type: 'integer' },
            sourceFilesMissing: { type: 'integer' },
            artifactsChecked: { type: 'integer' }
          }
        },
        counts: {
          type: 'object',
          additionalProperties: false,
          required: ['errors', 'warnings'],
          properties: {
            errors: { type: 'integer' },
            warnings: { type: 'integer' }
          }
        }
      }
    },
    batches: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['batchId', 'dir', 'createdAt', 'complete', 'artifacts', 'bytes'],
        properties: {
          batchId: { type: 'string' },
          dir: { type: 'string' },
          createdAt: nullableString(),
          title: nullableString(),
          gitHead: nullableString(),
          complete: { type: 'boolean' },
          artifacts: { type: 'integer' },
          bytes: { type: 'integer' }
        }
      }
    },
    next: { type: 'array', items: { type: 'string' } },
    limits: {
      type: 'object',
      additionalProperties: false,
      required: ['maxEntries', 'maxDepth', 'maxHashFiles', 'maxFileBytes', 'maxTotalBytes', 'maxSessionEvents', 'maxCommandChars'],
      properties: {
        maxEntries: { type: 'integer' },
        maxDepth: { type: 'integer' },
        maxHashFiles: { type: 'integer' },
        maxFileBytes: { type: 'integer' },
        maxTotalBytes: { type: 'integer' },
        maxSessionEvents: { type: 'integer' },
        maxCommandChars: { type: 'integer' }
      }
    }
  }
})

/** Model-facing parameters. Raw JSON Schema; the plugin self-validates args. */
export const TOOL_ARGUMENTS_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: {
      type: 'string',
      enum: [...ACTIONS],
      description:
        'scan = collect evidence and preview without writing; create = write a batch; ' +
        'verify = read-only hash/drift check of one batch; list = read-only batch listing.'
    },
    target: {
      type: 'string',
      enum: [...TARGETS],
      default: 'user',
      description:
        'Output root. user = $DSH_HOME/handoff (default, needs danger-full-access); ' +
        'workspace = <workspace>/.dsh/handoff (explicit downgrade). No auto fallback.'
    },
    title: { type: 'string', description: 'Optional batch title, at most 200 characters.' },
    goal: { type: 'string', description: 'Session goal statement, at most 4000 characters.' },
    summary: {
      type: 'string',
      description:
        'H1 narrative supplied by the caller (at most 8000 characters). The generator never invents it.'
    },
    decisions: {
      type: 'array',
      items: { type: 'string' },
      description: 'Decision statements for H1; at most 50 items of 2000 characters each.'
    },
    nextSteps: {
      type: 'array',
      items: { type: 'string' },
      description: 'Next steps; at most 50 items of 1000 characters each.'
    },
    concepts: {
      type: 'array',
      items: { type: 'string' },
      description: 'H2 glossary entries; at most 50 items of 1000 characters each.'
    },
    flow: {
      type: 'array',
      items: { type: 'string' },
      description: 'H5 end-to-end flow steps; at most 50 items of 1000 characters each.'
    },
    risks: {
      type: 'array',
      items: { type: 'string' },
      description: 'H6 open questions / risks / pitfalls; at most 50 items of 1000 characters each.'
    },
    files: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Workspace-relative paths to include as evidence (at most 200). Absolute paths and ' +
        'parent traversal are rejected.'
    },
    copyFiles: {
      type: 'boolean',
      default: false,
      description:
        'Copy up to 20 redacted files (256 KiB each, 2 MiB total) into evidence/files/.'
    },
    batchId: {
      type: 'string',
      description:
        'verify/list locator: YYYYMMDDTHHmmssZ-xxxx. Omitted = latest batch of this project.'
    },
    all: {
      type: 'boolean',
      default: false,
      description: 'list: include every project under the handoff root (default: current project only).'
    },
    force: {
      type: 'boolean',
      default: false,
      description:
        'Allow overwriting an existing or incomplete batch directory. Default createIfAbsent.'
    }
  }
})

/** The `limits` block returned to the model. */
export function publicLimits() {
  return {
    maxEntries: LIMITS.maxEntries,
    maxDepth: LIMITS.maxDepth,
    maxHashFiles: LIMITS.maxEvidenceFiles,
    maxFileBytes: LIMITS.maxHashBytes,
    maxTotalBytes: LIMITS.maxHashTotalBytes,
    maxSessionEvents: LIMITS.sessionMaxEvents,
    maxCommandChars: LIMITS.sessionMaxCommandChars
  }
}

/** True for a non-null, non-array plain object. */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Create a structured handoff failure.
 * @param {string} code one of {@link ERROR}.
 * @param {string} detail human-readable cause.
 * @param {Record<string, unknown>} [extra] additional machine-readable fields.
 * @returns {Error & {code: string, detail: string, name: string}}
 */
export function handoffError(code, detail, extra) {
  const error = new Error(`${code}: ${detail}`)
  error.name = 'HandoffError'
  error.code = code
  error.detail = detail
  if (isPlainObject(extra)) Object.assign(error, extra)
  return error
}

/** True when `error` is a structured handoff failure. */
export function isHandoffError(error) {
  return error instanceof Error && error.name === 'HandoffError' && typeof error.code === 'string'
}

/** Extract a stable error code from any thrown value. */
export function errorCodeOf(error) {
  if (error !== null && typeof error === 'object' && typeof error.code === 'string') return error.code
  return ERROR.INTERNAL
}

/** Extract a stable message from any thrown value. */
export function errorMessageOf(error) {
  if (error instanceof Error) return error.message
  if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message
  return String(error)
}

function invalid(detail) {
  return handoffError(ERROR.INVALID_ARGS, detail)
}

function consumeString(raw, key, maxLength) {
  const value = raw[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw invalid(`${key} must be a string`)
  if (value.length > maxLength) throw invalid(`${key} must be at most ${maxLength} characters`)
  return value
}

function consumeBoolean(raw, key, fallback) {
  const value = raw[key]
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw invalid(`${key} must be a boolean`)
  return value
}

function consumeStringArray(raw, key, maxItems, maxItemLength) {
  const value = raw[key]
  if (value === undefined) return []
  if (!Array.isArray(value)) throw invalid(`${key} must be an array of strings`)
  if (value.length > maxItems) throw invalid(`${key} must contain at most ${maxItems} items`)
  const result = []
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string') throw invalid(`${key}[${index}] must be a string`)
    if (item.length > maxItemLength)
      throw invalid(`${key}[${index}] must be at most ${maxItemLength} characters`)
    result.push(item)
  }
  return result
}

/**
 * Validate and normalize raw tool arguments. Raw JSON Schema tools are not
 * validated by the registry, so this is the only argument gate.
 * @param {unknown} raw caller-provided arguments.
 * @returns {{action: string, target: string, title: string|undefined, goal: string|undefined,
 *   summary: string|undefined, decisions: string[], nextSteps: string[], concepts: string[],
 *   flow: string[], risks: string[], files: string[], copyFiles: boolean,
 *   batchId: string|undefined, all: boolean, force: boolean}}
 * @throws {Error & {code: string}} `HANDOFF_INVALID_ARGS` for any violation.
 */
export function validateToolArgs(raw) {
  if (!isPlainObject(raw)) throw invalid('arguments must be a JSON object')
  const known = new Set(Object.keys(TOOL_ARGUMENTS_SCHEMA.properties))
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) throw invalid(`unknown argument "${key}"`)
  }
  const action = raw.action
  if (typeof action !== 'string' || !ACTIONS.includes(action))
    throw invalid(`action must be one of ${ACTIONS.join(', ')}`)
  const target = raw.target === undefined ? 'user' : raw.target
  if (typeof target !== 'string' || !TARGETS.includes(target))
    throw invalid(`target must be one of ${TARGETS.join(', ')}`)
  const batchId = consumeString(raw, 'batchId', 40)
  if (batchId !== undefined && !BATCH_ID_RE.test(batchId))
    throw invalid('batchId must match YYYYMMDDTHHmmssZ-xxxx (lower-case hex suffix)')
  if (action === 'create' && batchId !== undefined)
    throw invalid('batchId locates verify/list; create always mints a new batch id')
  if (action !== 'verify' && action !== 'list' && batchId !== undefined)
    throw invalid('batchId is only valid for verify and list')
  const all = consumeBoolean(raw, 'all', false)
  if (all && action !== 'list') throw invalid('all is only valid for list')
  const force = consumeBoolean(raw, 'force', false)
  if (force && action !== 'create') throw invalid('force is only valid for create')

  return {
    action,
    target,
    title: consumeString(raw, 'title', 200),
    goal: consumeString(raw, 'goal', 4000),
    summary: consumeString(raw, 'summary', 8000),
    decisions: consumeStringArray(raw, 'decisions', 50, 2000),
    nextSteps: consumeStringArray(raw, 'nextSteps', 50, 1000),
    concepts: consumeStringArray(raw, 'concepts', 50, 1000),
    flow: consumeStringArray(raw, 'flow', 50, 1000),
    risks: consumeStringArray(raw, 'risks', 50, 1000),
    files: consumeStringArray(raw, 'files', LIMITS.maxExplicitFiles, 400),
    copyFiles: consumeBoolean(raw, 'copyFiles', false),
    batchId,
    all,
    force
  }
}

/**
 * Best-effort DSH version detection for manifest provenance. The harness does
 * not expose its version through a public service and this package must not
 * import harness packages, so an explicit environment value or an injected
 * reader (used by the plugin entry point) wins; otherwise `unknown` is honest.
 * @param {Record<string, string|undefined>} [env] environment source.
 * @param {() => string|undefined} [readInstalledVersion] optional reader.
 * @returns {string}
 */
export function detectDshVersion(env = {}, readInstalledVersion) {
  const explicit = typeof env?.DSH_VERSION === 'string' ? env.DSH_VERSION.trim() : ''
  if (explicit !== '') return explicit
  if (typeof readInstalledVersion === 'function') {
    try {
      const detected = readInstalledVersion()
      if (typeof detected === 'string' && detected.trim() !== '') return detected.trim()
    } catch {
      /* fall through to unknown: detection is provenance only */
    }
  }
  return 'unknown'
}

/** Generator identity block embedded in every manifest. */
export function generatorIdentity({ dshVersion = 'unknown', platform = 'unknown' } = {}) {
  return {
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    dshVersion,
    platform
  }
}
