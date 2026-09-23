---
change: change-20260923-gdrive-delta-relist-scope
role: verification
---
# Verification

## Success conditions

This change is done when every acceptance criterion in the requirements member has evidence,
the gate (`npm run lint && npm run lint:bot-repro && npm run build && npm run test:coverage`)
is green, the account-wide per-changed-folder re-list is gone from the Google Drive module,
the OneDrive and Dropbox production code and request shapes are unchanged, and the
documentation claims named by FR-010 are corrected.

## Tier map

| tier | meaning here |
|---|---|
| T0 | pure unit tests over the delta apply accumulator and the adapter validation |
| T1 | wired tests through `ManagedRemoteFs` / the declared operation and the shared contract composition root, plus lint / build / coverage |
| T2 | shared scope-entry contract case for all three families through the central catalog |
| T3 | opt-in live Google Drive e2e, not in the gate |

## Verification per contract

| verification | tier | command | asserts |
|---|---|---|---|
| verify-target-set-unit | T0 | `npm test -- src/fs/caching/id-delta.test.ts` | the entered set contains exactly the folders whose old path was undefined and whose new path resolved, in first-entered order; empty on a steady-state page |
| verify-orchestration-unit | T1 | `npm test -- tests/fs/managed/delta-completion.test.ts` | zero invocations on a no-entry drain; one per remaining topmost target in first-entered order; nested and unresolved targets dropped; a rejected listing aborts before any durable commit |
| verify-cursor-invalid-fallback | T1 | `npm test -- tests/fs/managed/delta-completion.test.ts` | `cursor_invalid` takes the full-scan fallback, publishes no partial delta, diff against the pre-delta view, and keeps a same-path content update the path↔id diff cannot re-derive |
| verify-scope-entry-contract | T2 | `npm test -- tests/fs/remote-backend-contracts.test.ts` | the exact modified set F, F/a.md, F/sub, F/sub/b.md, no deleted/renamed, repeated after `abortWorkingView` |
| verify-subtree-read-unit | T1 | `npm test -- src/backends/googledrive/adapter.test.ts` | one scoped listing per invocation for the given folder id; provider entries returned; the delta path never walks a changed folder |
| verify-subtree-typed-410 | T1 | `npm test -- src/backends/googledrive/adapter.test.ts` | a 410 yields `cursor_invalid` to core rather than a partial result or an untyped throw |
| verify-completion-api-shape | T1 | `npm test -- tests/backend-api/validate-module.test.ts` | a declaring adapter validates; an omitting adapter validates; a declared-but-malformed member is rejected |
| verify-completion-facts-contract | T2 | `npm test -- tests/fs/remote-backend-contracts.test.ts` | Google Drive yields the exact entered subtree through the declared operation; OneDrive and Dropbox pass over unchanged production code |
| verify-module-compat | T1 | `npm test -- tests/backend-api/validate-module.test.ts` | the three canonical modules register and validate with and without the optional member; a declared-but-malformed member is rejected while a valid omitting adapter is accepted |
| verify-catalog-completeness | T2 | `npm test -- tests/fs/remote-backend-contracts.test.ts` | `validateRemoteBackendCatalog` returns no issues and all three families run the scope-entry case |
| verify-abort-atomicity | T1 | `npm test -- tests/fs/managed/delta-completion.test.ts` | over a cursor-sensitive fake: the durable checkpoint and scope fingerprint are unchanged after a rejected listing, and the retry re-derives the same complete subtree |
| verify-relist-request-count | T1 | `npm test -- tests/fs/managed/delta-completion.test.ts` | steady state issues 0 invocations; an entering folder issues exactly 1 per topmost target and nested targets are not walked |
| verify-account-wide-red | T1 | `npm test -- src/backends/googledrive/adapter.test.ts` | the unmodified delta path walked changed folders; the fixed `getChanges` never calls the subtree list on that path (RED-first regression guard) |
| verify-live-relist-cost | T3 | `npm run test:e2e:google` | the real move-in scenario surfaces the complete entered subtree; the live run does not measure request counts |
| verify-ownership-guards | T1 | `npm run lint:bot-repro` | both guards stay green with no new `SyncOrchestrator` field and no persisted entered set |

The malformed-declaration assertion lives in `tests/backend-api/validate-module.test.ts`.
The orchestration, cursor-invalid fallback, abort and request-count checks live in
`tests/fs/managed/delta-completion.test.ts`; `tests/fs/managed/managed-remote-fs.test.ts`
holds no completion case. The account-wide RED witness lives in
`src/backends/googledrive/adapter.test.ts`.

## Regression witness (RED-first)

The account-wide regression is pinned by `src/backends/googledrive/adapter.test.ts`
(`verify-account-wide-red`): against the unmodified `GoogleDriveAdapter.getChanges` the test
fails because that path called `client.listAllFiles` for every changed folder, so it is a
RED-first witness that survives independently of the live provider. After the fix the same
test passes because the delta path issues no listing and `listSubtreeById` owns the one
scoped read. The steady-state / one-per-target count is the GREEN witness in
`tests/fs/managed/delta-completion.test.ts`. The live e2e cannot re-observe the pre-fix
count on the fixed build and is not asked to.

Normal witnesses: `witness-target-set-normal` (an entering page records exactly the entering
folder; a steady-state in-root rename records none), `witness-orchestration-normal` (one
invocation for the entered folder after the drain; the result reports the folder and every
descendant as modified with no deleted or renamed), `witness-subtree-normal` (exactly one
scoped listing for the supplied id), `witness-atomic-normal` (the checkpoint advances only
after a wholly clean cycle), `witness-relist-cost-normal` (zero listings in steady state),
`witness-lifetime-normal` (no entered-folder state observable after the call),
`witness-completion-normal`, `witness-evolution-normal` and `witness-shared-normal`.

Adversarial witnesses: `witness-target-set-adversarial` (a folder evicted earlier in the
same page by its ancestor's tombstone is still recorded), `witness-orchestration-adversarial`
(a nested target is walked once, an unresolved target is dropped, `cursor_invalid` yields
`needsFullScan` with no partial fact and keeps a same-path content update),
`witness-subtree-adversarial` (410 becomes `cursor_invalid`; an omitting adapter stays valid),
`witness-atomic-adversarial` (a cursor-sensitive fake proves the durable checkpoint is not
advanced; a recovery marker is forbidden), `witness-relist-cost-adversarial` (the count
tracks only the entered target and stays constant as account-wide activity grows),
`witness-lifetime-adversarial` (the guards fail on a cross-cycle owner),
`witness-completion-adversarial`, `witness-evolution-adversarial` (old-shape, malformed and
boundary-violating modules) and `witness-shared-adversarial` (a mis-registered catalog is
caught; a leaky fake does not satisfy the exact-set assertion).

## Live evidence

`npm run test:e2e:google` exercises the real Drive scenario: a folder moves into the bound
root and its unchanged descendants must surface as complete modified facts. It does not
measure request counts, so a steady-state cycle issues no subtree listing is evidenced by the
deterministic managed delta test, not the live run. Creds-gated, not in the gate.

## Known gaps

- The live e2e is completeness-only and cannot observe the pre-fix account-wide count on the
  fixed build; the deterministic account-wide RED witness is the adapter-level unit
  `verify-account-wide-red`, which fails against unmodified code.
- The declared-operation count is deterministic only because the managed delta test drives a
  fake that records every invocation; a provider-side dashboard count is out of scope.
