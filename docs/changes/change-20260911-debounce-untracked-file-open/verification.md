---
change: change-20260911-debounce-untracked-file-open
role: verification
---

<!-- lifecycle is owned by change.md -->

# Verification

## Root-cause evidence

Personal debug logs repeatedly record `file-open priority completed` with
`outcome:"deferred_to_batch"`, followed one or two milliseconds later by `Sync started`
and a one-file push. Source inspection binds that sequence to baseline absence calling
`deferToBatch`, which calls `requestNormalLifecycle` directly. The create handler had
already armed the independent five-second scheduler debounce.

## RED/GREEN regressions

- Before implementation, the focused suites failed three tests: the priority helper
  returned `deferred_to_batch`, the orchestrator returned no typed outcome while
  starting `runSync`, and the scheduler did not debounce an untracked outcome.
- During the #71 integration, four additional RED cases proved that the initial #72
  implementation checked missing capability or active-batch state before baseline
  absence and did not catch baseline-read failure at that boundary.
- After implementation, the three focused scheduler/orchestrator/priority suites pass
	159 tests. They include create/open/rename/modify coalescing through the real scheduler
	and orchestrator in both create/open orders, event-order independence,
  failed-cycle debounce re-arming, untracked-open liveness, tracked immediate fallbacks,
  baseline-read failure, and destroy-during-await behavior.

## Gate

- `npm run lint`: passed.
- `npm run lint:bot-repro`: passed (55 guard tests).
- `npm run build`: passed after updating the scheduler mock to the narrowed return type.
- `npm run test:coverage`: passed (96 files, 2003 tests; 85.33% statements,
	81.66% branches, 84.59% functions, and 86.78% lines).
- Personal artifact parity: repository and deployed `main.js` both have SHA-256
  `f1d1679a37dff69a0eaea5c5b24cd012a35138e8ba0cea8b276606b83e7b0b9a`.

## Independent review and evidence boundary

The causal re-review approved the baseline-only classification, scheduler-owned
debounce, narrowed orchestrator result, immediate tracked safety fallbacks, and the
destroy-after-await guard with no findings. `dev-evidence` reported only the pre-existing
user-owned `.claude/settings.local.json` and
`src/fs/oauth-disconnect-isolation.test.ts` outside this change; neither is staged.
