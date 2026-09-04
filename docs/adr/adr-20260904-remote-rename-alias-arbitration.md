---
id: adr-20260904-remote-rename-alias-arbitration
kind: adr
title: Arbitrate rename authority once inside Admission
status: accepted
created: '2026-09-04'
decision_makers:
- project owner
consequences:
  positive:
  - A normative remote rename cannot be reversed by a lower-authority alias rewrite.
  - Folder authority is auditable as one exact complete current-call proof.
  - COLD, WARM, HOT, Google Drive, OneDrive, and Dropbox share one decision contract.
  negative:
  - Conflicting reports and incomplete folder topology fail the whole identity component
    even when a lower-authority candidate appears executable.
  - Candidate helper imports and top-level declarations become a closed guarded architecture
    surface.
  neutral:
  - Public actions, evidence, reasons, persistence, execution order, and checkpoint
    semantics do not change.
confirmation: RED Admission permutations and negative matrices, an affine collection-read
  bound, common acquisition/backend/lifecycle tests, discriminating AST guard fixtures,
  unchanged state-owner guard, documentation conformance, and the full repository
  gate.
tags:
- sync
- admission
- rename
- architecture
owners: []
relations:
- {type: originatedFrom, target: change-20260904-remote-rename-alias-arbitration}
- {type: modifies, target: adr-20260831-admission-owns-identity-component-decisi}
- {type: modifies, target: adr-20260831-admission-owned-local-rename-constraint-lifecycle}
- {type: modifies, target: adr-20260901-admission-priority-pull}
- {type: modifies, target: adr-20260902-fresh-state-reconciliation-for-rename-edits}
- {type: modifies, target: adr-20260903-four-stage-sync-pipeline}
- {type: modifies, target: adr-20260903-preserve-all-observed-remote-versions}
- {type: references, target: adr-20260903-stateless-current-state-recovery}
source_paths:
- src/sync/plan-admission.ts
- src/sync/identity-component-decision.ts
- src/sync/identity-component-report-family.ts
- src/sync/identity-component-topology.ts
- src/sync/plan-admission-case-alias.ts
- src/sync/local-rename-admission.ts
- src/sync/optimize-local-renames.ts
- src/sync/optimize-remote-renames.ts
- src/sync/plan-admission.test.ts
- eslint.config.mts
- sync-admission-authority-guard.test.mjs
summary: Select one rename authority family from immutable component facts, prove
  exact folder coverage privately, and preserve stateless downstream behavior.
updated: '2026-09-05'
---

## Context

Admission already owns identity-component authorization, but its current implementation
passes actions through several ordered candidate normalizers. An alias/current-fact
rewrite can therefore run before reported rename shaping and produce a plausible action
opposite to the provider's normative reported postcondition. The current topology path
also derives apparent RenameEvidence from the action under evaluation, so an action may
appear to prove its own folder coverage.

The observed recurrence contains local casing aliases, a provider-reported folder edge,
and stable descendant identities. Fixing only the triggering conditional would leave the
split semantic ownership and synthetic proof intact. The repair must establish one
authority decision and one independent proof without expanding durable or public state.

Several accepted ADRs and the current pipeline guide were written while SyncState v6
RenameDebt existed. Some present-tense clauses still say that planning/debt gates,
retained rename evidence, checkpoint/debt release, or RenameDebt meaning remain current,
although adr-20260903-stateless-current-state-recovery has already removed those concepts
from current correctness state. Historical ADRs must remain historical rather than being
silently rewritten.

## Decision

component-identity-component-authority remains the sole rename-arbitration semantic
owner for an identity component. Its public admitDestructivePlan facade preserves one
immutable raw component, invokes one private decideIdentityComponent producer exactly
once, and maps that closed result mechanically to one existing disposition. The private
producer classifies authority, selects one family, materializes that family once from raw
actions, consumes one subordinate topology proof, applies the final predicates once,
and returns. The report-family classifier, candidate shapers, and proof helper are pure
subordinate producers callable only by that decision; they do not own a component,
authorization, disposition, state, or lifecycle.

Classify all effective current-cycle reported claims before invoking any candidate
builder. Exact duplicates may collapse and the established narrow non-binding local
report classification remains, but no normative conflict may be discarded. A coherent
non-empty reported family wins over aliases. Incompatible reported roots, directions,
identities, or postconditions fail the component with rename_mismatch and do not fall
through. An alias-only/current-fact candidate may be considered only when the effective
reported set is empty. A selected-family private union narrows each builder; no builder
receives another family's rewritten actions or enough unselected facts to arbitrate
again. The ordered cross-family normalizer sequence is removed.

For a selected reported folder root, a pure subordinate topology helper starts from the
selected immutable RenameEvidence and binds exactly one correctly directed native folder
action. It accepts each and only each strict descendant pair that preserves the exact
relative suffix, has both endpoints included, and reuses neither endpoint. Every in-scope
endpoint below either root must occur exactly once. Missing, extra, deferred, unknown,
crossed, duplicated, unrelated, or ambiguous pairs make the mapping incomplete. Alias
membership is checked only after proof completeness and only against exact pairs. The
separate no-report local parent policy continues to use complete current facts and does
not manufacture a report.

The proof and its exact-pair index are immutable after construction, private to one
decision call, and unreachable when that call returns. They never enter a public action,
evidence type, AuthorizedSyncPlan, persistence schema, cache, module-scope mutable
collection, orchestrator field, checkpoint, retry, or recovery mechanism.

Failure precedence is deterministic and preserves the existing vocabulary:

1. An existing EvidenceUnknownReason or EvidenceContradictionReason returned by the
   selected alias/local mechanism is its singleton result.
2. Existing orthogonal present-unresolved, unknown-observation, conflicting-identity,
   and opposing-delete predicates are deduplicated and lexically sorted.
3. Within rename evaluation, normative conflict or failure to bind the selected
   root/action/direction/postcondition is rename_mismatch; a correctly bound folder with
   incomplete/ambiguous/unknown descendants is incomplete_folder_mapping; a correctly
   bound non-folder with unknown scope is unknown_scope; only a complete folder proof
   with an outside alias is alias_target_mutation.
4. Remaining no-report stable-identity, actionless, and standalone-delete failures retain
   their existing identity_postcondition_unproven or unknown_observation semantics.

Equal complete facts have one meaning across COLD, WARM, HOT, Google Drive, OneDrive,
and Dropbox. Their acquisition paths supply operational inputs but do not own rename
arbitration. Provider identity, temperature, prior failure, database version, global
record count, and recovery markers are not decision inputs. No provider production
branch, provider call, executor ordering, action/status/disposition/reason, per-file
commit, working-view abort, or clean-checkpoint rule changes.

Enforce the ownership structurally. Candidate and topology runtime helpers may be
value-imported in production only by identity-component-decision.ts; plan-admission.ts
imports the component decision entry. A TypeScript-AST guard inventories those edges and
rejects module-scope mutable correctness data in the decision/proof modules, with
synthetic module-scope Map and foreign-import negatives. This guard is verification and
enforcement of the same authority contract, not a runtime semantic component. The
existing sync-state-ownership-guard.test.mjs remains unchanged and independently
protects store, orchestrator, and checkpoint ownership.

## Clause-level supersession and documentation targets

This ADR clarifies and supersedes only earlier clauses that describe the following as
present behavior or current authority:

- SyncState v6 RenameDebt retaining current rename facts or remaining physically active;
- a planning/debt gate around normal or priority execution;
- evidence/debt retention until checkpoint or exact checkpoint/debt release;
- RenameDebt retirement, replay, or pending evidence as a finalization responsibility;
- unchanged RenameDebt meaning as a current compatibility promise.

Those clauses in adr-20260831-admission-owned-local-rename-constraint-lifecycle,
adr-20260901-admission-priority-pull,
adr-20260902-fresh-state-reconciliation-for-rename-edits,
adr-20260903-four-stage-sync-pipeline,
adr-20260903-preserve-all-observed-remote-versions, and
adr-issue43-destructive-authorization are historical context only. The rest of each
decision remains active unless superseded elsewhere. In particular, Admission ownership,
priority exact-action substitution, fresh current-fact reconciliation, preserve-all
conflict handling, the four-stage boundary, and destructive authorization remain intact.
The accepted stateless-current-state ADR and ADR 0001 govern the current two durable
authorities.

Implementation shall update the current AGENTS.md, ARCHITECTURE.md,
docs/sync-pipeline.md, docs/code-enforcement.md, and
docs/design/design-four-stage-sync-pipeline.md. It shall not edit accepted ADR text or
completed change packages. The active design gains INV-007 for single
selection/materialization/evaluation/disposition, INV-008 for exact call-local folder
proof, and BOUNDARY-007 for the closed helper-import/no-module-cache boundary.

## Consequences

{% consequence kind="positive" %}
Reported rename authority and alias evidence can no longer choose opposite action
families according to helper order.
{% /consequence %}

{% consequence kind="positive" %}
Folder descendant authorization is complete, exact, provider-neutral, and derived from
authority independent of the action being judged.
{% /consequence %}

{% consequence kind="negative" %}
A component with conflicting reports or incomplete topology cannot use an otherwise
plausible lower-tier action; it fails closed until current facts become determinate.
{% /consequence %}

{% consequence kind="negative" %}
The closed importer and declaration inventories must be deliberately updated when the
Admission module structure legitimately changes.
{% /consequence %}

{% consequence kind="neutral" %}
The observable vocabulary, public schemas, durable authorities, provider APIs,
executor barriers, successful-unit commits, abort semantics, and clean-cycle checkpoint
publication remain unchanged.
{% /consequence %}

## Rejected alternatives

- Add a condition around the known alias-first recurrence. This fixes one ordering
  symptom while retaining multiple semantic owners and action-derived proof.
- Reorder or patch the existing normalizer chain. Any ordered cross-family chain lets
  helper order arbitrate authority and makes later helpers consume rewritten actions.
- Make topology proof an independent component decision owner. That permits selection,
  evaluation, and disposition to diverge again.
- Infer report authority from a plausible proposed action or broaden a folder root to
  partial, unknown, crossed, or merely nearby descendants. The action cannot prove its
  own legitimacy and incomplete topology is not identity proof.
- Put provenance in public evidence/actions or retain proof in a module cache, store,
  orchestrator field, checkpoint, pending-work ledger, or recovery instruction. This
  would create another correctness owner and violate stateless replanning.
- Add backend-specific, COLD/WARM/HOT, prior-error, or schema-cold-start arbitration.
  Equal current facts must have one decision regardless of acquisition path.
- Change child/parent effect order or introduce an intermediate checkpoint. Admission
  repair does not require a downstream lifecycle change.


{% transition from="proposed" to="accepted" date="2026-09-05" %}
Project owner approved the structural Admission repair and rejected a local workaround on 2026-09-05.
{% /transition %}
