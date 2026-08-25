---
change: change-20260825-issue43-destructive-authorization
role: requirements
functional_requirements:
- id: FR-43-01
  statement: Decision Engine and rename refinement produce plain proposals; only Admission
    issues destructive permission from a complete immutable cycle snapshot.
  priority: must
- id: FR-43-02
  statement: Admission emits exactly one disposition for every relevant action-bearing
    or actionless evidence-connected component.
  priority: must
- id: FR-43-03
  statement: Actionless uncertainty is visibly deferred, retains evidence and debt,
    withholds checkpoint advancement, and requests later COLD reevaluation without
    a tight retry.
  priority: must
- id: FR-43-04
  statement: Execution accepts only Admission-issued nominal AuthorizedSyncPlan and
    receives only actions projected from authorized dispositions.
  priority: must
- id: FR-43-05
  statement: Admission alone classifies scope no-op, convergence, identity consistency,
    alias targeting, and permitted destructive postconditions; finalization does not
    recompute them.
  priority: must
- id: FR-43-06
  statement: Authorized-component evidence and debt become releasable only after every
    bound action succeeds; failure or block retains them without changing authorization.
  priority: must
- id: FR-43-07
  statement: Releasable evidence and local debt retire only after safe checkpoint
    commit and remain intact when checkpoint persistence fails.
  priority: must
- id: FR-43-08
  statement: Remote evidence is captured before later fallible work; an exception
    strictly before Admission retains it and requests COLD recovery without fabricating
    a disposition.
  priority: must
- id: FR-43-09
  statement: Disconnected authorized actions preserve proposal order and may commit
    per-file state while another component is deferred, without checkpoint advancement.
  priority: must
- id: FR-43-10
  statement: Every deferred disposition contributes exactly once to partial status,
    notification count, diagnostics, checkpoint withholding, and later COLD recovery.
  priority: must
- id: FR-43-11
  statement: Issue 46 remains owned by OneDrive backend and cache evidence production
    and is verified independently by its casing regression and an Admission-constant
    A/B pipeline test.
  priority: must
- id: NFR-43-01
  statement: Equal immutable snapshots produce equal disposition membership, reason
    ordering, and authorized action order without I/O or mutation.
  priority: must
- id: NFR-43-02
  statement: The design adds no lifecycle manager, persistent component graph, remote
    debt, or duplicate normative evidence DTO.
  priority: must
---

# Requirements
