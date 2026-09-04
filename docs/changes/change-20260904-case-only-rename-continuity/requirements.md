---
change: change-20260904-case-only-rename-continuity
role: requirements
functional_requirements:
- id: FR-CCR-01
  statement: Treat only the clean-cycle remote cursor and per-file terminal SyncRecord as authoritative durable sync state, committing each at its respective boundary.
  priority: must
- id: FR-CCR-02
  statement: When a cycle is wholly clean, atomically persist the cursor with a complete snapshot of the final live remote metadata cache.
  priority: must
- id: FR-CCR-03
  statement: Remove touchedPaths and pendingFullPersist without replacing them with affected-path, pending-full, receipt, or recovery correctness state.
  priority: must
- id: FR-CCR-04
  statement: On first open by the repair, cold-start metadata cache version 3 as version 4 and SyncState version 7 as version 8 so existing affected vaults rebuild from current facts.
  priority: must
- id: FR-CCR-05
  statement: Preserve identity_postcondition_unproven solely as an existing cycle-local Admission failure reason, without changing identity decisions or persisting the reason.
  priority: must
- id: NFR-CCR-01
  statement: Close the authoritative owner set and reviewed SyncOrchestrator state-field inventory through ADR, AGENTS, code-enforcement, and a mechanical source guard.
  priority: must
---

<!-- lifecycle is owned by change.md -->

# Requirements

## Content

### FR-CCR-01 — Exactly two authoritative durable states

The sync engine shall treat only these durable states as authoritative:

1. the remote delta cursor, persisted after a wholly clean cycle; and
2. each file's terminal `SyncRecord`, persisted after that file's admitted I/O
   succeeds.

A later failure in the same cycle shall not roll back already-successful file records
and shall not advance the remote cursor. “Checkpoint” names the clean-cycle cursor
commit boundary; it is not another stored state. The existing scope fingerprint, if
stored with the cursor, is checkpoint-validity metadata and shall not become an
independent decision or recovery authority.

### FR-CCR-02 — Complete subordinate cache projection

When a Google Drive, Dropbox, or OneDrive cycle is wholly clean,
`CachingRemoteFs` shall snapshot the complete final live metadata cache under its cache
mutex and atomically replace the durable projection while committing the cursor. The
snapshot shall include observation-origin and successful executor-origin effects
without tracking which individual paths produced them.

The cache remains non-authoritative and fully derivable from the provider. Its
co-persistence with the cursor is atomicity for a subordinate projection, not a third
source of sync truth.

### FR-CCR-03 — No pending cache correctness state

The implementation shall remove `touchedPaths` and `pendingFullPersist`. It shall not
replace them with a persisted or in-memory affected-path set, pending-operation list,
receipt, recovery debt, or relation state. If Admission, execution, or checkpoint
persistence prevents a clean cycle, the durable cursor and cache projection shall stay
at their prior clean boundary; successful file `SyncRecord`s may remain committed.

### FR-CCR-04 — Versioned COLD recovery

When the repaired release first opens metadata cache version 3, the existing IndexedDB
upgrade policy shall drop and recreate that derived cache as version 4. When it opens
SyncState version 7, the same project-wide schema policy shall drop and recreate its
terminal record and merge-base stores as version 8. The following cycle shall use the
ordinary no-checkpoint, no-baseline COLD path to rebuild from current local and remote
facts; no legacy migration, persisted recovery state, or inferred rename shall run.

### FR-CCR-05 — Existing fail-closed decision remains cycle-local

`identity_postcondition_unproven` shall remain an existing cycle-local Admission failure
reason. It shall not be persisted as status, intent, or recovery instruction. This
change shall add no Admission evidence, graph edge, identity rule, action disposition,
or COLD relation reconstruction. Any unrelated identity defect requires its own proven
regression and change.

### NFR-CCR-01 — Mechanically closed state boundary

ADR 0001, `AGENTS.md`, and `docs/code-enforcement.md` shall enumerate exactly the remote
cursor and `SyncRecord` as authoritative durable sync state. A source-contract guard
shall pin that two-item authority catalog and the complete reviewed instance-field
inventory of `SyncOrchestrator`.

The guard shall fail on any additional `SyncOrchestrator` field or authority owner. A
change to the guard is an architectural change and requires coordinated updates to ADR
0001, `AGENTS.md`, and `docs/code-enforcement.md`; it is not an ordinary way to make lint
green. The same guard shall prevent reintroduction of `touchedPaths`,
`pendingFullPersist`, or an equivalent pending cache owner.

### Acceptance counterexamples

- Treating “checkpoint” as state distinct from the cursor fails FR-CCR-01.
- Restoring a stale pre-rename path after a clean restart fails FR-CCR-02.
- Replacing removed bookkeeping with another pending write-set fails FR-CCR-03.
- Retaining v7 path identity, migrating it, or adding recovery-specific state fails FR-CCR-04.
- Adding or persisting an identity result, even under a different name, fails FR-CCR-05.
- Adding an unreviewed authority owner or `SyncOrchestrator` field fails NFR-CCR-01.
