---
change: change-20260903-four-stage-sync-pipeline
role: implementation
---

<!-- lifecycle is owned by change.md -->

# Implementation

## Fixed contracts

- `BatchObservation` is fact-only. It contains observed entries, identity evidence, observations, scope, namespace, baseline paths, and replay metadata, but no plan.
- Admission alone invokes the path-local decision helper, builds identity components, shapes/authorizes exact actions, and returns `AuthorizedSyncPlan` plus lifecycle dispositions.
- Executor and finalizer contracts remain exact-plan based. No provider, checkpoint, storage, phase, conflict, or priority contract changes.
- The four stages are structural owners. Private helpers do not become additional top-level stages.

## Dependency-ordered units

1. **Observation carriers:** replace the pre-Admission plan snapshot with a deeply readonly fact-only `BatchObservation`; update observation tests and callers.
2. **Admission authority:** move `planSync()` invocation behind Admission, keep component/action shaping there, and add an import-boundary fitness function.
3. **Execution and orchestration integration:** wire the fact-only observation into Admission, preserve exact `AuthorizedSyncPlan` execution/finalization, diagnostics, priority behavior, and convergence tests.
4. **Commit/finalization and durable design:** verify terminality/checkpoint/debt behavior remains unchanged; update architecture docs, accepted ADR, and governing design.

## Explicit exclusions

Do not add runtime re-Admission, per-component point observation, dynamic rerouting, epochs, receipts, new outcome states, provider APIs, or persistence changes.
