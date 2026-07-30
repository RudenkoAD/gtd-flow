# GTD Flow 0.13.0: unified inbox and AI Inbox MVP

This document is the release-note companion for the breaking GTD Flow release.
It describes the migration and the decided MVP boundary. It does not promise
mobile, background, or paid-model support.

## What changes

- Runtime **namespaces are removed**. GTD Flow now has one user-configured
  Markdown inbox and exactly one optional explicit `🧭 <scope-id>` per task.
  Views, capture, and discovery are global rather than namespace-routed.
- Tasks support provisional estimates: `⏱` total elapsed duration, plus `🧠`
  cognitive, `💓` emotional, and `💪` literal physical intensity. Each intensity
  is on the independent `0`–`5` scale; `0` means not applicable. Duration starts
  at `5m`, uses five-minute increments below `24h`, and accepts only whole days
  from `24h` upward (`1d`, `2d`, …); partial values such as `37h` are invalid.
- The embedded **GTD AI** desktop view adds a new conversation per processing
  run, command-triggered inbox estimation, follow-up questions, and general
  task chat with validated tools.
- User edits lock their individual estimate fields against later AI overwrite.
  The user must explicitly unlock and reprocess a field to make it AI-owned
  again. A stale question cannot revive a field that was subsequently manually
  locked.

This is a breaking API/data-model change for plugin users, MCP consumers, and
external widgets. `namespace` inputs and outputs are replaced by `scope`.

## Upgrade safely

1. Make an offline backup of the vault before enabling the new release. Include
   `.gtd-flow/` and the local plugin settings directory if you want to preserve
   non-secret preferences. OAuth credentials do not transfer because they are
   intentionally memory-only.
2. Upgrade the plugin on **Obsidian Desktop**. The manifest declares
   `isDesktopOnly: false`, so the plugin still installs on mobile, but the AI
   layer needs a loopback OAuth callback and stays desktop-only.
3. Set the single **Inbox file** and create at least one active scope.
4. For a legacy namespace vault, run **«Мигрировать пространства в scope…»**:
   select migration coverage and a treatment for former Common tasks, map every
   legacy namespace to an active scope, then inspect the dry-run.
5. Only after reviewing the plan, select **«Подтвердить и применить»**. The
   migration writes its journal to `.gtd-flow/ai/migrations/<migration-id>.json`.
   Any missing task IDs selected by the dry-run are inserted inside this
   journaled operation and are therefore included in rollback.
6. Use the AI only after enabling it and explicitly selecting **Connect**. The
   inbox processor itself runs only through its commands, including explicit
   retry for queued free-route work.

The one-time wizard alone reads legacy `gtd-namespace` metadata and old
namespace settings. Normal operation no longer interprets them. Do not add new
runtime namespace settings, selectors, or metadata after migration.

## Pause, recover, or roll back

- If migration is interrupted or conflicts with an external edit, keep the
  journal ID. Use **«Продолжить миграцию пространств…»** to retry idempotently;
  it will not guess through a changed file.
- To reverse a completed migration, use **«Откатить миграцию пространств…»** with
  the same journal ID. It restores captured files and the previous inbox
  setting only when the journal can do so safely.
- If rollback cannot proceed, restore the pre-upgrade vault backup. Downgrading
  the plugin alone does **not** recreate runtime namespace routing or undo task
  annotations.
- Keep the backup until the migration journal is complete and you have checked
  the unified inbox, scopes, and critical workflows on desktop.

## AI, privacy, and tool safety

- The MVP is **desktop only**. It uses OpenRouter OAuth with PKCE/S256 and a
  temporary desktop loopback callback.
- Requests target `openrouter/free`; there is no paid-model fallback. When free
  capacity is exhausted, a job waits for an explicit retry rather than silently
  switching models.
- Durable runs use `rate_limited` only for actual rate-limit responses such as
  HTTP 429. Other temporary provider failures use `retry_waiting`, so an outage
  is not misreported as exhausted free quota. Neither state retries without an
  explicit user action.
- Routing follows the user's OpenRouter account provider policy by default. The
  optional strict ZDR mode remains fail-closed.
- The token is kept only in process memory. It is not stored in Markdown,
  `.gtd-flow/`, `data.json`, logs, history exports, or synced vault state. A
  Desktop restart requires reconnecting.
- Chat reads are constrained to validated tools. Reversible individual task
  edits offer one-shot Undo. Task/file deletion, bulk changes, and irreversible
  board/project actions require an explicit preview and approval. The model
  cannot access `.gtd-flow/`, `.obsidian/`, a shell, or arbitrary files.

## Learning, locks, and stored data

AI writes provisional duration, intensities, and scope before optional follow-up
questions. Questions are persisted and shown only for fields still owned by AI
and unlocked after that provisional write. Manual corrections create field-level
locks. The learning history records suggestions, corrections, explicit unlocks,
and question linkage so later prompts can use local examples without treating a
user correction as an AI-owned value. Answering a question only persists bounded
context; it does not contact OpenRouter. The next explicit task-reprocess command
uses that context for the linked fields that remain AI-owned.

The vault synchronizes the scope catalog, immutable session/message records,
runs, recovery leases, feedback, feedback outbox records, and migration
journals beneath `.gtd-flow/`. Credentials and rebuildable local retry/index
state stay local. Obsidian Sync does not provide a global linearizable
compare-and-set: offline devices can still produce a conflict which is retained
and handled fail-closed rather than guessed through.

## Known MVP limits

- No mobile AI, mobile OAuth, or mobile plugin support.
- No automatic/background AI processing; processing and free-route retries are
  commands.
- No paid fallback if the free route is unavailable.
- OAuth reconnect is required after a Desktop restart; in-app remote OAuth-token
  revocation is not provided.
- Migration is a deliberate, journaled action—not an automatic upgrade step.
- The plugin cannot make cross-device sync writes globally serializable while
  devices are offline; inspect and resolve preserved conflicts.

## Final MVP product decisions

- AI chooses the best-fitting existing active scope and never creates a scope.
- Canonical fields are `⏱`, `🧠`, `💓`, `💪`, and `🧭`.
- Recurring instances inherit the template's current estimate and scope fields,
  without copying prediction provenance as a new confirmed label.
- OpenRouter routing follows account policy by default; strict ZDR is optional
  and fail-closed.
- `0m` is invalid. From `24h` upward, only exact 24-hour multiples such as
  `24h`, `48h`, and `72h` are accepted; `37h` is rejected rather than rounded.
- Memory-only OAuth credentials and reconnect after restart are accepted for the
  MVP.

D1 namespace coverage and D2 handling of former Common tasks remain explicit
per-migration choices in the wizard; neither has a hidden global default.
