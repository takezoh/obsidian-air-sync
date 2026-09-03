---
change: change-20260903-remove-policy-out
role: implementation
---

<!-- lifecycle is owned by change.md -->

# Implementation

## Content

1. Add a RED boundary test proving that a cross-scope rename currently leaks its
   excluded endpoint and relation into `BatchObservation`.
2. Normalize the complete `ChangeSet` at the Observation scope boundary:
   filter entries and baseline membership, sanitize path observations, and retain
   identity evidence only for included occurrences/endpoints.
3. Run scope projection only over the normalized facts. Remove `policy_out`, the
   cross-scope rename consequence matrix, and all Admission fixtures depending on it.
4. Update the active four-stage design, ADR 0008, and sync-pipeline documentation.
   Remove the obsolete mixed-scope change package introduced solely by the reverted
   PR branch.
5. Verify focused tests followed by the repository's complete gate.
