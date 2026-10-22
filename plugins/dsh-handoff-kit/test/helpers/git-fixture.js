/**
 * Test-only io adapter between {@link createFakeFs} and the `io` abstraction
 * expected by `src/git.js` and `src/collect.js`.
 *
 * The adapter takes absolute native paths only, mirrors the exact shape the
 * production service builds over `ctx.fs`, records every call (so tests can
 * prove which paths a module read), and deliberately does NOT sort
 * `listDir` output — callers (the collector) must guarantee determinism
 * themselves.
 *
 * @module test/helpers/git-fixture
 */

import { resolve } from 'node:path'

/**
 * Wrap a fake filesystem in the `{lstat, readText, readBytes, listDir}` io
 * contract.
 * @param {ReturnType<typeof import('./fake-fs.js').createFakeFs>} fs
 * @returns {{
 *   calls: Array<{op: string, path: string}>,
 *   lstat(absPath: string): Promise<{type: string, size?: number}|undefined>,
 *   readText(absPath: string): Promise<string>,
 *   readBytes(absPath: string, maxBytes: number): Promise<Uint8Array>,
 *   listDir(absPath: string): Promise<Array<{name: string, type: string, size?: number}>>
 * }}
 */
export function createFakeIo(fs) {
  const calls = []
  const record = (op, absPath) => {
    calls.push({ op, path: resolve(absPath) })
  }
  const targetOf = async (absPath) => {
    const target = await fs.resolve(absPath)
    return target
  }

  return {
    calls,
    async lstat(absPath) {
      record('lstat', absPath)
      const info = await fs.lstat(absPath)
      if (info === undefined) return undefined
      if (info.type === 'file' && Number.isFinite(info.size))
        return { type: 'file', size: info.size }
      return { type: info.type }
    },
    async readText(absPath) {
      record('readText', absPath)
      return fs.readText(await targetOf(absPath))
    },
    async readBytes(absPath, maxBytes) {
      record('readBytes', absPath)
      return fs.readBytes(await targetOf(absPath), undefined, maxBytes)
    },
    async listDir(absPath) {
      record('listDir', absPath)
      const rows = await fs.listDir(await targetOf(absPath))
      return rows.map((row) => ({
        name: row.name,
        type: row.type,
        ...(Number.isFinite(row.size) ? { size: row.size } : {})
      }))
    }
  }
}

/**
 * Wrap an io adapter and reverse every `listDir` result, to prove the consumer
 * sorts directory listings itself instead of trusting filesystem order.
 * @param {ReturnType<typeof createFakeIo>} io
 */
export function createReversedIo(io) {
  return {
    calls: io.calls,
    lstat: (absPath) => io.lstat(absPath),
    readText: (absPath) => io.readText(absPath),
    readBytes: (absPath, maxBytes) => io.readBytes(absPath, maxBytes),
    async listDir(absPath) {
      const rows = await io.listDir(absPath)
      return [...rows].reverse()
    }
  }
}
