/**
 * Permanent removal of one Session's on-disk footprint.
 *
 * Why this exists: the Harness exposes NO delete or remove operation for a
 * Session anywhere in its public surface. `archive` only appends the id to a
 * durable hidden-set and leaves every byte on disk. This module is therefore the
 * whole deletion capability, and it is deliberately self-contained: it reads the
 * documented on-disk layout directly and uses only public Services and Events,
 * never another package's internal module and never an `@deepseek-ai/*` import.
 *
 * Layout it relies on (verified against a live install):
 *
 *   <sessionsRoot>/<projectKey>/<sessionId>/session.v4.jsonl.zstd
 *   <storagesRoot>/session_projcache/sessions/<sessionId>.json
 *   <storagesRoot>/workspace.json            (archived / pinned id sets)
 *
 * Removing the Session directory is sufficient to make the Session disappear
 * everywhere, and this is a property of the Harness rather than of this plugin:
 *
 *   - The JSONL backend enumerates Sessions by walking `<sessionsRoot>` project
 *     directories and then session directories, so a removed directory is simply
 *     never listed; there is no index that could keep pointing at it.
 *   - A workspace derives its visible `sessionIds` by filtering its own recorded
 *     account through `sessionPath(id)`, so an id whose directory is gone drops
 *     out of the flat list and out of every workspace grouping by itself.
 *
 * What is left to do here is the part the Harness will not do for us: stop the
 * Session's running work so no live writer is appending to a file we unlink, and
 * drop the id from the registry-global archived/pinned sets, which are plain
 * arrays of ids that no path filter touches.
 */

import { readdir, rm, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'

/** Session ids are opaque, but they are also path segments: refuse anything else. */
const SESSION_ID = /^session-[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Storage unit and table that hold a Session's cached projection. */
const PROJ_CACHE_DIR = 'session_projcache'
const PROJ_CACHE_TABLE = 'sessions'

/**
 * Resolve a Harness root the way the Harness itself does: explicit config first,
 * then the `DSH_HOME` this process was launched with, then the platform default.
 * @param {string} configured - explicit value from this plugin's Config.
 * @param {string} child - directory name under the Harness home.
 * @returns {string} absolute root path.
 */
function resolveRoot(configured, child) {
  const explicit = String(configured ?? '').trim()
  if (explicit !== '') return resolve(explicit)
  const home = process.env.DSH_HOME?.trim()
  const base = home !== undefined && home !== '' ? home : join(homedir(), '.dsh')
  return resolve(join(base, child))
}

/**
 * @param {string} code - stable machine-readable reason.
 * @param {string} message - human-readable detail.
 * @returns {Error} failure carrying `code`.
 */
export function failure(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * Whether a path is the intended root or something strictly inside it. Guards
 * against a crafted id escaping its project directory.
 * @param {string} candidate - path about to be removed.
 * @param {string} root - root it must stay within.
 * @returns {boolean} true when removal is confined to the root.
 */
function inside(candidate, root) {
  const target = resolve(candidate)
  const base = resolve(root)
  return target.startsWith(base + sep)
}

/**
 * Permanently deletes one Session.
 *
 * Constructed per activation and owned by the plugin's Cordis effect, so a
 * disable or an uninstall simply drops it.
 */
export class SessionEraser {
  /**
   * @param {object} options - resolved configuration and ambient capabilities.
   * @param {string} [options.sessionsRoot] - Session log root; empty derives it.
   * @param {string} [options.storagesRoot] - storage root; empty derives it.
   * @param {boolean} [options.blockActive] - refuse rather than stop a live Session.
   * @param {boolean} [options.stopActivity] - stop a live Session's work before removal.
   * @param {boolean} [options.cleanWorkspaceRegistry] - drop archived/pinned ids.
   * @param {boolean} [options.cleanProjectionCache] - remove the cached projection.
   * @param {object} options.host - ambient Host capabilities.
   * @param {() => object | undefined} options.host.agents - `ctx.get('agents')`.
   * @param {() => object | undefined} options.host.registry - `ctx.get('workspaceRegistry')`.
   * @param {(name: string, request: object) => Promise<unknown>} options.host.broadcast -
   *   parallel Event dispatch, used to stop a Session's work.
   * @param {(sessionId: string) => void} options.host.announce - forwarded Event that
   *   makes every Client drop a Session from its list.
   */
  constructor(options) {
    this.sessionsRoot = resolveRoot(options.sessionsRoot, 'sessions')
    this.storagesRoot = resolveRoot(options.storagesRoot, 'storages')
    this.blockActive = options.blockActive !== false
    this.stopActivity = options.stopActivity !== false
    this.cleanWorkspaceRegistry = options.cleanWorkspaceRegistry !== false
    this.cleanProjectionCache = options.cleanProjectionCache !== false
    this.host = options.host
  }

  /**
   * Find the physical directories holding one Session.
   *
   * A Session id is globally unique, but the project directory above it derives
   * from that Session's `cwd`, which this plugin should not have to know. Walking
   * the handful of project directories finds it wherever it lives and stays
   * correct when the Harness renames or re-nests that layout's parent.
   * @param {string} sessionId - validated Session id.
   * @returns {Promise<string[]>} absolute Session directories.
   */
  async locate(sessionId) {
    let projects
    try {
      projects = await readdir(this.sessionsRoot, { withFileTypes: true })
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
    const found = []
    for (const project of projects) {
      if (!project.isDirectory()) continue
      const candidate = join(this.sessionsRoot, project.name, sessionId)
      if (!inside(candidate, this.sessionsRoot)) continue
      try {
        if ((await stat(candidate)).isDirectory()) found.push(candidate)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
    return found
  }

  /**
   * Describe what a delete would remove, without changing anything. The UI calls
   * this to render an accurate confirmation instead of guessing.
   * @param {string} sessionId - Session id to inspect.
   * @returns {Promise<object>} plan with directories, cache path and live state.
   */
  async plan(sessionId) {
    const id = this.requireId(sessionId)
    const directories = await this.locate(id)
    const cachePath = join(this.storagesRoot, PROJ_CACHE_DIR, PROJ_CACHE_TABLE, `${id}.json`)
    let cache = null
    try {
      if ((await stat(cachePath)).isFile()) cache = cachePath
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    return {
      sessionId: id,
      directories,
      cachePath: cache,
      live: this.isLive(id),
      exists: directories.length > 0 || cache !== null,
    }
  }

  /**
   * Permanently delete one Session: stop its work, detach it from the workspace
   * registry, then remove its log directory and cached projection.
   * @param {string} sessionId - Session id to delete.
   * @returns {Promise<object>} outcome naming exactly what was removed.
   */
  async delete(sessionId) {
    const id = this.requireId(sessionId)
    const plan = await this.plan(id)

    if (!plan.exists) throw failure('not-found', `Session ${id} was not found on disk.`)
    if (plan.live && this.blockActive && !this.stopActivity) {
      throw failure('active', `Session ${id} is open in this Harness. Close it, or allow stopping its work, before deleting.`)
    }

    // Stop first. A live Agent holds a writer on the log, and unlinking a file
    // another handle is still appending to is how a delete damages a neighbour.
    // The Harness's own stop hook does this through the same cancel paths the
    // user's stop button uses, so every open turn closes regularly.
    if (plan.live && this.stopActivity) await this.stop(id)

    const registryEffects = []
    const registry = this.host.registry()
    if (this.cleanWorkspaceRegistry && registry !== undefined) {
      // Both calls only remove an id, so they are idempotent and run no
      // existence check: they succeed even though the Session is already gone.
      registryEffects.push(await this.attempt('unarchive', () => registry.unarchiveSession?.(id)))
      registryEffects.push(await this.attempt('unpin', () => registry.unpinSession?.(id)))
    }

    for (const directory of plan.directories) {
      if (!inside(directory, this.sessionsRoot)) {
        throw failure('unsafe-path', `Refusing to remove ${directory}: it is outside ${this.sessionsRoot}.`)
      }
      await rm(directory, { recursive: true, force: true })
    }

    let removedCache = false
    if (this.cleanProjectionCache && plan.cachePath !== null) {
      await rm(plan.cachePath, { force: true })
      removedCache = true
    }

    // Tell every open page the Session is gone, on the same forwarded event the
    // Harness announces a disposal with. Removing a directory is not a disposal,
    // so nothing else would: without this the row stays in the sidebar until the
    // next list refresh, which is exactly the "deleted but still there" report.
    // It runs last, and a notification failure must not turn a finished deletion
    // into a reported failure.
    try {
      this.host.announce(id)
    } catch {
      // The row drops out on the next list refresh instead.
    }

    return {
      sessionId: id,
      removedDirectories: plan.directories,
      removedCache,
      registry: registryEffects,
    }
  }

  /**
   * @param {string} sessionId - candidate id.
   * @returns {string} the id, once proven to be a safe path segment.
   * @throws {Error} `invalid-id` when it is not a Session id.
   */
  requireId(sessionId) {
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) {
      throw failure('invalid-id', `Not a Session id: ${JSON.stringify(sessionId)}.`)
    }
    return sessionId
  }

  /**
   * @param {string} sessionId - validated Session id.
   * @returns {boolean} whether a live Agent currently holds it.
   */
  isLive(sessionId) {
    const agents = this.host.agents()
    return agents !== undefined && agents.get(sessionId) !== undefined
  }

  /**
   * Ask the Harness to stop one Session's running work through its own hook.
   * @param {string} sessionId - validated live Session id.
   * @returns {Promise<void>} resolves once every provider was asked.
   */
  async stop(sessionId) {
    await this.attempt('stop', () => this.host.broadcast('workspace/session-stop', { sessionId }))
  }

  /**
   * Run one best-effort step and keep its outcome as data. A cleanup that cannot
   * run must never be reported as a failed deletion: the Session directory is
   * what the caller asked to remove, and its removal is the operation that counts.
   * @param {string} step - step name for the outcome record.
   * @param {() => Promise<unknown> | undefined} operation - step to run.
   * @returns {Promise<{step: string, ok: boolean, reason?: string}>} the outcome.
   */
  async attempt(step, operation) {
    try {
      const pending = operation()
      if (pending !== undefined) await pending
      return { step, ok: true }
    } catch (error) {
      return { step, ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }
}
