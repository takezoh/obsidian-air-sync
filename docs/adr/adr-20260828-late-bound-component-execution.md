---
id: adr-20260828-late-bound-component-execution
kind: adr
title: Sync direction is selected after component ownership
status: accepted
created: '2026-08-28'
decision_makers:
- user
consulted:
- user
informed: []
tags:
- sync
- concurrency
- checkpoint
owners: []
relations:
- {type: originatedFrom, target: change-20260827-late-bound-sync-execution}
- {type: supersedes, target: adr-20260827-file-open-fast-pass-preserves-remote-change-batches}
- {type: supersedes, target: adr-20260607-metadata-cache-is-subordinate-to-commit-last}
source_paths:
- src/sync/sync-cycle-planning.ts
- src/sync/plan-admission.ts
- src/sync/plan-executor.ts
- src/sync/orchestrator.ts
- src/sync/state.ts
- src/fs/interface.ts
- src/fs/caching/remote-fs.ts
- docs/adr/0001-metadata-cache-is-subordinate-to-commit-last.md
consequences:
  positive:
  - Fast pass priority no longer requires frozen-action version supersession.
  - Ordinary current-state drift converges incrementally without stale-driven COLD.
  - Persisted schemas and the existing single-record content CAS remain unchanged.
  negative:
  - Admission/finalization use cycle-local component/member-obligation IDs and authorization
    epochs.
  - The executor must prove forbidden-overlap outcomes for dynamic routes.
  - Incomplete cycles require a private reversible replay mechanism in CachingRemoteFs.
  neutral:
  - Point observation validates admitted endpoints but never proves structural topology
    completeness.
confirmation: Direction-free member Admission, identity-plus-path provider parity,
  effect-by-scheduler isolation, exact all-member completion, effect-shape commit,
  and usable-versus-expired cursor replay tests pass with the full repository gate.
summary: Admit complete direction-free component/member obligations, choose every
  member direction from paired current identity/path evidence after ownership, and
  replay ordinary incomplete work from a usable committed cursor.
updated: '2026-08-28'
---

# ADR: Sync direction is selected after component ownership

Status: Accepted

Date: 2026-08-28

## Context

File-open fast pass exists to synchronize an opened file ahead of remaining unstarted
normal work. The predecessor design retained concrete directional normal actions, then
used provider version ordering, priority receipts, `deferred_stale_plan`, and a later
COLD scan when fast pass made an action stale. That mechanism confuses scheduling
priority with sync direction: after priority settles, normal work can simply merge the
current Local, Remote, and baseline state.

The existing safety boundaries remain mandatory. Admission owns complete connected
identity/scope authorization. `PlanExecutor` owns transfer, conflict, and structural
isolation. `SyncStateStore` already has two-argument whole-record
`compareAndPut(expectedRecord, nextRecord)` for a single content baseline; the path is
contained in those records and is not a separate argument. Current rename/delete/multi-record handling uses component-owned ordered state
writes; repository evidence does not establish an atomic transaction or precommit
guarantee. ADR 0001 keeps cursor/cache subordinate to clean commit.

Current `CachingRemoteFs.getChangedPaths()` advances the live in-memory cursor/cache
before `commitCheckpoint()` persists it. Therefore withholding commit alone does not
make another trigger on the same instance replay from the committed cursor.

Accepted ADR 0001 Decision 2 closes that same-session gap by requiring
`recoverViaColdScan` after failure and warns that removing it while leaving the live
cursor ahead loses work. This proposal supplies a different closure for ordinary
incomplete cycles with a usable committed cursor, so the two decisions conflict unless
that narrow Decision 2 rule is explicitly superseded. ADR 0001's commit-last invariant
and its COLD paths for unusable/missing/reset cursors remain compatible and necessary.

The user selected and accepted late-bound execution, rejected stale-plan deferral and
stale-driven COLD, and allowed CAS only as the existing schema-neutral whole-record
operation.

## Decision

Normal detection produces evidence-connected work components without direction.
Admission authorizes each complete frozen batch/delta component with a stable cycle-local
ID, exact stable direction-free member-obligation IDs, closed effect envelope, normalized
path set, and revocable in-memory authorization epoch. Execution selects an effect for
every member only after full path ownership and current Local, paired Remote identity/
independent path occupant or authoritative absence, and current `SyncRecord` observation.
None of the component/member/epoch authority is persisted.

File-open retains strict priority over every normal component not started. Later normal
work re-observes and normally reaches no-action or the current merge. Provider tokens are
opaque equality witnesses only. There is no frozen-action supersession, provider version
ordering, durable receipt, `deferred_stale_plan`, or drift-triggered COLD.

Remote observation pairs the admitted identity with an independent current occupant or
authoritative absence at its path. Identity missing alone never proves path absence.
Google Drive does not use `findChildByName(pageSize=1)` as authority; it paginates all
same-parent/name candidates at each root-relative step and maps 0/1/>1 to absence/current/
conflicting. Dropbox and OneDrive expose the same absence/current/conflicting/unverifiable
partition through existing provider path-metadata seams. The pair is request-local and
delta/cache/checkpoint neutral. Replacement/structural/conflicting/unverifiable pairs emit
no I/O or no-action success.

These point observations validate already-admitted endpoints but do not prove connected-
component completeness. Structural I/O is limited to the complete component supplied by
frozen authoritative batch/delta evidence. Same-cycle expansion is allowed only when
that cycle already contains authoritative evidence for the complete union; it preserves
the ID, replaces the epoch, acquires the full union, and re-observes before I/O.

Dynamic phase routing preserves observable effect×scheduler-state isolation. No selected
effect may overlap work forbidden by the existing transfer-before-conflict-before-
structural barriers; conflict siblings remain isolated, remote/local structural and
rename ordering remain intact, and disjoint-path concurrency remains available. No
decision relies on a later phase being stricter. Private scheduling or locking inside
the existing executor/coordinator boundary is implementation discretion; a shared
scheduler/guard boundary change requires design escalation.

Repeated current-state invalidation is bounded per scheduling quantum. Exhaustion yields
nonterminal same-cycle work and no receipt. Quiescing state completes; continuous churn
is rate-limited, observable, and checkpoint-blocking. No terminal
`current_state_churn` outcome is introduced.

Commit authority follows effect shape. Existing two-argument whole-record
`compareAndPut(expectedRecord, nextRecord)` protects single-record content baseline
replacement. The records carry the path; no third argument or new API is introduced.
Rename/delete/multi-record effects retain
current component ownership and existing ordered state writes. If a later write/effect
fails, no successful receipt is emitted and checkpoint commit is withheld; an earlier
write may remain and incremental replay converges from current Local/Remote/SyncRecord
state. No atomic rollback or precommit guarantee is claimed. No expected-absence or
multi-path CAS, new structural transaction/precommit API, `SyncRecord`/checkpoint/settings
field, persisted epoch/receipt/token, `DB_VERSION` change, or migration is added.

Every admitted member obligation is late-decided and becomes terminal `applied` or
freshness-bound `no_action`, or the component remains failed/nonterminal. No-action carries
in-memory local generation, expected whole record, admitted-identity result, independent
path-occupant token/authoritative path absence, and frozen delta witnesses; Local and
record are revalidated under ownership. Only complete terminal membership produces one
component receipt containing its stable component ID, latest epoch, exact admitted member-
ID set, and one completion per member. Finalization verifies exact equality across every
component and member. Partial member success followed by failure emits no component
receipt/checkpoint and converges by replay. Directional action-object identity is not used.
Remote changes after the frozen cut remain next-delta work because detached observation
never advances the global cut.

For ordinary incomplete work while the last committed cursor remains usable,
`CachingRemoteFs` owns a private reversible mechanism ensuring target-plus-sibling replay
without `list()`, COLD, or a recovery-only provider call. SyncRecords already committed
before later failure may remain and converge during replay. If the provider rejects or
expires the committed cursor, the existing typed cursor-expiry COLD policy takes
precedence; ordinary drift/failure alone is not a COLD reason. No exact restoration
procedure, shared checkpoint API, or persisted coordination state is prescribed; a need
for one requires design escalation.

This decision narrowly supersedes accepted ADR 0001 Decision 2 only where it requires
`recoverViaColdScan` after every same-session ordinary incomplete cycle. The replacement
is the usable-committed-cursor replay contract above. ADR 0001's cache/cursor atomic
commit-last invariant, crash recovery, and every COLD policy for cursor rejection/expiry,
backend reset/disconnect, rescan, scope widening, or missing checkpoint remain governing.
Ordinary drift/failure is no longer sufficient to select COLD, but those explicit policy
conditions are unchanged.

## Consequences

### Positive

- Fast pass is true scheduling priority and later work derives correctness from current
  state rather than provider ordering.
- Structural completeness, receipt freshness, and checkpoint replay have explicit owners
  and discriminating failure behavior.
- No durable coordination state, migration, provider enumeration, or backend-specific
  engine is added.

### Costs

- Admission and finalization carry cycle-local component/member-obligation IDs/epochs.
- Executor concurrency tests must cover every effect×scheduler-state forbidden-overlap
  case and preservation of required disjoint-path concurrency.
- `CachingRemoteFs` must provide private reversible replay while the cursor is usable and
  preserve the existing typed rejection/expiry partition.
- ADR 0001 Decision 2's same-session mandatory `recoverViaColdScan` test/contract must be
  replaced by usable-cursor replay coverage; its other commit-last and COLD obligations
  remain unchanged.

### Failure behavior and testability

- Identity-missing/path-occupied, replacement/structural, incomplete, or expanded point
  evidence performs no I/O or successful no-action/member completion.
- Content CAS mismatch preserves the current baseline. Structural ordered-write failure
  blocks success/checkpoint and converges through replay even if an earlier write remains.
- Churn yields bounded nonterminal work and blocks checkpoint rather than spinning or
  inventing a terminal failure.
- Missing/stale/inexact component/member completion evidence cannot finalize cleanly.
- Tests distinguish usable-cursor target+sibling replay from typed cursor-expiry COLD and
  prove that ordinary drift/failure cannot choose COLD while a prior SyncRecord converges.

## Rejected alternatives

### Frozen actions plus version supersession

Rejected. It keeps provider ordering and stale-action policy even though current state is
the only direction input needed at execution.

### Stale deferral followed by COLD

Rejected. Ordinary concurrency is incremental work and must not force a vault-wide list.
This does not remove the existing typed COLD policy when the provider rejects or expires
the committed cursor.

### Infer structural completeness from point reads

Rejected. Existing provider contracts prove current endpoint evidence, not the absence
of every connected rename/alias/replacement endpoint. No enumeration API is invented.

### Multi-path or expected-absence CAS

Rejected. Existing whole-record content CAS is sufficient for single-record content.
Structural effects retain current component-owned ordered writes plus commit-last replay;
a new atomic/precommit, multi-path, or expected-absence API would expand the state boundary
without evidence.

### Persist component receipts, epochs, or checkpoint generation

Rejected. All execution authority is cycle-local, and the existing committed
MetadataStore snapshot is the replay source.

### Terminal churn failure

Rejected. A private attempt cap must not change a mandatory current-state execution
outcome. Bounded nonterminal quanta provide resource control without semantic drift.


{% transition from="proposed" to="accepted" date="2026-08-28" %}
Accepted by user consultation consultation-late-bound-sync-execution-20260828
{% /transition %}
