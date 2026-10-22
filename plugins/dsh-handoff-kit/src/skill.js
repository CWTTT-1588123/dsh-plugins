/**
 * Bundled `handoff-pack` skill provider.
 *
 * Mirrors the official packaged-skill shape (rank 600, source `bundled`,
 * directory resource base) without importing any harness package: the
 * SKILL.md frontmatter is parsed by this module's minimal YAML subset.
 *
 * @module dsh-handoff-kit/skill
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PLUGIN_NAME, SKILL_NAME } from './contracts.js'

/** Same rank as the harness's own bundled skill providers. */
export const SKILL_RANK = 600
/** Provider id shown in skill diagnostics. */
export const SKILL_PROVIDER = PLUGIN_NAME
/** Default directory holding bundled skills. */
export const SKILLS_ROOT = fileURLToPath(new URL('../skills/', import.meta.url))

/**
 * Parse a `key: value` YAML subset frontmatter block. Values may be quoted;
 * nested structures are not needed by bundled skills.
 * @param {string} raw full SKILL.md text.
 * @returns {{data: Record<string, string>, body: string}|undefined}
 */
export function parseSkillMarkdown(raw) {
  if (typeof raw !== 'string') return undefined
  const lines = raw.replace(/\r\n/g, '\n').split('\n')
  if (lines[0] !== '---') return undefined
  const closing = lines.indexOf('---', 1)
  if (closing < 0) return undefined
  const data = {}
  for (const line of lines.slice(1, closing)) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (match === null) continue
    const [, key, rawValue] = match
    const value = rawValue.trim()
    data[key] =
      (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))
        ? value.slice(1, -1)
        : value
  }
  return { data, body: lines.slice(closing + 1).join('\n').trim() }
}

/**
 * Build a candidate from one parsed skill file.
 * @param {{directory: string, file: string, data: Record<string, string>}} input
 */
export function toCandidate({ directory, file, data }) {
  return {
    name: data.name,
    description: data.description,
    ...(data['when-to-use'] === undefined ? {} : { whenToUse: data['when-to-use'] }),
    invocation: { modelInvocable: true, userInvocable: true },
    provider: SKILL_PROVIDER,
    source: 'bundled',
    resourceBase: { kind: 'directory', path: directory },
    rank: SKILL_RANK,
    locator: file,
    path: file
  }
}

/**
 * Load every bundled skill directory.
 * @param {string} skillsRoot
 * @returns {Promise<Array<{candidate: object, content: string}>>}
 */
export async function loadBundledSkills(skillsRoot = SKILLS_ROOT) {
  const entries = await readdir(skillsRoot, { withFileTypes: true })
  const skills = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const directory = join(skillsRoot, entry.name)
    const file = join(directory, 'SKILL.md')
    let parsed
    try {
      parsed = parseSkillMarkdown(await readFile(file, 'utf8'))
    } catch {
      continue
    }
    if (parsed === undefined) continue
    const { data, body } = parsed
    if (typeof data.name !== 'string' || data.name.trim() === '') continue
    if (typeof data.description !== 'string' || data.description.trim() === '') continue
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(data.name.trim())) continue
    skills.push({
      candidate: toCandidate({ directory, file, data: { ...data, name: data.name.trim() } }),
      content: body
    })
  }
  skills.sort((left, right) => (left.candidate.name < right.candidate.name ? -1 : 1))
  return skills
}

/**
 * Create the `(control) => SkillProvider` factory expected by
 * `ctx.skills.registerProvider`.
 * @param {{skillsRoot?: string}} [options]
 */
export function createSkillProvider(options = {}) {
  const skillsRoot = options.skillsRoot ?? SKILLS_ROOT
  return (control) => ({
    name: SKILL_PROVIDER,
    async list() {
      control?.signal?.throwIfAborted?.()
      const skills = await loadBundledSkills(skillsRoot)
      return skills.map((skill) => skill.candidate)
    },
    async get(candidate, listOptions) {
      listOptions?.signal?.throwIfAborted?.()
      control?.signal?.throwIfAborted?.()
      const skills = await loadBundledSkills(skillsRoot)
      const found = skills.find((skill) => skill.candidate.name === candidate?.name)
      if (found === undefined) return undefined
      return { ...found.candidate, content: found.content }
    }
  })
}

/** The single bundled skill name (exported for tests/index diagnostics). */
export const BUNDLED_SKILL_NAME = SKILL_NAME
