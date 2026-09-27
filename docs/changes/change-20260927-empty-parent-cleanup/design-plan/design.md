# Empty-parent cleanup on delete/rename propagation

<!-- anchor: goal -->
## Goal

Removing the last file from a folder on one device leaves an empty folder on the
other device forever. Folders are not sync facts today: they exist on the far side
only as a side effect of a file write, and nothing removes one when its last child
disappears. Over time both sides accumulate empty shells the user cannot explain.

This design removes a folder on the **receiving** side when a propagated
opposite-side file deletion or rename empties it, and cascades through ancestors the
cascade also empties, stopping before the sync root. The originating side keeps its
folder. It deliberately does **not** make empty folders first-class sync facts
(GitHub issue #77); creating, renaming, or deleting an already-empty folder still
propagates nothing.

## Decisions taken (from requirements Q&A, 2026-09-27)

1. **Scope.** Empty-parent cleanup only; not full empty-folder sync. This stays out
   of the four layers catalogued in
   [issue-20260916-empty-folders-never-sync-on-any-backend](../../issue/issue-20260916-empty-folders-never-sync-on-any-backend.md):
   no directory `entries`, no folder identity in Admission, no new `SyncActionType`,
   no folder `SyncRecord`.
2. **Receiver side only.** The side mutated by the action is pruned. `delete_local`
   and `rename_local` prune locally; `delete_remote` and `rename_remote` prune
   remotely. This is exactly the side that received the opposite-side change, so the
   origin side keeps its own now-empty folder.
3. **Strict safety.** A directory is deleted only when occupancy is authoritatively
   proven empty; any in-scope sibling, ignored sibling, dot-prefixed/hidden sibling,
   unknown occupancy, reserved path, or the sync root prevents deletion. Out-of-scope
   means "keep", because it still proves the folder is occupied.

<!-- anchor: approach -->
## Approach

The prune target is the target of the action, and every delete/rename action's target
is the receiving side (verified against `decision-engine.ts` and
`plan-executor.ts`: `delete_local`/`rename_local` move the local side; the other two
move the remote side). So the policy in decision 2 is exactly "prune on the action's
target filesystem".

**1. Admission attaches the candidate chain, scope-filtered.** When Admission
constructs an admitted `delete_local` / `delete_remote` / file `rename_local` /
file `rename_remote` action, it attaches the ancestry of the removed source path —
`action.oldPath` for a rename, `action.path` for a delete — as a fixed execution
protocol on the action: `pruneEmptyAncestors: readonly string[]`, deepest-first, each
ancestor a directory that is itself in sync scope, excluding the root. This is a
protocol carried by an action, not a new action kind: the same shape `ConflictAction`
already uses for `protocol` and `RenameAction` for `content`/`descendantRecords`.
Folder renames and the state-only `match`/`cleanup` actions carry nothing (a folder
rename keeps the folder; a state-only action performs no filesystem I/O).

Scope filtering needs a directory predicate. `ScopeProjection` already exposes
`byEndpoint` for files; this adds an `includes(path)` predicate copied from the
projection's own `isIncluded`, so Admission can decide an ancestor's inclusion without
re-deriving ignore/dot-path/reserved rules. This is a type-surface addition, not a
policy change.

**2. Execution runs one deduplicated prune pass after the removals.** Once every
serial removal in the cycle has completed, the executor takes the union of all
succeeded actions' admitted candidate chains, keyed by `(side, directory)`, and walks
it deepest-first. For each directory it asks `hasChildren` exactly once; only a `false`
answer authorizes the `delete(directory)` that follows. A directory with any child — the
in-scope files under consideration, an ignored file, a `.gitkeep`, a hidden child, or
anything else — is kept, and its ancestors are skipped unread because each necessarily
contains it. A `hasChildren`/`delete` error is logged at warn, keeps that directory (and
skips its ancestors, which it still occupies), and does not fail the cycle (see
NFR-EPC-001 below). Running after all removals is what makes a shared folder—two
sibling files deleted by two actions—read once rather than once per action.

This is a re-evaluation of current facts at execution, the same discipline
`checkPublicationInputs` applies to file endpoints: Admission authorizes the bounded,
scope-approved candidate set as part of the action; execution refuses any candidate
whose condition does not hold.

**3. Occupancy is a first-class port semantic, sourced from the right authority.**
The empty check only needs "does this directory hold anything". `IFileSystem` gains
`hasChildren(path)` for exactly that, sourced from each backend's authority: the local
disk authority — the raw vault adapter, which sees dot-prefixed entries the vault index
omits, so a folder holding only `.hidden` is not reported empty — and, for a remote
backend, its derived cache, which holds out-of-scope objects too. The old metadata-rich
`listDir` (no production caller) is retired. The local filesystem is meanwhile split
into the two authorities it always straddled: a **disk authority** (`DiskSurface`, raw
`DataAdapter`) for existence/casing/occupancy and mutation of index-invisible paths, and
an **index authority** (`VaultSurface`, `Vault`/`FileManager`) for indexed mutation and
discovery; `LocalFs` composes them and owns the authority rule, cross-regime parent
creation, and cross-regime rename.

**4. Nothing is persisted and no new authority is created.** No folder record, no
prune intent, no recovery marker, no cursor or checkpoint change, no IndexedDB
change, no new member of the closed `SyncActionType` set. The candidate chain lives
only on the cycle's action; the occupancy proof lives only in the executor's once-per-cycle
pass.

### Why this shape

- It is the minimal change that satisfies the policy: it touches `types.ts`
  (one optional action field), the admission action-construction site (attach the
  chain), a new `prune-empty-parents.ts` invoked once by `plan-executor.ts`,
  `scope-projection.ts` / `types.ts` (`ScopeProjection.includes`), the port semantic
  `IFileSystem.hasChildren`, and the local filesystem split into `DiskSurface` +
  `VaultSurface` composed by `LocalFs`.
- It introduces no `BatchObservation` / `IdentityComponent` member, so
  `sync-admission-authority-guard.test.mjs` is unaffected; it adds no
  `SyncOrchestrator` field or store writer, so `sync-state-ownership-guard.test.mjs`
  is unaffected.
- It adds one port method (`hasChildren`, replacing the unused `listDir`) and no backend
  module change; local and every remote backend answer `hasChildren` from their own
  authority.

## Fit with the standing invariants

- **Fact-first pipeline.** Observation is unchanged. Admission authorizes the bounded
  candidate set; execution performs the exact effects and re-proves the condition.
  No action is invented by execution.
- **Two durable publication points.** A prune publishes no `SyncRecord` and does not
  touch the checkpoint. It is a fixed consequence of an admitted action, like a
  rename's `content.mode`.
- **Execution order.** The prune pass runs once, after every serial removal and before
  the cycle's checkpoint commit, while the structural permit is held. Deletes and renames
  are already in the structural lane, so no phase/lane rule changes.
- **Crash safety.** A crash after the file effect but before the prune leaves the
  folder (and, because the action never committed, re-plans next cycle as a
  state-only `cleanup`, which carries no prune). This is the accepted v1 boundary; see
  Unresolved decisions.
- **Deletion safety.** Occupancy is proven by an authoritative direct-child read; a
  failed read keeps the directory; hidden and out-of-scope children count as present.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Observe folder occupancy in Observation and let Admission authorize the exact empty chain (full fact-first) | Strictest reading, but it needs a new fact carrier on `BatchObservation`, whose member set is pinned by `sync-admission-authority-guard.test.mjs`, plus a guard/ADR/enforcement update. The condition is cheaply and authoritatively re-checkable at execution, as file endpoints already are. Kept as the upgrade path if the owner wants the stricter cut. |
| An optional `IFileSystem.pruneEmptyAncestors()` owned by the filesystem, mirroring namespace reconciliation (ADR 20260922) | Places the mutation where the namespace lives, but adds a shared-boundary method with contract/harness obligations for every family, for a cleanup with no cache-consistency hazard (the normal `delete` path already updates the derived cache). |
| Make empty folders first-class sync facts (PR #78 / issue #77) | Far larger: Observation entries, Admission folder identity, a new action kind, and a folder record representation, touching three AST guards and withdrawing an accepted ADR. Out of the agreed scope. |
| Prune on both sides | Contradicts the owner's receiver-side-only decision and would delete folders the user emptied on purpose on the device where they work. |
| New state-only `prune_folder` action kind | Grows the closed action-type set for a cleanup, which AGENTS.md and the issue doc both flag as a large structural cost. |
| Prune from `change-detector` / a post-cycle sweep | No execution-phase I/O, no current-fact re-proof, and it would need durable intent to survive a partial cycle. |

<!-- anchor: scope -->
## Scope

**In scope.**

- `src/sync/types.ts` — the optional `pruneEmptyAncestors` protocol on
  `SyncActionBase`, and `ScopeProjection.includes`.
- `src/sync/scope-projection.ts` — populate `includes` from the projection's
  `isIncluded`.
- `src/sync/sync-cycle-planning.ts` — copy `includes` through `captureBatchObservation`.
- `src/sync/identity-component-decision.ts` — attach the scope-filtered, deepest-first
  ancestor chain when a delete or file-rename action is constructed.
- `src/sync/prune-empty-parents.ts` — the cycle-level pass: union the succeeded actions'
  candidate chains by (side, directory), read each directory at most once deepest-first,
  delete only empty ones; best-effort and stateless.
- `src/sync/plan-executor.ts` — call that pass once after all serial removals; no new
  action dispatch branch.
- `src/fs/interface.ts` — replace the unused metadata-rich `listDir` with the occupancy
  query `hasChildren`.
- `src/fs/local/disk-surface.ts` — the disk authority: existence, actual casing,
  occupancy, hidden-path mutation.
- `src/fs/local/vault-surface.ts` — the index authority: indexed mutation and discovery.
- `src/fs/local/index.ts` — `LocalFs` composes the two authorities and owns the authority
  rule, cross-regime parent creation, and cross-regime rename.
- `src/fs/caching/remote-fs.ts` — `hasChildren` from the derived cache.
- Tests: local `hasChildren` hidden-child witness; executor prune witnesses; admission
  chain/scope witnesses; orchestrator end-to-end deleted-last-file and renamed-out
  cases in both directions, plus the negative controls (sibling, ignored sibling,
  hidden sibling, root, out-of-scope ancestor, unknown occupancy).
- Docs: withdraw the "accepted current behavior" note for this narrower case in
  `adr-20260916-gdrive-delta-relists-entered-folders.md`; add
  `docs/adr/adr-20260927-receiver-side-empty-parent-cleanup.md`; update
  `docs/sync-pipeline.md` deletion-safety and `AGENTS.md` project gotchas.

**Out of scope, with reasons.**

- Full empty-folder sync (issue #77 / PR #78) — see Alternatives.
- Any `BatchObservation` / `IdentityComponent` member, any new `SyncActionType`, any
  folder `SyncRecord`, any IndexedDB/schema change.
- Any backend module change; the behaviour is expressed through `IFileSystem`.
- Pruning on the origin side, and pruning of a folder already emptied in a prior
  cycle (`cleanup`).

<!-- anchor: risks -->
## Unresolved decisions

Settled for v1 on 2026-09-27 (recorded in `change.md` Closure Notes and the accepted ADR):
best-effort prune; no prune on state-only `cleanup`; an explicit optional
`ScopeProjection.includes` predicate; full empty-folder sync (issue #77) deferred.

- `resolved-prune-retry — is best-effort prune acceptable?` Execution re-proves
  emptiness but does not persist a failed prune, so a transient local/provider delete
  error leaves the folder until another delete in the same folder. Retrying it
  strictly would require either a state-only prune action or durable intent, both
  currently forbidden. **Recommendation:** accept best-effort in v1 and log at warn.
  Settle by owner decision.
- `resolved-cleanup-prune — should a state-only cleanup prune?` When both sides are
  already absent, the origin is not recorded and the receiver side cannot be named
  without new state. **Recommendation:** no prune on `cleanup` in v1. Settle by owner
  decision; if rejected, a dedicated fact-first carrier is the only invariant-respecting
  route.
- `resolved-scope-predicate — `ScopeProjection.includes` vs reusing
  `isConfiguredScopeCompatible(path, path)`.` The latter already returns `isIncluded(path)`
  for a self-pair but its documented meaning is rename compatibility. **Recommendation:**
  add the explicit predicate. Settle at implementation.
- `resolved-vs-full-empty-folders — does this supersede or defer PR #78?` This change
  removes the accumulation the reporter of #77 complained about without first-class
  empty folders. **Recommendation:** land this first; revisit #77 as a separate
  accepted ADR. Settle by owner decision.

## Verification plan

- **Unit — local fs:** `LocalFs.hasChildren("notes")` is true when the folder's only
  child is hidden; a folder reads empty only when the disk authority says so.
- **Unit — admission:** a `delete_local` on `notes/a.md` with `notes` in scope carries
  `pruneEmptyAncestors`; an ancestor excluded by ignore/dot-path/reserved carries
  neither it nor its descendants; a folder rename carries nothing.
- **Unit — executor:** after `delete_remote`, an empty remote folder is deleted and a
  folder with any child is not; a provider/disk error is logged and does not fail the
  action; a two-level empty chain prunes deepest-first and stops at the root.
- **Integration — orchestrator:** remote deletes the last file of `notes/` → local
  `notes/` is gone, remote `notes/` stays; local deletes the last file → remote
  `notes/` is gone, local `notes/` stays; rename out of a folder prunes the source on
  the receiving side only; a hidden/ignored sibling prevents the prune.
- **Regression:** the two AST guards stay green unmodified;
  `npm run lint && npm run lint:bot-repro && npm run build && npm run test:coverage`.
- **Opt-in e2e:** on one remote backend, delete the last file of a folder from the
  cloud and confirm the local empty folder is removed after a real sync.
