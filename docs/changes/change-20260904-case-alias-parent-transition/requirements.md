---
change: change-20260904-case-alias-parent-transition
role: requirements
functional_requirements:
- id: FR-CAPT-001
  statement: When complete current-cycle evidence proves one included case-only parent
    mapping, Admission shall retain every child content action, replace only topology-only
    descendant renames, and authorize exactly one existing explicit parent folder
    rename in the same plan.
  priority: must
- id: FR-CAPT-002
  statement: Equal complete component facts shall produce the same Admission decision
    under COLD, WARM, and HOT without a prior-failure input, recovery branch, new
    status, or additional correctness owner.
  priority: must
- id: FR-CAPT-003
  statement: Requested spelling shall never prove provider topology or re-key the
    cache; only provider-resolved metadata or a successfully completed explicit
    rename endpoint may establish projected topology.
  priority: must
- id: FR-CAPT-004
  statement: A cycle shall not commit the remote cursor past any admitted child content
    work; each SyncRecord commits only after its own admitted I/O, and cursor plus
    complete derived cache commit only after a wholly clean plan.
  priority: must
- id: FR-CAPT-005
  statement: The executor shall execute the authorized plan exactly through the existing
    transfer, serial-conflict, and structural barriers so child content effects finish
    before the explicit parent folder rename.
  priority: must
- id: FR-CAPT-006
  statement: Incomplete descendant mapping, ambiguous provider resolution, a foreign
    or recreated destination identity, or a changed mutation precondition shall fail
    closed and leave the working view uncommitted.
  priority: must
- id: NFR-CAPT-001
  statement: Provider resolution shall reuse the attempt-local live cache, perform
    at most one lookup per previously unresolved parent segment and one existing-child
    lookup per mutation, and add no parent lookup for later sibling mutations.
  priority: must
- id: NFR-CAPT-002
  statement: The repair shall add no action type, generic DAG, executor re-admission,
    persisted evidence, schema migration, recovery instruction, Admission status,
    or correctness-critical in-memory state.
  priority: must
---

<!-- lifecycle is owned by change.md -->

# Requirements

## Content

### Outcome

A case-only parent-folder transition converges in one ordinary sync cycle without losing child content work, fabricating provider topology, or introducing recovery state. Admission decides the complete identity component; the cache-backed filesystem validates provider-resolved targets; Execution preserves its existing exact phase order; the remote checkpoint remains commit-last.

### Functional requirements

- **FR-CAPT-001 — same-cycle component plan.** When complete current-cycle evidence proves one included case-only parent mapping, Admission shall retain every child content action, replace only topology-only descendant renames, and authorize exactly one existing `rename_remote(oldParent, newParent, isFolder=true)` action in the same plan.
- **FR-CAPT-002 — temperature-independent decision.** Equal complete component facts shall produce the same Admission decision under COLD, WARM, and HOT without a prior-failure input, recovery branch, new status, or additional correctness owner.
- **FR-CAPT-003 — provider-proven topology.** Requested spelling shall never prove provider topology or re-key the cache. Only provider-resolved metadata or a successfully completed explicit rename endpoint may establish projected topology.
- **FR-CAPT-004 — no cursor past unfinished content.** A cycle shall not commit the remote cursor past admitted child content work. Each `SyncRecord` commits only after its own admitted I/O; cursor plus complete cache commit only after a wholly clean plan.
- **FR-CAPT-005 — exact phase order.** The executor shall preserve the existing transfer, serial-conflict, and structural barriers, placing all child content effects before the explicit parent folder rename.
- **FR-CAPT-006 — fail-closed identity boundary.** Incomplete descendant mapping, ambiguous provider resolution, a foreign or recreated destination identity, or a changed mutation precondition shall fail closed and leave the remote working view uncommitted.

### Non-functional requirements

- **NFR-CAPT-001 — bounded provider resolution.** Reuse the attempt-local live cache; perform at most one provider lookup for each previously unresolved parent segment and one existing-child lookup per mutation; later sibling mutations add no parent lookup. Do not prefetch or add a second resolver cache.
- **NFR-CAPT-002 — closed mechanism set.** Add no action type, generic DAG, executor re-admission, persisted evidence, schema migration, recovery instruction, Admission status, new folder identity, or correctness-critical in-memory state.

### Acceptance scenarios

1. Given a complete COLD component whose provider parent is `Templates`, local/baseline intent is `TemplateS`, one child is remote-only changed, and another conflicts, when Admission authorizes the component, then the plan contains both child content actions and exactly one parent folder rename; when executed, both content actions finish before the rename and only then may the cursor/cache checkpoint commit.
2. Given equal complete component facts acquired through COLD, WARM, and HOT, when Admission decides each component, then the normalized action sets are equal and no prior failure or acquisition-mode status is an input.
3. Given a request through `TemplateS` whose provider metadata still names the same folder `Templates`, when a child mutation resolves its target, then the cache remains keyed by provider-proven `Templates`, the existing child identity is updated, and no duplicate is created.
4. Given an explicit provider rename response naming the same folder identity `TemplateS`, when the live projection applies that response, then the folder and descendants re-key to `TemplateS` and may publish only with the clean checkpoint.
5. Given an incomplete mapping, multiple matching children, or a foreign/recreated destination, when Admission or the filesystem evaluates the operation, then it rejects the operation without fallback create, implicit merge, parent-only success, or cursor advancement.
6. Given several sibling writes below one unresolved parent, when the first resolves the parent and later siblings run, then the total parent lookups equal the previously unresolved segments and later siblings add zero parent lookups for Google Drive, OneDrive, and Dropbox fixtures.

### Counterexamples that must fail

- A parent-only clean first cycle that drops a remote-only child and advances the cursor.
- Cache re-key from requested echo while provider metadata still reports the old spelling.
- A `pageSize=1` Google response treated as uniqueness proof when a second same-name child can exist.
- Executor-inferred ancestor rename, dependency DAG, late Admission, or a new recovery/defer status.
- Cursor/cache publication after any admitted action is absent, failed, blocked, or lacks terminal proof.

### Non-goals

No provider cleanup workflow for an already-created duplicate; no live-provider semantics guarantee beyond observed evidence; no schema or settings migration; no executor scheduler redesign; no generalized rename graph; no persistent component or folder identity.
