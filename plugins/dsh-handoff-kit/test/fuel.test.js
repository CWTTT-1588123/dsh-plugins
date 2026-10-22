import assert from 'node:assert/strict'
import { test } from 'node:test'

import { LIMITS } from '../src/contracts.js'
import { buildFuel, buildGoalFuel, buildJobsFuel, clipFuelText } from '../src/fuel.js'

test('clipFuelText redacts secrets and bounds length', () => {
  assert.equal(clipFuelText('plain objective'), 'plain objective')
  assert.equal(clipFuelText('token: abc123456789'), 'token: «REDACTED:generic-assignment»')
  const long = 'x'.repeat(600)
  assert.equal(clipFuelText(long, 500).length, 501)
  assert.equal(clipFuelText(long, 500).endsWith('…'), true)
  assert.equal(clipFuelText(undefined), '')
})

test('buildGoalFuel normalizes a GoalView and redacts its objective', () => {
  const block = buildGoalFuel({
    goal: {
      id: 'goal-1',
      objective: 'ship it password=hunter2secret',
      phase: 'active',
      roundsStarted: 2,
      maxGoalRounds: 10,
      activation: 'resumed',
      updatedAt: 1792648000000
    }
  })
  assert.equal(block.available, true)
  assert.equal(block.goal.id, 'goal-1')
  assert.equal(block.goal.phase, 'active')
  assert.equal(block.goal.roundsStarted, 2)
  assert.equal(block.goal.activation, 'resumed')
  assert.doesNotMatch(block.goal.objective, /hunter2secret/)
  assert.match(block.goal.objective, /«REDACTED:/)
})

test('buildGoalFuel reports no goal honestly when the service answered', () => {
  const block = buildGoalFuel({})
  assert.equal(block.available, true)
  assert.equal(block.goal, undefined)
  assert.match(block.note, /no current goal/)
  const unavailable = buildGoalFuel({ available: false, note: 'goals service is unavailable in this profile' })
  assert.equal(unavailable.available, false)
  assert.equal(unavailable.note, 'goals service is unavailable in this profile')
})

test('buildJobsFuel aggregates status counts, filters by owner and caps items', () => {
  const jobs = [
    { id: 'job-1', kind: 'bash', label: 'run tests', status: 'running', owner: 'session-1', startedAt: 100 },
    { id: 'job-2', kind: 'bash', label: 'build', status: 'done', owner: 'session-1', startedAt: 50, finishedAt: 90 },
    { id: 'job-3', kind: 'bash', label: 'other session', status: 'running', owner: 'session-2', startedAt: 10 },
    { id: 'job-4', kind: 'bash', label: 'unowned', status: 'failed', startedAt: 1 }
  ]
  const block = buildJobsFuel({ jobs, sessionId: 'session-1', limits: LIMITS })
  assert.equal(block.available, true)
  assert.equal(block.count, 3)
  assert.deepEqual(block.statusCounts, { done: 1, failed: 1, running: 1 })
  assert.deepEqual(block.items.map((item) => item.id), ['job-1', 'job-2', 'job-4'])
  assert.equal(block.items[1].finishedAt, 90)
})

test('buildJobsFuel caps items and reports truncation', () => {
  const jobs = Array.from({ length: 8 }, (_, index) => ({
    id: `job-${index}`,
    kind: 'bash',
    label: `job ${index}`,
    status: index % 2 === 0 ? 'running' : 'done',
    startedAt: index
  }))
  const block = buildJobsFuel({
    jobs,
    limits: { ...LIMITS, fuelMaxJobs: 3 }
  })
  assert.equal(block.items.length, 3)
  assert.match(block.note, /first 3 of 8/)
})

test('buildJobsFuel degrades when the service is unavailable', () => {
  const block = buildJobsFuel({ jobs: undefined })
  assert.equal(block.available, false)
  assert.equal(block.count, 0)
  assert.match(block.note, /unavailable/)
  const custom = buildJobsFuel({ jobs: null, note: 'jobs.list failed: boom' })
  assert.equal(custom.note, 'jobs.list failed: boom')
})

test('buildFuel combines both optional blocks', () => {
  const fuel = buildFuel({
    goal: { id: 'g', objective: 'o', phase: 'active', roundsStarted: 0, maxGoalRounds: 3, updatedAt: 1 },
    jobs: [{ id: 'j', kind: 'k', label: 'l', status: 'running', startedAt: 1 }],
    sessionId: 'session-1'
  })
  assert.equal(fuel.goals.available, true)
  assert.equal(fuel.jobs.available, true)
  assert.equal(fuel.jobs.count, 1)
})
