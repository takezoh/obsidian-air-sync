---
change: change-20260912-restore-exact-binding-occurrence-ownership
role: verification
---

<!-- lifecycle is owned by change.md -->

# Verification

## Verification

- A RED Admission regression reproduces exact-plus-alias double binding before the fix.
- GREEN requires `unknown_observation` with no executable actions for that incomplete
  component.
- Existing Admission suites retain exact deletion, cleanup, native rename, preservation,
  and publication-CAS behavior.
- RED produced both `conflict(case.md)` and `rename_remote(Case.md -> case.md)` from the
  same local occurrence.
- A second RED reversed baseline iteration order and reproduced two actions from the
  same local occurrence.
- A third RED used two historical identities sharing a current exact address and
  reproduced two actions from the same remote occurrence.
- A fourth RED omitted the provider's optional stable identity and reproduced two
  conflicts from the same remote occurrence.
- GREEN applies one precomputed occurrence claim to exact and structural branches and
  excludes historical identity mismatches before exact binding; exact binding claims
  the endpoints its materializer reads. The focused Admission suite passed 129 tests.
- A symmetric remote-only relation-abandonment test verifies pull with retained
  publication CAS.
- The authority guard now rejects replacing either ordinary exact dispatch site with
  a hand-built structural binding; its focused suite passed 11 tests.
- `npm run lint`: passed.
- `npm run lint:bot-repro`: passed (56 guard tests).
- `npm run build`: passed.
- `npm run test:coverage`: passed (96 files, 2016 tests; 85.40% statements,
  81.74% branches, 84.63% functions, 86.84% lines).
- `fake_green_guard.py --base f50b728`: passed with no findings.
- Independent Sol cross-task review reproduced the identity-unavailable duplicate
  binding and exact-dispatch guard false-green; after both corrections, its final
  rereview verdict was `approved` with no findings.
