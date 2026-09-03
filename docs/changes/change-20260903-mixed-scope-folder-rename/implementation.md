---
change: change-20260903-mixed-scope-folder-rename
role: implementation
---

<!-- lifecycle is owned by change.md -->

# Implementation

## Contract

`partitionMixedScopeFolderEvidence()` is an Admission-private normalization. It may
remove a folder rename edge and its exact root alias from the action-shaping view only
when:

1. both folder roots are included;
2. at least one observed descendant is policy-excluded;
3. no observed descendant is unknown or mobile-deferred; and
4. every included descendant endpoint is covered by an aligned, determinate child
   rename edge from the same origin side.

The original component evidence remains available for diagnostics and local rename
debt lifecycle. Only the normalized evidence is supplied to action shaping and the
component decision. Existing file rename validation then proves exact executable
actions; it is not bypassed. Identical child rename evidence reacquired from fresh and
replayed sources is deduplicated in this normalized action-shaping view so multiplicity
does not change the decision.

`reconstructCaseAliasChildRenames()` handles the COLD replay state where the
case-insensitive local filesystem exposes only the old canonical spelling and the
ordinary path-local proposal is empty. It reconstructs no general action: it admits
only an aligned included child with a local destination-to-source alias, a complete
same-content baseline, an unchanged exact remote source, and an authoritatively absent
remote destination. All other states remain ordinary Admission failures.
