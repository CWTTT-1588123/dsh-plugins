/**
 * dsh-handoff-kit bundle entry (Host half, plus the P2 UI bridge).
 *
 * Registers the bundle's capabilities inside one Cordis lifetime:
 *   - the `handoff_pack` tool (scan/create/verify/list),
 *   - the `handoff_load` tool (read-only consumption: trust verdict + drift + pointers),
 *   - the `/handoff` human command,
 *   - the bundled `handoff-pack` skill provider,
 *   - the UI JSON route consumed by the bundle's `client.js` workbench (P2).
 *
 * No imports from `@deepseek-ai/*`: the package has zero runtime dependencies
 * and resolves every service through the injected context.
 *
 * @module dsh-handoff-kit
 */

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { PLUGIN_NAME, detectDshVersion } from './src/contracts.js'
import { createService } from './src/service.js'
import { createLoadTool, createTool } from './src/tool.js'
import { createCommand } from './src/command.js'
import { createSkillProvider } from './src/skill.js'
import { registerUiRpc } from './src/ui.js'

/** Cordis plugin name. */
export const name = PLUGIN_NAME

/**
 * Hard dependencies. `workingDirectory` is read opportunistically through
 * `ctx.get` (base mounts it) so the plugin still activates when only the
 * documented services exist.
 */
export const inject = ['tools', 'commands', 'skills', 'fs', 'sessions', 'sandboxPolicy']

const require = createRequire(import.meta.url)

/**
 * Best-effort DSH version for manifest provenance. Tries, in order: the
 * profile's installed dsh package, the Electron resources asar path, and the
 * package resolution graph. Any failure is `undefined` (provenance only) —
 * it never touches the workspace.
 * @returns {string|undefined}
 */
export function detectInstalledDshVersion() {
  const candidates = []
  if (typeof process.env.DSH_PROFILE_DIR === 'string' && process.env.DSH_PROFILE_DIR !== '')
    candidates.push(join(process.env.DSH_PROFILE_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  if (typeof process.resourcesPath === 'string' && process.resourcesPath !== '')
    candidates.push(join(process.resourcesPath, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  try {
    candidates.push(require.resolve('@deepseek-ai/dsh/package.json'))
  } catch {
    /* not resolvable from this linked checkout */
  }
  for (const manifestPath of candidates) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      if (typeof manifest?.version === 'string' && manifest.version.trim() !== '') return manifest.version
    } catch {
      /* try the next candidate */
    }
  }
  return undefined
}

/**
 * Register the bundle's capabilities.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  const service = createService({
    ctx,
    env: process.env,
    dshVersion: detectDshVersion(process.env, detectInstalledDshVersion),
    platform: process.platform
  })
  ctx.effect(() => ctx.tools.register(createTool(service)))
  ctx.effect(() => ctx.tools.register(createLoadTool(service)))
  ctx.effect(() => ctx.commands.register(createCommand(service)))
  ctx.effect(() => ctx.skills.registerProvider(createSkillProvider()))
  // P2: the Web UI half reaches this bundle's service through one
  // authenticated `/api` route. Absent in host-only profiles, where the
  // plugin still works through its tools/command; the route is owned by an
  // optional child fiber on the `connection` service.
  registerUiRpc(ctx, service, { env: process.env })
}

/** Internal exports for tests (not part of the plugin contract). */
export const _test = { detectInstalledDshVersion }
