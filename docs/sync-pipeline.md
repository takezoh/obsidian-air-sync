# Sync Pipeline

## Pipeline overview

Each sync cycle runs a 4-phase pipeline:

1. **Collect** -- `collectChanges()` gathers `MixedEntity[]` using the appropriate temperature mode
2. **Decide** -- `planSync()` maps each `MixedEntity` to a `SyncAction`
3. **Execute** -- `executePlan()` runs I/O in lane/tier phases (transfers → conflicts → structural; see [Execution phases](#execution-phases-lanetier-scheduling))
4. **Commit** -- `commitAction()` persists each successful action's `SyncRecord` to IndexedDB

The orchestrator (`SyncOrchestrator.executeSyncOnce()`) drives this pipeline, applying scope filtering and mobile size limits between Collect and Decide.

**Scope filter (`SyncOrchestrator.isExcluded()`)** — a path is synced only if it passes **both** gates:

1. **Dot-path scope** (`isDotPathOutOfScope`): a dot-prefixed/hidden path (`.airsync`, `.obsidian`, `.git`, …) is in scope only when it sits under a configured `syncDotPaths` root — `settings.syncDotPaths` augmented with the vault's config directory when `enableConfigSync` is on (`getEffectiveSyncDotPaths`, `config-sync.ts`). Normal paths always pass. This is applied symmetrically to local and remote entries, so an out-of-scope hidden path on the remote (e.g. another device's `.airsync/logs/`) is never pulled, and never produces a `delete_remote` (the gate runs before `planSync`).
2. **Ignore patterns** (`isIgnored`): gitignore-style `ignorePatterns` — likewise augmented with a built-in pattern set (`getEffectiveIgnorePatterns`) prepended when `enableConfigSync` is on, letting through hotkeys/plugin settings under the config directory while excluding device-specific layout.

`isExcluded()` also reserves two paths unconditionally, ahead of both gates, so neither `syncDotPaths` nor `ignorePatterns` can ever pull them back into scope:
- The backend's own metadata path (`INTERNAL_METADATA_PATH` = `.airsync/metadata.json`, `sync/remote-vault.ts`): never synced from either side, even when `.airsync` is opted into `syncDotPaths`. The remote FS hides it too; excluding it here keeps the exclusion symmetric (otherwise a local copy would be pushed, then deleted as a phantom remote deletion).
- This plugin's own settings file under the config directory (`isOwnPluginDataPath`, `config-sync.ts`): checked regardless of `enableConfigSync`, since a user can opt the config directory into `syncDotPaths` by hand without the toggle. Syncing it would let one device's backend credentials/vaultId overwrite another's — a soft `ignorePatterns` entry alone can't guarantee this (gitignore's last-match-wins semantics would let a user's own pattern override it), so it's enforced as a reserved path instead.

The same `isExcluded()` gates the vault-event dirty tracking (scheduler), so push and pull use one scope rule across hot and cold paths.

`runSync()` is gated on a connected remote (`remoteFs` present), layout-ready, and not-connecting; it serializes via an `AsyncMutex`. A call arriving while a sync runs sets `syncPending` and returns; the lock holder re-runs in a `do/while (syncPending)` loop, acknowledging each cycle's start-of-cycle snapshot at the end of each non-fatal cycle (coalescing). Each cycle (`executeSyncOnce`) is wrapped by `executeWithRetry`, which retries up to `MAX_RETRIES = 3` with exponential backoff plus jitter (`2^(attempt-1) * 1000 * (0.5 + Math.random())` ms), honoring `Retry-After` (×1000) on 429/403. `AuthError`, a non-rate-limit 403, and 404 abort without retry; a fatal abort returns early and leaves the dirty set un-acknowledged so it is retried next run.

## Crash recovery

The remote delta cursor (Google Drive's `changesStartPageToken`) is the engine's "synced up to here" checkpoint. It lives in the backend's IndexedDB store (`META_STORE`), **co-located with the file-map cache and committed in the same transaction** (see [ADR 0001](adr/0001-metadata-cache-is-subordinate-to-commit-last.md)). The orchestrator calls `provider.commitCheckpoint(fs)` **only after a fully-successful cycle** (`result.failed.length === 0`); a partial or interrupted cycle never calls it, so the cursor and cache both stay at the prior committed value.

At the start of each cycle the orchestrator asks `remoteFs.hasCheckpoint()` (async — it reads the store). When it is false — first sync, an interrupted/partial sync that never committed a checkpoint, or after a manual rescan — `executeSyncOnce` passes `forceFullScan: true` to `collectChanges`, forcing a **cold** reconcile (full remote `list()` × baselines). Cold is the only mode that rediscovers remote files an interrupted sync pulled-but-never-baselined or never reached: the delta-based hot/warm path is blind to them because the cursor has already moved past them (or they predate any cursor, as in an interrupted first sync). When a checkpoint *is* committed, the next sync replays the delta from it, re-detecting any un-synced change.

A **same-session failure** also forces at least one subsequent cold cycle. This is load-bearing (ADR 0001 convergence path 2) — `result.failed` does not capture the full recovery gap (folder-rename descendants, remote-only orphans, detect-vs-execute races), so only a full cold scan re-derives it. After that cold recovery has been paid, the orchestrator may temporarily block only the same repeated **local-origin** poison action (`push`, `delete_remote`, `rename_remote`) whose error classification is `permanent` and carries a stable `permanentCode`. The key is `(backendType, action, path, "permanent", permanentCode)`, the same action signature must fail in two consecutive cycles, and the block lasts 5 minutes or until the action/content changes, succeeds, or fails with a non-eligible classification. The two-cycle threshold means the first failure still buys one mandatory cold recovery pass; the 5 minute TTL is a short mobile-friendly cooldown that prevents repeated poison I/O without persisting across plugin reloads. Blocked actions are reported as `result.blocked` and surface as `partial_error`; they are not treated as "Everything up to date".

Remote-origin or ambiguous actions (`pull`, `delete_local`, `rename_local`, `conflict`) are never blocked, because advancing past them could hide remote changes. Transient and rate-limit failures are also never blocked; after the connection or provider recovers, the next sync must execute I/O again. Re-seeding failed paths for a "hot" recovery, skipping the first cold scan for "small" failure sets, or advancing the cursor while blindly ignoring remote-origin failures are **ADR 0001 prohibited patterns** (they re-open silent in-session data loss). The cost is **bounded and intentionally retained**: per-action `withIoRetry` keeps most transient/429 failures from ever reaching `result.failed`, and repeated cold scans are avoided only after the recovery debt has been paid and the remaining failure is a permanent local-origin poison action.

The **Rescan vault** action (settings → Advanced) discards the committed checkpoint via the live FS (`remoteFs.resetCheckpoint()` — clears the cursor and cache) and triggers a sync, forcing one cold reconcile against the remote — a manual recovery for a vault that looks stuck or incomplete. It diffs against baselines (it does not re-download) and keeps sync history.

A backend may keep a **non-authoritative cache** (the Google Drive `path↔id` map in IndexedDB) to avoid a network re-list. That cache is a performance optimization, not a third source of truth. Its only invariant — **never committed ahead of (nor behind) the committed cursor** — is now structural: the cursor lives *in* the cache's store and commits in the same transaction, so they cannot diverge (a failed flush lands neither and propagates, holding the cycle back). Before "optimizing" any of this, read [ADR 0001](adr/0001-metadata-cache-is-subordinate-to-commit-last.md): the recurring bugs here all came from treating the cache as authoritative.

## Temperature modes

The change detector selects a temperature based on the state of `LocalChangeTracker` and `SyncStateStore` (or a forced cold reconcile during [crash recovery](#crash-recovery)):

### Hot -- O(delta)

Selected when the cycle snapshot is `initialized` and its dirty set is non-empty (the detector reads the snapshot captured at cycle start, not the live tracker).

- Takes the union of local dirty paths and remote changed paths (from `getChangedPaths()`)
- Calls `stat()` on each path for both local and remote filesystems
- Calls `stateStore.getMany()` for the affected paths only
- Prunes no-ops via explicit cases (in order): both sides absent → keep only if a baseline exists (cleanup); no baseline → always keep (new file); local absent but remote present → always keep (rename/delete source); otherwise keep iff `hasChanged(local)` or `hasRemoteChanged(remote)`. Entries with neither side nor a baseline are dropped first.
- Most efficient mode during steady-state operation

### Warm -- O(n) local + O(delta) remote

Selected when the hot condition fails (tracker uninitialized, or initialized but with no dirty paths) and `stateStore.getAll()` is non-empty. Typical cases: a focus/visibility/online sync with no pending local edits, or the first sync after plugin reload.

- Calls `localFs.list()` for a full local listing
- Calls `getChangedPaths()` for the remote delta
- Compares the full local listing against all stored `SyncRecord`s to find local changes and deletions
- Confirms every would-be local deletion against the authoritative filesystem (`confirmLocalDeletions`) so an under-reporting `list()` cannot delete an on-disk file — see [Deletion safety](#deletion-safety)
- Unions both endpoints (newPath and oldPath) of every local rename pair from `getRenamePairs()` into the changed set, so warm mode produces the delete_remote+push actions the rename optimizer consumes
- Calls `remoteFs.stat()` only for paths identified as changed

### Cold -- O(n)

Selected when `stateStore.getAll()` returns an empty array (first sync or after state clear), or forced via `forceFullScan` during [crash recovery](#crash-recovery) (no committed remote checkpoint).

- Calls both `localFs.list()` and `remoteFs.list()`
- Full outer join on path to build `MixedEntity[]` for every file on either side
- No filtering -- all paths are candidates

## Hash enrichment

After any temperature mode collects entries, `collectChanges()` runs `enrichHashesForInitialMatch()` on entries where both sides exist but no baseline (`prevSync`) is present. This handles cold starts, partial initial syncs, and simultaneous file creation.

`list()` returns `hash: ""` for performance. Without enrichment, the decision engine cannot distinguish identical files from conflicts (both hashes are falsy). The enrichment step:

1. Filters to entries where `local.size === remote.size` and `remote.remoteChecksum` is available (and its algo is locally computable)
2. Reads local file content and computes a digest in the remote checksum's algorithm (e.g. MD5 for Google Drive, via `js-md5`)
3. Compares with the remote's `remoteChecksum.value` (e.g. Google Drive MD5 from the files.list API response)
4. If match: computes SHA-256 from the same content and sets it on both entities so the decision engine returns `match`
5. If mismatch: leaves hashes empty → decision engine returns `conflict`

Uses `AsyncPool(10)` for parallel local reads. Per-file errors are caught and skipped (file stays unenriched → treated as conflict, safe side).

After initial-match enrichment, `enrichHashesForRenames()` runs for entries that are rename destinations (from `localTracker.getRenamePairs()`). In warm/cold mode, `list()` returns `hash: ""`, but the rename optimizer needs SHA-256 to verify content equivalence. This step calls `stat()` on rename destination entries to compute their hash. Only the `hash` field is updated; `mtime` and `size` from `list()` are preserved.

`collectChanges()` runs three post-collection steps in order: `enrichHashesForInitialMatch` (all modes, `AsyncPool(10)`), `enrichHashesForRenames` (all modes, unthrottled `Promise.all`), and — warm mode only — `confirmLocalDeletions` (`AsyncPool(10)`; see [Deletion safety](#deletion-safety)).

## Change detection

### Local changes

`LocalChangeTracker` (`local-tracker.ts`) tracks dirty paths in memory via a `Set<string>`. Vault events (`create`, `modify`, `delete`) call `markDirty(path)`. The `rename` event calls `markRenamed(newPath, oldPath)`, which records the pair in a `renamePairs` map (used by the rename optimizer) and marks both paths dirty. Rename chains are collapsed (A→B→C becomes A→C). Each sync cycle captures a `snapshot()` of the tracker at the start (a frozen copy of `dirtyPaths` / `renamePairs` / `folderRenamePairs` / `initialized`) and acknowledges exactly that snapshot at the end: `acknowledge(snapshot)` deletes the snapshot's paths from the dirty set and clears each captured rename / folder-rename pair only when the live entry still matches the snapshot's value (so a mid-cycle rename reusing a key survives), then sets `initialized = true`. Acknowledging the start-of-cycle snapshot rather than the live set keeps a `markDirty` arriving mid-cycle for the next cycle instead of sweeping it (see [Acknowledge pattern](error-handling.md#acknowledge-pattern)).

Folder renames are tracked separately: a `rename` event whose target is a `TFolder` routes to `markFolderRenamed(newPath, oldPath)`, recording the pair in a distinct `folderRenamePairs` map (also chain-collapsing A→B→C to A→C), while files go to `markRenamed`. Unlike `markRenamed`, this does not mark any path dirty. The orchestrator reads the cycle snapshot's `folderRenamePairs` and passes it into `refinePlan()` as a separate argument, where `coalesceLocalFolderRenames` consumes it.

### Remote changes

`IFileSystem.getChangedPaths()` returns `{ modified, deleted, renamed? }` or `null`. `null` means no incremental data is available — fall back to warm/cold detection. The `renamed` array carries `{ oldPath, newPath, isFolder? }` pairs for native rename optimization. For the Google Drive implementation of this contract (changes.list, the 410 full-scan delta, fullScanWithDelta), see [Incremental sync](google-drive-backend.md#incremental-sync) and [Cache invalidation](google-drive-backend.md#cache-invalidation).

### Comparison functions

`hasChanged(file, record)` -- local file vs baseline (ADR 0005 — locally a content
hash costs I/O, so it leads with the hash only when one is already on hand):

1. If **both** sides carry a content hash (the HOT/`stat()` path computed one), it is authoritative — compare hashes (catches a same-mtime+size edit; ignores an mtime-only touch)
2. Otherwise (the `list()` path leaves `hash: ""` to stay I/O-free), compare mtime + size
3. Neither a hash nor a usable mtime → conservatively treat as changed

`hasRemoteChanged(file, record)` -- remote file vs baseline:

1. mtime + size comparison
2. If mtime/size differ, check `remoteChecksum` (e.g. Google Drive md5Checksum), when both sides expose the same algorithm
3. Fall back to hash comparison
4. Conservative: treat as changed if undeterminable

## Decision table

`decideAction()` in `decision-engine.ts` maps each `MixedEntity` to a `SyncActionType`:

| prevSync | local | remote | localChanged | remoteChanged | Action |
|----------|-------|--------|--------------|---------------|--------|
| yes | exists | exists | yes | yes | `conflict` |
| yes | exists | exists | yes | no | `push` |
| yes | exists | exists | no | yes | `pull` |
| yes | exists | exists | no | no | (skip) |
| yes | exists | missing | yes | -- | `conflict` |
| yes | exists | missing | no | -- | `delete_local` |
| yes | missing | exists | -- | yes | `conflict` |
| yes | missing | exists | -- | no | `delete_remote` |
| yes | missing | missing | -- | -- | `cleanup` |
| no | exists | missing | -- | -- | `push` |
| no | missing | exists | -- | -- | `pull` |
| no | exists | exists | local.hash && remote.hash && equal hashes && equal sizes | (n/a) | `match` |
| no | exists | exists | any hash empty, or hash/size mismatch | (n/a) | `conflict` |

For no-baseline rows the localChanged/remoteChanged columns do not apply — `hasChanged`/`hasRemoteChanged` are not evaluated. `match` requires BOTH hashes present and equal plus equal sizes; because `list()` returns `hash: ""`, an unenriched entry has empty hashes and routes to `conflict` even when sizes match — see [Hash enrichment](#hash-enrichment).

## Deletion safety

There is no volume-based abort gate. Deletion safety rests on three independent layers:

1. **Decision rules** -- an ambiguous case (a file gone on one side while the surviving side changed since baseline) is routed to `conflict` (keep both), never to a deletion; a missing baseline never yields a deletion.
2. **layoutReady gate** -- sync does not run before the Obsidian vault index is loaded. `SyncScheduler` defers its event wiring, and `runSync()` is gated on `app.workspace.layoutReady`, so a `list()` that under-reports during startup cannot be mistaken for mass local deletions.
3. **Authoritative absence** -- a would-be local deletion (a baseline path missing from the in-memory `list()`) is re-`stat()`'d against the filesystem before it is acted on. `LocalFs.stat()` falls back to the vault adapter on an index miss. Only warm change detection runs `confirmLocalDeletions()` (hot and cold do not), re-`stat()`-ing each candidate (an entry with a prior baseline but no `local`: `!e.local && e.prevSync`) via `AsyncPool(10)`; a non-directory file found on disk has its `entry.local` restored, moving it out of the deletion branches. Only a genuine absence (gone on disk too, or `stat()` returns null/throws) propagates. Deletions are additionally soft -- to trash on both sides -- so even a correct deletion stays recoverable.

## Rename optimization

`refinePlan()` in `rename-optimizer.ts` runs after `planSync()`. It replaces redundant delete+transfer pairs with native rename operations. The optimizer is split by trust boundary into two modules:

### Local renames — hash-verified (`optimize-local-renames.ts`)

When `LocalChangeTracker` records a rename pair (from Obsidian's `rename` event), the optimizer matches `delete_remote(oldPath) + push(newPath)` → `rename_remote`. Hash verification is mandatory: `push.local.hash === del.baseline.hash` must hold, confirming content is unchanged. The centralised `isValidLocalRename()` function enforces this rule for both file and folder renames.

- **File renames** (`optimizeLocalFileRenames`): Matches individual rename pairs from `localTracker.getRenamePairs()`.
- **Folder renames** (`coalesceLocalFolderRenames`): When a folder rename is detected, coalesces all descendant file rename actions into a single `rename_remote` with `isFolder: true`. Only coalesces when ALL descendants pass hash verification. Uncoalesced file renames fall through to individual file rename optimization.

### Remote renames — trusted (`optimize-remote-renames.ts`)

When `getChangedPaths()` reports a rename pair, the optimizer matches `delete_local(oldPath) + pull(newPath)` → `rename_local`. The rename pair from the backend is authoritative, so no hash verification is needed. Surfacing that pair is the backend's job and is **order-independent** across all backends ([ADR 0006](adr/0006-remote-rename-detection-is-order-independent.md)): id-addressed backends (Google Drive, OneDrive) get it for free, while Dropbox's path-addressed delta (a `deleted(old)`+`add(new)` pair whose ordering Dropbox does not guarantee) reorders upserts-before-deletes so a folder rename never degrades to a file-by-file re-pull.

- **File renames** (`optimizeRemoteFileRenames`): Matches individual rename pairs from the backend. The match requires the old path to be a pure `delete_local` and the new path a `pull`; if a same-name file was created at the old path in the same sync, that path becomes a `pull`/`conflict` (not `delete_local`), so the rename correctly does NOT coalesce — the move and the new file resolve as two independent transfers (right end state, no move optimization). The local optimizer (`optimize-local-renames.ts`) is symmetric: it needs `delete_remote(old)` + `push(new)`.
- **Folder renames** (`coalesceRemoteFolderRenames`): When a folder-level rename pair has `isFolder: true`, coalesce every `delete_local` child under the old prefix into one `rename_local` (`isFolder: true`). Rules: (1) Absorb a descendant whose matching `pull` is missing into the rename — rewrite its baseline to the new path; a genuine remote delete then propagates as `delete_local` next cycle (bias toward safe deletion). (2) Skip the whole folder (reason `destination_occupied`) if any action under the new prefix has a non-null local entity (`a.local != null`), falling back to the per-file actions. Detection is best-effort; a per-action `localFs.rename` failure is caught and recovers next cycle. See `optimize-remote-renames.ts` for rationale. Remaining file-level pairs fall through to individual file rename optimization.
  - **Optimization opportunity (not implemented):** the `destination_occupied` skip re-downloads *every* child via `delete_local`+`pull`, even children whose own destination `B/x` is free. A finer fallback could expand the folder pair into per-child pairs and route them through `optimizeRemoteFileRenames`, turning each free-destination child into a `rename_local(A/x→B/x)` (no re-download) and leaving only the genuinely-colliding child as `conflict`/`match`. Purely an efficiency win in a rare case — convergence already guarantees correctness — left unimplemented to keep the coalescer all-or-nothing. See [ADR 0006](adr/0006-remote-rename-detection-is-order-independent.md).

### Observability

Each optimization step returns `RenameOptResult` with `applied` (successful renames) and `skipped` (with structured `reason`: `action_type_mismatch`, `hash_mismatch`, `hash_missing`, `no_descendants`, `destination_occupied`). `refinePlan()` logs these via the debug logger.

## Execution phases (lane/tier scheduling)

`executePlan()` in `plan-executor.ts` classifies each action by **resource lane** (which filesystem it mutates: `remote` / `local` / `both` / state-only) and **dependency tier** (`transfer` / `rename` / `delete` / state-only), then runs three phases separated by barriers:

| Phase | Actions | Execution | Rationale |
|-------|---------|-----------|-----------|
| 1 — Transfers | `push`, `pull` | Pooled via an **`AdaptivePool`** (AIMD: desktop start 5 / max 10, mobile start 3 / max 8; +1 every 8 clean runs, ÷2 on a rate-limit) **plus a byte budget** (in-flight bytes ≤ desktop 1 GB / mobile 512 MB) | Independent content I/O on disjoint paths (one action per path); concurrency adapts to the provider's sustainable rate, and the byte budget bounds peak memory (each transfer holds a whole-file `ArrayBuffer`) |
| 1 — State-only | `match`, `cleanup` | Inline, no pool slot | No I/O — just a `SyncRecord` upsert/delete |
| 2 — Conflicts | `conflict` | Serial (own phase) | Mutates both filesystems **and a planner-invisible `.conflict` sibling** (`generateConflictPath`); serial avoids sibling-path collisions — see [ADR 0001](adr/0001-metadata-cache-is-subordinate-to-commit-last.md) (prohibited patterns) |
| 3 — Structural | remote lane: `rename_remote` → `delete_remote`; local lane: `rename_local` → `delete_local` | The two lanes run **concurrently**; within each lane renames are **serial** then deletes **pooled** (own `AsyncPool(DELETE_CONCURRENCY=5)` per lane) | Renames serial (two endpoints + folder-subtree rewrites); deletes pooled (bulk-folder-delete throughput); lanes independent (the local FS has no remote metadata cache) |

The phases run behind **sequential barriers** (Phase 1 fully drains before Phase 2 before Phase 3). This preserves two safety properties: no content write (Phase 1) runs concurrently with a same-subtree structural rename/delete (Phase 3), and conflict (Phase 2, which touches both sides + a sibling path) never overlaps either. Renames stay serial so the rename optimizer's destination-occupancy assumptions hold; pooled deletes are safe even for the legitimate folder+descendant overlap via the inline delete CAS guard (the folder's `removeTree` evicts the child entry, so the child delete short-circuits) — see [ADR 0001 → T7](adr/0001-metadata-cache-is-subordinate-to-commit-last.md).

Phases 1 and 3 use `executeAction()`, which runs `runActionIO()` followed by `commitAction()` and records success in `result.succeeded`. Phase 2 (conflict) uses `executeConflictAction()` instead: it runs `resolveConflict()` per the configured strategy (`auto_merge` / `duplicate`), re-stats both local and remote sides, commits, and records the action in both `result.conflicts` and `result.succeeded`. In both paths, `AuthError` is re-thrown to abort the entire cycle (it rejects the phase's pool/lane and propagates); all other errors are caught per-action and recorded in `result.failed`. Known repeated local-origin poison actions can be skipped before I/O and recorded in `result.blocked`; they are visible in notifications and status but do not commit per-file state.

**Adaptive transfer concurrency + in-cycle retry.** Phase 1's `AdaptivePool` ramps its in-flight ceiling up on sustained success and halves it on a rate-limit signal, so a large initial/bulk sync discovers the provider's sustainable throughput instead of a fixed `5`. Admission has a **second dimension besides the count limit: a byte budget** (sum of in-flight transfer sizes ≤ desktop 1 GB / mobile 512 MB) — because each transfer holds the whole file as an `ArrayBuffer` (`requestUrl` is buffered, no streaming), the budget caps peak memory by *bytes* rather than letting it scale with file *count*, so small files run highly concurrent while large ones self-throttle. A single file larger than the budget still runs (it is admitted only when the pool is otherwise empty, so it transfers alone). Each action's network I/O is additionally wrapped in `withIoRetry`: a `rateLimit`/`transient` error is retried in-cycle (up to `MAX_ACTION_RETRIES = 3`, honoring `Retry-After`), and on a rate-limit the task signals the pool (`noteRateLimit`, before the backoff sleep) so the ceiling drops immediately while the rate-limited task holds its slot (a natural throttle). A rate-limited transfer therefore no longer defers to the next (forced-cold) cycle, so the cycle completes clean more often. See [error-handling.md → Two retry layers](error-handling.md#two-retry-layers). Conflict and deletes also get `withIoRetry`, but only transfers feed the `AdaptivePool` (conflict is serial; deletes use a fixed pool).

## State commit

`commitAction()` in `state-committer.ts` persists state per successfully-executed action:

- `push` / `pull` / `match` / `conflict`: upsert `SyncRecord` via `stateStore.put()`. If `enableThreeWayMerge` is on and the file is merge-eligible (`isMergeEligible`: byte size <= 1 MiB (`MAX_MERGE_SIZE = 1024*1024`) and the file extension is in the fixed `TEXT_EXTENSIONS` allowlist — .md/.txt/.json/.canvas/.css/.js/.ts/... — not a content sniff), stores the file content via `stateStore.putContent()` for future 3-way merge base. The content store compresses each entry (raw deflate via `store/content-codec.ts`, prefixed with a 1-byte format header; tiny/incompressible entries fall back to stored-raw so they never grow). Compression is transparent: `putContent` encodes and `getContent` decodes, so callers always handle plain bytes. `rewritePaths` copies the stored (still-encoded) bytes verbatim — no re-compression.
- `rename_remote` / `rename_local`: for a folder rename (`isFolder` with `descendants`), call `stateStore.rewritePaths(descendants)` to remap every child baseline (and any stored merge-base content) old→new path in one IndexedDB transaction. For a single file: delete the old-path record, upsert the new-path record (+ optional 3-way merge content).
- `delete_local` / `delete_remote` / `cleanup`: delete `SyncRecord` via `stateStore.delete()`.

Failed actions are not committed; they will be re-detected on the next sync cycle.

## Sync triggers

`SyncScheduler` (`scheduler.ts`) registers six event-driven sync triggers (wired by five `wire*` methods, since `wireVaultEvents()` covers both the Vault change and Vault rename rows below) — plus `wireDepartureEvents()`, which wires the departure boundary that *gates* the foreground triggers and is not itself a trigger (see below). Wiring happens in `wireAll()`, gated on `workspace.layoutReady`: if the layout is already ready, `start()` calls `wireAll()` immediately; otherwise it defers via `workspace.onLayoutReady(() => wireAll())`. `wireAll()` no-ops if the plugin was destroyed before the layout became ready.

| Trigger | Event | Behaviour |
|---------|-------|-----------|
| Vault change | `create` / `modify` / `delete` | Marks path dirty via `localTracker.markDirty()`, then calls `debouncedSync()` (5 s debounce). Consecutive edits reset the timer so sync fires 5 s after the last change. |
| Vault rename | `rename` | Calls `localTracker.markRenamed(newPath, oldPath)` which records the rename pair and marks both paths dirty, then calls `debouncedSync()`. Folder targets call `markFolderRenamed` instead. If either endpoint is ignore-excluded, the rename is not recorded as a pair; each non-excluded endpoint is marked dirty, and the debounce fires only if at least one endpoint is non-excluded. |
| Visibility | `document.visibilitychange` | On `"visible"` re-syncs via `triggerForegroundSync()` **only after a departure** (ADR 0007), unless a sync is already running. On `"hidden"` (background) marks a departure. |
| Focus | `window.focus` | Re-syncs via `triggerForegroundSync()` when the window gains focus (desktop alt-tab, tablet split-view return, mobile first-touch), **only after a departure** (ADR 0007). |
| Online | `window.online` | Immediately calls `runSync()` when the network connection is restored — a network axis, **not** departure-gated. |
| File open | `workspace.on("file-open")` | Priority pull for the opened file (see below). |

A **departure** (the app leaving the foreground) is marked by `wireDepartureEvents()` (`window.blur`) **or** `visibilitychange→hidden`, OR'd so phone (hidden), tablet/desktop (blur — alt-tab and split-view keep the document `visible`) are all covered. It is not itself a sync trigger; it arms the next foreground return.

All triggers are event-driven — there is no periodic timer. All triggers except file-open run a full sync cycle through the pipeline. Out-of-scope paths (failing either gate of `isExcluded()` — dot-path scope or `ignorePatterns`) are excluded at the vault-event level — dirty marks and debounce are skipped entirely. The file-open priority pull also skips out-of-scope paths.

These triggers are **classified** ([ADR 0004](adr/0004-sync-reruns-are-classified-by-trigger.md)): **signal** triggers carry no local change, and the `isSyncing()` guard **discards** them while a sync is in flight (the in-flight cycle already does the re-scan they ask for); **vault** triggers carry a real edit and route through `markDirty` + `debouncedSync()`, so they re-run via `syncPending` even mid-sync. The **foreground** signals (focus / visibilitychange→visible) are further gated on a real **departure** ([ADR 0007](adr/0007-foreground-resync-requires-a-real-departure.md)): they re-sync only after the app actually left the foreground, so a mobile cold start's trailing deferred `focus` (no departure since the `onLayoutReady` catch-up sync) does not fire a redundant second scan. That guard, the `syncPending` loop, and the departure gate are load-bearing — see the ADRs before collapsing them.

## Active file priority sync

`SyncScheduler.wireFileOpenEvent()` hooks the `file-open` workspace event. When a user opens a file:

1. Ignore null file (e.g. closing the active pane)
2. Look up the file's `SyncRecord`
3. Call `stat()` on both local and remote
4. If remote has changed (`hasRemoteChanged`) but local has NOT changed (`hasChanged`), call `orchestrator.pullSingle(path)` to immediately pull the latest version
5. This gives the user the freshest content immediately on file open

Unlike the focus/visibility/online triggers, the file-open handler does not check `isSyncing()` and does not skip when a sync is already running. `pullSingle()` acquires the same `syncMutex` that `runSync()` uses, so the priority pull queues behind any in-flight sync (the `AsyncMutex` enqueues the waiter rather than dropping it) instead of being skipped. The record lookup and `stat()` checks (steps 2-4) run before `pullSingle`, so they execute concurrently with an in-flight sync; only the actual pull is serialized.
