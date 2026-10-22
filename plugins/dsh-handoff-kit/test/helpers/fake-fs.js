/**
 * In-memory filesystem double for unit tests.
 *
 * It implements the subset of `ctx.fs` the plugin uses, with the same shape
 * (`resolve`/`lstat`/`stat`/`listDir`/`readText`/`readBytes`/`contains`/
 * `writeText`), the same `writeText` intent semantics (`createIfAbsent` /
 * `replaceIfVersion`), and a faithful `FS_SANDBOX_DENIED` policy fence so the
 * permission matrix can be tested without switching session modes.
 *
 * Symlinks are first-class: `resolve` follows them (realpath semantics), while
 * `lstat` does not, which is exactly the pair the collector relies on.
 *
 * @module test/helpers/fake-fs
 */

import { Buffer } from 'node:buffer'
import { resolve, sep } from 'node:path'
import { isInside } from '../../src/paths.js'

function fsError(code, message) {
  const error = new Error(`${code}: ${message}`)
  error.code = code
  return error
}

function toBytes(content) {
  if (content instanceof Uint8Array) return Buffer.from(content)
  return Buffer.from(String(content), 'utf8')
}

/**
 * Create an in-memory filesystem.
 * @param {{root?: string, files?: Record<string, string|Uint8Array|{type: string, target?: string}>, platform?: string}} [options]
 */
export function createFakeFs(options = {}) {
  const platform = options.platform ?? process.platform
  const root = resolve(options.root ?? 'C:\\ws')
  const entries = new Map()
  const writes = []
  const caseInsensitive = platform === 'win32'

  const normalize = (path) => resolve(String(path))
  const key = (path) => {
    const normalized = normalize(path)
    return caseInsensitive ? normalized.toLowerCase() : normalized
  }

  function store(path, entry) {
    const normalized = normalize(path)
    entries.set(key(normalized), { display: normalized, ...entry })
  }

  function getEntry(path) {
    return entries.get(key(path))
  }

  function ensureParents(absolutePath) {
    let current = normalize(absolutePath)
    const pending = []
    while (true) {
      const parent = current.slice(0, Math.max(0, current.lastIndexOf(sep)))
      if (parent === '' || parent === current) break
      if (!entries.has(key(parent))) pending.push(parent)
      else break
      current = parent
    }
    for (const directory of pending.reverse()) store(directory, { type: 'directory' })
  }

  function realpath(path) {
    const absolute = normalize(path)
    const parts = absolute.split(sep)
    let current = parts[0] === '' ? sep : `${parts[0]}${sep}`
    const rest = parts.filter((part) => part !== '')
    let index = 0
    if (rest[0] !== undefined && /^[A-Za-z]:$/.test(rest[0])) {
      current = `${rest[0]}${sep}`
      index = 1
    }
    for (; index < rest.length; index += 1) {
      current = resolve(current, rest[index])
      const entry = getEntry(current)
      if (entry?.type === 'symlink') {
        current = resolve(entry.target)
      }
    }
    return normalize(current)
  }

  /** Key-order-stable child listing used by `listDir`. */
  function childrenOf(directory) {
    const parentKey = key(directory)
    const prefix = parentKey.endsWith(sep) ? parentKey : parentKey + sep
    const children = []
    for (const entry of entries.values()) {
      const entryKey = key(entry.display)
      if (!entryKey.startsWith(prefix)) continue
      const rest = entryKey.slice(prefix.length)
      if (rest === '' || rest.includes(sep)) continue
      children.push(entry)
    }
    children.sort((left, right) => (left.display < right.display ? -1 : left.display > right.display ? 1 : 0))
    return children
  }

  function seedFile(path, content) {
    const absolute = resolve(root, path)
    ensureParents(absolute)
    store(absolute, { type: 'file', content: toBytes(content), version: { token: `v-${writes.length}-${entries.size}` } })
  }

  function seedDirectory(path) {
    const absolute = resolve(root, path)
    ensureParents(absolute)
    store(absolute, { type: 'directory' })
  }

  function seedSymlink(path, target) {
    const absolute = resolve(root, path)
    ensureParents(absolute)
    store(absolute, { type: 'symlink', target: resolve(root, target) })
  }

  const defaultPolicy = {
    mode: 'danger-full-access',
    workspaceRoot: root,
    sessionId: 'session-test'
  }

  for (const [path, content] of Object.entries(options.files ?? {})) {
    if (content !== null && typeof content === 'object' && !(content instanceof Uint8Array)) {
      if (content.type === 'directory') seedDirectory(path)
      else if (content.type === 'symlink') seedSymlink(path, content.target)
      else throw new Error(`fake-fs: unsupported seed entry for ${path}`)
    } else {
      seedFile(path, content)
    }
  }

  const fs = {
    platform,
    root,
    defaultPolicy,

    async resolve(path, opts) {
      const base = opts?.cwd ?? root
      const absolute = normalize(resolve(base, String(path)))
      const real = realpath(absolute)
      return { targetKey: real, displayPath: real }
    },

    processPath(target) {
      return target.targetKey
    },

    processPathFromHostPath(hostPath) {
      return normalize(hostPath)
    },

    fileUrl(target) {
      return `file:///${target.targetKey.replace(/\\/g, '/')}`
    },

    contains(parent, child) {
      return isInside(parent.targetKey, child.targetKey, { platform })
    },

    async stat(target, signal) {
      signal?.throwIfAborted?.()
      const entry = getEntry(target.targetKey)
      if (entry === undefined) return undefined
      return {
        version: entry.version ?? { token: entry.type },
        type: entry.type === 'symlink' ? 'other' : entry.type,
        ...(entry.type === 'file' ? { size: entry.content.length } : {})
      }
    },

    async lstat(path, opts, signal) {
      signal?.throwIfAborted?.()
      const base = opts?.cwd ?? root
      const absolute = normalize(resolve(base, String(path)))
      const entry = getEntry(absolute)
      if (entry === undefined) return undefined
      return {
        version: entry.version ?? { token: entry.type },
        type: entry.type,
        ...(entry.type === 'file' ? { size: entry.content.length } : {})
      }
    },

    async readText(target, signal) {
      signal?.throwIfAborted?.()
      const entry = getEntry(target.targetKey)
      if (entry === undefined) throw fsError('FS_NOT_FOUND', `no such file "${target.displayPath}"`)
      if (entry.type !== 'file') throw fsError('FS_NOT_REGULAR_FILE', `"${target.displayPath}" is not a file`)
      if (entry.failRead === true) throw fsError('FS_DENIED', `cannot read "${target.displayPath}"`)
      return entry.content.toString('utf8')
    },

    async readBytes(target, signal, maxBytes) {
      signal?.throwIfAborted?.()
      const entry = getEntry(target.targetKey)
      if (entry === undefined) throw fsError('FS_NOT_FOUND', `no such file "${target.displayPath}"`)
      if (entry.type !== 'file') throw fsError('FS_NOT_REGULAR_FILE', `"${target.displayPath}" is not a file`)
      if (entry.content.length > maxBytes) throw fsError('FS_TOO_LARGE', `"${target.displayPath}" exceeds ${maxBytes} bytes`)
      return Buffer.from(entry.content)
    },

    async listDir(target, signal) {
      signal?.throwIfAborted?.()
      const entry = getEntry(target.targetKey)
      if (entry === undefined) throw fsError('FS_NOT_FOUND', `no such directory "${target.displayPath}"`)
      if (entry.type !== 'directory') throw fsError('FS_NOT_DIRECTORY', `"${target.displayPath}" is not a directory`)
      return childrenOf(target.targetKey).map((child) => ({
        name: child.display.split(sep).at(-1),
        type: child.type === 'directory' ? 'directory' : child.type === 'file' ? 'file' : 'other',
        target: { targetKey: child.display, displayPath: child.display },
        ...(child.type === 'file' ? { size: child.content.length } : {})
      }))
    },

    async writeText(target, content, expected, signal, sandboxPolicy) {
      signal?.throwIfAborted?.()
      const policy = sandboxPolicy ?? defaultPolicy
      const mode = policy.mode ?? defaultPolicy.mode
      const workspaceRoot = policy.workspaceRoot ?? root
      if (mode === 'read-only') throw fsError('FS_SANDBOX_DENIED', `cannot write "${target.displayPath}": read-only mode`)
      if (mode !== 'danger-full-access' && !isInside(workspaceRoot, target.targetKey, { platform }))
        throw fsError('FS_SANDBOX_DENIED', `cannot write "${target.displayPath}": outside workspace root`)
      const before = getEntry(target.targetKey)
      if (expected?.kind === 'createIfAbsent' && before !== undefined)
        throw fsError('FS_NOT_OBSERVED', `cannot overwrite existing "${target.displayPath}"`)
      if (expected?.kind === 'replaceIfVersion') {
        if (before === undefined) throw fsError('FS_STALE_VERSION', `"${target.displayPath}" no longer exists`)
        if (before.version?.token !== expected.version?.token)
          throw fsError('FS_STALE_VERSION', `"${target.displayPath}" changed since read`)
      }
      ensureParents(target.targetKey)
      const buffer = toBytes(content)
      writes.push({
        path: target.targetKey,
        bytes: buffer.length,
        content: buffer.toString('utf8'),
        policyMode: mode
      })
      store(target.targetKey, { type: 'file', content: buffer, version: { token: `write-${writes.length}` } })
      return {
        operation: before === undefined ? 'create' : 'update',
        version: { token: `write-${writes.length}` },
        before: before?.content?.toString('utf8') ?? null,
        after: buffer.toString('utf8')
      }
    },

    async editText(target, edit, expected, signal, sandboxPolicy) {
      const current = await fs.readText(target, signal)
      if (expected !== undefined && getEntry(target.targetKey)?.version?.token !== expected.version?.token)
        throw fsError('FS_STALE_VERSION', `"${target.displayPath}" changed since read`)
      const next = edit.replaceAll
        ? current.split(edit.oldString).join(edit.newString)
        : current.replace(edit.oldString, edit.newString)
      await fs.writeText(target, next, undefined, signal, sandboxPolicy)
      return { version: { token: `write-${writes.length}` }, before: current, after: next }
    },

    // ── test-only surface ────────────────────────────────────────────────
    /** Every write performed so far, in order. */
    writes,
    writePaths() {
      return writes.map((write) => write.path)
    },
    writeCount() {
      return writes.length
    },
    /** Snapshot of the current tree, sorted by path (used by zero-write checks). */
    snapshot() {
      return [...entries.values()]
        .map((entry) => ({
          path: entry.display,
          type: entry.type,
          ...(entry.type === 'file' ? { size: entry.content.length } : {})
        }))
        .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    },
    has(path) {
      return entries.has(key(resolve(root, path)))
    },
    readFile(path) {
      const entry = getEntry(resolve(root, path))
      if (entry === undefined) return undefined
      return entry.content?.toString('utf8')
    },
    addFile(path, content) {
      const absolute = resolve(root, path)
      ensureParents(absolute)
      store(absolute, { type: 'file', content: toBytes(content), version: { token: `seed-${entries.size}` } })
    },
    addDirectory(path) {
      seedDirectory(path)
    },
    addSymlink(path, target) {
      seedSymlink(path, target)
    },
    remove(path) {
      const absolute = normalize(resolve(root, path))
      entries.delete(key(absolute))
    },
    setReadFailure(path, failRead = true) {
      const entry = getEntry(resolve(root, path))
      if (entry === undefined) throw new Error(`fake-fs: no entry ${path}`)
      entry.failRead = failRead
    }
  }

  return fs
}

/** Build a policy object for {@link createFakeFs} writes. */
export function policy(mode, workspaceRoot, sessionId = 'session-test') {
  return { mode, workspaceRoot, sessionId }
}
