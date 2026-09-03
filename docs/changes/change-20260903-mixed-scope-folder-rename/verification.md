---
change: change-20260903-mixed-scope-folder-rename
role: verification
---

<!-- lifecycle is owned by change.md -->

# Verification

## Evidence

- RED: the local mixed-scope fixture produced a native folder action and failed with
  `incomplete_folder_mapping`.
- Focused positive tests cover local-origin case-only alias evidence and symmetric
  remote-origin child renames. A separate fixture reproduces duplicate fresh/replayed
  child evidence from the live log.
- Counterexamples retain fail-closed behavior for missing included-child evidence and
  unknown descendant scope.
- The live post-failure shape is covered: COLD replay, duplicate debt evidence, zero
  ordinary proposal actions, and local destination aliasing the old case spelling.
- Topology tests use arbitrary user-ignore, hidden, and reserved-path representatives
  and prove that all `policy_out` sources become footprint constraints rather than
  managed identity evidence. `unknown` and `mobile_deferred` remain fail-closed.
- `npm run lint`: passed.
- `npm run lint:bot-repro`: passed (29 tests).
- `npm run build`: passed.
- `npm run test:coverage`: passed (92 files, 1736 tests).
