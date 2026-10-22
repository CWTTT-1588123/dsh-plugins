/**
 * Client-half registration tests without a browser.
 *
 * The bundle is a plain script that registers a lazy factory on
 * `window.__ModuleLoader__`; evaluating it in a VM with a stub React is enough
 * to prove the module definition, the slot injection points and the cleanup —
 * not the rendering. Visual behavior is verified in the real page (L1/L2).
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const CLIENT_SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const PACKAGE_JSON = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

/** Evaluate client.js and return the registered module definition. */
function loadClientDefinition() {
  let definition
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(input) {
          definition = input
        }
      }
    }
  }
  vm.runInNewContext(CLIENT_SOURCE, sandbox, { filename: 'client.js' })
  return definition
}

/** The slice of React the factory touches at registration time. */
function fakeReact() {
  return {
    createElement() {
      return null
    },
    useState(value) {
      return [value, () => {}]
    },
    useEffect() {},
    useSyncExternalStore(_subscribe, getSnapshot) {
      return getSnapshot()
    }
  }
}

/** A slots double that runs each injection callback like the shell does. */
function fakeSlots() {
  const slots = {
    injected: [],
    registrations: [],
    inject(key, callback) {
      slots.injected.push(key)
      const dispose = callback()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    register(options, component) {
      slots.registrations.push({ options, component })
      return () => {
        slots.registrations = slots.registrations.filter((entry) => entry.options !== options)
      }
    }
  }
  return slots
}

test('client.js registers the package-named lazy factory', () => {
  const definition = loadClientDefinition()
  assert.equal(definition.id, PACKAGE_JSON.name)
  assert.equal(typeof definition.factory, 'function')
  const plugin = definition.factory((request) => {
    assert.equal(request, 'react')
    return fakeReact()
  })
  assert.deepEqual([...plugin.inject], ['slots'])
  assert.equal(typeof plugin.apply, 'function')
})

test('apply() injects all four P2 seats and disposes them', () => {
  const definition = loadClientDefinition()
  const plugin = definition.factory(() => fakeReact())
  const slots = fakeSlots()
  const ctx = { slots }
  const dispose = plugin.apply(ctx)
  assert.deepEqual(slots.injected, [
    'conversation.input.left',
    'shell.overlay',
    'sidebar.panellist',
    'main'
  ])
  const byName = Object.fromEntries(slots.registrations.map((entry) => [entry.options.name, entry]))
  assert.equal(byName['conversation.input.left'].options.id, 'handoff')
  assert.equal(typeof byName['conversation.input.left'].options.label, 'function')
  assert.equal(byName['conversation.input.left'].options.label(), '交接')
  assert.equal(byName['shell.overlay'].options.id, 'handoff-kit.panel')
  assert.equal(byName['sidebar.panellist'].options.id, 'handoff-kit')
  assert.equal(byName['sidebar.panellist'].options.label(), '交接')
  assert.equal(byName.main.options.key, 'handoff-kit')
  for (const entry of slots.registrations) assert.equal(typeof entry.component, 'function')
  dispose()
})

test('apply() is inert when the composition serves no slots seat', () => {
  const definition = loadClientDefinition()
  const plugin = definition.factory(() => fakeReact())
  assert.equal(typeof plugin.apply({}), 'function')
  assert.equal(typeof plugin.apply({ slots: {} }), 'function')
})
