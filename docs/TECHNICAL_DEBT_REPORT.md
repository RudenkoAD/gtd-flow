# GTD Flow Technical Debt and Expansion Readiness Audit

**Audit date:** 2026-07-28

**Repository baseline:** `0.12.0` at commit `261ab52` on `master`

**Scope:** core domain logic, writeback services, Obsidian/Svelte UI, calendar sync,
MCP server, widget core, tests, build, release automation, and project documentation

## Executive summary

GTD Flow has a stronger foundation than most projects of this size: strict TypeScript,
an explicit pure-core boundary, broad unit/property/service coverage, deterministic
file-oriented behavior, and a successful build. The current suite passes **2,033 tests in
75 files**.

The project is nevertheless **not ready to expand its mutating workflows safely
without a short reliability phase first**. Two confirmed defects can silently delete
or lose task data:

1. concurrent MCP calls all report success while last-writer-wins replacement drops
   earlier writes; and
2. `move-line` can delete a task when source and target are the same file, or when an
   unrelated target row has the same task ID.

The next tier of risk is concentrated in multi-step operations and untrusted input:
promotion can advance its checkpoint past failed work, malformed YAML can be replaced
destructively, pathological recurrence rules can monopolize the Obsidian thread, and
calendar sync can resurrect deleted mirror files. These are architectural seams rather
than isolated parsing mistakes.

### Recommended decision

Treat **TD-01 and TD-02 as release blockers for further write-capable expansion**.
Complete the Phase 0 and Phase 1 roadmap before adding more MCP mutations, cross-view
drag/drop flows, or synchronization sources. Feature work that does not broaden write
paths can continue in parallel if the new reliability tests are mandatory gates.

## Remediation follow-up — 2026-07-28

The audit above is intentionally preserved as the baseline at commit `261ab52`.
The current worktree now contains a reliability/remediation pass for every finding.
The two critical data-loss reproductions are fixed; the registry-backed static,
semantic, coverage, and mounted-browser gates are installed; and the unified
verification gate passes on both the local runtime and the exact minimum Node runtime.
Detailed dependency-advisory triage was authorized and completed; the remediated
lockfile now reports zero known npm advisories.

### Current closure matrix

| ID | Current status | Remediation outcome |
| --- | --- | --- |
| TD-01 | Mitigated / locally accepted | Per-physical-file coordination, optimistic snapshot verification/retry, postcondition checks, and real 100-call MCP concurrency tests prevent the reproduced lost-update failure. A non-cooperating external process can still write in the irreducible final snapshot-to-rename interval; no portable filesystem CAS can eliminate that interval. |
| TD-02 | Resolved | Canonical vault-relative paths, same-file/path-alias rejection, source fingerprints, and exact duplicate/retry rules prevent destructive moves. |
| TD-03 | Resolved | Promotions use stable IDs and a durable retry ledger; checkpoints advance only after terminal success. Conflicting persisted routes now fail closed without executing or pruning either record. |
| TD-04 | Mitigated / locally accepted | Response, line, parameter, component, VTIMEZONE, recurrence, output, wall-time, and per-feed concurrency budgets are enforced before or during processing. UTC-only fast-forwarding preserves TZID/DST correctness. `ical.js` remains synchronous, but parser-amplifying structures are bounded; uncommon unsafe VTIMEZONE forms fail closed. |
| TD-05 | Resolved | Frontmatter has explicit absent/valid/invalid states. Invalid, unterminated, whitespace-suffixed, and comment-suffixed opening delimiters are preserved byte-for-byte on rejected writes. |
| TD-06 | Resolved | Stable external IDs, generation fences, tombstones, orphan reconciliation, deletion rollback, and generation-draining sync prevent mirror resurrection and stale writes. |
| TD-07 | Resolved | Persisted settings use a shared Zod schema and migration path. An existing MCP `data.json` must validate and merge without recovery; invalid paths block tools before any default-folder write. Settings saves are snapshotted, serialized, and notify views only for the latest durable snapshot. |
| TD-08 | Resolved | Duplicate recurring-template IDs fail closed, and planned child IDs are deduplicated. |
| TD-09 | Resolved | The test-vault generator refuses existing directories by default; `--force` is limited to a vault carrying its generated marker. |
| TD-10 | Resolved | Exact `svelte-check` reports zero errors/warnings across source and browser harness files. The compiler gate covers all 21 project components. Mounted Playwright tests exercise real `VirtualList`, `DayCell`, and `DndService` paths: keyboard quick-add and rejected cross-view drops, ARIA status announcements, variable-height tail reachability, keyed state, and axe with no disabled rules. |
| TD-11 | Resolved | Virtualization is keyed and measured for variable-height rows, with an explicit threshold and a mounted tail/draft-preservation regression. Settings-aware query keys and latest-durable revision notifications keep mounted views coherent. |
| TD-12 | Resolved | A centralized async action boundary reports failures; graph, board, settings, quick-add, subscription, DnD, and cross-view workflows now roll back, restore drafts, retain retryable state, or surface a user-visible Notice instead of silently diverging. Sync/async rejected-drop regressions and a mounted ARIA-live failure test cover the final DnD boundary. |
| TD-13 | Resolved | `FsVault` uses a shared incremental metadata tree, bounded I/O, safe no-follow snapshots, SHA-256 revisions, mode-preserving exclusive replacement, and a 10,000-note regression. MCP and widget now share the same bounded container-frontmatter projection, delimiter semantics, namespace labels, and parity tests without bundling full YAML into QuickJS. |
| TD-14 | Resolved | CI/release actions are SHA-pinned and least-privileged; version/tag contracts accept normal `npm version` tags; release publication consumes a verified immutable checksum bundle. Dependabot and a scheduled high-severity audit workflow are present. The 12 reported advisories were triaged and removed through compatible exact upgrades/overrides; the final audit reports zero vulnerabilities. |
| TD-15 | Resolved | The purity gate now uses TypeScript AST/import-graph analysis over the documented layers and has fixtures for static, side-effect, and dynamic imports. |
| TD-16 | Resolved | Version sources, MCP server info, Node `>=20.19.0`, Node 20.19/22 CI lanes, artifact presence, and bundle budgets are defined and checked. Compilation uses exact Obsidian `1.7.2` and Node 20 typings; the complete unified gate passes under an isolated Node `20.19.0` runtime. |
| TD-17 | Resolved | Metadata keys are type-tagged; day-status writes are generation-guarded; path scope is segment-aware; graph counts scale through DAG bitsets; defaults are unaliased; and new board IDs use a readable slug plus a CSPRNG UUID with local reservation/revalidation as a retry guard. |
| TD-18 | Resolved | Release/verification docs, private-package intent, artifact contracts, bundle budgets, checksum instructions, and manual Kanban expectations are synchronized. ESLint, Prettier, semantic Svelte, V8 coverage thresholds, and mounted Playwright/axe tests are mandatory parts of the unified local/CI/release gate. |

### Current verification evidence

| Check | Current result |
| --- | --- |
| `npm run verify` | Passed on the local runtime: lint, format, compiler/semantic Svelte, coverage, browser/axe, builds, budgets, and release contract |
| Minimum Node runtime | The complete `npm run verify` gate passed under isolated Node `20.19.0` |
| Vitest and coverage | 88 files / 2,151 tests; Vitest 4 AST-aware coverage: 90.70% statements, 85.27% branches, 91.25% functions, 93.28% lines |
| Core purity | Passed with the AST/import-graph checker |
| Svelte gates | Compiler passed 21 components; `svelte-check` reported 0 errors and 0 warnings; only three dependency-owned `@xyflow/svelte` production-build warnings remain |
| Mounted browser/accessibility | 3 Playwright tests passed against real project components/services in Chrome for Testing 151, including a rejected cross-view drop; axe ran with no disabled rules |
| TypeScript and production builds | Passed |
| Dependency audit | `npm audit --json`: 0 vulnerabilities after exact security upgrades and transitive overrides |
| Bundle budgets | `main.js` 1,137,980 / 1,300,000; `mcp-server.js` 1,619,890 / 2,000,000; `widget-core.js` 113,506 / 150,000 bytes |
| Release contract | Passed for project version `0.12.0` and npm-style tag `v0.12.0` |
| Release checksums | All six release payload files passed `sha256sum --check SHA256SUMS` |
| Critical regressions | Include 100 concurrent real MCP writes, a 10,000-note incremental scan, 29 bounded ICS tests, and 71 board-service tests |

### Dependency advisory triage

The authorized initial audit identified 3 moderate and 9 high dependency findings:
the MCP SDK/Hono path, esbuild's development server, ESLint's minimatch chain, and
Vitest coverage's test-exclude/glob chain. None was critical.

The lockfile now uses exact compatible versions for
`@modelcontextprotocol/sdk@1.30.0`, `esbuild@0.28.1`, `eslint@10.8.0`,
`vitest@4.1.10`, and `@vitest/coverage-v8@4.1.10`, with exact safe overrides for
`@hono/node-server@2.0.12` and `fast-uri@3.1.4`. Peer/runtime compatibility, a clean
install, both full runtime gates, and the release bundle pass. The final
`npm audit --json` reports zero vulnerabilities.

Vitest 4's AST-aware V8 remapping produces different coverage percentages from
Vitest 3 for the unchanged 52-file `core`/`services`/MCP scope. Thresholds were
recalibrated to 89% statements, 83% branches, 89% functions, and 91% lines, preserving
approximately the prior two-point regression margin without exclusions or disabled
source-map remapping.

## Severity model

| Severity | Meaning in this report |
| --- | --- |
| Critical | Confirmed silent data loss/deletion through a supported operation |
| High | Credible data corruption, permanent missed work, UI freeze, or unsafe destructive tooling |
| Medium | Reliability, scaling, accessibility, validation, or release-integrity debt likely to impede expansion |
| Low | Maintainability, portability, documentation, or packaging debt with limited immediate user impact |

## Audit method and verification

The audit combined repository-wide architectural review, targeted source tracing,
existing test execution, production builds, and focused temporary reproductions.
Temporary reproduction files were outside the repository and were removed afterward.
Production source files were not changed.

| Check | Result |
| --- | --- |
| `npm ci` | Passed; npm reported 4 advisories: 3 moderate and 1 high |
| `npm test` | Passed: 75 files, 2,033 tests |
| `npm run build` | Passed; one project Svelte warning and three dependency warnings |
| TypeScript | Passed under the existing strict configuration |
| Core purity gate | Passed, but the checker itself has a false-negative defect described in TD-15 |
| MCP concurrency reproduction | 12 concurrent `add_task` calls returned success; only 1 task persisted |
| ICS stress sample | One-day-old `FREQ=SECONDLY` series took about 818 ms and emitted 15,001 rows |
| Repository state before report | Clean |

The npm advisory names and exploitability were not retrieved because doing so required
an external metadata request that was not permitted in this audit environment. The
count is therefore an actionable triage item, **not evidence that the shipped runtime
is presently exploitable**.

Local verification used Node `25.1.0`; CI uses Node `20.x`. Minimum supported runtime
compatibility remains a separate gap in TD-16.

## Prioritized risk register

| ID | Severity | Area | Finding |
| --- | --- | --- | --- |
| TD-01 | Critical | MCP/writeback | Concurrent MCP mutations silently lose successful writes |
| TD-02 | Critical | Writeback | `move-line` can delete the source task instead of moving it |
| TD-03 | High | Tickler/promotion | Failed promotions are checkpointed and may never retry |
| TD-04 | High | Calendar/ICS | Pathological feeds can freeze the plugin; one hung feed blocks all sync |
| TD-05 | High | MCP/frontmatter | Invalid existing YAML is destructively replaced during writes |
| TD-06 | High | Calendar sync | Deleted mirrors can be resurrected and path changes leave private orphan copies |
| TD-07 | High | Settings/config | Unvalidated persisted settings can crash startup or redirect MCP writes to defaults |
| TD-08 | High | Recurrence | Duplicate template IDs can generate duplicate child rows |
| TD-09 | High | Tooling | Test-vault generator can overwrite an existing real vault |
| TD-10 | Medium | Svelte/UI | Highest-risk UI behavior is outside semantic checking and runtime tests |
| TD-11 | Medium | Lists/settings | Virtualization is incorrect for variable-height rows; live settings remain stale |
| TD-12 | Medium | Async workflows | Fire-and-forget and multi-write actions can leave UI and disk state divergent |
| TD-13 | Medium | MCP/scaling | Every tool call rereads the entire vault; path and permission edge cases remain |
| TD-14 | Medium | Release | A tag can publish an untested, version-inconsistent, over-privileged release |
| TD-15 | Medium | Architecture gate | Core-purity checker can false-pass and does not enforce its documented scope |
| TD-16 | Medium | Compatibility | Declared/runtime versions and generated artifacts are not consistently verified |
| TD-17 | Medium | Core correctness | Several indexing, race, path-scope, and graph-scaling defects remain |
| TD-18 | Low | Project hygiene | Documentation, packaging, quality gates, and artifact contracts have drifted |

## Detailed findings

### TD-01 — Concurrent MCP mutations silently lose successful writes

**Severity:** Critical

**Confidence:** Confirmed by runtime reproduction

**Evidence**

- `src/mcp/tools.ts:45-55` creates a fresh vault/session per tool invocation.
- `src/mcp/session.ts:44-47` performs a new scan for each call.
- `src/mcp/fsVault.ts:106-120` performs read-transform-write without a mutation lock.
- `src/mcp/fsVault.ts:214-223` replaces the old file with a temporary file and rename.

Atomic rename prevents a torn replacement, but it does not make the preceding
read-modify-write sequence transactional. Two callers can read the same old content,
produce different replacements, and both return success even though the last rename
wins.

A focused reproduction sent 12 concurrent `add_task` requests to one inbox through the
real built MCP server. All 12 tool results reported success, while the final file
contained only one of the 12 tasks.

**Impact**

- Silent loss of agent-created tasks.
- The same race exists between MCP and Obsidian, not only between MCP requests.
- Adding more write tools increases the collision surface.

**Remediation**

1. Use one shared mutation coordinator and serialize mutations per canonical file path.
2. Add optimistic concurrency across processes: capture file stat/content hash, compare
   immediately before replacement, then retry or return a conflict.
3. Return a conflict/error instead of success when the intended postcondition is not
   present.
4. Add parallel MCP and MCP-versus-external-writer tests.

**Acceptance criteria**

- A stress test with at least 100 concurrent appends retains 100 unique tasks.
- Concurrent edits never return success unless their postcondition survives.
- Tests cover independent files, one shared file, and an external edit between read and
  commit.

### TD-02 — `move-line` can delete the source task instead of moving it

**Severity:** Critical

**Confidence:** Confirmed from reachable write path and focused reproduction

**Evidence**

- `src/services/WritebackService.ts:674-775` implements the move.
- At `:745-755`, the target append is skipped whenever the target already contains the
  moved ID.
- At `:758-775`, the source is then deleted unconditionally.
- The project picker has a same-file guard at
  `src/views/common/taskMenu.ts:444`, but archive dispatch at `:266-305` does not.
- `src/settings/SettingsTab.ts:531-540` accepts an arbitrary archive file path.
- Template promotion in `src/views/common/taskActions.ts:310-322` also has no equality
  guard.

There are two destructive cases:

1. If source and target are the same file, the target scan sees the task's own ID,
   treats the append as already completed, and then deletes that line.
2. If a different row in the target has the same ID, it is treated as a retry of the
   same move. The distinct source row is deleted.

Duplicate ID carriers are intentionally retained elsewhere so conflicts can fail
closed, making ID equality alone insufficient proof of idempotent completion.

**Remediation**

1. Reject or no-op `sourcePath === targetPath` before any write.
2. Treat an existing target row as an idempotent retry only when its captured
   content/fingerprint matches the source row.
3. Otherwise return a dedicated `duplicate-id-conflict` without altering either file.
4. Enforce the invariant in `WritebackService`, not separately in each UI caller.

**Acceptance criteria**

- Regression tests cover same-file moves, unrelated duplicate IDs, true retries, and
  stale source lines.
- No caller can bypass the service-level guard.
- Failed moves leave both files byte-for-byte unchanged.

### TD-03 — Failed promotions are checkpointed and may never retry

**Severity:** High

**Confidence:** Confirmed by control-flow tracing; deterministic failure exists with a supported setting

**Evidence**

- `src/services/PromoteService.ts:85-115` records `lastRun` after the batch even when
  individual plans fail.
- `src/core/tickler/promote.ts:115-118` excludes tasks at or before that checkpoint on
  future passes.
- `src/services/PromoteService.ts:133-178` clears start, strips board tags, and moves
  the task as separate writes.
- `src/services/PromoteService.test.ts:68-74` hardcodes `autoInjectId: true`.

With `autoInjectId: false`, an ID-less board task can fail deterministically:
clearing `🛫` leaves its content key usable, stripping the board tag changes that key,
and the subsequent `move-line` uses the stale key. The task is partially changed,
remains in the old file, may disappear from the relevant views, and the global
checkpoint advances past it.

**Remediation**

- Replace the global success checkpoint with durable per-task operation state or a
  retry ledger.
- Prefer a compound promotion intent with one stable task ID and explicit rollback or
  resume semantics.
- Advance the checkpoint only when all candidates are terminal: completed, safely
  skipped, or recorded for retry.

**Acceptance criteria**

- Injected failures at every step are retried on the next run.
- `autoInjectId: false` is covered.
- A partially completed promotion remains visible and recoverable.

### TD-04 — Pathological feeds can freeze the plugin, and one hung feed blocks all sync

**Severity:** High

**Confidence:** Confirmed by targeted benchmark and source tracing

**Evidence**

- `src/sync/icsParse.ts:31-38,276-305,319-409` caps emitted occurrences, not recurrence
  iterator steps.
- The current cap check permits 15,001 rows before stopping.
- `src/sync/SyncService.ts:184-203` parses after fetch on the plugin thread.
- `src/sync/SyncService.ts:143-155` processes subscriptions sequentially and uses a
  single `running` flag.
- `src/main.ts:267-270` uses `requestUrl` without a per-feed deadline or cancellation.

A secondly recurrence beginning only one day before the mirror window took roughly
818 ms locally. A recurrence beginning months or years earlier scales to millions of
synchronous iterator steps before it emits an in-window occurrence. Response bytes,
VEVENT count, total iterator steps, elapsed time, and global output are all unbounded.

Separately, a hung request prevents every later subscription from synchronizing, while
subsequent sync triggers return early because `running` remains true.

**Remediation**

- Enforce response-byte, VEVENT, iterator-step, elapsed-time, per-series-output, and
  global-output budgets.
- Fast-forward recurrence expansion near the requested window while preserving
  `EXDATE` and `RECURRENCE-ID` semantics.
- Move expensive parsing/expansion off the interactive thread if Obsidian permits it.
- Apply per-feed deadlines and cancellation; use bounded concurrency with
  `Promise.allSettled`.
- Share the active sync promise rather than silently ignoring duplicate triggers.

**Acceptance criteria**

- Adversarial secondly/minutely fixtures stop within a documented time and memory
  budget.
- One timed-out subscription does not prevent others from completing.
- Budget errors are visible and identify the affected subscription.

### TD-05 — Invalid existing YAML is destructively replaced during MCP writes

**Severity:** High

**Confidence:** Confirmed by data-flow tracing

**Evidence**

- `src/mcp/frontmatter.ts:23-36` represents invalid frontmatter similarly to absent
  frontmatter while dropping the original malformed block from the body.
- `src/mcp/frontmatter.ts:56-65` builds a new object and fresh block.
- `src/mcp/fsVault.ts:123-137` uses this path for normal MCP frontmatter mutations.

A temporary syntax error in otherwise valuable YAML can therefore cause an ordinary
MCP mutation to erase the original metadata block.

**Remediation**

- Model frontmatter as three states: absent, valid, and present-but-invalid.
- Read operations may choose a documented fail-open behavior; mutations must fail
  closed when present YAML cannot be parsed.
- Preserve the original bytes and return an error with file path and parse location.

**Acceptance criteria**

- A malformed-frontmatter write test leaves the file byte-identical.
- No write path treats invalid and absent metadata as the same state.

### TD-06 — Deleted mirrors can be resurrected and path changes leave orphan copies

**Severity:** High

**Confidence:** Confirmed by async lifecycle tracing

**Evidence**

- `src/sync/SyncService.ts:94-100,171-175,177-210` snapshots a subscription before the
  awaited fetch and checks only whether the whole service is disposed afterward.
- `src/settings/SettingsTab.ts:368-380` deletes a mirror and then removes the
  subscription.
- Namespace changes at `src/settings/SettingsTab.ts:345-356` save new settings without
  reconciling the old mirror path.
- `src/sync/mirrorBuilder.ts:111-118` does not store a stable subscription ID in
  generated frontmatter.

An in-flight fetch can finish after deletion and recreate the removed mirror. The
normal rename flow deletes the old path, but an in-flight fetch can still recreate the
old-name copy. Namespace or common-root changes can deterministically create a new
mirror while leaving the old private calendar content in place.

**Remediation**

- Give each subscription a stable ID and persist it in mirror frontmatter.
- Tombstone/cancel deleted subscriptions and revalidate current state after each await.
- Reconcile, migrate, or trash old paths whenever any path-forming setting changes.
- Make cleanup idempotent so interrupted migrations can resume safely.

**Acceptance criteria**

- Deleting during a delayed fetch cannot recreate the file.
- Renaming/moving a subscription leaves exactly one mirror.
- Startup reconciliation detects and reports orphaned managed mirrors.

### TD-07 — Persisted settings are unvalidated; MCP configuration fails open

**Severity:** High

**Confidence:** Confirmed with malformed-shape tracing

**Evidence**

- `src/settings/mergeSettings.ts:15-22` shallowly spreads and casts arbitrary persisted
  JSON.
- `src/core/namespace/namespace.ts:154` assumes `namespaces` is an array and calls
  `.some()`.
- Other consumers assume enum/object shapes, for example Settings UI calendar
  placement handling near `src/settings/SettingsTab.ts:190`.
- `src/mcp/config.ts:16-27` handles missing files, malformed JSON, and permission errors
  identically by using defaults.
- The shallow merge aliases compound values from `DEFAULT_SETTINGS`; Settings UI
  mutates arrays in place at `src/settings/SettingsTab.ts:134-141,282-313,376-379`.

Malformed persisted data can crash plugin startup. In MCP, a corrupt or unreadable
settings file can silently redirect writes to default `GTD/...` locations. In-place
mutation can also contaminate module-level defaults for the remainder of the process.

**Remediation**

- Parse settings with a versioned Zod schema, coercing only explicitly supported legacy
  forms and clamping numeric values.
- Build defaults through a factory/deep clone; freeze defaults in development.
- Default MCP configuration only for `ENOENT`. Fail write tools closed on malformed or
  unreadable configuration.
- Surface migration/validation diagnostics without logging private content.

**Acceptance criteria**

- Wrong-type, `null`, missing, legacy, and out-of-range fixtures load deterministically.
- Corrupt MCP settings cannot trigger writes to default folders.
- All mutable default collections have distinct references per load.

### TD-08 — Duplicate recurring template IDs can generate duplicate child rows

**Severity:** High

**Confidence:** Confirmed by planning/batch-write tracing

**Evidence**

- `src/services/RecurrenceService.ts:285-320` overwrites `templateById` entries while
  retaining both templates.
- `src/core/recurrence/spawnPlan.ts:98-205` can plan the same deterministic child ID
  twice because planned IDs are not added to `existingIds`.
- `src/services/RecurrenceService.ts:449-453` deduplicates only against IDs present
  before the batch.

Two carriers with one template ID can therefore append duplicate child rows in a
single run. Cursor advancement then fails on the ambiguous template, leaving a
persistent error state.

**Remediation**

- Group templates by ID before planning and fail closed for every duplicate carrier.
- Add planned child IDs to the current batch's deduplication set.
- Provide a diagnostic that lists all conflicting template paths.

**Acceptance criteria**

- Duplicate templates produce no child writes.
- One run cannot append the same deterministic child ID twice.

### TD-09 — Test-vault generator can overwrite an existing real vault

**Severity:** High

**Confidence:** Confirmed by script review

**Evidence**

- `scripts/gen-test-vault.mjs:27-35` accepts any destination path.
- `scripts/gen-test-vault.mjs:56-60` uses unconditional `writeFileSync`, truncating
  known GTD paths if they already exist.
- `README.md:180` and `docs/VERIFY.md:10-11` recommend the generator without a
  destructive warning.

A mistyped destination pointing at a real vault can overwrite inbox, board, project,
and generated bulk files.

**Remediation**

- Refuse existing or non-empty destinations by default.
- Use exclusive creation for files.
- Require an explicit `--force` and print the exact affected paths before overwriting.
- Prefer generating into a newly created directory whose marker proves ownership.

**Acceptance criteria**

- The default invocation cannot change any pre-existing file.
- Forced replacement requires an explicit flag and is covered by destructive-safety
  tests.

## Medium-priority expansion debt

### TD-10 — Highest-risk Svelte behavior is outside semantic checking and runtime tests

`tsconfig.json:19` includes TypeScript files but not the 21 `.svelte` components.
`vitest.config.ts:15-20` replaces every Svelte import with
`src/testing/svelteStub.ts`, and the project has no `svelte-check`, mounted component,
browser, or accessibility test gate.

The production build succeeds, but it reports a project warning around
`src/views/calendar/Calendar.svelte:250-254` about capturing `app`, plus three warnings
from `@xyflow/svelte`. The present suite cannot detect component lifecycle failures,
virtualized DOM behavior, keyboard interaction, or optimistic UI rollback.

Calendar creation, context menus, drag, and resize also rely on pointer/context-menu
handlers attached to non-focusable elements in:

- `src/views/calendar/DayCell.svelte:125-153,198-209`
- `src/views/calendar/TimeGridCol.svelte:159-232,282-294`
- `src/views/calendar/EventOccurrenceChip.svelte:110-132`
- `src/views/calendar/TimeGridBlock.svelte:157-166`

**Action:** add `svelte-check` to CI, fail on project warnings, and add a small
browser/component suite with accessibility checks. Prioritize calendar keyboard
operation, virtual lists, cross-view drag failure, settings changes, and modal wiring.

### TD-11 — Virtualization is incorrect for variable-height rows; open views retain stale settings

`src/views/common/VirtualList.svelte:4-47` assumes a fixed 44 px row, uses a hard-coded
threshold of 100, and renders an unkeyed `{#each}`. Task cards vary in height through
wrapped descriptions, badges, and progress (`src/views/common/TaskCard.svelte:223-326`).
At scale this can produce overlaps, gaps, inaccurate scrolling, unreachable rows, and
state transfer between recycled cards.

The public `virtualizeThreshold` setting in
`src/settings/Settings.ts:65,124` and `src/settings/SettingsTab.ts:563-572` is not wired
to the inbox list.

Settings are plain objects rather than a reactive source. Query memoization in
`src/stores/derived/queryStore.ts:44-64` excludes a settings revision, while inbox,
calendar, tickler, and recurring views capture settings during initialization. A user
can change a setting and keep observing old behavior until a leaf remount or restart.

**Action:** key rows by task identity; use measured variable-size virtualization or
enforce a true fixed-height card contract; wire the configured threshold; introduce a
reactive settings store/revision and include relevant values in derived-store keys.

### TD-12 — Fire-and-forget and multi-write actions can leave UI and disk state divergent

Examples include:

- graph moves are removed from pending state before persistence in
  `src/services/ProjectService.ts:514-560`;
- `src/views/project/ProjectGraph.svelte:182-194,277-310` ignores move failures and
  mutates auto-layout state without rollback;
- board promise chains in `src/views/kanban/Kanban.svelte:218-239` omit rejection
  handling;
- several calls in `src/main.ts` are intentionally fire-and-forget without a common
  error boundary;
- Tickler-to-Kanban drag clears the start marker and then moves the row as two writes in
  `src/views/kanban/Column.svelte:76-93`.

If the second write fails, a task can disappear from Tickler without reaching the
board. Disk failures can also leave graph coordinates visibly updated but not saved.

**Action:** introduce a centralized async action runner that catches exceptions,
surfaces a Notice/diagnostic, and resynchronizes state. Retain or requeue pending graph
moves on failure. Express cross-view operations as compound intents with rollback or
resume semantics.

### TD-13 — MCP performs a full-vault scan per call and retains filesystem edge cases

`src/mcp/tools.ts:45-55`, `src/mcp/session.ts:44-47`, and
`src/mcp/fsVault.ts:183-211` recursively list and sequentially read every Markdown file
for every read or write tool. Cost is `O(total vault bytes)` per call, and memory holds
file content plus parsed snapshots/tasks. This will dominate latency as the product
expands to large vaults or agent workflows make many calls.

Additional hardening gaps:

- `src/mcp/fsVault.ts:28-29,60-66` lowercases Darwin paths, which can misclassify a
  differently cased sibling on case-sensitive APFS.
- `src/mcp/fsVault.ts:214-223` does not preserve the original file mode during
  temporary-file replacement; a private `0600` note may inherit a broader default
  mode.
- `src/widget/widgetFrontmatter.ts:41-69` implements an ad-hoc YAML subset and can
  misread valid inline comments or escaping.
- namespace aliases resolve differently in MCP and widget code.

**Action:** add an incremental path/mtime index, lazy reads, bounded I/O, and
representative 10k+ note benchmarks. Retain the existing canonical-ancestor checks
while removing the platform-wide Darwin case-folding assumption; preserve original
modes; share one settings/frontmatter parser and namespace resolver.

### TD-14 — Release automation can publish an untested or inconsistent release

`.github/workflows/release.yml:6-9` runs for every tag. Its publish path at `:25-39`
builds and releases without:

- running `npm test`;
- validating semantic version format;
- checking agreement among tag, `package.json`, `manifest.json`, and `versions.json`;
- separating read-only build/install from the job holding `contents: write`.

CI and release actions use mutable major tags rather than pinned commit SHAs.
A clean install reported four dependency advisories, while no scheduled audit/SCA gate
exists. The advisory details require trusted-environment triage before choosing an
upgrade.

**Action:** validate every version source, run tests or consume an already-verified
immutable artifact, split privileged publication from dependency execution, narrow
permissions by job, pin action revisions, add scheduled dependency review, and add
artifact checksums/provenance as release maturity grows.

### TD-15 — The core-purity checker can false-pass

`scripts/check-core-purity.mjs:25` reuses a global regular expression. The early return
at `:35` can leave `lastIndex` set, causing the next file to skip a forbidden import.
A direct two-file reproduction detected `node:fs` in the first file and missed
`node:path` in the second. The regex approach also misses some side-effect/dynamic
imports.

`CHECKED` at `:17-21` omits services even though `docs/RELEASE.md:25` describes services
as checked. No current source violation was found, but the architectural gate is less
reliable than its passing status implies.

**Action:** replace regex scanning with TypeScript AST/import-graph inspection, define
the intended layer boundary in one place, and unit-test the checker with multiple
files, side-effect imports, dynamic imports, and false-positive fixtures.

### TD-16 — Runtime compatibility and generated versions are not consistently verified

- `src/mcp/server.ts:42` reports MCP version `0.1.0` while the project is `0.12.0`;
  `src/mcp/e2e.test.ts:107-113` checks only the name.
- `manifest.json` declares Obsidian `1.7.2`, while the caret dev dependency resolves
  newer typings, so CI does not compile against the actual minimum API surface.
- MCP is built for Node 18, Node 22 typings are used, CI runs only Node 20, and no
  `engines` field or minimum-runtime smoke test defines the contract.
- Current output sizes are approximately 756 KB for `main.js`, 1.57 MB for
  `mcp-server.js`, and 103 KB for `widget-core.js`, with no size budget.

**Action:** generate versions from one source, assert MCP server info, compile/test
against the minimum supported Obsidian and Node versions, declare the runtime contract,
and add coarse bundle budgets to detect accidental growth.

### TD-17 — Additional core correctness and scaling issues

These findings are narrower than the critical write paths but should be scheduled
before the affected subsystems are expanded:

| Issue | Evidence | Recommended fix |
| --- | --- | --- |
| Frontmatter index conflates YAML types (`"true"` matches `true`) | `src/adapters/MetadataAdapter.ts:193-200,264-281` | Type-tag index keys and coerce only explicitly supported fields |
| Day-status refreshes can commit out of order | `src/services/DayStatusService.ts:97-160` | Serialize or use a generation token; surface failed writes |
| Board ID allocation has a check-then-write race | `src/services/BoardService.ts:372-394` | Reserve/revalidate IDs immediately before commit and retry |
| Path-scope prefix semantics are ambiguous: `path:GTD` also matches `GTD2/...` | `src/core/board/membership.ts:41-53` | Require/normalize a trailing separator or explicitly document literal-prefix behavior |
| Project downstream counts are quadratic | `src/core/projects/graphEngine.ts:189-213`; `src/services/ProjectService.ts:204-218` | Use memoized/topological computation and add 1k/10k-node tests |
| Default collections are aliased and mutable | `src/settings/mergeSettings.ts:15-22`; Settings UI mutation sites | Defaults factory/deep clone; frozen development defaults |

### TD-18 — Documentation, packaging, and artifact contracts have drifted

Examples:

- `docs/RELEASE.md` still refers to `0.1.0`, says `LICENSE` is absent although it
  exists, and claims there are no network requests although calendar sync uses
  `requestUrl`.
- `docs/VERIFY.md` depends on an untracked `test-vault/`; the generator is both required
  and currently unsafe as described in TD-09.
- README screenshot links point to missing files under `docs/img/`.
- Manual installation documents three plugin files while MCP instructions assume a
  separate `mcp-server.js`; the status of `widget-core.js` as a release artifact is
  unclear.
- There is no lint, formatter, coverage threshold, unified `verify` script, or package
  publication allowlist. The package is not marked private.
- MCP E2E writes its bundle into the repository and can skip after a bundling failure
  rather than treating it as a failed precondition.

**Action:** make release docs version-neutral, regenerate verification facts, restore
or remove screenshot links, document each artifact and installation path, mark the npm
package private unless publication is intended, add a `verify` script and coverage
policy, and make E2E precondition failures explicit.

## Remediation roadmap

### Phase 0 — Stop silent loss before new write features

1. Serialize MCP mutations per canonical path and add compare-and-swap/retry.
2. Guard `move-line` at the service boundary and validate true idempotent retries.
3. Add deterministic concurrency and same-file/duplicate-ID regression tests.
4. Make the test-vault generator non-destructive by default.

**Exit condition:** no supported write operation can report success after losing or
deleting the intended task in the covered scenarios.

### Phase 1 — Make multi-step work resumable and untrusted input bounded

1. Convert promotion and Tickler-to-Kanban movement into resumable compound intents.
2. Fail closed on invalid frontmatter and invalid/unreadable MCP settings.
3. Add ICS byte/event/step/time/output budgets and per-feed timeouts.
4. Add stable external-calendar IDs, cancellation, tombstones, and mirror
   reconciliation.
5. Validate/migrate settings with Zod and eliminate aliased defaults.
6. Reject duplicate recurring-template carriers before planning.

**Exit condition:** every interrupted multi-step workflow either rolls back or is
rediscovered on the next run; untrusted input has explicit resource budgets.

### Phase 2 — Establish an actual UI/runtime quality gate

1. Add `svelte-check` and make project-authored warnings fail CI.
2. Add browser/component and accessibility tests for the highest-risk interactions.
3. Replace fixed-height unkeyed virtualization.
4. Introduce reactive settings and settings-aware query invalidation.
5. Centralize async action error handling, rollback, and user feedback.

**Exit condition:** the CI gate exercises Svelte runtime behavior and failure paths, not
only service logic behind component stubs.

### Phase 3 — Scale and harden delivery

1. Replace MCP full scans with an incremental index and benchmark representative vaults.
2. Repair the core-purity checker with AST/import-graph analysis.
3. Add version, compatibility, test, permission, and immutable-artifact release gates.
4. Triage dependency advisories in a trusted environment and adopt scheduled scanning.
5. Clean documentation, artifact distribution, packaging, and bundle budgets.

**Exit condition:** a release is reproducible, version-consistent, tested at minimum
supported runtimes, and accompanied by an explicit artifact contract.

## Suggested test additions

The current suite is broad; the next tests should target interactions between units:

1. parallel writes to one file, parallel writes to separate files, and an external
   modification between read and commit;
2. same-file move, unrelated duplicate target ID, true retry, and stale source;
3. promotion failure injection after every sub-step with `autoInjectId` both on and off;
4. invalid YAML/config preservation and settings schema migration fuzz cases;
5. bounded secondly/minutely ICS fixtures, oversized response, excess VEVENTs, timeout,
   and one failed feed among healthy feeds;
6. deletion or rename during an in-flight calendar fetch;
7. duplicate recurring template carriers in one and multiple files;
8. mounted virtual-list scrolling with variable-height cards and stable edit state;
9. live settings changes without remount;
10. disk/write rejection during graph layout, board movement, and cross-view drag;
11. keyboard-only calendar creation, menu, move, and resize flows;
12. minimum supported Obsidian and Node smoke tests plus release-version contract tests.

## Existing strengths worth preserving

- Strict TypeScript with `noUncheckedIndexedAccess`.
- Clear separation among core, adapters, services, views, MCP, and widget code.
- An explicit portability/purity goal for the core and widget layers.
- 2,033 passing tests, including property tests, service tests, MCP E2E coverage, and a
  10k-task performance smoke.
- Writeback commonly uses exact-line/stale-index checks and copy-before-delete ordering.
- Task indexing preserves duplicate carriers so ambiguity can be handled explicitly.
- Strong path traversal and symlink tests.
- External calendar mirrors are read-only through plugin and MCP task mutations.
- Deterministic mirror generation and unchanged-content write avoidance.
- Careful store subscription, day-rollover, and drag/drop cleanup.
- No dynamic `innerHTML` usage was found.
- Lockfile dependency URLs use HTTPS registry entries with integrity hashes; production
  source maps and generated bundles are ignored.

These are good foundations. The recommended work is primarily about making boundaries
transactional, cancellable, resource-bounded, and observable rather than replacing the
project's architecture.

## Audit limitations

- No live Obsidian UI or browser automation was run, so UI findings are based on source
  behavior plus the absence of runtime component gates.
- No representative private vault was inspected.
- No case-sensitive macOS volume, Windows environment, or Node 18 runtime was available.
- Detailed dependency advisory data was not retrieved.
- Performance samples are directional, not a complete benchmark suite.

Re-run this audit after Phase 1, with particular attention to failure injection and
concurrent mutation semantics.
