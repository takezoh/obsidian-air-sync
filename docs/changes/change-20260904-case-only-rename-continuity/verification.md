---
change: change-20260904-case-only-rename-continuity
role: verification
---

<!-- lifecycle is owned by change.md -->

# Verification

## Content

### Deterministic acceptance matrix

| Contract | Tier | Command | Required observation |
|---|---:|---|---|
| Final cache projection, all backends | T1 | `npm test -- --run tests/fs/remote-backend-contracts.test.ts` | Google Drive, Dropbox, and OneDrive recreate the final live metadata snapshot after executor write/parent/rename/delete/subtree mutations. |
| Google restart causality | T1 | `npm test -- --run src/fs/googledrive/index.test.ts` | A clean `Templates`→`TemplateS` checkpoint restores only final-casing cache paths after recreation. |
| Checkpoint failure safety | T1 | `npm test -- --run src/fs/caching/remote-fs.contract.test.ts` | A failed snapshot transaction advances neither durable projection nor cursor and requires no retry write-set. |
| Versioned persistence reset | T1 | `npm test -- --run src/store/metadata-store.test.ts src/sync/state.test.ts` | Version 3 metadata stores are recreated as version 4; SyncState v7 records and merge bases are recreated as empty v8 stores, with no second v9 reset. |
| Ordinary COLD rebuild | T1 | `npm test -- --run src/sync/orchestrator.test.ts` | A cleared checkpoint and baseline select ordinary full-scan reconciliation without a recovery-specific branch. |
| Local actual-casing boundary | T1 | `npm test -- --run src/fs/local/local-fs.test.ts` | Stale index aliases collapse to the adapter-proven spelling while genuine case-sensitive siblings remain. |
| Observation boundary | T1 | `npm test -- --run src/sync/change-detector.test.ts` | Equal-byte aliases acquire endpoint/content facts without emitting rename identity or an action; differing bytes remain explicit contradictory facts. |
| Admission authorization | T1 | `npm test -- --run src/sync/plan-admission.test.ts src/sync/orchestrator.test.ts` | Complete current facts shape one explicit remote-rename protocol; mismatched/incomplete facts reject; COLD/WARM/HOT and unrelated records do not alter the result. |
| Terminal race proof | T1 | `npm test -- --run src/sync/plan-executor.test.ts` | A local/remote content race around the admitted case-alias move blocks commit and keeps the cycle non-clean. |
| State-boundary guard | T1 | `npm test -- --run src/sync/state-boundary.test.ts` | Exactly two authoritative durable states and the reviewed `SyncOrchestrator` instance-field inventory are accepted; removed cache pending-state identifiers are absent. |

The shared backend contract remains registered only through
`tests/fs/remote-backend-contracts.test.ts`.

### Counterexample and mutation checks

- Persist only delta-touched paths after an executor rename: the restart projection test
  must fail.
- Omit one live cache entry or absence from the complete snapshot: the shared contract
  must fail.
- Swallow a snapshot persistence error or advance the cursor separately: the failure
  safety test must fail.
- Reintroduce `touchedPaths`, `pendingFullPersist`, or equivalent pending correctness
  state: the state-boundary guard and source review must fail.
- Retain a seeded v7 casing `SyncRecord`: the versioned reset test must fail.
- Add a `SyncOrchestrator` instance field without revising the architectural contract:
  the exact inventory test must fail.
- Remove any exact/alias, target-absence, unique-identity, hash, size, or included-scope
  precondition: the Admission counterexample tests and scoped review must fail.
- Persist the candidate/result or add a durable Admission status: the state-boundary guard and
  scoped review must fail.

### Repository gate

Run and record:

```bash
npm run lint
npm run lint:bot-repro
npm run build
npm run test:coverage
```

All commands must pass. Diff inspection must confirm that the implementation contains
one complete snapshot at the existing checkpoint, only the established one-time schema
bumps, no migration or recovery state, no new Orchestrator state field, and only the
strict cycle-local case-alias Observation/Admission protocol described above.

### Optional provider fidelity

`npm run test:e2e` may confirm a real provider's case-only rename event shape when
credentials are available. It is T2 evidence only and does not replace the deterministic
cache, upgrade, or state-boundary tests.
