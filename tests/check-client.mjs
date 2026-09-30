/**
 * Checks for the Client half.
 *
 * Two failures this exists to prevent.
 *
 * 1. The slot renderer CALLS an entry's `inject` — `runInject` in
 *    dsh-client-ui-renderer does `inject(...args)` and merges the result into the
 *    entry's props. Passing a plain object instead of a function throws on the
 *    entry's first render, and the per-entry error boundary swallows it: the
 *    shipped rows still draw and the plugin's row silently never appears. Nothing
 *    in the Inspect data reveals that, because registration itself succeeded. So
 *    these checks mirror the renderer's own call.
 *
 * 2. A row of `sidebar.workspaces.session.menu.item` is unmounted when its menu
 *    closes. An earlier version registered the confirmation dialog from the row's
 *    own effect, so the dialog was torn down by the very click that asked for it
 *    and a delete looked like nothing happened at all. The dialog therefore has
 *    to belong to the plugin, not to the row, and these checks render it without
 *    the row being mounted at all.
 *
 * The bundle is loaded through a stub of the module loader, exactly as the page
 * loads it, which also catches a mistake in `window.__ModuleLoader__.load`.
 *
 *   node tests/check-client.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

let failures = 0
let checks = 0

/**
 * Run one named check.
 * @param {string} title - what is being verified.
 * @param {() => void} body - the check.
 * @returns {Promise<void>} resolves after recording the outcome.
 */
async function test(title, body) {
  checks++
  try {
    await body()
    console.log(`  ok   ${title}`)
  } catch (error) {
    failures++
    console.error(`  FAIL ${title}\n       ${error.stack ?? error.message}`)
  }
}

/**
 * A DOM good enough for the bundle's own style injection.
 * @returns {object} the fake document, plus its head element.
 */
function fakeDom() {
  const make = (tag) => ({
    tagName: String(tag).toUpperCase(),
    style: {},
    dataset: {},
    attributes: {},
    children: [],
    textContent: '',
    setAttribute(name, value) { this.attributes[name] = value },
    removeAttribute(name) { delete this.attributes[name] },
    appendChild(child) { this.children.push(child); return child },
    removeChild(child) { this.children = this.children.filter((entry) => entry !== child); return child },
    remove() {
      const parent = this.parentNode
      if (parent !== undefined) parent.removeChild(this)
    },
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null },
    querySelectorAll() { return [] },
  })
  const head = make('head')
  return { document: { head, createElement: make, querySelector: () => null }, head }
}

const BUNDLE = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')

/**
 * Load the bundle through a stub module loader, as the page's combo script does.
 * @param {Record<string, unknown>} modules - modules the factory may require.
 * @returns {object} the factory's exports.
 */
function loadBundle(modules) {
  const loaded = []
  const window = { __ModuleLoader__: { load(entry) { loaded.push(entry) } } }
  const document = globalThis.document
  // The bundle is a plain script whose only side effect is the loader call.
  const evaluate = new Function('window', 'document', BUNDLE)
  evaluate(window, document)

  assert.equal(loaded.length, 1, 'the bundle must register exactly one module')
  const entry = loaded[0]
  assert.equal(entry.id, 'dsh-session-delete-plugin', 'the module id must equal the package name')
  assert.equal(typeof entry.factory, 'function')
  return entry.factory((name) => {
    if (!Object.hasOwn(modules, name)) throw new Error(`unexpected require(${JSON.stringify(name)})`)
    return modules[name]
  })
}

/**
 * Wrap a `CommandResult` the way the Remote layer does.
 *
 * A Remote call does NOT return the command's result. It returns a tagged
 * envelope, `{ ok: true, value }` or `{ ok: false, error }`, and the settled
 * `{ commandId, result }` sits at `value`. Fixtures that hand back a bare result
 * would let the plugin's own unwrapping be wrong and still pass here while every
 * real deletion reported "no result".
 * @param {object} result - the `CommandResult` the Host settles with.
 * @returns {object} the envelope.
 */
function envelope(result) {
  return { ok: true, value: { commandId: 'cmd-1', result } }
}

/**
 * Build the Client context `apply` expects, recording what it registers.
 *
 * `get` mimics the Cordis context proxy's strictness: a name the plugin did not
 * declare in its `inject` list must throw, because that is exactly how
 * `cannot get property "remote.commands" without inject` reached the user instead
 * of a working menu row.
 *
 * @param {object} [options] - overrides.
 * @param {(agent: string, line: string) => object} [options.execute] - fake command channel.
 * @param {boolean} [options.withoutRemote] - omit the Remote service.
 * @returns {object} the context and the recorded registrations.
 */
function clientContext(options = {}) {
  const registrations = []
  const locales = []
  const effects = []
  const slots = {
    inject(key, callback) { callback(); registrations.push({ kind: 'inject', key }) },
    register(spec, component) {
      registrations.push({ kind: 'register', spec, component })
      return () => {}
    },
  }
  const commands = { execute: options.execute ?? (async () => envelope({ kind: 'success', text: 'plan' })) }
  const declared = new Set(['slots', 'remote.commands', 'locale'])
  const values = {
    slots,
    'remote.commands': commands,
    locale: { register: (ns, dicts) => { locales.push({ ns, dicts }); return () => {} } },
  }
  if (options.withoutRemote === true) {
    values['remote.commands'] = undefined
  }
  const ctx = {
    get(name) {
      if (!declared.has(name)) {
        throw new Error(`cannot get property "${name}" without inject`)
      }
      return values[name]
    },
    effect(callback) { const dispose = callback(); effects.push(dispose); return dispose },
  }
  return { ctx, registrations, locales, effects, slots, commands }
}

/**
 * A React stand-in exposing what this bundle actually uses.
 *
 * Rendering is verified in the browser; these checks cover the registration and
 * state machinery around it. `useSyncExternalStore` is read-only here: the checks
 * render an overlay entry on demand, so a snapshot read is enough and no
 * subscription has to be driven.
 * @returns {object} the React stand-in.
 */
function reactStub() {
  const stores = []
  let cursor = 0
  let render = null
  let scheduled = false
  /**
   * Effects are real here: the dialog focuses its safe button after paint, and a
   * no-op stub would hide a component that only renders inside an effect.
   */
  let pendingEffects = []
  let cleanups = []
  /** Minimal class component, enough for the crash-safe wrapper. */
  class Component {
    constructor(props) { this.props = props; this.state = {} }
    setState(next) { this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) } }
  }
  /** Run the previous render's cleanups, then this render's effects. */
  const commitEffects = () => {
    for (const cleanup of cleanups.reverse()) {
      if (typeof cleanup === 'function') cleanup()
    }
    cleanups = []
    const effects = pendingEffects
    pendingEffects = []
    for (const effect of effects) {
      const cleanup = effect()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    }
  }
  /**
   * Re-run the last rendered component after a state change, as React would.
   *
   * Deferred to a microtask so it lands after the handler that caused it has
   * returned, which is the ordering the component is written against.
   */
  const settle = () => {
    if (scheduled || render === null) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      // Drain until nothing is queued: an effect may set state, and a state
      // update may re-arm `render`.
      while (render !== null) {
        const current = render
        cursor = 0
        pendingEffects = []
        current.tree = current.component(current.props)
        // `render` must stay set while effects run, so a state update inside an
        // effect can schedule the next pass instead of being dropped.
        commitEffects()
        if (render === current) render = null
      }
    })
  }
  return {
    Component,
    Fragment: Symbol.for('react.fragment'),
    stores,
    /** @param {{component: Function, props: object}} next - the render to track. */
    track(next) {
      render = next
      cursor = 0
      pendingEffects = []
      next.tree = next.component(next.props)
      commitEffects()
    },
    currentTree() { return render === null ? null : render.tree },
    resetCursor() { cursor = 0 },
    /** Drain every queued re-render and effect now. @returns {void} */
    flush() {
      scheduled = false
      while (render !== null) {
        const current = render
        cursor = 0
        pendingEffects = []
        current.tree = current.component(current.props)
        commitEffects()
        if (render === current) render = null
      }
    },
    /** Stop tracking: the tracked component has been unmounted. */
    unmount() { render = null },
    /**
     * Run an inspection without letting it affect the tracked render's state.
     *
     * Rendering another component to look at it would otherwise append its effects
     * to the tracked render's pending list, so the next render would run them —
     * and their cleanups — as a side effect of merely asserting something.
     * @param {() => T} operation - the inspection.
     * @returns {T} the inspection's result.
     * @template T
     */
    settled(operation) {
      const savedPending = pendingEffects
      const savedCleanups = cleanups
      const savedCursor = cursor
      pendingEffects = []
      cleanups = []
      try {
        return operation()
      } finally {
        pendingEffects = savedPending
        cleanups = savedCleanups
        cursor = savedCursor
      }
    },
    createElement(type, props, ...children) {
      return { type, props: { ...(props ?? {}), children: children.length > 1 ? children : children[0] } }
    },
    useRef: (initial) => ({ current: initial }),
    useMemo: (factory) => factory(),
    useEffect: (effect) => { pendingEffects.push(effect) },
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    useState(initial) {
      const index = cursor++
      stores[index] ??= { value: typeof initial === 'function' ? initial() : initial }
      const store = stores[index]
      return [store.value, (next) => {
        store.value = typeof next === 'function' ? next(store.value) : next
        settle()
      }]
    },
  }
}

/** The ids this plugin owns, one entry each. */
const ROW_ID = 'dsh-session-delete'
const OVERLAY_ID = 'dsh-session-delete-confirm'

/** The session id every rendered row in these checks acts on. */
const TARGET = 'session-11111111-2222-3333-4444-555555555555'
const TITLE = 'A disposable session'

/**
 * Find one of this plugin's registrations by id.
 * @param {object} harness - a client context whose `apply` already ran.
 * @param {string} id - the registration id.
 * @returns {object} the registration record.
 */
function findEntry(harness, id) {
  const found = harness.registrations.find((entry) => entry.kind === 'register' && entry.spec.id === id)
  assert.ok(found !== undefined, `no registration for id ${id}`)
  return found
}

/**
 * Replay the renderer's `runInject`.
 *
 * `inject` is CALLED, not read — `runInject` in dsh-client-ui-renderer does
 * `inject(...args)` and merges the result into the entry's props. A plain object
 * instead of a function throws on the entry's first render, which is the defect
 * this replay pins.
 * @param {object} spec - the entry's registration spec.
 * @returns {object} the props the renderer would hand the component.
 */
function runInject(spec) {
  assert.equal(
    typeof spec.inject, 'function',
    'inject must be a function — the renderer calls it, and a plain object crashes the entry',
  )
  return spec.inject()
}

/**
 * Collect every element in a rendered tree, expanding function components.
 *
 * A slot entry's component may return another element whose `type` is itself a
 * function component, so function components have to be invoked too, or the walk
 * stops one level short of the DOM. That is precisely how a "no dialog" verdict
 * can come from a component that did render one.
 * @param {unknown} node - subtree.
 * @returns {object[]} elements.
 */
function flatten(node) {
  if (node === null || node === undefined || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(flatten)
  if (typeof node.type === 'function') return flatten(node.type(node.props))
  return [node, ...(node.props === undefined ? [] : flatten(node.props.children))]
}

/**
 * Apply the bundle against a fresh context and mount both halves.
 *
 * The row is mounted through the stateful React stand-in so its click handler can
 * be driven; the overlay entry is rendered on demand. Rendering the overlay does
 * NOT require the row: that is the point of the design these checks pin.
 * @param {object} [options] - client context overrides.
 * @returns {object} the mount.
 */
function mountPlugin(options = {}) {
  const react = reactStub()
  const harness = clientContext(options)
  const exports = loadBundle({ react })
  exports.apply(harness.ctx)

  const rowEntry = findEntry(harness, ROW_ID)
  const overlayEntry = findEntry(harness, OVERLAY_ID)

  const mount = {
    component: exports.__row,
    props: {
      sessionId: TARGET,
      displayTitle: TITLE,
      useMenuOpenState: () => [true, () => {}],
      ...runInject(rowEntry.spec),
    },
  }
  react.track(mount)

  const isMenuButton = (node) => node.type === 'button' && node.props?.role === 'menuitem'
  const isAction = (node) => node.type === 'button' && node.props?.className?.includes('sd-danger')

  /** Render the overlay entry as the outlet would, from its injected props. */
  const overlayElements = () => react.settled(() => {
    react.resetCursor()
    return flatten(overlayEntry.component(runInject(overlayEntry.spec)))
  })

  return {
    react,
    harness,
    exports,
    rowEntry,
    overlayEntry,
    menuButton: () => flatten(react.currentTree()).find(isMenuButton),
    /** @returns {object[]} the overlay's tree: dialog and notice together. */
    overlay: () => overlayElements(),
    /** @returns {object|undefined} the confirmation dialog's root element. */
    dialog: () => overlayElements().find((element) => element.props?.role === 'dialog'),
    /** @returns {object|undefined} the dialog's destructive action button. */
    confirmButton: () => overlayElements().find(isAction),
    /** @returns {object|undefined} the outcome notice. */
    toast: () => overlayElements().find((element) => element.props?.className === 'sd-toast'),
  }
}

/**
 * Render the exposed inner row once and flatten the result.
 * @param {object} props - owner props plus whatever the entry injects.
 * @returns {object[]} the flattened element tree.
 */
function renderRow(props) {
  const react = reactStub()
  const exports = loadBundle({ react })
  react.track({ component: exports.__row, props })
  return flatten(react.currentTree())
}

/**
 * Let the stand-in flush its deferred re-renders.
 *
 * The controller chains awaits (state update, then the Remote call, then more
 * state), so a single tick is not enough to reach the settled state.
 * @returns {Promise<void>} resolves after the flush.
 */
async function settle() {
  for (let tick = 0; tick < 8; tick++) await Promise.resolve()
}

console.log('client bundle')

test('the bundle registers the expected module and export shape', () => {
  globalThis.document = fakeDom().document
  const exports = loadBundle({ react: reactStub() })
  // `remote.commands` is a service key of its own: the Cordis context proxy throws
  // `cannot get property "remote.commands" without inject` unless it is declared.
  // The `remote` parent is deliberately NOT declared — nothing here reads it, and
  // reaching a namespace through its parent is what the proxy refuses.
  assert.deepEqual(exports.inject, ['slots', 'remote.commands', 'locale'])
  assert.equal(typeof exports.apply, 'function')
})

test('every service the plugin reads is declared in its inject list', () => {
  globalThis.document = fakeDom().document
  const exports = loadBundle({ react: reactStub() })
  // The fake context throws for an undeclared name, so a successful apply proves
  // the list covers everything `apply` touches.
  const harness = clientContext()
  assert.doesNotThrow(() => exports.apply(harness.ctx))
})

test('the plugin contributes two entries: one row and one dialog', () => {
  globalThis.document = fakeDom().document
  const harness = clientContext()
  loadBundle({ react: reactStub() }).apply(harness.ctx)
  const registered = harness.registrations.filter((entry) => entry.kind === 'register')
  assert.equal(registered.length, 2, 'exactly one row and one overlay must be contributed')
  assert.deepEqual(
    registered.map((entry) => entry.spec.id).sort(),
    [OVERLAY_ID, ROW_ID].sort(),
  )
})

test('the row registers into the session menu slot after the shipped rows', () => {
  globalThis.document = fakeDom().document
  const harness = clientContext()
  loadBundle({ react: reactStub() }).apply(harness.ctx)

  const { spec, component } = findEntry(harness, ROW_ID)
  assert.equal(spec.name, 'sidebar.workspaces.session.menu.item')
  assert.equal(spec.order, 500, 'must sort after pin/rename/fork/archive')
  assert.equal(spec.locale, 'dsh-session-delete')
  assert.equal(typeof component, 'function')
})

test('the dialog registers into shell.overlay when the plugin applies', () => {
  globalThis.document = fakeDom().document
  const harness = clientContext()
  loadBundle({ react: reactStub() }).apply(harness.ctx)

  const { spec } = findEntry(harness, OVERLAY_ID)
  assert.equal(spec.name, 'shell.overlay')
  assert.equal(spec.locale, 'dsh-session-delete')
  assert.equal(
    typeof spec.inject, 'function',
    'the overlay must inject through a function, like every entry the renderer runs',
  )
})

await test('the dialog is registered by apply, NOT by a click on the row', async () => {
  globalThis.document = fakeDom().document
  // The regression this pins: the row unmounts with its menu, so a dialog it
  // registered outlived nothing. The entry has to exist before any click, and the
  // click must only raise a request on the controller the overlay already reads.
  const mount = mountPlugin()
  assert.ok(
    runInject(mount.overlayEntry.spec).request.getSnapshot() === null,
    'no request is pending before a click',
  )

  await mount.menuButton().props.onClick()
  await settle()

  assert.notEqual(
    runInject(mount.overlayEntry.spec).request.getSnapshot(), null,
    'the click must land on the controller the overlay is already reading',
  )
})

test('the overlay signals are observable the way the renderer binds them', () => {
  globalThis.document = fakeDom().document
  const harness = clientContext()
  loadBundle({ react: reactStub() }).apply(harness.ctx)
  const { request } = runInject(findEntry(harness, OVERLAY_ID).spec)

  let notified = 0
  const unsubscribe = request.subscribe(() => { notified++ })
  const raised = { sessionId: TARGET, displayTitle: TITLE, plan: null, busy: true, error: null }
  request.set(raised)
  assert.equal(notified, 1, 'a listener must be told about a change')
  assert.equal(request.getSnapshot(), raised, 'the snapshot must be the value just set')
  request.set(raised)
  assert.equal(notified, 1, 'an unchanged value must not notify')

  unsubscribe()
  request.set(null)
  assert.equal(notified, 1, 'an unsubscribed listener must not be told anything')
})

test("the row's inject returns the props the row reads, and nothing else", () => {
  globalThis.document = fakeDom().document
  const harness = clientContext()
  loadBundle({ react: reactStub() }).apply(harness.ctx)
  const props = runInject(findEntry(harness, ROW_ID).spec)

  assert.equal(typeof props.open, 'function', 'the row needs a way to raise a confirmation')
  assert.equal(props.available, true, 'the row needs to know whether the command channel exists')
  assert.deepEqual(
    Object.keys(props).sort(), ['available', 'open'],
    'the row must not be handed the command namespace: it outlives its own menu nowhere',
  )
})

test('the row disables itself when the command namespace is absent', () => {
  globalThis.document = fakeDom().document
  const harness = clientContext({ withoutRemote: true })
  loadBundle({ react: reactStub() }).apply(harness.ctx)

  const props = runInject(findEntry(harness, ROW_ID).spec)
  assert.equal(props.available, false)
  const button = renderRow(props).find((element) => element.type === 'button' && element.props?.role === 'menuitem')
  assert.ok(button !== undefined, 'the row must render without a command channel')
  assert.equal(button.props.disabled, true, 'without a command channel the row must disable itself')
})

test('the row still registers when the Remote channel is absent', () => {
  globalThis.document = fakeDom().document
  const harness = clientContext({ withoutRemote: true })
  assert.doesNotThrow(() => loadBundle({ react: reactStub() }).apply(harness.ctx))
  assert.ok(findEntry(harness, ROW_ID) !== undefined, 'a missing Remote service must not block registration')
})

test('the locale namespace registers both dictionaries', () => {
  globalThis.document = fakeDom().document
  const harness = clientContext()
  loadBundle({ react: reactStub() }).apply(harness.ctx)
  assert.equal(harness.locales.length, 1, 'no locale registration happened')
  const { ns, dicts } = harness.locales[0]
  assert.equal(ns, 'dsh-session-delete')
  assert.equal(dicts.zh['menu.delete'], '删除会话')
  assert.equal(dicts.en['menu.delete'], 'Delete session')
  // The dialog's own copy must be translated too, not just the row label.
  const dialogCopy = [
    'confirm.title', 'confirm.body', 'confirm.action', 'confirm.cancel', 'confirm.pending',
    'status.reading', 'status.plan', 'result.done', 'result.restart',
    'error.generic', 'error.unavailable', 'error.noResult', 'error.unknownCommand',
  ]
  for (const key of dialogCopy) {
    assert.ok(dicts.en[key] !== undefined, `en is missing ${key}`)
    assert.ok(dicts.zh[key] !== undefined, `zh is missing ${key}`)
  }
})

test('applying installs one owned stylesheet using only theme tokens', () => {
  const { document, head } = fakeDom()
  globalThis.document = document
  const harness = clientContext()
  loadBundle({ react: reactStub() }).apply(harness.ctx)

  const styleTags = head.children.filter((node) => node.tagName === 'STYLE')
  assert.equal(styleTags.length, 1, 'expected exactly one injected <style>')
  assert.match(styleTags[0].textContent, /\.sd-item\b/)
  assert.equal(harness.effects.length, 3, 'styles, locale and the notice timer must all be owned by effects')

  // Colours come only from theme tokens; a literal colour would not follow the
  // theme. Structural keywords that carry no theme meaning are allowed.
  const NEUTRAL = /^(transparent|none|inherit|currentColor|unset|initial)$/
  const colours = styleTags[0].textContent.match(/background:\s*[^;]+|color:\s*[^;]+/g) ?? []
  for (const declaration of colours) {
    const value = declaration.slice(declaration.indexOf(':') + 1).trim()
    if (NEUTRAL.test(value)) continue
    assert.match(
      declaration, /var\(--dsw-alias-/,
      `a colour declaration does not use a theme token: ${declaration.trim()}`,
    )
  }
})

test('the row wears the host menu danger treatment, not a generic hover', () => {
  const { document, head } = fakeDom()
  globalThis.document = document
  loadBundle({ react: reactStub() }).apply(clientContext().ctx)
  const css = head.children.find((node) => node.tagName === 'STYLE').textContent

  // The host's own destructive menu rows (Menu.module.css `.danger`) fill with
  // `--dsw-alias-interactive-bg-hover-danger` in both states and take
  // `--dsw-radius-md`. A generic surface fill or a literal radius reads as a
  // different control sitting in the same menu.
  const dangerFill = 'background: var(--dsw-alias-interactive-bg-hover-danger)'
  assert.equal(
    css.split(dangerFill).length - 1, 2,
    'hover and focus-visible must both take the host danger fill',
  )
  assert.match(css, /\.sd-item \{[^}]*border-radius: var\(--dsw-radius-md\)/)
})

test('the registered row component is the crash-safe wrapper, not the row itself', () => {
  globalThis.document = fakeDom().document
  const harness = clientContext()
  const exports = loadBundle({ react: reactStub() })
  exports.apply(harness.ctx)
  const { component } = findEntry(harness, ROW_ID)
  // The wrapper exists so a render throw shows a fault row instead of retiring
  // the entry and leaving the menu silently short one item.
  assert.equal(typeof component, 'function', 'React.Component subclass is a function')
  assert.equal(typeof exports.__row, 'function', 'the inner row must be exposed for these checks')
  assert.equal(typeof exports.__overlay, 'function', 'the overlay must be exposed for these checks')
  assert.equal(typeof exports.__faultRow, 'function')
})

test('the row renders one menuitem button, disabled without a command channel', () => {
  globalThis.document = fakeDom().document
  const harness = clientContext({ withoutRemote: true })
  loadBundle({ react: reactStub() }).apply(harness.ctx)
  const props = runInject(findEntry(harness, ROW_ID).spec)

  const elements = renderRow(props)
  const button = elements.find((element) => element.type === 'button' && element.props?.role === 'menuitem')
  assert.ok(button !== undefined, 'the row must render one role="menuitem" button')
  assert.equal(button.props.disabled, true, 'without a command channel the row must be disabled')
  assert.equal(button.props.onClick !== undefined, true, 'the row must carry its click handler')
})

test('the row reads its label from the injected locale', () => {
  globalThis.document = fakeDom().document
  const harness = clientContext()
  loadBundle({ react: reactStub() }).apply(harness.ctx)
  const injected = runInject(findEntry(harness, ROW_ID).spec)

  const englishLabel = renderRow(injected).find((element) => element.props?.className === 'sd-label')
  assert.equal(englishLabel.props.children, 'Delete session')

  const chineseLabel = renderRow({
    ...injected,
    t: (key) => ({ 'menu.delete': '删除会话' }[key] ?? key),
  }).find((element) => element.props?.className === 'sd-label')
  assert.equal(chineseLabel.props.children, '删除会话', 'the row must follow the injected locale')
})

test('the overlay reads its copy from the injected locale too', () => {
  globalThis.document = fakeDom().document
  const mount = mountPlugin()
  const overlay = mount.overlayEntry
  const props = runInject(overlay.spec)
  props.request.set({ sessionId: TARGET, displayTitle: TITLE, plan: null, busy: false, error: null })

  const chinese = mount.react.settled(() => {
    mount.react.resetCursor()
    return flatten(overlay.component({ ...props, t: (key) => ({ 'confirm.title': '永久删除这个会话？' }[key] ?? key) }))
  })
  const title = chinese.find((element) => element.props?.className === 'sd-title')
  assert.equal(title.props.children, '永久删除这个会话？', 'the dialog must follow the injected locale')
})

test('the row survives a host that stops projecting the optional props', () => {
  globalThis.document = fakeDom().document
  const harness = clientContext()
  loadBundle({ react: reactStub() }).apply(harness.ctx)

  // No `useMenuOpenState`, no `t`, no injected props at all: the row must render.
  const elements = flatten(loadBundle({ react: reactStub() }).__row({
    sessionId: TARGET,
    displayTitle: TITLE,
  }))
  const button = elements.find((element) => element.type === 'button' && element.props?.role === 'menuitem')
  assert.ok(button !== undefined, 'a missing optional prop must not remove the row')
  assert.equal(button.props.disabled, true, 'without a command channel it must disable itself')
})

test('the fault row is available to report a render failure', () => {
  globalThis.document = fakeDom().document
  const exports = loadBundle({ react: reactStub() })
  const elements = flatten(exports.__faultRow({ t: (key) => ({ 'error.rowFailed': '删除会话菜单项无法显示' }[key] ?? key) }))
  const fault = elements.find((element) => element.props?.['data-dsh-session-delete'] === 'fault')
  assert.ok(fault !== undefined, 'the fault row must be identifiable in the DOM')
  const text = elements.find((element) => element.props?.className === 'sd-fault')
  assert.equal(text.props.children[0], '删除会话菜单项无法显示')
})

test('the menu icon matches the host icon family it sits among', () => {
  globalThis.document = fakeDom().document
  const mount = mountPlugin()
  const elements = flatten(mount.react.currentTree())
  const svg = elements.find((element) => element.type === 'svg')
  assert.ok(svg !== undefined, 'the row must render an icon')
  assert.equal(String(svg.props['aria-hidden']), 'true', 'the icon is decorative')
  assert.equal(svg.props.viewBox, '0 0 16 16', 'the host draws icons on a 16x16 viewBox')
  assert.equal(svg.props.width, 14, 'the host renders menu icons at 14px')

  // The artwork is the host's `IconTrashOutlineRegular`, which the Harness itself
  // draws for a destructive menu row. Every `*OutlineRegular` glyph on this
  // surface strokes at 1px; the 1.3 medium weight this row once used belongs to a
  // different family and reads heavier than its neighbours.
  assert.equal(Number(svg.props.strokeWidth), 1, 'the outline family draws at 1px')

  const paths = elements.filter((entry) => entry.type === 'path')
  assert.equal(paths.length, 5, 'the host artwork is five paths')

  for (const path of paths) {
    // Outline glyphs are stroke-only. The translucent plate (`fill` + `opacity`)
    // belongs to the filled `*FillRegular` family and is exactly what made this
    // row look like it came from somewhere else.
    assert.equal(path.props.fill, undefined, 'outline glyphs carry no fill')
    assert.equal(path.props.opacity, undefined, 'outline glyphs carry no plate')
    assert.equal(path.props.stroke, 'currentColor', 'the path takes the row colour')
  }

  // Staying inside the viewBox is what keeps the glyph the same size as the
  // shipped ones at the same nominal 14px. Coordinates are read straight from the
  // path data, so bezier control points count too — they bound the curve.
  for (const path of paths) {
    const coordinates = (String(path.props.d ?? '').match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
    assert.ok(coordinates.length > 0, 'expected path coordinates')
    for (const value of coordinates) {
      assert.ok(
        value >= 0 && value <= 16,
        `coordinate ${value} falls outside the 16x16 viewBox`,
      )
    }
  }
})

await test('clicking the row opens a dialog and asks the Host for the plan', async () => {
  globalThis.document = fakeDom().document
  const calls = []
  const mount = mountPlugin({
    execute: async (agent, line) => {
      calls.push({ agent, line })
      return envelope({ kind: 'success', text: '1 log directory and its cached projection' })
    },
  })

  await mount.menuButton().props.onClick()
  await settle()

  assert.equal(calls.length, 1, 'one dry-run call is expected')
  assert.equal(calls[0].agent, TARGET, 'the call must target the row session')
  assert.equal(calls[0].line, `/delete-session ${TARGET}`, 'the dry run must not carry --confirm')

  const dialog = mount.dialog()
  assert.ok(dialog !== undefined, 'the confirmation dialog must be rendered from shell.overlay')
  const plan = flatten(dialog).find((element) => element.props?.className === 'sd-plan')
  assert.ok(plan !== undefined, 'the dialog must show the plan text the Host returned')
  assert.match(String(plan.props.children), /1 log directory/)
})

await test('the dialog opens on the click itself, before the Host answers', async () => {
  globalThis.document = fakeDom().document
  let release
  const pending = new Promise((resolve) => { release = resolve })
  const mount = mountPlugin({ execute: () => pending })

  const opened = mount.menuButton().props.onClick()
  await settle()

  // Still waiting on the Host: the dialog must already be on screen, otherwise a
  // slow or hanging read looks exactly like nothing happened.
  const dialog = mount.dialog()
  assert.ok(dialog !== undefined, 'the dialog must appear before the read completes')
  const plan = flatten(dialog).find((element) => element.props?.className === 'sd-plan')
  assert.match(String(plan.props.children), /Checking|正在确认/)

  release(envelope({ kind: 'success', text: '1 log directory' }))
  await opened
  await settle()
})

await test('the dialog is still there after the menu row has gone', async () => {
  globalThis.document = fakeDom().document
  const mount = mountPlugin()
  await mount.menuButton().props.onClick()
  await settle()

  // The menu closes on the same click, taking the row with it.
  mount.react.unmount()

  const dialog = mount.dialog()
  assert.ok(dialog !== undefined, 'the dialog must not depend on the row that raised it')
  assert.match(
    String(dialog.props['aria-label'] ?? ''),
    /A disposable session|永久删除/,
    'the dialog must still name the session it is about',
  )
})

await test('a failed read keeps the dialog open and shows the reason', async () => {
  globalThis.document = fakeDom().document
  const mount = mountPlugin({
    execute: async () => {
      throw new Error('cannot get property "agent" without inject')
    },
  })

  await mount.menuButton().props.onClick()
  await settle()

  // The regression this pins: an earlier version cleared the request on failure,
  // so the dialog vanished and a failed delete looked like no reaction.
  const dialog = mount.dialog()
  assert.ok(dialog !== undefined, 'a failure must leave the dialog in place')
  const alert = flatten(dialog).find((element) => element.props?.role === 'alert')
  assert.ok(alert !== undefined, 'a failure must be displayed, not swallowed')
  assert.match(String(alert.props.children), /without inject/)
})

await test('confirming sends --confirm, closes the dialog and reports success', async () => {
  globalThis.document = fakeDom().document
  const calls = []
  const mount = mountPlugin({
    execute: async (agent, line) => {
      calls.push(line)
      return envelope({
        kind: 'success',
        text: line.endsWith('--confirm') ? `Deleted ${agent}` : '1 log directory',
      })
    },
  })

  await mount.menuButton().props.onClick()
  await settle()

  const confirm = mount.confirmButton()
  assert.ok(confirm !== undefined, 'the dialog must offer the destructive action')
  await confirm.props.onClick()
  await settle()

  assert.equal(calls.length, 2, 'the confirmed call must follow the dry run')
  assert.equal(calls[1], `/delete-session ${TARGET} --confirm`)
  assert.equal(mount.dialog(), undefined, 'the dialog must close once the deletion is done')

  // A deleted session removes this very row, so success cannot be reported by the
  // row disappearing: it needs its own notice.
  const toast = mount.toast()
  assert.ok(toast !== undefined, 'a successful deletion must show a notice')
  const text = flatten(toast).find((element) => element.props?.className === 'sd-toast-text')
  assert.match(String(text.props.children), /Deleted/)
})

await test('an error result from the Host is displayed in the dialog', async () => {
  globalThis.document = fakeDom().document
  const mount = mountPlugin({
    execute: async (agent, line) => envelope(line.endsWith('--confirm')
      ? { kind: 'error', text: 'delete-session: [not-found] Session was not found on disk.' }
      : { kind: 'success', text: '1 log directory' }),
  })

  await mount.menuButton().props.onClick()
  await settle()
  const confirm = mount.confirmButton()
  await confirm.props.onClick()
  await settle()

  const dialog = mount.dialog()
  assert.ok(dialog !== undefined, 'the dialog must stay open so the failure can be read and retried')
  const alert = flatten(dialog).find((element) => element.props?.role === 'alert')
  assert.ok(alert !== undefined, 'a Host error result must be displayed')
  assert.match(String(alert.props.children), /not found/i)
  assert.equal(mount.toast(), undefined, 'a failed deletion must not claim success')
})

await test('a command result with no text still reports that something happened', async () => {
  globalThis.document = fakeDom().document
  const mount = mountPlugin({
    execute: async (agent, line) => envelope(line.endsWith('--confirm')
      ? { kind: 'success' }
      : { kind: 'success', text: '1 log directory' }),
  })

  await mount.menuButton().props.onClick()
  await settle()
  const confirm = mount.confirmButton()
  await confirm.props.onClick()
  await settle()

  const toast = mount.toast()
  assert.ok(toast !== undefined, 'a wordless success must still produce a notice')
  const text = flatten(toast).find((element) => element.props?.className === 'sd-toast-text')
  assert.ok(String(text.props.children).length > 0, 'the notice must carry text')
})

await test('a refused Remote call reports the refusal instead of claiming no result', async () => {
  globalThis.document = fakeDom().document
  const mount = mountPlugin({
    execute: async (agent, line) => (line.endsWith('--confirm')
      ? { ok: false, error: { code: 'agent/unknown', message: 'no agent for that session' } }
      : envelope({ kind: 'success', text: '1 log directory' })),
  })

  await mount.menuButton().props.onClick()
  await settle()
  const confirm = mount.confirmButton()
  await confirm.props.onClick()
  await settle()

  const alert = flatten(mount.dialog()).find((element) => element.props?.role === 'alert')
  assert.ok(alert !== undefined, 'a refusal must be displayed')
  assert.match(String(alert.props.children), /no agent for that session/)
})

await test('a line that resolves to no command says so rather than reporting nothing', async () => {
  globalThis.document = fakeDom().document
  // `value` is absent when the line names a command this profile does not have;
  // that is the shape the Host uses for an unresolved line.
  const mount = mountPlugin({ execute: async () => ({ ok: true, value: undefined }) })

  await mount.menuButton().props.onClick()
  await settle()

  const alert = flatten(mount.dialog()).find((element) => element.props?.role === 'alert')
  assert.ok(alert !== undefined, 'an unresolved command must be reported')
  assert.match(String(alert.props.children), /delete-session/)
})

await test('dismissing a pending confirmation clears it without a Host call', async () => {
  globalThis.document = fakeDom().document
  const calls = []
  const mount = mountPlugin({
    execute: async (agent, line) => {
      calls.push(line)
      return envelope({ kind: 'success', text: '1 log directory' })
    },
  })

  await mount.menuButton().props.onClick()
  await settle()
  const cancel = flatten(mount.dialog()).find((element) => element.props?.className === 'sd-button')
  assert.ok(cancel !== undefined, 'the dialog must offer a way out')
  cancel.props.onClick()
  await settle()

  assert.equal(mount.dialog(), undefined, 'dismissing must close the dialog')
  assert.equal(calls.length, 1, 'dismissing must not issue a confirmed call')
})

await test('an unavailable command channel disables the row instead of failing later', () => {
  globalThis.document = fakeDom().document
  const mount = mountPlugin({ withoutRemote: true })
  assert.equal(mount.menuButton().props.disabled, true)
})

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) process.exitCode = 1
