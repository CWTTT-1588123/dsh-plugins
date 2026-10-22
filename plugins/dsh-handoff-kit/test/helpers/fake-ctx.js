/**
 * Minimal Cordis-context double for assembly tests: it records the tool,
 * command and skill registrations `apply()` makes, exposes the services the
 * plugin injects, and models `sandboxPolicy.resolve` plus the session /
 * working-directory lookup used to derive workspace and policy.
 *
 * @module test/helpers/fake-ctx
 */

import { createFakeFs } from './fake-fs.js'

/**
 * @param {{
 *   fs?: ReturnType<typeof createFakeFs>,
 *   session?: {id: string, events?: unknown[], cwd?: string, header?: {cwd?: string}} | null,
 *   mode?: string,
 *   workspaceRoot?: string,
 *   dshHome?: string,
 *   defaultDirectory?: string,
 *   sessionId?: string
 * }} [options]
 */
export function createFakeCtx(options = {}) {
  const workspaceRoot = options.fs?.root ?? options.workspaceRoot ?? 'C:\\ws'
  const fs = options.fs ?? createFakeFs({ root: workspaceRoot })
  const dshHome = options.dshHome ?? 'C:\\Users\\test\\.dsh'
  const mode = options.mode ?? 'danger-full-access'
  const sessionId = options.sessionId ?? 'session-test'
  const defaultDirectory = options.defaultDirectory ?? workspaceRoot
  const session =
    options.session === undefined
      ? { id: sessionId, header: { cwd: workspaceRoot }, events: [], ownEvents: () => [] }
      : options.session === null
        ? undefined
        : {
            id: options.session.id ?? sessionId,
            header: { cwd: options.session.cwd ?? workspaceRoot },
            events: options.session.events ?? [],
            ownEvents() {
              return this.events
            }
          }

  const registered = { tools: [], commands: [], skillProviders: [] }
  const effects = []
  const services = {}

  const sandboxPolicy = {
    defaultMode: mode,
    workspaceRoot,
    resolve(request = {}) {
      const resolvedMode = request.mode ?? mode
      const resolvedRoot = request.session?.header?.cwd ?? workspaceRoot
      return { mode: resolvedMode, workspaceRoot: resolvedRoot, sessionId: request.session?.id ?? sessionId }
    },
    overrideOf() {
      return undefined
    }
  }

  const sessions = {
    get(id) {
      return session !== undefined && session.id === id ? session : undefined
    },
    list() {
      return session === undefined ? [] : [session]
    }
  }

  const workingDirectory = {
    defaultDirectory,
    get(source) {
      return source?.header?.cwd ?? defaultDirectory
    },
    async ensure() {
      return defaultDirectory
    }
  }

  Object.assign(services, { fs, sessions, sandboxPolicy, workingDirectory })
  // Extra optional services injected by tests (workspaceChanges, goals, jobs).
  Object.assign(services, options.services ?? {})

  const ctx = {
    fs,
    sessions,
    sandboxPolicy,
    workingDirectory,
    registered,
    services,
    dshHome,
    get(name) {
      return services[name]
    },
    effect(executor, label) {
      const disposer = executor()
      if (typeof disposer === 'function') effects.push(disposer)
      else if (disposer !== undefined && disposer !== null && typeof disposer.then === 'function')
        effects.push(() => disposer)
      return () => {}
    },
    tools: {
      register(definition) {
        registered.tools.push(definition)
        return () => {}
      },
      get(name) {
        return registered.tools.find((tool) => tool.name === name)
      }
    },
    commands: {
      register(definition) {
        registered.commands.push(definition)
        return () => {}
      },
      find(name) {
        return registered.commands.find((command) => command.name === name)
      }
    },
    skills: {
      registerProvider(create) {
        registered.skillProviders.push(create)
        return () => {}
      }
    },
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {}
    },
    /** Run every registered effect disposer (reverse order), like fiber dispose. */
    async dispose() {
      for (const disposer of effects.reverse()) await disposer()
    }
  }

  return ctx
}

/**
 * Build a settled tool execution context as the registry would pass it.
 * @param {Record<string, unknown>} [options]
 */
export function createExec(options = {}) {
  const controller = new AbortController()
  return {
    callId: 'call-1',
    name: 'handoff_pack',
    arguments: options.arguments ?? {},
    agent: options.agent,
    signal: options.signal ?? controller.signal,
    controller
  }
}
