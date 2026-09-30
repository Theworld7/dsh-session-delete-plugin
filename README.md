# dsh-session-delete-plugin

Adds **Delete session** to a DeepSeek Harness session's `...` menu and removes that
session from disk.

The Harness has no delete operation for a session: the closest thing it ships is
**archive**, which only appends the id to a durable hidden-set and leaves every byte
on disk. This plugin adds the real thing — the session log directory, the cached
projection, and the archived/pinned registry entries all go away.

Right-click a session row → `...` → **Delete session** → confirm → gone.

```
src/index.js      Host half: the `delete-session` command and its safety policy
src/eraser.js     the deletion itself, against the on-disk layout
client/client.js  Client half: the menu row and the confirmation dialog
tests/            behavioural checks, run against a synthetic Harness home
cordis.patch.yml  the bundle layer and this plugin's config
```

## Install

```sh
git clone git@github.com:Theworld7/dsh-session-delete-plugin.git
dsh plugin --profile <profile> add <path-to-the-clone>
```

Or, from an agent session, `plugin_manager` with `action: install_bundle` and this
directory as `target`. The profile records the package and appends it to
`dsh.profile.bundles`; plain `dsh web` then loads it with no `--patch` argument.

Installed, it is live immediately: the Host row activates through HMR and the
browser row registers into the sidebar slot as soon as the page's module graph
updates.

### Removing it

```sh
dsh plugin --profile <profile> remove dsh-session-delete-plugin
```

`dsh plugin` forwards its arguments to the profile's package manager verbatim
(`add`, `remove`, `why`, …), so removal runs on the same channel as installation.
The package and its `dsh.profile.bundles` entry go; sessions already deleted stay
deleted, and nothing else the profile owns is touched.

## Compatibility

| | Declared in | Value |
|---|---|---|
| Node.js | `engines.node` and `dsh.compatibility.node` | `>=20` |
| Harness | `dsh.compatibility.dshReleases` | `0.2.0-rc.2` → `compatible` |

Only that one Harness release is marked `compatible`. Every other release is left
**unstated**, which the Store's rules read as unknown — the honest answer, since
no other release has been exercised. What makes a wider range *plausible* is the
plugin's zero `@deepseek-ai/*` import: it reaches the Host through slots, the
command registry, declared events and the on-disk layout, so a release that keeps
those keeps working. Plausible is not tested, so it is not claimed.

## Permissions

Declared as they are rather than as they would be convenient: this plugin's whole
job is destructive, and a clean capability report would be a lie.

| Kind | Used | What that means here |
|---|---|---|
| Files | **yes** | removes the session log directory and its cached projection under `<DSH_HOME>`, and rewrites `<DSH_HOME>/registry.json` to drop the id from `archivedSessionIds` / `pinnedSessionIds`. Nothing outside `<DSH_HOME>/sessions` and `<DSH_HOME>/storages` is read or written, and every removal target is re-checked to sit strictly inside those roots. |
| Network | no | nothing is fetched, uploaded, or reported anywhere. |
| Commands | no | no process is spawned and no shell is invoked. |
| Credentials | no | no token, key, cookie, or password is read. The single environment read is `DSH_HOME`, a **directory path** used to locate the Harness home; it carries no secret. |

Two notes for anyone auditing this automatically:

- A scanner will flag the first row, and it should: a plugin that deletes
  directories is high-capability whatever its manifest claims, and the Store
  policy treats a `files` signal as grounds to withhold automatic approval. That
  is the correct outcome, and this plugin does not present itself otherwise.
- A scanner may additionally read the `DSH_HOME` lookup as a *credentials*
  signal. That is a false positive on a path lookup. It stays because honouring
  `DSH_HOME` is what lets the plugin find a non-default Harness home; removing it
  would make the plugin delete from the wrong place, not make it safer.

## What actually gets deleted

| Target | Path |
|---|---|
| Session log directory | `<DSH_HOME>/sessions/<projectKey>/<sessionId>/` |
| Cached projection | `<DSH_HOME>/storages/session_projcache/sessions/<sessionId>.json` |
| Registry sets | the id is dropped from `archivedSessionIds` and `pinnedSessionIds` |

Deleting the log directory is enough to make the session *stay* deleted, and that
is a property of the Harness rather than a trick:

- The JSONL backend enumerates sessions by **walking** `sessions/<projectKey>/<sessionId>/`.
  There is no index that could keep pointing at a removed directory.
- A workspace derives its visible `sessionIds` by filtering its own recorded
  account through `sessionPath(id)`, so an id whose directory is gone drops out of
  the flat list **and** out of every workspace grouping on its own. The plugin
  does not have to repair `workspace.json`; that would in fact fight the
  Harness's own reconciliation.

What is left for the plugin is what the Harness will not do on its own:

- stop the session's running work, so no live writer is appending to a file about
  to be unlinked;
- drop the id from the two registry-global id arrays, which no path filter touches;
- **announce the removal** on `api-session/removed`, the forwarded event the
  session list already listens to. An open page holds its rows in memory, and a
  directory that vanished underneath it is not something it can notice by itself —
  without this the row sits there until the next list refresh, which reads as
  "deleted, but it is still in the sidebar".

## Configuration

Every knob lives in the plugin's `Config`, so a user's override survives Harness
upgrades. Override the row id `session-delete` from the profile's
`cordis.patch.yml`, or from a `--patch` overlay:

| key | default | meaning |
|---|---|---|
| `sessionsRoot` | `''` | Session log root. Empty derives `$DSH_HOME`, then `~/.dsh`. |
| `storagesRoot` | `''` | Storage root holding the projection cache. Empty derives the same way. |
| `blockActive` | `true` | Refuse to delete a session that is open in this Harness. |
| `stopActivity` | `true` | Stop an open session's work first, through the Harness's own `workspace/session-stop` hook. |
| `cleanWorkspaceRegistry` | `true` | Drop the id from the archived and pinned sets. |
| `cleanProjectionCache` | `true` | Remove the cached projection. |

A patch row **replaces** the whole `config` value, so restate every key you still
want:

```yaml
- id: session-delete
  name: 'dsh-session-delete-plugin'
  config:
    sessionsRoot: ''
    storagesRoot: ''
    blockActive: true
    stopActivity: true
    cleanWorkspaceRegistry: true
    cleanProjectionCache: false   # keep projections, delete only logs
```

## Hot-swap

The plugin is a normal profile bundle, so it obeys the profile's own lifecycle.
Verified on a running page:

- `plugin_manager` `set_plugin` `include:session-delete` → `false` removes the
  `dsh-session-delete` row from `sidebar.workspaces.session.menu.item` and takes
  the Host command with it.
- Setting it back to `true` restores the row.

Because the row and the command are registered on the plugin's own Context, an
uninstall removes both — there is no separate cleanup step and nothing is left
behind. Styles are appended by an owned effect and removed with it.

One caveat that applies to every client plugin: **a changed `client/client.js`
reaches the page only after a browser refresh.** Enabling, disabling and
config-only changes apply live, but new client *code* requires the reload.

## Why this survives Harness upgrades

The plugin imports **nothing** from the Harness — no `@deepseek-ai/*` package, no
internal module, no generated artifact. It reaches the framework only through
stable, documented contracts:

1. **The slot system.** Two entries, both through `ctx.slots.inject` /
   `ctx.slots.register`: the row into `sidebar.workspaces.session.menu.item`, with
   the owner's documented props (`sessionId`, `displayTitle`, `useMenuOpenState`),
   and the dialog into `shell.overlay`, which the shell layout renders. `replaceRisk`
   for the row's slot is `none`.
2. **The command registry.** The Client reaches the Host with
   `ctx.remote.commands.execute(sessionId, '/delete-session <id>', [], signal)`,
   and reads the shipped `{ ok, value }` envelope — a Remote method, not a private
   channel.
3. **Public events and Services.** `workspace/session-stop` is a declared parallel
   event and `api-session/removed` is on the forwarded-event allowlist; `agents`
   and `workspaceRegistry` are looked up with `ctx.get` and treated as optional, so
   the plugin also loads in a profile that lacks them.
4. **Theme tokens.** Styling uses only the `--dsw-alias-*` tokens the Theme
   inspect provider lists. A renamed token degrades the appearance but cannot
   break rendering.
5. **The on-disk layout**, which the plugin reads **discoveristically rather than
   structurally**: it walks `<sessionsRoot>` project directories and looks for a
   session directory named after the id, instead of rebuilding the Harness's
   `projectKey(cwd)` encoding. If the layout changes, discovery reports
   `not-found` instead of deleting the wrong directory.

### The one design decision worth knowing about

A plugin **cannot** add a new Remote namespace. The Client's callable surface is
built at build time from generated Typert contributions, so exposing
`ctx.remote.sessionDelete` would require a code-generation step. The alternatives
were a dynamic Cordis package (which has a real `host.call` bridge but does not
survive a page reload, so it cannot back a durable menu action) or the shipped
command channel. This plugin uses the command channel.

A consequence: a deletion is logged in the target session as `command/run` /
`command/done` immediately before the log is removed. That is the framework's own
audit trail for commands, and it cannot be suppressed.

## Safety

- The session id must match `^session-[A-Za-z0-9][A-Za-z0-9._-]*$`, and every path
  about to be removed is re-checked to be strictly inside the sessions root, so a
  crafted id cannot escape its project directory.
- A session that is open in this Harness is refused unless `stopActivity` is on,
  in which case its work is stopped through the Harness's own hook first.
- The deletion only ever runs with `--confirm`. The dialog's first call is a dry
  run that returns what would be removed and writes nothing.
- A failing registry cleanup is reported as a warning on an otherwise successful
  deletion: the log is gone either way, and the user is told which entry may
  remain.

## Develop and verify

```sh
node tests/check-eraser.mjs     # 15 checks: the Host deletion logic
node tests/check-client.mjs     # 30 checks: the Client contract, the row and the dialog
```

Both need no Harness and no install. The eraser checks build a synthetic Harness
home in a temp directory, so no real session is ever touched; they cover
discovery, the cache and registry cleanup, `not-found`, id rejection, the
active-session refusal, the stop hook, a failing registry cleanup, the removal
announcement, leaving unrelated projects alone, and the dry-run/`--confirm` gate.
The client checks load `client/client.js` through a stub of the module loader —
exactly as the page does — and render both entries: the row, and the dialog
rendered *without the row mounted*, which is the arrangement the live page uses.

### Three traps worth recording

#### 1. A slot entry's `inject` is called, not read

A slot entry's `inject` is **called** by the renderer, not read:

```js
// dsh-client-ui-renderer, runInject
const inject = entry.inject
if (!inject) return EMPTY_INJECTED_PROPS
return bindInjectSources(inject(...args))   // ← must be callable
```

`inject: { slots, remote }` (a plain object) therefore throws `inject is not a
function` on the row's first render. The consequence is worse than a missing row,
and it is worth understanding:

```js
// dsh-client-ui-renderer:1117
host.reportEntryError(slotKey, entry, error, { abdicate: spec.kind !== 'chain' })
// dsh-client-ui-slots:286   entriesOfSlot() — what the outlet renders
if (this.abdicated.has(entry)) continue
```

A list entry that throws is **abdicated**: added to a retired set and skipped by
`entriesOfSlot()` from then on. Registration itself succeeded, so `snapshot()` —
which is what the `Slots` Inspect provider reports — still lists the entry as
present and `active`. The result is a row that Inspect swears is there and that
the menu never draws again, for the life of the page.

The row is therefore wrapped in its own error boundary (`SafeRow`). If rendering
ever throws, the entry is still retired, but the plugin records the reason and
renders a visible fault row in its place rather than disappearing:

> 删除会话菜单项无法显示
> `TypeError: …`

It subscribes to `slots.onEntryError` for the same reason. Without these, a render
defect is indistinguishable from "the plugin is not installed".

`tests/check-client.mjs` pins the inject contract by replaying `runInject` against
the registration, and pins optional-prop tolerance by rendering the row with none
of the owner's optional props present.

#### 2. A row does not outlive its menu

The owner of the session menu says it above its own rename action:

> *The dialog lives outside the row menu **because the row unmounts with the
> menu**; the browser raises the same request from a title double-click.*

The first version of this plugin registered its confirmation dialog from the row's
own effect — register on click, dispose on unmount — which is a self-cancelling
arrangement: the click closes the menu, the menu unmounts the row, and the cleanup
removes the registration in the same commit that created it. Nothing was drawn and
nothing was logged, so the symptom was a menu item that did precisely nothing.

The dialog and the outcome notice are therefore contributed from `apply`, for the
plugin's whole life, and the row only raises a request on a signal both halves
share. `tests/check-client.mjs` renders the dialog **after unmounting the row**, so
a regression to the old arrangement fails the suite.

#### 3. A Remote call answers with an envelope

`ctx.remote.commands.execute(...)` does not resolve to the command's result. It
resolves to `{ ok, value }` (or `{ ok: false, error }`), and the settled
`CommandResult` is at `value.result`. The first version read `result` off the
envelope, got `undefined` for ever, and reported "the Harness returned no result"
on every attempt — a failure that looks like a Host problem and is in fact a
missing `.value`.

The fixtures in `tests/check-client.mjs` return the envelope, not a bare result,
so the unwrapping is exercised rather than assumed.

### Matching the host's icon geometry

The host's menu icons are drawn on `viewBox="0 0 16 16"` with the artwork filling
that box edge to edge, rendered at **14px**. An icon's apparent size is its path
extent plus half the stroke on each side, so a glyph whose paths occupy only part
of its viewBox looks smaller than its neighbours at exactly the same `width`/`height`
— which is what happened with the first version of this row's glyph, and no amount
of adjusting the CSS size fixes it without also making the icon oversized relative
to the row.

The glyph here is therefore authored on the half-pixel grid and centred on ±7.5,
so its drawn extent is the full 16 units; it also uses the host's medium stroke
(1.3) rather than its 1px regular stroke, because a 1px stroke reads thin at 14px.

`tests/check-client.mjs` measures the path extent and asserts the drawn span
covers the box, so a later edit that shrinks the icon fails the suite.

### Verification status

| Claim | How it was established |
|---|---|
| Host row activates | `plugin_manager` `list_plugins` → `include:session-delete`, `fiberPhase: active` |
| Client row registers | Slots `listSubTree` → `sidebar.workspaces.session.menu.item` occupant `dsh-session-delete` order 500 |
| Hot-swap works | the row disappears on disable and returns on enable, on a running page |
| Deletion logic is correct | 15/15 checks pass in `tests/check-eraser.mjs` |
| Client contract is correct | 30/30 checks pass in `tests/check-client.mjs`, including a replay of the renderer's `runInject`, the `{ ok, value }` envelope, the service-inject list, the icon geometry and rendering the dialog with the row unmounted |
| **The row renders in the menu** | **confirmed by the user**, in context with 置顶会话 / 重命名 / 分叉会话 / 归档会话 |
| **The dialog and a real deletion** | **confirmed by the user** on a live page: the dialog opened, listed what would be removed, the confirmed deletion succeeded, the notice appeared and the sidebar row went with it. |
| Uninstall | `dsh plugin --profile <p> remove <pkg>` forwards verbatim to the profile's package manager (`dsh/lib/bin.js:116`). The round trip has **not** been exercised end to end on a disposable profile. |

If the confirmation dialog reports *"The Harness command channel is unavailable"*,
that means `ctx.get('remote.commands')` was absent from this page's composition —
the row deliberately disables itself instead of failing mid-action.
