# Design — Google Drive re-lists folders that newly enter the bound root

Plan revision: `r3` (minimality rework of `r2`). Change:
`change-20260915-gdrive-folder-reentry-enumeration`.
ADR: `docs/adr/adr-20260916-gdrive-delta-relists-entered-folders.md` (accepted 2026-09-16).

<!-- anchor: goal -->
## Goal

Google Drive's `changes.list` reports one change for each changed item. Moving a folder
reports only the folder; its unchanged descendants produce no change. `applyEntry()`
(`src/fs/caching/id-delta.ts:64-102`) walks descendants only in its `moved` branch, which
requires the folder to be cached already. A folder whose id has no cached path therefore
enters the cache alone. This covers four cases:

- the folder was never tracked;
- it was evicted when it left the root;
- it was trashed and then restored;
- its ancestor chain entered scope.

Its pre-existing descendants never reach the cache, `getChangedPaths()`, or the vault until
a COLD scan. `live-probe-googledrive` (2026-09-16) confirmed this. After a move-out and
move-back-in, the incremental view held only `F` while a COLD scan held four items. The
first move-in also dropped `F/sub` and `F/sub/b.txt`.

Outcome: in the same attempt that applies the folder's change, Google Drive reports the
folder's complete current subtree as present facts, as far as the grant can list. No
durable state is added, steady-state deltas issue no request, and OneDrive and Dropbox
production code is unchanged. RB-CHK-003 already requires this result.

<!-- anchor: scope -->
## Scope

**In scope.**

- `src/fs/caching/id-delta.ts`: at apply time, record the folder ids that gained a cached path.
- `src/fs/googledrive/incremental-sync.ts`: after the changes drain, list each topmost
  entered folder once, sequentially, and merge the result through `applyIdDeltaPage`.
- Documentation that currently claims `listAllFiles` never runs on the delta path:
  `src/fs/googledrive/list-all.ts:15-16` and `docs/google-drive-backend.md:115`.
  The e2e notes in `docs/e2e-testing.md` also change.
- Verification:
  - Google Drive unit witnesses.
  - One scope-entry case in the shared `runCachingRemoteFsContract`, run by all three
    registered families over fakes whose delta shapes are taken from the three recorded live
    probes (`live-probe-googledrive`, `live-probe-onedrive`, `live-probe-dropbox`).
  - One opt-in live Google Drive e2e case.
- One proposed ADR.

**Non-goals.**

- Production change or new I/O for OneDrive or Dropbox (FR-5).
- The empty local folder left after a folder moves out. `change-detector.ts` filters
  directories, and the user decided this is current behavior with no follow-up issue.
- Changes to RB-CHK-003 wording, the qualification worksheet, `AbstractMetadataCache`, or
  `CachingRemoteFs`.
- Any new persisted field, cursor, evidence, retained set, recovery marker, or guard
  fixture edit.
- The `drive.file` visibility limitation (issue #79).
- Restoring the deleted reproduction test `src/fs/googledrive/folder-reentry-delta.test.ts`.
  It is historical evidence only.

<!-- anchor: approach -->
## Approach

1. **Exact detection.** `applyEntry` records `entry.id` into a per-call
   `IdDeltaResult.enteredFolderIds` when the folder's old cached path is `undefined` and the
   new path resolves. The shared seam gains no I/O. OneDrive computes the set and never reads it.
2. **Google Drive completion.** After the full drain, `applyIncrementalChanges` builds the
   target list from that set:
   - it uses each id's *current* path;
   - it drops ids that left scope;
   - it drops targets nested under another target (`/`-delimited);
   - it lists each remaining target with `listAllFiles(id)`, one at a time.
3. **Merge by re-feed.** Each listing, mapped to `IdDeltaEntry`, goes through the existing
   `applyIdDeltaPage`. That call already orders parents first, accounts for moves, and drops
   unknown parents fail-closed.
4. **Failure.** The listing sits inside the existing `try`, so a rejection aborts the
   attempt through the existing closeout.
5. **Verification.**
   - All three families run one shared scope-entry case. Each harness emits the delta shape
     its own live probe recorded. All three probes are already recorded, so the case needs no
     evidence-gathering step of its own.
   - Google Drive also runs a live e2e case.

<!-- anchor: fr-1 -->
### FR-1 — entered folder brings its subtree (event-driven)

WHEN Google Drive incremental delta application applies a folder change whose stable id has
no cached path immediately before that change is applied, and that folder still resolves
inside the bound root when the changes drain ends, the Google Drive filesystem SHALL include,
in the same `getChangedPaths()` or `list()` working view, that folder and every descendant the
configured OAuth grant lists under it. Each descendant is reported as `modified`, or as a
`renamed` pair when its id was cached at another path.

This covers never-tracked, evicted-then-reentered, trash-restored, and ancestor-chain entry.
Under `drive.file`, the app-visible subset is the complete fact and is not an error.

<!-- anchor: fr-2 -->
### FR-2 — nested entered folders are listed once (unwanted behavior)

IF more than one folder satisfies FR-1 in one changes drain, and one folder's post-drain path
is a `/`-delimited descendant of another's, THEN the Google Drive filesystem SHALL list only
the topmost folder. A folder whose name merely extends another folder's name (`Notes`,
`Notes2`) SHALL still be listed.

<!-- anchor: fr-3 -->
### FR-3 — no listing without an entered folder (event-driven)

WHEN a Google Drive changes drain contains no folder that satisfies FR-1, including a rename
or move of an already-cached folder, the Google Drive filesystem SHALL issue no subtree
listing request.

<!-- anchor: fr-4 -->
### FR-4 — listing failure aborts the attempt (unwanted behavior)

IF a subtree listing for FR-1 fails after the listing's own bounded retries, THEN
`getChangedPaths()` and `list()` SHALL reject with that error. The durable checkpoint SHALL
remain unchanged, and the next attempt SHALL list the same folders again from the committed
window. An HTTP 410 takes the existing full-scan fallback.

<!-- anchor: fr-5 -->
### FR-5 — natively complete backends stay unchanged (event-driven)

WHEN a folder with pre-existing descendants moves into the bound root on OneDrive or Dropbox,
the existing delta application SHALL report the folder and every descendant in the same
result. It SHALL do so without a production code change and without any request beyond its
ordinary delta pages.

<!-- anchor: nfr-1 -->
### NFR-1 — bounded listing cost (performance)

Within one Google Drive changes drain, subtree listings SHALL run sequentially, with at most
one `listAllFiles` walk in flight. Their count SHALL NOT exceed the number of topmost folders
that satisfy FR-1. No retry layer is added around `listAllFiles`.

<!-- anchor: nfr-2 -->
### NFR-2 — no new state owner (ubiquitous invariant)

The system SHALL keep the entered-folder set and the listing targets only within one delta
application call. It SHALL persist no new field, cursor, evidence, or recovery marker. It
SHALL never remove, tombstone, or re-key a cached entry because that entry is absent from a
subtree listing. It SHALL keep `sync-state-ownership-guard.test.mjs` and
`sync-admission-authority-guard.test.mjs` green without fixture edits.

<!-- anchor: component-id-delta-seam -->
## Component: id-addressed delta seam

- **Paths:** `src/fs/caching/id-delta.ts`. Existing; modified by one field and one condition.
- **Responsibility:** apply a normalized id-keyed page to an `AbstractMetadataCache` and
  accumulate the touched paths. This change adds the entered-folder fact.
- **Repository grounding:**
  - Called by `src/fs/googledrive/incremental-sync.ts:54` and
    `src/fs/onedrive/incremental-sync.ts:44`. Dropbox does not call it.
  - Sort comparator: lines 48-60. An uncached id compares as `"".split("/").length === 1`.
  - `applyEntry`: lines 64-102.
  - No standalone test file exists. Coverage comes through each backend's
    `incremental-sync.test.ts`.
- **Accepted decisions:** ADR 0001 (attempt-bounded view), ADR 0006 (order independence of
  this seam).
- **Contracts:** `contract-entered-folder-recording`.

<!-- anchor: component-gdrive-incremental-sync -->
## Component: Google Drive incremental sync

- **Paths:** `src/fs/googledrive/incremental-sync.ts`,
  `src/fs/googledrive/incremental-sync.test.ts`, `src/fs/googledrive/list-all.ts` (doc
  comment only), `docs/google-drive-backend.md`. Existing.
- **Responsibility:** drain `changes.list`, map changes to `IdDeltaEntry`, and apply each
  page. It now also completes entered folders' subtrees before returning.
- **Repository grounding:**
  - `applyIncrementalChanges`: lines 29-77. It has one `try` whose `catch` maps HTTP 410 to
    `needsFullScan` and rethrows everything else.
  - `GoogleDriveClient.listAllFiles(folderId)` (`client.ts:176-179`) delegates to
    `list-all.ts:26-96`. That walk accepts any folder id and uses an `AdaptivePool` (start
    3, max 8) with `MAX_LIST_RETRIES = 3` per page.
  - The per-folder query is `'<id>' in parents and trashed = false`, with fields that
    include `parents` and `mimeType`.
  - `GoogleDriveFs.fetchChanges` (`index.ts:56-61`) runs under
    `CachingRemoteFs.cacheMutex` through `_applyIncrementalChanges` (`remote-fs.ts:363-389`).
    That function classifies `changedPaths` into `modified`/`deleted` with `cache.hasFile`.
  - Two documentation surfaces must change: `docs/google-drive-backend.md:115` and
    `list-all.ts:15-16` both state that `listAllFiles` is never on the hot/warm delta path.
- **Test seam:** new cases use a real `GoogleDriveMetadataCache("root")` with a client mock
  that provides `listChanges` and `listAllFiles`. Existing mocked-cache cases stay unchanged.
- **Accepted decisions:** ADR 0001, `adr-20260903-stateless-current-state-recovery`.
- **Contracts:** `contract-gdrive-entered-folder-relisting`.

<!-- anchor: component-caching-contract-harnesses -->
## Component: shared caching contract and backend harnesses

- **Paths:** `tests/fs/contracts/caching-remote-fs.contract.ts`, the three backend harnesses
  in `tests/fs/{googledrive,onedrive,dropbox}/caching-remote-fs.contract-harness.ts`, and
  `src/fs/caching/remote-fs.contract.test.ts`. Existing.
  - **Correction (found during unit 2).** This plan counted three implementers of the
    harness interface. There is a fourth: `src/fs/caching/remote-fs.contract.test.ts` builds
    a `MockRemoteFs` harness and calls `runCachingRemoteFsContract` directly instead of
    registering through the composition root, so a required member must be implemented there
    too or the build breaks. It is test infrastructure; no production file is affected. See
    the implementation member for its staged shape and the reason.
- **Responsibility:** run the ADR 0001 crash-safety and ADR 0006 rename cases against the
  real `GoogleDriveFs`, `OneDriveFs`, and `DropboxFs` over in-memory typed-client fakes.
- **Repository grounding:**
  - The three backend harnesses implement `CachingRemoteFsHarness<TFile>` (lines 10-31) and
    are registered through `tests/fs/remote-backend-contracts.test.ts:23-48`; the mock
    harness in `src/fs/caching/remote-fs.contract.test.ts` implements the same interface and
    self-registers.
  - ADR 0006 set the precedent: `stageRemoteRename` was added to every harness, with a
    per-provider delta shape.
  - The Google Drive stub `listAllFiles: () => Promise.resolve([...baseline.values()])`
    (line 27) ignores `folderId`.
  - The OneDrive `fullList` and Dropbox `listFolderAll` stubs return their whole baselines.
- **Normative constraints:**
  - The remote backend contract's Conformance 3 forbids a fake more generous than the real
    API, and forbids opting out of a failing shared case.
  - Its Failure Responsibility section states that a provider limitation "is not a reason
    to opt out of a shared contract case".
- **Contracts:** `contract-scope-entry-shared-case`.

<!-- anchor: component-gdrive-live-e2e -->
## Component: Google Drive live e2e

- **Paths:** `e2e/googledrive.e2e.ts`, `docs/e2e-testing.md`. Existing.
- **Responsibility:** credentials-gated live checks of `GoogleDriveFs` (ADR 0003). The file
  skips as a whole when credentials are absent.
- **Repository grounding:**
  - The file creates one per-run parent (`makeGoogleDriveParent`) and fresh children
    (`makeGoogleDriveChild`).
  - `client.updateFileMetadata(id, metadata, addParents, removeParents)` moves an item.
  - `npm run test:e2e:google` runs `typecheck:e2e` first.
- **Contracts:** `contract-gdrive-live-scope-entry-e2e`.

<!-- anchor: contract-entered-folder-recording -->
## Contract: entered-folder recording

**Subject:** the fact that a folder id gained a cached path during one delta application.
**Owner:** `component-id-delta-seam`. **Requirements:** FR-1, FR-3, NFR-2.
**Unit:** "Record entered folders and re-list them in Google Drive delta application".
**ADR:** `adr-20260916-gdrive-delta-relists-entered-folders`.

**Decision rule `rule-record-entered-folder`.**

- Evidence mode: total.
- Inputs: `oldPath` and `newPath` returned by `applyFileChangeDetectMove(entry.file)`, and
  `entry.isFolder`.
- Epistemic state: determinate. Both paths come from the same in-memory cache,
  synchronously, around this entry's own mutation.
- Outcome:
  - `IdDeltaResult` gains `enteredFolderIds: Set<string>`. `createIdDeltaResult()`
    initializes it empty.
  - Immediately after the existing `if (!newPath) return;`, `applyEntry` adds `entry.id`
    when `!oldPath && entry.isFolder`.
  - The rule never consults `FileChangeResult.wasFolder`. That field describes the old path
    and is always `false` when `oldPath` is undefined.
  - Tombstones never record.
  - A Set makes enter, leave, re-enter within one drain a single element, in first-entry
    order.
- Observable: `observable-entered-folder-set`.

**Outcome partition.** For a non-tombstone folder entry, the pair (`oldPath`, `newPath`)
selects exactly one existing branch:

| `oldPath` | `newPath` | Result |
|---|---|---|
| undefined | undefined | Unresolvable. Nothing is recorded (existing early return). |
| defined | undefined | Moved outside. Existing deletion facts. |
| undefined | defined | **Entered. Recorded.** |
| defined | same as `oldPath` | Unchanged. |
| defined | different from `oldPath` | Moved. Existing rename facts. |

The cases are exhaustive and mutually exclusive by construction.

**Observable `observable-entered-folder-set`.** Scope: one accumulator created by one backend
delta application call. After the call's pages are applied, the set holds exactly the ids of
folders that entered during those pages.

**Operational inputs:** none. Closure reason: the rule reads only the cache owned by the same
call and makes no provider request.

**Invariants.**

- `id-delta.ts` stays synchronous, keeps type-only imports, and performs no I/O.
- The sort comparator, tombstone branch, moved-outside branch, and `moved` branch are unchanged.
- The set is never persisted, never copied into `IncrementalChangesResult`, and never read by
  `CachingRemoteFs` or OneDrive.

**Failure semantics:** none new. The rule is a pure in-memory predicate over values produced
in the same call.

**Witnesses.** All use verification `v-gd-unit`, through contract-level observation of
`listAllFiles` calls.

- `witness-recording-never-tracked`
  - Normal. FR-1.
  - Setup: the cache holds root file `keep.md`. A page contains uncached folder `F` whose
    parent is root.
  - Expected: `F` is recorded, so `listAllFiles("F")` is called once.
  - Forbidden: no call.
- `witness-recording-evicted-within-page`
  - Adversarial; risk: ordering, stale. FR-1.
  - Setup: the cache holds `A`, `A/F`, and `A/F/x`. One page contains a trash tombstone for
    `A` and `F` re-parented to root.
  - Mechanism: the depth sort applies `A` (depth 1) before `F` (cached depth 2).
    `removeTree(A)` evicts `F`, so `F` applies with `oldPath` undefined.
  - Expected: `F` is recorded, and after listing, `F/x` is present.
  - Forbidden: `F/x` missing. That is the result of any page-start or drain-start `hasId`
    sampling.
- `witness-recording-tracked-rename`
  - Adversarial; risk: regression. FR-3.
  - Setup: the cache holds folder `D` with a child. `D` is renamed `E`.
  - Expected: nothing recorded, zero listing calls, and the existing rename pair.
  - Forbidden: any listing call.

**Verification.**

- `v-gd-unit` (T1): `npx vitest run src/fs/googledrive/incremental-sync.test.ts`.
- `v-build` (T0): `npm run build`.

**Implementation discretion:** none. The field name, type, and placement are fixed.

**Open design choices:** none.

<!-- anchor: contract-gdrive-entered-folder-relisting -->
## Contract: Google Drive entered-folder re-listing

**Subject:** Google Drive's delta facts for folders that entered during one changes drain.
**Owner:** `component-gdrive-incremental-sync`.
**Requirements:** FR-1, FR-2, FR-3, FR-4, NFR-1, NFR-2.
**Unit:** "Record entered folders and re-list them in Google Drive delta application".
**ADR:** `adr-20260916-gdrive-delta-relists-entered-folders`.

**Decision rule `rule-relist-targets`.**

- Evidence mode: total.
- Inputs: `acc.enteredFolderIds` after the page loop, and `ctx.cache.getPathById`.
- Epistemic state: determinate.
- Outcome:
  1. The rule runs once per `applyIncrementalChanges` call. It starts after the page loop
     exits through `if (!pageToken) break;`, inside the existing `try`, and before the
     `Incremental changes applied` log and the return. It never runs per page.
  2. Snapshot `[...acc.enteredFolderIds]` in insertion order. Ids added to the set during
     later merges are never read.
  3. For each id, `path = ctx.cache.getPathById(id)`. Drop ids whose path is `undefined`: the
     folder left scope or was tombstoned later in the drain, so its descendants are out of
     scope too.
  4. Drop a target whose path `p` has another target path `q` with `p.startsWith(q + "/")`.
     A raw `startsWith(q)` test is forbidden.
  5. The remaining targets, in first-entered order, are the listing targets. They are
     computed once and never recomputed between listings.
- Observable: `observable-listing-calls`.

**Decision rule `rule-relist-execute`.**

- Evidence mode: total. Input: `input-gdrive-subtree-listing`.
- Outcome:
  1. For each target in order, call `const files = await ctx.client.listAllFiles(id)`.
  2. Then call `applyIdDeltaPage(ctx.cache, acc, files.map(toListedEntry))`. The private
     mapper returns `{ id: f.id, isFolder: f.mimeType === FOLDER_MIME, file: f }`.
  3. The next listing starts only after the previous merge returns.
  4. No other request type, no `Promise.all`, and no retry around `listAllFiles`.
     `list-all.ts`'s bounded per-page retry is the only retry layer (RB-PROV-005).
  5. The merge is upsert-only.
  6. The return shape stays the same: `{ newToken: currentToken, needsFullScan: false,
     changedPaths: acc.changedPaths, renamedPaths: acc.renamedPaths }`.
     `acc.count` includes the merged entries; that value is used only for logging.
- Observable: `observable-entered-subtree-facts`.

**Why re-feeding is order-safe.** This is evidence, not a new mechanism:

- `list-all.ts:67-69` pushes each listed item before enqueueing its folder, so every
  descendant follows its ancestor in the result.
- `applyIdDeltaPage` sorts every folder before every file. Uncached folders all compare at
  depth 1. ES2019 `Array.prototype.sort` is stable, so uncached folders apply in listing
  order: parent first.
- An already-cached folder resolves through `idToPath` wherever it sorts.
- A stray entry with an unknown parent gets `null` from `resolvePathFromCache` and is dropped
  by `applyFileChange` (`metadata-cache.ts:279-285, 395-401`).
- A listed descendant cached at another path takes the existing `moved` branch and yields a
  rename pair.

**Decision rule `rule-relist-failure`.** Evidence mode: fallible, single source. Outcome
partition:

- **determinate:** `listAllFiles` resolves, and the merge proceeds.
- **unknown:** `listAllFiles` rejects. Causes include auth, permission, or notFound errors;
  exhausted rateLimit or transient retries; and the pagination cap.
  - That target is not merged, and no later target is listed.
  - The error leaves `applyIncrementalChanges` through the existing `catch` (`throw err`).
  - `CachingRemoteFs._applyIncrementalChanges` never assigns the new cursor.
    `getChangedPaths()` or `list()` rejects, and `runSyncCycleAttempt` calls
    `abortWorkingView()` instead of `commitCheckpoint()`.
- **Special case:** an error with HTTP status 410 is caught by the existing
  `isHttpError(err, 410)` check and returns `needsFullScan: true`. `fullScanWithDelta`
  then lists the whole root and diffs by id. `files.list` is not expected to return 410.

Default policy: an unknown listing is never treated as empty, partial, or complete. Coverage
basis: every provider request this step makes is `listAllFiles(target)`, so every failure is
either determinate or unknown.

**Observables.**

- `observable-entered-subtree-facts`
  - Scope: one `getChangedPaths()` or `list()` result and its working view.
  - For each target, every listed descendant is in `changedPaths`. It becomes `modified`
    through `cache.hasFile`, or a `renamed` pair when its id was cached elsewhere.
  - `stat()` and `list()` return those descendants.
- `observable-listing-calls`
  - Scope: one `applyIncrementalChanges` call.
  - The ordered ids passed to `listAllFiles` equal the listing targets. The sequence is
    empty when no folder entered. At most one call is in flight.
- `observable-attempt-abort`
  - Scope: one sync attempt and the next attempt.
  - On a listing failure, the rejected attempt commits nothing.
  - The next attempt replays the same committed window, records the same entered folders,
    and calls `listAllFiles` for the same targets.

**Operational input `input-gdrive-subtree-listing`.**

- Owner: `component-gdrive-incremental-sync`.
- Producer: external. Google Drive API `files.list`, called through
  `GoogleDriveClient.listAllFiles` and `list-all.ts`.
- Source: `ctx.client.listAllFiles(targetId)`, on the same authenticated client as
  `listChanges`.
- Data scope: descendants of one target folder that the configured grant can see, excluding
  the folder itself. Trashed items are excluded by the query. Under `drive.file`, only
  app-visible items are included.
- Acquired: after the whole changes drain, while `CachingRemoteFs.cacheMutex` is held. This
  is the same hold as `fetchChanges`; `fullScan` already lists under this mutex.
- Required until: the merge that immediately follows, in the same call.
- Preservation: live working view only. It is committed only through the existing atomic
  cache and cursor commit (ADR 0001).
- Mutable between acquisition and use: yes. The listing is an untrusted current observation
  (RB-INV-001).
- Stability basis: the drain's `newStartPageToken` is captured before any listing. A provider
  change after that token is re-delivered in the next window and applied idempotently by id.
- Invalidation: none within the call; the next cycle re-observes.
- Unavailable: follows `rule-relist-failure`, outcome unknown, and the attempt aborts.

**Semantic profiles.**

- **Outcome partition:** `rule-relist-failure`.
- **Cost convergence.**
  - Per call, the number of listings equals the number of topmost targets, which never
    exceeds the entered folder ids.
  - Zero listings on deltas without an entered folder and on renames of cached folders.
  - Sequential, so at most one `AdaptivePool` (max 8) is active.
  - A replay after abort repeats at most the same targets per attempt. No new retry layer.
- **Scope consistency.** A listing is a subtree snapshot taken after the delta window's
  token. The combined working view never reports an item absent because one source omitted
  it: the merge only upserts, and the token precedes the listing. Items deleted after the
  listing arrive as tombstones in the next window.

**Invariants.**

- No new `try`/`catch`, persisted field, cross-call state, or export. The target list is a
  local variable.
- `applyIdDeltaPage`, `AbstractMetadataCache`, and `CachingRemoteFs` are unchanged.
  `list-all.ts` changes only in its doc comment.
- The step exists only in Google Drive's `applyIncrementalChanges`.

**Typed failure semantics.**

- `failure-relist-rejected`: an external listing failure. The error propagates, the attempt
  aborts, and FR-4 applies. No mandatory outcome is degraded: the vault remains at the last
  committed checkpoint.
- `failure-relist-status-410`: handled by the existing full-scan fallback, which yields
  complete facts.
- Internal contract violations: none new.

**Witnesses.** All use `v-gd-unit`, with a real `GoogleDriveMetadataCache("root")` and mocked
`listChanges` and `listAllFiles`.

- `witness-relist-never-tracked`
  - Normal. FR-1.
  - Setup: `F` enters. The listing returns `a.md(F)`, `sub(F)`, `b.md(sub)`.
  - Expected: `changedPaths` includes F, F/a.md, F/sub, and F/sub/b.md, and all four are
    cached.
  - Forbidden: only `F`.
- `witness-relist-reentry-after-move-out`
  - Adversarial; risk: stale. FR-1.
  - Setup: drain 1 moves tracked `F` (with child `c.md`) out, and it is evicted. Drain 2
    moves `F` back.
  - Expected: `F/c.md` returns in drain 2.
  - Forbidden: only `F`. This is the production defect.
- `witness-relist-evicted-within-page` is shared with the recording contract.
- `witness-relist-child-before-parent`
  - Adversarial; risk: ordering. FR-1.
  - Setup: one page lists uncached folder `S` (parent `F`) before uncached `F`, with equal
    sort depth. `S` is dropped and `F` enters. The listing of `F` includes `S` and `S/b.md`.
  - Expected: `F/S` and `F/S/b.md` are present.
  - Forbidden: `F/S` missing.
- `witness-relist-stale-path`
  - Adversarial; risk: stale. FR-1.
  - Setup: page 1 moves `F` (with children) into cached folder `A`. Page 2 renames `A` to `B`.
  - Expected: `listAllFiles("F")` is called, and `B/F/*` is present.
  - Forbidden: a skip, an `undefined` id lookup, or a thrown error.
- `witness-relist-nested`
  - Adversarial; risk: cost. FR-2, NFR-1.
  - Setup: page 1 enters `F`. Page 2 enters `F/S`. The listing of `F` also returns an
    uncached folder `T`, which is recorded during the merge.
  - Expected: exactly one call, for `F`.
  - Forbidden: a call for `S` or `T`.
- `witness-relist-name-prefix-sibling`
  - Adversarial; risk: boundary. FR-2.
  - Setup: `Notes` and `Notes2` both enter.
  - Expected: two calls, and `Notes2`'s children are present.
  - Forbidden: `Notes2` skipped.
- `witness-relist-left-scope-later`
  - Adversarial; risk: stale. FR-1, NFR-1.
  - Setup: page 1 enters `F`. Page 2 trashes `F`.
  - Expected: zero calls, and `F` is reported deleted.
  - Forbidden: any call.
- `witness-relist-no-entered-folder`
  - Adversarial; risk: regression, cost. FR-3.
  - Setup: a delta with only file upserts, and a rename of a cached folder.
  - Expected: zero calls.
- `witness-relist-failure`
  - Adversarial; risk: failure. FR-4.
  - Setup: two targets. The first `listAllFiles` rejects with `{ status: 403 }`.
  - Expected: `applyIncrementalChanges` rejects with that same error, and the second target
    is never listed.
  - Forbidden: resolving with partial `changedPaths`.
- `witness-relist-sequential`
  - Adversarial; risk: concurrency. NFR-1.
  - Setup: two targets. The first listing is a deferred promise.
  - Expected: the second call does not happen before the first listing resolves and merges.
- `witness-relist-grant-subset`
  - Adversarial; risk: boundary. FR-1, NFR-2.
  - Setup: descendant `D` was cached from its own change earlier in the drain. The listing
    returns a subset that omits `D`.
  - Expected: `D` stays cached and in `changedPaths`, and no retry or extra call happens.
  - Forbidden: `D` removed.
- `witness-relist-descendant-cached-elsewhere`
  - Adversarial; risk: identity. FR-1.
  - Setup: the listing of `F` returns id `c` whose cached path is root `C`.
  - Expected: a rename pair `C` → `F/C`.
  - Forbidden: a duplicate identity, or `C` left stale.

**Verification.**

- `v-gd-unit` (T1): `npx vitest run src/fs/googledrive/incremental-sync.test.ts`. The named
  witnesses above must exist.
  - `witness-relist-never-tracked`, `witness-relist-reentry-after-move-out`,
    `witness-relist-evicted-within-page`, `witness-relist-child-before-parent`, and
    `witness-relist-stale-path` must fail on the unmodified production code before the change.
- `v-build` (T0): `npm run build`.
- `v-lint` (T0): `npm run lint`.
- `v-guards` (T1): `npm run lint:bot-repro`. Both ownership guards must pass with unchanged
  fixtures.

**Implementation discretion `discretion-relist-helper-shape`.**

- Question: inline the loop in `applyIncrementalChanges` or extract a private helper, and what
  to name the private mapper.
- Scope: `src/fs/googledrive/incremental-sync.ts`, private.
- Escalate when:
  - the shape needs an export or a new module;
  - it needs an `id-delta.ts` change beyond `contract-entered-folder-recording`;
  - any witness would observe a difference.

**Open design choices:** none.

<!-- anchor: contract-scope-entry-shared-case -->
## Contract: shared scope-entry case for every caching family

**Subject:** the check that, when a folder with pre-existing descendants enters the bound
root, every registered remote family's real filesystem reports the full subtree. The check
runs over fakes whose delta shape matches a recorded live observation.
**Owner:** `component-caching-contract-harnesses`. **Requirements:** FR-1, FR-5, NFR-2.
**Unit:** "Add the scope-entry case to the shared caching contract for all families".
**ADR:** `adr-20260916-gdrive-delta-relists-entered-folders`.

**Decision rule `rule-shared-case-registration`.**

- Evidence mode: total.
- The case lives inside `runCachingRemoteFsContract`. `registerGoogleDriveCachingContract`,
  `registerOneDriveCachingContract`, and `registerDropboxCachingContract` all run it through
  the unchanged `tests/fs/remote-backend-contracts.test.ts`.
- `CachingRemoteFsHarness<TFile>` gains two required, non-optional members, implemented by
  every implementer of the interface: the three backend harnesses and the mock harness in
  `src/fs/caching/remote-fs.contract.test.ts`. Their names are discretionary.
  - **Seed outside.** Given a folder path, before any checkpoint, create outside the bound
    root a folder with that name containing file `a.md` and folder `sub`, where `sub` holds
    `b.md`. Nothing is visible to the harness's full root listing or to any later delta until
    the move.
  - **Stage move-in.** Move that folder under the bound root with the same name. The next
    delta reports the move in the provider's recorded shape.
- Forbidden: a separate module, family-filtered registration, `it.skip`, an optional member,
  or a family-conditional assertion.

**Decision rule `rule-provider-fake-shape`.**

- Evidence mode: live observation per family.
- **Google Drive** (`live-probe-googledrive`): exactly one change, for the folder (parents set
  to root). Descendants emit nothing.
  - The harness `listAllFiles(folderId)` returns only the live descendants of `folderId`, in
    parent-first order, excluding the folder itself.
  - A root listing therefore excludes outside items. This replaces the stub at line 27.
- **OneDrive** (`live-probe-onedrive`): delta items for the folder and every descendant, in
  the observed order F, F/a.md, F/sub, F/sub/b.md. `fullList` keeps returning only
  bound-root items.
- **Dropbox** (`live-probe-dropbox`): one `list_folder/continue` window carrying the folder
  and every pre-existing descendant, in the observed order F, F/a.md, F/sub, F/sub/b.md.
  `listFolderAll` keeps returning only bound-root items.

Every shape is a recorded observation, so no family's fake is guessed. A family whose shape
were not recorded would need a probe before its member is written; none is outstanding.

**Case steps** (`observable-shared-scope-entry`; scope: one filesystem over one harness):

1. Seed file `keep.md` and seed `F` outside. Build the FS. `list()` contains `keep.md` and
   none of `F`, `F/a.md`, `F/sub`, `F/sub/b.md`, `a.md`, `sub`, `b.md`. Commit the checkpoint.
2. Stage the move-in of `F`. Call `d = await fs.getChangedPaths()`.
   - Sorted `d.modified` equals exactly `["F", "F/a.md", "F/sub", "F/sub/b.md"]`.
   - `d.deleted` equals `[]`, and `d.renamed ?? []` equals `[]`.
   - `stat("F/sub/b.md")` is not null.
3. Call `abortWorkingView()`, then `getChangedPaths()` again. `modified` holds the same set.
   The replay re-derives everything from committed state.

**Operational input `input-provider-scope-entry-shape`.**

- Owner: `component-caching-contract-harnesses`.
- Producer: external. Each provider's live delta API, observed by an opt-in probe.
- Source: `recovery-decisions.json` `live-probe-googledrive`, `live-probe-onedrive`, and
  `live-probe-dropbox`, all dated 2026-09-16 and run with the same method.
- Data scope: one move-in window of a three-descendant folder.
- Acquired: before the corresponding harness member is written. All three are already
  recorded.
- Required until: the case is merged.
- Preservation: the dated live-observation records in `recovery-decisions.json`, cited by
  this contract, the ADR, and the change package's implementation member.
- Mutable between acquisition and use: yes, the provider may change later. ADR 0003's
  opt-in live runs remain the backstop.
- Stability basis: one recorded run per provider, per the recorded method.
- Invalidation: an e2e or probe run that contradicts a recorded shape invalidates that
  harness shape and is fixed in the fake or the backend. The shared case is never relaxed.
- Unavailable: not applicable — no family's shape is outstanding. A future family without a
  recorded shape gets a probe before its member, never a guessed fake.

**Semantic profiles.**

- Scope consistency: the full root listing and the delta must agree on scope. Step 1's
  invisibility assertion and step 2's exact-set assertion bind both sources.

**Invariants.**

- No production file changes: only the four test files are touched, and in particular
  `src/fs/onedrive`, `src/fs/dropbox`, `src/fs/caching/remote-fs.ts`, and
  `src/fs/caching/metadata-cache.ts` stay as they are. OneDrive gains no client method and
  no request beyond its ordinary delta pages.
- `tests/fs/remote-backend-contracts.test.ts` is unchanged.
- Existing cases in the three harnesses stay green with the scoped stubs.

**Typed failure semantics.**

- `failure-shared-case-red`: the case fails for a family.
  - For Google Drive, the implementation is incomplete; U1 must be fixed.
  - For OneDrive or Dropbox, it is a fidelity or backend divergence: the fake disagrees with
    the family's recorded probe, or the backend no longer matches it. Fix the fake or report
    for escalation. Never skip, never opt a family out, and never relax the assertion.

**Witnesses.** All use `v-shared-contract`.

- `witness-shared-gd-folder-only`
  - Normal for Google Drive. FR-1.
  - Expected: the case passes only with U1.
  - RED-first: on unmodified production code, `d.modified` is `["F"]`.
- `witness-shared-gd-stub-fidelity`
  - Adversarial; risk: fake fidelity. FR-1.
  - With the old whole-baseline stub, `buildFromFiles` attaches outside items at root
    (`metadata-cache.ts:315-327`), so step 1 fails. The re-feed would also add `keep.md`,
    so step 2 fails too.
  - Expected: both fail with the old stub and pass with the scoped stub.
- `witness-shared-onedrive-native`
  - Normal. FR-5.
  - Expected: passes with unchanged OneDrive code and zero added client methods.
- `witness-shared-replay`
  - Adversarial; risk: recovery. NFR-2.
  - Expected: step 3 yields the same set.
  - Forbidden: an empty or partial set after abort.
- `witness-shared-dropbox-native`
  - Normal. FR-5.
  - Setup: the Dropbox stage emits the shape `live-probe-dropbox` recorded.
  - Expected: passes with unchanged Dropbox code and zero added client methods.
  - Forbidden: a Dropbox fake shape that differs from that record, which would make the fake
    more generous or more mean than the real API.

**Verification.**

- `v-shared-contract` (T1): `npx vitest run tests/fs/remote-backend-contracts.test.ts`.
- `v-build` (T0): `npm run build`. All three harnesses must type-check against the widened
  interface.

**Implementation discretion `discretion-scope-entry-seam-shape`.**

- Question: the names and signatures of the two harness members, fixture ids, and the
  outside-container representation in each harness.
- Scope: the four test files, private.
- Escalate when:
  - a family's recorded shape cannot be expressed through the two members;
  - an assertion would have to become family-conditional.

**Open design choices:** none.

<!-- anchor: contract-gdrive-live-scope-entry-e2e -->
## Contract: Google Drive live scope-entry e2e

**Subject:** live evidence that real Google Drive plus `GoogleDriveFs` reports an entered
folder's subtree, including on re-entry.
**Owner:** `component-gdrive-live-e2e`. **Requirements:** FR-1.
**Unit:** "Add the Google Drive live scope-entry e2e case".
**ADR:** `adr-20260916-gdrive-delta-relists-entered-folders`.

**Decision rule `rule-live-scenario`.** Evidence mode: live observation. The scenario lives
in the credentialed branch of `e2e/googledrive.e2e.ts`, in one `describe`/`it`:

1. **Setup.**
   - Create root `R = makeGoogleDriveChild(client, parentId)` and outside folder
     `O = makeGoogleDriveChild(client, parentId)`.
   - Through `client`, create `F` under `O` with `a.md`, folder `sub`, and `sub/b.md`.
   - Build `GoogleDriveFs(client, R, undefined, store)` with a real `MetadataStore`.
   - Call `list()`, then `commitCheckpoint()`.
2. **Move in.**
   - `updateFileMetadata(F, {}, R, O)`.
   - Poll `getChangedPaths()` until a result's `modified` contains `F`.
   - That same result's `modified` must contain F, F/a.md, F/sub, and F/sub/b.md.
   - `commitCheckpoint()`.
3. **Move out.**
   - `updateFileMetadata(F, {}, O, R)`.
   - Poll until a result's `deleted` contains `F`.
   - That result's `deleted` must contain all four paths.
   - `commitCheckpoint()`.
4. **Move back in** (the live reproduction).
   - `updateFileMetadata(F, {}, R, O)`.
   - Poll until `modified` contains `F`.
   - That result's `modified` must contain all four paths, and `stat("F/sub/b.md")` is not
     null.

Exhausting the poll bound fails the test with a message naming `changes.list` propagation.
It never skips and never passes. When credentials are absent, the existing file-level
`describe.skip` applies. `docs/e2e-testing.md` gains a Notes bullet describing the scenario,
why it polls, and why the assertion is on the result where `F` first appears.

**Observable `observable-live-subtree-facts`.** Scope: one live filesystem over the real API
for one test run.

**Operational input `input-live-changes-propagation`.**

- Owner: `component-gdrive-live-e2e`.
- Producer: external. Google Drive `changes.list` and `files.list`.
- Source: the real `GoogleDriveClient`.
- Data scope: one per-run parent folder.
- Acquired: during polling.
- Required until: the assertion.
- Preservation: none.
- Mutable: yes.
- Stability basis: the assertion binds to the result where `F` first appears.
- Unavailable: the poll bound is exhausted, and the test fails explicitly.

**Invariants:** the case is never part of `npm test`, lint, or CI. Cleanup stays the existing
per-run parent trash.

**Typed failure semantics:** `failure-live-propagation-timeout`, an explicit test failure.

**Witnesses.** Both use `v-gd-live`.

- `witness-live-first-move-in`
  - Normal. FR-1.
  - Expected: step 2 passes.
- `witness-live-reentry`
  - Adversarial; risk: stale. FR-1.
  - Expected: step 4 passes.
  - Forbidden: `modified` without the descendants, the defect `live-probe-googledrive`
    observed.

**Verification.**

- `v-e2e-typecheck` (T0): `npm run typecheck:e2e`.
- `v-gd-live` (T2): `npm run test:e2e:google`.

**Implementation discretion `discretion-live-poll-bounds`.**

- Question: poll count, interval, fixture names, and helper extraction within the file.
- Scope: `e2e/googledrive.e2e.ts`, private.
- Escalate when:
  - propagation routinely needs more than about 60 seconds;
  - the assertion would have to span more than one result.

**Open design choices:** none.

<!-- anchor: adr-20260916-gdrive-delta-relists-entered-folders -->
## ADR: Google Drive delta application re-lists folders that newly enter the bound root

Status: proposed. File: `docs/adr/adr-20260916-gdrive-delta-relists-entered-folders.md`.
The ADR is standalone and does not amend ADR 0006: ADR 0006 reorders a complete delta, and
this ADR recovers entries a provider never sends.

It fixes five decisions:

1. Apply-time recording in `id-delta.ts`.
2. Google-Drive-only sequential re-listing after the drain, targeting the current path of
   each id.
3. Upsert-only merge through the existing `applyIdDeltaPage`.
4. Propagation of listing failure into the existing attempt abort.
5. Unchanged OneDrive and Dropbox production code, with one shared scope-entry case for all
   three families over fakes bound to their recorded live probes.

It compares these rejected options:

- the shared fix for both id-addressed backends;
- page-start or drain-start sampling;
- path-keyed recording;
- a new `AbstractMetadataCache` resolver;
- per-page or concurrent listing;
- base-class placement;
- an RB-CHK-003 amendment;
- a two-family contract module;
- an ADR 0006 amendment;
- bundling the empty-folder symptom.

## Units

1. **Record entered folders and re-list them in Google Drive delta application.**
   - Contracts: `contract-entered-folder-recording`, `contract-gdrive-entered-folder-relisting`.
   - Files: `src/fs/caching/id-delta.ts`, `src/fs/googledrive/incremental-sync.ts`,
     `src/fs/googledrive/incremental-sync.test.ts`, `src/fs/googledrive/list-all.ts`,
     `docs/google-drive-backend.md`.
   - Depends on: none.
2. **Add the scope-entry case to the shared caching contract for all families.**
   - Contract: `contract-scope-entry-shared-case`.
   - Files: `tests/fs/contracts/caching-remote-fs.contract.ts` and the three
     `caching-remote-fs.contract-harness.ts` files.
   - Depends on: unit 1.
   - Each family's staged shape comes from its recorded live probe.
3. **Add the Google Drive live scope-entry e2e case.**
   - Contract: `contract-gdrive-live-scope-entry-e2e`.
   - Files: `e2e/googledrive.e2e.ts`, `docs/e2e-testing.md`.
   - Depends on: unit 1.

## Acceptance

- **AC-1 (FR-1):** full-subtree facts appear in the same result for these witnesses:
  never-tracked, re-entry after move-out, within-page eviction, child-before-parent,
  stale-path, grant-subset, and cached-elsewhere. The shared case passes for Google Drive,
  and the live re-entry case passes.
- **AC-2 (FR-2):** nested entered folders produce one listing. `Notes` and `Notes2` produce two.
- **AC-3 (FR-3):** a delta without an entered folder, or with a cached-folder rename,
  produces zero listings.
- **AC-4 (FR-4):** a listing rejection rejects `applyIncrementalChanges` with the same error.
  No later target is listed. The shared-case replay step re-derives the same facts after abort.
- **AC-5 (FR-5):** OneDrive and Dropbox production files are unchanged. The shared case passes
  for both, each over a fake emitting the shape its live probe recorded.
- **AC-6 (NFR-1):** listings are sequential, and their count equals the topmost targets.
- **AC-7 (NFR-2):** no new persisted or retained state. Listing absence never removes an
  entry. Both ownership guards pass unchanged.

## Decision dispositions

Each draft decision input maps to exactly one disposition.

| Decision input | Disposition | Target and rationale |
|---|---|---|
| `decision-input-scope-googledrive-only` (draft-2) | adopted | ADR decision 5; `contract-scope-entry-shared-case`. `live-probe-onedrive` shows OneDrive already complete. |
| `decision-input-shared-seam-vs-gdrive-local` (draft-1) | rejected | ADR alternatives table. Keeping `id-delta.ts` untouched forces page-start or drain-start sampling, which loses a folder evicted within the page (`witness-recording-evicted-within-page`). Its I/O-placement half is adopted through `decision-input-shared-seam-placement`. |
| `decision-input-shared-seam-placement` (draft-2) | adopted, modified | `contract-entered-folder-recording`. Recording is shared and I/O is Google Drive only. The record holds ids, not paths. The "future third backend" rationale is dropped; apply-time exactness is the rationale. |
| `decision-input-subtree-merge-algorithm` (draft-2) | rejected | ADR alternatives table; `contract-gdrive-entered-folder-relisting` re-feeds through `applyIdDeltaPage`. The resolver's premise is false. |
| `decision-input-reuse-list-all` (draft-1) | adopted | `contract-gdrive-entered-folder-relisting` (`rule-relist-execute`). `listAllFiles` is reused unchanged, sequentially. |
| `decision-input-folder-scope-entry-contract-shape` (draft-1) | rejected | `contract-scope-entry-shared-case`. One case in `runCachingRemoteFsContract` for all families instead of a two-family module, because the remote backend contract forbids opting out. |
| `decision-input-harness-fidelity-asymmetric-fakes` (draft-2) | adopted, extended | `contract-scope-entry-shared-case`. Every family's shape is bound to a recorded live probe, and the Google Drive `listAllFiles` stub is scoped. |
| `decision-input-adr-home-choice` (draft-2) | adopted | `adr-20260916-gdrive-delta-relists-entered-folders`, standalone. |
| `decision-input-adr-home` (draft-1) | subsumed | Into `decision-input-adr-home-choice`. |
| `decision-input-verification-tiers` (both drafts) | adopted | All four contracts: T1 unit and shared contract, T2 live Google Drive e2e, T0 static and type checks. No probe tier remains: all three provider shapes are recorded. |
| `decision-input-empty-folder-nongoal` (draft-2) | adopted | Change root `non_goals` and requirements member Non-Goals, per the user decision. |
| `decision-input-empty-folder-followup` (draft-1) | subsumed | Into `decision-input-empty-folder-nongoal`. No issue is filed. |
| `decision-input-repro-test-deleted` (draft-2) | adopted | `contract-gdrive-entered-folder-relisting` verification. New RED-first witnesses replace the deleted file, which is never referenced as existing. |
| `decision-input-dropbox-scope-entry-shape` (new; closes critique open question 1) | adopted | `contract-scope-entry-shared-case`. Closed by live evidence, not by a planned probe: `live-probe-dropbox` (2026-09-16) is determinate complete, so the Dropbox fake emits the folder with every pre-existing descendant, grounded exactly as OneDrive's is. No probe unit, evidence gate, or escalation branch remains. |

## Resolved critique issues

Each critique issue with `verdict: Y` has exactly one resolution below.

- **`issue-reenum-path-keyed-idat-stale`: resolved.**
  - The record holds stable ids (`enteredFolderIds: Set<string>`), and the current path is
    resolved with `getPathById` after the drain. Ids that no longer resolve are out of scope
    and dropped deterministically.
  - Patch hint partly adopted: the id-keyed lookup is adopted. The `{id, path}` pair is not,
    because the path captured at record time goes stale by construction and has no use.
  - Pinned by `witness-relist-stale-path` and `witness-relist-left-scope-later`.
- **`issue-subtree-merge-resolver-refuted-premise`: resolved by deletion.**
  - The resolver and `component-metadata-cache` are removed. The merge re-feeds through
    `applyIdDeltaPage` with a private mapper.
  - Patch hint adopted, with the order-safety evidence recorded in the contract.
- **`issue-shared-harness-interface-dropbox-contradiction`: resolved.**
  - Patch hint (two-family module) rejected: it would contradict the remote backend
    contract's no-opt-out rule.
  - Instead, the case runs in `runCachingRemoteFsContract` with two required members
    implemented by all three harnesses, so `tsc` stays green and Dropbox is not skipped.
  - Dropbox's fake shape comes from `live-probe-dropbox` (determinate complete), grounded the
    same way as the Google Drive and OneDrive shapes, so no family's fake is guessed.
- **`issue-rbchk003-amendment-enforcement-unfounded`: resolved by deletion.**
  - The RB-CHK-003 amendment, the worksheet bullet, and `component-remote-backend-contract-doc`
    are removed. Promotion is `none`. Patch hint adopted.
- **`issue-concurrent-enumeration-unbounded`: resolved.**
  - Listings run sequentially with no new retry layer, and NFR-1 bounds in-flight listings to
    one. Pinned by `witness-relist-sequential`.
  - Replay repetition under sustained rate limiting is accepted and bounded: at most the same
    targets per attempt. It is recorded as an ADR negative consequence. Patch hint adopted.
- **`issue-dedup-raw-prefix-sibling`: resolved.**
  - The nesting test is `p.startsWith(q + "/")`. Pinned by `witness-relist-name-prefix-sibling`.
  - Patch hint adopted.
- **`issue-verification-caching-dir-nondiscriminating`: resolved.**
  - The test-location discretion is removed. All Google Drive witnesses live in
    `src/fs/googledrive/incremental-sync.test.ts`, run with the real cache.
  - `v-gd-unit` names that file and the witnesses, including the RED-first subset.
  - Patch hint adapted: the `src/fs/caching` directory command is removed rather than widened.
- **`issue-listall-hot-path-doc-contract-unobserved`: resolved.**
  - `docs/google-drive-backend.md` and `src/fs/googledrive/list-all.ts` (doc comment) are in
    the Google Drive component grounding and unit 1's files. Both must describe the scoped
    incremental-path exception.
  - Patch hint adopted.

The residual-ordering claim (`verdict: N`) is also corrected. The ADR claims no residual
case: a dropped child under an entered parent is covered by the parent's listing, and a
child of an already-tracked parent resolves in any order.

## Critique open questions closed

1. **Dropbox behavior on scope entry is unverified.** Closed by live observation.
   `live-probe-dropbox` (2026-09-16) ran the recorded method against the Dropbox e2e account:
   the path-based recursive delta reported the entering folder with all pre-existing
   descendants on both the first move-in and the move back in, and the Air Sync view equaled
   the COLD control. All three backends are now measured — Google Drive incomplete (the defect
   this change fixes), OneDrive complete, Dropbox complete. The Dropbox fake shape follows that
   record, and the change carries no probe unit, evidence gate, or escalation branch. The case
   is never skipped and never family-filtered.
2. **A two-family module conflicts with the design doc's no-opt-out sentence.** Closed by
   following the design doc. There is no two-family module: the case lives in the shared
   contract run by all registered families. The design doc text stays unchanged.

## Scope expansion inventory

- `scope-signal-id-delta-entered-folder-ids` (shared boundary): `IdDeltaResult`, shared by
  Google Drive and OneDrive, gains `enteredFolderIds`.
- `scope-signal-caching-harness-scope-entry-members` (shared boundary):
  `CachingRemoteFsHarness`, implemented by three families, gains two required members plus
  one shared case.
- `scope-signal-verification-tiers-user-decision` (post-consultation decision): the shared
  contract case and the live e2e were authorized by the user's verification decision.
- `scope-signal-adr-renamed-narrowed-successor` (smaller structural alternative):
  `adr-20260916-gdrive-delta-relists-entered-folders` carries an id neither draft has. Both
  drafts proposed an ADR for this same decision under different ids (draft-1
  `adr-gdrive-folder-scope-entry-reenumeration`, draft-2
  `adr-20260916-newly-resolved-folder-reenumeration-order-independence`); the final ADR is
  their renamed and narrowed successor, fixing a Google-Drive-scoped delta mechanism rather
  than draft-2's cross-backend order-independence norm.

## Change package mapping

- **`change.md`:**
  - intent, outcomes, scope, and non-goals;
  - change classes `behavior`, `internal_design`;
  - gate `soft`;
  - promotion `none`: RB-CHK-003 already owns the normative completeness obligation, and
    this ADR owns the Google Drive mechanism;
  - relations `conformsTo design-remote-backend-implementation-contract`,
    `introduces adr-20260916-gdrive-delta-relists-entered-folders`, and
    `conformsTo adr-20260903-stateless-current-state-recovery`.
- **`requirements.md`:** FR-1 to FR-5, NFR-1, NFR-2, acceptance, invariants, and non-goals.
- **`implementation.md`:** the four contracts in condensed form, unit order, targets, and seams.
- **`verification.md`:** success conditions and the T0, T1, and T2 commands with their
  criteria.
