# Sync Pipeline

This document owns the pipeline's responsibility boundaries, invariant ordering, and the
safety judgements behind them. Algorithms, helper names, and constants live in the code.

## Pipeline overview

Each sync cycle has exactly four top-level responsibility stages:

1. **Observation** -- acquire exact entries, path observations, and normative identity evidence; project scope and freeze those facts without constructing actions.
2. **Admission** -- privately construct the path-local proposal, build identity-connected components once, apply conflict and destructive-action policy, assign every relevant component one disposition and lifecycle membership, and issue the only `AuthorizedSyncPlan`.
3. **Execution** -- accept that authorized plan only, perform its exact effects, and report exact outcomes without inventing or rerouting actions.
4. **Commit/finalization** -- record proven successes per action; mechanically fold those outcomes with the Admission dispositions and commit the remote cursor/checkpoint only after a clean cycle.

These name responsibility owners, not one scheduled pass per helper: evidence completion,
scope projection, and immutable fact capture belong to Observation; the decision table,
component build, conflict policy, and component-local rename shaping are private to
Admission and add no extra network scan.

The conflict strategy is captured once. Observation consults it only through a
responsibility-local predicate that decides whether Prefer-local proof hashes are needed.
Admission is the sole policy compiler: every conflict action carries a required, closed
execution policy, and Execution/resolver/audit never receive the raw strategy.

No executable action exists before Admission. The orchestrator only sequences the
boundaries: it projects scope into a fact-only snapshot and passes it once at the
authorization cut point.

**Scope filter (`SyncOrchestrator.isExcluded()`)** — a path is synced only if it passes
**both** gates: dot-path scope (a hidden path is in scope only under a configured dot-path
root, augmented with the config directory when config sync is on; normal paths always pass)
and ignore patterns (gitignore-style, likewise augmented when config sync is on, with
individual config subtrees opted in). Scope is applied symmetrically to local and remote
facts, and excluded endpoints and crossing identity edges are discarded. These settings
are part of the scope fingerprint, so changing one forces a single cold reconcile and
surfaces remote-only files that predate the delta cursor.

`isExcluded()` also reserves two paths unconditionally, ahead of both gates: the backend's
own metadata path (never synced from either side, for symmetry with the remote filesystem's
hiding) and this plugin's own settings file under the config directory. The latter is
enforced as a reserved path rather than a soft ignore pattern because gitignore's
last-match-wins semantics would let a user's own pattern override it, letting one device's
credentials overwrite another's.

`runSync()` is gated on a connected remote, layout-ready, and not-connecting; it serializes
and coalesces calls arriving mid-run. A clean cycle acknowledges its captured tracker
snapshot. A terminal partial cycle withholds the durable checkpoint, retains captured dirty
paths, and abandons only captured rename reports — so failed content writes stay HOT while
relational work is re-observed from current endpoints instead of replaying an unresolved
rename report. Before any incomplete attempt is classified or retried its remote working
view is aborted; no evidence or recovery instruction is persisted.

## Crash recovery

The remote delta cursor is the "synced up to here" checkpoint. It is committed with the
file-map cache in the backend's store, only when there is no failed action or Admission
failure (see [ADR 0001](adr/0001-metadata-cache-is-subordinate-to-commit-last.md)). A
partial or interrupted cycle leaves cursor and cache at the prior committed value.

At each invocation the orchestrator asks whether a committed checkpoint exists and reads
the durable scope fingerprint. A missing checkpoint (first sync, schema cold-start, cleared
state, manual rescan) or a durable scope change forces COLD; otherwise the ordinary
tracker/baseline rules select WARM or HOT. The captured selection holds across the
invocation's bounded retries; a later explicit sync recomputes it from durable/current
facts.

The cache/cursor/scope acquired during an attempt is a live derived working view. A wholly
clean result commits it; Admission rejection, failed/blocked execution, missing terminal
proof, a blocked checkpoint, persist failure, or a pre-closeout exception aborts it without
touching the durable checkpoint. The next attempt lazily reloads the checkpoint and
re-observes current facts exactly as a reconstructed filesystem would — no previous failure
selects a temperature or suppresses a later action. Fatal parallel execution waits for
scheduled siblings to settle before abort.

An **Admission failure** is different from a failed action: the rejected component never
reaches the executor, even with zero actions. The cycle ends `partial_error`, reports an
ordinary error, aborts the working view, and does not queue another cycle; it creates no
pending operation row or recovery marker. Case-only local rename evidence may be
reconstructed from an unambiguous case-folded baseline/current pair when the remote baseline
identity and version are unchanged; general rename identity is never guessed.

Re-seeding failed paths, retaining a failure/quarantine marker, forcing a special recovery
temperature, or advancing the cursor while ignoring failures are **ADR 0001 prohibited
patterns**. The **Rescan vault** action discards the committed checkpoint and triggers one
cold reconcile; it diffs against baselines (it does not re-download) and keeps sync history.

A backend may keep a **non-authoritative cache** (e.g. Google Drive's path↔id map) to avoid
a network re-list. Its only invariant — **never committed ahead of (nor behind) the
committed cursor** — is structural: the cursor lives in the cache's store and commits in
the same transaction. Before "optimizing" this, read
[ADR 0001](adr/0001-metadata-cache-is-subordinate-to-commit-last.md): the recurring bugs
here all came from treating the cache as authoritative.

## Temperature modes

Acquisition selects a temperature from the durable checkpoint/scope, the local change
tracker, and the sync state store. It is an acquisition strategy only: HOT, WARM, and COLD
must produce the same Admission decision for the same complete component facts.

### Hot -- O(delta)

Selected when the cycle snapshot is initialized and its dirty set is non-empty (read from
the start-of-cycle snapshot, not the live tracker). It takes the union of local dirty paths
and remote changed paths and reads only the affected baselines. No-ops are pruned by
explicit cases: both sides absent keeps only a baseline; no baseline is always kept; and
otherwise the entry is kept only when a side actually changed.

### Warm -- O(n) local + O(delta) remote

Selected when hot fails but stored records exist. It lists the whole local side, takes the
remote delta, and compares the listing against stored records to find changes and deletions.
Every baseline absence is confirmed against the authoritative filesystem so an
under-reporting local list cannot authorize deletion — see [Deletion safety](#deletion-safety).
Local reported renames are added as both endpoints and carried as normative identity
evidence.

### Cold -- O(n)

Selected when no stored records exist, or forced for a missing checkpoint or durable scope
change. Both sides are fully listed and outer-joined so every path on either side is a
candidate.

## Hash enrichment

Listing omits content hashes for I/O reasons, so without enrichment the decision engine
cannot distinguish identical files from conflicts. Enrichment covers only bilateral entries
with no baseline that are the same size and carry a locally reproducible remote checksum:
on a digest match the content is hashed so the engine returns `match`, and on a mismatch or
a per-file error hashes stay empty, routing to `conflict` (the safe side). Local rename
destinations get a stat-based hash so Admission's rename proof has SHA-256 equivalence.
Merely because `prefer_local` is selected, Admission completes SHA-256 facts for included,
same-path bilateral edits with a non-empty committed baseline; other strategies do no reads
for this proof, excluded paths are not read, and missing proof — including a cold start —
routes to preservation rather than local overwrite. Before enrichment, rename endpoints are
observed and baseline absences confirmed; a thrown `stat()` aborts the attempt and is never
converted to absence.

## Change detection

### Local changes

`LocalChangeTracker` tracks dirty paths in memory from vault events. File and folder rename
events record a producer pair and mark both root endpoints dirty without enumerating folder
descendants; rename chains are collapsed. At collection the captured pair is converted once
into normative rename evidence, and any private action-shaping view derives from that
evidence rather than being a second source of truth. Each cycle captures a start snapshot
and acknowledges exactly that snapshot: a clean completion removes captured dirty paths and
generation-matching relations, a partial completion removes only relations and retains dirty
paths, and a mid-cycle event reusing a key survives either operation (see
[Acknowledge pattern](error-handling.md#acknowledge-pattern)).

### Remote changes

The incremental checkpoint returns modified/deleted paths plus optional authoritative
rename pairs and contentions, or `null` when no incremental data is available (fall back to
warm/cold). The rename array is authoritative reported evidence, captured before later
detection so a retry cannot consume the live cursor and lose the constraint.

`contended` names derived cache addresses found claimed by two live stable ids (Drive can
hold two same-named children; the vault cannot). Two provider-resolved same-named *folders*
are not a contention — they are one vault folder, and only what collides inside it is. A
COLD cycle receives the same facts through a working-view drain, so no temperature forgets.
A contention is not a change at any path, so it never enters the change set; the
orchestrator drops excluded-path contentions and passes the rest to Admission (see
[Address-contention remediation](#address-contention-remediation)). Nothing is persisted.

### Comparison functions

Local file vs baseline (ADR 0005 — locally a hash costs I/O, so it leads with the hash only
when one is already on hand): when both sides carry a hash it is authoritative (catching a
same-mtime+size edit, ignoring an mtime-only touch); otherwise compare mtime + size; when
neither is usable, conservatively treat as changed. Remote file vs baseline: compare mtime
+ size, then the remote checksum when both expose the same algorithm, then fall back to
hash; an undeterminable result is treated as changed.

## Decision table

`decideAction()` in `decision-engine.ts` maps each combined view to an action. Its
load-bearing safety decisions:

- With a baseline: a bilateral change is `conflict`; a one-sided change pushes or pulls; no change is skipped; a missing side with the other unchanged deletes the missing side; a missing side with the other changed is `conflict` (keep both), never a deletion; both missing is `cleanup`.
- Without a baseline: local-only pushes, remote-only pulls; bilateral files are `match` only when BOTH hashes are present, equal, and sizes are equal, otherwise `conflict`. Because listing returns empty hashes, an unenriched entry routes to `conflict` even when sizes match.
- A missing baseline never yields a deletion.

## Deletion safety

There is no volume-based abort gate. Deletion safety rests on four independent layers:

1. **Decision rules** -- an ambiguous case (a file gone on one side while the survivor changed since baseline) routes to `conflict`, never deletion; a missing baseline never yields a deletion.
2. **layoutReady gate** -- sync does not run before the vault index is loaded, so an under-reporting listing during startup cannot be mistaken for mass local deletions.
3. **Authoritative observation** -- listing absence is re-`stat()`'d before it can authorize deletion; a thrown stat aborts the cycle, and HOT checkpoint tombstones remain authoritative remote absence. The local stat falls back to the vault adapter on an index miss, so it is a genuine independent check; the remote stat reads the same cache the listing came from, so on the remote side the authority is the cache itself (a complete projection of a wholly clean scan, ADR 0001), not the re-read. The one cause the cache knows about is a contended derived address, which is arbitrated and returned as a fact rather than silently evicted, and every producer of remote deletions subtracts a path whose absence that displacement explains.
4. **Whole-component admission** -- rename, alias, unresolved-presence, and stable-ID edges connect related managed paths. Excluded paths are absent from the Admission snapshot and are not identity nodes. If the component decision cannot prove every managed resource survives, Admission fails it before execution. Deletions are additionally soft (trash), but recoverability is not used as authorization.

## Identity-component action shaping

There is no standalone whole-plan optimizer. Admission builds the cycle-local component
partition once and may replace a component's proved delete+transfer pair with one native
rename as part of the same result carrying authorization, disposition, and lifecycle.

### Local renames — hash-verified

A local reported rename may be shaped into one remote rename. Hash verification is
mandatory: the pushed local hash must equal the deleted baseline hash. This holds for file
and folder renames; a folder rename coalesces all mapped managed-descendant actions and
every managed descendant must pass, while excluded listing entries are absent and do not
prevent the opaque rename. Current occurrences are claimed symmetrically so a destination
baseline used as one publication expectation cannot bind the same occurrence again; exact
executor CAS is a guard against external publication, not a mechanism for resolving
duplicate actions from one plan. On case-insensitive local filesystems, a COLD replay can
resolve the new spelling back to the old and produce no action; Admission reconstructs a
child rename only when the local alias is exact, the baseline content matches, the remote
source is unchanged, and remote destination absence is authoritative, and it can coalesce
back into the reported folder rename.

### Remote renames — trusted

A delta-reported rename pair may be shaped into one local rename. The report is
authoritative evidence, so no content-hash inference is needed; order-independence is the
backend's job ([ADR 0006](adr/0006-remote-rename-detection-is-order-independent.md)). The
same component decision validates the shaped result. If a new object was created at the old
path, native rename does not coalesce and the source-recreation fallback is permitted only
when stable-ID evidence proves the moved and recreated objects are distinct and both are
preserved. For a folder pair, every local delete child under the old prefix coalesces into
one folder rename: a descendant whose matching pull is missing is absorbed (its baseline
rewritten, with a genuine remote delete propagating next cycle — biasing toward safe
deletion), and the folder is skipped if any action under the new prefix has a non-null local
entity. Detection is best-effort; a per-action rename failure is caught and recovers next
cycle.

- **Optimization opportunity (not implemented):** a destination-occupied folder rename may be decomposable into per-child mappings, but only a complete mapping whose postconditions pass Admission may execute. Incomplete mappings fail Admission; see [ADR 0006](adr/0006-remote-rename-detection-is-order-independent.md) and [ADR 0008](adr/0008-logical-identity-admission-fails-closed.md).

## Destructive admission

Scope is applied before freezing entries, evidence, observations, scope, and namespace into
one fact-only snapshot, passed once to Admission. Admission privately constructs the
path-local proposal, builds connected components from actions plus rename/alias/stable-
identity evidence and path observations, and emits exactly one `authorized`,
`resolved_no_action`, or `failed` disposition per relevant component, including
evidence-connected components with zero actions.

Admission alone proves exact deletion authority, native rename, two-sided convergence, or
the recognized source-recreation postcondition. Unknown, conflicting, incomplete, or
otherwise unproved components fail closed as a whole, including state-only actions. Only
`authorized` actions are projected; disconnected ordinary work retains proposal order,
while a proved component replacement occupies that component's place. Execution cannot
accept a plain proposal through the supported typed API.

Within each component, Admission selects rename authority once from the raw facts before
shaping: a coherent reported rename family precedes alias-only current facts, and aliases
prove endpoint equivalence but never choose the opposite direction. A reported folder root
governs only exact, complete, unique, suffix-preserving included descendant pairs held in
call-local proof data that is discarded when the decision returns and never enters an
action, store, checkpoint, retry, or recovery mechanism. Any unknown/deferred endpoint or
incomplete folder mapping fails Admission; the full direction matrix and rejected inferences
are in [ADR 0008](adr/0008-logical-identity-admission-fails-closed.md).

No operation intent, rename evidence, failed disposition, or recovery instruction is
persisted. Finalization does not re-evaluate scope, observations, identities, aliases, or
action shapes: it folds the snapshot-bound dispositions with succeeded action membership.
Successful file actions publish their SyncRecord; the cursor, cache, and scope checkpoint
publish only after a wholly clean cycle. An incomplete attempt aborts its working view, and
the next invocation re-observes and reclassifies through the same Admission contract.

### Observability

Admission logs executable/proposed counts and each failed component's reason, evidence
kind/origin, endpoint dispositions, and paths (never content or credentials). Status stays
`partial_error` and Admission failures join the ordinary error count; their detail is
diagnostic only, and a later sync may reacquire facts but the failure is neither pending
work nor a convergence guarantee. The exception is `awaiting_repair`, where the same plan
carries the repair that settles it, so the cycle closes as a follow-up, queues the next
cycle, and counts no error (see [Address-contention remediation](#address-contention-remediation)).

## Address-contention remediation

Drive can hold two same-named children at one address; a vault path cannot. The metadata
cache arbitrates and *withholds* one claimant, naming it in a displacement fact rather than
silently evicting it (see
[Google Drive backend → Cache invalidation](google-drive-backend.md#cache-invalidation)).
That loses nothing but converges nothing, so the condition is repaired at its source: a
sibling Admission stage originates a remote rename from complete current-cycle facts (not
from a local rename) and adds no action type.

- **Inputs** are the announced contentions, which claimants hold a committed SyncRecord — looked up by the claimant's own identity, not the contended path — whether the identity-rename capability exists, and the vault exclusion scope applied by the orchestrator *before* Admission (the cache holds excluded objects too, but a repair writes to the provider, so it may only reach a path the user actually syncs; the filter sits at the orchestrator so the filesystem can still subtract a displaced excluded path from the deleted set).
- **Remediable** only when both claims are provider-resolved and the rename capability is present. A request-echo claim is an out-of-root guess and is announced but not repaired.
- **The keeper** is the claimant holding a committed SyncRecord — sync priority follows sync history. When that singles out none (none hold one, or several were already synced), it is the claimant the arbiter admitted. The choice is a function of the unordered claim set plus committed state and is identical under COLD/WARM/HOT, which stops a long-synced file from being renamed for a new duplicate. It is the *sole* decider for the address: where the cache's mechanism (which cannot read sync state) differs, this holds.
- **The address is withheld** whenever the keeper is not the claimant the cache seated — "sync the object whose id matches the SyncRecord, rename the one that does not". The keeper was dropped from the working view, so Admission binds the address and everything beneath it as present-but-unresolved; acting on the seated claimant instead would sync the wrong object and publish a record naming an object the same plan is moving. It resolves next cycle once the repair vacates it. Independent of the rename capability: a backend that cannot repair the namespace still must not sync the wrong object there.
- **The target** is built from the renamed claimant's own stable id, so the rename is idempotent across retries, needs no content fetch, and is meaningful for a folder; that form cannot collide with the hash-based preservation suffix.
- **Execution** goes through the identity-rename capability, never a path-addressed rename (which would resolve to the claimant that keeps the address); it carries no local counterpart, baseline, or record publication.
- **Commit gate and follow-up.** A cycle owing a repair is checkpoint-blocked so no cursor advances past a withheld claimant, while every uncontested action still executes and publishes. When nothing failed it closes as a follow-up rather than incomplete (convergence needs one more cycle), queued like any sync request and keeping status `syncing` instead of reporting failure. A withheld address whose repair this plan carries fails its component as `awaiting_repair` (counts toward the follow-up); one no repair can reach stays unresolved (does not, because a follow-up would only observe it again). A non-remediable contention owes no repair and does not block the checkpoint by itself; if its keeper is not the seated claimant the address is still withheld, which fails that component until the provider's facts change.

Nothing here is persisted — not the contention, not the disposition, not a repair queue —
and none of it is shown to the user: it is a fact about the Drive namespace that the
filesystem and Admission settle between them. The paths and both stable ids go to the log
at warn level.

## Execution phases (lane/tier scheduling)

Execution classifies each action by **resource lane** (which filesystem it mutates: remote /
local / both / state-only) and **dependency tier** (transfer / rename / delete / state-only),
then runs three phases behind sequential barriers: transfers plus state-only work, then
conflicts serially, then structural renames and deletes. The barriers preserve two safety
properties: no content write runs concurrently with a same-subtree structural rename/delete,
and a conflict (which touches both sides plus a planner-invisible sibling path) never
overlaps either. Renames stay serial so Admission's destination-occupancy proof is not
deliberately invalidated by another rename in the same lane; pooled deletes are safe even
for legitimate folder+descendant overlap because the folder's tree removal evicts the child
entry — see [ADR 0001 → T7](adr/0001-metadata-cache-is-subordinate-to-commit-last.md).

Transfers pool independent content I/O on disjoint paths; concurrency adapts to the
provider's sustainable rate, and a byte budget bounds peak memory because each transfer
holds a whole-file buffer, so small files run highly concurrent while large ones
self-throttle. Conflict actions are serial and validate their required policy and protocol
before I/O; missing or incompatible policy fails closed with no downstream default.
`AuthError` aborts the whole cycle; all other errors are caught per-action and recorded.

A push captures and validates its exact local bytes before writing. Once the remote terminal
proves those bytes, the transfer publishes the captured local facts as its historical
SyncRecord half even if the local address was subsequently changed, replaced, or removed;
the later local revision remains pending and converges next cycle. Stale pre-write inputs
and an unproved or corrupt remote terminal remain non-clean, as does a pull whose remote
source changed or disappeared. See
[ADR 20260914](adr/adr-20260914-publish-captured-push-revision.md). When three-way merge is
enabled, the merge-base projection reuses these proved transfer bytes instead of rereading
the now-obsolete local path.

Each normal action holds a priority permit from immediately before its exact effect through
publication, so queued file-open work runs only where no normal action is half-applied.
Preparation through Admission and finalization through checkpoint commit are exclusive;
priority may replace only an unstarted Admission-projected singleton pull during the
transfer phase. See [error-handling.md → Two retry layers](error-handling.md#two-retry-layers)
for the per-action in-cycle retry.

## State commit

`sync-records` is keyed by the provider object's identity, not its address, with a unique
index over path; the merge-base content store is keyed the same way. A record's key never
moves when the file does, and every production commit goes through a compare-and-swap that
compares captured expectations against one transaction image before writing anything.

- A push/pull/match/conflict publishes the terminal record with whole-record CAS, comparing two captured expectations inside the one transaction: the row this publication continues (by the terminal's own identity) and whatever the path index shows occupying the claimed address. Neither is defaulted from the other; a baseline-free action passes both as absent, requiring a vacant address. A stale expectation fails the action instead of overwriting a newer winner, and a failed publication writes and deletes nothing.
- With three-way merge enabled and a merge-eligible file, the content is stored as a future merge base, written only while the terminal record is still exactly the row just published; the store compresses entries and falls back to raw for tiny/incompressible ones. A relocation never copies or re-encodes stored bytes — the content row shares the record's identity key, so it stays put; a publication drops it only when it invalidates the base.
- A folder rename publishes every child in one transaction, comparing each child's captured source row and destination occupant against a single image, then updating each identity-keyed row in place. The set is refused when non-injective in source or terminal addresses, or when one item's terminal address is another's source address (cyclic); self-overlap is admitted. A single-file rename is one put of the same identity-keyed row with a new path, so the continued row and its identically keyed merge-base content stay in place.
- A local/remote delete or cleanup removes the captured record and its merge-base content after proving in the same transaction that the record is still both that row and the occupant of the path; with no captured record it verifies the address is vacant and succeeds.

The store's plain uncompared routes have **no** production caller; `clear()` is reached only
on a backend identity change or target disconnect/reset. Execution publishes exclusively
through the compare-and-swap routes. Failed actions are not committed and are re-detected
next cycle.

## Sync triggers

`SyncScheduler` registers six event-driven sync triggers plus a departure boundary that
*gates* the foreground triggers and is not itself a trigger. Wiring is gated on the vault
layout being ready and no-ops if the plugin was destroyed first.

| Trigger | Behaviour |
|---------|-----------|
| Vault change | Marks the path dirty, then debounces so sync fires after the last change. |
| Vault rename | Records the pair and marks both paths dirty, then debounces; if either endpoint is ignore-excluded the pair is not recorded, each non-excluded endpoint is marked dirty, and the debounce fires only if at least one endpoint is non-excluded. |
| Visibility | On becoming visible, re-syncs only after a departure (ADR 0007), unless one is already running; on hidden, marks a departure. |
| Focus | Re-syncs only after a departure (ADR 0007). |
| Online | Immediately syncs when the network is restored — a network axis, not departure-gated. |
| File open | Priority pull for the opened file (see below). |

A **departure** (leaving the foreground) is marked by blur or by becoming hidden, OR'd to
cover phone, tablet, and desktop. It is not a sync trigger; it arms the next foreground
return. All triggers are event-driven — there is no periodic timer. Out-of-scope paths are
excluded at the vault-event level. The triggers are **classified**
([ADR 0004](adr/0004-sync-reruns-are-classified-by-trigger.md)): signal triggers carry no
local change and are discarded while a sync is in flight (the running cycle already does the
re-scan they ask for); vault triggers carry a real edit and re-run via the pending flag even
mid-sync; the foreground signals are further gated on a real departure
([ADR 0007](adr/0007-foreground-resync-requires-a-real-departure.md)), so a mobile cold
start's trailing deferred focus does not fire a redundant second scan. That guard, the
coalescing loop, and the departure gate are load-bearing.

## Active file priority sync

The scheduler forwards the opened path without reading any baseline or filesystem metadata.
The priority owner requires an identity-aware SyncRecord, rechecks local state, and asks the
optional priority capability for detached current authority; if changed and safe it writes
locally, commits the whole record with CAS, then acknowledges the exact tracker generation.
Unlike focus/visibility/online, file-open is queued even during a batch: queued opens drain
after active normal actions and before later normal permits, never interrupting an
effect/commit pair nor running during preparation/finalization, and only a transfer-phase
exact singleton regular-file pull with matching stable identity can be superseded. Missing
capability/baseline, ambiguous topology, a local edit, changed target token/identity, CAS
loss, or a later phase fails closed to the normal lifecycle with no invented action;
duplicate opens of one path coalesce.

A missing baseline is classified more narrowly than other deferrals: an `untracked` result,
not a safety failure. Priority issues no immediate lifecycle request, and the scheduler
feeds the result into the same resettable debounce as vault changes, so a create-plus-open
waits for the note to settle while an untracked open without a create event still gets a
delayed normal scan. Baseline classification happens before capability and active-batch
checks, so the outcome does not depend on observation order. Other conditions
(present-but-incomplete tracking, active-batch deferral, missing capability, observation
contradictions, invalidation, provider/baseline errors, CAS loss) keep immediate
normal-lifecycle behavior.
