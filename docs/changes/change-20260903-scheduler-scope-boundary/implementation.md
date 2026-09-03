---
change: change-20260903-scheduler-scope-boundary
role: implementation
---

<!-- lifecycle is owned by change.md -->

# Implementation

## Content

1. Replace tests that require cross-scope rename evidence with boundary expectations
   and run them against the old implementation as a RED witness.
2. Normalize file rename events directly into included rename pairs or included-only
   dirty paths.
3. Recursively expand cross-scope folder events into included child-file effects,
   discarding excluded roots and descendants before `LocalChangeTracker`.
4. Run focused tests and the complete repository gate.
