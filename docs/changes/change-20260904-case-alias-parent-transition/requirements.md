---
change: change-20260904-case-alias-parent-transition
role: requirements
functional_requirements:
- id: FR-CAPU-001
  statement: Admission shall transform each applicable case-alias parent component
    into one normalized candidate action set, route that candidate through exactly
    one final component evaluator, and emit no terminal disposition before that evaluator
    returns.
  priority: must
- id: FR-CAPU-002
  statement: When complete current facts contain a valid target-keyed child SyncRecord,
    the unique current provider-old occurrence of that identity, retained child content
    work, and one complete included case-only parent mapping, Admission shall authorize
    the content work followed by exactly one existing parent rename_remote action.
  priority: must
- id: FR-CAPU-003
  statement: A cross-path stable-identity edge without controlling reported rename
    evidence shall be covered only by the exact current occurrence to unique committed
    baseline occurrence pair for the same opaque stable identity inside one validated
    complete parent rename_remote mapping; an intended endpoint without that occurrence
    shall not establish coverage.
  priority: must
- id: FR-CAPU-004
  statement: Unrelated, absent, incomplete, crossed, duplicated, wrongly directed,
    out-of-scope, unresolved, or identity-conflicting coverage shall retain the existing
    applicable fail-closed reason and authorize no partial component plan.
  priority: must
- id: FR-CAPU-005
  statement: The repair shall preserve existing reported native rename decisions,
    unbaselined single-file case-alias canonicalization, standalone deletion authority,
    failure reason vocabulary, and disconnected proposal ordering.
  priority: must
- id: FR-CAPU-006
  statement: Equal complete component facts shall produce the same Admission actions,
    disposition, and reasons after COLD, WARM, or HOT acquisition, with no temperature,
    global-state, schema-version, or prior-failure input.
  priority: must
- id: FR-CAPU-007
  statement: Each file SyncRecord shall remain committed only after its admitted I/O
    and cursor plus complete derived cache plus scope shall remain committed only
    after a wholly clean cycle; retry shall use ordinary current-fact acquisition.
  priority: must
- id: NFR-CAPU-001
  statement: The implementation shall add no action, disposition, status, failure
    reason, evidence kind, persisted field, schema, migration, recovery branch, provider
    branch, exported policy owner, or correctness-critical in-memory owner.
  priority: must
- id: NFR-CAPU-002
  statement: The evaluator shall derive one validated topology-coverage relation exactly
    once per component without I/O in O(A + D + E + S) time and O(D) cycle-local auxiliary
    space, where A, D, E, and S are actions, mapped descendants, evidence items, and
    relevant scope endpoints; repeated per-edge rescans are non-conforming.
  priority: must
- id: NFR-CAPU-003
  statement: Fresh dependency and change-surface evidence shall be green before production
    implementation begins; a newly discovered caller, owner, or cross-boundary dependency
    shall stop implementation and return the design for revision.
  priority: must
---

<!-- lifecycle is owned by change.md -->

# Requirements

## Content

### Outcome

A case-only parent retry that contains a valid target-keyed child record converges through ordinary current-fact Admission. Component-local normalizers shape one candidate, one action-aware evaluator proves the final postcondition, and only the exact current occurrence to unique committed baseline occurrence of the same opaque identity may borrow complete parent-rename coverage. No recovery state or additional authority is introduced.

### Functional requirements

- **FR-CAPU-001 — one terminal owner.** When Admission finishes component-local candidate shaping, it shall route the candidate through `evaluateIdentityComponent` exactly once before emitting exactly one existing disposition; no normalizer may authorize or settle the component first.
- **FR-CAPU-002 — mixed-record convergence.** When complete facts contain a valid target-keyed child `SyncRecord`, its unique current provider-old occurrence, retained child content work, and one complete included case-only parent mapping, Admission shall authorize the content work followed by exactly one existing parent `rename_remote`.
- **FR-CAPU-003 — exact occurrence edge.** A no-reported-rename stable-identity edge shall be covered only by the exact directed pair from the same opaque identity's unique current occurrence to its unique committed baseline occurrence inside one validated complete parent mapping. A merely intended destination shall not establish coverage.
- **FR-CAPU-004 — fail-closed preservation.** Unrelated, absent, incomplete, crossed, duplicated, reversed, out-of-scope, unresolved, or identity-conflicting coverage shall retain the existing applicable failure reason and authorize no partial component plan.
- **FR-CAPU-005 — compatibility.** Existing reported native rename, unbaselined single-file case-alias canonicalization, standalone delete authority, reason vocabulary and precedence, and disconnected proposal order shall remain unchanged.
- **FR-CAPU-006 — fact-equivalent temperatures.** Equal complete immutable component facts shall produce the same Admission actions, disposition, and reasons after COLD, WARM, or HOT acquisition without temperature, global-state, schema-version, or prior-outcome input.
- **FR-CAPU-007 — existing durable authority.** Each file record shall commit only after its admitted I/O. Cursor, complete derived cache, and scope shall commit only after a wholly clean cycle; retry shall use ordinary current-fact acquisition.

### Non-functional requirements

- **NFR-CAPU-001 — closed mechanism set.** Add no action, disposition, status, failure reason, evidence kind, provider branch, persisted field, schema, migration, recovery branch, exported policy owner, or correctness-critical in-memory owner.
- **NFR-CAPU-002 — one linear derivation.** Derive one validated topology-coverage relation exactly once per component without I/O in `O(A + D + E + S)` time and `O(D)` auxiliary space, where the terms are actions, mapped descendants, evidence items, and relevant scope endpoints. Alias and stable-identity predicates shall share it; repeated per-edge rescans are forbidden.
- **NFR-CAPU-003 — fresh evidence gate.** Refresh dependency and change-surface evidence before production edits. Any unknown, stale, conflicting, or newly expanded owner/dependency shall stop implementation for design revision.

### Acceptance scenarios

1. Given a complete parent component with a target-keyed child baseline, one same-identity provider-old current occurrence, retained content work, and an exact complete descendant pair, when Admission evaluates the normalized component, then it emits one authorized disposition containing the content action and exactly one parent rename.
2. Given the same intended destination but no matching unique committed baseline occurrence for that identity, when Admission evaluates the component, then it emits one failed `identity_postcondition_unproven` disposition and no executable action.
3. Given a determinate `normalizeLocalMove` candidate whose remote-current slot also contains a second opaque identity key, when Admission evaluates it, then the candidate still reaches the final evaluator and yields exactly one failed `conflicting_identity` disposition with zero executable actions.
4. Given one exactly covered stable edge and one uncovered edge in the same component, when Admission evaluates it, then the whole component fails and no covered subset executes.
5. Given equal complete facts supplied by COLD-, WARM-, and HOT-labelled acquisition fixtures, when Admission decides each, then actions, dispositions, and reasons are identical without a temperature or prior-failure field.
6. Given child success followed by parent structural failure, when finalization closes the attempt and a later sync runs, then the child record remains valid, cursor/cache/scope remain at the prior checkpoint, the live view was aborted, and the later attempt re-observes current facts without recovery state.

### Counterexamples that must fail

- `normalizeLocalMove` authorizes or resolves a component before `evaluateIdentityComponent` can observe `conflicting_identity`.
- An intended path substitutes for the same identity's absent or non-unique committed baseline occurrence.
- Alias validation and stable-identity validation derive separate coverage notions or rescan actions/descendants for each edge.
- A mapped sibling masks an unrelated, incomplete, crossed, duplicate, or reversed edge.
- Cursor/cache/scope publishes after any admitted action is absent, failed, blocked, or lacks terminal proof.
- A retry depends on previous failure, COLD/WARM/HOT selection, a marker, debt, pending action, schema version, or global record count.

### Non-goals

No provider or filesystem change; no executor scheduler redesign; no generalized rename graph; no persisted component/folder identity; no schema or settings migration; no cleanup workflow; no live-provider semantics guarantee; and no special recovery or compensation path.
