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
- After implementation, focused scheduler/orchestrator/priority tests pass, including
  create/open/rename coalescing, untracked-open liveness, tracked missing-identity
  immediate fallback, and destroy-during-await behavior.

## Gate

- `npm run lint`: passed.
- `npm run lint:bot-repro`: passed (55 guard tests).
- `npm run build`: passed after updating the scheduler mock to the narrowed return type.
- `npm run test:coverage`: passed (96 files, 1991 tests; 85.33% statements,
  81.62% branches, 84.59% functions, and 86.78% lines).
- Personal artifact parity: repository and deployed `main.js` both have SHA-256
  `f088f2f7d1f1750fd980ba83bb776edb98f3b7606998a8bc43eee0eec4bd94b3`.

## Independent review and evidence boundary

The causal re-review approved the baseline-only classification, scheduler-owned
debounce, narrowed orchestrator result, immediate tracked safety fallbacks, and the
destroy-after-await guard with no findings. `dev-evidence` reported only the pre-existing
user-owned `.claude/settings.local.json` and
`src/fs/oauth-disconnect-isolation.test.ts` outside this change; neither is staged.
