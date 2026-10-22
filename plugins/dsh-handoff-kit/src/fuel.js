/**
 * P1/M2 read-only "fuel": current goal and background jobs presented as
 * deterministic evidence.
 *
 * Both host services are optional (`ctx.get('goals')`, `ctx.get('jobs')`), so
 * every failure mode degrades to `available:false` + a reason instead of
 * blocking `create`. No auto-execution and no mutation: this module only reads
 * and normalizes plain JSON views. Pure: no clock, no filesystem, no service.
 *
 * @module dsh-handoff-kit/fuel
 */

import { LIMITS } from './contracts.js'
import { redactText } from './redact.js'

/** Clip a free-text field through the redactor and the fuel text bound. */
export function clipFuelText(value, maxChars = LIMITS.fuelTextChars) {
  if (typeof value !== 'string' || value === '') return ''
  const redacted = redactText(value).text
  return redacted.length > maxChars ? `${redacted.slice(0, maxChars)}…` : redacted
}

function integerOr(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback
}

/**
 * Normalize one `GoalView` into the manifest fuel goals block.
 *
 * `available` describes whether the goals service could answer for this agent;
 * a live service with no current goal is `available:true` and a `note`, not an
 * unavailable service. `goal` is present only when a goal view exists.
 * @param {{goal: object|null|undefined, available?: boolean, note?: string}} input
 */
export function buildGoalFuel({ goal, available = true, note } = {}) {
  const block = { available: available === true }
  if (goal !== null && typeof goal === 'object') {
    block.available = true
    block.goal = {
      id: typeof goal.id === 'string' ? goal.id : '',
      objective: clipFuelText(goal.objective),
      phase: typeof goal.phase === 'string' ? goal.phase : '',
      roundsStarted: integerOr(goal.roundsStarted, 0),
      maxGoalRounds: integerOr(goal.maxGoalRounds, 0),
      updatedAt: integerOr(goal.updatedAt, 0)
    }
    if (typeof goal.activation === 'string') block.goal.activation = goal.activation
  }
  if (block.available && block.goal === undefined) {
    block.note = typeof note === 'string' && note !== '' ? note : 'no current goal for this agent'
  } else if (!block.available) {
    block.note = typeof note === 'string' && note !== '' ? note : 'goals service is unavailable'
  } else if (typeof note === 'string' && note !== '') {
    block.note = note
  }
  return block
}

/**
 * Normalize `ctx.jobs.list(caller)` into the manifest fuel jobs block.
 * @param {{jobs: unknown[]|null|undefined, sessionId?: string|null, limits?: typeof LIMITS, note?: string}} input
 */
export function buildJobsFuel({ jobs, sessionId, limits = LIMITS, note } = {}) {
  if (!Array.isArray(jobs)) {
    const block = { available: false, count: 0, statusCounts: {}, items: [] }
    block.note = typeof note === 'string' && note !== '' ? note : 'jobs service is unavailable'
    return block
  }
  const visible = jobs.filter((job) => {
    if (job === null || typeof job !== 'object') return false
    if (sessionId === undefined || sessionId === null) return true
    return job.owner === undefined || job.owner === sessionId
  })
  const statusCounts = {}
  for (const job of visible) {
    const status = typeof job.status === 'string' && job.status !== '' ? job.status : 'unknown'
    statusCounts[status] = (statusCounts[status] ?? 0) + 1
  }
  const sortedStatusCounts = {}
  for (const key of Object.keys(statusCounts).sort()) sortedStatusCounts[key] = statusCounts[key]
  const items = visible.slice(0, limits.fuelMaxJobs).map((job) => {
    const item = {
      id: typeof job.id === 'string' ? job.id : '',
      kind: typeof job.kind === 'string' ? job.kind : '',
      label: clipFuelText(job.label),
      status: typeof job.status === 'string' ? job.status : 'unknown',
      startedAt: integerOr(job.startedAt, 0)
    }
    if (Number.isInteger(job.finishedAt)) item.finishedAt = job.finishedAt
    const progress = typeof job.progress === 'string' ? job.progress : job.detail
    if (typeof progress === 'string' && progress !== '') item.progress = clipFuelText(progress)
    return item
  })
  const block = {
    available: true,
    count: visible.length,
    statusCounts: sortedStatusCounts,
    items
  }
  if (visible.length > limits.fuelMaxJobs)
    block.note = `only the first ${limits.fuelMaxJobs} of ${visible.length} jobs are listed`
  if (typeof note === 'string' && note !== '') block.note = note
  return block
}

/** Assemble the manifest fuel block from the two optional service reads. */
export function buildFuel({ goal, jobs, sessionId, limits = LIMITS, goalAvailable, goalNote, jobsNote } = {}) {
  return {
    goals: buildGoalFuel({ goal, available: goalAvailable, note: goalNote }),
    jobs: buildJobsFuel({ jobs, sessionId, limits, note: jobsNote })
  }
}
