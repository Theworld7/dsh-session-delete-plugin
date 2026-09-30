# Contracts this plugin depends on

Everything below was read from, or verified against, a live Harness install. The
plugin imports none of these packages; it names their public contracts only. This
file exists so an upgrade can be re-checked quickly.

Harness version this was developed and verified against: **0.2.0-rc.2**
(`@deepseek-ai/dsh-client-ui-workspace` reports `version: "0.2.0-rc.2"`).

## 1. Slot: `sidebar.workspaces.session.menu.item`

| | |
|---|---|
| Kind | `list`, scope `root` |
| Declared by | the `sidebar.workspaces` entry of `@deepseek-ai/dsh-client-ui-workspace` |
| `replaceRisk` | `none` |
| Registration | `{ id: string, order?: number, label?: string \| (() => string) }` |
| Owner props | `{ sessionId: SessionId, displayTitle: string }` |
| Injected hook | `useMenuOpenState` |
| Shipped occupants | `pin` 100, `rename` 200, `fork` 300, `archive` 400 |

This plugin registers `id: 'dsh-session-delete'`, `order: 500`.

The registration options also carry an `inject` face, and **that face is called,
not read**: `dsh-client-ui-renderer`'s `runInject` performs
`bindInjectSources(inject(...args))` and merges the result into the entry's props.
It must therefore be a function — `inject: () => ({ open, available })`. A plain
object throws `inject is not a function` on the row's first render, and the
per-entry error boundary then drops the row with no registration-level symptom.

### A row does not outlive its menu

`dsh-client-ui-workspace` says so in as many words, above its own rename action:

> *The dialog lives outside the row menu **because the row unmounts with the
> menu**; the browser raises the same request from a title double-click.*

So **nothing a row registers can back a menu action**. This plugin's first
version registered its confirmation dialog from the row's own effect, and the
click that closed the menu tore that registration down — a delete that produced
no dialog, no notice and no error. The dialog is contributed from `apply` instead
(§1b), and the row only raises a request on a signal both halves share.

The shipped actions do the same: `rename`, `archive` and the row notice are all
registered inside `ctx.slots.inject("shell.overlay", ...)` at plugin-apply time.

**Check after an upgrade:** query the Client `Slots` provider with
`root: "sidebar.workspaces.session.menu.item"` and confirm the slot exists with
the same owner props and `useMenuOpenState` hook — then confirm the row actually
draws in the menu, because registration alone does not prove rendering. Then
click it, and confirm a dialog appears: that is the half no Inspect query sees.

## 1b. Slot: `shell.overlay`

| | |
|---|---|
| Kind | `list`, scope `root` |
| Declared by | the `shell` entry of `@deepseek-ai/dsh-client-ui-layout` |
| Rendered by | `renderSlot("shell.overlay", {})` in that package's `AppFrame` |
| Ordering | shipped occupants register with no `order` (default 0), so this plugin's `500` draws last — i.e. on top |
| Shipped occupants | `workspace.session-rename`, `workspace.session-archive`, `workspace.row-toast` |

An overlay entry gets its props from its own `inject` face, exactly like the row,
and it may render `null` when it has nothing to show — that is how the shipped
rename dialog behaves while no rename is requested.

Because the entry is registered for the plugin's whole life, its transient state
cannot live in the entry's own `useState` either: the row that raises a
confirmation is gone before the answer arrives. This plugin keeps that state in
two plugin-owned signals that the entry subscribes to with React's
`useSyncExternalStore` — the same reader shape (`getSnapshot` + `subscribe`) the
renderer binds an entry's `hooks` face with, so a future version could move to
that face without changing the signals.

**Check after an upgrade:** confirm `shell.overlay` still exists and is still
rendered by the layout; if the layout renames it, the dialog has nowhere to draw
and the deletion becomes a no-op again.

## 2. Client Remote: `commands.execute`

```
@Remote async execute(
  agent: Agent,
  line: string,
  submittedAttachments: readonly CommandSubmitAttachment[],
  signal: AbortSignal,
): Promise<CommandExecution | undefined>
```

`Agent` is `{ readonly id: SessionId }`, and the wire encoding of that parameter
is a string id that the Host resolves through its `agent` lookup. Called as:

```js
ctx.remote.commands.execute(sessionId, '/delete-session <id> --confirm', [], signal)
```

### It does not resolve to the `CommandResult`

A Client Remote call resolves to a tagged envelope, not to the method's own
return value:

```ts
{ ok: true, value: T } | { ok: false, error: { code, message } }
```

so the executor's `{ commandId, result }` sits at `value`, and `value` is
`undefined` when the line names no command this profile has. The shipped caller
reads it that way (`dsh-client-ui-commands`):

```js
const result = await this.ctx.remote.commands.execute(session.id, line, attachments)
if (!result.ok) throw new Error(`command.execute failed: ${result.error.code}: ${result.error.message}`)
if (result.value === void 0) return { kind: 'error', text: `unknown or malformed command: ${line}` }
// the CommandResult is result.value.result
```

Reading `result` off the envelope yields `undefined` for ever, which is a
survivable-looking dead end: the command never runs, the plugin reports "no
result", and nothing anywhere says the shape was wrong.

**Check after an upgrade:** confirm the envelope is still `{ ok, value | error }`
and that the settled value still nests the `CommandResult` under `result`.

### It is a service of its own — inject the full key

`remote.commands` is the Cordis **service key** of the namespace, and the context
proxy answers a declared name while throwing for anything else:

```js
// cordis, ReflectService.handler.get
const error = new Error(`cannot get property "${prop}" without inject`)
```

So reaching it through the parent service fails at runtime:

```js
ctx.get('remote').commands   // ✗ TypeError: cannot get property "remote.commands" without inject
ctx.get('remote.commands')   // ✓ only when 'remote.commands' is in `inject`
```

This plugin therefore declares `inject: ['slots', 'remote', 'remote.commands', 'locale']`
and reads the key directly. Note that a *successful* `ctx.get('remote')` proves
nothing about the namespace beneath it, which is what made this failure
survivable through several rounds of "the row is registered, so it must be fine".

**Check after an upgrade:** the namespace service key is `remote.` + the Typert
namespace, so `commands` → `remote.commands`. Confirm the Client `Service`
provider still names the namespace `commands`, then extend `inject` if the plugin
ever calls a second namespace.

**Check after an upgrade:** `dsh-commands` still declares `@Remote execute`, and
`@deepseek-ai/dsh-api-remotes` still mounts the `commands` namespace on the
Client. If the wire encoding of `agent` ever became an object, `execute` would
reject and the dialog would report it.

## 3. Host Service: `ctx.commands`

- `register(definition: CommandDefinition): () => void`
- `CommandDefinition`: `{ name, description, input?, handler }`
- `CommandInvocation`: `{ commandId, agent, rawInput, attachments, signal }`
- `CommandResult`: `{ kind: 'success', text?, sourceEventSeq? } | { kind: 'error', text }`

This plugin registers one global command, `delete-session`.

The registry validates every definition and every result at run time
(`normalizeDefinition` / `normalizeResult` in `@deepseek-ai/dsh-commands`), and two
of its rules are load-bearing here:

- the command name must match `/^[a-z][a-z0-9_-]*$/` (`delete-session` does);
- an `{ kind: 'error' }` result must carry a **non-empty** `text`, or the handler
  throws a `TypeError` instead of reporting anything.

A thrown handler is not settled as an error result — the executor rethrows it, so
the Client sees a rejected Remote call rather than a `CommandResult`. This plugin
therefore catches inside the handler and returns error results with text, never
lets a throw escape.

## 4. Host Event: `workspace/session-stop`

| | |
|---|---|
| Mode | `parallel` |
| Signature | `(request: SessionActivityRequest): Promise<void> \| void` |
| `SessionActivityRequest` | `{ readonly sessionId: SessionId }` |

Dispatched with `ctx.parallel('workspace/session-stop', { sessionId })`. Each
provider stops its own family of work through the same cancel paths the user's
stop button uses.

## 4b. Host Event: `api-session/removed`

| | |
|---|---|
| Mode | `emit`, on `@deepseek-ai/dsh-api-remotes`' forwarded-event allowlist |
| Signature | `(sessionId: SessionId): void` |
| Emitted as | `ctx.emit('api-session/removed', sessionId)` |
| Consumed by | the Client Session list — `SessionManager.handleSessionRemoved` records a `remove` mutation |

The Harness emits this from `session/disposed`. **A filesystem deletion is not a
disposal**, so nothing else would announce it and every open page would keep a row
for a Session that no longer exists — the "deleted, but it is still there" report.
The plugin emits it itself, last, after the files are gone.

Host events are dispatched globally in Cordis (no scope filter is installed on the
Host side), so a plugin's `ctx.emit` reaches the forwarder's `ctx.on` listener.

**Check after an upgrade:** confirm the event is still on the forwarded allowlist
and still fed by `session/disposed`; a rename here costs the UI refresh only, not
the deletion.

## 5. Host Services: `agents`, `workspaceRegistry`

Both are looked up with `ctx.get` and treated as optional.

- `agents.get(id: SessionId): Agent | undefined` — used only to decide whether a
  session is live.
- `workspaceRegistry.unarchiveSession(sessionId): Promise<void>` — removes an id
  from the registry-global archive set. Runs no existence check.
- `workspaceRegistry.unpinSession(sessionId): Promise<void>` — removes an id from
  the registry-global pin set.

## 6. On-disk layout

```
<DSH_HOME>/sessions/<projectKey>/<sessionId>/session.v4.jsonl.zstd
<DSH_HOME>/storages/session_projcache/sessions/<sessionId>.json
<DSH_HOME>/storages/workspace.json
```

`<DSH_HOME>` defaults to `~/.dsh`. The plugin **walks** `<sessionsRoot>` project
directories looking for a directory named after the session id, rather than
recomputing the Harness's `projectKey(cwd)` encoding — so a change to that
encoding degrades to `not-found`, not to deleting the wrong directory.

The root is resolved in `resolveRoot` in this order: this plugin's own
`sessionsRoot` / `storagesRoot` config, then `process.env.DSH_HOME`, then
`~/.dsh`. The environment read is what lets the plugin respect a relocated
Harness home. A catalog scanner may report it as a *credentials* signal; it is a
directory-path lookup and carries no secret (README → Permissions). Removing it
would not make the plugin safer, only wrong on a non-default home.

The `session_projcache/sessions/<id>.json` cache is a pure cache: removing it is
safe, and leaving it behind is also harmless (the Harness reconciles it).

**Known tolerance:** the log filename carries a format version
(`session.v4.jsonl.zstd`). The plugin never reads the file — it removes the whole
session directory — so a future `session.v5.*` needs no change here.

## 7. Theme tokens used

Only tokens the Client `Theme` provider lists:

`--dsw-alias-bg-base`, `--dsw-alias-bg-layer-1`, `--dsw-alias-bg-layer-2`,
`--dsw-alias-border-l1`, `--dsw-alias-border-l2`, `--dsw-alias-label-primary`,
`--dsw-alias-label-secondary`, `--dsw-alias-state-error-primary`.

A renamed token degrades the appearance; it cannot break rendering.

## 8. Bundle manifest

- `dsh.bundle.patch` → `./cordis.patch.yml` selects the plugin.
- `dsh.client` → `{ platform: 'web', immediately: true, inject: [...] }` makes the
  Client bundle part of the module graph. `inject` only orders activation; it is
  not a module dependency, which is what lets this plugin import no Harness
  package while still loading after the sidebar it extends.
- The Client bundle is the module-loader factory form:
  `window.__ModuleLoader__.load({ id, factory(require) { ... } })`, with `id`
  equal to the package name.
- `dsh.compatibility` → `{ node, dshReleases }`. `dshReleases` maps each Harness
  release this build was actually exercised on to `compatible` / `incompatible`.
  Only exercised releases are listed; an unlisted release is unknown by design,
  not by omission. **Re-check this on every Harness upgrade**: a release that
  changes any contract in sections 1–5 must be moved to `incompatible` or dropped,
  never left behind as a stale claim. `engines.node` and `dsh.compatibility.node`
  carry the same floor (`>=20`) and must move together.
- `repository`, `license` and `files` are read by catalog automation, not by the
  Harness: the Store matches `repository.url` against the canonical GitHub
  repository, matches `license` against the repository's license metadata, and
  requires `files` to be explicit. `LICENSE` is listed in `files` so the
  distributed artifact carries the same license as the manifest.
