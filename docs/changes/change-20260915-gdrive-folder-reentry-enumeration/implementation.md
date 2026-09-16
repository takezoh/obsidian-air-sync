---
change: change-20260915-gdrive-folder-reentry-enumeration
role: implementation
contracts:
- contract-entered-folder-recording
- contract-gdrive-entered-folder-relisting
- contract-scope-entry-shared-case
- contract-gdrive-live-scope-entry-e2e
contract_projections:
- id: contract-entered-folder-recording
  verifications:
  - v-gd-unit
  - v-build
  discretion: []
- id: contract-gdrive-entered-folder-relisting
  verifications:
  - v-gd-unit
  - v-guards
  - v-build
  - v-lint
  discretion:
  - discretion-relist-helper-shape
- id: contract-scope-entry-shared-case
  verifications:
  - v-shared-contract
  - v-build
  discretion:
  - discretion-scope-entry-seam-shape
- id: contract-gdrive-live-scope-entry-e2e
  verifications:
  - v-e2e-typecheck
  - v-gd-live
  discretion:
  - discretion-live-poll-bounds
adrs:
- adr-20260916-gdrive-delta-relists-entered-folders
decision_dispositions:
- decision_input_ref: decision-input-scope-googledrive-only
  disposition: 'adopted: production fix and new I/O are Google Drive only; live-probe-onedrive
    shows OneDrive already complete (ADR decision 5).'
  adr_refs:
  - adr-20260916-gdrive-delta-relists-entered-folders
  contract_refs:
  - contract-gdrive-entered-folder-relisting
  - contract-scope-entry-shared-case
- decision_input_ref: decision-input-shared-seam-vs-gdrive-local
  disposition: 'rejected: leaving id-delta.ts untouched forces page-start or drain-start
    sampling, which loses a folder evicted within the page by its ancestor''s tombstone;
    its Google-Drive-only I/O half is carried by decision-input-shared-seam-placement.'
  adr_refs:
  - adr-20260916-gdrive-delta-relists-entered-folders
  contract_refs:
  - contract-entered-folder-recording
- decision_input_ref: decision-input-shared-seam-placement
  disposition: 'adopted (modified): apply-time recording of stable ids in the shared
    seam, I/O only in Google Drive; the future-third-backend rationale is replaced
    by apply-time exactness.'
  adr_refs:
  - adr-20260916-gdrive-delta-relists-entered-folders
  contract_refs:
  - contract-entered-folder-recording
  - contract-gdrive-entered-folder-relisting
- decision_input_ref: decision-input-subtree-merge-algorithm
  disposition: 'rejected: re-feeding the parent-first listAllFiles result through
    applyIdDeltaPage is order-safe (stable sort, depth-1 tie, cached parents resolve
    by id, unknown parents dropped), so a new AbstractMetadataCache resolver prevents
    no failure.'
  adr_refs:
  - adr-20260916-gdrive-delta-relists-entered-folders
  contract_refs:
  - contract-gdrive-entered-folder-relisting
- decision_input_ref: decision-input-reuse-list-all
  disposition: 'adopted: GoogleDriveClient.listAllFiles is reused unchanged, called
    sequentially per topmost target with no added retry layer.'
  adr_refs:
  - adr-20260916-gdrive-delta-relists-entered-folders
  contract_refs:
  - contract-gdrive-entered-folder-relisting
- decision_input_ref: decision-input-folder-scope-entry-contract-shape
  disposition: 'rejected: a Google-Drive-and-OneDrive-only module would opt Dropbox
    out of a normative shared case; the case lives in runCachingRemoteFsContract for
    all registered families.'
  adr_refs:
  - adr-20260916-gdrive-delta-relists-entered-folders
  contract_refs:
  - contract-scope-entry-shared-case
- decision_input_ref: decision-input-harness-fidelity-asymmetric-fakes
  disposition: 'adopted (extended): each family''s harness emits its live-recorded
    delta shape and the Google Drive listAllFiles stub is scoped to the requested
    folder; all three shapes are now grounded in recorded probes (live-probe-googledrive,
    live-probe-onedrive, live-probe-dropbox).'
  contract_refs:
  - contract-scope-entry-shared-case
- decision_input_ref: decision-input-adr-home-choice
  disposition: 'adopted: a standalone ADR, because ADR 0006 reorders a complete delta
    while this decision recovers entries the provider never sends.'
  adr_refs:
  - adr-20260916-gdrive-delta-relists-entered-folders
- decision_input_ref: decision-input-adr-home
  disposition: subsumed into decision-input-adr-home-choice (same question and same
    standalone outcome).
  adr_refs:
  - adr-20260916-gdrive-delta-relists-entered-folders
- decision_input_ref: decision-input-verification-tiers
  disposition: 'adopted: unit witnesses and the shared contract case in the enforced
    gate (T1), the live Google Drive e2e opt-in (T2), static and type checks (T0);
    no probe tier remains in the change, because all three provider shapes are already
    recorded.'
  contract_refs:
  - contract-entered-folder-recording
  - contract-gdrive-entered-folder-relisting
  - contract-scope-entry-shared-case
  - contract-gdrive-live-scope-entry-e2e
- decision_input_ref: decision-input-empty-folder-nongoal
  disposition: 'adopted: recorded as a non-goal in change.md and the requirements
    member per the user decision; change-detector.ts is untouched and no issue is
    filed.'
- decision_input_ref: decision-input-empty-folder-followup
  disposition: subsumed into decision-input-empty-folder-nongoal (no follow-up issue).
- decision_input_ref: decision-input-repro-test-deleted
  disposition: 'adopted: the deleted file is never referenced as existing; RED-first
    witnesses in src/fs/googledrive/incremental-sync.test.ts replace it and add the
    never-tracked variant.'
  contract_refs:
  - contract-gdrive-entered-folder-relisting
- decision_input_ref: decision-input-dropbox-scope-entry-shape
  disposition: 'adopted: closed by live evidence rather than by a planned probe. live-probe-dropbox
    (2026-09-16) recorded a determinate complete scope-entry delta, so the Dropbox
    fake emits the folder with every pre-existing descendant, exactly as the OneDrive
    fake is grounded; no probe unit, evidence gate or escalation branch remains in
    the change.'
  adr_refs:
  - adr-20260916-gdrive-delta-relists-entered-folders
  contract_refs:
  - contract-scope-entry-shared-case
milestones: []
reference_algorithms: []
---

<!-- lifecycle is owned by change.md -->

# Implementation

Governing decision: `adr-20260916-gdrive-delta-relists-entered-folders` (accepted 2026-09-16).

## Order

| Unit | Contracts | Files | Depends on |
|---|---|---|---|
| 1. Record entered folders and re-list them in Google Drive delta application | entered-folder recording; Google Drive entered-folder re-listing | `src/fs/caching/id-delta.ts`, `src/fs/googledrive/incremental-sync.ts`, `src/fs/googledrive/incremental-sync.test.ts`, `src/fs/googledrive/list-all.ts` (doc comment), `docs/google-drive-backend.md` | — |
| 2. Add the scope-entry case to the shared caching contract for all families | shared scope-entry case | `tests/fs/contracts/caching-remote-fs.contract.ts`, the Google Drive, OneDrive, and Dropbox `caching-remote-fs.contract-harness.ts` files, and `src/fs/caching/remote-fs.contract.test.ts` (the fourth harness implementer, found during unit 2) | 1 |
| 3. Add the Google Drive live scope-entry e2e case | Google Drive live scope-entry e2e | `e2e/googledrive.e2e.ts`, `docs/e2e-testing.md` | 1 |

## Contract: entered-folder recording (`src/fs/caching/id-delta.ts`)

- `IdDeltaResult` gains `enteredFolderIds: Set<string>`, and `createIdDeltaResult()`
  initializes it to an empty set.
- In `applyEntry`, place the new check immediately after the existing `if (!newPath) return;`.
  Add `entry.id` when `!oldPath && entry.isFolder`.
  - Tombstones never record.
  - `FileChangeResult.wasFolder` is never consulted. It describes the old path and is
    `false` whenever `oldPath` is undefined.
- Leave these unchanged: the sort comparator, the tombstone branch, the moved-outside branch,
  and the `moved` branch.
- The module stays synchronous, with type-only imports and no I/O. OneDrive computes the set
  and never reads it.

## Contract: Google Drive entered-folder re-listing (`src/fs/googledrive/incremental-sync.ts`)

The new step runs once per call, after the page loop exits through `if (!pageToken) break;`.
It runs inside the existing `try` and before the log and the return.

1. **Snapshot.** Copy `[...acc.enteredFolderIds]` in insertion order. Ids that later merges
   add are never read.
2. **Current paths.** For each id, look up `path = ctx.cache.getPathById(id)`. Drop ids whose
   path is `undefined`: that folder left scope or was tombstoned later in the drain.
3. **Topmost filter.** Drop a target whose path `p` has another target path `q` with
   `p.startsWith(q + "/")`. Never use a raw prefix test.
4. **List.** Process targets in first-entered order, strictly one at a time:
   `const files = await ctx.client.listAllFiles(id)`, then
   `applyIdDeltaPage(ctx.cache, acc, files.map(toListedEntry))`. The private mapper returns
   `{ id: f.id, isFolder: f.mimeType === FOLDER_MIME, file: f }`.
   - Do not add `Promise.all`.
   - Add no retry: `list-all.ts`'s bounded per-page retry is the only retry layer.
   - Do not recompute the targets between listings.
5. **Merge.** The merge only upserts. Absence from a listing never removes an entry.
   - Re-feeding is order-safe. `list-all.ts` pushes a parent before its descendants. Uncached
     folders tie at depth 1 in the stable sort. A cached parent resolves by id. An entry with
     an unknown parent is dropped by `applyFileChange`.
   - A descendant already cached at another path yields a rename pair.
6. **Result.** The return shape is unchanged. `acc.count` now includes merged entries, which
   affects only the log.
7. **Failure.** A rejected `listAllFiles` propagates through the existing `catch`, and no
   later target is listed. HTTP 410 keeps the existing full-scan fallback.
   `CachingRemoteFs._applyIncrementalChanges` therefore never advances the cursor.
   `runSyncCycleAttempt` aborts the working view and does not commit.
8. **Documentation.** Update the doc comment at `list-all.ts:15-16` and
   `docs/google-drive-backend.md` (the Cache invalidation and Full-scan listing concurrency
   sections). Both must describe this single scoped use of `listAllFiles` on the incremental
   path.

Implementation discretion is limited to two private choices: inline loop versus a private
helper, and the mapper's name. Escalate if the change needs an export, a new module, another
`id-delta.ts` change, or behavior that any unit witness can observe.

## Contract: shared scope-entry case (test infrastructure)

- **Harness interface.** `CachingRemoteFsHarness<TFile>` gains two required members. Their
  names are discretionary. Every implementer of the interface implements both.
  - **Implementers (corrected during unit 2).** The design counted three: the Google Drive,
    OneDrive, and Dropbox harnesses under `tests/fs/`. The repository has a fourth,
    `src/fs/caching/remote-fs.contract.test.ts`, which builds a `MockRemoteFs` harness and
    calls `runCachingRemoteFsContract` directly rather than through the composition root.
    Widening a required member breaks its build, so it implements both members too. Its
    staged shape is the complete one (folder then every descendant): the mock has no
    provider to probe, and the complete shape is what the base machinery must serve without
    a backend's re-listing. It remains test infrastructure; no production file changed.
  - **Seed outside.** Before any checkpoint, create a folder outside the bound root that
    contains `a.md` and `sub/b.md`. The full root listing and every later delta must not see
    it.
  - **Stage move-in.** Move that folder under the root under the same name. The next delta
    reports the move in the provider's recorded shape.
- **Provider shapes.** Each comes from that provider's live probe of 2026-09-16, all three
  run with the same method (create the folder with `a` and `sub/b` outside the bound root
  before any cursor; move it in, out, and back in; drain the delta from a cursor captured
  before each move; compare the Air Sync view with a COLD control).
  - **Google Drive.** One change, for the folder only. The harness `listAllFiles(folderId)`
    returns only the descendants of `folderId`, parents first, without the folder itself. It
    replaces the stub that ignores `folderId`.
  - **OneDrive.** Delta items for the folder, `a.md`, `sub`, and `sub/b.md`, in that order.
  - **Dropbox.** The same complete shape: one `list_folder/continue` window carrying the
    folder, `a.md`, `sub`, and `sub/b.md`. The probe recorded this on both the first move-in
    and the move back in, with the Air Sync view equal to the COLD control.
- **Registration.** The case lives in `runCachingRemoteFsContract`.
  `tests/fs/remote-backend-contracts.test.ts` is unchanged. Do not add a separate module, a
  family filter, a skip, an optional member, or a family-conditional assertion.
- **Case steps.**
  1. Before the move, the root holds `keep.md` and none of the seeded paths. Commit.
  2. After the move, `modified` is exactly `[F, F/a.md, F/sub, F/sub/b.md]`. `deleted` and
     `renamed` are empty, and `stat("F/sub/b.md")` returns an entry.
  3. After `abortWorkingView()`, a second `getChangedPaths()` returns the same `modified` set.

## Contract: Google Drive live scope-entry e2e

The case lives in the credentialed branch of `e2e/googledrive.e2e.ts`.

1. **Setup.** Create a root folder and an outside folder with `makeGoogleDriveChild`. Put `F`
   in the outside folder, with `a.md` and `sub/b.md`. Build `GoogleDriveFs` with a real
   `MetadataStore`, call `list()`, then commit.
2. **First move-in.** Move `F` into the root with `updateFileMetadata(id, {}, add, remove)`.
   Poll `getChangedPaths()` until a result's `modified` contains `F`. That same result must
   contain all four paths. Commit.
3. **Move-out.** Move `F` back out. Poll until `deleted` contains `F`. That result must contain
   all four paths. Commit.
4. **Re-entry.** Move `F` back in. Poll until `modified` contains `F`. That result must
   contain all four paths, and `stat("F/sub/b.md")` must return an entry.

If the poll bound runs out, the test fails with a message about propagation. It never skips.
Add a Notes bullet to `docs/e2e-testing.md`. The poll bound and interval are private
discretion. Escalate if propagation routinely exceeds about 60 seconds.

## Test seams

| Seam | Use |
|---|---|
| Real `GoogleDriveMetadataCache("root")` with a client mock providing `listChanges` and `listAllFiles` | Unit witnesses for the recording rule and the re-listing rule. Existing mocked-cache cases stay unchanged. |
| `CachingRemoteFsHarness` typed-client fakes | The shared case over the real `GoogleDriveFs`, `OneDriveFs`, and `DropboxFs`. |
| Real `GoogleDriveClient` in opt-in e2e | Live delta shape backstop (ADR 0003). |

## Boundaries

The following must not change:

- `AbstractMetadataCache`
- `CachingRemoteFs`
- the `applyIdDeltaPage` sort and existing branches
- `list-all.ts` behavior
- `src/fs/onedrive/**`
- `src/fs/dropbox/**`
- `tests/fs/remote-backend-contracts.test.ts`
- ownership-guard fixtures
- persisted schema
