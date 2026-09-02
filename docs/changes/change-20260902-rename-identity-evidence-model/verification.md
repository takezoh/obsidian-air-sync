---
change: change-20260902-rename-identity-evidence-model
role: verification
---

<!-- lifecycle is owned by change.md -->

# Verification

## Profiles

| Profile | Tier | Command | Pass criterion |
|---|---|---|---|
| evidence/admission | T0 | `npm test -- src/sync/plan-admission.test.ts` | one-time candidate derivation, deep immutability, legal union exhaustiveness, total disposition/debt matrix, R/Y row |
| conflict preparation/resolver | T0 | `npm test -- src/sync/conflict-resolver.test.ts` | bounded reads; preparation has zero writes; primary/additional naming, dual visibility, bytes, strategy scope, resolver once |
| executor cuts/proof | T1 | `npm test -- src/sync/plan-executor.test.ts` | every resolver/delete/rename/write/proof cut returns failed/blocked without commit/retry/rollback; complete terminal proof only on success |
| per-file CAS | T0 | `npm test -- src/sync/state-committer.test.ts` | raw results rejected and exact-baseline CAS accepts branded proof only |
| finalization | T0 | `npm test -- src/sync/sync-cycle-finalization.test.ts` | clean checkpoint precedes exact release; every nonclean result withholds both; disconnected per-file success remains |
| type closure | T0 | `npm run build` | illegal Cartesian/prepared/proof values cannot compile; no unhandled union variant |
| full repository gate | T1 | `npm run lint && npm run lint:bot-repro && npm run build && npm run test:coverage` | all commands green on the exact implementation head |

## Required adversarial cases

- Foreign Y has bytes equal to local: identity precedence still selects conflict, never convergence.
- R occurs at multiple paths or identity authority is missing: contradicted/unknown, zero action.
- R is at a third path and Y occupies destination: both exact versions are visible and verified
  locally/remotely before destructive effects; configured strategy sees R as primary exactly once.
- `auto_merge` succeeds: exact primary R backup and additional Y output remain; merged target follows
  ordinary strategy semantics.
- `duplicate` is configured: primary preservation output is reused, Y gets its own output, no second
  resolver call occurs.
- First invocation leaves one or more verified outputs then fails: next fresh invocation may generate
  higher-numbered outputs, and tests assert no dedup/exactly-once claim.
- Checksum absent/cross-algorithm and mtime zero: stable double-read progresses; changed read blocks;
  unreadable/auth input fails or blocks within the bounded invocation.
- Remove each terminal proof field independently: state committer rejects the value or build fails.

## Partial-cut matrix

Inject failure before/after every resolver preservation write/readback, configured primary result,
target delete, source rename, target write, terminal stat/read, per-file CAS, checkpoint, and exact
debt release. For every cut, assert the precise external effects that may remain, old/new durable
state, next legal normalized family, absence of raw retry/rollback, and checkpoint/debt behavior.

## Structural fitness functions

- Planning/Admission source scan: no filesystem handle or I/O import in normalization/admission.
- Preparation spies: zero write/delete/rename calls and no conflict-path allocation.
- Resolver spies: it is the only caller allocating/writing preservation outputs and is entered once.
- Executor/source scan and tests: terminal proof helper remains private in `plan-executor.ts`; no new
  terminal-proof module/component.
- State committer type test: fresh CAS requires the branded proof type.
- Finalizer tests: no per-file CAS ownership; checkpoint then exact release only.
- Diff inspection plus lint: no provider/checkpoint API, state schema/store, strategy, deferred,
  pending, journal, workflow engine, raw retry, or rollback surface.

## T2 boundary

No new provider capability is claimed, so opt-in live E2E is not a release gate for this design.
Existing shared backend contracts remain unchanged. Real-provider testing may confirm observations but
cannot be used to claim conditional atomicity or external-writer linearizability.

## Completion

Completion requires all `AC-*` criteria, all profiles green on the exact head, a clean forbidden-
surface inspection, and independent review of the historical three integration findings plus the
twelve critic resolutions.
