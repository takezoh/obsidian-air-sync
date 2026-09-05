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
  statement: On first open by the repair, cold-start metadata cache version 3 as version 4 and SyncState version 7 as version 8; do not add another reset to compensate for a prior failed attempt.
  priority: must
- id: FR-CCR-05
  statement: For every cycle, normalize a local case alias from current component facts only when they prove one exact physical local target, one unique exact remote source identity, an absent remote target, included scope, and equal content; Admission must decide it exhaustively without persisted intermediate state.
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

### FR-CCR-04 — One versioned cold-start

When the repaired release first opens metadata cache version 3, the existing IndexedDB
upgrade policy shall drop and recreate that derived cache as version 4. When it opens
SyncState version 7, the same project-wide schema policy shall drop and recreate its
terminal record and merge-base stores as version 8. The following cycle uses ordinary
collection and Admission to rebuild from current local and remote facts. A build that
already created version 8 shall not be reset again: correctness must not depend on
which earlier attempt failed, on a zero-record store, or on a recovery marker.

### FR-CCR-05 — Current-fact case-alias canonicalization

During WARM/COLD collection, `LocalFs.list()` shall resolve only case-fold-colliding
vault-index spellings against the raw adapter and discard spellings that resolve to the
same physical path; genuinely distinct case-sensitive paths shall remain. `stat()` shall
return adapter-resolved actual casing as authoritative endpoint evidence.

Observation shall record only current alias, exact endpoint, absence, identity, hash,
and size facts. It shall not infer rename identity or authorize an action. Admission
shall form one typed component from those facts and any component-local `SyncRecord`.
When the old local spelling resolves to exactly the new physical spelling, the local
new path and remote old path are exact, the remote new path is stat-authoritatively
absent, the remote old identity is unique, both paths are included by scope, and direct
reads prove equal SHA-256 and size, Admission shall explicitly choose the local spelling
as canonical and authorize one `rename_remote` preserving the remote stable identity.

That equal-content canonicalization protocol is the no-baseline case. When the
component has a terminal baseline, the alias is only endpoint evidence for the ordinary
typed fresh-reconciliation table: local-only change may rename/write, both-changed may
conflict, and already-converged content may settle. Admission still owns the one
exhaustive result; Execution does not reinterpret the alias.

This decision is independent of COLD/WARM/HOT acquisition, global `SyncRecord` count,
database version, previous failure reason, and prior Admission result. With the same
complete component facts, all acquisition temperatures produce the same decision. A
recognized alias component with incomplete or contradictory proof must produce an
explicit fail-closed decision; it must not fall through to unrelated path-local rules.

Immediately before the effect, Execution shall re-observe exact local new, exact remote
old identity, vacant remote new, and equal direct-read bytes. After the move it shall
prove remote old absent, local/remote new exact, expected remote identity, and equal
bytes/size. A mismatch shall make the cycle non-clean and shall not commit a
`SyncRecord`.

The evidence and decision are immutable cycle snapshots and shall be discarded after
the cycle. `identity_postcondition_unproven` remains an existing cycle-local failure
reason, not a persisted status, intent, or recovery instruction. No new status,
`SyncRecord` field, store, Orchestrator field, or cross-cycle relation is permitted.

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
- Adding a v8-to-v9 reset, migrating path identity, or adding recovery-specific state fails FR-CCR-04.
- Having Observation infer a rename, accepting unequal/unhashed content, persisting the
  candidate/result, conditioning it on acquisition temperature or whole-store state,
  or allowing a recognized alias component to fall through fails FR-CCR-05.
- Adding an unreviewed authority owner or `SyncOrchestrator` field fails NFR-CCR-01.
