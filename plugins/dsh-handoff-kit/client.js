/**
 * dsh-handoff-kit Client half (plain browser module; no build step).
 *
 * Loaded lazily by the Web module system as this package's `./client` export.
 * It registers four surfaces:
 *   - a 「交接」 button at the left of the conversation composer
 *     (`conversation.input.left`),
 *   - a frame-wide floating panel (`shell.overlay`),
 *   - a sidebar panel icon and its center page (`sidebar.panellist` + `main`).
 *
 * Every piece of data comes from the Host half's authenticated `/api` route
 * (`/api/handoff-kit/rpc`): this file renders and copies, it does not parse
 * manifests, verify hashes or read the filesystem.
 *
 * Zero dependencies: React arrives from the module table, styles use the
 * host's `--dsw-alias-*` theme tokens.
 */

window.__ModuleLoader__.load({
  id: 'dsh-handoff-kit',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Authenticated Host route registered by src/ui.js. */
    const RPC_PATH = '/api/handoff-kit/rpc'
    const PROTOCOL = 1
    /**
     * Last conversation session this page saw. A root-scoped workbench surface
     * has no session binding of its own, and the Host falls back to the newest
     * live root session when this hint is stale or missing.
     */
    const SESSION_HINT_KEY = 'dsh.handoff-kit.lastSessionId'
    /** Shared by the sidebar row and the `main` page (layout dispatches by key). */
    const PANEL_ID = 'handoff-kit'
    const BUTTON_ID = 'handoff'
    const BUTTON_ORDER = 40

    // ---------------------------------------------------------------- theme
    const T = {
      base: 'var(--dsw-alias-bg-base)',
      layer1: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      overlay: 'var(--dsw-alias-bg-overlay)',
      border1: 'var(--dsw-alias-border-l1)',
      border2: 'var(--dsw-alias-border-l2)',
      text: 'var(--dsw-alias-label-primary)',
      text2: 'var(--dsw-alias-label-secondary)',
      brand: 'var(--dsw-alias-brand-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      success: 'var(--dsw-alias-state-success-primary)'
    }
    const FONT =
      'var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif)'
    const MONO = 'ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace'

    // ---------------------------------------------------------------- store
    /** One tiny observable store shared by the four slot components. */
    const store = {
      version: 0,
      open: false,
      tab: 'create',
      sessionId: undefined,
      sessionTitle: '',
      inputActions: null,
      state: null,
      stateError: null,
      loading: false,
      target: 'user',
      selectedBatchId: null,
      toast: null,
      // create tab
      createTitle: '',
      createSummary: '',
      createIncludeDiffs: false,
      createBusy: false,
      createResult: null,
      createError: null,
      // opening prompt (copy)
      promptText: '',
      promptBatchId: '',
      promptTrust: '',
      promptError: null,
      copying: false,
      // load tab / detail
      detailBatchId: '',
      detail: null,
      detailLoading: false,
      detailError: null,
      // continue (append/update) from the workbench
      continueOpen: false,
      continueMode: 'append',
      continueConfirm: false,
      continueBaseId: '',
      continueIncludeDiffs: false,
      continueTitle: '',
      continueSummary: '',
      continueBusy: false,
      continueError: null,
      continueResult: null
    }
    const listeners = new Set()
    function subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
    function getVersion() {
      return store.version
    }
    function set(patch) {
      Object.assign(store, patch)
      store.version += 1
      for (const listener of Array.from(listeners)) listener()
    }
    function useStoreVersion() {
      return React.useSyncExternalStore(subscribe, getVersion)
    }

    // ------------------------------------------------------------ host RPC
    function uiError(code, message, remedy) {
      const error = new Error(message)
      error.code = code
      error.remedy = remedy
      return error
    }

    /**
     * One JSON request to this bundle's Host half.
     * @param {string} method `state` | `detail` | `copy` | `create`
     * @param {Record<string, unknown>} [params]
     */
    async function callHost(method, params) {
      let response
      try {
        response = await fetch(RPC_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ protocol: PROTOCOL, method, params: params ?? {} })
        })
      } catch {
        throw uiError(
          'HANDOFF_UI_UNREACHABLE',
          '无法连接宿主服务（页面或宿主可能正在重启）。',
          '刷新页面后重试；若仍失败，确认插件已启用且页面由本机 DSH 提供。'
        )
      }
      const text = await response.text()
      let payload = null
      try {
        payload = text === '' ? null : JSON.parse(text)
      } catch {
        throw uiError('HANDOFF_UI_BAD_RESPONSE', '宿主返回了无法解析的响应。', '重试；仍失败时查看 DSH 日志。')
      }
      if (payload !== null && payload.ok === true) return payload.value
      const failure = payload !== null && typeof payload === 'object' ? payload.error : undefined
      throw uiError(
        failure !== undefined && typeof failure.code === 'string' ? failure.code : `HTTP_${response.status}`,
        failure !== undefined && typeof failure.message === 'string' ? failure.message : '宿主请求失败',
        failure !== undefined && typeof failure.remedy === 'string' ? failure.remedy : '重试一次。'
      )
    }

    function describeError(error) {
      if (error === null || error === undefined) return { code: '', message: '', remedy: '' }
      return {
        code: typeof error.code === 'string' ? error.code : '',
        message: error instanceof Error ? error.message : String(error),
        remedy: typeof error.remedy === 'string' ? error.remedy : ''
      }
    }

    function showToast(message) {
      set({ toast: message })
      setTimeout(() => {
        if (store.toast === message) set({ toast: null })
      }, 2600)
    }

    function sessionParams() {
      const params = {}
      if (typeof store.sessionId === 'string' && store.sessionId !== '') params.sessionId = store.sessionId
      return params
    }

    async function refreshState(options) {
      const sessionId = options !== undefined && 'sessionId' in options ? options.sessionId : store.sessionId
      const target = (options !== undefined && options.target) || store.target || 'user'
      set({ loading: true, stateError: null, target })
      const params = { target }
      if (typeof sessionId === 'string' && sessionId !== '') params.sessionId = sessionId
      try {
        const state = await callHost('state', params)
        set({ state, loading: false })
      } catch (error) {
        set({ loading: false, stateError: error })
      }
    }

    function openPanel() {
      const prefill = store.createTitle !== '' ? store.createTitle : store.sessionTitle
      set({ open: true, createTitle: typeof prefill === 'string' ? prefill : '', createError: null })
      void refreshState({})
    }
    function closePanel() {
      set({ open: false })
    }

    /** Clipboard write; returns false when the browser refuses (no DOM fallback). */
    async function copyText(text) {
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch {
        /* fall through to the manual-copy hint */
      }
      return false
    }

    /** Navigate to this bundle's center page through the layout service. */
    let pluginCtx = null
    function selectMainPanel(panelId) {
      try {
        const layout = pluginCtx !== null ? (pluginCtx.layout ?? pluginCtx.get?.('layout')) : undefined
        if (layout !== undefined && typeof layout.selectPanel === 'function') layout.selectPanel(panelId)
      } catch {
        /* the shell may not expose layout in a reduced composition */
      }
    }
    function openWorkbench() {
      set({ open: false })
      selectMainPanel(PANEL_ID)
    }

    // ----------------------------------------------------------- actions
    /** Generate one package through the Host service, then optionally copy. */
    async function performCreate(options) {
      if (store.createBusy) return
      const copyAfter = options !== undefined && options.copy === true
      const params = Object.assign({ mode: 'create', target: store.target || 'user' }, sessionParams())
      const title = store.createTitle.trim()
      const summary = store.createSummary.trim()
      if (title !== '') params.title = title
      if (summary !== '') params.summary = summary
      if (store.createIncludeDiffs === true) params.includeDiffs = true
      set({ createBusy: true, createError: null, createResult: null, promptText: '', promptError: null })
      try {
        const result = await callHost('create', params)
        set({ createBusy: false, createResult: result })
        await refreshState({})
        if (copyAfter) await performCopy(result.batchId)
      } catch (error) {
        set({ createBusy: false, createError: error })
      }
    }

    /** Build the new-session opening prompt for a batch. Read-only. */
    async function fetchPromptText(batchId) {
      const params = Object.assign({ target: store.target || 'user' }, sessionParams())
      if (typeof batchId === 'string' && batchId !== '') params.batchId = batchId
      const result = await callHost('copy', params)
      set({
        promptText: result.text,
        promptBatchId: result.batchId,
        promptTrust: result.trust,
        promptError: null
      })
      return result.text
    }

    /** Build the opening prompt for a batch and copy it. Read-only. */
    async function performCopy(batchId) {
      if (store.copying) return
      const explicit = typeof batchId === 'string' && batchId !== '' ? batchId : store.createResult?.batchId
      set({ copying: true, promptError: null })
      try {
        const text = await fetchPromptText(explicit)
        const copied = await copyText(text)
        set({ copying: false })
        showToast(copied ? '开场提示词已复制' : '无法自动复制：请手动选择文本')
      } catch (error) {
        set({ copying: false, promptError: error })
      }
    }

    /** Verify one batch and load its bounded detail. Read-only. */
    async function performDetail(batchId) {
      if (typeof batchId !== 'string' || batchId === '') return
      const params = Object.assign({ target: store.target || 'user', batchId }, sessionParams())
      set({ detailBatchId: batchId, detailLoading: true, detailError: null })
      try {
        const detail = await callHost('detail', params)
        set({ detail, detailLoading: false })
      } catch (error) {
        set({ detailLoading: false, detail: null, detailError: error })
      }
    }

    /** Put the opening prompt into the composer draft (no clipboard needed). */
    async function insertPrompt(batchId) {
      try {
        let text = store.promptText
        const reused = store.promptBatchId === batchId && typeof text === 'string' && text !== ''
        if (!reused) text = await fetchPromptText(batchId)
        const actions = store.inputActions
        if (actions === null || actions === undefined || typeof actions.setDraft !== 'function') {
          showToast('无法插入：请从输入框「交接」按钮打开面板')
          return
        }
        actions.setDraft(text)
        closePanel()
        showToast('已插入输入框')
      } catch (error) {
        set({ promptError: error })
      }
    }

    // ------------------------------------------------- continue (append/update)
    function openContinue(mode) {
      const batches = store.state !== null && Array.isArray(store.state.batches) ? store.state.batches : []
      set({
        continueOpen: true,
        continueMode: mode === 'update' ? 'update' : 'append',
        continueConfirm: false,
        // Capture the base at open time: after the write, the list's newest
        // batch is the NEW one, so re-deriving the base would mislabel it.
        continueBaseId: batches.length > 0 ? batches[0].batchId : '',
        continueBusy: false,
        continueError: null,
        continueResult: null
      })
    }

    function closeContinue() {
      set({
        continueOpen: false,
        continueConfirm: false,
        continueBusy: false,
        continueError: null,
        continueResult: null
      })
    }

    /**
     * Write the next generation through the existing service. The old batch is
     * never modified: `append` links `previous`, `update` also records
     * `supersedes`, both in a NEW batch directory.
     */
    async function performContinue() {
      if (store.continueBusy) return
      const mode = store.continueMode === 'update' ? 'update' : 'append'
      const params = Object.assign({ mode, target: store.target || 'user' }, sessionParams())
      const baseId = store.continueBaseId
      if (typeof baseId === 'string' && baseId !== '') {
        // Pin the lineage target the dialog showed, so the write matches it even
        // if another batch appeared in between.
        if (mode === 'update') params.supersedes = baseId
        else params.previousBatchId = baseId
      }
      const title = store.continueTitle.trim()
      const summary = store.continueSummary.trim()
      if (title !== '') params.title = title
      if (summary !== '') params.summary = summary
      if (store.continueIncludeDiffs === true) params.includeDiffs = true
      set({ continueBusy: true, continueError: null, continueResult: null, continueConfirm: false })
      try {
        const result = await callHost('create', params)
        set({ continueBusy: false, continueResult: result })
        await refreshState({})
        set({ detailBatchId: result.batchId, selectedBatchId: result.batchId })
        await performDetail(result.batchId)
      } catch (error) {
        set({ continueBusy: false, continueError: error })
      }
    }

    // -------------------------------------------------------- presentations
    function formatBytes(value) {
      const bytes = Number(value)
      if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
      return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
    }

    function formatTime(value) {
      if (typeof value !== 'string' || value === '') return '—'
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return value
      const pad = (number) => String(number).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function trustColor(trust) {
      if (trust === 'verified') return T.success
      if (trust === 'invalid') return T.error
      return T.warn
    }

    // -------------------------------------------------------------- atoms
    function Button(props) {
      const [hover, setHover] = React.useState(false)
      const primary = props.primary === true
      const disabled = props.disabled === true
      const base = {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        height: 30,
        padding: '0 12px',
        borderRadius: 7,
        border: `1px solid ${primary ? 'transparent' : T.border1}`,
        background: primary ? T.brand : hover && !disabled ? T.layer2 : 'transparent',
        color: primary ? '#ffffff' : props.danger === true ? T.error : T.text,
        fontFamily: FONT,
        fontSize: 12.5,
        lineHeight: '1',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.55 : 1,
        whiteSpace: 'nowrap'
      }
      return h(
        'button',
        {
          type: 'button',
          disabled,
          title: props.title,
          onClick: disabled ? undefined : props.onClick,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: Object.assign(base, props.style ?? {})
        },
        props.children
      )
    }

    function Badge({ text, color }) {
      return h(
        'span',
        {
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            height: 19,
            padding: '0 7px',
            borderRadius: 10,
            border: `1px solid ${color}`,
            color,
            fontFamily: FONT,
            fontSize: 11,
            lineHeight: '1',
            whiteSpace: 'nowrap'
          }
        },
        text
      )
    }

    function ErrorNotice({ error }) {
      const described = describeError(error)
      if (described.message === '') return null
      return h(
        'div',
        {
          style: {
            border: `1px solid ${T.error}`,
            background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent)',
            borderRadius: 8,
            padding: '9px 11px',
            margin: '10px 0',
            fontFamily: FONT,
            fontSize: 12,
            lineHeight: 1.6,
            color: T.text
          }
        },
        h('div', { style: { fontWeight: 600, color: T.error } }, described.code === '' ? '请求失败' : described.code),
        h('div', null, described.message),
        described.remedy === '' ? null : h('div', { style: { color: T.text2 } }, `修法：${described.remedy}`)
      )
    }

    function KeyValue({ label, children, mono }) {
      return h(
        'div',
        { style: { display: 'flex', gap: 10, alignItems: 'baseline', padding: '2px 0', minWidth: 0 } },
        h('span', { style: { flex: '0 0 auto', color: T.text2, fontFamily: FONT, fontSize: 12 } }, label),
        h(
          'span',
          {
            style: {
              flex: '1 1 auto',
              minWidth: 0,
              overflowWrap: 'anywhere',
              fontFamily: mono === true ? MONO : FONT,
              fontSize: 12
            }
          },
          children
        )
      )
    }

    function Field({ label, hint, children }) {
      return h(
        'label',
        { style: { display: 'block', marginBottom: 10 } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 } },
          h('span', { style: { fontFamily: FONT, fontSize: 12, color: T.text } }, label),
          hint === undefined ? null : h('span', { style: { fontFamily: FONT, fontSize: 11, color: T.text2 } }, hint)
        ),
        children
      )
    }

    const inputStyle = {
      width: '100%',
      boxSizing: 'border-box',
      background: T.base,
      border: `1px solid ${T.border1}`,
      borderRadius: 7,
      color: T.text,
      fontFamily: FONT,
      fontSize: 12.5,
      lineHeight: 1.55,
      padding: '6px 9px',
      outline: 'none'
    }

    function TextInput(props) {
      return h('input', {
        type: 'text',
        value: props.value,
        placeholder: props.placeholder,
        maxLength: props.maxLength,
        disabled: props.disabled,
        onChange: (event) => props.onChange(event.target.value),
        style: Object.assign({}, inputStyle, { height: 32 })
      })
    }

    function TextArea(props) {
      return h('textarea', {
        value: props.value,
        placeholder: props.placeholder,
        rows: props.rows ?? 3,
        maxLength: props.maxLength,
        onChange: (event) => props.onChange(event.target.value),
        style: Object.assign({}, inputStyle, { resize: 'vertical', minHeight: 58 })
      })
    }

    function Choice(props) {
      return h(
        'button',
        {
          type: 'button',
          onClick: props.onClick,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            height: 28,
            padding: '0 11px',
            borderRadius: 14,
            border: `1px solid ${props.active ? T.brand : T.border1}`,
            background: props.active ? 'color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent)' : 'transparent',
            color: props.active ? T.brand : T.text2,
            fontFamily: FONT,
            fontSize: 12,
            cursor: 'pointer'
          }
        },
        props.children
      )
    }

    function Checkbox(props) {
      return h(
        'label',
        { style: { display: 'inline-flex', alignItems: 'center', gap: 7, cursor: 'pointer', fontFamily: FONT, fontSize: 12, color: T.text } },
        h('input', {
          type: 'checkbox',
          checked: props.checked,
          onChange: (event) => props.onChange(event.target.checked),
          style: { accentColor: 'var(--dsw-alias-brand-primary)', width: 14, height: 14, margin: 0 }
        }),
        props.children
      )
    }

    // ------------------------------------------------------------- glyph
    function HandoffGlyph({ size, dim }) {
      const edge = typeof size === 'number' ? size : 16
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: edge,
          height: edge,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block', flex: '0 0 auto', opacity: dim === true ? 0.75 : 1 }
        },
        h('rect', { x: 2, y: 3, width: 7.5, height: 10, rx: 1.6 }),
        h('rect', { x: 6.5, y: 3, width: 7.5, height: 10, rx: 1.6 }),
        h('path', { d: 'M4.2 7.4h3.2M6.2 6l1.4 1.4L6.2 8.8' }),
        h('path', { d: 'M11.8 10.2H8.6M9.8 8.8 8.4 10.2l1.4 1.4' })
      )
    }

    // -------------------------------------------------------- composer button
    /**
     * The conversation entry point. Kept to the composer's compact control
     * height; opens the floating panel and remembers this session's context.
     */
    function ComposerButton(props) {
      const [hover, setHover] = React.useState(false)
      const sessionTitle =
        typeof props.useSessions === 'function'
          ? props.useSessions((snapshot) => {
              if (props.sessionId === undefined) return undefined
              const row = snapshot?.byId?.[props.sessionId]
              return row?.title ?? row?.displayTitle
            })
          : undefined
      const active = store.open
      return h(
        'button',
        {
          type: 'button',
          title: '交接：生成 / 载入交接包',
          'aria-label': '交接',
          'aria-expanded': active,
          onClick: () => {
            if (store.open) {
              closePanel()
              return
            }
            if (typeof props.sessionId === 'string' && props.sessionId !== '') {
              try {
                window.localStorage.setItem(SESSION_HINT_KEY, props.sessionId)
              } catch {
                /* private mode / storage disabled: the Host fallback still works */
              }
            }
            set({
              sessionId: props.sessionId,
              sessionTitle: typeof sessionTitle === 'string' ? sessionTitle : '',
              inputActions: props.inputActions ?? null
            })
            openPanel()
          },
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            height: 26,
            padding: '0 7px',
            borderRadius: 6,
            border: '1px solid transparent',
            background: active ? T.layer2 : hover ? T.layer1 : 'transparent',
            color: active ? T.text : T.text2,
            fontFamily: FONT,
            fontSize: 12,
            lineHeight: '1',
            cursor: 'pointer',
            flex: '0 0 auto'
          }
        },
        h(HandoffGlyph, { size: 15 }),
        h('span', { style: { whiteSpace: 'nowrap' } }, '交接')
      )
    }

    // -------------------------------------------------------- create tab
    function CreateResult({ result }) {
      useStoreVersion()
      if (result === null || result === undefined) return null
      const warnings = Array.isArray(result.warnings) ? result.warnings : []
      const lineage = result.lineage
      return h(
        'div',
        {
          style: {
            marginTop: 14,
            border: `1px solid ${T.success}`,
            background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 8%, transparent)',
            borderRadius: 10,
            padding: '11px 12px'
          }
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 } },
          h('span', { style: { color: T.success, fontFamily: FONT, fontSize: 12.5, fontWeight: 600 } }, '已生成'),
          h('span', { style: { fontFamily: MONO, fontSize: 12 } }, result.batchId ?? ''),
          h('span', { style: { flex: '1 1 auto' } }),
          h(Badge, {
            text: result.action === 'update' ? 'update' : result.action === 'append' ? 'append' : 'create',
            color: T.brand
          })
        ),
        h(KeyValue, { label: '目录', mono: true, children: result.displayDir ?? result.dir ?? '—' }),
        h(KeyValue, {
          label: '证据',
          children: `${Array.isArray(result.artifacts) ? result.artifacts.length : 0} 个文件${
            result.totals?.artifactBytes !== undefined ? `，${formatBytes(result.totals.artifactBytes)}` : ''
          }`
        }),
        lineage === undefined || lineage === null
          ? null
          : h(KeyValue, {
              label: '血缘',
              children:
                `sequence ${lineage.sequence}` +
                (lineage.previous === undefined ? '' : `，previous ${lineage.previous}`) +
                (lineage.supersedes === undefined ? '' : `，supersedes ${lineage.supersedes}`)
            }),
        warnings.length === 0
          ? null
          : h(
              'div',
              { style: { marginTop: 6, fontFamily: FONT, fontSize: 11.5, color: T.warn } },
              `${warnings.length} 条警告：` +
                warnings
                  .slice(0, 4)
                  .map((warning) => `[${warning.code}] ${warning.detail}`)
                  .join('；')
            ),
        h(
          'div',
          { style: { display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' } },
          h(Button, { primary: true, onClick: () => void performCopy(result.batchId), disabled: store.copying }, store.copying ? '正在生成提示词…' : '复制开场提示词'),
          h(Button, {
            onClick: async () => {
              const ok = await copyText(String(result.displayDir ?? result.dir ?? ''))
              showToast(ok ? '目录已复制' : '无法自动复制，请手动选择目录')
            }
          }, '复制目录'),
          h(Button, { onClick: openWorkbench }, '打开工作台')
        )
      )
    }

    function PromptPreview() {
      useStoreVersion()
      if (store.promptError !== null) return h(ErrorNotice, { error: store.promptError })
      if (store.promptText === '') return null
      return h(
        'div',
        { style: { marginTop: 12 } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5, flexWrap: 'wrap' } },
          h('span', { style: { fontFamily: FONT, fontSize: 12, color: T.text } }, '新会话开场提示词'),
          h(Badge, { text: `trust=${store.promptTrust}`, color: trustColor(store.promptTrust) }),
          h('span', { style: { fontFamily: MONO, fontSize: 11, color: T.text2 } }, store.promptBatchId),
          h('span', { style: { flex: '1 1 auto' } }),
          h(Button, {
            onClick: async () => {
              const ok = await copyText(store.promptText)
              showToast(ok ? '已复制' : '无法自动复制，请手动选择文本')
            }
          }, '再次复制')
        ),
        h('textarea', {
          readOnly: true,
          value: store.promptText,
          rows: 7,
          style: Object.assign({}, inputStyle, {
            resize: 'vertical',
            minHeight: 120,
            fontFamily: MONO,
            fontSize: 11.5,
            lineHeight: 1.6
          })
        })
      )
    }

    function CreateTab() {
      useStoreVersion()
      const state = store.state
      const roots = state !== null && state.roots !== undefined ? state.roots : null
      const target = store.target || 'user'
      const targetRoot = roots !== null ? roots[target] : null
      const busy = store.createBusy === true
      const manageDisabled = busy || (state === null && store.stateError === null)
      return h(
        'div',
        { style: { padding: '12px 14px 16px' } },
        h(ErrorNotice, { error: store.stateError }),
        h(
          Field,
          { label: '标题', hint: '可选，最多 200 字' },
          h(TextInput, {
            value: store.createTitle,
            placeholder: '交接批次标题（用于 manifest / 列表）',
            maxLength: 200,
            disabled: busy,
            onChange: (value) => set({ createTitle: value })
          })
        ),
        h(
          Field,
          { label: '备注', hint: '可选，写进 HANDOFF 的 H1 叙述' },
          h(TextArea, {
            value: store.createSummary,
            placeholder: '一句话说明这次交接的重点 / 未完成事项',
            rows: 3,
            maxLength: 8000,
            onChange: (value) => set({ createSummary: value })
          })
        ),
        h(
          'div',
          { style: { marginBottom: 10 } },
          h('div', { style: { fontFamily: FONT, fontSize: 12, marginBottom: 4 } }, '目标'),
          h(
            'div',
            { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            h(Choice, { active: target === 'user', onClick: () => set({ target: 'user' }) }, 'user（默认，$DSH_HOME）'),
            h(Choice, { active: target === 'workspace', onClick: () => set({ target: 'workspace' }) }, 'workspace（降级）')
          ),
          h(
            'div',
            { style: { marginTop: 6, fontFamily: MONO, fontSize: 11.5, color: T.text2, overflowWrap: 'anywhere' } },
            targetRoot === null ? '目标根目录：读取中…' : `写入根目录：${targetRoot}`
          ),
          h(
            'div',
            { style: { marginTop: 2, fontFamily: FONT, fontSize: 11, color: T.text2 } },
            '实际批次目录 = 根目录 / 项目 key / batchId，由宿主计算并在生成后显示；点击前不会写盘。'
          )
        ),
        h(
          'div',
          { style: { marginBottom: 12 } },
          h(
            Checkbox,
            { checked: store.createIncludeDiffs === true, onChange: (value) => set({ createIncludeDiffs: value }) },
            '附带会话改动 diff（≤20 文件 / ≤512 KiB）'
          )
        ),
        store.createError === null ? null : h(ErrorNotice, { error: store.createError }),
        h(
          'div',
          { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
          h(Button, { primary: true, disabled: manageDisabled, onClick: () => void performCreate({ copy: false }) }, busy ? '正在生成…' : '生成交接包'),
          h(Button, { disabled: manageDisabled, onClick: () => void performCreate({ copy: true }) }, '生成并复制开场提示词')
        ),
        busy
          ? h(
              'div',
              { style: { marginTop: 8, fontFamily: FONT, fontSize: 11.5, color: T.text2 } },
              '正在采集证据并写入交接包，可能需要几秒…（写操作已由这次点击确认）'
            )
          : null,
        h(ErrorNotice, { error: store.promptError }),
        h(CreateResult, { result: store.createResult }),
        h(PromptPreview)
      )
    }

    // -------------------------------------------------------- load tab / detail
    /** Trust + drift + findings + bounded HANDOFF excerpts for one batch. */
    function DetailView({ detail, loading, error }) {
      useStoreVersion()
      if (error !== null && error !== undefined) return h(ErrorNotice, { error })
      if (loading === true && (detail === null || detail === undefined)) {
        return h(
          'div',
          { style: { color: T.text2, fontFamily: FONT, fontSize: 12, padding: '14px 0' } },
          '正在校验：读包 + 重算哈希与漂移…'
        )
      }
      if (detail === null || detail === undefined) {
        return h(
          'div',
          { style: { color: T.text2, fontFamily: FONT, fontSize: 12, padding: '14px 0', lineHeight: 1.8 } },
          '从左侧选择一个批次，查看 trust / drift / findings，并复制开场提示词。'
        )
      }
      const verification = detail.verification
      const counts = verification !== null && verification !== undefined ? verification.counts : undefined
      const findings = Array.isArray(verification?.findings) ? verification.findings : []
      const drift = verification?.drift
      const pointers = Array.isArray(detail.pointers) ? detail.pointers : []
      const next = Array.isArray(detail.next) ? detail.next : []
      const warnings = Array.isArray(detail.warnings) ? detail.warnings : []
      const sections = Array.isArray(detail.handoff?.sections) ? detail.handoff.sections : []
      const drifted =
        drift !== undefined &&
        drift !== null &&
        (drift.gitHeadChanged === true || drift.sourceFilesChanged > 0 || drift.sourceFilesMissing > 0)
      const trust = typeof detail.trust === 'string' ? detail.trust : 'stale'
      return h(
        'div',
        null,
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 } },
          h('span', { style: { fontFamily: MONO, fontSize: 12.5, fontWeight: 600 } }, detail.batchId ?? ''),
          h(Badge, { text: `trust=${trust}`, color: trustColor(trust) }),
          counts === undefined
            ? null
            : h(Badge, {
                text: `${counts.errors} error / ${counts.warnings} warn`,
                color: counts.errors > 0 ? T.error : counts.warnings > 0 ? T.warn : T.success
              }),
          h('span', { style: { flex: '1 1 auto' } }),
          h(
            'button',
            {
              type: 'button',
              onClick: async () => {
                const ok = await copyText(String(detail.displayDir ?? detail.dir ?? ''))
                showToast(ok ? '目录已复制' : '无法自动复制，请手动选择目录')
              },
              style: {
                border: 'none',
                background: 'transparent',
                color: T.brand,
                fontFamily: FONT,
                fontSize: 11.5,
                cursor: 'pointer',
                padding: 0
              }
            },
            '复制目录'
          )
        ),
        h(KeyValue, { label: '目录', mono: true, children: detail.displayDir ?? detail.dir ?? '—' }),
        detail.manifest?.title === null || detail.manifest?.title === undefined
          ? null
          : h(KeyValue, { label: '标题', children: detail.manifest.title }),
        verification?.checkedAt === undefined
          ? null
          : h(KeyValue, { label: '校验于', children: formatTime(verification.checkedAt) }),
        h(
          'div',
          {
            style: {
              marginTop: 6,
              fontFamily: FONT,
              fontSize: 11.5,
              color: drifted ? T.warn : T.success
            }
          },
          drift === undefined || drift === null
            ? '漂移：未执行漂移检查'
            : drifted
              ? `漂移：gitHead ${drift.gitHeadChanged === true ? '已变' : '未变'} · 源文件变化 ${drift.sourceFilesChanged} · 缺失 ${drift.sourceFilesMissing}`
              : '漂移：无（gitHead 未变，源文件哈希一致）'
        ),
        findings.length === 0
          ? null
          : h(
              'div',
              { style: { marginTop: 8, border: `1px solid ${T.border1}`, borderRadius: 8, padding: '7px 10px' } },
              h('div', { style: { fontFamily: FONT, fontSize: 11.5, fontWeight: 600, marginBottom: 3 } }, `findings（${findings.length}）`),
              findings.slice(0, 12).map((finding, index) =>
                h(
                  'div',
                  {
                    key: `f-${index}`,
                    style: {
                      fontFamily: FONT,
                      fontSize: 11.5,
                      lineHeight: 1.6,
                      color: finding.severity === 'error' ? T.error : T.warn,
                      overflowWrap: 'anywhere'
                    }
                  },
                  `[${finding.severity}] ${finding.code}${finding.path === undefined ? '' : ` · ${finding.path}`}${
                    finding.detail === undefined ? '' : ` — ${finding.detail}`
                  }`
                )
              ),
              findings.length > 12
                ? h('div', { style: { fontFamily: FONT, fontSize: 11.5, color: T.text2 } }, `还有 ${findings.length - 12} 条…`)
                : null
            ),
        warnings.length === 0
          ? null
          : h(
              'div',
              { style: { marginTop: 8, fontFamily: FONT, fontSize: 11.5, color: T.warn, lineHeight: 1.6 } },
              `包内警告（${warnings.length}）：` +
                warnings
                  .slice(0, 5)
                  .map((warning) => `[${warning.code}] ${warning.detail}`)
                  .join('；')
            ),
        sections.length === 0
          ? null
          : h(
              'div',
              { style: { marginTop: 8 } },
              sections.slice(0, 3).map((section, index) =>
                h(
                  'div',
                  { key: `s-${index}`, style: { marginBottom: 6 } },
                  h('div', { style: { fontFamily: FONT, fontSize: 11.5, fontWeight: 600, color: T.text } }, section.heading ?? section.id),
                  h(
                    'div',
                    {
                      style: {
                        fontFamily: FONT,
                        fontSize: 11.5,
                        lineHeight: 1.65,
                        color: T.text2,
                        whiteSpace: 'pre-wrap',
                        maxHeight: 120,
                        overflowY: 'auto'
                      }
                    },
                    section.text ?? ''
                  )
                )
              )
            ),
        pointers.length === 0
          ? null
          : h(
              'div',
              { style: { marginTop: 8, fontFamily: MONO, fontSize: 11, color: T.text2, lineHeight: 1.7, overflowWrap: 'anywhere' } },
              pointers.map((pointer, index) => h('div', { key: `p-${index}` }, `· ${pointer.label}: ${pointer.path}`))
            ),
        next.length === 0
          ? null
          : h(
              'div',
              { style: { marginTop: 8, fontFamily: FONT, fontSize: 11.5, color: T.text2, lineHeight: 1.7 } },
              h('div', { style: { color: T.text, fontWeight: 600, marginBottom: 2 } }, '下一步'),
              next.slice(0, 3).map((item, index) => h('div', { key: `n-${index}` }, `· ${item}`))
            ),
        h(ErrorNotice, { error: store.promptError }),
        h(
          'div',
          { style: { display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' } },
          h(Button, { primary: true, disabled: store.copying, onClick: () => void performCopy(detail.batchId) }, store.copying ? '正在生成提示词…' : '复制开场提示词'),
          h(Button, { onClick: () => void insertPrompt(detail.batchId) }, '插入输入框'),
          h(
            Button,
            {
              onClick: () => {
                set({ selectedBatchId: detail.batchId })
                openWorkbench()
              }
            },
            '打开工作台'
          )
        )
      )
    }

    /** The batch list shared by the 「载入」 tab and the workbench page. */
    function BatchList({ maxHeight }) {
      useStoreVersion()
      const state = store.state
      const batches = state !== null && Array.isArray(state.batches) ? state.batches : []
      return h(
        'div',
        {
          style: {
            borderRight: `1px solid ${T.border1}`,
            maxHeight: maxHeight ?? '52vh',
            overflowY: 'auto',
            padding: '6px 0'
          }
        },
        batches.map((batch) =>
          h(
            'button',
            {
              key: batch.batchId,
              type: 'button',
              onClick: () => void performDetail(batch.batchId),
              style: {
                display: 'block',
                width: '100%',
                textAlign: 'left',
                border: 'none',
                borderLeft: `3px solid ${batch.batchId === store.detailBatchId ? T.brand : 'transparent'}`,
                background: batch.batchId === store.detailBatchId ? T.layer1 : 'transparent',
                padding: '7px 10px',
                cursor: 'pointer'
              }
            },
            h('div', { style: { fontFamily: MONO, fontSize: 11.5, color: T.text } }, batch.batchId),
            h(
              'div',
              {
                style: {
                  fontFamily: FONT,
                  fontSize: 11,
                  color: T.text2,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }
              },
              `${batch.title !== null && batch.title !== undefined ? batch.title : '（无标题）'} · ${formatTime(batch.createdAt)}`
            )
          )
        )
      )
    }

    function LoadTab() {
      useStoreVersion()
      const state = store.state
      const batches = state !== null && Array.isArray(state.batches) ? state.batches : []
      React.useEffect(() => {
        if (store.tab !== 'load') return
        if (batches.length === 0) return
        if (store.detailBatchId !== '') return
        void performDetail(batches[0].batchId)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [store.tab, store.detailBatchId, batches.length])
      if (state === null) {
        return h(
          'div',
          { style: { padding: '16px 14px' } },
          store.stateError !== null
            ? h(ErrorNotice, { error: store.stateError })
            : h('div', { style: { color: T.text2, fontFamily: FONT, fontSize: 12 } }, '正在读取批次…')
        )
      }
      if (batches.length === 0) {
        return h(
          'div',
          { style: { padding: '16px 14px', color: T.text2, fontFamily: FONT, fontSize: 12, lineHeight: 1.8 } },
          '还没有批次。先切到「生成」创建第一包交接。'
        )
      }
      return h(
        'div',
        { style: { display: 'grid', gridTemplateColumns: 'minmax(200px, 250px) 1fr', minHeight: 280 } },
        h(BatchList, { maxHeight: '52vh' }),
        h(
          'div',
          { style: { padding: '10px 14px 14px', maxHeight: '52vh', overflowY: 'auto' } },
          h(DetailView, { detail: store.detail, loading: store.detailLoading, error: store.detailError })
        )
      )
    }

    // ----------------------------------------------------- continue modal
    function ContinueModal() {
      useStoreVersion()
      if (store.continueOpen !== true) return null
      const mode = store.continueMode === 'update' ? 'update' : 'append'
      const state = store.state
      const batches = state !== null && Array.isArray(state.batches) ? state.batches : []
      const latest = batches.length > 0 ? batches[0] : null
      const baseId = typeof store.continueBaseId === 'string' && store.continueBaseId !== '' ? store.continueBaseId : latest?.batchId ?? ''
      const target = store.target || 'user'
      const targetRoot = state !== null && state.roots !== undefined ? state.roots[target] : null
      const busy = store.continueBusy === true
      const result = store.continueResult
      const needsUpdateConfirm = mode === 'update' && store.continueConfirm !== true && result === null
      const header = h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '12px 14px',
            borderBottom: `1px solid ${T.border1}`,
            background: T.layer1
          }
        },
        h('span', { style: { color: T.brand, display: 'inline-flex' } }, h(HandoffGlyph, { size: 18 })),
        h('div', { style: { flex: '1 1 auto' } },
          h('div', { style: { fontFamily: FONT, fontSize: 13.5, fontWeight: 600 } }, '继续交接'),
          h('div', { style: { fontFamily: FONT, fontSize: 11.5, color: T.text2 } }, '写入新批次；旧批次不被修改')
        ),
        h('button', {
          type: 'button',
          'aria-label': '关闭',
          onClick: closeContinue,
          style: { border: 'none', background: 'transparent', color: T.text2, cursor: 'pointer', fontSize: 16, lineHeight: '1', padding: 4 }
        }, '×')
      )
      const form = h(
        'div',
        { style: { padding: '12px 14px' } },
        h(
          'div',
          { style: { display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' } },
          h(Choice, { active: mode === 'append', onClick: () => set({ continueMode: 'append', continueConfirm: false }) }, 'append（承接最新）'),
          h(Choice, { active: mode === 'update', onClick: () => set({ continueMode: 'update', continueConfirm: false }) }, 'update（标记 supersedes）')
        ),
        h(
          'div',
          { style: { fontFamily: FONT, fontSize: 11.5, color: T.text2, lineHeight: 1.7, marginBottom: 8 } },
          mode === 'update'
            ? '新建一代并记录 supersedes 最新批次；旧批次保持原样，不会被改写。需要二次确认。'
            : '承接最新批次追加一代（lineage.previous）；旧批次保持原样。'
        ),
        h(KeyValue, { label: '基准批次', mono: true, children: baseId === '' ? '（无可用批次）' : baseId }),
        h(KeyValue, { label: '写入根目录', mono: true, children: targetRoot ?? '—' }),
        h(
          'div',
          { style: { fontFamily: FONT, fontSize: 11, color: T.text2, marginBottom: 10 } },
          '实际批次目录由宿主按项目 key 生成，写入完成后显示；点击前不会写盘。'
        ),
        h(
          Field,
          { label: '标题', hint: '可选' },
          h(TextInput, {
            value: store.continueTitle,
            placeholder: '这一代的标题（可选）',
            maxLength: 200,
            disabled: busy,
            onChange: (value) => set({ continueTitle: value })
          })
        ),
        h(
          Field,
          { label: '备注', hint: '可选，写进 H1' },
          h(TextArea, {
            value: store.continueSummary,
            rows: 2,
            maxLength: 8000,
            onChange: (value) => set({ continueSummary: value })
          })
        ),
        h(
          'div',
          { style: { marginBottom: 10 } },
          h(
            Checkbox,
            { checked: store.continueIncludeDiffs === true, onChange: (value) => set({ continueIncludeDiffs: value }) },
            '附带会话改动 diff'
          )
        ),
        h(ErrorNotice, { error: store.continueError }),
        result === null
          ? null
          : h(
              'div',
              {
                style: {
                  border: `1px solid ${T.success}`,
                  background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 8%, transparent)',
                  borderRadius: 8,
                  padding: '9px 11px',
                  marginBottom: 8
                }
              },
              h(
                'div',
                { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4, flexWrap: 'wrap' } },
                h('span', { style: { color: T.success, fontFamily: FONT, fontSize: 12.5, fontWeight: 600 } }, '已写入新批次'),
                h('span', { style: { fontFamily: MONO, fontSize: 12 } }, result.batchId ?? ''),
                result.lineage === undefined || result.lineage === null
                  ? null
                  : h(Badge, {
                      text: `第 ${result.lineage.sequence} 代`,
                      color: T.brand
                    })
              ),
              h(KeyValue, { label: '目录', mono: true, children: result.displayDir ?? result.dir ?? '—' }),
              h(
                'div',
                { style: { display: 'flex', gap: 8, marginTop: 8 } },
                h(Button, {
                  onClick: () => {
                    set({ selectedBatchId: result.batchId, detailBatchId: result.batchId })
                    void performDetail(result.batchId)
                    closeContinue()
                  }
                }, '查看该批次'),
                h(Button, { onClick: closeContinue }, '关闭')
              )
            ),
        needsUpdateConfirm
          ? h(
              'div',
              {
                style: {
                  border: `1px solid ${T.warn}`,
                  borderRadius: 8,
                  padding: '8px 10px',
                  fontFamily: FONT,
                  fontSize: 11.5,
                  color: T.warn,
                  marginTop: 6
                }
              },
              '二次确认：将新建一个 supersedes 批次，旧批次只读保留。'
            )
          : null,
        result === null
          ? h(
              'div',
              { style: { display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' } },
              needsUpdateConfirm
                ? h(Button, { onClick: () => set({ continueConfirm: true }) }, '继续交接（update）')
                : h(Button, { primary: true, disabled: busy || latest === null, onClick: () => void performContinue() }, busy ? '正在写入…' : `确认写入（${mode}）`),
              h(Button, { onClick: closeContinue }, '取消')
            )
          : null
      )
      return h(
        'div',
        {
          style: {
            position: 'fixed',
            inset: 0,
            zIndex: 70,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0, 0, 0, 0.42)'
          },
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) closeContinue()
          }
        },
        h(
          'div',
          {
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': '继续交接',
            style: {
              width: 'min(560px, calc(100vw - 40px))',
              maxHeight: 'min(84vh, 720px)',
              display: 'flex',
              flexDirection: 'column',
              background: T.overlay,
              color: T.text,
              border: `1px solid ${T.border2}`,
              borderRadius: 12,
              boxShadow: '0 18px 60px rgba(0, 0, 0, 0.45)',
              overflow: 'hidden',
              fontFamily: FONT
            }
          },
          header,
          h('div', { style: { overflowY: 'auto', flex: '1 1 auto', minHeight: 0 } }, form)
        )
      )
    }

    // -------------------------------------------------------- floating panel
    function Tabs() {
      useStoreVersion()
      const tab = store.tab
      const item = (id, label) =>
        h(
          'button',
          {
            type: 'button',
            onClick: () => set({ tab: id }),
            style: {
              height: 30,
              padding: '0 12px',
              border: 'none',
              borderBottom: `2px solid ${tab === id ? T.brand : 'transparent'}`,
              background: 'transparent',
              color: tab === id ? T.text : T.text2,
              fontFamily: FONT,
              fontSize: 12.5,
              cursor: 'pointer'
            }
          },
          label
        )
      return h(
        'div',
        { style: { display: 'flex', gap: 2, padding: '0 10px', borderBottom: `1px solid ${T.border1}`, background: T.layer1 } },
        item('create', '生成'),
        item('load', '载入')
      )
    }

    function PanelSummary() {
      useStoreVersion()
      const state = store.state
      const batches = state !== null && Array.isArray(state.batches) ? state.batches.length : null
      return h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '7px 14px',
            borderBottom: `1px solid ${T.border1}`,
            fontFamily: FONT,
            fontSize: 11.5,
            color: T.text2,
            overflowWrap: 'anywhere'
          }
        },
        h('span', null, state === null ? '读取中…' : `项目 ${state.project?.name ?? '—'}`),
        h('span', null, batches === null ? '' : `· ${batches} 个批次`),
        h('span', { style: { flex: '1 1 auto' } }),
        h(
          'button',
          {
            type: 'button',
            onClick: () => void refreshState({}),
            disabled: store.loading,
            style: {
              border: 'none',
              background: 'transparent',
              color: store.loading ? T.text2 : T.brand,
              fontFamily: FONT,
              fontSize: 11.5,
              cursor: store.loading ? 'default' : 'pointer',
              padding: 0
            }
          },
          store.loading ? '刷新中…' : '刷新'
        )
      )
    }

    function FloatingPanel() {
      useStoreVersion()
      React.useEffect(() => {
        if (!store.open) return undefined
        const onKeyDown = (event) => {
          if (event.key === 'Escape') closePanel()
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [store.open])
      if (!store.open) return null
      const header = h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '12px 14px',
            borderBottom: `1px solid ${T.border1}`,
            background: T.layer1
          }
        },
        h('span', { style: { color: T.brand, display: 'inline-flex' } }, h(HandoffGlyph, { size: 18 })),
        h(
          'div',
          { style: { flex: '1 1 auto', minWidth: 0 } },
          h('div', { style: { fontFamily: FONT, fontSize: 13.5, fontWeight: 600 } }, '交接'),
          h('div', { style: { fontFamily: FONT, fontSize: 11.5, color: T.text2 } }, '生成 / 载入会话交接包')
        ),
        h(
          'button',
          {
            type: 'button',
            'aria-label': '关闭',
            onClick: closePanel,
            style: { border: 'none', background: 'transparent', color: T.text2, cursor: 'pointer', fontSize: 16, lineHeight: '1', padding: 4 }
          },
          '×'
        )
      )
      const footer = h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '10px 14px',
            borderTop: `1px solid ${T.border1}`,
            background: T.layer1
          }
        },
        h(Button, { onClick: openWorkbench }, '打开工作台'),
        h('span', { style: { flex: '1 1 auto' } }),
        h(Button, { onClick: closePanel }, '关闭')
      )
      return h(
        'div',
        {
          style: {
            position: 'fixed',
            inset: 0,
            zIndex: 60,
            pointerEvents: 'auto',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0, 0, 0, 0.38)'
          },
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) closePanel()
          }
        },
        h(
          'div',
          {
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': '交接',
            style: {
              width: 'min(680px, calc(100vw - 48px))',
              maxHeight: 'min(84vh, 780px)',
              display: 'flex',
              flexDirection: 'column',
              background: T.overlay,
              color: T.text,
              border: `1px solid ${T.border2}`,
              borderRadius: 12,
              boxShadow: '0 18px 60px rgba(0, 0, 0, 0.45)',
              overflow: 'hidden',
              fontFamily: FONT
            }
          },
          header,
          h(PanelSummary),
          h(Tabs),
          h(
            'div',
            { style: { overflowY: 'auto', flex: '1 1 auto', minHeight: 0 } },
            store.tab === 'load' ? h(LoadTab) : h(CreateTab)
          ),
          footer
        )
      )
    }

    // ------------------------------------------------------------- sidebar icon
    function SidebarIcon(props) {
      return h(HandoffGlyph, { size: typeof props?.size === 'number' ? props.size : 16 })
    }

    // ---------------------------------------------------------- workbench page
    function WorkbenchPage() {
      useStoreVersion()
      const state = store.state
      const batches = state !== null && Array.isArray(state.batches) ? state.batches : []
      React.useEffect(() => {
        let sessionId = store.sessionId
        if (typeof sessionId !== 'string' || sessionId === '') {
          try {
            const stored = window.localStorage.getItem(SESSION_HINT_KEY)
            if (typeof stored === 'string' && stored !== '') sessionId = stored
          } catch {
            /* storage unavailable: the Host fallback still works */
          }
        }
        if (typeof sessionId === 'string' && sessionId !== '') set({ sessionId })
        if (store.state === null && !store.loading) void refreshState({ sessionId })
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])
      React.useEffect(() => {
        if (batches.length === 0) return
        if (store.detailBatchId !== '') return
        const first =
          store.selectedBatchId !== null && batches.some((batch) => batch.batchId === store.selectedBatchId)
            ? store.selectedBatchId
            : batches[0].batchId
        set({ selectedBatchId: first })
        void performDetail(first)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [state, store.selectedBatchId])
      const refreshAll = () => {
        void refreshState({}).then(() => {
          if (store.detailBatchId !== '') void performDetail(store.detailBatchId)
        })
      }
      return h(
        'div',
        {
          style: {
            height: '100%',
            minHeight: 0,
            overflowY: 'auto',
            background: T.base,
            color: T.text,
            fontFamily: FONT
          }
        },
        h(
          'div',
          { style: { maxWidth: 1180, margin: '0 auto', padding: '22px 26px 40px' } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' } },
            h('span', { style: { color: T.brand, display: 'inline-flex' } }, h(HandoffGlyph, { size: 22 })),
            h('h1', { style: { margin: 0, fontSize: 18, fontWeight: 650 } }, '交接工作台'),
            h('span', { style: { flex: '1 1 auto' } }),
            h(Button, { onClick: refreshAll, disabled: store.loading }, store.loading ? '刷新中…' : '刷新'),
            h(Button, {
              onClick: () => {
                if (store.detailBatchId !== '') void performDetail(store.detailBatchId)
              },
              disabled: store.detailLoading || store.detailBatchId === ''
            }, store.detailLoading ? '校验中…' : '校验'),
            h(Button, {
              primary: true,
              onClick: () => {
                set({ tab: 'create' })
                openPanel()
              }
            }, '生成'),
            h(Button, { onClick: () => openContinue('append') }, '继续交接'),
            h(Button, { onClick: () => selectMainPanel('conversation') }, '返回对话')
          ),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 12, margin: '2px 0 14px', flexWrap: 'wrap' } },
            h(
              'p',
              { style: { margin: 0, color: T.text2, fontSize: 12.5, lineHeight: 1.7 } },
              '交接包是“新会话开场提示词”的后端证据；写操作（生成 / 继续交接）会先显示目标目录并在点击后执行。'
            ),
            state === null
              ? null
              : h('span', { style: { fontFamily: FONT, fontSize: 11.5, color: T.text2 } },
                  `项目 ${state.project?.name ?? '—'} · ${batches.length} 个批次 · 会话 ${state.session?.id ?? '未绑定'}`)
          ),
          h(
            'div',
            {
              style: {
                border: `1px solid ${T.border1}`,
                borderRadius: 12,
                background: T.layer1,
                overflow: 'hidden',
                display: 'grid',
                gridTemplateColumns: 'minmax(220px, 280px) 1fr',
                minHeight: 360
              }
            },
            h(BatchList, { maxHeight: 'calc(100vh - 260px)' }),
            h(
              'div',
              { style: { padding: '12px 18px 18px', overflowY: 'auto', maxHeight: 'calc(100vh - 260px)' } },
              h(DetailView, { detail: store.detail, loading: store.detailLoading, error: store.detailError })
            )
          ),
          h(ContinueModal)
        )
      )
    }

    // ---------------------------------------------------------------- plugin
    return {
      inject: ['slots'],
      apply(ctx) {
        pluginCtx = ctx
        const slots = ctx.slots ?? ctx.get?.('slots')
        if (slots === undefined || slots === null) return () => {}
        if (typeof slots.inject !== 'function' || typeof slots.register !== 'function') return () => {}
        // `inject` fires when the owning shell entry declares the seat: load order
        // between this bundle and the shell plugins does not matter, and a shell
        // that cannot serve the seat leaves the surface simply absent.
        const disposers = [
          // Conversation entry: a compact control at the left of the tool row.
          slots.inject('conversation.input.left', () =>
            slots.register(
              { name: 'conversation.input.left', id: BUTTON_ID, order: BUTTON_ORDER, label: () => '交接' },
              ComposerButton
            )
          ),
          // Frame-wide floating layer: the panel itself.
          slots.inject('shell.overlay', () =>
            slots.register({ name: 'shell.overlay', id: `${PANEL_ID}.panel`, order: 100 }, FloatingPanel)
          ),
          // Sidebar row + center page share one key.
          slots.inject('sidebar.panellist', () =>
            slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 50, label: () => '交接' }, SidebarIcon)
          ),
          slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID }, WorkbenchPage))
        ]
        return () => {
          pluginCtx = null
          for (const dispose of disposers) {
            try {
              if (typeof dispose === 'function') dispose()
            } catch {
              /* the slot owner may already be torn down */
            }
          }
        }
      }
    }
  }
})
