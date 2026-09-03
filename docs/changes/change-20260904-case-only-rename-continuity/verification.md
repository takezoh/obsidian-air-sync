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
| Final projection, all backends | T1 | `npm test -- --run tests/fs/remote-backend-contracts.test.ts` | Google Drive, Dropbox, and OneDrive restore final write/mkdir/rename/delete/parent/subtree paths after clean commit and recreation. |
| Google restart causality | T1 | `npm test -- --run src/fs/googledrive/index.test.ts` | `Templates` to `TemplateS` plus children persists at new paths; replaying the queued self-change emits no stale rename. |
| Projection failure safety | T1 | `npm test -- --run src/fs/googledrive/index.test.ts src/sync/orchestrator.test.ts` | A failed transaction advances neither map nor cursor and a retry still has the pending footprint. |
| Contextual evidence and COLD relation | T1 | `npm test -- --run src/sync/change-detector.test.ts src/sync/identity-evidence.test.ts` | X/X and X/Y remain distinguishable, ordinary same-path rows stay sparse, and only one complete non-empty folder set yields `current_state` evidence. |
| Admission partition | T1 | `npm test -- --run src/sync/plan-admission.test.ts` | Safe file/folder proof resolves; foreign, missing, empty, incomplete, duplicate, ambiguous, and unrelated alias cases fail with existing reasons and no destructive action. |
| COLD baseline convergence | T1 | `npm test -- --run src/sync/orchestrator.test.ts` | A pre-existing relation-loss state runs only `match`/`cleanup`, commits clean, and the following sync is idle; paired foreign state stays `partial_error` and uncommitted. |

The shared caching contract must be registered only through
`tests/fs/remote-backend-contracts.test.ts`, consistent with the repository's central
backend matrix.

### Counterexample and mutation checks

- Remove executor-origin touch registration for a renamed root or one descendant: the
  restart projection test must fail.
- Clear the touched set before a failed transaction retry: the persistence-failure test
  must fail.
- Accept only a subset of folder descendants, an empty folder, or path-case equality
  without identity: the paired Admission/COLD tests must fail.
- Replace one current descendant identity while keeping every path and hash unchanged:
  the component must become `conflicting_identity`, execute no filesystem action, and
  withhold the checkpoint.
- Emit continuity for an unrelated ordinary same-path row or allow an unrelated alias:
  the sparsity/alias tests must fail.
- Return `resolved_no_action` for an old-path COLD baseline without converging its records:
  the second-cycle idle assertion must fail.

### Repository gate

Run and record all required commands after focused tests:

```bash
npm run lint
npm run lint:bot-repro
npm run build
npm run test:coverage
```

All must pass before push. Confirm by source/diff inspection that no persisted schema,
folder identity, journal/receipt, new status/evidence kind, Orchestrator policy, or public
checkpoint/provider API was added.

### Optional provider fidelity

`npm run test:e2e` may verify the real Google Drive, Dropbox, and OneDrive case-only
folder mutation/delta shape when credentials are available. Record it separately as T2
evidence. It is not part of the normal gate and cannot replace the deterministic shared
contract or paired security counterexamples.
