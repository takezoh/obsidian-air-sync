---
change: change-20260912-sync-policy-boundary-simplification
role: verification
---

<!-- lifecycle is owned by change.md -->

# Verification

## Content

### T0 — ownership and mapping

- Verify Prefer-local acquisition retains the exact candidate/read bound and other strategies add zero reads.
- Verify the exhaustive Admission mapping for Auto merge, proven Prefer-local local win,
  Prefer-local preservation, Duplicate preservation, and compound conflicts.
- Verify unsafe-cast missing/malformed/incompatible policy fails before filesystem or committer calls.
- Extend the Admission authority guard to reject foreign compiler imports, downstream raw-policy
  interpretation, optional/default policy, retained proof, and new durable owners.

The final review uses a fixed coverage matrix instead of adding examples one finding at a time:

| Boundary | Required discriminators |
|---|---|
| Preservation-cover validation | canonical full-SHA candidate, source/existing-destination content agreement, candidate/preserved/child partition order, valid published-prefix continuation |
| Policy compatibility | every invalid mode/strategy pair, both non-preserving cover modes, and preserving-cover positives for Duplicate and Prefer-local |
| Prefer-local Admission compiler | the positive local-win proof and each individual fallback predicate |
| Fail-before-I/O | local, remote, committer-local, state-store, and checkpoint capabilities |
| Audit and ownership guard | multiple action-local strategies together; property, element, and destructured raw-strategy access |

Each negative row must reject its named counterexample, not merely pass the aggregate suite.

### T1 — composed behavior and lifecycle

- Run resolver/executor matrices, COLD/WARM/HOT convergence, interruption, exact publication,
  sibling settlement, and commit-or-abort closeout tests.
- Mutate settings during a cycle and prove behavior and audit retain the captured action provenance.
- Confirm action order, preservation-before-destruction, per-file CAS, checkpoint rules, and
  best-effort audit failure behavior are unchanged.

### T2 — repository gate

```bash
npm run lint
npm run lint:bot-repro
npm run build
npm run test:coverage
```

All focused tests, structural guards, and all four gate commands must be green. Tests or rules
may not be disabled. Live provider E2E is not required because no backend contract changes.

## Evidence

- RED witness: the Admission policy-mapping test failed before the required policy was
  added to conflict actions.
- Focused sync suite: Admission, executor, resolver, convergence, orchestrator, and
  Observation planning tests pass together (411 tests).
- Full repository gate after the second review repair: `npm run lint`,
  `npm run lint:bot-repro`, `npm run build`, and `npm run test:coverage` passed.
  Coverage ran 97 files / 2087 tests.
- Documentation conformance indexed 53 artifacts with no warnings; design spine lint
  returned green with 25 anchors and no errors or warnings.
- Sol review findings were reproduced and repaired: same-path Auto merge cannot be
  downgraded to preservation, the compiler import/raw-strategy guards are name-independent,
  executor fixtures no longer synthesize conflict contracts, and preservation-cover
  provenance is tested for all three user strategies.
- The second Sol review findings were also reproduced and repaired: the structural guard
  applies a production-wide default-deny rule to raw strategy interpretation and rejects
  compiler re-exports; executor validation rejects unproven local-win actions before any
  filesystem or state-store I/O; malformed-contract tests cover the I/O surface and a
  policy/protocol matrix; resolver tests call the production policy contract directly.
- The third Sol review findings were reproduced and repaired: local-win validation now
  rejects remote identity replacement; preservation-cover protocols are validated deeply
  before execution; no-I/O tests observe every callable filesystem, checkpoint, and state
  capability; local-win/policy negative matrices and preserve-mode audit provenance are
  discriminating; raw-strategy exceptions are narrowed to exact semantic owner functions,
  and local compiler re-exports are rejected explicitly.
- The convergence repair froze the five-row matrix above before implementation. RED execution
  rejected none of the reversed-child, invented-candidate, or short-digest preservation inputs;
  the focused suite failed exactly those three cases. The repaired validator now requires each
  full-SHA candidate to be canonical and preserves the Admission-authored candidate partition order,
  including a positive published-prefix continuation case.
- Mutation checks proved the new assertions are discriminating: deleting the replacement fallback,
  reading through `committer.localFs` before validation, reusing the first conflict's strategy,
  weakening cover compatibility to Auto-merge only, and restoring property-access-only guard logic
  each made its corresponding focused test fail. Every mutation was reverted before the green run.
- The fixed-scope review found two remaining cross-field counterexamples. Before the repair,
  source/content and existing-destination/content disagreement both passed boundary validation;
  the two new negative tests failed. The validator now requires admitted source and non-missing
  destinations to match the child's exact hash and size before any I/O. A Prefer-local
  preservation-cover positive was also added; a temporary validator mutant that rejected this
  valid pair failed exactly that test and was reverted.
- The cross-field row was then expanded once, by field rather than by later finding: candidate
  digest binding, source hash and size, existing-destination hash and size, and file-kind are each
  independently negative-tested. Removing candidate/content binding, size comparison, or the
  non-directory requirement made only the corresponding focused tests fail; all mutants were
  reverted. This closes the frozen preservation relation without opening new review scope.
- The final fixed-scope Sol closure review approved both disjoint lenses with zero findings:
  correctness F-C1/F-C2 and test-discrimination F-T1..F-T4 are resolved. The repository gate
  then passed with 97 files / 2102 tests, and documentation conformance indexed 53 artifacts
  with no warnings.
- After the convergence repair, the complete repository gate passed again: `npm run lint`,
  `npm run lint:bot-repro`, `npm run build`, and `npm run test:coverage`. Coverage ran
  97 files / 2095 tests; documentation lint indexed 53 artifacts with no warnings.
