---
change: change-20260927-gdrive-out-of-subtree-exclusion
role: verification
---

<!-- lifecycle is owned by change.md -->

# Verification

## Success conditions

This change is done when a Google Drive object with no provider parent is absent from every
view-feeding read path, a byte-backed object with a parent is unaffected, a version-bound
read of a no-parent object is unverifiable without a download, and the repository gate
(`npm run lint && npm run lint:bot-repro && npm run build && npm run test:coverage`) is
green.

## Tier map

| tier | meaning here |
|---|---|
| T0 | unit tests over the adapter read-path filters and the representability predicate |
| T1 | wired test through the shared Google Drive managed harness, plus lint / build / coverage |
| T2 | opt-in live Google Drive e2e, not in the gate |

## Verification per contract

| verification | tier | command | asserts |
|---|---|---|---|
| verify-view-filter | T0 | `npm test -- src/backends/googledrive/adapter.test.ts` | a no-parent object is absent from `listAll` and the `getChanges` upserts while an in-root file remains; `getById`/`getByPath` resolve it to absence |
| verify-managed-delta | T1 | `npm test -- tests/fs/remote-backend-contracts.test.ts` | a no-parent object added after a committed cycle does not appear in `getChangedPaths` or the view, while the in-root file stays |
| verify-in-subtree-unaffected | T0/T1 | `npm test -- src/backends/googledrive/adapter.test.ts tests/fs/remote-backend-contracts.test.ts` | files, folders, subtrees, and deltas for in-root objects behave exactly as before |
| verify-gate | T1 | `npm run lint && npm run lint:bot-repro && npm run build && npm run test:coverage` | the full repository gate is green |

## Regression witness (RED-first)

The witness was executed: removing the parent clause from
`isSyncableGoogleDriveObject` (`… && hasGoogleDriveParent(file)`) makes exactly the 3 new
cases fail — the two adapter cases and the managed-harness delta case — while every
pre-existing test stays green. After restoring the clause the same 3 pass. Against the
unmodified adapter a no-parent object normalized to `parentId: null`, which
`NormalizedMetadataCache.resolvePathFromCache` reads as a bound-root child and seats at its
bare name.

## Evidence

- `npm run lint`: passed.
- `npm run lint:bot-repro`: passed (69 guard tests).
- `npm run build`: passed.
- `npm run test:coverage`: passed (118 files, 2427 tests).

## Known gaps

- The live e2e (`npm run test:e2e:google`) is credentials-gated and not run here; the
  provider DTO shape (`parents: []`) is exercised through the faithful managed harness.
- Whether the field object is a no-parent shared item or a shortcut placed in the bound
  folder cannot be confirmed without a live read; either way it is excluded (the native
  exclusion covers the shortcut case, this change covers the no-parent case).
