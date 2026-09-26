---
change: change-20260927-gdrive-native-object-exclusion
role: verification
---

<!-- lifecycle is owned by change.md -->

# Verification

## Success conditions

This change is done when a provider-native Google Workspace object is absent from every
Google Drive view-feeding read path, a byte-backed file of any mimeType is unaffected, a
version-bound read of a native object is unverifiable without a download, and the repository
gate (`npm run lint && npm run lint:bot-repro && npm run build && npm run test:coverage`) is
green.

## Tier map

| tier | meaning here |
|---|---|
| T0 | pure unit tests over the native predicate and the adapter read-path filters |
| T1 | wired tests through `ManagedRemoteFs` / the shared Google Drive managed harness, plus lint / build / coverage |
| T2 | opt-in live Google Drive e2e, not in the gate |

## Verification per contract

| verification | tier | command | asserts |
|---|---|---|---|
| verify-native-predicate | T0 | `npm test -- src/backends/googledrive/types.test.ts` | Docs Editors/forms/scripts/shortcuts are native; the folder mimeType is not; byte-backed and empty mimeTypes are not |
| verify-view-filter | T0 | `npm test -- src/backends/googledrive/adapter.test.ts` | native objects are absent from listAll and listSubtreeById while byte files remain; a native upsert is dropped from `getChanges` while its delete is kept; `getById`/`getByPath` resolve a native object to absence |
| verify-read-unverifiable | T0 | `npm test -- src/backends/googledrive/adapter.test.ts` | a version-bound read of a native object returns `unverifiable` and `downloadFile` is never called |
| verify-managed-view | T1 | `npm test -- tests/fs/remote-backend-contracts.test.ts` | a cold `ManagedRemoteFs.list()` and a committed-then-delta `getChangedPaths()` both keep the native object out while the byte-backed file is present |
| verify-gate | T1 | `npm run lint && npm run lint:bot-repro && npm run build && npm run test:coverage` | the full repository gate is green |

## Regression witness (RED-first)

The pre-fix failure is pinned by the managed-harness and adapter cases, and the witness was
executed: disabling the predicate (`isGoogleDriveNativeObject → false`) makes exactly the 8
new cases fail — `types.test.ts` "reports Docs Editors objects as native", the five adapter
cases, and the two managed cases — while every pre-existing test stays green. After restoring
the predicate the same 8 pass. Against the unmodified adapter a native `GoogleDriveFile`
normalized to `kind "file"` and appeared in the view, and a read attempted `downloadFile`,
which the real client maps to a 403 `fileNotDownloadable`. The field symptom this reproduces
is the real `2026-09-26` vault log: `remoteOnly:1` → `pull:1` → 403 `fileNotDownloadable` →
`failed:1`, repeated on the next cycle.

## Evidence

- `npm run lint`: passed.
- `npm run lint:bot-repro`: passed (69 guard tests).
- `npm run build`: passed.
- `npm run test:coverage`: passed (118 files, 2424 tests).

## Known gaps

- The live e2e (`npm run test:e2e:google`) is credentials-gated and not run here; the
  provider DTO shape is exercised through the faithful managed harness, not a real native
  object in the bound root.
- The exact mimeType of the field object was inferred from the 403 `fileNotDownloadable`
  reason and the client's field list, not read from the Drive API; the predicate covers the
  whole `application/vnd.google-apps.*` family, so the inference does not change the fix.
