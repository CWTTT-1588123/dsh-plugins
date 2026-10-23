/**
 * Host-side bridge for the P2 UI workbench (Client half).
 *
 * The persistent bundle's Client half cannot use the dynamic-package
 * `host.call` channel: that builtin belongs to `dsh-cordis-client-runner`
 * (in-memory Cordis packages created by the `cordis` tool). A bundle client
 * talks to its Host half through {@link registerUiRpc}, an authenticated
 * same-origin JSON route registered on `ctx.connection.fetch` (the shipped
 * `/api` bridge). The route is a thin adapter: it validates the envelope,
 * rebuilds the `exec` face the existing service already expects, and returns
 * the service's own results. It owns no manifest parsing, hashing or
 * verification logic.
 *
 * P2 plan §4.1 methods:
 *   - `state`  : project + recent batches + target roots (read-only)
 *   - `detail` : one batch: verify findings/drift + bounded HANDOFF excerpts
 *   - `create` : create/append/update through the existing `run()`
 *   - `copy`   : build the new-session opening prompt from `load()` (no write)
 *
 * @module dsh-handoff-kit/ui
 */

import { join } from 'node:path'

import {
  ERROR,
  HANDOFF_SUBDIR,
  TARGETS,
  WORKSPACE_HANDOFF_SUBDIR,
  errorCodeOf,
  errorMessageOf,
  handoffError,
  isPlainObject,
  validateLoadArgs,
  validateToolArgs
} from './contracts.js'
import { resolveDshHome } from './service.js'

/** Wire protocol version; a Client from another major refuses to talk. */
export const UI_RPC_PROTOCOL = 1
/** Route path inside the authenticated `/api` bridge. */
export const UI_RPC_PATH = '/api/handoff-kit/rpc'
/** Request body cap: the UI only sends small JSON. */
export const UI_RPC_MAX_BODY_BYTES = 256 * 1024
/** Methods the Client may call, in a stable order. */
export const UI_RPC_METHODS = Object.freeze(['state', 'detail', 'copy', 'create'])

/** Parameters accepted per method (unknown keys are rejected, not ignored). */
const METHOD_PARAMS = Object.freeze({
  state: Object.freeze(['sessionId', 'target', 'all']),
  detail: Object.freeze(['sessionId', 'target', 'batchId', 'include']),
  copy: Object.freeze(['sessionId', 'target', 'batchId', 'include']),
  create: Object.freeze([
    'sessionId',
    'target',
    'mode',
    'title',
    'summary',
    'goal',
    'nextSteps',
    'includeDiffs',
    'force',
    'previousBatchId',
    'supersedes'
  ])
})

/** Create-mode actions the UI may request. */
const CREATE_MODES = Object.freeze(['create', 'append', 'update'])

/**
 * Chinese remedy text per error code, reused by every UI surface.
 * @param {string} code stable `HANDOFF_*` code.
 * @returns {string}
 */
export function remedyFor(code) {
  switch (code) {
    case ERROR.READ_ONLY:
      return '当前会话权限是只读：改用 target=workspace 或切换到 workspace-write 再试。'
    case ERROR.SANDBOX_DENIED:
      return '宿主的沙箱拒绝了这次写入：检查会话权限，或把目标切到 workspace。'
    case ERROR.BATCH_EXISTS:
      return '该批次已存在：勾选「覆盖（force）」或稍后重试。'
    case ERROR.BATCH_NOT_FOUND:
    case ERROR.RESUME_NOT_FOUND:
      return '没有找到可用的交接批次：刷新列表，或先在「生成」里创建一包。'
    case ERROR.APPEND_TARGET_MISSING:
      return '没有可继续的目标批次：先在「生成」里创建一包，再继续交接。'
    case ERROR.LINEAGE_CYCLE:
      return '血缘目标不合法（不能串到自己）：留空以使用最新批次。'
    case ERROR.MANIFEST_MISSING:
    case ERROR.MANIFEST_INVALID:
    case ERROR.VERIFY_INVALID:
      return '该批次的包不完整或校验失败：不要直接信任，查看 findings 或重新生成。'
    case ERROR.INVALID_ARGS:
      return '参数不合法：检查表单内容后重试。'
    case ERROR.PATH_ESCAPE:
      return '路径越界：检查 target 与工作区目录。'
    case ERROR.WRITE_FAILED:
    case ERROR.READ_FAILED:
      return '宿主读写失败：检查目录权限与磁盘空间后重试。'
    case ERROR.SECRET_CHECK_FAILED:
      return '检测到疑似密钥内容：清理后重新生成。'
    case ERROR.INTERNAL:
    default:
      return '宿主内部错误：重试一次；仍失败时查看 DSH 日志。'
  }
}

/**
 * Build the successful envelope.
 * @param {unknown} value JSON value.
 */
function success(value) {
  return { ok: true, protocol: UI_RPC_PROTOCOL, value }
}

/**
 * Build the failure envelope from any thrown value.
 * @param {unknown} error
 */
export function failureOf(error) {
  const code = errorCodeOf(error)
  const detail = typeof error?.detail === 'string' ? error.detail : errorMessageOf(error)
  const message = detail.startsWith(code) ? detail.slice(code.length).replace(/^:\s*/, '') : detail
  return {
    ok: false,
    protocol: UI_RPC_PROTOCOL,
    error: { code, message: message === '' ? code : message, remedy: remedyFor(code) }
  }
}

/** JSON response helper for the raw fetch route. */
function json(status, body) {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
}

/** Validate and read an optional session id. */
function consumeSessionId(params) {
  const value = params.sessionId
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value === '' || value.length > 200) {
    throw handoffError(ERROR.INVALID_ARGS, 'sessionId must be a non-empty string of at most 200 characters')
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
    throw handoffError(ERROR.INVALID_ARGS, 'sessionId contains unsupported characters')
  }
  return value
}

/** Validate and default a target. */
function consumeTarget(params, fallback = 'user') {
  const value = params.target ?? fallback
  if (!TARGETS.includes(value)) {
    throw handoffError(ERROR.INVALID_ARGS, `target must be one of ${TARGETS.join(', ')}`)
  }
  return value
}

/** Build the `exec` face the service already consumes (agent + signal). */
function execForSession(session, signal) {
  const exec = {}
  const sessionId = typeof session?.id === 'string' ? session.id : undefined
  if (sessionId !== undefined) exec.agent = { id: sessionId }
  if (signal !== undefined) exec.signal = signal
  return exec
}

/**
 * Resolve the session/workspace this UI request acts on.
 *
 * A provided, live session id wins. Root-scoped surfaces (the sidebar
 * workbench page) carry no session binding, so without one the newest live
 * root session is used; the deployment fallback directory is the last resort
 * (it can point at the profile directory rather than a project). This is host
 * context resolution, not handoff business logic.
 */
function resolveWorkspace(serviceCtx, sessionId) {
  const sessions = typeof serviceCtx.get === 'function' ? serviceCtx.get('sessions') : serviceCtx.sessions
  let session = sessionId !== undefined && typeof sessions?.get === 'function' ? sessions.get(sessionId) : undefined
  if (session === undefined && typeof sessions?.list === 'function') {
    let candidates = []
    try {
      candidates = sessions.list()
    } catch {
      candidates = []
    }
    const roots = Array.isArray(candidates)
      ? candidates.filter(
          (candidate) =>
            candidate !== null &&
            typeof candidate === 'object' &&
            candidate.header?.parentSession === undefined &&
            candidate.header?.origin !== 'subagent'
        )
      : []
    if (roots.length > 0) session = roots[roots.length - 1]
  }
  const workingDirectory =
    typeof serviceCtx.get === 'function' ? serviceCtx.get('workingDirectory') : serviceCtx.workingDirectory
  let workspaceRoot
  if (session !== undefined && typeof workingDirectory?.get === 'function') {
    workspaceRoot = workingDirectory.get(session)
  }
  if (typeof workspaceRoot !== 'string' || workspaceRoot === '') workspaceRoot = session?.header?.cwd
  if (typeof workspaceRoot !== 'string' || workspaceRoot === '') workspaceRoot = workingDirectory?.defaultDirectory
  if (typeof workspaceRoot !== 'string' || workspaceRoot === '') {
    throw handoffError(ERROR.INTERNAL, 'cannot resolve the workspace directory for this UI request')
  }
  return { session, workspaceRoot }
}

/** Absolute target roots shown before a write (P2 §3.4 "显示目标目录"). */
function rootsOf(env, workspaceRoot) {
  return {
    user: join(resolveDshHome(env), HANDOFF_SUBDIR),
    workspace: join(workspaceRoot, ...WORKSPACE_HANDOFF_SUBDIR.split('/'))
  }
}

/**
 * Render the new-session opening prompt from a `handoff_load` result.
 *
 * Prompt-first (ADR-0003): this text is the primary deliverable; the package
 * is its backing. The renderer only assembles facts `load()` already produced
 * (trust, pointers, next, bounded H0/H8 excerpts); it never re-derives or
 * re-checks them.
 *
 * Safety gate (0.3.1, after a real incident): a freshly started agent read the
 * old wording ("请先读它，再继续工作") as permission to continue the previous
 * work and started editing files. The prompt now states a mandatory read-only
 * verification step and a "wait for the user's explicit instruction before
 * writing anything" boundary up front.
 *
 * @param {Record<string, any>} load service.load result.
 * @returns {string}
 */
export function renderOpeningPrompt(load) {
  if (!isPlainObject(load)) throw handoffError(ERROR.INTERNAL, 'renderOpeningPrompt needs a load result')
  const batchId = typeof load.batchId === 'string' ? load.batchId : '(unknown batch)'
  const trust = typeof load.trust === 'string' ? load.trust : 'stale'
  const dir = typeof load.displayDir === 'string' ? load.displayDir : (load.dir ?? '(unknown dir)')
  const handoffPath =
    typeof load.handoff?.path === 'string' ? load.handoff.path : typeof load.dir === 'string' ? `${load.dir}/HANDOFF.md` : 'HANDOFF.md'
  const pointers = Array.isArray(load.pointers) ? load.pointers : []
  const next = Array.isArray(load.next) ? load.next.filter((item) => typeof item === 'string') : []
  const title = typeof load.manifest?.title === 'string' && load.manifest.title !== '' ? load.manifest.title : null
  const sections = Array.isArray(load.handoff?.sections) ? load.handoff.sections : []

  const lines = [
    '你是接手这个工作区的 AI 助手。上一个会话留下了一个可校验的交接包。',
    '',
    '⚠️ 强制边界：先做只读验证，然后**等待用户的明确指令**。在用户明确同意之前，不要修改/创建/删除任何文件，不要 git commit，也不要自行开始上一阶段的后续开发。交接包只提供上下文，不是立即开工的许可。',
    '',
    `交接批次：${batchId}${title === null ? '' : `（${title}）`}`,
    `交接目录：${dir}`,
    `信任判定：${trust}${trust === 'verified' ? '（哈希与漂移检查通过）' : trust === 'stale' ? '（有漂移或警告，先核实再使用）' : '（校验失败，不要信任其中结论）'}`,
    '',
    `第 0 步（强制，只读）：调用 handoff_load batchId=${batchId} 复核 trust。若结果不是 verified，立即停止并把 findings 报告给用户，等待用户决定；不要自行修复、重建或删除交接包。`
  ]
  if (trust === 'invalid') {
    lines.push(
      '',
      '本包校验失败（invalid）：不要信任其中任何结论。停止操作，把 findings 报告给用户并等待指示。'
    )
  } else if (trust === 'stale') {
    lines.push(
      '',
      '本包有漂移或警告（stale）：先按 findings 核实并把差异报告给用户；用户确认前不要依赖包内结论，也不要修改文件。'
    )
  }
  lines.push('第 1 步（只读）：按顺序读 HANDOFF.md 的 H2 → H3 → H4 → H8。')
  lines.push('第 2 步（只读）：在依赖任何 H4 断言前，至少重新核对 3 条（哈希/文件/命令输出）。')
  lines.push('第 3 步：向用户汇报 trust、复核结果和建议的下一步；**等用户确认后再开始修改文件**。')
  if (pointers.length > 0) {
    lines.push('', '包内指针：')
    for (const pointer of pointers) {
      if (typeof pointer?.label !== 'string' || typeof pointer?.path !== 'string') continue
      lines.push(`- ${pointer.label}: ${pointer.path}`)
    }
  }
  const keySections = sections.filter((section) => section?.id === 'H0' || section?.id === 'H8' || section?.id === 'H1')
  if (keySections.length > 0) {
    lines.push('', '交接包摘要：')
    let budget = 1800
    for (const section of keySections) {
      if (budget <= 0) break
      const text = typeof section.text === 'string' ? section.text.trim() : ''
      if (text === '') continue
      const capped = text.length > budget ? `${text.slice(0, budget)}…` : text
      budget -= capped.length
      lines.push('', `## ${section.heading ?? section.id}`, capped)
    }
  }
  if (next.length > 0) {
    lines.push('', '建议的下一步（仅供参考，仍需用户确认后再执行）：')
    for (const item of next.slice(0, 3)) lines.push(`- ${item}`)
  }
  lines.push('', `复核命令（只读）：handoff_load batchId=${batchId}；HANDOFF 路径：${handoffPath}`)
  lines.push('提示：在收到用户的明确指令前，请只汇报、不落盘。')
  return lines.join('\n')
}

/**
 * Project key encoded in a tokenized batch directory.
 *
 * `list all` returns `dir` tokens of the shape `<root>/<projectKey>/<batchId>`
 * for every project key under the same handoff root, which is the only
 * read-only way the Host exposes sibling projects. Deriving the key from the
 * token (instead of adding fields to the tool output contract) keeps the
 * `handoff_pack` list schema frozen.
 *
 * @param {unknown} batchDir tokenized batch dir (e.g. `$DSH_HOME/handoff/k/id`)
 * @param {unknown} rootDir tokenized handoff root (the `list all` result dir)
 * @param {unknown} batchId the batch id the token must end with
 * @returns {string|null} the project key, or null when the token does not fit
 */
export function projectKeyFromBatchDir(batchDir, rootDir, batchId) {
  if (typeof batchDir !== 'string' || batchDir === '') return null
  if (typeof rootDir !== 'string' || rootDir === '') return null
  if (typeof batchId !== 'string' || batchId === '') return null
  const prefix = rootDir.endsWith('/') ? rootDir : `${rootDir}/`
  if (!batchDir.startsWith(prefix)) return null
  const suffix = `/${batchId}`
  if (!batchDir.endsWith(suffix)) return null
  const projectKey = batchDir.slice(prefix.length, batchDir.length - suffix.length)
  if (projectKey === '' || projectKey.includes('/')) return null
  return projectKey
}

/**
 * Create the RPC dispatcher/handler pair.
 *
 * @param {{
 *   service: {run: Function, load: Function},
 *   env?: Record<string, string|undefined>,
 *   ctx?: any
 * }} options
 */
export function createUiRpc({ service, env = {}, ctx } = {}) {
  if (service === null || typeof service !== 'object') throw new Error('createUiRpc requires a service')
  if (typeof service.run !== 'function' || typeof service.load !== 'function') {
    throw new Error('createUiRpc requires service.run and service.load')
  }
  const serviceCtx = ctx ?? {}

  /** `state`: read-only project + batches + roots (+ historical batches). */
  async function state(params, signal) {
    const target = consumeTarget(params)
    const { session, workspaceRoot } = resolveWorkspace(serviceCtx, consumeSessionId(params))
    const exec = execForSession(session, signal)
    const raw = { action: 'list', target }
    if (params.all === true) raw.all = true
    const list = await service.run(validateToolArgs(raw), exec)
    const currentProjectKey = typeof list.project?.key === 'string' ? list.project.key : null
    let batches = Array.isArray(list.batches) ? list.batches : []
    const warnings = Array.isArray(list.warnings) ? [...list.warnings] : []
    let history = null
    // A remote-seeded project key changes when the repository gains/changes a
    // git remote, orphaning earlier batches under the old key. When the current
    // key has none, surface the sibling-key batches read-only (grouped by
    // project key) instead of an empty workbench. Writes are untouched:
    // create/append/update still resolve the current project key.
    if (batches.length === 0 && params.all !== true) {
      const aggregate = await service.run(validateToolArgs({ action: 'list', target, all: true }), exec)
      const rootDir = typeof aggregate.dir === 'string' ? aggregate.dir : ''
      const grouped = new Map()
      for (const batch of Array.isArray(aggregate.batches) ? aggregate.batches : []) {
        if (batch === null || typeof batch !== 'object') continue
        const projectKey = projectKeyFromBatchDir(batch.dir, rootDir, batch.batchId)
        if (projectKey === null || projectKey === currentProjectKey) continue
        if (!grouped.has(projectKey)) grouped.set(projectKey, [])
        grouped.get(projectKey).push({ ...batch, projectKey })
      }
      if (grouped.size > 0) {
        const projectKeys = [...grouped.keys()].sort()
        batches = projectKeys.flatMap((projectKey) => grouped.get(projectKey))
        history = { active: true, currentProjectKey, projectKeys, dir: rootDir }
        warnings.push({
          code: 'PROJECT_KEY_FALLBACK',
          detail:
            `current project key ${currentProjectKey ?? '(unknown)'} has no batches; showing ` +
            `${batches.length} historical batch(es) from project key(s) ${projectKeys.join(', ')} read-only; ` +
            'new batches are still written to the current project key'
        })
      }
    }
    return {
      protocol: UI_RPC_PROTOCOL,
      target,
      dir: list.dir,
      project: list.project,
      batches,
      totals: list.totals,
      warnings,
      limits: list.limits,
      next: list.next,
      roots: rootsOf(env, workspaceRoot),
      history,
      session: {
        id: typeof exec.agent?.id === 'string' ? exec.agent.id : null,
        live: session !== undefined,
        cwd: workspaceRoot
      }
    }
  }

  /** `detail`/`copy` locator: an explicit batch id or the newest batch. */
  async function latestBatchId(params, exec) {
    const target = consumeTarget(params)
    const list = await service.run(validateToolArgs({ action: 'list', target }), exec)
    const batches = Array.isArray(list.batches) ? list.batches : []
    if (batches.length === 0) {
      throw handoffError(ERROR.RESUME_NOT_FOUND, 'no handoff batch exists for this project yet')
    }
    return { batchId: batches[0].batchId, target }
  }

  /** `detail`: verified load with bounded HANDOFF excerpts (read-only). */
  async function detail(params, signal) {
    const target = consumeTarget(params)
    const { session } = resolveWorkspace(serviceCtx, consumeSessionId(params))
    const exec = execForSession(session, signal)
    let batchId = params.batchId
    if (batchId === undefined || batchId === 'latest') {
      batchId = (await latestBatchId(params, exec)).batchId
    }
    if (typeof batchId !== 'string' || batchId === '') {
      throw handoffError(ERROR.INVALID_ARGS, 'batchId must be a non-empty string')
    }
    const include = params.include === 'full' ? 'full' : 'sections'
    const load = await service.load(validateLoadArgs({ batchId, target, include, verifyFirst: true }), exec)
    return { protocol: UI_RPC_PROTOCOL, target, ...load }
  }

  /** `copy`: opening prompt text from a verified load; never writes. */
  async function copy(params, signal) {
    const target = consumeTarget(params)
    const { session } = resolveWorkspace(serviceCtx, consumeSessionId(params))
    const exec = execForSession(session, signal)
    let batchId = params.batchId
    if (batchId === undefined || batchId === 'latest') {
      batchId = (await latestBatchId(params, exec)).batchId
    }
    if (typeof batchId !== 'string' || batchId === '') {
      throw handoffError(ERROR.INVALID_ARGS, 'batchId must be a non-empty string')
    }
    const load = await service.load(validateLoadArgs({ batchId, target, include: 'sections', verifyFirst: true }), exec)
    return {
      protocol: UI_RPC_PROTOCOL,
      target,
      batchId: load.batchId ?? batchId,
      trust: load.trust ?? 'stale',
      dir: load.dir,
      displayDir: load.displayDir,
      warnings: load.warnings ?? [],
      text: renderOpeningPrompt(load)
    }
  }

  /** `create`: the only writing method; delegates to the validated service verb. */
  async function create(params, signal) {
    const target = consumeTarget(params)
    const { session } = resolveWorkspace(serviceCtx, consumeSessionId(params))
    const exec = execForSession(session, signal)
    const mode = params.mode ?? 'create'
    if (!CREATE_MODES.includes(mode)) {
      throw handoffError(ERROR.INVALID_ARGS, `mode must be one of ${CREATE_MODES.join(', ')}`)
    }
    const raw = { action: mode, target }
    const passthrough = [
      'title',
      'summary',
      'goal',
      'nextSteps',
      'includeDiffs',
      'force',
      'previousBatchId',
      'supersedes'
    ]
    for (const key of passthrough) {
      if (params[key] !== undefined) raw[key] = params[key]
    }
    // The tool/command paths validate before calling the service; the UI route
    // must do the same so the service receives its canonical argument shape.
    const result = await service.run(validateToolArgs(raw), exec)
    return { protocol: UI_RPC_PROTOCOL, target, ...result }
  }

  /**
   * Dispatch one validated request.
   * @param {string} method
   * @param {Record<string, unknown>} params
   * @param {AbortSignal} [signal]
   */
  async function dispatch(method, params, signal) {
    if (typeof method !== 'string' || !UI_RPC_METHODS.includes(method)) {
      throw handoffError(ERROR.INVALID_ARGS, `unsupported UI method: ${String(method)}`)
    }
    const raw = params === undefined || params === null ? {} : params
    if (!isPlainObject(raw)) throw handoffError(ERROR.INVALID_ARGS, 'params must be a JSON object')
    const allowed = METHOD_PARAMS[method]
    for (const key of Object.keys(raw)) {
      if (!allowed.includes(key)) throw handoffError(ERROR.INVALID_ARGS, `unknown parameter for ${method}: ${key}`)
    }
    switch (method) {
      case 'state':
        return await state(raw, signal)
      case 'detail':
        return await detail(raw, signal)
      case 'copy':
        return await copy(raw, signal)
      case 'create':
        return await create(raw, signal)
      default:
        throw handoffError(ERROR.INVALID_ARGS, `unsupported UI method: ${method}`)
    }
  }

  /**
   * Raw route handler: parse `{method, params}`, answer a JSON envelope.
   * @param {Request} request
   */
  async function handle(request) {
    if (request === null || typeof request !== 'object' || request.method !== 'POST') {
      return json(405, failureOf(handoffError(ERROR.INVALID_ARGS, 'UI RPC accepts POST only')))
    }
    let text
    try {
      text = await request.text()
    } catch (error) {
      return json(400, failureOf(handoffError(ERROR.INVALID_ARGS, `cannot read request body: ${errorMessageOf(error)}`)))
    }
    if (typeof text !== 'string' || text.length > UI_RPC_MAX_BODY_BYTES) {
      return json(413, failureOf(handoffError(ERROR.INVALID_ARGS, 'request body too large')))
    }
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      return json(400, failureOf(handoffError(ERROR.INVALID_ARGS, 'request body must be JSON')))
    }
    if (!isPlainObject(payload) || typeof payload.method !== 'string') {
      return json(400, failureOf(handoffError(ERROR.INVALID_ARGS, 'request must carry a method string')))
    }
    if (payload.protocol !== undefined && payload.protocol !== UI_RPC_PROTOCOL) {
      return json(400, failureOf(handoffError(ERROR.INVALID_ARGS, 'UI protocol version mismatch; reload the page')))
    }
    try {
      const value = await dispatch(payload.method, payload.params, request.signal)
      return json(200, success(value))
    } catch (error) {
      return json(200, failureOf(error))
    }
  }

  return { handle, dispatch, path: UI_RPC_PATH, methods: UI_RPC_METHODS }
}

/**
 * Register the UI RPC route on the optional `connection` service.
 *
 * The connection service belongs to the Web composition, so the plugin stays
 * installable in host-only profiles: without it this registers nothing.
 *
 * @param {any} ctx plugin context.
 * @param {{run: Function, load: Function}} service
 * @param {{env?: Record<string, string|undefined>}} [options]
 * @returns {() => void} disposer (no-op when no transport exists).
 */
export function registerUiRpc(ctx, service, options = {}) {
  if (ctx === null || typeof ctx !== 'object') return () => {}
  const rpc = createUiRpc({ service, env: options.env ?? process.env, ctx })
  const attach = (hostCtx) => {
    const connection =
      typeof hostCtx.get === 'function' ? hostCtx.get('connection') : hostCtx.connection
    if (connection === undefined || connection === null) return () => {}
    if (typeof connection.fetch?.register !== 'function') return () => {}
    const register = () =>
      connection.fetch.register({
        path: UI_RPC_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: (request) => rpc.handle(request)
      })
    if (typeof hostCtx.effect === 'function') {
      let dispose
      hostCtx.effect(() => {
        dispose = register()
        return () => {
          if (typeof dispose === 'function') return dispose()
        }
      })
    } else {
      register()
    }
    return () => {}
  }
  if (typeof ctx.inject === 'function') {
    // Optional service: the child fiber activates only when the Web composition
    // provides `connection`, and is disposed with this plugin's context.
    ctx.inject(['connection'], (connectionCtx) => {
      attach(connectionCtx)
    })
    return () => {}
  }
  return attach(ctx) ?? (() => {})
}

/** Internal helpers exposed for tests (not part of the plugin contract). */
export const _test = {
  execForSession,
  consumeTarget,
  consumeSessionId,
  rootsOf,
  resolveWorkspace,
  projectKeyFromBatchDir
}
