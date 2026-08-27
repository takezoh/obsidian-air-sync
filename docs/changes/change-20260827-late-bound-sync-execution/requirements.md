---
change: change-20260827-late-bound-sync-execution
role: requirements
functional_requirements:
- id: FR-LATE-01
  statement: After component ownership, the system shall choose and execute each direction-free
    member obligation only from current Local, paired admitted-identity and independent
    current path-occupant Remote observations, and current SyncRecord.
  priority: must
- id: FR-LATE-02
  statement: When file-open priority is pending, the system shall run it before every
    normal component not already started.
  priority: must
- id: FR-LATE-03
  statement: When evidence changes before I/O, the system shall re-observe the same
    component without stale disposition, provider ordering, priority supersession
    receipt, or drift-driven COLD.
  priority: must
- id: FR-LATE-04
  statement: While execution-time direction differs from provisional phase, the system
    shall preserve existing phase/barrier ordering and prevent the specified effect-by-scheduler-state
    forbidden overlaps without mandating one private locking mechanism.
  priority: must
- id: FR-LATE-05
  statement: Structural I/O shall remain inside the complete endpoint and identity
    component proved by frozen authoritative batch or delta evidence.
  priority: must
- id: FR-LATE-06
  statement: Single-record content baseline replacement shall use existing two-argument
    whole-record compareAndPut(expectedRecord, nextRecord), whose records carry the
    path; rename, delete, and multi-record effects shall use current component-owned
    ordered writes, emit no success or checkpoint commit on partial failure, and converge
    by incremental replay without new API or schema growth.
  priority: must
- id: FR-LATE-07
  statement: Repeated invalidation shall consume bounded work per scheduling quantum
    and yield nonterminal same-cycle work; continuous churn shall block checkpoint
    without a new terminal churn failure.
  priority: must
- id: FR-LATE-08
  statement: A no-action member completion shall require current local, whole-record,
    admitted-identity, independent path-occupant token or authoritative path-absence,
    frozen-delta, component/member-ID, and latest-epoch witnesses; identity missing
    alone is not path absence.
  priority: must
- id: FR-LATE-09
  statement: Finalization shall require one latest-epoch component receipt whose exact
    admitted direction-free member-obligation ID set has one terminal applied or no-action
    completion per member, for every authorized component.
  priority: must
- id: FR-LATE-10
  statement: If a cycle is ordinarily incomplete and its last committed cursor remains
    usable, next incremental work shall replay target plus sibling from that checkpoint
    without list or COLD; provider cursor rejection or expiry shall use the existing
    typed cursor-expiry COLD policy, and ordinary drift/failure alone shall not.
  priority: must
---

<!-- lifecycle is owned by change.md -->

# Requirements

## Intent

Normal detection and Admission establish what connected work may run, but they do not
choose member directions. Direction is selected for every exact admitted member obligation
only when the component owns its complete authorized path set and observes current Local,
the admitted Remote identity, an independent current path occupant/absence, and current
`SyncRecord`. This makes the fast pass a pure priority decision: following normal work
uses current state instead of comparing old/new provider versions.

## Observable requirements

### R1 — priority and current-state execution

Given file-open priority is enqueued while normal work is pending, every normal component
not already started waits until the priority attempt settles. An already-started
indivisible component may finish. When later normal work starts, every member observes
the current Local/identity/path-occupant/record evidence and becomes no-action or performs
the current merge; it never executes a frozen direction or returns
`deferred_stale_plan`.

The Remote observation is a request-local pair. Identity missing does not prove path
absence. Google Drive must not use `findChildByName(pageSize=1)` as absence authority: for
each root-relative name/parent step it paginates every same-parent/name candidate, where
zero means absence, one means current occupant, and more than one means conflicting.
Dropbox and OneDrive expose the same absence/current/conflicting/unverifiable partition
through their existing provider path-metadata seams. Replacement/structural, conflicting,
or unverifiable pairs permit neither I/O nor no-action success and do not mutate global
delta/cache/checkpoint state.

### R2 — structural safety without inferred topology

Structural work is authorized only within the complete component established by frozen
batch/delta evidence. Point reads may validate admitted endpoints but cannot prove that
no connected rename, alias, or replacement endpoint exists. Evidence outside the frozen
component or unverifiable completeness performs no structural I/O, emits no successful
receipt, and leaves the checkpoint uncommitted for incremental replay.

Same-cycle expansion is allowed only when authoritative batch/delta evidence already in
the cycle supplies the complete expanded set. It retains the stable component ID,
replaces the in-memory authorization epoch, acquires the full union, and re-observes every
endpoint before I/O.

### R3 — effect×scheduler-state isolation

No requirement relies on a later phase being stricter. For every current effect selected
in transfer, conflict, or structural scheduler state, execution must exhibit no overlap
forbidden by the existing transfer-before-conflict-before-structural barriers. Conflict
siblings remain isolated, remote/local structural and rename ordering remain intact, and
disjoint-path concurrency remains available. Private scheduling/locking is implementation
discretion; a shared scheduler boundary or changed observable outcome requires design
escalation.

### R4 — bounded churn

Each scheduling quantum has a fixed provider-call/backoff work bound. Exhaustion yields
the same nonterminal component with no receipt. After external state quiesces it completes
in finitely many resumes. Continuous churn is rate-limited and observable, does not spin,
does not become a new terminal failure, and blocks checkpoint commit.

### R5 — schema-neutral state safety

Single-record content baseline replacement uses the existing whole-record
`SyncStateStore.compareAndPut(expectedRecord, nextRecord)`. The path is carried by
`expectedRecord`/`nextRecord` and is not a separate argument. Rename/delete/multi-record state remains under current
component ownership and uses the current ordered state writes. No atomic transaction or
precommit guarantee is assumed: a partial failure emits no successful receipt, withholds
checkpoint commit, and converges through incremental replay even if an earlier write
remains. No expected-absence or multi-path CAS, new structural transaction/precommit API,
persisted epoch/receipt/token, schema field, `DB_VERSION` change, or migration is
permitted.

### R6 — fresh receipts and incremental replay

A member no-action completion is bound to local tracker generation, expected whole
`SyncRecord`, admitted-identity result, independent path-occupant token or authoritative
path absence, frozen delta generation, component/member IDs, and latest in-memory epoch.
Identity missing alone is not absence. Local and record are revalidated under ownership
before acceptance. A remote mutation after the frozen delta cut remains next-delta work
because detached observation does not advance that cut.

Clean finalization requires exact component membership and, for every latest epoch, exact
admitted member-ID membership with one terminal applied/no-action completion per member.
Any missing, duplicate, unknown, failed, blocked, nonterminal, stale-epoch, member-inexact,
or freshness-invalid evidence withholds the component receipt and checkpoint. If some
members succeed before another fails, no component receipt/checkpoint is emitted and
replay converges their retained effects.

For ordinary incomplete work with a usable committed cursor, next incremental work
replays target and sibling without `list()`, COLD, or a recovery-only provider call;
`CachingRemoteFs` owns the private reversible mechanism. If the provider rejects or
expires that cursor, the existing typed cursor-expiry COLD policy takes precedence.
Ordinary drift/failure alone is never a COLD reason.

## Constraints

- No durable queue, receipt, epoch, token, retry marker, or checkpoint/settings field.
- No new shared checkpoint/reload API or recovery-only provider call; a need for either
  escalates back to design.
- No migration, DB version change, provider ordering, provider enumeration, or backend-
  specific sync engine.
- Existing logical-identity Admission, conflict/rename barriers, strict priority,
  commit-last, and unrelated explicit COLD policies remain controlling.
