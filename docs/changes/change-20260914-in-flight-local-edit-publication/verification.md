---
change: change-20260914-in-flight-local-edit-publication
role: verification
---

<!-- lifecycle is owned by change.md -->

# Verification

## Success conditions

- The first push publishes a `SyncRecord` and merge base for the exact captured bytes when a
  same-size or different-size local revision arrives during the write.
- SHA-256 and MD5-only remote metadata both prove the captured remote terminal without
  cross-algorithm comparison.
- A captured entity without a locally computable content key does not cause a post-write
  local reread.
- The later tracker generation survives clean closeout and the next HOT cycle performs an
  ordinary push without conflict.
- Remote corruption/identity replacement, CAS failure, pull mutation, rename/conflict
  failure, and incomplete checkpoint controls remain non-clean.
- No new receipt/export/state owner/provider method/recovery branch is introduced.

## T0 — focused contract evidence

Run:

```bash
npm test -- src/sync/local-edit-during-push.repro.test.ts
npm test -- src/sync/plan-executor.test.ts
npm test -- src/sync/orchestrator.test.ts
```

The tests must assert exact remote bytes, record hash/size, merge-base content, action
outcomes, tracker generation, checkpoint calls, next-cycle action kind, and absence of
conflict artifacts. Timing or timestamp assertions alone are insufficient.

## T1 — protocol and lifecycle regression evidence

Run:

```bash
npm test -- src/sync/plan-executor.test.ts src/sync/conflict-resolver.test.ts
npm test -- src/sync/sync-cycle-finalization.test.ts src/sync/orchestrator.test.ts
npm run lint:bot-repro
```

The remote-corruption control must publish no affected record/base/checkpoint. Pull, rename,
conflict, exact-CAS, and state-ownership controls must retain their prior outcomes.

## T2 — repository gate

Run exactly:

```bash
npm run lint && npm run lint:bot-repro && npm run build && npm run test:coverage
```

All commands must pass. In addition, inspect the diff for new exported proof/receipt types,
retained receipt collections, durable stores or fields, provider methods, action/status
kinds, recovery branches, and ownership-guard fixture changes; the expected count is zero.

Live-provider reproduction may be recorded as corroborating operational evidence, but it is
not a correctness prerequisite and must not replace the deterministic matrix.
