---
change: change-20260912-unify-exact-path-admission
role: implementation
---

<!-- lifecycle is owned by change.md -->

# Implementation

## Implementation

`identity-component-decision.ts` now gives `materializeExactPath` the sole ownership of
same-address endpoint lookup, absence validation, exact-key baseline lookup, comparison
selection, publication expectation, and action materialization. Its discriminated
capability makes preservation and deletion propagation explicit without caller-origin
modes or boolean policy flags.

Relation abandonment requests preservation, while unclaimed ordinary bindings request
deletion propagation. Native rename, folder, replacement, preservation-cover,
execution, publication-store, and checkpoint mechanisms remain unchanged.
