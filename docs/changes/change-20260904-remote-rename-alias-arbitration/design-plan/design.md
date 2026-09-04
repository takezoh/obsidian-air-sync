# Remote rename and alias arbitration

<!-- anchor: goal -->
## Goal

Repair the recurring post-success folder-rename failure by making
component-identity-component-authority the only semantic owner of an identity-component
Admission decision. For every connected component, its public admitDestructivePlan
facade preserves the immutable raw facts, invokes one private decideIdentityComponent
producer exactly once, and maps its closed result to exactly one existing disposition.
The producer classifies authority, selects at most one candidate family, materializes
that family once from the raw actions, obtains one subordinate topology proof, evaluates
the existing fail-closed predicates once, and returns.

The topology helper is a pure subordinate data producer inside that decision. It is not
a component owner, final evaluator, action authorizer, disposition owner, or lifecycle
owner. Its proof is immutable after construction, call-local, and unreachable after the
component call returns.

The repaired flow is:

    immutable raw identity component
            |
            v
    classify all reports and current-fact proposals
            |
            v
    select once: coherent reported family > alias-only family > none
            |
            v
    conflicting normative reports fail; no lower-tier fallback
            |
            v
    materialize the selected family once from raw actions
            |
            v
    derive one selected-root topology proof
            |
            v
    evaluate once; dispose once

This is an Admission-only responsibility repair. It adds no persisted state, recovery
path, intermediate checkpoint, orchestrator field, public provenance, provider-specific
policy, action kind, status, disposition, failure reason, or executor ordering rule.

<!-- anchor: scope -->
## Scope

The implementation surface is deliberately structural and narrow:

- plan-admission.ts retains the authority component's public Admission facade, component partition loop,
  AuthorizedSyncPlan construction, and one disposition mapping per component.
- identity-component-decision.ts becomes the only private per-component semantic
  producer called by that loop.
- identity-component-report-family.ts is a pure decision-only classifier for the
  selected-family private value; it cannot shape or authorize actions.
- identity-component-topology.ts is a planned pure helper that derives proof data for
  that producer and has no public or independent production caller.
- plan-admission-case-alias.ts, local-rename-admission.ts,
  optimize-local-renames.ts, and optimize-remote-renames.ts remain subordinate candidate
  mechanisms. Their runtime entry points accept the immutable raw component and an
  already selected family variant; they cannot see enough unselected input to choose
  authority again and cannot consume another family's rewritten actions.
- plan-admission.test.ts pins the production recurrence, selection permutations,
  reason precedence, exact-root coverage, synthetic-authority rejection, and a
  collection-read complexity bound before production changes.
- Existing provider, executor, committer, finalizer, and state-owner tests are
  compatibility evidence. Their production implementations and ordering are not change
  targets.
- A new sync-admission-authority-guard.test.mjs statically closes production helper
  importers and top-level runtime declarations in the decision/proof modules.
- The new ADR, active four-stage design promotion, current architecture/pipeline guide,
  and enforcement guide make the repaired boundary durable. Historical accepted ADRs
  are not silently edited.

The production-shaped witness contains three local alias facts, one authoritative
remote folder report TemplateS to Templates, and two stable remote identities. The
current alias-first rewrite creates the inverse rename_remote candidate; bypassing only
that rewrite reveals the second defect, because action-derived coverage no longer binds
the reported root to its exact descendants. Both causal layers therefore belong to one
authority-to-proof repair.

Out of scope are Google actor attribution, provider payload changes, live-provider
feature work, schema migration, persisted evidence or intent, pending work, recovery
instructions, conflict-policy changes, executor rescheduling, rollback, and any
special COLD, WARM, or HOT branch.

<!-- anchor: approach -->
## Chosen approach

Use one algorithm-bound private component decision. Before any candidate builder runs,
the decision classifies the raw component's reported claims, including the existing
narrow non-binding local-report classification. Exact duplicate reports may collapse,
but no normative conflict is erased. If the effective reported set is non-empty, all
its claims must describe one coherent postcondition family; that family wins over every
alias-only proposal. If it is contradictory, the component fails with rename_mismatch
and never falls through. Only an empty effective reported set permits an alias-only
candidate, and the alias still needs all existing endpoint, identity, vacancy, scope,
baseline, and content facts.

The selected-family value is a closed private union. Candidate functions receive that
variant plus the unchanged raw component. A central materialization step may combine
subordinate fragments within the selected coherent family, but no builder receives
another family's action output and no ordered chain successively rewrites the component.
The result is one shaped action set, evaluated once.

For a selected reported folder root, proof starts with the selected RenameEvidence,
never with the proposed action. It binds exactly one correctly directed native folder
action and only its complete, suffix-preserving, included, endpoint-unique descendants.
A distinct current-fact parent proof preserves the established no-report local
case-only canonicalization path without relabelling an alias as a report.

## Requirements

<!-- anchor: fr-raa-001 -->
### FR-RAA-001 — one identity-component semantic owner

While Admission decides one connected identity component, the system shall preserve
the immutable raw component, invoke one private component-decision producer exactly
once, evaluate exactly once, and emit exactly one existing final disposition through
admitDestructivePlan. No candidate or proof helper may authorize, settle, fail, or
reinterpret that result.

<!-- anchor: fr-raa-002 -->
### FR-RAA-002 — reported authority precedes aliases

When the effective authoritative reported claims in one component form one coherent
root, direction, identity, and postcondition family, Admission shall select that family
before any alias-only candidate and shall derive direction only from the reported side
and old-to-new edge.

<!-- anchor: fr-raa-003 -->
### FR-RAA-003 — normative conflict has no fallback

If effective reported claims require incompatible roots, directions, identities, or
postconditions, Admission shall fail the entire component with existing
rename_mismatch semantics, authorize no action, and shall not select an alias, ordinary
path action, or another reported subset as fallback.

<!-- anchor: fr-raa-004 -->
### FR-RAA-004 — exact selected-root descendant authority

When a selected reported folder-root claim is materialized, its authority shall govern
each and only each descendant pair belonging to the same correctly directed native
folder action after the complete mapping is proven suffix-aligned, included,
endpoint-unique, exhaustive, and unambiguous.

<!-- anchor: fr-raa-005 -->
### FR-RAA-005 — aliases remain current facts

The system shall treat an alias only as endpoint-equivalence evidence. Alias spelling,
presence, or a plausible action shape shall never synthesize a reported claim, select
direction while an effective report exists, or authorize a descendant outside the
selected root proof.

<!-- anchor: fr-raa-006 -->
### FR-RAA-006 — no-report local parent convergence remains

When the effective reported set is empty and complete current facts prove the existing
local case-only parent policy, Admission shall preserve child content work at
provider-current paths and authorize exactly one existing parent rename_remote action.
The existing content-before-structural executor barrier shall remain unchanged.

<!-- anchor: fr-raa-007 -->
### FR-RAA-007 — acquisition and backend equivalence

Given equal complete immutable component facts, Admission shall return identical
actions, disposition, and ordered reasons after COLD, WARM, or HOT acquisition and
for Google Drive, OneDrive, or Dropbox. Acquisition temperature and provider identity
shall not be decision inputs.

<!-- anchor: fr-raa-008 -->
### FR-RAA-008 — deterministic existing failure observation

For every component fact set, Admission shall apply the fixed failure-predicate
precedence in this design, deduplicate and canonically sort every multi-reason result,
and emit only the existing failure vocabulary. Input permutation shall not alter the
action set, disposition, or reason array.

<!-- anchor: nfr-raa-001 -->
### NFR-RAA-001 — closed state and behavior surface

The change shall add no persisted or public schema, schema version, migration,
recovery branch, pending instruction, intermediate checkpoint, orchestrator field,
correctness-critical cross-call owner, provider call, action, status, disposition, or
failure reason. The two existing durable authorities remain unchanged.

<!-- anchor: nfr-raa-002 -->
### NFR-RAA-002 — bounded pure work

Authority classification, selected-family materialization, topology indexing, and the
final predicate fold shall perform no I/O and use O(A + D + E + O + S) time and
call-local auxiliary space for actions, descendant pairs, evidence, observations, and
relevant scope endpoints. An instrumented T0 test shall enforce
reads <= 32 * (A + D + E + O + S) + 128 on connected scaled fixtures and reject
all-pairs rescanning.

<!-- anchor: nfr-raa-003 -->
### NFR-RAA-003 — discriminating static architecture guard

The repository shall statically reject any production value import of a candidate or
topology helper outside identity-component-decision.ts and shall reject module-scope
mutable correctness data in the component-decision and topology modules. The existing
state-owner/checkpoint guard shall remain unchanged and green.

<!-- anchor: nfr-raa-004 -->
### NFR-RAA-004 — durable documentation authority

A new ADR shall record the approved arbitration/proof decision and explicitly
supersede only the stale present-tense RenameDebt and pending-retirement claims in
earlier accepted ADRs. Current guides and the active four-stage design shall describe
the stateless boundary, while historical ADR text and completed change packages remain
unchanged.

## Decision context

<!-- anchor: adr-20260904-remote-rename-alias-arbitration -->
### ADR — arbitrate rename authority once inside Admission

The proposed ADR records the already approved structural outcome: one component
decision, reported-over-alias precedence, no conflict fallback, exact selected-root
coverage, deterministic existing reasons, private call-local proof, and no state or
downstream changes. It also states clause-level supersession: any earlier accepted ADR
sentence that describes SyncState v6 RenameDebt, evidence retention, a planning/debt
gate, checkpoint/debt retention, or debt retirement as present behavior is historical
only after the accepted stateless-current-state decision. The rest of those ADRs
remains valid. Their files are not edited.

<!-- anchor: adr-0001-metadata-cache-is-subordinate-to-commit-last -->
ADR 0001 keeps durable correctness closed to the successful per-file SyncRecord and
the wholly clean cursor plus complete derived cache checkpoint. A proof value cannot
become a third authority.

<!-- anchor: adr-0006-remote-rename-detection-is-order-independent -->
ADR 0006 requires every registered backend family to expose a folder move through the
same provider-neutral RenamePair/current-snapshot contract. Admission does not branch
on its producer.

<!-- anchor: adr-0008-logical-identity-admission-fails-closed -->
ADR 0008 makes reported rename evidence normative, alias spelling factual,
folder completeness mandatory, and any unproved identity component non-executable.

<!-- anchor: adr-20260831-admission-owns-identity-component-decisi -->
The accepted Admission-ownership ADR fixes component-identity-component-authority,
exposed through admitDestructivePlan, as the cross-path semantic owner and candidate
builders as subordinate. The new decision clarifies that one private
decideIdentityComponent producer supplies the component result, while the public facade
only maps it to authorization and disposition.

<!-- anchor: adr-20260903-four-stage-sync-pipeline -->
The accepted four-stage ADR keeps Observation factual, Admission authoritative,
Execution exact, and Commit/finalization terminal. Its action-authority boundary
remains; only its obsolete present-tense checkpoint/debt and rename-debt-gate wording
is superseded by the new clarification.

<!-- anchor: adr-20260903-stateless-current-state-recovery -->
The accepted stateless recovery ADR requires each retry to re-observe current facts and
prohibits persisted evidence, debt, pending work, recovery instructions, and
prior-failure decision inputs.

## Components

<!-- anchor: component-identity-component-authority -->
### Identity-component Admission authority

component-identity-component-authority is the sole semantic owner. Existing grounding is
src/sync/plan-admission.ts, src/sync/plan-admission-graph.ts,
src/sync/identity-component-decision.ts, identity-component-report-family.ts,
plan-admission-case-alias.ts,
local-rename-admission.ts, optimize-local-renames.ts, and
optimize-remote-renames.ts. Those selected-family shapers and the planned
identity-component-topology.ts are pure subordinate producers/implementation targets
owned by this component, not components or decision owners themselves. The topology
proof is a call-local value returned only to the private decision producer. The public
integration seam is admitBatchObservation/admitDestructivePlan and the deterministic
test seam is plan-admission.test.ts.

identity-evidence.ts, change-detector.ts, sync-cycle-planning.ts,
fs/caching/id-delta.ts, fs/dropbox/incremental-sync.ts, and the central remote backend
contract matrix remain operational-input producers and compatibility evidence. They do
not own rename arbitration, and no provider production implementation changes. The
static lint/AST guards and durable documentation are verification and enforcement of
this same authority boundary, not another runtime component or semantic owner.

<!-- anchor: component-execution-commit-boundary -->
### Existing execution and commit boundary

plan-executor.ts, state-committer.ts, sync-cycle-finalization.ts, and the
checkpoint-capable filesystem own effect order, post-I/O file records, working-view
abort, and clean checkpoint publication. They consume the same AuthorizedSyncPlan and
do not receive authority/proof data.

## Implementation contracts

<!-- anchor: contract-single-component-admission -->
### Contract: one component decision and disposition

Owner: component-identity-component-authority. Subject: the semantic decision for one
immutable identity-connected component.

Operational inputs:

| Input ID | Producer and source | Acquisition and lifetime | Invalid or unavailable result |
|---|---|---|---|
| input-raw-component | buildAdmissionComponents from one immutable BatchObservation and raw path-local actions | frozen before the private decision; call-local | no authorization |
| input-component-scope | scope projection already present in the snapshot | frozen with the component | existing unknown/incomplete failure |
| input-component-baselines | committed SyncRecords already attached to entries/actions | current component call only | existing unproven/unknown result |

Decision rules:

- rule-component-call-once: admitDestructivePlan calls decideIdentityComponent once
  for each component produced by the exhaustive partition.
- rule-private-producer-only: decideIdentityComponent performs classification,
  selection, materialization, proof consumption, and final reason calculation on behalf
  of the owning component as one cohesive private producer. No other caller can invoke
  its subordinate builders.
- rule-public-disposition-once: admitDestructivePlan maps the closed producer result
  mechanically to one authorized, resolved_no_action, or failed disposition and cannot
  change selection or suppress a reason.
- rule-raw-preservation: no candidate function mutates or replaces the shared raw
  component before authority selection.

Observable effects:

- observable-one-component-result: every relevant component has one and only one
  disposition.
- observable-authorized-plan-only: actions enter AuthorizedSyncPlan only when that
  component's final reason array is empty.
- observable-input-order-invariance: permutations of the same facts produce the same
  action/disposition/reason projection.

Invariants are one call, one component result, one disposition, and no post-result
allowlist. An impossible private result, duplicate component result, or missing result
is an internal contract violation and fails fast before effects; it is not converted
to a new user-facing reason.

The outcome partition is determinate, unknown, inconclusive, or conflicting. Only a
determinate closed result can authorize. T0 verifies exact count/kind/actions/reasons;
T1 verifies the private importer inventory. A normal witness is one unrelated ordinary
component plus the reported folder component, each disposed exactly once. An
adversarial witness makes a candidate helper return plausible actions before final
identity rejection and must still produce one failed disposition with no executable
action.

<!-- anchor: contract-authority-arbitration -->
### Contract: classify once, select once, shape once

Owner: component-identity-component-authority. Subject: rename authority precedence
and selected-family materialization.

Operational inputs:

| Input ID | Producer and source | Acquisition and lifetime | Invalid or unavailable result |
|---|---|---|---|
| input-reported-claims | current-cycle RenameEvidence with authority reported, after scope projection and the existing exact non-binding local-report classification | read once from the raw component | unknown/inconclusive report fails; conflict remains conflict |
| input-alias-facts | current PathObservation and alias IdentityEvidence | call-local fact only | cannot supply report authority |
| input-current-fact-proposal | existing case-alias/local fresh-state predicates over raw endpoints, identity, baseline, vacancy, scope, and content | derived only if the effective reported set is empty | existing evidence reason or no candidate |
| input-raw-actions | unmodified path-local actions | supplied to exactly one selected-family materializer | selected family fails; no fallback |

Decision rules:

- rule-classify-reports-first: collapse exact duplicate claims, classify the existing
  narrowly proven non-binding local report, and retain every remaining report and
  identity fact.
- rule-coherent-report-family: reported claims are coherent only when one root,
  direction, identity, and postcondition action family can satisfy all of them.
- rule-reported-wins: a coherent non-empty reported family is selected before any
  alias-only proposal; aliases remain validation facts.
- rule-conflict-stops: incompatible normative claims select no subset and cannot fall
  through to aliases or ordinary actions.
- rule-alias-only-when-empty: an alias-only family may be considered only when the
  effective reported set is empty.
- rule-selected-signatures: every runtime candidate builder accepts the immutable raw
  component and an already narrowed selected-family variant. It does not accept another
  builder's action output or enough unselected claims to reselect precedence.
- rule-one-materialization: one central materializer builds the chosen family from the
  original actions once; no cross-family ordered rewrite chain remains.

Observable effects:

- observable-reported-remote-wins: the exact TemplateS to Templates remote report plus
  inverse-looking local aliases produces only rename_local TemplateS to Templates.
- observable-report-conflict-fails: incompatible reported claims produce no
  executable component action and exact reason rename_mismatch.
- observable-alias-only-compatible: removing all effective reports exposes the
  established complete local parent rename_remote path.

The partition is determinate for one coherent family or ordinary none, unknown when
required current evidence is absent, inconclusive when the selected family cannot
materialize, and conflicting when normative reports cannot share one postcondition.
Unknown, inconclusive, and conflicting never try another family. Tests permute evidence,
actions, and aliases and include a complete alias candidate beneath a conflicting
reported set. The primary adversarial witness is an alias-first builder or reported
subset tie-break; either changes observable direction and fails.

<!-- anchor: contract-root-proof-failure-semantics -->
### Contract: selected-root proof and deterministic failure semantics

Owner: component-identity-component-authority. Subject: the subordinate topology proof
and exact existing reason output.

Operational inputs:

| Input ID | Producer and source | Acquisition and lifetime | Invalid or unavailable result |
|---|---|---|---|
| input-selected-family | contract-authority-arbitration closed union | immutable within one decision call | no proof and no authorization |
| input-shaped-actions | the one selected-family materialization from raw actions | created once, call-local | rename_mismatch; no action fallback |
| input-descendant-scope | included/unknown/deferred endpoint projection for both selected roots | frozen current cycle | folder mapping incomplete or non-folder scope unknown |
| input-identity-observations | aliases, stable identity occurrences, destination occupancy, and exact/absent observations | frozen current cycle | existing orthogonal fail-closed reason |

Decision rules:

- rule-proof-from-authority: a reported RootTopologyProof begins with the selected
  RenameEvidence and binds exactly one native folder action having equal old/new roots,
  folder kind, and the side-derived action direction. It never creates RenameEvidence
  from an action.
- rule-exact-descendants: each pair is strictly under both roots, preserves the exact
  relative suffix, has included endpoints, and reuses neither endpoint.
- rule-total-descendants: every in-scope component endpoint below either root occurs
  exactly once. Omitted, additional, deferred, unknown, crossed, duplicated, unrelated,
  or ambiguous pairs make the proof incomplete.
- rule-alias-membership-after-proof: only after a complete proof may an alias whose
  unordered endpoints equal one exact pair be accepted as consistent with that root.
- rule-current-fact-parent-distinct: the no-report local parent path uses a distinct
  current-fact proof with the existing exact remote source, authoritative target
  absence, complete child mapping, content, identity, and scope predicates. It does not
  fabricate a report.
- rule-proof-lifetime: proof and pair index are private, read-only after construction,
  returned only to decideIdentityComponent, and discarded before Admission returns.

Failure precedence is closed as follows:

| Priority | Predicate | Exact rename-specific result |
|---|---|---|
| 0 | Selected alias/local normalization returns an existing EvidenceUnknownReason or EvidenceContradictionReason | that singleton existing reason; no later family |
| 1 | present_unresolved, unknown observation, conflicting identity, or opposing deletes | the true existing orthogonal reasons, deduplicated and lexically sorted; rename evaluation does not mask or replace them |
| 2a | normative reports conflict, or a selected report cannot bind uniquely to the shaped root/action/direction/postcondition | rename_mismatch |
| 2b | a correctly bound folder root has empty, partial, unaligned, non-unique, non-exhaustive, ambiguous, deferred, or unknown-scope descendants | incomplete_folder_mapping |
| 2c | a correctly bound non-folder report has deferred/unknown scope | unknown_scope |
| 2d | the root proof is complete but an alias lies outside its exact pair set | alias_target_mutation |
| 3 | no-report stable identity remains uncovered, an actionless component is unresolved, or a standalone delete lacks authoritative absence | the existing identity_postcondition_unproven or unknown_observation predicate |

Within priority 2, the first matching row is the only rename-specific reason. The final
array is deduplicated and lexically sorted whenever multiple orthogonal reasons are
permitted. This preserves every existing string while making overlaps deterministic.
In particular:

- conflicting report plus complete alias yields exactly [rename_mismatch];
- wrong root/direction plus partial descendants yields exactly [rename_mismatch];
- correctly bound partial mapping plus alias yields exactly
  [incomplete_folder_mapping];
- correctly bound unknown-scope descendant plus alias yields exactly
  [incomplete_folder_mapping];
- complete root proof plus unrelated alias yields exactly [alias_target_mutation];
- non-folder deferred scope yields exactly [unknown_scope].

Observable effects are observable-exact-root-coverage, which accepts every and only
the selected root's complete pairs; observable-no-synthetic-authority, which rejects a
plausible action lacking selected authority; and observable-stable-reason-array, which
fixes the arrays above across permutations.

The partition is determinate only for a unique complete proof or an applicable ordinary
no-proof path, unknown for missing observations/scope, inconclusive for a selected but
unproved mapping, and conflicting for competing claims/identities. T0 covers each
positive and negative individually. A risk-tagged normal witness is the reported
folder recurrence. Adversarial witnesses are unrelated, missing, crossed, duplicated,
wrong-root, wrong-direction, extra, unresolved, unknown-scope, synthetic-action, and
covered-plus-uncovered pairs. Every negative asserts exact reasons and zero executable
actions.

The proof pass and its consumers share one index. Instrumented collection fixtures at
sizes 64 and 512 count element reads without a production counter; each must satisfy
reads <= 32 * (A + D + E + O + S) + 128. The larger balanced action/evidence fixture
must fail for an all-pairs implementation.

<!-- anchor: contract-provider-temperature-equivalence -->
### Contract: shared facts have one meaning

Owner: component-identity-component-authority. Operational-input producers, rather than
semantic owners, supply the existing provider-neutral RenamePair/current snapshot,
completed current identity/alias observations, and committed baselines. WARM/HOT folder
reports retain their existing post-delta complete-snapshot requirement; COLD supplies
current facts directly. The decision signature accepts no temperature, provider
discriminator, prior error, database version, or global record count.

Rule provider-neutral-facts requires all three registered backend families to emit the
same folder RenamePair shape and enter the common Admission contract. Rule equal-facts
requires equal complete components to produce equal actions/disposition/reasons even
when a test namespace labels acquisition differently. Missing live credentials are
unknown operational evidence, not permission for a provider branch.

Observable provider-contract-parity is the central Google Drive, OneDrive, and Dropbox
contract matrix remaining green. Observable temperature-equivalence is equality of the
Admission projection for constructed equal facts. Determinate facts use the common
contract; missing/ambiguous facts fail at the existing boundary. Optional live E2E may
confirm fidelity but is not a closure substitute.

<!-- anchor: contract-execution-state-preservation -->
### Contract: execution and durable authority remain unchanged

Owner: component-execution-commit-boundary. The input is the exact AuthorizedSyncPlan
plus existing terminal effect results. Child content/conflict work drains before the
parent structural rename under the existing barrier. A file SyncRecord commits only
after admitted I/O and terminal proof. The remote cursor, complete derived cache, and
scope checkpoint publish only after the whole cycle is clean.

A child or parent failure, Admission failure, blocked action, missing terminal proof,
or exception remains non-clean. The checkpoint owner aborts the live working view and
the next attempt re-observes current facts. Successful child records are not rolled
back. Selected family, proof, reason, and disposition are never persisted or retained
for retry. The outcome partition is existing terminal success versus incomplete/
conflicting failure; no recovery mode is added.

The normal lifecycle witness is a clean local Templates to TemplateS transition,
clean checkpoint, later reported provider TemplateS to Templates transition with
unchanged Windows-style aliases, one rename_local action, and clean completion. The
adversarial cut fails a child or the parent and observes post-I/O record semantics,
checkpoint withholding, working-view abort, and ordinary recomputation. Provider
production code, executor ordering, commit logic, and checkpoint APIs must remain
unchanged.

<!-- anchor: contract-admission-architecture-conformance -->
### Contract: keep the private authority boundary closed

Owner: component-identity-component-authority. This static contract is the verification
and enforcement projection of the same authority boundary, not a runtime component or
semantic owner. It has two independent guards.

First, eslint.config.mts adds identity-component-report-family.ts and
identity-component-topology.ts to PURE_TRANSFORMS and
keeps backend, filesystem, clock, randomness, and Node imports forbidden. Runtime/value
imports of plan-admission-case-alias, local-rename-admission,
optimize-local-renames, optimize-remote-renames, identity-component-report-family, and
identity-component-topology are legal in production only from
identity-component-decision.ts. plan-admission.ts imports the component decision entry,
not those builders. Type-only compatibility exports carry no capability and are
separately inventoried.

Second, sync-admission-authority-guard.test.mjs uses the installed TypeScript AST and
a closed source inventory to assert those production import edges and the top-level
runtime declarations of identity-component-decision.ts,
identity-component-report-family.ts, and identity-component-topology.ts. Allowed declarations are imports, exported types/
interfaces, pure function declarations, and const primitive literals. The guard rejects
let/var, class/enum, object/array/Map/Set or other mutable const initializers, assignment
or update expressions at module scope, and any new production value importer.
Synthetic negatives must prove that const proofCache = new Map() and an import from an
unapproved production module fail. A synthetic pure-function/type module must pass.

The new guard is added to lint:bot-repro. The existing
sync-state-ownership-guard.test.mjs remains unchanged and separately proves the closed
orchestrator/store/checkpoint inventory. Passing one guard cannot waive the other.

Durable conformance adds INV-007 and INV-008 plus BOUNDARY-007 to
design-four-stage-sync-pipeline. The current pipeline and architecture guides remove
present-tense debt ownership and link the new ADR. The new ADR, rather than edits to
accepted history, explicitly supersedes the stale clauses. Any forbidden importer,
module-scope proof cache, state-owner change, stale current guide, or red full gate
blocks completion.

## Decision inputs and final dispositions

| Decision input | Final disposition |
|---|---|
| decision-input-structural-owner | adopted by the new ADR and contract-single-component-admission: component-identity-component-authority is the one Admission semantic owner, with one public facade and one private producer; a local conditional is rejected. |
| decision-input-reported-precedence | adopted by the new ADR and contract-authority-arbitration: coherent reports win and conflicting reports stop without fallback. |
| decision-input-root-descendant-authority | adopted by the new ADR and contract-root-proof-failure-semantics: only selected-root exact complete coverage governs descendants. |
| decision-input-closed-state | adopted from ADR 0001 and the stateless ADR; no new state, checkpoint, or recovery mechanism. |
| decision-input-stale-rename-debt-doc | adopted as clause-level supersession in the new ADR and current-guide correction; historical files are not edited. |
| decision-input-google-attribution | not_applicable to Admission correctness; actor attribution can be separate diagnostics but cannot change a valid reported claim. |
| decision-input-live-provider-parity | not_applicable to implementation selection; always-on shared contracts are mandatory and live E2E is optional evidence. |
| decision-input-private-provenance | implementation_detail subsumed by the private pair-index discretion; the selected immutable RenameEvidence reference and lifetime are design-fixed. |
| decision-input-root-carrier | subsumed by decision-input-root-descendant-authority and the single-owner contract; there is no separate topology component. |
| decision-input-descendant-governance | subsumed by decision-input-root-descendant-authority. |
| decision-input-no-new-state | subsumed by decision-input-closed-state. |
| decision-input-provider-common-path | adopted by contract-provider-temperature-equivalence and ADR 0006. |
| decision-input-doc-drift | subsumed by decision-input-stale-rename-debt-doc and the new ADR. |

The only implementation discretion is the file-private exact-pair index representation
inside identity-component-topology.ts: a collision-safe composite-key ReadonlyMap or
nested ReadonlyMaps may be used. It must preserve one selected immutable authority
reference, exact matching, the fixed reason partition, the affine read bound, and
call-local lifetime. It escalates if it changes a public/exported type, adds another
proof, moves ownership, retains state, weakens any negative, or changes an observable.

## Critique issue resolution

This is the final resolved_issues ledger. Every verdict Y issue is closed:

| issue_ref | Resolution and patch-hint disposition |
|---|---|
| issue-single-owner-contract-not-closed | adopted materially. The draft-1 stable component-identity-component-authority ID remains the sole rename-arbitration semantic owner. admitDestructivePlan is its public facade, decideIdentityComponent is its once-called private producer, and selected-family shapers plus topology are pure subordinate producers with no component or disposition ownership. Provider/acquisition sources remain operational-input producers, while static guards are enforcement of the same authority contract rather than components. The draft-2 selected-family signature graft is adopted. |
| issue-private-proof-owner-gate-nondiscriminating | adopted materially. contract-admission-architecture-conformance adds a TypeScript-AST closed importer/top-level declaration guard, Map-cache and foreign-import synthetic negatives, lint:bot-repro integration, and an instrumented affine-read T0 witness. The existing state guard remains unchanged. |
| issue-failure-partition-reasons-not-exclusive | adopted materially. contract-root-proof-failure-semantics fixes predicate precedence and exact arrays for report conflict, root/action mismatch, partial/unknown folder mappings, non-folder scope, and post-proof alias mismatch; all negatives assert both reasons and zero actions. |
| issue-recovery-missed-current-adr-debt-conflict | adopted with one safety correction. The suggestion to rewrite accepted ADR text is rejected because it would silently alter history. The new proposed ADR explicitly supersedes the stale present-tense debt clauses while preserving the rest, and implementation updates only current guides/design/enforcement. |

There are no critique blockers, open product choices, or scope-expansion signals. The
new guard, enforcement target, and ADR were already present as concepts in the two
drafts; integration keeps one stable semantic component and makes its checks
discriminating.

## Dependency-ordered implementation units

### Unit 1 — pin RED and negative contracts

In plan-admission.test.ts, retain the production-shaped recurrence as RED before
production repair. Add action/evidence/observation permutations, coherent and
conflicting report sets, no-report alias compatibility, exact root mapping controls,
synthetic-action authority rejection, exact reason arrays, and the instrumented
64/512-element affine-read witness. Each negative asserts one component disposition,
the exact existing reason array, and zero executable actions.

### Unit 2 — centralize the component decision

Move all runtime candidate selection and builder sequencing behind the one
decideIdentityComponent entry. Build effective reported claims from the immutable raw
component, select one family, pass the narrowed variant into subordinate builders,
materialize once from raw actions, derive the selected-root proof, apply the fixed
predicate precedence, and return the closed component result. Extract only the pure
topology data producer to identity-component-topology.ts. Remove ordered cross-family
normalization and action-derived synthetic RenameEvidence. Preserve public types,
action vocabulary, and unrelated path behavior.

### Unit 3 — prove common acquisition, execution, and state contracts

Add the orchestrator sequence for a clean local parent transition followed by an
opposite provider-current reported root and unchanged aliases. Verify equal complete
COLD/WARM/HOT fixtures, child-before-parent execution, post-I/O records, abort on
incomplete attempts, and clean checkpoint publication. Run the central Google Drive,
OneDrive, and Dropbox folder-rename contract matrix. No provider, executor, committer,
finalizer, checkpoint, or state production edit is allowed; any such need returns to
design.

### Unit 4 — enforce and publish the boundary

Add sync-admission-authority-guard.test.mjs and wire it into package.json
lint:bot-repro; narrow eslint imports and add the topology module to PURE_TRANSFORMS.
Keep sync-state-ownership-guard.test.mjs unchanged. Publish the proposed ADR, promote
INV-007, INV-008, and BOUNDARY-007 into the active four-stage design, and align
AGENTS.md, ARCHITECTURE.md, docs/sync-pipeline.md, and docs/code-enforcement.md.
Do not modify accepted ADR history or completed changes. Run docs conformance and the
complete repository gate.

The dependency order is Unit 1 to Unit 2 to Unit 3 to Unit 4. A failure that implies a
new provider branch, public carrier, state owner, recovery path, executor change, or
reason vocabulary stops implementation and returns this design for revision.

## Verification and completion

Completion requires all of the following observable outcomes:

1. The exact three-alias, one-remote-root, two-stable-identity recurrence authorizes
   only rename_local TemplateS to Templates with no failure, with or without the former
   parent-alias normalization opportunity.
2. Conflicting reports, wrong direction, partial/unknown/crossed/duplicate mappings,
   and aliases outside a complete proof fail with the exact arrays fixed above and no
   executable action.
3. With no effective report, the established local parent path retains child content
   work and one later rename_remote.
4. Equal complete facts converge identically across acquisition labels and all three
   provider families use the common RenamePair contract.
5. Executor ordering, successful per-file record publication, abort, and clean
   checkpoint semantics remain unchanged.
6. The new architecture guard rejects a module-scope Map proof cache and a foreign
   helper importer; the existing state-owner guard remains green without fixture
   expansion.
7. Current guides/design and the new ADR agree that no rename debt or retained evidence
   is current authority, while accepted historical files remain unchanged.
8. npm run lint, npm run lint:bot-repro, npm run build, and npm run test:coverage all
   pass.

Optional live provider E2E is reported as unverified when credentials are unavailable;
it is not a substitute for the central registered-family contracts.
