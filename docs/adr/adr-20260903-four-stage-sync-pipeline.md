---
id: adr-20260903-four-stage-sync-pipeline
kind: adr
title: Adopt a four-stage sync pipeline
status: accepted
created: '2026-09-03'
decision_makers:
- project owner
consequences:
  positive:
  - The action-authority boundary becomes explicit and mechanically enforceable.
  negative:
  - Existing tests and documentation that construct pre-Admission SyncPlan values
    must migrate to fact-only observations.
  neutral:
  - Provider APIs, checkpoint schema, priority scheduling, and conflict policy remain
    unchanged.
confirmation: ESLint restricts production decision-engine imports to Admission, and
  the repository gate passes.
tags: []
owners: []
relations:
- {type: references, target: adr-20260831-admission-owns-identity-component-decisi}
- {type: references, target: adr-20260902-fresh-state-reconciliation-for-rename-edits}
source_paths:
- src/sync/sync-cycle-planning.ts
- src/sync/plan-admission.ts
- src/sync/plan-executor.ts
- src/sync/sync-cycle-finalization.ts
summary: Collapse proposal into Admission so the sync pipeline has four top-level
  responsibility owners.
updated: '2026-09-04'
---

## Context

The engine was documented as five stages: Observe, Propose, Admit, Execute, and Finalize. In code, Observation created a `SyncPlan` before Admission, while Admission was also declared the sole owner of component topology, conflict, destructive-action, and rename lifecycle decisions. That split admitted two action authorities and made structural convergence depend on convention.

The project owner approved the four-responsibility model on 2026-09-01 and subsequently chose the direct structural solution: keep the current PR54/PR57 semantics, but move path-local action construction behind the Admission boundary instead of adding late-bound machinery.

## Decision

Adopt exactly four top-level sync responsibilities: Observation acquisition, Admission decision, Effect execution, and Commit/finalization.

Observation shall return facts only. Admission shall be the only production boundary allowed to invoke the path-local action decision helper and shall return the exact `AuthorizedSyncPlan`. Execution shall perform only that plan. Commit/finalization shall publish state only from exact terminal outcomes and shall retain checkpoint/debt on partial or invalidated completion.

Consequently, Observation cannot fabricate rename evidence from a case alias, and
Execution cannot infer a special protocol from a missing baseline. Admission must
normalize each recognized component and decide it exhaustively from current
component-local facts. COLD/WARM/HOT selection, global store population, prior error,
and schema version are outside the decision boundary.

The orchestrator sequences these owners but is not an additional policy layer. Priority coordination and rename-debt gates remain mechanisms inside these owners, not additional stages. No provider/checkpoint API, persistence schema, phase order, conflict rule, or user-visible outcome changes as part of this decision.

A case-only parent transition follows the same four stages. Observation may acquire
the parent endpoints revealed by child aliases but creates no action. Admission alone
collapses the complete component into child content actions plus one parent folder
rename. Execution uses the entity-resolved local/remote endpoints already present in
those actions, then the existing structural barrier performs the parent rename.

## Consequences

{% consequence kind="positive" %}
There is one action authority, so rename/content convergence and conflict classification cannot disagree between a pre-Admission proposal layer and Admission.
{% /consequence %}

{% consequence kind="negative" %}
Tests that injected a `SyncPlan` at the Admission boundary must instead provide observed entries and let Admission construct the plan.
{% /consequence %}

{% consequence kind="neutral" %}
The existing decision table remains a private pure helper; provider behavior, checkpoint format, priority scheduling, and execution phase barriers stay unchanged.
{% /consequence %}

## Alternatives

Keep Propose as a fifth top-level stage. Rejected because it leaves action construction outside the declared sole authority and preserves the structural contradiction.

Introduce runtime re-Admission, epochs, receipts, or dynamically rerouted effects. Rejected because the current semantics require only one immutable batch admission, and the additional authority machinery would increase states without solving the normal boundary more simply.

Treat four layers as documentation-only groupings. Rejected because prose does not prevent Observation from continuing to emit executable actions.

`npm run lint` enforces the production import direction, and the full repository gate plus focused Admission/convergence tests verify behavior.


{% transition from="proposed" to="accepted" date="2026-09-03" %}
Approved by project owner in the four-layer responsibility discussion.
{% /transition %}
