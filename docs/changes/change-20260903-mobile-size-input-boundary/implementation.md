---
change: change-20260903-mobile-size-input-boundary
role: implementation
---

<!-- lifecycle is owned by change.md -->

# Implementation

## Content

1. Make the boundary predicate accept optional current size metadata.
2. Collect and rename-propagate current sizes before filtering `ChangeSet` facts.
3. Reduce `ScopeDisposition` to `included | unknown`; retain fail-closed unknown
   evidence without any deterministic policy state.
4. Apply the predicate before every scheduler tracker mutation and expand mixed folder
   renames to eligible file effects.
5. Apply the same predicate before priority remote observation when local size is
   sufficient, and after metadata observation before content I/O for remote growth.
6. Fingerprint the effective mobile byte threshold.
7. Update governing docs that currently retain `mobile_deferred`.
