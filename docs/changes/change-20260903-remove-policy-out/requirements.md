---
change: change-20260903-remove-policy-out
role: requirements
---

<!-- lifecycle is owned by change.md -->

# Requirements

## Content

### R1 — Excluded paths do not exist to the sync engine

Given physical entries, observations, baseline records, or identity evidence that
refer to a path rejected by the configured scope policy, when Observation constructs
`BatchObservation`, then that path must not occur in entries, observations, evidence,
scope projection, or baseline membership.

### R2 — Cross-scope rename is not an engine concept

Given a reported rename with exactly one included endpoint, when Observation applies
scope, then it must discard the rename relation and excluded endpoint. The remaining
included entry is planned from its own current and baseline facts as an ordinary
create or delete. Given two excluded endpoints, no fact from the rename reaches the
engine. Given two included endpoints, the rename relation remains intact.

### R3 — No excluded-path disposition

The engine's scope vocabulary must contain only facts it can act on or must fail
closed for: `included`, `mobile_deferred`, and `unknown`. It must not contain
`policy_out` or another renamed equivalent.

### Counterexamples

- Keeping an excluded rename endpoint as a constraint is invalid.
- Allowing an excluded descendant to affect folder completeness or component failure
  is invalid.
- Removing only the `policy_out` spelling while retaining equivalent state or branches
  is invalid.
