import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  SKILL_RANK,
  SKILLS_ROOT,
  createSkillProvider,
  loadBundledSkills,
  parseSkillMarkdown
} from '../src/skill.js'

const SAMPLE = `---
name: demo-skill
description: 演示技能。
when-to-use: 当需要演示时。
---

# Demo

Body text.
`

test('parseSkillMarkdown parses the frontmatter subset and body', () => {
  const parsed = parseSkillMarkdown(SAMPLE)
  assert.equal(parsed.data.name, 'demo-skill')
  assert.equal(parsed.data.description, '演示技能。')
  assert.equal(parsed.data['when-to-use'], '当需要演示时。')
  assert.match(parsed.body, /^# Demo/)
  assert.equal(parseSkillMarkdown('# no frontmatter\n'), undefined)
  assert.equal(parseSkillMarkdown('---\nname: x\n'), undefined)
  assert.equal(parseSkillMarkdown(42), undefined)
})

test('the bundled handoff-pack SKILL.md is valid and complete', async () => {
  const skills = await loadBundledSkills()
  assert.equal(skills.length, 1)
  const { candidate, content } = skills[0]
  assert.equal(candidate.name, 'handoff-pack')
  assert.match(candidate.description, /交接包/)
  assert.equal(candidate.rank, SKILL_RANK)
  assert.equal(SKILL_RANK, 600)
  assert.equal(candidate.source, 'bundled')
  assert.equal(candidate.provider, 'dsh-handoff-kit')
  assert.deepEqual(candidate.resourceBase, { kind: 'directory', path: join(SKILLS_ROOT, 'handoff-pack') })
  assert.equal(candidate.invocation.modelInvocable, true)
  assert.equal(candidate.invocation.userInvocable, true)
  assert.equal(typeof candidate.locator, 'string')
  assert.match(content, /## 何时用/)
  assert.match(content, /## 权威顺序/)
  assert.match(content, /## 新会话怎么读/)
  assert.match(content, /handoff_pack/)
})

test('provider lists candidates and loads the definition on demand', async () => {
  const control = { signal: new AbortController().signal, invalidate() {} }
  const provider = createSkillProvider()(control)
  assert.equal(provider.name, 'dsh-handoff-kit')
  const candidates = await provider.list({})
  assert.equal(candidates.length, 1)
  const candidate = candidates[0]
  assert.equal(candidate.name, 'handoff-pack')
  assert.equal(candidate.content, undefined)

  const definition = await provider.get(candidate, {})
  assert.equal(definition.name, 'handoff-pack')
  assert.match(definition.content, /HANDOFF\.md/)
  assert.match(definition.content, /manifest\.json/)
  assert.equal(await provider.get({ name: 'missing-skill' }, {}), undefined)
})

test('a custom skills root lets tests exercise the loader without the bundled files', async () => {
  const candidatesOnly = await loadBundledSkills(join(SKILLS_ROOT, 'does-not-exist')).catch((error) => error)
  assert.equal(candidatesOnly instanceof Error, true)
})
