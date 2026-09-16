---
change: change-20260915-gdrive-folder-reentry-enumeration
role: verification
---

<!-- lifecycle is owned by change.md -->

# Verification

Tiers:

- **T0** covers static, type, and scope checks.
- **T1** covers deterministic tests that belong to the enforced gate.
- **T2** covers opt-in live provider evidence. T2 is never part of `npm test` or CI.

## Success conditions

1. A Google Drive folder whose id gains a cached path during a changes drain has every
   grant-visible descendant in the same `getChangedPaths()` result (FR-1).
2. Nested entered folders produce one listing, and a name-prefix sibling still gets its own
   listing (FR-2).
3. When no folder entered, no listing is issued (FR-3).
4. A listing failure rejects the attempt with nothing committed, and a replay re-derives the
   same facts (FR-4).
5. OneDrive and Dropbox production code is unchanged, and the shared scope-entry case passes
   for both over fakes that emit the delta shape each provider's live probe recorded (FR-5).
6. Listings run sequentially, and their count is bounded by topmost targets (NFR-1).
7. No new state is added, listing absence never removes an entry, and the ownership guards
   are unchanged (NFR-2).

## T1 — Google Drive unit witnesses

Run:

```bash
npx vitest run src/fs/googledrive/incremental-sync.test.ts
```

The file must contain these cases. Each case uses a real `GoogleDriveMetadataCache("root")`
and a client mock that provides `listChanges` and `listAllFiles`. Each assertion checks cached
paths, `changedPaths` and `renamedPaths`, and the exact ordered ids passed to `listAllFiles`.

| Witness | Setup and expected result |
|---|---|
| never-tracked | Uncached `F` enters. `F`, `F/a.md`, `F/sub`, and `F/sub/b.md` are reported. One call, `F`. |
| reentry-after-move-out | Drain 1 moves tracked `F` out (evicted). In drain 2 `F` returns and its child is reported again. |
| evicted-within-page | One page holds a trash tombstone for cached `A` and `F` re-parented from `A` to the root. `F`'s previous children are reported under `F`. |
| child-before-parent | Uncached `S` (child of `F`) is listed before uncached `F` in one page. `F/S` and its file are present. |
| stale-path | Page 1 moves `F` into cached `A`. Page 2 renames `A` to `B`. `listAllFiles("F")` is called and `B/F/*` is present. |
| nested | `F` enters on page 1 and `F/S` on page 2. The listing of `F` holds an uncached folder `T`. Exactly one call, `F`. |
| name-prefix-sibling | `Notes` and `Notes2` both enter. Two calls, and `Notes2`'s children are present. |
| left-scope-later | Page 1 enters `F`. Page 2 trashes `F`. Zero calls. |
| no-entered-folder / tracked-rename | A delta with only file changes, or a rename of a cached folder. Zero calls. |
| failure | The first of two listings rejects with `{ status: 403 }`. `applyIncrementalChanges` rejects with that error, and the second target is never listed. |
| sequential | The first listing is deferred. The second call does not happen before the first merge. |
| grant-subset | A descendant cached from its own change is absent from the listing. It stays cached and reported, and no extra call is made. |
| descendant-cached-elsewhere | A listed id is cached at root `C`. The rename pair `C` → `F/C` is produced. |

RED-first: never-tracked, reentry-after-move-out, evicted-within-page, child-before-parent,
and stale-path must fail against the unmodified production code before implementation.
Record that observation in the task evidence.

## T1 — shared caching contract

Run:

```bash
npx vitest run tests/fs/remote-backend-contracts.test.ts
```

The scope-entry case runs for `GoogleDriveFs`, `OneDriveFs`, and `DropboxFs` and must pass for
all three. It asserts four things:

- Before the move-in, the seeded outside paths are invisible.
- After the move-in, `modified` is exactly `[F, F/a.md, F/sub, F/sub/b.md]`, `deleted` and
  `renamed` are empty, and `stat("F/sub/b.md")` returns an entry.
- After `abortWorkingView()`, a second `getChangedPaths()` returns the same `modified` set.
- Every existing case stays green.

Each family's staged delta shape comes from its own live probe of 2026-09-16: Google Drive
emits the folder change alone, while OneDrive and Dropbox emit the folder with all three
descendants. A fake that departs from its family's recorded shape is a defect in the fake.

Load-bearing witnesses:

- The Google Drive cell fails without the unit-1 production change: `modified` is only `[F]`.
- The Google Drive cell also fails with the old `listAllFiles` stub, which ignores `folderId`.
- The OneDrive and Dropbox cells pass over unchanged production code, with no added client
  method and no request beyond the ordinary delta pages.

## T0 — static, scope, and gate checks

Run:

```bash
npm run build
npm run lint
npm run lint:bot-repro
npm run typecheck:e2e
```

Criteria:

- `lint:bot-repro` passes `sync-state-ownership-guard.test.mjs` and
  `sync-admission-authority-guard.test.mjs` with unchanged fixtures.
- The change touches no production file outside `src/fs/caching/id-delta.ts` and
  `src/fs/googledrive/`; `src/fs/onedrive`, `src/fs/dropbox`, `src/fs/caching/remote-fs.ts`
  and `src/fs/caching/metadata-cache.ts` are untouched.
- A diff review finds the following count equal to zero: new persisted fields, new exports
  from `incremental-sync.ts`, `Promise.all` or retry wrappers around `listAllFiles`, new
  `try`/`catch` blocks in `applyIncrementalChanges`, and changes to `applyIdDeltaPage`'s
  comparator or existing branches.

Before closure, also run the repository gate:

```bash
npm run lint && npm run lint:bot-repro && npm run build && npm run test:coverage
```

## T2 — live Google Drive e2e

Run outside an agent sandbox, as described in `docs/e2e-testing.md`:

```bash
npm run test:e2e:google
```

The scope-entry case must pass three phases: move-in, move-out, and move-back-in. In the
first result that contains `F`, the modified or deleted list must also hold `F/a.md`,
`F/sub`, and `F/sub/b.md`. After re-entry, `stat("F/sub/b.md")` must return an entry. When
credentials are missing, the suite is skipped, and a skipped run is not evidence for this
change.

## Recorded provider evidence

A harness fake is only as good as the observation behind it. Each provider's scope-entry delta
shape was measured live on 2026-09-16, before this plan was written, and the harness shapes
follow those records.

| Provider | Recorded scope-entry delta | Air Sync view vs COLD control |
|---|---|---|
| Google Drive | On the move back in, the folder alone. On the first move-in, the folder plus whichever descendant changes happened to propagate after the start token, without the nested ones. | Differs — the defect this change fixes. |
| OneDrive | The folder and every pre-existing descendant, on both move-ins. | Equal. |
| Dropbox | The folder and every pre-existing descendant, on both move-ins. | Equal. |

No probe runs as part of this change. If a later opt-in run contradicts a recorded shape, fix
the fake or the backend; never skip a family or relax the shared case.
