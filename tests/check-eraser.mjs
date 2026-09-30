/**
 * Behavioural checks for the Host half's deletion logic.
 *
 * These run against a synthetic Harness layout in a temp directory, so no real
 * Session is ever touched. Run with:
 *
 *   node tests/check-eraser.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SessionEraser } from '../src/eraser.js'
import { createCommand } from '../src/index.js'

const SESSION = 'session-11111111-2222-3333-4444-555555555555'
const PROJECT = '--C-Users-someone-Documents-project--'

let failures = 0
let checks = 0

/**
 * Run one named check.
 * @param {string} title - what is being verified.
 * @param {() => Promise<void>} body - the check.
 * @returns {Promise<void>} resolves after recording the outcome.
 */
async function test(title, body) {
  checks++
  try {
    await body()
    console.log(`  ok   ${title}`)
  } catch (error) {
    failures++
    console.error(`  FAIL ${title}\n       ${error.message}`)
  }
}

/**
 * Build a synthetic Harness home with one Session on disk.
 * @returns {Promise<{root: string, sessions: string, storages: string, sessionDir: string, cacheFile: string}>} layout paths.
 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-delete-'))
  const sessions = join(root, 'sessions')
  const storages = join(root, 'storages')
  const sessionDir = join(sessions, PROJECT, SESSION)
  const cacheFile = join(storages, 'session_projcache', 'sessions', `${SESSION}.json`)

  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), 'not really zstd')
  await mkdir(join(storages, 'session_projcache', 'sessions'), { recursive: true })
  await writeFile(cacheFile, '{"version":7}')
  await writeFile(join(storages, 'workspace.json'), '{"unit":{"name":"workspace"}}')

  return { root, sessions, storages, sessionDir, cacheFile }
}

/**
 * Build an eraser over a fixture with recorded registry effects.
 * @param {object} layout - fixture paths.
 * @returns {object} the subject and its spies: `eraser`, `registry`, `broadcast`
 *   and `announced` (the ids the eraser told the Clients to drop).
 */
function eraserFor(layout) {
  const registry = { unarchived: [], unpinned: [] }
  const broadcast = []
  const announced = []
  const eraser = new SessionEraser({
    sessionsRoot: layout.sessions,
    storagesRoot: layout.storages,
    host: {
      agents: () => undefined,
      registry: () => ({
        unarchiveSession: async (id) => { registry.unarchived.push(id) },
        unpinSession: async (id) => { registry.unpinned.push(id) },
      }),
      broadcast: async (event, request) => { broadcast.push(`${event}:${request.sessionId}`) },
      announce: (id) => { announced.push(id) },
    },
  })
  return { eraser, registry, broadcast, announced }
}

/** @param {string} path - path to test. @returns {Promise<boolean>} whether it exists. */
async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

console.log('eraser')

await test('plan locates the Session directory and its cached projection', async () => {
  const layout = await fixture()
  try {
    const { eraser } = eraserFor(layout)
    const plan = await eraser.plan(SESSION)
    assert.equal(plan.exists, true)
    assert.deepEqual(plan.directories, [layout.sessionDir])
    assert.equal(plan.cachePath, layout.cacheFile)
    assert.equal(plan.live, false)
  } finally {
    await rm(layout.root, { recursive: true, force: true })
  }
})

await test('delete removes the log directory and the cached projection', async () => {
  const layout = await fixture()
  try {
    const { eraser } = eraserFor(layout)
    const outcome = await eraser.delete(SESSION)
    assert.equal(await exists(layout.sessionDir), false)
    assert.equal(await exists(layout.cacheFile), false)
    assert.equal(outcome.removedCache, true)
    assert.deepEqual(outcome.removedDirectories, [layout.sessionDir])
  } finally {
    await rm(layout.root, { recursive: true, force: true })
  }
})

await test('delete releases the archived and pinned registry entries', async () => {
  const layout = await fixture()
  try {
    const { eraser, registry } = eraserFor(layout)
    await eraser.delete(SESSION)
    assert.deepEqual(registry.unarchived, [SESSION])
    assert.deepEqual(registry.unpinned, [SESSION])
  } finally {
    await rm(layout.root, { recursive: true, force: true })
  }
})

await test('deleting an absent Session fails as not-found instead of succeeding quietly', async () => {
  const layout = await fixture()
  try {
    const { eraser } = eraserFor(layout)
    await assert.rejects(
      () => eraser.delete('session-99999999-0000-0000-0000-000000000000'),
      (error) => error.code === 'not-found',
    )
  } finally {
    await rm(layout.root, { recursive: true, force: true })
  }
})

await test('a non-Session id is rejected before touching the filesystem', async () => {
  const layout = await fixture()
  try {
    const { eraser } = eraserFor(layout)
    for (const bad of ['../../etc', 'session-', '', 'other-id', 'session-a/../..']) {
      await assert.rejects(() => eraser.delete(bad), (error) => error.code === 'invalid-id', `accepted ${JSON.stringify(bad)}`)
    }
  } finally {
    await rm(layout.root, { recursive: true, force: true })
  }
})

await test('a live Session is refused while stopActivity leaves it unstopped', async () => {
  const layout = await fixture()
  try {
    const registry = { unarchived: [], unpinned: [] }
    const eraser = new SessionEraser({
      sessionsRoot: layout.sessions,
      storagesRoot: layout.storages,
      blockActive: true,
      stopActivity: false,
      host: {
        agents: () => ({ get: (id) => (id === SESSION ? { id } : undefined) }),
        registry: () => ({
          unarchiveSession: async (id) => { registry.unarchived.push(id) },
          unpinSession: async (id) => { registry.unpinned.push(id) },
        }),
        broadcast: async () => { throw new Error('must not stop') },
        announce: () => { throw new Error('must not announce') },
      },
    })
    await assert.rejects(() => eraser.delete(SESSION), (error) => error.code === 'active')
    assert.equal(await exists(layout.sessionDir), true, 'refusal must not remove anything')
  } finally {
    await rm(layout.root, { recursive: true, force: true })
  }
})

await test('a live Session is stopped through the Harness hook before removal', async () => {
  const layout = await fixture()
  try {
    const registry = { unarchived: [], unpinned: [] }
    const broadcast = []
    const eraser = new SessionEraser({
      sessionsRoot: layout.sessions,
      storagesRoot: layout.storages,
      stopActivity: true,
      host: {
        agents: () => ({ get: (id) => (id === SESSION ? { id } : undefined) }),
        registry: () => ({
          unarchiveSession: async (id) => { registry.unarchived.push(id) },
          unpinSession: async (id) => { registry.unpinned.push(id) },
        }),
        broadcast: async (event, request) => { broadcast.push(`${event}:${request.sessionId}`) },
        announce: () => undefined,
      },
    })
    await eraser.delete(SESSION)
    assert.deepEqual(broadcast, [`workspace/session-stop:${SESSION}`])
    assert.equal(await exists(layout.sessionDir), false)
  } finally {
    await rm(layout.root, { recursive: true, force: true })
  }
})

await test('a failing registry cleanup still removes the Session', async () => {
  const layout = await fixture()
  try {
    const eraser = new SessionEraser({
      sessionsRoot: layout.sessions,
      storagesRoot: layout.storages,
      host: {
        agents: () => undefined,
        registry: () => ({
          unarchiveSession: async () => { throw new Error('registry offline') },
          unpinSession: async () => { throw new Error('registry offline') },
        }),
        broadcast: async () => undefined,
        announce: () => undefined,
      },
    })
    const outcome = await eraser.delete(SESSION)
    assert.equal(await exists(layout.sessionDir), false)
    assert.deepEqual(outcome.registry.map((entry) => entry.ok), [false, false])
  } finally {
    await rm(layout.root, { recursive: true, force: true })
  }
})

await test('a completed deletion tells every client to drop the Session', async () => {
  const layout = await fixture()
  try {
    const { eraser, announced } = eraserFor(layout)
    await eraser.delete(SESSION)
    // Without this the sidebar keeps a row for a Session that is already gone.
    assert.deepEqual(announced, [SESSION])
  } finally {
    await rm(layout.root, { recursive: true, force: true })
  }
})

await test('nothing is announced for a Session that was never removed', async () => {
  const layout = await fixture()
  try {
    const { eraser, announced } = eraserFor(layout)
    await assert.rejects(
      () => eraser.delete('session-99999999-0000-0000-0000-000000000000'),
      (error) => error.code === 'not-found',
    )
    assert.deepEqual(announced, [], 'an absent Session must not be announced as removed')
  } finally {
    await rm(layout.root, { recursive: true, force: true })
  }
})

await test('an unrelated project directory is left untouched', async () => {
  const layout = await fixture()
  try {
    const other = join(layout.sessions, '--C-other--', 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
    await mkdir(other, { recursive: true })
    await writeFile(join(other, 'session.v4.jsonl.zstd'), 'keep me')
    const { eraser } = eraserFor(layout)
    await eraser.delete(SESSION)
    assert.equal(await exists(other), true)
  } finally {
    await rm(layout.root, { recursive: true, force: true })
  }
})

console.log('command')

await test('an unconfirmed invocation is a dry run that removes nothing', async () => {
  const layout = await fixture()
  try {
    const { eraser } = eraserFor(layout)
    const result = await createCommand(eraser).handler({ rawInput: SESSION })
    assert.equal(result.kind, 'success')
    assert.match(result.text, /log directory/)
    assert.equal(await exists(layout.sessionDir), true, 'a dry run must not delete')
  } finally {
    await rm(layout.root, { recursive: true, force: true })
  }
})

await test('--confirm performs the deletion in any argument position', async () => {
  for (const rawInput of [`${SESSION} --confirm`, `--confirm ${SESSION}`]) {
    const layout = await fixture()
    try {
      const { eraser } = eraserFor(layout)
      const result = await createCommand(eraser).handler({ rawInput })
      assert.equal(result.kind, 'success', result.text)
      assert.match(result.text, /^Deleted /)
      assert.equal(await exists(layout.sessionDir), false)
    } finally {
      await rm(layout.root, { recursive: true, force: true })
    }
  }
})

await test('a missing id and an invalid id are reported, not thrown', async () => {
  const layout = await fixture()
  try {
    const { eraser } = eraserFor(layout)
    const command = createCommand(eraser)
    assert.equal((await command.handler({ rawInput: '' })).kind, 'error')
    assert.equal((await command.handler({ rawInput: '../../etc' })).kind, 'error')
    assert.equal(await exists(layout.sessionDir), true)
  } finally {
    await rm(layout.root, { recursive: true, force: true })
  }
})

await test('deleting an unknown Session is reported as an error result', async () => {
  const layout = await fixture()
  try {
    const { eraser } = eraserFor(layout)
    const result = await createCommand(eraser).handler({
      rawInput: 'session-99999999-0000-0000-0000-000000000000 --confirm',
    })
    assert.equal(result.kind, 'error')
    assert.match(result.text, /not found/i)
  } finally {
    await rm(layout.root, { recursive: true, force: true })
  }
})

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) process.exitCode = 1