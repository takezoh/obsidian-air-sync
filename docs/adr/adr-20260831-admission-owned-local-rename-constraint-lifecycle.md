---
id: adr-20260831-admission-owned-local-rename-constraint-lifecycle
kind: adr
title: Admission-owned local rename constraint lifecycle
summary: Persist only Admission-classified local safety constraints and retire exact
  membership only after its successful consequence and checkpoint.
status: accepted
created: '2026-08-31'
decision_makers:
- user
tags:
- sync
- rename
- safety
owners: []
relations:
- {type: partOf, target: change-20260831-issue51-rename-evidence-lifecycle}
- {type: references, target: adr-20260825-issue43-destructive-authorization}
- {type: references, target: adr-20260831-admission-owns-identity-component-decisi}
source_paths:
- src/sync/plan-admission.ts
- src/sync/rename-debt.ts
- src/sync/sync-cycle-finalization.ts
- src/sync/identity-component-decision.ts
consequences:
  positive:
  - Admission becomes the single owner of executable and durable local rename safety
    classification.
  - False v6 debt can converge from fresh authoritative facts without a reset while
    genuine or ambiguous debt remains fail closed.
  - Persistence failure and successful retirement have explicit pre-I/O and post-checkpoint
    boundaries.
  negative:
  - The immutable Admission snapshot and result must evolve together across acquisition,
    orchestration, persistence, and finalization.
  - Positive additive classification requires complete observations and therefore
    may retain or defer folder or chain cases whose completeness cannot be proven.
  neutral:
  - RenameEvidence tuple and RenameDebt SyncState v6 wire shape remain unchanged.
  - Remote rename authority, backend delta semantics, and the unproven blank-file
    symptom are not changed.
confirmation: Focused Admission, orchestrator, state, and finalization tests prove
  the positive additive witness, fail-closed counterexamples, upsert-before-I/O abort,
  current-scope authority, and consequence-bound post-checkpoint retirement.
updated: '2026-08-31'
---

# Admission-owned local rename constraint lifecycle

## Context

ADR 0008 section 6 requires unresolved local reported rename edges to be persisted
before plan I/O and tracker acknowledgement. That protects the only crash-replay source
for a genuine synchronized rename. The 0.1.42 implementation interpreted the trigger as
every in-scope tracker report, before Admission had established synchronized-resource or
destructive relevance.

For a never-synchronized local file renamed from `old` to `new`, the safe proposal can
be only `push(new)`. Scope-only debt promotion nevertheless turns the report into a
durable obligation to prove a native rename. Admission then emits `rename_mismatch`,
Finalization retains the deferred debt, and restart replays it indefinitely. Existing
v6 rows lack provenance that can distinguish this false debt from a genuine unresolved
rename.

Issue 43 separately establishes that Admission consumes one immutable cycle snapshot,
is the exclusive owner of destructive executable authority, and Finalization cannot
re-evaluate safety. Any correction must keep that owner and ADR 0008's fail-closed and
commit-last guarantees.

The accepted identity-component decision ADR extends that same owner to cross-path
action shaping. Lifecycle membership is therefore not a later interpretation of a
refined plan: shaped action, disposition, persistence, and release are projections of
one Admission component result.

## Decision

Amend only ADR 0008 section 6's local persistence trigger:

- A raw local tracker report or replayed v6 row is a rename candidate, not an
  already-authorized durable safety constraint.
- Admission is the sole owner that promotes a candidate to a safety-binding local
  constraint. Promotion uses an immutable proof projection containing edge identity,
  authoritative endpoint observations, baseline membership, identity/conflict facts,
  folder/chain completeness, current scope, proposal, origin, and namespace.
- Current scope is freshly projected from current settings and is authoritative. Scope
  dispositions stored in a v6 row are historical diagnostics and conservative hints;
  they never fill or override current `unknown`.
- A candidate is non-binding only when the entire connected component positively proves
  an additive unbaselined interpretation: no baseline or remote identity, authoritative
  old/intermediate absence, exact current local terminal presence, authoritative remote
  terminal absence, complete coverage, known compatible scope, and terminal pushes only.
  Missing, conflicting, destructive, synchronized, or incomplete evidence is
  safety-binding or inconclusive and remains fail closed.
- Admission emits exact `persistBeforeExecution` and
  `releaseAfterSafeCheckpoint` memberships associated with component dispositions. A
  successful safety-binding native rename belongs to both. A deferred edge is
  persist-only. A fresh non-binding report is in neither. A loaded false v6 row is
  release-only after its proved additive or already-converged consequence and a clean
  checkpoint.
- The orchestrator durably upserts all persistence membership before executor I/O or
  tracker acknowledgement. One failed upsert aborts the cycle visibly before either
  side effect and preserves loaded debt and pending evidence for retry.
- Finalization mechanically retires an exact release member only when its associated
  disposition is `resolved_no_action`, or is `authorized` with all actions successful,
  and the checkpoint commits. Deferral, failed/blocked action, missing association, or
  checkpoint failure retains it.
- Structured diagnostics distinguish fresh, replayed, promoted, non-binding, retained,
  released, and persistence-failed stages without content or credentials.

The existing `RenameEvidence` tuple and SyncState v6 `RenameDebt` wire shape are reused.
No schema migration, blanket deletion, general identity graph, or persistent lifecycle
state machine is introduced.

This ADR replaces only the phrase-level persistence trigger in ADR 0008
section 6: “unresolved local reported edge” means “unresolved local constraint that
Admission classified safety-binding.” All other ADR 0008 decisions remain accepted and
unchanged. Issue 43's exclusive Admission authority remains unchanged and is extended to
the durable rename lifecycle membership consumed by the orchestrator and Finalization.

## Rejected alternatives

- Persist whenever `prevSync` exists in planning. This keeps authority outside Admission
  and misses remote identity, scope, and destructive relevance.
- Delete every old row whose plan is push-only. Push spelling does not prove absence of
  a synchronized resource when observations or scope are incomplete.
- Add provenance fields in SyncState v7. New fields cannot truthfully reconstruct old
  0.1.42 provenance, and this project's schema policy would cold-start all stores.
- Remove durable rename debt and rely on tracker replay. Tracker acknowledgement or a
  process restart can erase the only genuine rename edge before a safe checkpoint.
- Add a general identity graph or persistent lifecycle state machine. The existing
  bounded edge carrier plus cycle-local component graph is sufficient.

## Consequences

{% consequence kind="positive" %} Admission becomes the single owner of executable and durable local rename safety classification. {% /consequence %}

{% consequence kind="positive" %} Existing false v6 debt can converge from fresh facts without a reset while ambiguous debt remains fail closed. {% /consequence %}

{% consequence kind="negative" %} Snapshot and result contracts must evolve atomically across acquisition, orchestration, persistence, and finalization. {% /consequence %}

{% consequence kind="negative" %} Folder and chain candidates remain retained when complete positive proof is unavailable. {% /consequence %}

{% consequence kind="neutral" %} RenameEvidence, RenameDebt v6, remote rename authority, and backend delta semantics remain unchanged. {% /consequence %}

{% consequence kind="neutral" %} This decision does not claim or implement a fix for the unproven blank-file symptom. {% /consequence %}

## Confirmation

Focused tests must prove the positive additive witness, current-scope authority over
stale v6 hints, fail-closed counterexamples, upsert failure with zero executor/tracker
side effects, and exact post-checkpoint retirement.
