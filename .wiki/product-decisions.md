# Product decisions

## AI task metadata

- Duration is total elapsed time. Values below 24 hours use five-minute
  increments with a five-minute minimum. Values from 24 hours onward use whole
  days only (`1d`, `2d`, ...). Duration may be unknown.
- Cognitive, emotional, and physical intensity are independent integer scales
  from 0 to 5. Zero means not applicable; unknown is distinct from zero.
- A task has at most one user-configurable scope. AI must select the best active
  scope when processing a task.
- User-edited estimate fields are individually user-owned and must not be
  overwritten by later AI runs. Clearing a field still locks ownership but does
  not turn the old value into a training label.
- Synced AI history belongs under the vault's hidden plugin folder. Credentials
  remain local and must never be written there.

## Task details editor

- Inbox, Kanban, and Tickler task cards open the full editor when the user clicks
  outside the title and embedded controls. A title double-click remains inline
  rename; controls and drag keep their own actions.
- The editor changes ordinary task fields and AI metadata through one atomic
  line update. Id-less tasks receive a stable ID before feedback is prepared.
- External-calendar tasks are read-only.
- An in-flight save cannot be dismissed by the modal chrome, Escape, or Cancel.

## Android widget navigation

- External widgets navigate through the plugin-owned `obsidian://gtd-flow`
  protocol action. Supported targets are unified Inbox and Calendar day mode on
  one validated ISO date.
- The URI must include the encoded vault name so Obsidian activates the intended
  vault before dispatching the plugin handler.
- Unknown targets fail closed and must not change the workspace.

## CalDAV external calendars

- CalDAV is read-only. The plugin never writes back to a CalDAV server; a
  collection is only ever imported into a local mirror file.
- CalDAV network access is desktop-only, enforced by a runtime gate, not by the
  manifest: `manifest.json` stays universal (`isDesktopOnly: false`) and Android
  still renders mirrors delivered by vault sync, it just never dials the server
  itself.
- CalDAV credentials live only in Obsidian SecretStorage, per device. `data.json`
  holds nothing but an opaque account id, a `secretRef`, and the https server
  origin — never a username, token, or collection href.
- A discovered collection's href is never persisted in `data.json`. It lives only
  inside the SecretStorage payload's `collections` cache or is re-obtained by
  running discovery again.
- Privacy mode is never pre-selected. A newly discovered collection starts in the
  `unconfigured` draft state, which blocks sync until the user makes an explicit
  `details`/`busy` choice.
- Tightening privacy (`details` → `busy`) is fail-closed through a durable
  `pendingRedaction` marker: the subscription stays fenced off from sync until the
  detailed mirror is actually trashed and the marker is durably cleared, surviving
  a crash or restart in between.
- CalDAV mirror `🆔` identity is namespaced by `accountId` + `collectionKey`, so
  swapping the underlying account/collection under the same subscription cannot
  collide with a previous mirror's ids. Legacy ICS `🆔` values are namespace-free
  and stay unchanged forever — that scheme is never retrofitted onto them.
- Corporate hostnames and credentials must never reach the public repository,
  including as UI preset values, fixtures, or examples — only placeholder
  addresses (e.g. `https://caldav.example.com`) are allowed anywhere in tracked
  files.

## Android plugin surface

- The release manifest is universal (`isDesktopOnly: false`), but Android registers
  only Inbox, Calendar, Recurring, and the shared task editor.
- AI/OpenRouter/OAuth, projects, boards, tickler, cards, onboarding, external calendar
  polling, promote mutation, graph/DnD, and pop-out remain desktop-only.
- Mobile-safe metadata services must not import Obsidian desktop APIs, Electron, or
  Node. Desktop AI is loaded dynamically after the runtime policy confirms desktop.
- Recurrence runs on Android and desktop. Deterministic parent IDs for legacy id-less
  templates, deterministic instance IDs, and conflict-safe writes are the cross-device
  idempotency boundary. Index changes that reveal synced duplicate instances schedule a
  coalesced convergence pass; reindexing an injected parent ID also schedules the deferred
  spawn pass. Users do not have to wait for restart/day rollover.
- Task-card provenance requests are microtask-batched so one mounted task list reads the
  synced feedback/outbox history once rather than once per card.
- Protocol navigation accepts only the unified Inbox or Calendar day with a strict
  ISO date; unknown parameters fail closed.
