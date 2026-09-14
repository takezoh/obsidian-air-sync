---
change: change-20260914-in-flight-local-edit-review-convergence
role: verification
---

<!-- lifecycle is owned by change.md -->

# Verification

## Discriminating evidence

- A temporary generation-insensitive `LocalChangeTracker.acknowledge` mutant changed the
  observed sequence from `hot, hot` to `hot, warm`; the integration test failed.
- A temporary removal of terminal remote-identity comparison caused both adversarial tests
  to fail by exposing the forbidden SyncRecord publication and checkpoint commit.
- A temporary push-only terminal selection applied to pull made the same-size remote-source
  mutation test fail by exposing forbidden SyncRecord publication.
- Both mutants were removed before the final verification tree.

## Final verification

- Focused: 3 files, 250 tests passed.
- `npm run lint`: passed.
- `npm run lint:bot-repro`: 57 guard tests and source scan passed.
- `npm run build`: passed.
- `npm run test:coverage`: 98 files, 2114 tests passed.
- `dev-docs lint --conformance`: passed with zero warnings before this package was added;
  run again after lifecycle materialization.
