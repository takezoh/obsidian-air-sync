---
change: change-20260902-sync-outcome-convergence
role: verification
---

<!-- lifecycle is owned by change.md -->

# Verification

## T0 — pure and focused

- Admission matrix covers the six fresh states, precedence, unknown zero-action, local rename-edit non-conflict, remote/destination conflict, and one compound action only.
- Executor tests inject failure before/after rename, post-rename observation, current-local read, write, terminal observation, and state commit. Baseline commits only after terminal verification; rollback and blind rename retry calls are zero.
- Resolver tests map old base/new local/current remote paths into existing `auto_merge | duplicate`, preserve observed remote content under that existing contract, and prove at most one resolver delegation per fresh invocation. They do not infer prior-output ownership from content or assert cross-invocation artifact deduplication.
- Static/type tests prove no journal/payload/attention/checkpoint-receipt/conditional-provider/store surface and unchanged `IFileSystem`/checkpoint types.

## T1 — integrated fresh recovery

- Reconstructed-instance and same-session tests classify crash cuts as old-path baseline, post-rename old content, converged, changed/destination conflict, or unknown using current state only.
- Observation/transport exhaustion creates no pending row, retains old baseline/checkpoint, reports current error status, and the next ordinary trigger performs a fresh acquisition.
- Stale cache over changed live evidence cannot select unchanged convergence.
- A v6 fixture is candidate-only, cannot directly authorize I/O, and is exact-deleted only after existing successful consequence and clean checkpoint; failure/unknown/checkpoint failure retains it.
- A failed component stops while disconnected work completes its `SyncRecord`; checkpoint remains withheld.

## T2

No new provider capability or live-provider rollout gate exists. Existing shared provider contract discipline and opt-in live E2E remain unchanged and are not used to claim conditional atomicity.

## Final gate

```bash
npm run lint
npm run lint:bot-repro
npm run build
npm run test:coverage
```

Success requires `AC-01` through `AC-07`, accepted fresh reconciliation ADR, rejected old proposals with consultation provenance, spine/docs/conformance lint green, and no removed mechanism in the implementation plan.
