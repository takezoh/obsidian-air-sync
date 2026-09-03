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
- `npm run lint`: passed.
- `npm run lint:bot-repro`: passed (29 tests).
- `npm run build`: passed.
- `npm run test:coverage`: passed (91 files, 1731 tests).
