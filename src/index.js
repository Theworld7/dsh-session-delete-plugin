/**
 * Host half of dsh-session-delete-plugin.
 *
 * The Host owns the deletion because deletion is a filesystem operation. The
 * browser half reaches it over the framework's own Remote channel rather than a
 * private side-channel: the Client runs
 * `ctx.remote.commands.execute(agentId, '/delete-session <id> --confirm', [], signal)`,
 * the Agent lookup resolves that id to the target Session's Agent, and the
 * command registered below runs subscribed to that Session.
 *
 * That route was chosen deliberately over the two obvious alternatives:
 *
 *   - A new Remote namespace is impossible. The Client's callable surface is
 *     built at build time from generated Typert contributions, so a plugin
 *     cannot add one at runtime without a code-generation step.
 *   - A dynamic Cordis package has a real `host.call` bridge, but it is
 *     process-local and does not survive a page reload, so it cannot back a
 *     durable right-click action.
 *
 * The command route uses only public, documented contracts — the command
 * registry, the `workspace/session-stop` event, and the workspace registry
 * Service — and imports nothing from the Harness. That is what keeps this plugin
 * working across Harness versions.
 */

import { SessionEraser } from './eraser.js'

/** Rows and packages need unique names; this is also the Cordis service key. */
export const name = 'session-delete'

/** The command registry is the Client's only route here, so it is required. */
export const inject = ['commands']

/** The single command the Client invokes. */
const COMMAND = 'delete-session'

/** Marks an invocation as a confirmed deletion rather than a dry run. */
const CONFIRM_FLAG = '--confirm'

/**
 * Parse one invocation's raw input.
 * @param {string} rawInput - text the caller supplied after the command name.
 * @returns {{sessionId: string, confirmed: boolean}} the parsed request.
 */
function parseRequest(rawInput) {
  const parts = String(rawInput ?? '').trim().split(/\s+/).filter((part) => part !== '')
  return {
    sessionId: parts.find((part) => part !== CONFIRM_FLAG) ?? '',
    confirmed: parts.includes(CONFIRM_FLAG),
  }
}

/**
 * Summarize what a deletion would remove, so the confirmation dialog can state
 * a concrete fact instead of a generic warning.
 * @param {SessionEraser} eraser - the deletion Service.
 * @param {string} sessionId - validated Session id.
 * @returns {Promise<string>} human-readable summary.
 */
async function describePlan(eraser, sessionId) {
  const plan = await eraser.plan(sessionId)
  if (!plan.exists) return `no files found on disk for ${sessionId}`
  const logs = plan.directories.length
  const cache = plan.cachePath === null ? 'no cached projection' : 'its cached projection'
  return `${logs} log ${logs === 1 ? 'directory' : 'directories'} and ${cache}`
}

/**
 * Build the deletion command definition for one eraser.
 *
 * A request without `--confirm` is a dry run: it reports what would be removed
 * and writes nothing. The dialog uses that to describe the exact target, and the
 * same definition then performs the deletion, so the description and the action
 * cannot drift apart.
 *
 * Exported so the flag gate is testable without a live Cordis runtime.
 * @param {SessionEraser} eraser - the deletion Service.
 * @returns {object} a `CommandDefinition` for the command registry.
 */
export function createCommand(eraser) {
  return {
    name: COMMAND,
    description: 'Permanently delete a Session and its files, including its log and cached projection.',
    input: { hint: '<sessionId> [--confirm]' },
    handler: async ({ rawInput }) => {
      const { sessionId, confirmed } = parseRequest(rawInput)
      if (sessionId === '') {
        return { kind: 'error', text: 'delete-session: a Session id is required.' }
      }

      let id
      try {
        id = eraser.requireId(sessionId)
      } catch (error) {
        return { kind: 'error', text: `delete-session: ${error.message}` }
      }

      try {
        if (!confirmed) {
          return { kind: 'success', text: `${id}: ${await describePlan(eraser, id)}` }
        }

        const outcome = await eraser.delete(id)
        const logs = outcome.removedDirectories.length
        const removed = `${logs} log ${logs === 1 ? 'directory' : 'directories'}${outcome.removedCache ? ' and its cached projection' : ''}`
        const failed = outcome.registry.filter((entry) => !entry.ok)
        const warning = failed.length === 0
          ? ''
          : ` Warning: the Session is gone, but releasing its ${failed.map((entry) => entry.step).join('/')} registry entry failed.`
        return { kind: 'success', text: `Deleted ${id}, removing ${removed}.${warning}` }
      } catch (error) {
        const code = typeof error?.code === 'string' ? ` [${error.code}]` : ''
        const message = error instanceof Error ? error.message : String(error)
        return { kind: 'error', text: `delete-session:${code} ${message}` }
      }
    },
  }
}

/**
 * Install the deletion command.
 *
 * Registered on this plugin's own Context, so disabling or uninstalling the
 * plugin removes both the command and the Client's only route to the deletion
 * path.
 * @param {object} ctx - Host Cordis Context owning this plugin.
 * @param {object} [config] - the row's config, as declared in cordis.patch.yml.
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const eraser = new SessionEraser({
    sessionsRoot: config.sessionsRoot,
    storagesRoot: config.storagesRoot,
    blockActive: config.blockActive,
    stopActivity: config.stopActivity,
    cleanWorkspaceRegistry: config.cleanWorkspaceRegistry,
    cleanProjectionCache: config.cleanProjectionCache,
    host: {
      agents: () => ctx.get('agents'),
      registry: () => ctx.get('workspaceRegistry'),
      broadcast: async (event, request) => {
        // `workspace/session-stop` is a declared parallel event; dispatch it the
        // way the Harness does, tolerating a profile with no provider.
        if (typeof ctx.parallel !== 'function') return undefined
        return ctx.parallel(event, request)
      },
      // `api-session/removed` is on the Harness's forwarded-event allowlist, and
      // it is what every open page uses to drop a Session from its list. The
      // Harness emits it when a Session is disposed; a deletion of files is not
      // a disposal, so this plugin has to say so itself or the sidebar keeps a
      // row for a Session that no longer exists.
      announce: (sessionId) => ctx.emit('api-session/removed', sessionId),
    },
  })

  // The returned disposer is owned by this Context, so a disable or uninstall
  // removes the command.
  ctx.commands.register(createCommand(eraser))
}
