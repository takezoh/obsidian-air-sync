---
change: change-20260904-remote-rename-alias-arbitration
role: requirements
functional_requirements:
- id: FR-RAA-001
  statement: While Admission decides one connected identity component, it shall preserve
    the immutable raw component, invoke one private component-decision producer exactly
    once, evaluate exactly once, and emit exactly one existing final disposition through
    admitDestructivePlan.
  priority: must
- id: FR-RAA-002
  statement: When effective authoritative reported claims form one coherent family,
    Admission shall select their root, direction, identity, and postcondition before
    any alias-only candidate and shall derive direction only from the reported side
    and old-to-new edge.
  priority: must
- id: FR-RAA-003
  statement: If effective reported claims require incompatible roots, directions,
    identities, or postconditions, Admission shall fail the entire component with
    existing rename_mismatch semantics and no alias, ordinary-action, or reported-subset
    fallback.
  priority: must
- id: FR-RAA-004
  statement: When a selected reported folder root is materialized, its authority shall
    govern each and only each descendant in the same correctly directed native action
    after the complete mapping is proven suffix-aligned, included, endpoint-unique,
    exhaustive, and unambiguous.
  priority: must
- id: FR-RAA-005
  statement: The system shall treat aliases only as endpoint-equivalence facts and
    shall never let alias spelling, presence, or a plausible action synthesize a report,
    select direction while an effective report exists, or authorize a descendant outside
    the selected proof.
  priority: must
- id: FR-RAA-006
  statement: When the effective reported set is empty and complete current facts prove
    the existing local case-only parent policy, Admission shall retain child content
    work at provider-current paths and authorize exactly one existing parent rename_remote
    under the unchanged content-before-structural barrier.
  priority: must
- id: FR-RAA-007
  statement: Equal complete immutable component facts shall produce identical actions,
    disposition, and ordered reasons after COLD, WARM, or HOT acquisition and for
    Google Drive, OneDrive, or Dropbox, without temperature or provider identity as
    a decision input.
  priority: must
- id: FR-RAA-008
  statement: Admission shall apply the fixed failure-predicate precedence, deduplicate
    and canonically sort multi-reason results, emit only existing failure strings,
    and preserve the result across input permutations.
  priority: must
- id: NFR-RAA-001
  statement: The change shall add no persisted or public schema, migration, recovery
    branch, pending instruction, intermediate checkpoint, orchestrator field, correctness-critical
    cross-call owner, provider call, action, status, disposition, or failure reason.
  priority: must
- id: NFR-RAA-002
  statement: Classification, selected-family materialization, topology indexing, and
    final evaluation shall perform no I/O in linear time and call-local space, with
    instrumented reads no greater than 32 times the total actions, descendants, evidence,
    observations, and scope endpoints plus 128.
  priority: must
- id: NFR-RAA-003
  statement: A static guard shall reject production value imports of candidate or
    topology helpers outside identity-component-decision.ts and module-scope mutable
    correctness data in the decision/proof modules, while the existing state-owner
    guard remains unchanged and green.
  priority: must
- id: NFR-RAA-004
  statement: A new ADR shall explicitly supersede only stale present-tense RenameDebt
    and pending-retirement claims in earlier accepted ADRs; current guides and the
    active design shall state the stateless boundary without modifying historical
    ADR text or completed changes.
  priority: must
---

<!-- lifecycle is owned by change.md -->

# Requirements

## Content

## Outcome

Remote rename and case-alias facts have one deterministic meaning inside Admission.
Each identity-connected component is decided from immutable current-cycle facts by one
private producer and mapped once to an existing public disposition. A coherent reported
rename is authoritative over aliases; a conflicting report set fails closed; and folder
authority reaches only descendants proven as one exact complete mapping. The behavior is
stateless, provider-neutral, acquisition-temperature-neutral, and leaves execution and
commit semantics unchanged.

The ownership projection is singular: component-identity-component-authority owns the
rename-arbitration semantics. admitDestructivePlan is its public facade,
decideIdentityComponent is its once-called private producer, selected-family and
topology helpers are subordinate producers, provider/acquisition paths supply
operational inputs, and static guards verify the same authority contract rather than
forming additional semantic components.

## Functional requirements

### FR-RAA-001 — one identity-component semantic owner

While Admission decides one connected identity component, the system shall preserve the
immutable raw component, invoke one private component-decision producer exactly once,
evaluate exactly once, and emit exactly one existing final disposition through
admitDestructivePlan. Candidate and topology helpers shall not authorize, settle, fail,
or reinterpret the result.

### FR-RAA-002 — reported authority precedes aliases

When the effective authoritative reported claims in one component form one coherent
root, direction, identity, and postcondition family, Admission shall select that family
before any alias-only candidate and shall derive direction only from the reported side
and old-to-new edge.

### FR-RAA-003 — normative conflict has no fallback

If effective reported claims require incompatible roots, directions, identities, or
postconditions, Admission shall fail the entire component with rename_mismatch,
authorize no action, and shall not select an alias, ordinary path action, or reported
subset as fallback.

### FR-RAA-004 — exact selected-root descendant authority

When a selected reported folder-root claim is materialized, its authority shall govern
each and only each descendant pair belonging to the same correctly directed native
folder action after the complete mapping is proven suffix-aligned, included,
endpoint-unique, exhaustive, and unambiguous.

### FR-RAA-005 — aliases remain current facts

The system shall treat an alias only as endpoint-equivalence evidence. Alias spelling,
presence, or a plausible action shape shall never synthesize a reported claim, select
direction while an effective report exists, or authorize a descendant outside the
selected-root proof.

### FR-RAA-006 — no-report local parent convergence remains

When the effective reported set is empty and complete current facts prove the existing
local case-only parent policy, Admission shall preserve child content work at
provider-current paths and authorize exactly one existing parent rename_remote action.
The existing content-before-structural executor barrier shall remain unchanged.

### FR-RAA-007 — acquisition and backend equivalence

Given equal complete immutable component facts, Admission shall return identical
actions, disposition, and ordered reasons after COLD, WARM, or HOT acquisition and for
Google Drive, OneDrive, or Dropbox. Acquisition temperature and provider identity shall
not be decision inputs.

### FR-RAA-008 — deterministic existing failure observation

For every component fact set, Admission shall apply the fixed failure-predicate
precedence in implementation.md, deduplicate and canonically sort every multi-reason
result, and emit only the existing failure vocabulary. Input permutation shall not alter
the action set, disposition, or reason array.

## Non-functional requirements

### NFR-RAA-001 — closed state and behavior surface

The change shall add no persisted or public schema, schema version, migration, recovery
branch, pending instruction, intermediate checkpoint, orchestrator field,
correctness-critical cross-call owner, provider call, action, status, disposition, or
failure reason. Existing durable authorities remain unchanged.

### NFR-RAA-002 — bounded pure work

Authority classification, selected-family materialization, topology indexing, and the
final predicate fold shall perform no I/O and use O(A + D + E + O + S) time and
call-local auxiliary space for actions, descendant pairs, evidence, observations, and
relevant scope endpoints. Instrumented tests shall enforce
reads <= 32 * (A + D + E + O + S) + 128 for connected fixtures of sizes 64 and 512.

### NFR-RAA-003 — discriminating static architecture guard

The repository shall statically reject any production value import of a candidate or
topology helper outside identity-component-decision.ts and shall reject module-scope
mutable correctness data in the component-decision and topology modules. The existing
state-owner/checkpoint guard shall remain unchanged and green.

### NFR-RAA-004 — durable documentation authority

A new ADR shall record the approved arbitration/proof decision and explicitly supersede
only stale present-tense RenameDebt and pending-retirement claims in earlier accepted
ADRs. Current guides and the active four-stage design shall describe the stateless
boundary, while historical ADR text and completed change packages remain unchanged.

## Acceptance scenarios

### Scenario 1 — authoritative remote folder report defeats inverse aliases

- Given immutable component facts containing local aliases, one authoritative remote
  folder report from TemplateS to Templates, its exact complete descendant mapping, and
  stable remote identities
- When Admission decides the component
- Then it emits only rename_local from TemplateS to Templates, returns one authorized
  disposition with no reason, and does not run an alias-only family

### Scenario 2 — normative conflict fails without fallback

- Given two effective reported claims that cannot share one root, direction, identity,
  and postcondition, plus a complete alias-only candidate
- When Admission decides the component under any input permutation
- Then it returns one failed disposition with exactly rename_mismatch and no executable
  action

### Scenario 3 — folder authority covers only a complete exact mapping

- Given one correctly bound reported folder root and a suffix-preserving, included,
  endpoint-unique, exhaustive descendant mapping
- When Admission proves topology
- Then every exact descendant pair is governed once and no unrelated alias or endpoint
  is included

### Scenario 4 — incomplete or ambiguous topology fails closed

- Given a correctly bound reported folder root whose mapping is empty, partial,
  unaligned, crossed, duplicated, additional, deferred, unknown-scope, or ambiguous
- When Admission evaluates the component
- Then it emits no action and returns exactly incomplete_folder_mapping before testing
  whether an alias lies outside the proof

### Scenario 5 — complete proof exposes an unrelated alias

- Given a complete selected-root proof and an alias whose unordered endpoints are not
  one exact proven pair
- When Admission evaluates the component
- Then it emits no action and returns exactly alias_target_mutation

### Scenario 6 — no-report local case-only flow remains compatible

- Given no effective reported claim and complete current facts satisfying the existing
  local case-only parent predicates
- When Admission decides the component
- Then it retains child content work at provider-current paths and one parent
  rename_remote action, with existing execution order unchanged

### Scenario 7 — equal facts converge across acquisition and provider labels

- Given equal complete components constructed through COLD, WARM, and HOT fixtures and
  through each registered backend-family contract
- When Admission evaluates them
- Then actions, disposition, and ordered reasons are identical

### Scenario 8 — architectural ownership is mechanically closed

- Given a synthetic module-scope proof Map or a production module other than the
  component decision that value-imports a candidate/topology helper
- When the static authority guard runs
- Then it fails; and given only pure call-local declarations and the sole approved
  importer, it passes together with the unchanged state-owner/checkpoint guard

## Counterexamples that must remain rejected

- Running an alias normalizer before report classification and then treating its output
  as the reported-family input.
- Resolving conflicting normative reports by priority, first-match, lexical tie-break,
  or fallback to an alias candidate.
- Constructing RenameEvidence from an action that is itself awaiting Admission.
- Accepting only the visible subset of a folder mapping or treating deferred/unknown
  descendants as absent.
- Placing proof provenance in AuthorizedSyncPlan, public action/evidence types, a cache,
  a module-scope collection, an orchestrator field, a checkpoint, or persisted state.
- Branching on provider kind, COLD/WARM/HOT, prior failure, schema version, or global
  record count to alter the decision.
- Reordering child content and parent structural effects or changing commit/finalization
  rules as part of this repair.

## Non-goals

The package does not redesign provider rename discovery, add actor attribution, add a
recovery protocol, migrate storage, add public provenance, create new observable
vocabulary, change conflict policy, or revise executor and checkpoint behavior.
