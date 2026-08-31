---
change: change-20260831-issue51-rename-evidence-lifecycle
role: verification
---

<!-- lifecycle is owned by change.md -->

# Verification

## Success conditions

| Contract | Tier | Evidence | Pass criterion |
|---|---:|---|---|
| Candidate proof | T1 | `npm test -- --run src/sync/change-detector.test.ts src/sync/sync-cycle-planning.test.ts` | Fixed projection carries authoritative observations and fresh scope; stale v6 scope never fills current unknown. |
| Admission lifecycle | T1 | `npm test -- --run src/sync/plan-admission.test.ts src/sync/orchestrator.test.ts` | Fresh additive case progresses without debt; synchronized/ambiguous/folder/chain counterexamples retain exact safety behavior. |
| v6 compatibility | T1 | `npm test -- --run src/sync/orchestrator.test.ts src/sync/state.test.ts` | Seeded false row converges without reset and deletes only after successful checkpoint; genuine/ambiguous rows remain. |
| Persistence abort | T1 | `npm test -- --run src/sync/orchestrator.test.ts src/sync/rename-debt.test.ts` | Injected upsert failure yields visible failure, zero executor I/O, zero tracker acknowledgement, and retained retry evidence. |
| Finalization | T1 | `npm test -- --run src/sync/sync-cycle-finalization.test.ts src/sync/orchestrator.test.ts` | Successful native rename retires once after checkpoint; deferred/failed/blocked/checkpoint-failed cases retain. |
| Diagnostics | T1 | focused orchestrator/log assertions | Raw, replayed, promoted, non-binding, retained, released, and persist-failed stages are distinguishable without content or credentials. |
| Documentation | T0 | dev-docs lint and relation/conformance checks | Accepted ADR explicitly amends only ADR 0008 section 6 persistence trigger and preserves Issue 43 authority. |
| Repository gate | T2 | `npm run lint && npm run lint:bot-repro && npm run build && npm test` | All commands pass. |

## Required adversarial witnesses

- Current scope is unknown while the v6 row stores `included`: no additive release.
- Old endpoint listing is absent but authoritative stat is unavailable: no absence proof.
- Baseline/remote identity appears anywhere in a chain: whole component safety-binding.
- Folder descendant completeness is unavailable: no additive folder classification.
- Native rename plan mismatches the reported edge: deferral and no destructive I/O.
- Debt upsert fails: no executor or tracker side effect.
- Action or checkpoint fails after persistence: debt remains.

## Closure gate

Closure requires all success-condition evidence, no unresolved consequential decision,
and no claim that blank-file creation was fixed.

## Recorded evidence — 2026-08-31

- Red witness: the unbaselined local rename test failed because the push was deferred as
  `rename_mismatch` before the Admission lifecycle change.
- Mutation witness: removing the remote-absence conjunct caused the occupied-remote
  counterexample to fail by authorizing its push; restoring the conjunct returned green.
- Focused lifecycle suite: 187 tests passed across Admission, orchestrator, debt,
  Finalization, and change detection before the final full run.
- Fake-green guard: no skipped/deleted/weakened-test findings.
- Repository gate: lint, bot reproduction, build, and all 95 test files / 1604 tests passed.
- dev-docs lint with conformance: passed with no warnings.
