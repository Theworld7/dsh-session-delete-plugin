window.__ModuleLoader__.load({
  id: 'dsh-session-delete-plugin',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /**
     * The command the Host half registers. Kept in one place so the two halves
     * cannot disagree about the name.
     */
    const COMMAND = 'delete-session'

    /** The slot this plugin extends, and the keys it owns inside it. */
    const SLOT = 'sidebar.workspaces.session.menu.item'
    const ROW_ID = 'dsh-session-delete'
    const OVERLAY_SLOT = 'shell.overlay'
    const OVERLAY_ID = 'dsh-session-delete-confirm'

    /** This plugin's locale namespace. Namespaced by package, like every other. */
    const NS = 'dsh-session-delete'

    /** How long an outcome notice stays on screen before it clears itself. */
    const NOTICE_HOLD_MS = 6000

    /**
     * The last render failure this plugin hit, if any.
     *
     * A slot entry that throws while rendering is *abdicated*: the registry adds
     * it to a retired set, `entriesOfSlot()` skips it from then on, and the outlet
     * draws nothing for it. Registration itself succeeded, so Slot Inspect keeps
     * reporting the row as present and `active` — the row is simply never drawn
     * again. That combination once hid a real defect completely, so this plugin
     * records its own failure and shows it as a menu row instead of vanishing.
     */
    const crash = { error: null }

    /**
     * Visible text, routed through the Client locale service.
     *
     * The shipped bundles register a namespace the same way, so this row follows
     * the active locale and picks up the host's own language switch. `en` is also
     * the fallback the locale service uses for a key a locale omits.
     */
    const MESSAGES = {
      en: {
        'menu.delete': 'Delete session',
        'confirm.title': 'Delete this session permanently?',
        'confirm.body': 'This removes the session log and its cached data from disk. It cannot be undone or restored.',
        'confirm.cancel': 'Cancel',
        'confirm.action': 'Delete permanently',
        'confirm.pending': 'Deleting…',
        'confirm.aria': 'Delete {title} permanently',
        'error.unavailable': 'The Harness command channel is unavailable, so this action cannot run.',
        'status.unavailable': 'The Harness command channel is unavailable.',
        'error.generic': 'The deletion failed.',
        'error.rowFailed': 'Delete session could not be displayed',
        'error.noResult': 'The Harness returned no result for the deletion command.',
        'error.unknownCommand': 'This profile has no delete-session command. Is the Host half of the plugin active?',
        'status.reading': 'Checking what would be removed…',
        'status.plan': 'The Harness described the removal without words.',
        'result.done': 'The session was deleted. The list refreshes on its own.',
        'result.restart': 'The session was deleted. Reopen the list if it is still shown.',
      },
      zh: {
        'menu.delete': '删除会话',
        'confirm.title': '永久删除这个会话？',
        'confirm.body': '这会从磁盘上移除该会话的日志与缓存数据，无法撤销，也无法恢复。',
        'confirm.cancel': '取消',
        'confirm.action': '永久删除',
        'confirm.pending': '正在删除…',
        'confirm.aria': '永久删除 {title}',
        'error.unavailable': 'Harness 命令通道不可用，无法执行此操作。',
        'status.unavailable': 'Harness 命令通道不可用。',
        'error.generic': '删除失败。',
        'error.rowFailed': '删除会话菜单项无法显示',
        'error.noResult': 'Harness 没有返回删除命令的结果。',
        'error.unknownCommand': '当前 profile 里没有 delete-session 命令，插件的主进程部分可能没有启用。',
        'status.reading': '正在确认将要删除的内容…',
        'status.plan': 'Harness 没有说明将要删除的内容。',
        'result.done': '会话已删除，列表会自动刷新。',
        'result.restart': '会话已删除，如果列表里还在，请重新打开列表。',
      },
    }

    /**
     * Interpolate `{name}` placeholders.
     * @param {string} template - text carrying placeholders.
     * @param {Record<string, string>} values - replacement values.
     * @returns {string} the filled text.
     */
    function fill(template, values) {
      return template.replace(/\{(\w+)\}/g, (match, key) => (key in values ? values[key] : match))
    }

    /**
     * Turn any thrown value into one line of text, without ever throwing itself.
     * @param {unknown} value - the thrown value.
     * @returns {string} readable text.
     */
    function messageOf(value) {
      try {
        if (value instanceof Error) return `${value.name}: ${value.message}`
        if (typeof value === 'string') return value
        return String(value)
      } catch {
        return 'unknown error'
      }
    }

    /**
     * Strip the Host-owned command prefix so a failure reads as a sentence.
     * @param {unknown} value - whatever failed.
     * @returns {string|null} text safe to render, or null when nothing is left.
     */
    function errorText(value) {
      const raw = messageOf(value).replace(/^delete-session:\s*(\[[^\]]*\]\s*)?/, '').trim()
      return raw === '' ? null : raw
    }

    /**
     * A minimal observable.
     *
     * Both halves of this plugin are registered separately — the row into the
     * session menu, the dialog into the shell overlay — so they meet at these
     * signals rather than in one component's state. The shape is the one React's
     * `useSyncExternalStore` reads, which is also how the renderer binds a slot
     * entry's `hooks` face.
     * @param {*} initial - starting value.
     * @returns {object} the store: `get`/`set` plus React's reader pair.
     */
    function createSignal(initial) {
      let value = initial
      const listeners = new Set()
      const getSnapshot = () => value
      return {
        get: getSnapshot,
        set(next) {
          if (Object.is(next, value)) return
          value = next
          for (const listener of [...listeners]) listener()
        },
        getSnapshot,
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      }
    }

    /** Read one signal the way the renderer's own hook bindings do. */
    function useSignal(signal) {
      return React.useSyncExternalStore(signal.subscribe, signal.getSnapshot)
    }

    /**
     * Render a `{ text, key }` phrase: the Host's own words when it sent words,
     * this plugin's translation of the recorded key when it did not.
     * @param {{text: string|null, key: string}|null} value - the phrase.
     * @param {(key: string) => string} t - translator for the fallback.
     * @returns {string|null} text to render.
     */
    function phrase(value, t) {
      if (value === null || value === undefined) return null
      return value.text !== null && value.text !== '' ? value.text : t(value.key)
    }

    /**
     * The deletion flow, owned by the plugin rather than by the menu row.
     *
     * This split is the whole design. A row of `sidebar.workspaces.session.menu.item`
     * is unmounted when its menu closes — the Host's own actions say so in as many
     * words — so anything a row registers dies with the click that registered it.
     * An earlier version kept the dialog and the notice in the row's own effects
     * and was therefore indistinguishable from a plugin that did nothing at all:
     * it closed the menu, tore its own registration down, and every later state
     * update landed in an unmounted component.
     *
     * The two slots therefore share this controller: the row asks for a
     * confirmation, the overlay draws it.
     *
     * @param {object} deps - ambient capabilities.
     * @param {object|undefined} deps.commands - the `remote.commands` namespace.
     * @returns {object} the controller.
     */
    function createController(deps) {
      const request = createSignal(null)
      const notice = createSignal(null)
      let noticeTimer = null

      const available = deps.commands !== null && deps.commands !== undefined
        && typeof deps.commands.execute === 'function'

      /**
       * Run one command and reduce every answer shape to one record.
       *
       * A Remote call answers with a tagged envelope — `{ ok: true, value }` or
       * `{ ok: false, error }` — and the command's own `CommandResult` sits at
       * `value.result`. Reading `result` off the envelope instead is a silent
       * dead end: it is always `undefined`, so every deletion reports "no result"
       * without ever reaching the Host's work.
       *
       * Inside that, a business failure arrives as `{ kind: 'error' }` within a
       * *successful* call — only a transport or policy failure rejects. A delete
       * that silently does nothing is the worst possible outcome here, so neither
       * shape is allowed to be swallowed.
       * @param {string} sessionId - the session to act on.
       * @param {boolean} confirmed - whether to perform the deletion.
       * @returns {Promise<object>} `{ text, key, failed, gone }`.
       */
      const execute = async (sessionId, confirmed) => {
        if (!available) return { text: null, key: 'error.unavailable', failed: true, gone: false }
        const refused = (key) => ({ text: null, key, failed: true, gone: false })
        try {
          const line = `/${COMMAND} ${sessionId}${confirmed ? ' --confirm' : ''}`
          const response = await deps.commands.execute(sessionId, line, [], new AbortController().signal)
          if (response === null || response === undefined) return refused('error.noResult')
          if (response.ok === false) {
            const detail = response.error?.message
            return {
              text: typeof detail === 'string' ? errorText(detail) : null,
              key: 'error.generic',
              failed: true,
              gone: false,
            }
          }
          // Absent `value` means the line resolved to no command at all.
          const outcome = response.value?.result
          if (outcome === null || outcome === undefined) return refused('error.unknownCommand')
          const failed = outcome.kind === 'error'
          const text = typeof outcome.text === 'string' ? errorText(outcome.text) : null
          return { text, key: failed ? 'error.generic' : 'result.done', failed, gone: confirmed && !failed }
        } catch (reason) {
          return { text: errorText(reason), key: 'error.generic', failed: true, gone: false }
        }
      }

      /**
       * Raise a confirmation for one session and fill in what would be removed.
       *
       * The dialog is raised first and described afterwards, so a slow or hanging
       * read still shows the operator that something is happening.
       * @param {string} sessionId - the session to delete.
       * @param {string} displayTitle - its title, for the dialog.
       * @returns {Promise<void>} resolves when the description has landed.
       */
      const open = async (sessionId, displayTitle) => {
        if (!available) return
        request.set({ sessionId, displayTitle, plan: null, busy: true, error: null })
        const outcome = await execute(sessionId, false)
        // A newer request, or a dismissal, supersedes this answer.
        if (request.get()?.sessionId !== sessionId) return
        request.set({
          sessionId,
          displayTitle,
          // `status.plan`, not the outcome key: this line describes what would be
          // removed, it does not report a completed deletion.
          plan: outcome.failed ? null : { text: outcome.text, key: 'status.plan' },
          busy: false,
          error: outcome.failed ? { text: outcome.text, key: outcome.key } : null,
        })
      }

      /**
       * Perform the confirmed deletion.
       *
       * Success clears the request and raises the notice. A deletion removes the
       * very row that asked for it, so the row cannot report its own success —
       * without the notice a working delete looked exactly like a broken one.
       * @returns {Promise<void>} resolves once the outcome is recorded.
       */
      const confirm = async () => {
        const current = request.get()
        if (current === null || current.busy) return
        request.set({ ...current, busy: true, error: null })
        const outcome = await execute(current.sessionId, true)
        if (request.get()?.sessionId !== current.sessionId) return
        if (outcome.failed) {
          request.set({ ...current, busy: false, error: { text: outcome.text, key: outcome.key } })
          return
        }
        request.set(null)
        notice.set({ text: outcome.text, key: outcome.key, gone: outcome.gone })
        if (noticeTimer !== null) clearTimeout(noticeTimer)
        noticeTimer = setTimeout(() => {
          noticeTimer = null
          notice.set(null)
        }, NOTICE_HOLD_MS)
      }

      /** Close the dialog. A request in flight is not interruptible. */
      const dismiss = () => {
        const current = request.get()
        if (current === null || current.busy) return
        request.set(null)
      }

      /** @returns {void} cancels the notice timer, for the plugin's disposal. */
      const dispose = () => {
        if (noticeTimer === null) return
        clearTimeout(noticeTimer)
        noticeTimer = null
      }

      return { request, notice, available, open, confirm, dismiss, dispose }
    }

    /**
     * Styles for this plugin only.
     *
     * Every colour is a `--dsw-alias-*` theme token, which is the whole styling
     * contract the Client exposes: a token that is renamed degrades the
     * appearance but can never break rendering. Radii use the host's own
     * `--dsw-radius-*` scale — the one its menu rows are drawn with. Geometry
     * that has no token at all (widths, spacing) is copied from the host's menu
     * and dialog so the row and the confirmation sit in the same visual system.
     */
    const CSS = `
.sd-item-wrap { position: relative; }
.sd-separator { height: 0.5px; margin: 3px 2px; background: var(--dsw-alias-border-l2); }
.sd-item {
  display: flex; align-items: center; gap: 6px; width: 100%;
  min-height: 34px; padding: 6px 8px; border: none; border-radius: var(--dsw-radius-md);
  background: transparent; cursor: pointer; font-size: 13px; line-height: 20px;
  color: var(--dsw-alias-state-error-primary); text-align: left;
}
.sd-item:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); }
.sd-item:focus-visible:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); outline: none; }
.sd-item:disabled { opacity: 0.4; cursor: not-allowed; }
.sd-icon { display: inline-flex; flex: none; width: 14px; height: 14px; align-items: center; justify-content: center; }
.sd-icon svg { width: 14px; height: 14px; }
.sd-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sd-fault { padding: 6px 8px; font-size: 11px; line-height: 15px; color: var(--dsw-alias-state-error-primary); word-break: break-word; }
.sd-fault-detail { display: block; margin-top: 2px; color: var(--dsw-alias-label-secondary); }

.sd-root {
  pointer-events: auto; position: fixed; inset: 0; z-index: 1000;
  display: flex; align-items: center; justify-content: center; padding: 24px;
}
.sd-mask { position: absolute; inset: 0; background: var(--dsw-alias-bg-base); opacity: 0.55; }
.sd-dialog {
  box-sizing: border-box; position: relative; z-index: 1;
  display: flex; flex-direction: column; gap: 20px;
  width: min(420px, 100%); padding: 24px;
  border-radius: 12px; background: var(--dsw-alias-bg-layer-2);
  box-shadow: 0 8px 32px rgb(0 0 0 / 24%);
}
.sd-title { margin: 0; font-size: 16px; line-height: 24px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.sd-body { display: flex; flex-direction: column; gap: 10px; }
.sd-text { margin: 0; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-primary); }
.sd-plan {
  margin: 0; padding: 10px 12px; border-radius: 8px; font-size: 13px; line-height: 20px;
  background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-secondary); word-break: break-all;
}
.sd-error { margin: 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-state-error-primary); }
.sd-footer { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.sd-button {
  min-height: 32px; padding: 0 14px; border-radius: 8px; cursor: pointer;
  font-size: 13px; line-height: 20px; border: 1px solid var(--dsw-alias-border-l2);
  background: transparent; color: var(--dsw-alias-label-primary);
}
.sd-button:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-1); }
.sd-button:disabled { opacity: 0.5; cursor: not-allowed; }
.sd-danger { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }

.sd-toast {
  position: fixed; left: 50%; bottom: 32px; transform: translateX(-50%);
  z-index: 1100; pointer-events: none;
  display: flex; flex-direction: column; gap: 4px;
  max-width: min(480px, calc(100vw - 48px));
  padding: 12px 16px; border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
  box-shadow: 0 8px 28px rgb(0 0 0 / 24%);
}
.sd-toast-text { font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary); word-break: break-word; }
.sd-toast-hint { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
`

    /**
     * Install this plugin's stylesheet and return its remover.
     *
     * A static Client bundle runs inside a sandboxed module factory, so it has no
     * access to the stylesheet helper the dynamic-package path provides. One
     * `<style>` element, removed by the effect that owns it, is the whole
     * requirement — and it keeps a disable or uninstall from leaving rules behind.
     * @returns {() => void} disposer removing the element.
     */
    function installStyles() {
      const element = document.createElement('style')
      element.setAttribute('data-dsh-plugin', 'dsh-session-delete-plugin')
      element.textContent = CSS
      document.head.appendChild(element)
      return () => element.remove()
    }

    /**
     * The host's own trash artwork, reproduced verbatim.
     *
     * The Harness draws `IconTrashOutlineRegular` for a destructive menu row —
     * its workspace menu pairs "Rename" (`IconEditOutlineRegular`) with "Delete"
     * (`IconTrashOutlineRegular`, `danger: true`) on this very surface. This
     * plugin cannot import that component: `dsh-client-ui-primitives` is a
     * `@deepseek-ai/*` module, and depending on nothing but the published
     * contract is the whole point. So the geometry is copied instead, to the
     * last control point.
     *
     * Matching the family means matching all of it, which an earlier hand-drawn
     * version did not:
     * - a uniform 1px stroke, not the medium 1.3 — every `*OutlineRegular` glyph
     *   in that menu, and `IconTrashOutlineRegular` itself, is 1;
     * - no background plate. The `opacity: 0.1` silhouette belonged to the
     *   filled `*FillRegular` family, which this menu does not use;
     * - no `stroke-linecap`/`stroke-linejoin` override. The rounding comes from
     *   the paths' own curves (`C` commands on the handle and the body's base);
     *   forcing `round` on straight segments is what made the old lid and ribs
     *   read as a different, blunter set.
     */
    function TrashIcon() {
      return h('svg', {
        viewBox: '0 0 16 16', width: 14, height: 14,
        fill: 'none', xmlns: 'http://www.w3.org/2000/svg',
        'aria-hidden': true, strokeWidth: 1,
      },
      // Lid.
      h('path', { d: 'M1.28149 3.88831H14.7187', stroke: 'currentColor' }),
      // Handle and the stand-off above the lid.
      h('path', {
        d: 'M5.41602 3.88833V2.47962C5.41602 2.29282 5.52492 2.11366 5.71876 1.98157C5.9126 1.84948 6.17551 1.77527 6.44964 1.77527H9.55053C9.82466 1.77527 10.0876 1.84948 10.2814 1.98157C10.4753 2.11366 10.5842 2.29282 10.5842 2.47962V3.88833',
        stroke: 'currentColor',
      }),
      // Body — tapers inward, rounded base.
      h('path', {
        d: 'M2.57349 3.88831L3.19366 13.2943C3.21937 13.5502 3.33952 13.7872 3.53065 13.9593C3.72178 14.1313 3.97016 14.2259 4.22729 14.2246H11.7728C12.0299 14.2259 12.2783 14.1313 12.4694 13.9593C12.6605 13.7872 12.7807 13.5502 12.8064 13.2943L13.4266 3.88831',
        stroke: 'currentColor',
      }),
      // Ribs.
      h('path', { d: 'M6.44946 6.98926V11.1238', stroke: 'currentColor' }),
      h('path', { d: 'M9.55054 6.98926V11.1238', stroke: 'currentColor' }))
    }

    /** The confirmation dialog, rendered while a request is pending. */
    function ConfirmDialog(props) {
      const { request, onConfirm, onDismiss, t } = props
      const { busy, error } = request
      const cancelRef = React.useRef(null)

      // Focus lands on the safe action, and stays there while the destructive one
      // is in flight. `useEffect` runs after paint, so the node exists.
      React.useEffect(() => {
        if (cancelRef.current !== null) cancelRef.current.focus()
      }, [])

      const onKeyDown = (event) => {
        if (event.key === 'Escape' && !busy) {
          event.stopPropagation()
          onDismiss()
        }
      }

      const title = request.displayTitle === '' ? request.sessionId : request.displayTitle
      // While the description is still being read the dialog says so; if the read
      // itself failed the reason is shown below instead, so there is no line left
      // to draw here.
      const plan = busy
        ? t('status.reading')
        : request.plan !== null ? phrase(request.plan, t) : null
      return h('div', {
        className: 'sd-root',
        onClick: () => { if (!busy) onDismiss() },
        onKeyDown,
      },
      h('div', { className: 'sd-mask', 'aria-hidden': true }),
      h('div', {
        className: 'sd-dialog', role: 'dialog', 'aria-modal': true,
        'aria-label': fill(t('confirm.aria'), { title }),
        onClick: (event) => event.stopPropagation(),
      },
      h('h2', { className: 'sd-title' }, t('confirm.title')),
      h('div', { className: 'sd-body' },
        h('p', { className: 'sd-text' }, title),
        h('p', { className: 'sd-text' }, t('confirm.body')),
        plan === null ? null : h('p', { className: 'sd-plan' }, plan),
        error === null ? null : h('p', { className: 'sd-error', role: 'alert' }, phrase(error, t))),
      h('div', { className: 'sd-footer' },
        h('button', {
          type: 'button', className: 'sd-button', disabled: busy,
          ref: cancelRef, onClick: onDismiss,
        }, t('confirm.cancel')),
        h('button', {
          type: 'button', className: 'sd-button sd-danger', disabled: busy,
          onClick: onConfirm,
        }, busy ? t('confirm.pending') : t('confirm.action')))))
    }

    /**
     * The outcome notice.
     *
     * A successful deletion removes the row that started it, so the row cannot
     * report success itself — without this notice the delete looked like it did
     * nothing at all even when it worked.
     */
    function ResultToast(props) {
      const { notice, t } = props
      return h('div', { className: 'sd-toast', role: 'status', 'aria-live': 'polite' },
        h('span', { className: 'sd-toast-text' }, phrase(notice, t)),
        notice.gone ? h('span', { className: 'sd-toast-hint' }, t('result.restart')) : null)
    }

    /**
     * The `shell.overlay` entry: the dialog while a confirmation is pending, the
     * notice after a deletion, nothing in between.
     *
     * It is registered for the plugin's whole life rather than from the row that
     * raises a confirmation, because that row unmounts with its menu.
     */
    function DeleteSessionOverlay(props) {
      const { request, notice, confirm, dismiss, t: injectedT } = props
      const pending = useSignal(request)
      const result = useSignal(notice)

      const t = React.useMemo(() => {
        if (typeof injectedT === 'function') return injectedT
        return (key) => MESSAGES.en[key] ?? key
      }, [injectedT])

      return h(React.Fragment, null,
        pending === null ? null : h(ConfirmDialog, { request: pending, onConfirm: confirm, onDismiss: dismiss, t }),
        result === null ? null : h(ResultToast, { notice: result, t }))
    }

    /**
     * The row itself.
     *
     * It carries no state and registers nothing: it closes its menu and raises a
     * confirmation on the shared controller. Everything it reads is treated as
     * optional, so a piece this version stops projecting degrades the row instead
     * of throwing and retiring the entry.
     */
    function DeleteSessionRow(props) {
      const { sessionId, displayTitle, open, available, t: injectedT } = props
      const menuHook = props.useMenuOpenState

      const t = React.useMemo(() => {
        if (typeof injectedT === 'function') return injectedT
        return (key) => MESSAGES.en[key] ?? key
      }, [injectedT])

      // The owner supplies this hook through the slot's `hookContext`.
      const closeMenu = React.useMemo(() => {
        if (typeof menuHook !== 'function') return () => {}
        try {
          const pair = menuHook()
          const setter = Array.isArray(pair) ? pair[1] : undefined
          return typeof setter === 'function' ? setter : () => {}
        } catch {
          return () => {}
        }
      }, [menuHook])

      return h('div', { className: 'sd-item-wrap', 'data-dsh-session-delete': 'row' },
        h('div', { className: 'sd-separator', role: 'separator' }),
        h('button', {
          type: 'button', role: 'menuitem', className: 'sd-item',
          disabled: available !== true,
          title: available === true ? undefined : t('status.unavailable'),
          onClick: () => { closeMenu(false); open(sessionId, displayTitle) },
        },
        h('span', { className: 'sd-icon' }, TrashIcon()),
        h('span', { className: 'sd-label' }, t('menu.delete'))))
    }

    /** Shown in the row's place when the row itself could not be rendered. */
    function FaultRow(props) {
      const t = props.t
      return h('div', { className: 'sd-item-wrap', 'data-dsh-session-delete': 'fault' },
        h('div', { className: 'sd-separator', role: 'separator' }),
        h('div', { className: 'sd-fault', role: 'alert' },
          t('error.rowFailed'),
          h('span', { className: 'sd-fault-detail' }, crash.error)))
    }

    /**
     * Render the row, or report the reason it could not be rendered.
     *
     * Without this, a throw here retires the entry permanently and the row never
     * appears — with no registration-level symptom at all.
     */
    class SafeRow extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }

      static getDerivedStateFromError() {
        return { failed: true }
      }

      componentDidCatch(error) {
        crash.error = messageOf(error)
        console.error('[dsh-session-delete] menu row failed to render:', error)
      }

      render() {
        const t = typeof this.props.t === 'function' ? this.props.t : (key) => MESSAGES.en[key] ?? key
        if (this.state.failed || crash.error !== null) return h(FaultRow, { t })
        return h(DeleteSessionRow, this.props)
      }
    }

    /**
     * Resolve a service the way plain-JavaScript plugin code has to: an
     * `inject`ed name is answered by the context, so ask for the exact key before
     * falling back to the context property.
     * @param {object} ctx - the plugin's Client context.
     * @param {string} name - the service key.
     * @returns {object|undefined} the service, when present.
     */
    function service(ctx, name) {
      if (typeof ctx.get === 'function') return ctx.get(name) ?? undefined
      return ctx[name]
    }

    return {
      // Every key this half touches must be declared. `remote.commands` is a
      // service of its own: the Cordis context proxy answers a declared name and
      // throws `cannot get property "remote.commands" without inject` for any
      // other, so it has to be listed here and read with `ctx.get`, not reached
      // through the `remote` service.
      inject: ['slots', 'remote.commands', 'locale'],
      // The inner components, exported under names the Harness ignores so
      // tests/check-client.mjs can render them without standing up a reconciler.
      // Production always goes through `SafeRow`.
      __row: DeleteSessionRow,
      __overlay: DeleteSessionOverlay,
      __faultRow: FaultRow,
      apply(ctx) {
        const slots = service(ctx, 'slots')
        if (slots === undefined) return
        const controller = createController({ commands: service(ctx, 'remote.commands') })
        const locale = service(ctx, 'locale')

        // The effect owns the stylesheet, so unloading the plugin removes it.
        ctx.effect(() => installStyles(), 'session-delete.styles')

        // Dictionaries are registered under this package's own namespace, and the
        // slot registration names it so the owner projects `t` in the active locale.
        if (locale !== undefined && typeof locale.register === 'function') {
          ctx.effect(() => locale.register(NS, MESSAGES), 'session-delete.locale')
        }

        // The outcome notice clears itself on a timer, and this effect owns it.
        ctx.effect(() => () => controller.dispose(), 'session-delete.notice')

        // Watch this plugin's own entries for a render crash. The registry retires
        // a crashed list entry, so afterwards the outlet draws nothing for it;
        // recording the reason turns a silent disappearance into a visible one.
        if (typeof slots.onEntryError === 'function') {
          ctx.effect(() => slots.onEntryError((key, entry, error) => {
            const id = entry?.options?.id ?? entry?.id
            const owned = (key === SLOT && id === ROW_ID) || (key === OVERLAY_SLOT && id === OVERLAY_ID)
            if (!owned) return
            crash.error = messageOf(error)
            console.error('[dsh-session-delete] an entry was retired after a render failure:', key, error)
          }), 'session-delete.entry-error')
        }

        // The dialog first, and for the plugin's whole life. Registering it from
        // the row would tie it to the row's lifetime, and a row of this slot is
        // unmounted the moment its menu closes — which is the very click that
        // asks for the dialog. Everything transient lives on the controller's
        // signals instead.
        slots.inject(OVERLAY_SLOT, () => slots.register({
          name: OVERLAY_SLOT,
          id: OVERLAY_ID,
          order: 500,
          locale: NS,
          inject: () => ({
            request: controller.request,
            notice: controller.notice,
            confirm: controller.confirm,
            dismiss: controller.dismiss,
          }),
        }, DeleteSessionOverlay))

        slots.inject(SLOT, () => slots.register({
          name: SLOT,
          id: ROW_ID,
          // After the shipped rows: pin 100, rename 200, fork 300, archive 400.
          order: 500,
          locale: NS,
          // `inject` is CALLED by the renderer — `runInject` does `inject(...args)`
          // and merges the returned object into the entry's props — so it must be
          // a function. A plain object throws on the row's first render, and the
          // per-entry error boundary then retires the row silently.
          //
          // The row is handed the two things it needs and nothing more: the
          // `remote.commands` namespace stays on the controller, so the row can
          // never reach the command channel by itself and outlive the dialog.
          inject: () => ({ open: controller.open, available: controller.available }),
        }, SafeRow))
      },
    }
  },
})
