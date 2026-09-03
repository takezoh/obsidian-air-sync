---
change: change-20260904-case-only-rename-continuity
role: requirements
functional_requirements:
- id: FR-CCR-01
  statement: When a clean cycle commits, atomically persist final live remote-cache
    values or absences from both delta acquisition and successful executor mutations
    with cursor and scope.
  priority: must
- id: FR-CCR-02
  statement: When write, mkdir, rename, delete, implicit parent creation, or folder
    subtree mutation changes a caching backend cache, register every affected old/new
    root, descendant, and parent path in one deferred checkpoint projection on all
    three backends.
  priority: must
- id: FR-CCR-03
  statement: If action, Admission, or checkpoint persistence fails, advance neither
    durable file map nor cursor/scope and retain the in-memory projection footprint
    until clean commit, reset, or full-scan supersession.
  priority: must
- id: FR-CCR-04
  statement: When a rename or alias relation needs continuity proof, preserve committed/current
    same-root identity occurrences cycle-locally without emitting same-path evidence
    for unrelated ordinary unchanged rows.
  priority: must
- id: FR-CCR-05
  statement: When evaluating a folder relation, use the complete non-empty suffix-preserving
    one-to-one set of included managed descendant file identities as folder continuity
    without inventing a folder-root identity.
  priority: must
- id: FR-CCR-06
  statement: When endpoints authoritatively converge and file or folder continuity
    is proved, resolve a zero-action reported rename without filesystem I/O and permit
    clean finalization.
  priority: must
- id: FR-CCR-07
  statement: When COLD current state uniquely proves an old-to-new case-only folder
    relation after reported evidence is gone, reconstruct it and authorize only existing
    match and cleanup bookkeeping needed to converge SyncRecord paths.
  priority: must
- id: FR-CCR-08
  statement: If identity is foreign, missing, duplicate, incomplete, ambiguously case-folded,
    or linked by an unrelated alias, authorize no destructive interpretation, report
    an existing failure reason, and withhold the checkpoint.
  priority: must
- id: NFR-CCR-01
  statement: Preserve four-stage ownership and existing public and persisted contracts
    without a journal, operation intent, receipt, folder identity, schema migration,
    new evidence or status vocabulary, Orchestrator policy, or ordinary full-cache
    rewrite.
  priority: must
---

<!-- lifecycle is owned by change.md -->

# Requirements

## Content

### FR-CCR-01 — Final cache projection at clean checkpoint

When a clean cycle commits its checkpoint, it shall atomically persist the final live
remote-cache values or absences produced by delta acquisition and successful
executor-side filesystem mutations together with the cursor and scope fingerprint.

### FR-CCR-02 — Complete mutation footprint on every caching backend

When write, mkdir, rename, delete, implicit parent creation, or folder subtree mutation
changes the live cache, Google Drive, Dropbox, and OneDrive shall include every affected
old/new root, descendant, and parent key in the same deferred checkpoint projection.

### FR-CCR-03 — Commit-last failure behavior

If an action, Admission component, or checkpoint transaction fails, the system shall
advance neither the durable file map nor its cursor/scope and shall retain the in-memory
projection footprint for a later clean commit unless reset or a full scan supersedes it.

### FR-CCR-04 — Sparse cycle-local continuity evidence

When a reported rename/alias or candidate current-state case-only relation needs
continuity proof, Observation shall retain committed and current same-root remote
identity occurrences through the existing `stable_identity` carrier. It shall not emit
same-path identity evidence for unrelated ordinary unchanged rows.

### FR-CCR-05 — Folder continuity from managed descendants

When Admission evaluates a folder relation, it shall treat the complete, non-empty,
suffix-preserving, one-to-one set of included managed descendant file identities as the
folder's logical continuity. Each pair shall have the same non-empty committed/current
remote identity. No persisted folder record or folder-root identity shall be added.

### FR-CCR-06 — Proven actionless self echo

When old/new endpoints are authoritatively converged and file or folder continuity is
proved, Admission shall classify a zero-action reported rename as
`resolved_no_action`, perform no filesystem effect, and permit clean finalization.

### FR-CCR-07 — Recovery after relation loss

When a COLD observation has no reported rename but baseline old-casing paths and current
local/remote new-casing paths uniquely prove the same case-only folder relation,
Observation shall emit that relation with `current_state` authority. Admission shall
permit only existing `match` and `cleanup` bookkeeping required to converge SyncRecord
paths; the following clean sync shall be idle.

### FR-CCR-08 — Foreign, incomplete, and unrelated states fail closed

When identity differs, is missing, is duplicated, cannot cover the complete included
managed descendant set, admits multiple case-fold relations, or an alias is unrelated to
the exact proved relation, Admission shall authorize no destructive interpretation,
report an existing specific failure, and withhold the checkpoint.

### NFR-CCR-01 — Minimal compatibility surface

The repair shall preserve the four-stage pipeline and existing public/persisted
contracts. It shall add no schema migration, journal, operation intent, provider receipt,
folder identity field, evidence/status vocabulary, Orchestrator decision, or ordinary
full-cache rewrite.

### Acceptance counterexamples

- A clean restart that restores `Templates/...` after the live cache renamed it to
  `TemplateS/...` fails FR-CCR-01/02.
- Accepting a folder because only one of several managed descendants retains its
  identity fails FR-CCR-05/08.
- Treating case-fold equality, equal content, or a current provider folder ID as folder
  continuity fails FR-CCR-05/08.
- Leaving a pre-existing old-path baseline unchanged after returning a clean result
  fails FR-CCR-07 because the next COLD cycle repeats the same error.
- Emitting same-path identity evidence for every unchanged file or adding a pending
  rename/status fails NFR-CCR-01.
