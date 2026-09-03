---
change: change-20260903-mobile-size-input-boundary
role: verification
---

<!-- lifecycle is owned by change.md -->

# Verification

## Content

RED evidence before production changes:

- `npm test -- --run src/sync/sync-cycle-planning.test.ts src/sync/scheduler.test.ts src/sync/scope-fingerprint.test.ts src/sync/orchestrator.test.ts`
- 9 failed / 139 passed, covering BatchObservation contamination, local tracker
  ingress, local and remote rename propagation, mixed folder expansion, remote-grown
  priority, baseline non-stickiness, fingerprint change, and one-shot cold recovery.

GREEN evidence:

- Focused suites: 6 files, 168 tests passed.
- `npm run lint`: passed.
- `npm run lint:bot-repro`: 29 tests passed; production scan found zero unsafe
  diagnostics across all declaration boundaries.
- `npm run build`: TypeScript and production bundle passed.
- `npm run test:coverage`: 90 files, 1715 tests passed.
- `npm run test:e2e`: live Google Drive, Dropbox, and OneDrive suites passed — 3
  files, 163 tests. The earlier credential-less run skipped all three and is not used
  as evidence.
- Independent revised causal critique: approved, no findings or open questions.
- dev-evidence `out-of-scope-changes.v2` and
  `closure.evidence-readiness.v1`: PASS at `scope-7317bcfd40af7979` against the
  pre-change commit `c079bfb`.

Static absence checks:

- No `mobile_deferred` or `mobileMaxBytes` remains in production, active pipeline,
  governing design, or ADR 0008.
- No rename-debt/quarantine claim remains in the active pipeline or orchestrator
  recovery comment. Historical completed change packages remain immutable.
