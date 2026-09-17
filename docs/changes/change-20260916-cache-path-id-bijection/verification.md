---
change: change-20260916-cache-path-id-bijection
role: verification
---

<!-- lifecycle is owned by change.md -->

# Verification

## Content

### Success conditions

This change is done when every acceptance criterion in the requirements member has evidence, the
gate is green, and the promotion manifest in `change.md` is reflected in the two governing design
documents.

### Tier map

| tier | meaning here |
|---|---|
| T0 | Unit tests over a pure function or an in-test subclass, and the existing `remote-fs.contract.test.ts` |
| T1 | Cross-module behaviour through the shared contract composition root, plus lint / build / coverage |
| T2 | Opt-in live e2e against the real provider (`npm run test:e2e:google`, `npm run test:e2e:onedrive`), not in the gate |

### New test files

`src/fs/caching/metadata-cache.test.ts` and `src/fs/caching/id-delta.test.ts` do not exist on main.
`docs/issue/issue-20260916-no-shared-contract-pins-enumeration.md` records that the shared cache and
the shared applier have no unit tests at all and that no shared contract pins enumeration
uniqueness; these files close that gap and that issue's `subject_paths` name them.

### T0 — unit

**`src/fs/caching/address-arbitration.test.ts`** (new)
- Every permutation of a claim set of size 2 and 3 yields the same admitted id and the same
  displacement set. Drive permutations exhaustively, not by sampling.
- Tier 1 (`actual_resolved` over `requested_echo`) is applied before tier 2 (lexicographically
  lowest id); equal ids yield `no_contest`.
- A losing `requested_echo` claim is marked as owing no provider remediation.
- The function never throws for any input, including empty-string ids and identical authorities.

**`src/fs/caching/metadata-cache.test.ts`** (new)
- The nested-collision fixture — `docs=d1{a.md,b.md}` vs `docs=d2{x.md}` — run as `(d1,c1,c2,d2,c3)`
  **and** as `(d2,c3,d1,c1,c2)`, asserting equal `list()`, equal `stat()` and equal displacement
  sets. The first permutation is the one both design drafts' mechanisms fail: `docs/x.md` must not
  resolve to `c3` under the winning folder in either order.
- The flat pair in both orders.
- A legacy Drive multi-parent entry (`googledrive/list-all.ts:43-49`) with `parents[]` in both
  orders yields the same contents. `findRelevantParentId` prefers `rootFolderId` and otherwise takes
  any known parent, so this is a collision producer distinct from the other two shapes.
- `setFile`'s occupant branch returns a displacement naming the path, both ids and every removed
  descendant path; a `void` return with one id gone must fail.
- Bijection after **every** mutation, not only at the end: every `(path,id)` in `exportRecords`
  satisfies `getPathById(id) === path` and `idAt(path) === id`, and `snapshotPathsById().size === size`.
- `bulkLoad`'s duplicate-stable-id throw keeps its exact message and breadth; no path-duplication
  throw exists.
- `AbstractMetadataCache` has no new instance field and no displacement survives its call.
- One `logger.warn` per contended address, with a counting logger double; a 500-descendant displaced
  folder produces one line, not 501; with `logger` undefined the cache behaves identically.

**`src/fs/caching/id-delta.test.ts`** (new)
- The measured folder fixture names the withheld id and both child paths instead of leaving
  `changedPaths=["docs"]` alone.
- A tombstone for the admitted id later in the same drain readmits the withheld claimant and
  withdraws the contention before publication.
- The published result for a multiset of entries is equal across page permutations.
- **The falsifier pair for the two causes of `applyFileChange` returning null**: a folder moved
  outside the tracked root still names its paths in `deleted`, while the later-page child of a
  parent displaced in this unit does not. Both must hold in the same test file, or the branch has
  been collapsed one way or the other.
- Nothing accumulated survives the drain.

**`src/fs/caching/remote-fs.contract.test.ts`** (existing, extended)
- The measured snapshot fixture yields an empty `deleted` for `docs`, `docs/a.md`, `docs/b.md`.
- **The cursor-expiry route**: seed a checkpoint containing a bare-name-collapsed orphan, force a
  410, and assert `RemoteDelta.deleted` excludes its old path. This is the route the repository's
  own issue document does not name and the one measured to reach `checkpoint_deleted` and the
  `delete_local` gate at `identity-component-decision.ts:568-569`.
- A genuine remote deletion still reaches `deleted` and still becomes `checkpoint_deleted`.

**`src/sync/plan-admission-address-contention.test.ts`** (new)
- The keeper and the target address are identical for both orders of the claim pair and for COLD,
  WARM and HOT, driven from a seeded `SyncStateStore` rather than from arrival order.
- The target is `insertConflictSuffix(path, "id-" + id)`, stable across two planning runs, and
  `directConflictCandidateHint` returns `undefined` for it.
- A remediable contention produces exactly one `rename_remote` naming the non-keeper's provider
  identity, and sets the checkpoint block.
- **An orphan-collapse contention produces no action, no provider mutation and no checkpoint block.**
- A backend without the rename capability receives no such action.

**`src/sync/plan-executor.test.ts`** (existing, extended)
- The executor renames by provider identity when one is supplied and publishes no `SyncRecord`.
- A remote-only rename with no local counterpart and no baseline no longer throws at
  `plan-executor.ts:383-384`.
- **The keeper is untouched.** A path-addressed fallback would move the wrong object; the test must
  be able to catch that.

**`src/sync/orchestrator.test.ts`** (existing, extended)
- A failed rename leaves `commitCheckpoint` uncalled, `abortWorkingView` called, and the cursor at
  its previous value; the next cycle re-observes the same contention.
- On `DEFAULT_SETTINGS` the status bar states the contended count. Assert against `DEFAULT_SETTINGS`
  itself, not a test-only settings object — `enableLogging` and `showSyncNotifications` are both
  `false` there and that is the whole point of the requirement.

**`src/sync/sync-notification.test.ts`** (existing, extended)
- The contended clause is distinct from the error clause, does not add to the error count, and
  merges correctly across cycles in `CycleSummary`.

**`src/fs/dropbox/metadata-cache.test.ts`** (existing, **unmodified**)
- `:92-98` and `:100-116` must stay green with no edits. If either turns red, Dropbox's
  provider-keyed policy has been changed, which this change does not authorize.

**`src/fs/googledrive/metadata-cache.test.ts`** (existing, edited)
- `:704-717`, which pins the silent displacing behaviour, is updated to assert the announced
  outcome — issue #90 requires it be updated rather than left green.
- `:410-421` must stay green: the bare-name fallback is retained and still carries
  `requested_echo`.

### T1 — shared contract and gate

**`tests/fs/contracts/caching-remote-fs.contract.ts`**, registered through
`tests/fs/remote-backend-contracts.test.ts`. Asserted only through `list`, `stat`, `listDir` and the
delta result — no cache reference, no private-state inspection.

1. Two distinct stable ids at one cache path: one addressable id, the other named in the delta
   result, `deleted` empty for that path.
2. The same two in the reverse provider ordering: identical observables.
3. A nested collision in both permutations: no loser descendant reachable under the winner, equal
   displacement sets.
4. Cold-versus-delta parity of the **collision outcome** — same addressable id, same announced
   facts. Deliberately *not* identical cached entry sets: the two routes legitimately hold different
   entries, because `resolveFilePathCached` places bare-name orphans that `resolvePathFromCache`
   declines.
5. No contested path reported deleted and no `delete_local` after a cursor expiry.
6. **Survival**: after the repair has landed, both objects are present — the keeper at the plain
   address, the other at `insertConflictSuffix(path, "id-" + id)` — on the provider and in the
   vault. This is the case that pins the no-loss invariant rather than a stable winner.
7. **No commit while withheld**: a cycle whose remediation fails leaves the cursor at its previous
   value and the next cycle re-observes the same contention.
8. Drive-specific shapes: `/`-in-name, orphan collapse (asserting **no** provider mutation), and the
   legacy multi-parent entry.

Cases 1–3 and 6–8 run for Google Drive; cases 4–5 run for every family that supplies the seam.

**Per-family obligation in the central matrix.** `CachingRemoteFsHarness` gains one
collision-staging seam and each family supplies it or a cited non-producibility:

| family | cell | citation |
|---|---|---|
| googledrive | collision-producing script | — |
| dropbox | cited non-producibility | Path-keyed namespace: `extractId` is `entry.id ?? entry.path_lower` (`dropbox/metadata-cache.ts:51`), so two ids cannot resolve to one address through its own enumeration. `unknown-dropbox-folder-replacement-contract` is cited alongside, because the repository's own documents leave that contract unresolved in both directions |
| onedrive | cited non-producibility | `unknown-onedrive-duplicate-names` is unsettled; a fabricated fixture would assert a shape the provider may not have. Settled by the T2 e2e below |

A missing cell stays a compile error through the existing `satisfies` at
`remote-backend-contracts.test.ts:23-42`. A declared gap carries its unsettled unknown id rather
than silence, and an empty function in place of a script must fail review.

**Gate.** `npm run lint && npm run lint:bot-repro && npm run build && npm run test:coverage` must be
green. Additionally: `node --test sync-state-ownership-guard.test.mjs
sync-admission-authority-guard.test.mjs` green **with no fixture edits** — this change adds no
orchestrator field, no persistent-store owner and no cursor writer, so no guard fixture may need
touching. If one does, the change has exceeded its declared scope.

### T2 — opt-in live e2e (not in the gate)

- `npm run test:e2e:google` — create two same-named siblings under one synced folder through the
  Drive API, run two cycles, assert both objects survive on Drive and both are present in the vault
  at distinct paths, and assert the identity-addressed rename actually renames the non-keeper.
- `npm run test:e2e:onedrive` — attempt to create two same-named children under one OneDrive folder
  through the Graph API. This settles `unknown-onedrive-duplicate-names` and decides whether
  OneDrive must implement the rename capability.

### Evidence of load-bearing assertions

Every new assertion must be RED-first or carry a mutation witness. The three that must be shown red
before the fix, because they are the measured defects:

- The nested-collision `(d1,c1,c2,d2,c3)` permutation (the order-dependent cascade).
- The cursor-expiry route to `delete_local` (`remote-fs.ts:429-431`).
- Shared contract case 2, both provider orderings, which must fail on PR #83's branch.

### Non-producible and unmeasured, recorded rather than stubbed

- OneDrive's duplicate-name behaviour — `unknown-onedrive-duplicate-names`.
- Dropbox's folder-replacement contract — `unknown-dropbox-folder-replacement-contract`.
- Main's end-to-end Admission outcome for these shapes — `unknown-admission-outcome-on-main`. The
  `conflicting_identity` stall reported in issue #90 was measured on a PR-83-rebased worktree and is
  not main's behaviour; nothing here depends on Admission failing closed as a damage bound.
- The interaction between a mid-drain `relistTargets` walk and a collision —
  `unknown-relist-collision-interaction`. Settled by a fixture that moves a folder containing a name
  collision into the synced root mid-drain.
- A permanently refused rename — `unknown-collision-stall-escape`. The cursor stalls, the rest of
  the vault keeps syncing, and the user is told each cycle; no recovery machinery is built and
  nothing is persisted.
- A checkpoint restored from a contended cycle — `unknown-checkpoint-restore-collision`.
