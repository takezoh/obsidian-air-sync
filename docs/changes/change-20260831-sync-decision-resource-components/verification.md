---
change: change-20260831-sync-decision-resource-components
role: verification
---

<!-- lifecycle is owned by change.md -->

# Verification

## Success conditions

The change is complete only when `AC-SD-001` through `AC-SD-008` in `requirements.md` have evidence, all three providers pass the mandatory shared faithful-fake/interface gate, any triggered backend-specific live evidence has a disposition for that backend change, the proposed ADR has an explicit disposition, and no mandatory gate is weakened or skipped.

## Verification profiles

| Profile | Tier | Command | Pass criterion |
|---|---|---|---|
| path-table | T0 pure | `npm test -- src/sync/decision-engine.test.ts` | Existing table cases, input order, at-most-one action, and no-baseline delete prohibition are unchanged. |
| component-outcomes | T0 pure | `npm test -- src/sync/plan-admission.test.ts` | Every precedence row has a positive case; missing/multiple/conflicting/failed-native-only cases defer; action and lifecycle outputs are exact. |
| component-cost | T0 pure/structural | focused component permutation and scale test added by Unit 1 | Non-semantic permutations are deterministic; one build meets the linearithmic-or-better time and linear auxiliary-memory contract; repeated/quadratic rescans fail the scale criterion. |
| rename-convergence | T1 wired | `npm test -- src/sync/plan-admission.test.ts src/sync/convergence.test.ts src/sync/delete-safety.test.ts` | Local/remote file/folder, chain, occupancy, source-recreation, scope, alias, and unsafe fallback witnesses converge or defer exactly as specified. |
| lifecycle-crash | T1 wired | `npm test -- src/sync/orchestrator.test.ts src/sync/sync-cycle-finalization.test.ts src/sync/crash-safety.test.ts src/sync/rename-debt.test.ts` | Upsert precedes I/O; upsert failure causes zero I/O; non-clean cycles retain replay; checkpoint precedes exact retirement; already-converged releases only matching replayed v6 debt. |
| executor-authority | T1 wired | `npm test -- src/sync/plan-executor.test.ts` | Executor accepts only `AuthorizedSyncPlan`, preserves existing ordering/barriers, and never interprets identity evidence. |
| shared-provider-contract | T1 contract | `npm test -- src/fs/googledrive/ifilesystem-contract.test.ts src/fs/dropbox/ifilesystem-contract.test.ts src/fs/onedrive/ifilesystem-contract.test.ts src/fs/googledrive/crash-safety-contract.test.ts src/fs/dropbox/crash-safety-contract.test.ts src/fs/onedrive/crash-safety-contract.test.ts` | Mandatory authority, identity, absence/error, order-independent rename, and snapshot cases pass for each faithful fake. |
| google-live-backstop | T2 real, opt-in | `npm run test:e2e:google` | ADR 0003 semantics: manual/non-CI; absent credentials warn and skip. Required as targeted evidence only when concrete Google Drive representation-gap evidence exists. |
| dropbox-live-backstop | T2 real, opt-in | `npm run test:e2e:dropbox` | ADR 0003 semantics: manual/non-CI; absent credentials warn and skip. Required as targeted evidence only when concrete Dropbox representation-gap evidence exists. |
| onedrive-live-backstop | T2 real, opt-in | `npm run test:e2e:onedrive` | ADR 0003 semantics: manual/non-CI; absent credentials warn and skip. Required as targeted evidence only when concrete OneDrive representation-gap evidence exists. |
| repository-gate | T1 wired | `npm run lint && npm run lint:bot-repro && npm run build && npm test` | All commands pass without disabled rules, weakened contracts, skipped mandatory shared provider cases, committed `main.js`, or schema drift. |

## Provider cutover evidence

Record one mandatory shared-conformance row per provider with faithful-fake/interface result and any backend-local fix. Separately record whether concrete representation-gap evidence triggered targeted live preverification. An untriggered or credential-skipped live suite is neither a shared-gate failure nor proof of fidelity; ADR 0003 explicitly permits the skip.

If targeted live evidence reveals a representable response, fix that provider and rerun its shared/targeted checks. If it proves an unrepresentable response, capture the exact response shape/semantics, hold only that backend change, and return to a separate interface design. Do not extend the central interface or block unrelated providers/Admission work in this change.

## Required counterexamples and mutations

- Failed native projection followed by plausible ordinary delete/transfer fallback MUST defer unless the ordinary row independently proves every survivor and consequence.
- Two non-deferral rows matching the same component MUST defer.
- Already-converged evidence MUST release only exact replayed v6 keys after checkpoint; broad/prefix release or release before checkpoint MUST fail.
- Missing remote absence, local hash mismatch, incomplete folder mapping, occupied unrelated destination, requested echo, conflicting stable identity, and zero-action incomplete evidence MUST prevent destructive authority.
- Reordered non-semantic input MUST preserve deterministic output; large fixtures MUST reject repeated component construction or quadratic rescans.
- Missing provider credentials MUST warn and skip under ADR 0003 and MUST NOT fail the mandatory shared gate. Concrete representation-gap evidence MUST trigger targeted live preverification for only the affected backend; absent such evidence, optional live execution is not a cutover prerequisite.

## Failure ordering assertions

- Observation exception: no fabricated absence and no Admission call.
- Debt upsert failure: no executor or tracker side effect.
- Component deferral/action failure: non-clean result and no checkpoint advance.
- Checkpoint failure: no release/debt deletion.
- Release-key mismatch: unmatched debt retained; no broad retirement.

## Structural fitness functions

- One path-local proposal owner and one Admission component decision owner.
- Exactly one component construction call in the production cycle.
- No production import/call of `refinePlan` or standalone rename optimizer.
- No Google Drive/Dropbox/OneDrive name/type switch under `src/sync/` decision code.
- No change to SyncState version, `RenameDebt` wire fields, checkpoint/SyncRecord formats, executor input type, or command/settings schema.
- No documentation or release claim that this redesign fixes blank files; no Issue #51 implementation or PR #53 content in the package.

## Evidence handoff

Unit 0 hands mandatory shared-conformance results and any backend-specific targeted-live disposition to Unit 1. Unit 1 may proceed when the shared gate passes; a pending targeted-live question holds only the affected backend change. Each later unit attaches focused command results and counterexample/mutation evidence to its acceptance IDs. Unit 3 records ADR disposition, docs/source conformance, structural checks, and the full repository gate.
