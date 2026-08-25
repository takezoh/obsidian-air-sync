# Issue #43 design — admission-owned destructive authorization

**Revision:** `integrated-plan-v1`

<!-- anchor: adr-0001-commit-last -->
## ADR 0001 — commit-last remains authoritative

Per-action state changes occur only after their I/O succeeds. A cycle checkpoint is
committed only after all authorization dispositions and execution results are safe;
rename debt and session evidence retire only after that checkpoint succeeds. A thrown
checkpoint write propagates and leaves all recovery material intact.

<!-- anchor: adr-0006-order-independent-rename -->
## ADR 0006 — backend evidence production remains independent

Backends own the shape and ordering of rename evidence. Admission can classify only
evidence it receives and must not infer an omitted edge from spelling or cache state.
Issue #46 therefore remains a OneDrive backend/cache evidence-production concern, not
an exception-recovery or authorization subtask of Issue #43.

<!-- anchor: adr-0008-logical-identity-admission -->
## ADR 0008 — logical-identity admission remains authoritative

Path observations, normative identity evidence, pre-filter scope projection,
whole-component fail-closed admission, visible deferral, bounded local RenameDebt,
remote checkpoint replay, and the v6 cold-start rule remain unchanged. This change
closes two representational holes in that accepted boundary: zero-action relevant
components receive a disposition, and execution receives a nominal admission product.

<!-- anchor: adr-issue43-destructive-authorization -->
## ADR Issue 43 — immutable admission authority

The cycle composition root captures one immutable `CycleAdmissionSnapshot` before
Admission. It contains the refined proposal, normative identity evidence, authoritative
path observations, endpoint scope projection, and the accepted backend/root namespace.
Admission is the sole constructor of an opaque/nominal `AuthorizedSyncPlan`; proposal
and refinement results remain plain `SyncPlan`. `executePlan` accepts only
`AuthorizedSyncPlan`, and finalization consumes the dispositions and completion results
bound to the same snapshot.

The snapshot is a shallow public contract over deeply immutable cycle inputs: no member
is mutated after capture, and admission output refers to the captured members rather
than copying evidence into another normative DTO. Backend/root teardown remains
serialized with sync execution. A settings or root change therefore affects the next
snapshot only and cannot alter an in-flight authorization. No lifecycle manager,
persistent component graph, durable authorization token, or remote debt is introduced.

<!-- anchor: fr-43-01 -->
## FR-43-01 — proposal is not permission

Decision Engine and rename refinement shall produce plain proposals only. Destructive
permission shall be issued only by Admission from a complete immutable cycle snapshot.

<!-- anchor: fr-43-02 -->
## FR-43-02 — dispositions are exhaustive

Admission shall emit exactly one `authorized`, `resolved_no_action`, or `deferred`
disposition for every connected component containing an action, identity evidence, or
an unresolved/unknown observation, including components containing zero actions.

<!-- anchor: fr-43-03 -->
## FR-43-03 — actionless uncertainty defers

An actionless component whose identity, presence, scope, or permitted postcondition is
not proven shall be visibly deferred. It executes no action, retains bound evidence and
debt, prevents checkpoint advancement, and requests a later COLD cycle without setting
a tight automatic retry.

<!-- anchor: fr-43-04 -->
## FR-43-04 — authorized execution only

`executePlan` shall accept only the nominal `AuthorizedSyncPlan` issued by Admission.
It shall receive the proposal-ordered projection of `authorized` actions and no action,
including `match` or `cleanup`, from another disposition.

<!-- anchor: fr-43-05 -->
## FR-43-05 — one safety decision owner

Admission alone shall classify scope no-op, two-sided convergence, identity
consistency, alias targeting, and permitted destructive postconditions. Finalization
shall not receive or re-evaluate scope projections, path observations, identity facts,
or action shapes to establish safety.

<!-- anchor: fr-43-06 -->
## FR-43-06 — completion does not reauthorize

Evidence and debt bound to an authorized component become releasable only when every
bound action succeeds. A failed or blocked bound action retains them without changing
the admission decision.

<!-- anchor: fr-43-07 -->
## FR-43-07 — checkpoint precedes retirement

Releasable evidence and debt shall retire only after the safe cycle checkpoint commits.
A checkpoint exception shall propagate and leave them unchanged.

<!-- anchor: fr-43-08 -->
## FR-43-08 — pre-Admission evidence-acquisition recovery

Remote rename evidence shall be copied to the existing session buffer immediately when
delta acquisition yields it. If stat, hashing, observation, or planning then throws
before Admission is invoked, the orchestrator shall request later COLD recovery and
retain that evidence. It shall not fabricate a disposition. Exceptions at or after the
Admission boundary are not reclassified as this recovery case and follow existing
fail-fast/commit-last semantics.

<!-- anchor: fr-43-09 -->
## FR-43-09 — disconnected progress remains ordered

Disconnected authorized actions shall preserve proposal order and may commit per-file
state while another component is deferred; the cycle checkpoint remains non-clean.

<!-- anchor: fr-43-10 -->
## FR-43-10 — deferral is observable

Every deferred disposition, including an actionless one, shall contribute exactly once
to partial status, notification count, structured diagnostics, checkpoint withholding,
and the request for a later same-session COLD reevaluation.

<!-- anchor: fr-43-11 -->
## FR-43-11 — Issue #46 has separate causal proof

Issue #43 verification shall not claim that pre-Admission retention fixes backend
evidence omission. Issue #46 is proven independently by the OneDrive casing regression
and an A/B pipeline test that holds Admission inputs and policy constant except for the
backend/cache producer emitting versus omitting the required rename edge.

<!-- anchor: nfr-43-01 -->
## NFR-43-01 — deterministic pure admission

Equal immutable snapshots shall produce equal disposition membership, reason ordering,
and authorized action order without I/O or mutation.

<!-- anchor: nfr-43-02 -->
## NFR-43-02 — bounded state and minimal carriers

The change shall add no lifecycle service, persistent component graph, remote debt, or
duplicate normative evidence DTO. Existing namespace-bounded local RenameDebt and the
session-local remote-evidence buffer remain the only recovery carriers.

<!-- anchor: component-action-proposal -->
## Component — action proposal

`decision-engine.ts`, rename optimization, and `sync-cycle-planning.ts` own exact-path
proposal generation and behavior-preserving rewrites. Their output is always a plain
`SyncPlan`; optimizer misses never grant permission.

<!-- anchor: component-admission -->
## Component — snapshot and Admission

`sync-cycle-planning.ts`, `plan-admission.ts`, `plan-admission-graph.ts`, and shared sync
types own snapshot capture, relevant-component construction, the exhaustive disposition
partition, and nominal authorization issuance. Admission's constructor/factory is the
only plain-`SyncPlan` to `AuthorizedSyncPlan` conversion boundary.

The outcome partition is exclusive and exhaustive:

- `authorized`: at least one proposed action and a permitted postcondition is proven;
- `resolved_no_action`: zero actions and explicit scope no-op or authoritative
  two-sided convergence is proven;
- `deferred`: every unknown, inconclusive, conflicting, incomplete, mismatched, or
  otherwise unproved relevant component.

Default is `deferred`. Exact-observation-only no-op paths with neither action nor
identity evidence are irrelevant and need no component. A remote rename edge with a
`present_unresolved` observation and zero actions is relevant and must be deferred.

<!-- anchor: component-finalization -->
## Component — mechanical finalization

`sync-cycle-finalization.ts`, `rename-debt.ts`, and `execution-result.ts` fold each
snapshot-bound disposition with mechanical completion. Deferred retains; resolved-no-
action is releasable; authorized is releasable only when all bound actions succeeded.
Checkpoint commit occurs before retirement. Policy-evaluating forms of
`renameEvidenceResolved`, `resolvedRenameDebts`, and `unresolvedRenameEvidence` are
removed or narrowed to mechanical consumers.

<!-- anchor: component-orchestrator-recovery -->
## Component — orchestration and recovery

`orchestrator.ts` remains the composition root and serializes backend/root lifecycle
with an in-flight cycle. It captures remote evidence before later fallible work, routes
the immutable snapshot through Admission, passes only the nominal authorized plan to
execution, reports dispositions, and handles only pre-Admission exceptions by retaining
captured evidence and requesting a later COLD run.

<!-- anchor: contract-proposal-boundary -->
## Contract — proposal, snapshot, and nominal authorization boundary

Decision rules:

1. Plain proposal/refinement output is never accepted by `executePlan`.
2. Snapshot capture occurs once after all required planning inputs exist and before
   Admission; captured arrays/records and namespace are immutable for the cycle.
3. Admission alone issues `AuthorizedSyncPlan`, branded by a module-private nominal
   member or equivalent opaque constructor that ordinary typed callers cannot create.
4. Execution and finalization use the same snapshot identity. Namespace/policy changes
   are queued for a later cycle, while teardown cannot overlap execution.

Normal witness: an exact deletion is admitted and retains original order. Adversarial
witness: a typed caller passing a proposal directly to `executePlan` fails build, and a
settings/root change between admission and execution cannot substitute new projection
or namespace inputs.

<!-- anchor: contract-admission-disposition -->
## Contract — exhaustive admission disposition

Inputs are the snapshot's proposal, evidence, observations, scope projection, and
namespace, owned by the composition root and produced respectively by proposal,
detector/tracker/backend, observation, scope policy, and active backend/root selection.
They are required before Admission. Missing represented facts yield unknown/deferred;
an acquisition exception before snapshot capture aborts into the pre-Admission recovery
contract. Evidence remains normative in its existing owner and is referenced, not
duplicated, by dispositions.

The determinate/unknown/inconclusive/conflicting epistemic partition maps to exactly one
disposition. Unknown, inconclusive, and conflicting always defer. The private membership
carrier may use object references or cycle-local indices, provided it is deterministic,
non-persistent, non-user-visible, and shared directly with finalization.

Normal witness: authoritative two-sided convergence with zero actions is
`resolved_no_action`. Adversarial witness: requested-echo presence with a rename edge
and zero actions is one `deferred` component, never omission or resolution.

<!-- anchor: contract-finalization-consumer -->
## Contract — disposition-driven commit-last finalization

Finalization receives the same snapshot's dispositions plus per-action succeeded,
failed, and blocked results. It may perform only membership/completion folding. It must
not inspect scope, observations, aliases, identities, or action shape to upgrade safety.
A deferred disposition or incompletely executed bound component retains evidence and
blocks the checkpoint. Once all work is releasable, checkpoint persistence precedes
debt/session-evidence retirement.

Normal witness: an authorized rename succeeds, checkpoint commits, then debt retires.
Adversarial witnesses: a bound action failure retains evidence; a checkpoint exception
leaves debt/evidence intact; disconnected successful work may commit per-file state but
cannot advance the cycle checkpoint while another component is deferred.

<!-- anchor: contract-preadmission-recovery -->
## Contract — pre-Admission COLD recovery boundary

The remote delta callback produces evidence into the existing session buffer before
fallible stat/hash/planning. An exception strictly before Admission invocation retains
the buffer, sets `recoverViaColdScan`, propagates through existing error reporting, and
does not create authorization or a disposition. A later empty delta plus COLD/full
observation resubmits the retained edge. There is no immediate retry loop.

Normal witness: ordinary acquisition reaches snapshot capture once. Adversarial witness:
a post-delta stat exception followed by an empty-delta retry still presents the edge to
Admission. Separately, the Issue #46 OneDrive/A-B checks vary evidence production, not
exception retention; passing this contract alone is never evidence that #46 is fixed.

## Contract evolution and rollout

The TypeScript consumers evolve atomically: snapshot capture, Admission output,
executor parameter, orchestrator, finalization, and focused tests compile together.
There is no persisted schema or wire migration; SyncState v6 and RenameDebt remain
unchanged. Rollback reverts the code/doc set together and requires no data rollback.
Baseline versus target discrimination is provided by the zero-action unresolved test,
the direct-proposal type failure, the snapshot mutation/root-change test, and the
finalization-no-redecision test.

## Decision closure

All draft inputs are closed. Admission is the sole authorization owner; actionless
relevant components are retained; existing `AdmissionResult` is enriched; the nominal
authorized carrier and immutable snapshot are adopted; commit-last and same-session
COLD recovery are preserved; persistent disposition/lifecycle state and Issue #46
fold-in are rejected; API changes are limited to the typed executor boundary; and
purity is verified by deterministic tests and build without expanding the lint policy.
The only delegated choice is the private cycle-local membership encoding described by
`discretion-component-membership-carrier`.

## Critique resolution

- `issue-authorization-expiry-unenforced`: resolved by immutable pre-Admission snapshot
  capture, snapshot-bound authorization/consumers, and serialized namespace teardown.
- `issue-executor-admission-boundary-open`: resolved by the Admission-only nominal
  `AuthorizedSyncPlan` constructor and executor parameter.
- `issue-issue46-owner-verification-blank`: resolved by assigning evidence production
  to the OneDrive backend/cache boundary and requiring the casing regression plus the
  Admission-constant A/B pipeline test independently of Issue #43 recovery tests.

## Verification witnesses

Focused T0 tests cover exact delete, actionless unresolved/resolved components,
determinism, bound failure retention, no finalization redecision, and checkpoint-before-
retirement. T1 tests cover typed composition, direct-proposal rejection, immutable
snapshot/root-policy stability, partial status, disconnected progress, and post-delta
exception recovery. T2 independently covers OneDrive casing/evidence emission and the
A/B pipeline causality. The repository gate remains lint, bot-reproduction lint, build,
and unit tests.
