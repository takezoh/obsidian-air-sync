---
change: change-20260912-unify-exact-path-admission
role: verification
---

<!-- lifecycle is owned by change.md -->

# Verification

## Verification

- Focused Admission tests cover retained comparison baselines and one-sided abandoned
  push publication CAS.
- The convergence suite covers an incomplete cycle followed by a new local file push,
  absence of a conflict duplicate, and a zero-action next cycle.
- The Admission authority AST guard requires an outcome-discriminated helper that owns
  exact-path materialization and is used by both ordinary and abandonment paths.
- `npm run lint`: passed.
- `npm run lint:bot-repro`: passed (56 guard tests).
- `npm run build`: passed.
- `npm run test:coverage`: passed (96 files, 2011 tests; 85.38% statements,
  81.65% branches, 84.63% functions, 86.82% lines).
- `fake_green_guard.py --base f50b728`: passed with no findings.
- `docs lint --conformance`: passed with no warnings.
- `dev-evidence` inspected 13 changed paths. The declared implementation and predecessor
  closure paths are in scope; `.claude/settings.local.json` and
  `src/fs/oauth-disconnect-isolation.test.ts` are pre-existing user-owned untracked files
  and remain untouched outside this change.
