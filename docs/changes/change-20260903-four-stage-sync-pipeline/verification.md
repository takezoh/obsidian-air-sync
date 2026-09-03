---
change: change-20260903-four-stage-sync-pipeline
role: verification
---

<!-- lifecycle is owned by change.md -->

# Verification

## RED witness

Add the production import restriction first. It must fail while `sync-cycle-planning.ts` imports `decision-engine.ts`, proving the existing five-stage boundary violates the approved architecture. Then move action construction into Admission and require the same lint rule to pass.

Observed RED:

- `npm run lint` rejected the `sync-cycle-planning.ts -> decision-engine.ts` production import after the boundary rule was added.
- `npm run build` then rejected the old Orchestrator call because a fact-only `BatchObservation` is not an `AdmissionSnapshot` and has no `plan`.

## Focused verification

- Observation carrier tests prove no plan is captured before Admission and input facts are copied/frozen as required.
- Admission tests prove observed entries are converted to the same exact action set and dispositions.
- Convergence tests prove rename plus content edit converges to a fixed point and concurrent Remote divergence still uses conflict handling.
- Executor/finalization tests prove exact-action execution, checkpoint commit-last, and debt retention are unchanged.
- Architecture checks prove production `decision-engine` imports are Admission-only.

## Commands

```bash
npm run lint
npm test -- --run src/sync/plan-admission.test.ts src/sync/decision-engine.test.ts src/sync/plan-executor.test.ts src/sync/sync-cycle-finalization.test.ts src/sync/convergence.test.ts
npm run lint
npm run lint:bot-repro
npm run build
npm run test:coverage
```

No live-provider E2E is required because provider behavior and interfaces do not change.

## Result

- Focused boundary, Admission, Execution, finalization, convergence, and Orchestrator tests: 7 files, 276 tests passed.
- Repository gate: lint passed; Dashboard reproduction passed (29 tests); build passed; coverage passed (91 files, 1726 tests).
- Coverage: 86.51% statements, 81.08% branches, 86.42% functions, 87.54% lines.
- Provider interfaces, persistence schema, action algebra, conflict policy, and checkpoint/debt policy were unchanged.
- Independent cross-task review findings were closed by making the carrier deeply readonly and driving both production boundary entry points directly from tests.
