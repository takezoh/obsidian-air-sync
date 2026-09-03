# Sync Pipeline

## Pipeline overview

Each sync cycle has exactly four top-level responsibility stages:

1. **Observation** -- `collectChanges()` acquires exact entries, path observations, and normative identity evidence; scope projection and `captureBatchObservation()` freeze those facts without constructing actions.
2. **Admission** -- `admitBatchObservation()` privately constructs the path-local proposal, builds identity-connected components once, applies conflict and destructive-action policy, assigns every relevant component one disposition and lifecycle membership, and issues the only `AuthorizedSyncPlan`.
3. **Execution** -- `executePlan()` accepts that authorized plan only, performs its exact effects, and reports exact outcomes without inventing or rerouting actions.
4. **Commit/finalization** -- per-action state publication records proven successes; `finalizeSyncCycle()` mechanically folds those outcomes with the Admission dispositions, commits a safe checkpoint, and only then retires released evidence and debt.

These stages describe responsibility owners, not one separately scheduled pass per helper function. Evidence completion, scope projection, and immutable fact capture belong to **Observation**. The path-local decision table, component build, conflict policy, and component-local rename shaping are private to **Admission**. They add no extra network scan merely by being named.

The lower-level cycle sequence within those boundaries is:

1. `collectChanges()` selects HOT/WARM/COLD collection, records authoritative path observations and identity evidence, confirms uncertain absences, and completes required hashes/identity facts.
2. `applyScope()` removes excluded paths and cross-scope identity edges, then projects mobile and observation completeness over the remaining facts.
3. `captureBatchObservation()` fixes included entries, evidence, observations, scope, and namespace without an action carrier.
4. `admitBatchObservation()` invokes the private path-local `planSync()` helper, then builds evidence-connected components once, shapes and decides each component, and projects the `AuthorizedSyncPlan` while preserving disconnected ordinary proposal order.
5. `executePlan()` runs only that authorized projection and reports exact completion; each successful action is published through `commitAction()`.
6. `finalizeSyncCycle()` folds disposition membership with execution completion, commits the checkpoint when safe, then retires released evidence and debt.

The orchestrator (`SyncOrchestrator.executeSyncOnce()`) only sequences the boundaries. `prepareSyncCycleSnapshot()` projects scope and produces a fact-only `BatchObservation`. The orchestrator passes it once to `admitBatchObservation()` at the authorization cut point; no executable action exists before that call.

File-open priority does not add another set of these stages. It reuses the stored baseline and Admission's exact action projection, while a provider capability supplies only a detached current observation/read. The normal cycle is not re-decided at execution time and does not issue per-component targeted API calls.

**Scope filter (`SyncOrchestrator.isExcluded()`)** — a path is synced only if it passes **both** gates:

1. **Dot-path scope** (`isDotPathOutOfScope`): a dot-prefixed/hidden path (`.airsync`, `.obsidian`, `.git`, …) is in scope only when it sits under a configured `syncDotPaths` root — `settings.syncDotPaths` augmented with the vault's config directory when `enableConfigSync` is on (`getEffectiveSyncDotPaths`, `config-sync.ts`). Normal paths always pass. This is applied symmetrically to local and remote facts before `BatchObservation`; excluded endpoints and identity edges that cross the boundary are discarded.
2. **Ignore patterns** (`isIgnored`): gitignore-style `ignorePatterns` — likewise augmented with a built-in pattern set (`getEffectiveIgnorePatterns`) prepended when `enableConfigSync` is on while excluding device-specific workspace state. The `syncConfigJsonFiles`, `syncConfigPlugins`, `syncConfigSnippets`, `syncConfigThemes`, and `syncConfigIcons` settings independently add root `*.json`, `plugins/`, `snippets/`, `themes/`, and `icons/`. `community-plugins.json` is classified with `plugins/`, not with generic root JSON, because it is the active community plugin list; it therefore follows `syncConfigPlugins` even when `syncConfigJsonFiles` differs. Root JSON and plugins stay on by default solely for backward compatibility with the pre-toggle Config Sync behavior; all newly introduced subtree scopes default to off and require explicit opt-in. These settings are part of the scope fingerprint, so changing one forces a single cold reconcile and surfaces remote-only files that predate the delta cursor.

`isExcluded()` also reserves two paths unconditionally, ahead of both gates, so neither `syncDotPaths` nor `ignorePatterns` can ever pull them back into scope:
- The backend's own metadata path (`INTERNAL_METADATA_PATH` = `.airsync/metadata.json`, `sync/remote-vault.ts`): never synced from either side, even when `.airsync` is opted into `syncDotPaths`. The remote FS hides it too; excluding it here keeps the exclusion symmetric (otherwise a local copy would be pushed, then deleted as a phantom remote deletion).
- This plugin's own settings file under the config directory (`isOwnPluginDataPath`, `config-sync.ts`): checked regardless of `enableConfigSync`, since a user can opt the config directory into `syncDotPaths` by hand without the toggle. Syncing it would let one device's backend credentials/vaultId overwrite another's — a soft `ignorePatterns` entry alone can't guarantee this (gitignore's last-match-wins semantics would let a user's own pattern override it), so it's enforced as a reserved path instead.

The same `isExcluded()` gates the vault-event dirty tracking (scheduler), so push and pull use one scope rule across hot and cold paths.

`runSync()` is gated on a connected remote (`remoteFs` present), layout-ready, and not-connecting; it serializes via an `AsyncMutex`. A call arriving while a sync runs sets `syncPending` and returns; the lock holder re-runs in a `do/while (syncPending)` loop. A tracker snapshot is acknowledged only after a clean, terminal cycle; an unresolved rename input remains in that in-memory input buffer for the next invocation. Each cycle (`executeSyncOnce`) is wrapped by `executeWithRetry`, which normally retries up to `MAX_RETRIES = 3` with exponential backoff plus jitter (`2^(attempt-1) * 1000 * (0.5 + Math.random())` ms), honoring `Retry-After` (×1000) on 429/403. `AuthError`, a non-rate-limit 403, and 404 abort without retry. A pre-Admission failure reports an error and causes the next normal trigger to use COLD observation; no evidence or recovery instruction is persisted.

## Crash recovery

The remote delta cursor is the engine's "synced up to here" checkpoint. It lives in the backend's IndexedDB store (`META_STORE`), **co-located with the file-map cache and committed in the same transaction** (see [ADR 0001](adr/0001-metadata-cache-is-subordinate-to-commit-last.md)). `finalizeSyncCycle()` calls `remoteFs.checkpoint.commitCheckpoint()` only when there is no failed action or Admission failure. A partial or interrupted cycle leaves cursor and cache at the prior committed value.

At the start of each cycle the orchestrator asks `remoteFs.checkpoint.hasCheckpoint()` (async — it reads the store). `false` means first sync, cleared state, or manual rescan and forces COLD. COLD is also forced after a same-session failed cycle (`recoverViaColdScan`) and after a scope-fingerprint change. A non-clean cycle after an established checkpoint does **not** erase that checkpoint: same-session recovery ignores the advanced live cursor and lists both sides, while a restart rebuilds the FS from the older committed cursor and freshly reacquires the current state. This distinction is the two-path recovery contract in ADR 0001.

A **same-session failure** also forces the next cycle to be cold. This is load-bearing (ADR 0001 convergence path 2) — `result.failed` does not capture the full recovery gap (folder-rename descendants, remote-only orphans, detect-vs-execute races), so only a full cold scan re-derives it. No previous failure suppresses an action in a later explicit sync: each cycle authorizes and executes solely from its current snapshot.

An **Admission failure** is different from a failed action: the rejected component never reaches the executor, even when it contains zero actions. The cycle ends `partial_error`, reports an ordinary error, withholds the checkpoint/scope fingerprint, and marks the next normal trigger for COLD re-observation without setting `syncPending` (no tight loop). It creates no pending operation row. Case-only local rename evidence may be reconstructed from an unambiguous case-folded baseline/current pair when the remote baseline identity and version remain unchanged; general rename identity is never guessed.

Re-seeding failed paths for a "hot" recovery, skipping the first cold scan for "small" failure sets, or advancing the cursor while blindly ignoring remote-origin failures are **ADR 0001 prohibited patterns** (they re-open silent in-session data loss). Per-action `withIoRetry` keeps most transient/429 failures from ever reaching `result.failed`; after a terminal failure, the next explicit sync invokes the provider again.

The **Rescan vault** action (settings → Advanced) discards the committed checkpoint via the live FS (`remoteFs.checkpoint.resetCheckpoint()` — clears the cursor and cache) and triggers a sync, forcing one cold reconcile against the remote — a manual recovery for a vault that looks stuck or incomplete. It diffs against baselines (it does not re-download) and keeps sync history.

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
- Confirms every baseline absence against the authoritative filesystem (`confirmBaselineAbsences`) so an under-reporting list cannot authorize deletion on either side — see [Deletion safety](#deletion-safety)
- Adds both endpoints of every local reported rename from the cycle snapshot to the observations/change surface; the normative record is then `ChangeSet.identityEvidence`
- Calls `remoteFs.stat()` only for paths identified as changed

### Cold -- O(n)

Selected when `stateStore.getAll()` returns an empty array (first sync or after state clear), or forced via `forceFullScan` for a missing checkpoint, same-session recovery, or scope change.

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

After initial-match enrichment, `enrichHashesForRenames()` runs for local rename destinations derived from `ChangeSet.identityEvidence`. In warm/cold mode, `list()` returns `hash: ""`, but Admission's local-origin rename proof needs SHA-256 content equivalence. This step calls `stat()` on exact local destination entries. Only the `hash` field is updated; `mtime` and `size` from `list()` are preserved.

Before hash enrichment, `collectChanges()` creates observations for every rename endpoint, confirms unknown endpoints, confirms the opposite side of carried debt/evidence, and in WARM/COLD confirms every baseline absence. A thrown `stat()` aborts the attempt; it is never converted to absence. Hash enrichment then touches exact entries only, and `completeIdentityEvidence()` adds same-root stable-ID occurrences.

## Change detection

### Local changes

`LocalChangeTracker` (`local-tracker.ts`) tracks dirty paths in memory via a `Set<string>`. Vault events (`create`, `modify`, `delete`) call `markDirty(path)`. The `rename` event calls `markRenamed(newPath, oldPath)`, which records the producer pair and marks both paths dirty. Rename chains are collapsed (A→B→C becomes A→C). At collection, `collectLocalRenameEvidence()` converts the captured pair exactly once into the normative `RenameEvidence`; any private action-shaping view is derived from that evidence rather than maintained as a second source of truth. Each sync cycle captures a `snapshot()` of the tracker at the start (a frozen copy of `dirtyPaths` / `renamePairs` / `folderRenamePairs` / `initialized`) and acknowledges exactly that snapshot at the end: `acknowledge(snapshot)` deletes the snapshot's paths from the dirty set and clears each captured rename / folder-rename pair only when the live entry still matches the snapshot's value (so a mid-cycle rename reusing a key survives), then sets `initialized = true`. Acknowledging the start-of-cycle snapshot rather than the live set keeps a `markDirty` arriving mid-cycle for the next cycle instead of sweeping it (see [Acknowledge pattern](error-handling.md#acknowledge-pattern)).

Folder renames are captured separately at the event boundary: a `TFolder` routes to `markFolderRenamed(newPath, oldPath)`, recording a chain-collapsed producer pair while files use `markRenamed`. Unlike file rename capture, this does not mark every descendant dirty. Collection converts both maps into the same normative `RenameEvidence` shape (`isFolder` distinguishes them); Admission receives that single evidence collection and derives its private folder-shaping view.

### Remote changes

`IFileSystem.checkpoint.getChangedPaths()` returns `{ modified, deleted, renamed? }` or `null`. `null` means no incremental data is available — fall back to warm/cold detection. The `renamed` array carries `{ oldPath, newPath, isFolder? }` as authoritative reported evidence. The acquisition owner captures that evidence before later detection work, so a retry cannot consume the live cursor and lose the constraint.

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

There is no volume-based abort gate. Deletion safety rests on four independent layers:

1. **Decision rules** -- an ambiguous case (a file gone on one side while the surviving side changed since baseline) is routed to `conflict` (keep both), never to a deletion; a missing baseline never yields a deletion.
2. **layoutReady gate** -- sync does not run before the Obsidian vault index is loaded. `SyncScheduler` defers its event wiring, and `runSync()` is gated on `app.workspace.layoutReady`, so a `list()` that under-reports during startup cannot be mistaken for mass local deletions.
3. **Authoritative observation** -- listing absence is re-`stat()`'d before it can authorize deletion. `LocalFs.stat()` falls back to the vault adapter on an index miss. `actual_resolved` proves an exact/alias path; `requested_echo` proves presence only; `null` proves absence; a thrown stat aborts the cycle. HOT checkpoint tombstones remain authoritative remote absence (Issue #44).
4. **Whole-component admission** -- rename, alias, unresolved-presence, and stable-ID edges connect related managed paths. Paths excluded by system-junk rules, user ignore patterns, dot-path scope, Config Sync policy, or reserved-path policy are absent from the Admission snapshot. An included-to-included folder rename is one opaque folder operation; excluded physical entries are not identity nodes and do not participate in mapping completeness. If the component decision cannot prove that every managed resource survives, `admitDestructivePlan()` fails it before execution. Deletions are additionally soft (trash), but recoverability is not used as authorization.

## Identity-component action shaping

There is no standalone whole-plan optimizer. PlanAdmission builds the cycle-local
component partition once and may replace a component's proved delete+transfer pair
with one native rename as part of the same result that carries authorization,
disposition, and lifecycle membership. The private shaping helpers retain two proof
rules:

### Local renames — hash-verified (`optimize-local-renames.ts`)

For a local reported rename in `ChangeSet.identityEvidence`, Admission may shape `delete_remote(oldPath) + push(newPath)` → `rename_remote`. Hash verification is mandatory: `push.local.hash === del.baseline.hash` must hold, confirming content is unchanged. The private local helper enforces this rule for both file and folder renames.

- **File renames** (`optimizeLocalFileRenames`): Consumes the derived file view of local `RenameEvidence`.
- **Folder renames** (`coalesceLocalFolderRenames`): Consumes the derived folder view and coalesces all mapped managed-descendant actions into one `rename_remote` with `isFolder: true`. Every managed descendant must pass hash verification. Excluded listing entries are absent from this view and do not prevent the opaque folder rename. Missing managed mappings still fail Admission.

On case-insensitive local filesystems, a COLD replay can resolve the requested new spelling back to the old spelling and therefore produce no ordinary path-local action. Admission reconstructs a managed child `rename_remote` only when the local alias is exact, the stored baseline content matches local content, the exact remote source is unchanged, and remote destination absence is authoritative. Reconstructed child actions can be coalesced back into the reported opaque folder rename. This lets persisted evidence converge without weakening changed-content or ambiguous-identity handling.

### Remote renames — trusted (`optimize-remote-renames.ts`)

When `getChangedPaths()` reports a rename pair, Admission may shape `delete_local(oldPath) + pull(newPath)` → `rename_local`. The report is authoritative rename evidence, so this shaping needs no content-hash inference. Surfacing that pair is the backend's job and is order-independent across all backends ([ADR 0006](adr/0006-remote-rename-detection-is-order-independent.md)). The same component decision validates the shaped result; there is no independently trusted intermediate plan.

- **File renames** (`optimizeRemoteFileRenames`): Matches individual rename pairs from the backend. The match requires the old path to be a pure `delete_local` and the new path a `pull`. If a new object was created at the old path, native rename does not coalesce; Admission permits the source-recreation fallback only when stable-ID evidence proves the moved and recreated objects are distinct and the actions preserve both. The private local shaping helper is symmetric: it needs `delete_remote(old)` + `push(new)`.
- **Folder renames** (`coalesceRemoteFolderRenames`): When a folder-level rename pair has `isFolder: true`, coalesce every `delete_local` child under the old prefix into one `rename_local` (`isFolder: true`). Rules: (1) Absorb a descendant whose matching `pull` is missing into the rename — rewrite its baseline to the new path; a genuine remote delete then propagates as `delete_local` next cycle (bias toward safe deletion). (2) Skip the whole folder (reason `destination_occupied`) if any action under the new prefix has a non-null local entity (`a.local != null`), falling back to the per-file actions. Detection is best-effort; a per-action `localFs.rename` failure is caught and recovers next cycle. See `optimize-remote-renames.ts` for rationale. Remaining file-level pairs fall through to individual file rename optimization.
  - **Optimization opportunity (not implemented):** a destination-occupied folder rename may be decomposable into per-child mappings, but only a complete mapping whose postconditions pass Admission may execute. Incomplete mappings fail Admission; see [ADR 0006](adr/0006-remote-rename-detection-is-order-independent.md) and [ADR 0008](adr/0008-logical-identity-admission-fails-closed.md).

## Destructive admission

`prepareSyncCycleSnapshot()` applies scope before freezing included entries,
normative evidence, observations, scope, and backend/root namespace into one fact-only
`BatchObservation`. The orchestrator passes that value once to
`admitBatchObservation()`. Admission privately constructs the path-local proposal, then builds connected components from
actions plus rename/alias/stable-identity evidence and path observations and emits
exactly one `authorized`, `resolved_no_action`, or `failed` disposition per
relevant component, including evidence-connected components with zero actions.

Admission alone proves exact deletion authority, native rename, two-sided convergence,
or the recognized source-recreation
postcondition. Unknown, conflicting, incomplete, or otherwise unproved components
fail closed as a whole, including state-only actions. Only actions from `authorized`
dispositions are projected into the nominal `AuthorizedSyncPlan`; disconnected
ordinary work retains proposal order, while a proved component replacement occupies
that component's place.
`executePlan()` cannot accept a plain proposal through the supported typed API.

Endpoint dispositions are `included`, `mobile_deferred`, or `unknown`.
Any unknown/mobile endpoint and any incomplete folder descendant mapping fails Admission. The
full local/remote direction matrix and rejected identity inferences are recorded in
[ADR 0008](adr/0008-logical-identity-admission-fails-closed.md).

Before admitted I/O, local reported edges are upserted into the SyncState v6 rename-debt
store under the snapshot's backend/root namespace. `finalizeSyncCycle()` does not
re-evaluate scope, observations, identities, aliases, or action shapes: it folds the
snapshot-bound dispositions with succeeded action membership. A safe checkpoint commits
first; only then are mechanically releasable debt and session evidence retired.
Disconnect/root switch waits on the orchestrator mutex before clearing state, so an
old-target in-flight cycle cannot recreate debt after teardown.

### Observability

Admission logs executable/proposed counts and each failed component's reason,
evidence kind/origin, endpoint dispositions, and paths (never content or credentials).
Status remains `partial_error`, and Admission failures join failed actions in the ordinary error
count. Their detailed reason remains diagnostic only. A later ordinary sync may reacquire current
facts, but the failure is neither pending work nor a convergence guarantee.
Private shaping helpers expose typed skip reasons to focused tests, but do not form an
observable pipeline stage.

## Execution phases (lane/tier scheduling)

`executePlan()` in `plan-executor.ts` classifies each action by **resource lane** (which filesystem it mutates: `remote` / `local` / `both` / state-only) and **dependency tier** (`transfer` / `rename` / `delete` / state-only), then runs three phases separated by barriers:

| Phase | Actions | Execution | Rationale |
|-------|---------|-----------|-----------|
| 1 — Transfers | `push`, `pull` | Pooled via an **`AdaptivePool`** (AIMD: desktop start 5 / max 10, mobile start 3 / max 8; +1 every 8 clean runs, ÷2 on a rate-limit) **plus a byte budget** (in-flight bytes ≤ desktop 1 GB / mobile 512 MB) | Independent content I/O on disjoint paths (one action per path); concurrency adapts to the provider's sustainable rate, and the byte budget bounds peak memory (each transfer holds a whole-file `ArrayBuffer`) |
| 1 — State-only | `match`, `cleanup` | Inline, no pool slot | No I/O — just a `SyncRecord` upsert/delete |
| 2 — Conflicts | `conflict` | Serial (own phase) | Mutates both filesystems **and a planner-invisible `.conflict` sibling** (`generateConflictPath`); serial avoids sibling-path collisions — see [ADR 0001](adr/0001-metadata-cache-is-subordinate-to-commit-last.md) (prohibited patterns) |
| 3 — Structural | remote lane: `rename_remote` → `delete_remote`; local lane: `rename_local` → `delete_local` | The two lanes run **concurrently**; within each lane renames are **serial** then deletes **pooled** (own `AsyncPool(DELETE_CONCURRENCY=5)` per lane) | Renames serial (two endpoints + folder-subtree rewrites); deletes pooled (bulk-folder-delete throughput); lanes independent (the local FS has no remote metadata cache) |

The phases run behind **sequential barriers** (Phase 1 fully drains before Phase 2 before Phase 3). This preserves two safety properties: no content write (Phase 1) runs concurrently with a same-subtree structural rename/delete (Phase 3), and conflict (Phase 2, which touches both sides + a sibling path) never overlaps either. Renames stay serial so Admission's destination-occupancy proof is not deliberately invalidated by another rename in the same lane; pooled deletes are safe even for the legitimate folder+descendant overlap via the inline delete CAS guard (the folder's `removeTree` evicts the child entry, so the child delete short-circuits) — see [ADR 0001 → T7](adr/0001-metadata-cache-is-subordinate-to-commit-last.md).

Phases 1 and 3 use `executeAction()`, which runs `runActionIO()` followed by `commitAction()` and records success in `result.succeeded`. Phase 2 (conflict) uses `executeConflictAction()` instead: it runs `resolveConflict()` per the configured strategy (`auto_merge` / `duplicate`), re-stats both local and remote sides, commits, and records the action in both `result.conflicts` and `result.succeeded`. In both paths, `AuthError` is re-thrown to abort the entire cycle (it rejects the phase's pool/lane and propagates); all other errors are caught per-action and recorded in `result.failed`.

Each normal action holds a `PriorityCoordinator` permit from immediately before its exact effect through `commitAction()` and terminal result publication. Queued file-open work therefore runs only at a safe point where no normal action is half-applied. Preparation through Admission and finalization through checkpoint commit are exclusive. The existing phase barriers remain authoritative; priority is allowed to replace only an unstarted Admission-projected singleton pull during the transfer phase.

**Adaptive transfer concurrency + in-cycle retry.** Phase 1's `AdaptivePool` ramps its in-flight ceiling up on sustained success and halves it on a rate-limit signal, so a large initial/bulk sync discovers the provider's sustainable throughput instead of a fixed `5`. Admission has a **second dimension besides the count limit: a byte budget** (sum of in-flight transfer sizes ≤ desktop 1 GB / mobile 512 MB) — because each transfer holds the whole file as an `ArrayBuffer` (`requestUrl` is buffered, no streaming), the budget caps peak memory by *bytes* rather than letting it scale with file *count*, so small files run highly concurrent while large ones self-throttle. A single file larger than the budget still runs (it is admitted only when the pool is otherwise empty, so it transfers alone). Each action's network I/O is additionally wrapped in `withIoRetry`: a `rateLimit`/`transient` error is retried in-cycle (up to `MAX_ACTION_RETRIES = 3`, honoring `Retry-After`), and on a rate-limit the task signals the pool (`noteRateLimit`, before the backoff sleep) so the ceiling drops immediately while the rate-limited task holds its slot (a natural throttle). A rate-limited transfer therefore no longer defers to the next (forced-cold) cycle, so the cycle completes clean more often. See [error-handling.md → Two retry layers](error-handling.md#two-retry-layers). Conflict and deletes also get `withIoRetry`, but only transfers feed the `AdaptivePool` (conflict is serial; deletes use a fixed pool).

## State commit

`commitAction()` in `state-committer.ts` persists state per successfully-executed action:

- `push` / `pull` / `match` / `conflict`: replace a known baseline with whole-record `stateStore.compareAndPut()`; a baseline-free new action uses `put()`. A stale baseline fails the action instead of overwriting a newer winner. If `enableThreeWayMerge` is on and the file is merge-eligible (`isMergeEligible`: byte size <= 1 MiB (`MAX_MERGE_SIZE = 1024*1024`) and the file extension is in the fixed `TEXT_EXTENSIONS` allowlist — .md/.txt/.json/.canvas/.css/.js/.ts/... — not a content sniff), stores the file content via `stateStore.putContent()` for future 3-way merge base. The content store compresses each entry (raw deflate via `store/content-codec.ts`, prefixed with a 1-byte format header; tiny/incompressible entries fall back to stored-raw so they never grow). Compression is transparent: `putContent` encodes and `getContent` decodes, so callers always handle plain bytes. `rewritePaths` copies the stored (still-encoded) bytes verbatim — no re-compression.
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
2. Forward the path to `orchestrator.pullSingle(path)`; the scheduler reads no baseline and no filesystem metadata
3. The priority owner requires an identity-aware `SyncRecord`, rechecks local state, and asks optional `IFileSystem.priority.observe/read` for detached current authority
4. If changed and safe, write locally, commit the whole record with CAS, then acknowledge the exact tracker generation
5. If an admitted singleton pull is still pending, supersede that exact action object; otherwise complete independently

Unlike focus/visibility/online triggers, file-open is queued even while a batch runs. `PriorityCoordinator` drains queued opens after active normal actions finish and before later normal permits. It never interrupts an effect/commit pair, runs nothing during preparation/finalization, and does not alter the global phase order. Only a transfer-phase exact singleton regular-file pull with matching stable identity can be superseded. Missing capability/baseline, structural or ambiguous topology, a local edit, changed target token/identity, CAS loss, or a later phase fails closed to the normal lifecycle; no alternate action is invented. Duplicate opens of one pending path coalesce into one attempt.
