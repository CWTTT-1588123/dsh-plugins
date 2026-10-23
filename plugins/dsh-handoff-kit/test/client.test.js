/**
 * Client-half registration + i18n + P2-G1 tests without a browser.
 *
 * The bundle is a plain script that registers a lazy factory on
 * `window.__ModuleLoader__`; evaluating it in a VM with a stub React is enough
 * to prove the module definition, slot injection, cleanup, the language
 * switch and the project/session selector — not pixel rendering. Visual
 * behavior is verified in the real page (L1/L2).
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

import { ERROR } from '../src/contracts.js'
import { remedyFor } from '../src/ui.js'

const CLIENT_SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const PACKAGE_JSON = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const EN_JSON = JSON.parse(readFileSync(new URL('../locale/en.json', import.meta.url), 'utf8'))
const ZH_JSON = JSON.parse(readFileSync(new URL('../locale/zh.json', import.meta.url), 'utf8'))
const HAN_RE = /[\u4e00-\u9fff]/

/** Extract one embedded EN_MESSAGES / ZH_MESSAGES table (marker i18n:en / i18n:zh). */
function messagesBlock(marker) {
  const re = new RegExp(`/\\* i18n:${marker} \\*/ (\\{[\\s\\S]*?\\n    \\})`)
  const match = CLIENT_SOURCE.match(re)
  assert.ok(match, `client.js carries the i18n:${marker} table`)
  return { literal: match[1], messages: JSON.parse(match[1]) }
}

const EN = messagesBlock('en')
const ZH = messagesBlock('zh')
const EN_HISTORY_CONTINUE_DISABLED = EN.messages['history.continueDisabled']

/**
 * Evaluate client.js and return the registered module definition.
 * @param {{document?: any, navigator?: any, storage?: any}} [options]
 */
function loadClientDefinition(options = {}) {
  let definition
  const window = {
    __ModuleLoader__: {
      load(input) {
        definition = input
      }
    }
  }
  if (options.storage !== undefined) window.localStorage = options.storage
  const sandbox = { window }
  if ('document' in options) sandbox.document = options.document
  if ('navigator' in options) sandbox.navigator = options.navigator
  vm.runInNewContext(CLIENT_SOURCE, sandbox, { filename: 'client.js' })
  return definition
}

/** Options that make the page report a given language to the client half. */
function languageOptions(language) {
  return {
    document: { documentElement: { lang: language } },
    navigator: { language }
  }
}

/** A minimal in-memory Storage double. */
function fakeStorage() {
  const items = new Map()
  return {
    items,
    getItem(key) {
      return items.has(key) ? items.get(key) : null
    },
    setItem(key, value) {
      items.set(key, String(value))
    },
    removeItem(key) {
      items.delete(key)
    }
  }
}

/** Copy a vm-realm value into this realm so strict deepEqual works. */
function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
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

/** A React double that records element trees so component copy can be read. */
function renderReact() {
  const createElement = (type, props, ...children) => {
    const merged = Object.assign({}, props ?? {})
    if (children.length === 1) merged.children = children[0]
    else if (children.length > 1) merged.children = children
    return { type, props: merged }
  }
  return {
    createElement,
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useEffect() {},
    useSyncExternalStore(_subscribe, getSnapshot) {
      return getSnapshot()
    }
  }
}

/** Collect visible strings, test ids and disabled test ids from a render tree. */
function renderVisible(tree) {
  const texts = []
  const testIds = []
  const disabledIds = []
  const visit = (node) => {
    if (node === null || node === undefined || node === true || node === false) return
    if (typeof node === 'string' || typeof node === 'number') {
      texts.push(String(node))
      return
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    if (typeof node !== 'object') return
    const props = node.props ?? {}
    if (typeof node.type === 'function') {
      visit(node.type(props))
      return
    }
    if (typeof node.type === 'string') {
      if (typeof props['data-testid'] === 'string') {
        testIds.push(props['data-testid'])
        if (props.disabled === true) disabledIds.push(props['data-testid'])
      }
      for (const key of ['title', 'aria-label', 'placeholder', 'alt']) {
        if (typeof props[key] === 'string' && props[key] !== '') texts.push(props[key])
      }
      visit(props.children)
    }
  }
  visit(tree)
  return { texts, testIds, disabledIds }
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

/** Build a plugin instance and its slot registrations. */
function mountedClient(options = {}) {
  const definition = loadClientDefinition(options)
  const plugin = definition.factory(() => renderReact())
  const slots = fakeSlots()
  plugin.apply({ slots })
  const byName = Object.fromEntries(slots.registrations.map((entry) => [entry.options.name, entry]))
  return { definition, plugin, slots, byName }
}

function renderSlot(byName, name, props) {
  assert.ok(byName[name], `slot registration ${name}`)
  return renderVisible(byName[name].component(props))
}

// ------------------------------------------------------------ registration

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

test('apply() injects all four P2 seats and disposes them (English default)', () => {
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
  assert.equal(byName['conversation.input.left'].options.label(), 'Handoff')
  assert.equal(byName['shell.overlay'].options.id, 'handoff-kit.panel')
  assert.equal(byName['sidebar.panellist'].options.id, 'handoff-kit')
  assert.equal(byName['sidebar.panellist'].options.label(), 'Handoff')
  assert.equal(byName.main.options.key, 'handoff-kit')
  for (const entry of slots.registrations) assert.equal(typeof entry.component, 'function')
  dispose()
})

test('a zh-* page language keeps the Chinese labels and copy', () => {
  const { plugin, byName } = mountedClient(languageOptions('zh-CN'))
  assert.equal(plugin._test.locale(), 'zh')
  assert.equal(byName['conversation.input.left'].options.label(), '交接')
  assert.equal(byName['sidebar.panellist'].options.label(), '交接')
  // The floating panel is closed by default, so open it through the shared store.
  const closed = renderSlot(byName, 'shell.overlay', {})
  plugin._test.store.open = true
  const opened = renderSlot(byName, 'shell.overlay', {})
  assert.deepEqual(closed.texts, [])
  assert.ok(opened.texts.includes('交接'))
  assert.ok(opened.texts.includes('生成 / 载入会话交接包'))
  assert.ok(opened.texts.includes('打开工作台'))
})

test('apply() is inert when the composition serves no slots seat', () => {
  const definition = loadClientDefinition()
  const plugin = definition.factory(() => fakeReact())
  assert.equal(typeof plugin.apply({}), 'function')
  assert.equal(typeof plugin.apply({ slots: {} }), 'function')
})

// ------------------------------------------------------------------ i18n

test('detectLocale prefers a saved choice, then a zh browser, then the page language', () => {
  const { plugin } = mountedClient()
  const detect = plugin._test.detectLocale
  assert.equal(detect(undefined, undefined, undefined), 'en')
  assert.equal(detect({ language: 'en-US' }, undefined, undefined), 'en')
  assert.equal(detect({ language: 'zh-CN' }, undefined, undefined), 'zh')
  assert.equal(detect({ languages: ['zh-Hans', 'en'] }, undefined, undefined), 'zh')
  // Reported regression: a Chinese browser must win over an en page lang.
  assert.equal(detect({ language: 'zh-CN' }, { documentElement: { lang: 'en-US' } }, undefined), 'zh')
  // An English browser on a zh page still gets Chinese from the page lang.
  assert.equal(detect({ language: 'en-US' }, { documentElement: { lang: 'zh-TW' } }, undefined), 'zh')
  // The explicit in-UI preference outranks every environment signal.
  assert.equal(detect({ language: 'zh-CN' }, { documentElement: { lang: 'zh-TW' } }, 'en'), 'en')
  assert.equal(detect({ language: 'en-US' }, { documentElement: { lang: 'en-US' } }, 'zh'), 'zh')
  // No signal -> English.
  assert.equal(detect({ language: 'fr-FR' }, undefined, undefined), 'en')
  assert.equal(detect({ languages: ['fr-FR', 'zh-CN'] }, undefined, undefined), 'zh')
})

test('a Chinese browser keeps the Chinese UI even when the page lang is English', () => {
  const { plugin, byName } = mountedClient({
    document: { documentElement: { lang: 'en-US' } },
    navigator: { language: 'zh-CN', languages: ['zh-CN', 'en-US'] }
  })
  assert.equal(plugin._test.locale(), 'zh')
  assert.equal(byName['conversation.input.left'].options.label(), '交接')
  const workbench = renderSlot(byName, 'main', {})
  assert.ok(workbench.texts.includes('交接工作台'))
  assert.ok(workbench.testIds.includes('handoff-locale-toggle'))
  assert.ok(workbench.testIds.includes('handoff-locale-zh'))
  assert.ok(workbench.testIds.includes('handoff-locale-en'))
})

test('the in-UI switch changes the language immediately, persists, and survives a rebuild', () => {
  const storage = fakeStorage()
  const zhPage = mountedClient({
    storage,
    document: { documentElement: { lang: 'zh-CN' } },
    navigator: { language: 'zh-CN' }
  })
  const localeKey = zhPage.plugin._test.localeKey
  assert.equal(localeKey, 'dsh.handoff-kit.locale')
  assert.equal(zhPage.plugin._test.locale(), 'zh')
  const before = renderSlot(zhPage.byName, 'main', {})
  assert.ok(before.texts.includes('交接工作台'))
  assert.ok(before.testIds.includes('handoff-locale-toggle'))

  // Switch to English through the exported helper (the component calls it).
  zhPage.plugin._test.setLocale('en')
  assert.equal(zhPage.plugin._test.locale(), 'en')
  assert.equal(storage.getItem(localeKey), 'en')
  const english = renderSlot(zhPage.byName, 'main', {})
  assert.ok(english.texts.includes('Handoff Workbench'))
  assert.ok(english.texts.includes('Host default (newest live session)'))
  assert.ok(english.texts.includes('Refresh'))
  assert.ok(english.texts.includes('Continue handoff'))
  assert.equal(HAN_RE.test(english.texts.join(' ')), false)

  // The same page can switch back without a reload.
  zhPage.plugin._test.setLocale('zh')
  assert.equal(zhPage.plugin._test.locale(), 'zh')
  assert.equal(storage.getItem(localeKey), 'zh')
  const backToChinese = renderSlot(zhPage.byName, 'main', {})
  assert.ok(backToChinese.texts.includes('交接工作台'))
  assert.ok(backToChinese.texts.includes('继续交接'))

  // A rebuilt module (page reload) reads the saved explicit preference first.
  zhPage.plugin._test.setLocale('en')
  const rebuilt = mountedClient({
    storage,
    document: { documentElement: { lang: 'zh-CN' } },
    navigator: { language: 'zh-CN' }
  })
  assert.equal(rebuilt.plugin._test.locale(), 'en')
  const rebuiltRender = renderSlot(rebuilt.byName, 'main', {})
  assert.ok(rebuiltRender.texts.includes('Handoff Workbench'))
  assert.equal(HAN_RE.test(rebuiltRender.texts.join(' ')), false)
})

test('the floating panel exposes the language switch on both tabs', () => {
  const { plugin, byName } = mountedClient(languageOptions('en-US'))
  plugin._test.store.open = true
  const createTab = renderSlot(byName, 'shell.overlay', {})
  assert.ok(createTab.testIds.includes('handoff-locale-toggle'))
  assert.ok(createTab.texts.includes('Create handoff package'))
  plugin._test.setLocale('zh')
  plugin._test.store.tab = 'load'
  const loadTabZh = renderSlot(byName, 'shell.overlay', {})
  assert.ok(loadTabZh.texts.includes('载入'))
  assert.ok(loadTabZh.testIds.includes('handoff-locale-toggle'))
  assert.ok(loadTabZh.testIds.includes('handoff-locale-en'))
})

test('English is the default when the environment exposes no language', () => {
  const { plugin, byName } = mountedClient()
  assert.equal(plugin._test.locale(), 'en')
  const composer = renderSlot(byName, 'conversation.input.left', { sessionId: 'session-1' })
  assert.ok(composer.texts.includes('Handoff'))
  assert.ok(composer.texts.includes('Handoff: create or load handoff packages'))
  assert.equal(HAN_RE.test(composer.texts.join(' ')), false)
})

test('the workbench renders English by default and Chinese for a zh page', () => {
  const english = mountedClient()
  const workbench = renderSlot(english.byName, 'main', {})
  assert.ok(workbench.texts.includes('Handoff Workbench'))
  assert.ok(workbench.texts.includes('Project / session'))
  assert.ok(workbench.texts.includes('Host default (newest live session)'))
  assert.ok(workbench.texts.includes('Refresh'))
  assert.ok(workbench.texts.includes('Verify'))
  assert.ok(workbench.texts.includes('Back to conversation'))
  assert.ok(
    workbench.texts.includes(
      'A handoff package is the evidence behind the new-session opening prompt; write actions (create / continue) show the target directory first and run only after you click.'
    )
  )
  assert.ok(workbench.testIds.includes('handoff-project-session'))
  assert.ok(workbench.testIds.includes('handoff-session-select'))
  assert.equal(HAN_RE.test(workbench.texts.join(' ')), false)

  const chinese = mountedClient(languageOptions('zh-CN'))
  const zhWorkbench = renderSlot(chinese.byName, 'main', {})
  assert.ok(zhWorkbench.texts.includes('交接工作台'))
  assert.ok(zhWorkbench.texts.includes('项目 / 会话'))
  assert.ok(zhWorkbench.texts.includes('宿主默认（最新活动会话）'))
  assert.ok(zhWorkbench.texts.includes('刷新'))
  assert.ok(zhWorkbench.texts.includes('校验'))
  assert.ok(zhWorkbench.texts.includes('返回对话'))
  assert.ok(zhWorkbench.texts.some((text) => HAN_RE.test(text)))
})

test('formatMessage fills placeholders and falls back to English for unknown locales', () => {
  const { plugin } = mountedClient()
  const format = plugin._test.formatMessage
  assert.equal(format('en', 'panel.project', { name: 'demo' }), 'Project demo')
  assert.equal(format('zh', 'panel.project', { name: 'demo' }), '项目 demo')
  assert.equal(format('en', 'detail.counts', { errors: 2, warnings: 1 }), 'errors: 2 · warnings: 1')
  assert.equal(format('en', 'detail.findingsMore', { count: 3 }), 'and 3 more…')
  // Missing placeholders stay visible instead of printing "undefined".
  assert.equal(format('en', 'panel.project'), 'Project {name}')
  assert.equal(format('fr', 'app.title'), 'Handoff')
  assert.equal(format('en', 'no.such.key'), 'no.such.key')
})

test('every literal t() key exists in the embedded table', () => {
  const keys = new Set([...CLIENT_SOURCE.matchAll(/\bt\('([^']+)'/g)].map((match) => match[1]))
  assert.ok(keys.size > 100, `found ${keys.size} literal t() keys`)
  for (const key of keys) {
    assert.ok(Object.prototype.hasOwnProperty.call(EN.messages, key), `missing i18n key: ${key}`)
  }
})

test('the English and Chinese tables share every key and keep both translations', () => {
  const placeholders = (value) =>
    [...value.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1]).sort()
  const enKeys = Object.keys(EN.messages)
  const zhKeys = Object.keys(ZH.messages)
  assert.deepEqual(plain(zhKeys), enKeys)
  assert.ok(enKeys.length > 100, 'the table covers the whole UI')
  // No duplicate literal keys were silently collapsed by JSON.parse.
  const literalCount = (EN.literal.match(/^      "/gm) ?? []).length
  assert.equal(literalCount, enKeys.length)
  for (const key of enKeys) {
    assert.equal(typeof EN.messages[key], 'string')
    assert.equal(typeof ZH.messages[key], 'string')
    assert.notEqual(EN.messages[key], '')
    assert.notEqual(ZH.messages[key], '')
    assert.equal(HAN_RE.test(EN.messages[key]), false, `English copy is Chinese-free: ${key}`)
    // A translation must keep every placeholder, or `t()` would print "undefined".
    assert.deepEqual(plain(placeholders(ZH.messages[key])), placeholders(EN.messages[key]), key)
  }
  assert.ok(HAN_RE.test(Object.values(ZH.messages).join('')), 'Chinese copy is retained')
  assert.equal(EN.messages['app.title'], 'Handoff')
  assert.equal(ZH.messages['app.title'], '交接')
  // The keys that visibly differ prove this is a translation, not a copy.
  assert.notEqual(EN.messages['app.workbenchTitle'], ZH.messages['app.workbenchTitle'])
})

test('locale/en.json and locale/zh.json mirror the embedded UI tables', () => {
  assert.deepEqual(plain(EN_JSON.ui), plain(EN.messages))
  assert.deepEqual(plain(ZH_JSON.ui), plain(ZH.messages))
  assert.equal(typeof EN_JSON.meta.title, 'string')
  assert.equal(typeof ZH_JSON.meta.title, 'string')
})

test('all user-visible copy lives in the two embedded tables (no stray Chinese)', () => {
  const withoutTables = CLIENT_SOURCE.replace(EN.literal, '').replace(ZH.literal, '')
  const offenders = withoutTables
    .split(/\r?\n/)
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter((entry) => HAN_RE.test(entry.line))
  assert.deepEqual(plain(offenders), [], `Chinese outside the i18n tables: ${JSON.stringify(offenders)}`)
})

test('every HANDOFF_* error code has a localized remedy matching the Host wording', () => {
  const remedyForUnknown = remedyFor('HANDOFF_NOT_A_REAL_CODE')
  for (const code of Object.values(ERROR)) {
    const key = `remedy.${code}`
    assert.ok(Object.prototype.hasOwnProperty.call(EN.messages, key), `English remedy for ${code}`)
    assert.ok(Object.prototype.hasOwnProperty.call(ZH.messages, key), `Chinese remedy for ${code}`)
    assert.equal(HAN_RE.test(EN.messages[key]), false)
    const hostWording = remedyFor(code)
    // The Host itself shares one wording for several codes; the client keeps
    // the Chinese copy byte-identical so switching languages changes only the
    // language, never the advice.
    if (hostWording !== remedyForUnknown) assert.equal(ZH.messages[key], hostWording)
  }
  assert.equal(Object.prototype.hasOwnProperty.call(EN.messages, 'remedy.default'), false)
})

// ------------------------------------------------- P2-G1: project/session

test('projectSessionView reports the resolved project/session and fallback state', () => {
  const { plugin } = mountedClient()
  const view = plugin._test.projectSessionView
  assert.equal(view(null), null)
  assert.equal(view(undefined), null)

  const live = view({
    project: { key: 'proj-1234', name: 'demo-app', workspace: '$WORKSPACE' },
    session: { id: 'session-1', live: true, cwd: 'C:\\ws' }
  })
  assert.deepEqual(plain(live), {
    projectName: 'demo-app',
    projectKey: 'proj-1234',
    workspace: '$WORKSPACE',
    sessionId: 'session-1',
    cwd: 'C:\\ws',
    live: true,
    fallback: false
  })

  const fallback = view({
    project: { key: 'proj-1234', name: 'demo-app', workspace: '$WORKSPACE' },
    session: { id: null, live: false, cwd: 'C:\\fallback' }
  })
  assert.equal(fallback.sessionId, '')
  assert.equal(fallback.live, false)
  assert.equal(fallback.fallback, true)
  assert.equal(fallback.workspace, '$WORKSPACE')

  // Missing project.workspace degrades to the session cwd, never to undefined.
  const cwdOnly = view({ project: { key: '', name: '' }, session: { id: 's', live: true, cwd: 'C:\\ws' } })
  assert.equal(cwdOnly.projectName, '—')
  assert.equal(cwdOnly.workspace, 'C:\\ws')
  assert.equal(cwdOnly.fallback, false)
})

test('sessionChoices puts the Host-resolved and pinned sessions first, then known ones', () => {
  const { plugin } = mountedClient()
  const choices = plugin._test.sessionChoices
  const known = [
    { id: 'known-b', title: 'Batch B' },
    { id: 'known-a', title: '' }
  ]
  assert.deepEqual(plain(choices(known, 'pinned-1', 'resolved-1')), [
    { id: 'resolved-1', title: '' },
    { id: 'pinned-1', title: '' },
    { id: 'known-b', title: 'Batch B' },
    { id: 'known-a', title: '' }
  ])
  // A pinned id that is also the resolved/known one is listed once.
  assert.deepEqual(plain(choices(known, 'known-b', 'known-b')), [
    { id: 'known-b', title: 'Batch B' },
    { id: 'known-a', title: '' }
  ])
  assert.deepEqual(plain(choices(undefined, '', '')), [])
})

test('shortSessionId keeps short ids and abbreviates long ones', () => {
  const { plugin } = mountedClient()
  const short = plugin._test.shortSessionId
  assert.equal(short(''), '')
  assert.equal(short('session-1'), 'session-1')
  assert.equal(short('abcdefghijklmnop'), 'abcdefghijklmnop')
  assert.equal(short('abcdefgh-1234-5678-9012-abcdefabcdef'), 'abcdefgh…cdef')
})

test('knownSessions/rememberSession record, dedupe and bound the client-side list', () => {
  const { plugin } = mountedClient()
  const storage = fakeStorage()
  const known = plugin._test.knownSessions
  const remember = plugin._test.rememberSession

  assert.deepEqual(plain(known(storage)), [])
  remember('session-a', 'Alpha', storage)
  remember('session-b', '', storage)
  assert.deepEqual(plain(known(storage)), [
    { id: 'session-b', title: '' },
    { id: 'session-a', title: 'Alpha' }
  ])
  // Re-recording moves a session to the front and updates its title.
  remember('session-a', 'Alpha v2', storage)
  assert.deepEqual(plain(known(storage)), [
    { id: 'session-a', title: 'Alpha v2' },
    { id: 'session-b', title: '' }
  ])
  // Bounded list: the 9th distinct session evicts the oldest.
  for (let index = 0; index < 8; index += 1) remember(`session-${index}`, '', storage)
  const bounded = known(storage)
  assert.equal(bounded.length, 8)
  assert.equal(bounded[0].id, 'session-7')
  // The last-session hint is written with the same call.
  assert.equal(storage.getItem('dsh.handoff-kit.lastSessionId'), 'session-7')

  // Corrupt or unexpected storage values never throw and never list rows.
  storage.setItem('dsh.handoff-kit.knownSessions', '{not json')
  assert.deepEqual(plain(known(storage)), [])
  storage.setItem('dsh.handoff-kit.knownSessions', '{"id":"x"}')
  assert.deepEqual(plain(known(storage)), [])
  storage.setItem('dsh.handoff-kit.knownSessions', JSON.stringify([{ id: '' }, { id: 7 }, { id: 'ok', title: 3 }]))
  assert.deepEqual(plain(known(storage)), [{ id: 'ok', title: '' }])
  // A frozen/absent storage object is inert, never fatal.
  assert.deepEqual(plain(known({ getItem() { throw new Error('denied') } })), [])
  remember('session-x', '', { setItem() { throw new Error('denied') } })
})

test('bindSession pins the workbench and persists the hint (empty id unbinds)', async () => {
  const storage = fakeStorage()
  const { plugin } = mountedClient({ storage })
  const bind = plugin._test.bindSession
  assert.equal(storage.getItem('dsh.handoff-kit.lastSessionId'), null)
  bind('session-1')
  assert.equal(plugin._test.store.sessionId, 'session-1')
  assert.equal(storage.getItem('dsh.handoff-kit.lastSessionId'), 'session-1')
  // Switching the binding clears the stale detail selection.
  plugin._test.store.detailBatchId = '20261022T023512Z-a1b2'
  bind('session-2')
  assert.equal(plugin._test.store.sessionId, 'session-2')
  assert.equal(plugin._test.store.detailBatchId, '')
  assert.equal(storage.getItem('dsh.handoff-kit.lastSessionId'), 'session-2')
  bind('')
  assert.equal(plugin._test.store.sessionId, '')
  assert.equal(storage.getItem('dsh.handoff-kit.lastSessionId'), null)
  // Let the (stubbed, fetch-less) state refresh settle so no rejection leaks.
  await new Promise((resolve) => setTimeout(resolve, 0))
})

test('the workbench selector surfaces Host fallback instead of hiding it', () => {
  const { plugin, byName } = mountedClient()
  plugin._test.store.state = {
    project: { key: 'proj-1234', name: 'demo-app', workspace: '$WORKSPACE' },
    session: { id: null, live: false, cwd: 'C:\\Users\\test\\.dsh\\profiles\\desktop' },
    batches: [],
    roots: { user: 'C:\\Users\\test\\.dsh\\handoff' }
  }
  const rendered = renderSlot(byName, 'main', {})
  assert.ok(rendered.testIds.includes('handoff-project-session'))
  assert.ok(rendered.texts.includes('Host fallback'))
  assert.ok(
    rendered.texts.some(
      (text) =>
        text.includes('No live session is bound') &&
        text.includes('C:\\Users\\test\\.dsh\\profiles\\desktop')
    )
  )
  assert.ok(rendered.texts.some((text) => text === 'Project: demo-app (proj-1234)'))
  assert.ok(rendered.texts.includes('Session: unbound'))
})

test('the workbench selector names an implicit Host resolution and a stale pin', () => {
  const implicit = mountedClient()
  implicit.plugin._test.store.state = {
    project: { key: 'proj-1234', name: 'demo-app', workspace: '$WORKSPACE' },
    session: { id: 'session-1', live: true, cwd: 'C:\\ws' },
    batches: []
  }
  const implicitRender = renderSlot(implicit.byName, 'main', {})
  assert.equal(implicitRender.texts.includes('Host fallback'), false)
  assert.ok(implicitRender.texts.includes('live'))
  assert.ok(
    implicitRender.texts.some(
      (text) => text.includes('not explicitly bound') && text.includes('session-1')
    )
  )

  const stale = mountedClient()
  stale.plugin._test.store.sessionId = 'session-gone'
  stale.plugin._test.store.state = {
    project: { key: 'proj-1234', name: 'demo-app', workspace: '$WORKSPACE' },
    session: { id: 'session-1', live: true, cwd: 'C:\\ws' },
    batches: []
  }
  const staleRender = renderSlot(stale.byName, 'main', {})
  assert.ok(
    staleRender.texts.some(
      (text) => text.includes('session-gone') && text.includes('session-1') && text.includes('not live')
    )
  )
})

// -------------------------------------- project-key history fallback (P3)

/** State shape the Host returns when the current project key has no batches. */
function historyState() {
  return {
    project: { key: 'ws-newkey01', name: 'demo-app', workspace: '$WORKSPACE' },
    session: { id: 'session-1', live: true, cwd: 'C:\\ws' },
    batches: [
      {
        batchId: '20261022T023512Z-a1b2',
        dir: '$DSH_HOME/handoff/old-key-11111111/20261022T023512Z-a1b2',
        projectKey: 'old-key-11111111',
        title: 'old one',
        createdAt: '2026-10-22T02:35:12.000Z',
        complete: true,
        artifacts: 3,
        bytes: 120
      },
      {
        batchId: '20261022T023512Z-c3d4',
        dir: '$DSH_HOME/handoff/other-key-22222222/20261022T023512Z-c3d4',
        projectKey: 'other-key-22222222',
        title: null,
        createdAt: '2026-10-22T02:35:12.000Z',
        complete: true,
        artifacts: 2,
        bytes: 80
      }
    ],
    history: {
      active: true,
      currentProjectKey: 'ws-newkey01',
      projectKeys: ['old-key-11111111', 'other-key-22222222'],
      dir: '$DSH_HOME/handoff'
    },
    roots: { user: 'C:\\Users\\test\\.dsh\\handoff' },
    warnings: [
      {
        code: 'PROJECT_KEY_FALLBACK',
        detail: 'current project key ws-newkey01 has no batches; showing 2 historical batch(es)'
      }
    ]
  }
}

test('groupBatchesByProject groups in list order and skips malformed rows', () => {
  const { plugin } = mountedClient()
  const group = plugin._test.groupBatchesByProject
  assert.deepEqual(plain(group([])), [])
  assert.deepEqual(
    plain(
      group([
        { batchId: 'b1', projectKey: 'k1' },
        { batchId: 'b2', projectKey: 'k2' },
        null,
        { batchId: 'b3', projectKey: 'k1' },
        { batchId: 'b4' }
      ])
    ),
    [
      { projectKey: 'k1', batches: [{ batchId: 'b1', projectKey: 'k1' }, { batchId: 'b3', projectKey: 'k1' }] },
      { projectKey: 'k2', batches: [{ batchId: 'b2', projectKey: 'k2' }] },
      { projectKey: '', batches: [{ batchId: 'b4' }] }
    ]
  )
})

test('the workbench groups historical batches and warns it is read-only', () => {
  const { plugin, byName } = mountedClient()
  plugin._test.store.state = historyState()
  const rendered = renderSlot(byName, 'main', {})
  assert.ok(rendered.testIds.includes('handoff-history-notice'))
  assert.ok(rendered.testIds.filter((id) => id === 'handoff-history-group').length >= 2)
  assert.ok(rendered.texts.includes('Historical project (read-only)'))
  assert.ok(
    rendered.texts.some(
      (text) =>
        text.includes('Current project ws-newkey01 has no batches') &&
        text.includes('old-key-11111111') &&
        text.includes('other-key-22222222') &&
        text.includes('read-only')
    )
  )
  // Project keys are the group headers.
  assert.ok(rendered.texts.includes('old-key-11111111'))
  assert.ok(rendered.texts.includes('other-key-22222222'))
  // The continue/append write path is refused while historical batches are shown.
  assert.ok(rendered.disabledIds.includes('handoff-continue'))
  assert.ok(rendered.texts.includes(EN_HISTORY_CONTINUE_DISABLED))
  assert.equal(HAN_RE.test(rendered.texts.join(' ')), false)
})

test('the historical-batch warning renders in Chinese too', () => {
  const { plugin, byName } = mountedClient(languageOptions('zh-CN'))
  plugin._test.store.state = historyState()
  const rendered = renderSlot(byName, 'main', {})
  assert.ok(rendered.texts.includes('历史项目（只读）'))
  assert.ok(
    rendered.texts.some(
      (text) => text.includes('当前项目 ws-newkey01 没有批次') && text.includes('只读显示')
    )
  )
  assert.ok(rendered.disabledIds.includes('handoff-continue'))
  assert.ok(rendered.texts.some((text) => text.includes('查看历史批次时无法继续交接')))
})

test('the Load tab shows the same historical grouping and banner', () => {
  const { plugin, byName } = mountedClient()
  plugin._test.store.state = historyState()
  plugin._test.store.open = true
  plugin._test.store.tab = 'load'
  const rendered = renderSlot(byName, 'shell.overlay', {})
  assert.ok(rendered.testIds.includes('handoff-history-notice'))
  assert.ok(rendered.testIds.includes('handoff-history-group'))
  assert.ok(rendered.texts.includes('Historical project (read-only)'))
  assert.ok(rendered.texts.includes('20261022T023512Z-a1b2'))
  assert.ok(rendered.texts.includes('20261022T023512Z-c3d4'))
})
