---
change: change-20260912-restore-exact-binding-occurrence-ownership
role: implementation
---

<!-- lifecycle is owned by change.md -->

# Implementation

## Implementation

Remove the exact-path-only bookkeeping set. When the baseline loop emits an exact
binding, add each present endpoint to the existing `claimedLocal` or `claimedRemote`
set. The final tail continues to use those same claimed sets, restoring the single
occurrence-ownership mechanism used before exact-path materialization was extracted.

Apply the existing historical remote-identity mismatch exclusion before the exact
branch. That record remains a replacement expectation; it must not claim the current
remote occurrence owned by another tracked identity.

Claim the concrete `facts.local` and `facts.remote` endpoints read by the exact
materializer, rather than only identity-derived candidates. Pin both exact dispatch
sites in the architecture guard and cover one-sided abandonment symmetrically.

Do not change `materializeExactPath`, capability selection, or structural rename
materialization.
