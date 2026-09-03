---
change: change-20260903-stateless-sync-recovery
role: verification
---

<!-- lifecycle is owned by change.md -->

# Verification

## RED/GREEN matrix

| Contract | RED proof | GREEN acceptance |
|---|---|---|
| No operation journal | Seed old debt/marker schema; absence guard fails on old symbols | Old schemas cold-start; no production debt, marker, resume, release, or replacement journal |
| Unit-only commit | Fail before and after provider effect; spy all state writes | Failed unit keeps prior record; verified successful units alone commit |
| Clean checkpoint | Exercise Admission failure, action failure, superseded action, invalidation | Zero checkpoint commits for non-clean cycles; exactly one for clean cycle |
| Current-state retry | Fail rename, retry in-process and with a new orchestrator | Retry executes immediately from COLD facts; next run is no-op |
| Conflict safety | Rename+edit with remote unchanged, then with remote independently changed | First converges without conflict; second preserves both versions |
| Case-only derivation | Alias/vacant/foreign/exact-casing and folder boundary fixtures | Candidate only for unambiguous baseline/current identity facts |
| Exclusion | Put `desktop.ini` and another policy-out path under renamed folder | Neither appears in observation, evidence, action, record, nor diagnostic inventories |
| Dropbox settlement | Inject failures/lost responses at each leg and endpoint observation | Exact-new succeeds; temp rolls back and verifies old; indeterminate never commits cache |
| No quarantine | Repeat an equivalent authorized action immediately after permanent failure | Second explicit sync invokes provider; there is no TTL `blocked` outcome |

## Completion gates

- Focused suites for state, planning, Admission, executor/finalization, orchestrator, and
  Dropbox all pass after their initial RED is recorded.
- Static absence guard passes with no renamed equivalent of pending/debt/journal state.
- `npm run lint`, `npm run lint:bot-repro`, `npm run build`, and
  `npm run test:coverage` pass.
- Dropbox live E2E verifies case-only file and folder rename when credentials are
  available. If not run, the final report explicitly states that provider behavior and
  the documented hard-kill window remain unverified in a live environment.

## Non-claims

- Tests do not claim atomic recovery from a hard kill between Dropbox moves.
- Tests do not infer arbitrary rename identity after tracker evidence is gone.
- A clean unit test gate does not claim Dropbox's live display-casing behavior was
  verified unless the credential-gated E2E was actually run.
