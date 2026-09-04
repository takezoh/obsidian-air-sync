# Case-alias parent transition — canonical design

<!-- anchor: goal -->
## Goal and scope

Fix the repeated case-only parent-folder failure at the existing responsibility boundaries. Admission decides the whole identity component from current-cycle facts, the cache-backed filesystem reports and mutates only provider-proven topology, Execution performs the authorized plan exactly, and the existing checkpoint owner publishes only a wholly clean cycle.

This is not a recovery feature. It introduces no ambiguous Admission status, stopped-state branch, journal, pending work, persistent evidence, schema migration, new folder identity, or correctness-critical orchestrator memory. COLD, WARM, and HOT remain acquisition strategies. With the same complete facts they must reach the same Admission decision.

The scope is deliberately limited to two cooperating corrections:

1. the shared filesystem/cache boundary separates an untrusted requested path from the provider-resolved mutation target and derived projection; and
2. Admission retains all child content work while replacing redundant topology-only descendant renames with one existing explicit parent folder rename in the same authorized plan.

The existing `transfer → serial conflict → structural` barriers, action vocabulary, per-file commit rule, clean-cycle checkpoint rule, and abort-on-incomplete lifecycle do not change.

<!-- anchor: approach -->
## Chosen approach

For a proven mapping from remote `Templates` to local intent `TemplateS`, the component is the same parent identity plus its complete set of managed descendant identities. Admission keeps every proposed child action that carries content (`push`, `pull`, or `conflict`). For execution it projects that action onto the provider's current old-casing path while retaining the same local entity, remote identity, baseline, and content decision. It removes only descendant `rename_remote` effects whose complete purpose is to restate the parent casing, and emits exactly one existing `rename_remote("Templates", "TemplateS", isFolder=true)` action. Because the executor already runs content phases before the structural phase, child content reaches the existing provider identity before the parent spelling changes; the parent action then rewrites the already-committed descendant `SyncRecord` paths.

The cache-backed filesystem accepts `TemplateS/...` as a lookup address, not as topology fact. A lookup returning provider metadata named `Templates` continues to expose `Templates`; it cannot re-key the live cache. An explicit rename response whose provider metadata names `TemplateS` may re-key the folder and descendants. A mutation uses one effective target derived from the provider object's own name/path and its resolved parent chain for existing-child lookup, identity/CAS checks, provider I/O, and the attempt-local cache projection.

The parent-only two-cycle candidate is rejected. It can consume a remote-only child delta, declare the first cycle clean, advance the cursor, and leave WARM/HOT with no source from which to rediscover the unexecuted child. The final plan therefore completes child content and the parent transition in one cycle or fails the cycle closed.

The provider-only candidate is also insufficient: recovered evidence shows it removes a stale-target warning while the sibling topology action still blocks. The combined correction is the smallest boundary-complete repair. A compound protocol, a dependency DAG, and executor-side ancestor inference add responsibility and state without adding required behavior.

## Requirements

<!-- anchor: fr-capt-001 -->
### FR-CAPT-001 — same-cycle component plan

When complete current-cycle evidence proves one included case-only parent mapping, Admission shall retain every child content action, replace only topology-only descendant renames, and authorize exactly one existing explicit parent folder rename in the same plan.

<!-- anchor: fr-capt-002 -->
### FR-CAPT-002 — temperature-independent decision

Equal complete component facts shall produce the same Admission decision under COLD, WARM, and HOT without prior-failure input, a recovery branch, a new status, or an additional correctness owner.

<!-- anchor: fr-capt-003 -->
### FR-CAPT-003 — provider-proven topology

Requested spelling shall never prove provider topology or re-key the cache. Only provider-resolved metadata or the successfully completed endpoint of an explicit rename may establish projected topology.

<!-- anchor: fr-capt-004 -->
### FR-CAPT-004 — no cursor past unfinished content

A cycle shall not commit the remote cursor past any admitted child content work. Each `SyncRecord` commits only after its own admitted I/O succeeds; cursor plus complete derived cache commit only after a wholly clean plan.

<!-- anchor: fr-capt-005 -->
### FR-CAPT-005 — exact existing phase order

Execution shall run the authorized plan exactly through the existing transfer, serial-conflict, and structural barriers so child content effects finish before the explicit parent folder rename.

<!-- anchor: fr-capt-006 -->
### FR-CAPT-006 — fail-closed identity boundary

Incomplete descendant mapping, ambiguous provider resolution, a foreign or recreated destination identity, or a changed mutation precondition shall fail closed and leave the working view uncommitted.

<!-- anchor: nfr-capt-001 -->
### NFR-CAPT-001 — bounded provider resolution

Resolution shall reuse the attempt-local live cache, perform at most one provider lookup per previously unresolved parent segment and one existing-child lookup per mutation, and add no parent lookup for later sibling mutations.

<!-- anchor: nfr-capt-002 -->
### NFR-CAPT-002 — closed mechanism set

The repair shall add no action type, generic DAG, executor re-admission, persisted evidence, schema migration, recovery instruction, Admission status, or correctness-critical in-memory state.

## Authority and state model

| Fact or state | Sole owner | Use in this change | Forbidden use |
|---|---|---|---|
| Current local/remote endpoints, baseline identity, component membership | Observation inputs consumed by Admission | Prove the current component and content/topology actions | Persist as recovery intent or branch on acquisition temperature |
| Authorized action set | Admission | Complete same-cycle decision | Executor reconstruction or late re-admission |
| Provider-returned path/name and stable identity | Provider adapter through the existing cache-backed filesystem | Establish actual mutation target and live derived projection | Treat requested echo as provider topology |
| Per-file `SyncRecord` | Existing state committer | Commit after that file's admitted I/O succeeds | Record pending/recovery work |
| Live remote cache/cursor/scope | Existing checkpoint-capable filesystem | Attempt-local derived working view | Durable mutation ledger or independent authority |
| Durable cursor + complete cache | Existing checkpoint store | Publish atomically after wholly clean cycle | Publish after parent-only or partially executed work |

No new folder identity is introduced. “Folder component” means the current parent identity and the complete managed descendant identity set already present in cycle evidence. It is a decision scope, not a persisted object.

## Joint plan and failure boundary

For a proven case-only parent transition, Admission applies these rules in order:

1. Prove a one-to-one parent identity mapping, included scope, local/baseline intent, destination non-foreignness, and a complete managed descendant set.
2. Preserve every proposed child content decision and identity, including remote-only pulls and serial conflicts, while addressing its I/O at the provider-current old-casing path.
3. Remove only descendant remote rename actions proven to be topology-only consequences of the same parent spelling transition.
4. Add one existing explicit parent `rename_remote(oldParent, newParent, isFolder=true)` action.
5. Hand the immutable authorized plan to the existing executor without dependency annotations.

Incomplete proof is not represented as an “ambiguous but continue” status. Admission uses its existing fail-closed result. If topology changes after Admission, the filesystem's existing identity/CAS precondition fails the mutation. In either case the cycle is non-clean, its live working view is aborted under the existing lifecycle, and a later ordinary acquisition re-observes current facts.

### Worked cases

| Current facts | Admission / filesystem result | Checkpoint result |
|---|---|---|
| Local/baseline intent says `TemplateS`; provider parent identity is still named `Templates`; one child is remote-only changed and another conflicts | Keep pull and conflict; emit one parent folder rename; provider-targeted child I/O runs before structural rename | Commit only after all three effects are terminal |
| Alias lookup for `TemplateS` returns the same provider object named `Templates` | Use `Templates` as actual topology; do not re-key; update an existing child only after unique identity resolution | Derived result may commit only with the clean cycle |
| Explicit provider rename confirms the same folder identity at `TemplateS` | Re-key live folder and descendants from resolved response metadata, or from that confirmed endpoint when the response is sparse | Publish with clean cursor/cache snapshot |
| Exact destination is a distinct or recreated folder identity | Admission or mutation precondition fails closed; no fallback create or implicit merge | Abort live view; durable cursor/cache unchanged |
| Managed descendant inventory is partial or crossed | Do not collapse child topology actions or authorize parent transition | Non-clean; no cursor advancement |

## Components

<!-- anchor: component-validation-harness -->
### Production-shape gate

`src/sync/orchestrator.test.ts`, `src/sync/plan-admission.test.ts`, and the three adapter test files own the test-only gate. Before any production file changes, it enters through the production COLD Observation and Admission path and records the exact component carriers and action subtypes. It also creates paired provider controls: alias lookup returns `Templates` without re-key; explicit rename returns `TemplateS` with re-key. A hand-built `AuthorizedSyncPlan` is supporting executor evidence, not sufficient proof.

If the production path lacks the parent identity, complete managed descendants, or distinguishable content/topology actions, implementation stops and returns to design. This is a development gate, not a runtime decision branch.

<!-- anchor: component-cache-backed-filesystems -->
### Cache-backed filesystems

`src/fs/caching/metadata-cache.ts`, `path-authority.ts`, `remote-fs.ts`, and the Google Drive, OneDrive, and Dropbox adapters own provider-resolved topology. They reuse the existing attempt-local live cache. Requested paths remain lookup inputs. Provider-returned metadata plus the resolved parent chain is the normal source of actual path spelling and mutation identity; a successfully completed explicit rename also confirms its endpoint when the provider response is sparse.

Each unresolved parent segment is looked up at most once per attempt and memoized in the live cache; sibling writes reuse it. Each mutation performs at most one existing-child lookup. Google Drive's lookup must return enough cardinality in that one request to distinguish zero, one, and multiple matches; a `pageSize=1` result is not uniqueness proof. No provider uses speculative prefetch or a second resolver cache.

<!-- anchor: component-admission-parent-normalization -->
### Admission parent transition

`src/sync/plan-admission.ts`, `plan-admission-graph.ts`, `plan-admission-case-alias.ts`, `optimize-local-renames.ts`, and `types.ts` own the component decision. The implementation reuses the existing component traversal and `rename_remote` folder action. It neither invents a parent-transition protocol nor changes the executor's action interpretation.

Admission is allowed to decide this because complete current-cycle evidence contains the relevant identity, endpoint, baseline intent, scope, and child proposals. It is not asked to predict provider topology: the filesystem separately validates the provider-resolved mutation target at I/O time.

<!-- anchor: component-execution-and-commit -->
### Execution and checkpoint

`plan-executor.ts`, `state-committer.ts`, and `sync-cycle-finalization.ts` retain their current responsibilities. Content transfer remains before serial conflict, serial conflict remains before structural actions, and the executor neither infers a parent effect nor retries a decision. The repository-root `sync-state-ownership-guard.test.mjs` protects the closed owner set.

Successful child content may commit its per-file record. Any later structural failure makes the cycle non-clean, so cursor and complete derived cache do not publish; the live working view aborts. No compensation or recovery marker is required.

<!-- anchor: contract-production-shape-gate -->
## Contract: production-shape gate

**Subject / owner / unit.** The test-only production path and provider controls are owned by `component-validation-harness` and delivered in `unit-0-production-shape-gate`.

### Operational inputs

| ID | Owner / producer / source | Scope and acquisition | Preservation and stability | Unavailable or invalid |
|---|---|---|---|---|
| `input-cold-component-facts` | Admission input owner / production Observation / COLD orchestrator entry | One parent plus all managed descendants, captured before Admission | Immutable for the Admission call; current-cycle only | Gate is `unknown`; no production edit |
| `input-cold-proposed-actions` | Admission input owner / decision engine / real proposal path | Exact subtype and identity for push, pull, conflict, unchanged, and topology-only effects | Immutable proposal snapshot; valid until Admission | Gate is `unknown` or `conflicting`; no production edit |
| `input-provider-paired-responses` | Adapter fixture owner / provider fake / existing adapter public seam | Alias-lookup and explicit-rename responses for each of three backends | Deterministic test response; no claim about unobserved live behavior | Adapter work remains evidence-seeking and production edit is blocked |

### Decision rules and observables

| Rule | Evidence mode | Epistemic state and outcome | Observable |
|---|---|---|---|
| `rule-gate-component-carriers` | production-path characterization | complete carriers → determinate/pass; missing carrier → unknown/stop; contradictory identity → conflicting/stop | `observable-cold-shape`: tests name exact component identities and action subtypes |
| `rule-gate-remote-only-work` | counterexample | remote-only delta appears as retained content candidate → determinate/pass; otherwise inconclusive/stop | `observable-remote-only-visible`: the test fails if a clean result can omit the child |
| `rule-gate-provider-controls` | paired adapter fixtures | both controls discriminate for all providers → determinate/pass; otherwise unknown or conflicting/stop | `observable-provider-control-difference`: only explicit rename changes actual spelling |

The partition is exhaustive for the gate: `determinate`, `unknown`, or `conflicting`; an assertion that cannot connect the production carriers is `inconclusive`. Only determinate/pass permits Units 1–2. Failure `failure-shape-unproven` is a design-gate failure, not a degraded runtime requirement and not a status added to production.

**Invariants.** Unit 0 modifies tests only. It does not encode a provider fixture as a universal fact, build an authorized plan manually as its only proof, or introduce a runtime branch.

**Verification.** `verify-cold-production-shape` runs the orchestrator and Admission tests. `verify-provider-paired-controls` runs the three adapter suites.

**Witnesses.** Normal witness `witness-cold-complete` (FR-CAPT-001/002, correctness): complete COLD facts expose a conflict, a remote-only pull, and topology-only rename proposals; both verifications observe the exact carriers. Adversarial witness `witness-clean-hides-remote-only` (FR-CAPT-004, data-loss): omitting the remote-only action would still let a cursor advance; `observable-remote-only-visible` and `verify-cold-production-shape` must fail. Adversarial witness `witness-alias-equals-rename` (FR-CAPT-003, duplicate-object): treating both provider controls alike must fail `verify-provider-paired-controls`.

<!-- anchor: contract-provider-resolved-topology -->
## Contract: provider-resolved topology

**Subject / owner / units.** Provider-proven target resolution and cache projection are owned by `component-cache-backed-filesystems`, implemented in `unit-1-provider-resolved-topology`, and integrated in Unit 3.

### Operational inputs

| ID | Owner / producer / source | Scope and acquisition | Preservation and stability | Unavailable or invalid |
|---|---|---|---|---|
| `input-requested-address` | Caller / admitted action / filesystem mutation argument | One lookup address, at mutation start | Untrusted and mutable across calls; never promoted | Cannot establish topology or cache re-key |
| `input-provider-parent-metadata` | Adapter / external provider / exact parent lookup | Each previously unresolved parent segment, before child lookup | Memoized only in existing live cache for this attempt; stable by provider identity/CAS | Unknown or ambiguous resolution rejects mutation |
| `input-provider-child-metadata` | Adapter / external provider / one existing-child lookup | One mutation target beneath resolved parent | Used for target identity/CAS and provider I/O; not persisted independently | Zero follows admitted create semantics only when absence is proven; multiple/conflict rejects |
| `input-mutation-response` | Adapter / external provider / write or explicit rename response | The object actually mutated | Provider-returned name/path is authoritative; explicit rename success confirms a sparse endpoint | Identity mismatch rejects; a sparse write remains at the current path without re-keying |
| `input-live-derived-cache` | Existing cache owner / cache-backed filesystem / attempt-local projection | Current attempt and scope | Reused for resolution; discarded on abort, atomically persisted only with cursor on clean commit | Cache miss invokes bounded resolution; stale/invalid entry is not trusted |

### Decision rules and observables

| Rule | Evidence mode | Inputs and epistemic outcome | Observable |
|---|---|---|---|
| `rule-requested-echo-negative-authority` | accepted ADR + paired control | requested address differs while provider says `Templates` → determinate/preserve provider spelling | `observable-no-alias-rekey`: live cache retains `Templates` |
| `rule-resolved-mutation-target` | provider metadata | one actual-resolved parent and zero/one unique child → determinate/create-or-update admitted target | `observable-single-provider-target`: provider log shows one intended identity and no duplicate |
| `rule-explicit-rename-projection` | mutation response | same expected stable identity returned as `TemplateS` → determinate/re-key folder and descendants | `observable-provider-confirmed-rekey`: live projection moves only after response |
| `rule-resolution-fail-closed` | provider metadata + CAS | missing chain → unknown; insufficient uniqueness → inconclusive; conflicting/foreign identity → conflicting | `observable-mutation-rejected`: no create/update fallback and cycle non-clean |
| `rule-resolution-budget` | request counter | cache hit / first unresolved path / sibling reuse → determinate only within fixed count | `observable-provider-call-count`: zero cached parent calls, at most one per unresolved segment, zero later-sibling parent calls, one child lookup per mutation |

### Semantic profiles

The outcome partition covers determinate, unknown, inconclusive, and conflicting provider evidence. Provider identity/CAS conflict takes precedence over requested spelling; multiple children take precedence over absence; unresolved evidence defaults to reject and abort. Google Drive must request enough matches in one child lookup to distinguish `0`, `1`, and `>1`; OneDrive and Dropbox prove their equivalent unique-path result through the same contract. Unknown live OneDrive/Dropbox case behavior remains optional T2 evidence: it never licenses requested echo as topology.

Cost converges at `O(U + M)`, where `U` is the number of parent segments not already resolved in the attempt-local cache and `M` is the number of mutations. A later sibling below an already resolved parent contributes no parent lookup. There is no speculative prefetch, retry loop, second resolver cache, or cycle-spanning memo.

Scope consistency is attempt-local: every mutation target and live projection is computed from one provider response lineage within the current checkpoint working view. No partial requested/provider mixture may become a global cache snapshot.

**Invariants.** Requested echo never re-keys. A single stable identity has one live projected path. Explicit provider rename is the only case-only re-key event. Complete cache/cursor persistence remains atomic and clean-cycle-only.

**Typed failures.** `failure-parent-unresolved` (unknown), `failure-child-uniqueness-unproven` (inconclusive), `failure-target-identity-conflict` (conflicting), `failure-mutation-response-mismatch` (conflicting), and ordinary external provider failure all reject the mutation and propagate a non-clean attempt; none degrades FR-CAPT-003/006 or falls back to create.

**Verification.** `verify-{google,onedrive,dropbox}-provider-topology` covers paired alias/rename controls, identity targeting, and request counters. `verify-three-backend-cache-contract` registers the common semantics for all three caching backends.

**Witnesses.** Normal `witness-provider-alias-update` (FR-CAPT-003, duplicate-object): `TemplateS` lookup returns provider `Templates`, then one existing child is updated; observe no alias re-key and one identity through the adapter and shared-contract tests. Normal `witness-explicit-folder-rename` (FR-CAPT-003, topology): explicit rename returns `TemplateS`; observe provider-confirmed subtree re-key. Adversarial `witness-recreated-destination` (FR-CAPT-006, data-loss): the destination stable identity differs; observe mutation rejection and no fallback create. Adversarial `witness-sibling-lookup-explosion` (NFR-CAPT-001, quota/latency): repeated sibling writes must preserve the exact request-count bound in every adapter suite.

<!-- anchor: contract-admission-parent-transition -->
## Contract: Admission parent transition

**Subject / owner / units.** Same-cycle component normalization is owned by `component-admission-parent-normalization`, implemented in `unit-2-admission-parent-transition`, and integrated in Unit 3.

### Operational inputs

| ID | Owner / producer / source | Scope and acquisition | Preservation and stability | Unavailable or invalid |
|---|---|---|---|---|
| `input-component-endpoints` | Admission / Observation / immutable cycle evidence | Current parent endpoints and all managed descendant endpoints before decision | Cycle-local facts; no temperature or prior-error tag | Incomplete component fails closed |
| `input-component-baselines` | Existing sync state owner / committed `SyncRecord`s / Admission input | Same identities in this component | Durable only as existing records; never rewritten merely to remember pending work | Missing facts reduce proof and retain fail-closed behavior |
| `input-local-parent-intent` | Admission / current local path plus baseline relation / component evidence | One old/new case-only parent mapping | Must agree across every managed descendant | Crossed or mixed mapping fails closed |
| `input-proposed-child-actions` | Admission / decision engine / proposed plan | Every action in the component, including remote-only delta-derived work | Immutable until one exhaustive Admission result | Unknown subtype or unaccounted action fails closed |
| `input-destination-identity-proof` | Admission and filesystem precondition / current endpoint evidence and provider resolution | Parent destination and relevant children | Must prove absent or same expected identity at decision and remain valid at mutation | Foreign/recreated/changed target rejects |

### Decision rules and observables

| Rule | Evidence mode | Inputs and epistemic outcome | Observable |
|---|---|---|---|
| `rule-complete-parent-mapping` | same-cycle identity proof | one same-identity parent, aligned local/baseline intent, complete managed descendants → determinate | `observable-one-parent-transition`: exactly one existing folder rename action |
| `rule-preserve-child-content` | exhaustive action classification | every push, pull, and conflict retained → determinate | `observable-content-set-preserved`: admitted content identities equal proposed content identities |
| `rule-remove-topology-only-descendants` | component relation proof | descendant rename solely restates parent casing → determinate/remove; any content/independent topology → retain or fail | `observable-no-redundant-child-rename`: only redundant structural effects disappear |
| `rule-cross-temperature-equivalence` | equal-fact comparison | equal operational inputs under COLD/WARM/HOT → same determinate or same fail-closed result | `observable-temperature-independent-plan`: normalized action sets are equal |
| `rule-admission-fail-closed` | completeness/identity partition | missing → unknown; insufficient proof → inconclusive; crossed/foreign/recreated → conflicting | `observable-no-partial-authorization`: no parent transition or content consumption is declared complete |

### Semantic profiles

The partition covers determinate, unknown, inconclusive, and conflicting component facts. Destination identity conflict and crossed mappings take precedence; incomplete managed membership or an unclassified action is inconclusive; missing endpoint/baseline evidence is unknown. Every non-determinate outcome retains the existing fail-closed Admission behavior. There is no fourth “defer/recover” disposition.

Scope consistency requires one complete identity component: parent plus every managed descendant in the cycle. Partial delta membership may contribute current evidence, but Admission cannot collapse topology unless the completed Observation/record join proves the full managed set. The resulting observable is component-wide, while inputs remain cycle-local and immutable.

**Invariants.** All content work stays in the same plan. Exactly one parent folder rename represents the casing effect. Admission alone shapes the plan. Acquisition temperature and prior failures are absent from the rule inputs. No new action, folder identity, disposition, or state owner exists.

**Typed failures.** `failure-component-incomplete` (inconclusive), `failure-mapping-crossed` (conflicting), `failure-destination-foreign` (conflicting), `failure-action-unclassified` (inconclusive), and `failure-precondition-changed` (external mutation-time conflict) all produce a non-clean attempt. None silently discards content or declares parent-only success.

**Verification.** `verify-same-cycle-mixed-admission` asserts exact action identity and subtype sets. `verify-temperature-independent-decision` runs equal-fact COLD/WARM/HOT cases and observes equal plans.

**Witnesses.** Normal `witness-mixed-siblings-one-cycle` (FR-CAPT-001/005, convergence): conflict, push/pull, and topology-only siblings share one parent; observe all content plus one parent rename. Adversarial `witness-remote-only-consumed` (FR-CAPT-004, data-loss): removing a remote-only pull would permit cursor advancement; exact-set verification must fail. Adversarial `witness-foreign-parent-target` (FR-CAPT-006, overwrite): a different identity occupies `TemplateS`; observe fail-closed with no parent action. Adversarial `witness-temperature-status-branch` (FR-CAPT-002/NFR-CAPT-002, state divergence): identical facts labeled COLD/WARM/HOT must not change the result.

<!-- anchor: contract-exact-execution-and-checkpoint -->
## Contract: exact execution and checkpoint

**Subject / owner / unit.** Existing execution, per-file commit, and clean-cycle checkpoint semantics are owned by `component-execution-and-commit` and verified/integrated in `unit-3-convergence-and-enforcement`. Production phase topology is unchanged.

### Operational inputs

| ID | Owner / producer / source | Scope and acquisition | Preservation and stability | Unavailable or invalid |
|---|---|---|---|---|
| `input-authorized-plan` | Executor / Admission / immutable authorized plan | Whole current cycle before Execution | Exact action membership and types; no late changes | Missing authorization is non-clean |
| `input-action-terminal-results` | Executor / provider and local effects / existing result aggregation | Each admitted action and phase | Terminal success/failure/blocked proof for this cycle | Any absent/failed/blocked result prevents checkpoint commit |
| `input-sync-record-commit` | Existing state committer / successful admitted I/O | Per file immediately after proven I/O | Existing durable record only; successful earlier records survive later failure | Never written for unexecuted/failed action |
| `input-working-view-candidate` | Checkpoint filesystem / current attempt | Complete derived cache, cursor, and scope at finalization | Live until clean atomic commit; discarded on abort | Incomplete/exceptional cycle aborts |

### Decision rules and observables

| Rule | Evidence mode | Inputs and outcome | Observable |
|---|---|---|---|
| `rule-existing-phase-order` | executor event log | authorized content actions → transfer then serial conflict; parent folder rename → structural | `observable-content-before-parent`: every child content terminal event precedes parent rename start |
| `rule-exact-plan-only` | action/result bijection | one result per authorized action, no inferred action → determinate | `observable-no-executor-inference`: provider log contains no undeclared ancestor effect |
| `rule-per-file-post-io-commit` | I/O/record sequence | admitted I/O success → record commit; otherwise none | `observable-record-after-io`: record event follows its provider/local success |
| `rule-clean-checkpoint-last` | finalization proof | every action terminal success and no checkpoint block → commit; otherwise abort/non-clean | `observable-cursor-last`: cursor/cache publish after remote-only child and parent rename terminal events |

The outcome partition is determinate clean, inconclusive nonterminal/blocked, or conflicting/failed. Only determinate clean commits. Any other returned outcome or exception follows the existing abort-working-view lifecycle. A successful per-file record is not rolled back, and does not authorize cursor publication by itself.

**Invariants.** No phase/DAG change, executor inference, late Admission, new writer, or new orchestrator field. Cache mutation remains a live derived projection until atomic clean commit. Retry is ordinary re-observation from current endpoints and committed records.

**Typed failures.** `failure-content-action` and `failure-parent-rename` keep the cycle non-clean; `failure-terminal-proof-missing` blocks commit; `failure-checkpoint-commit` propagates after existing abort behavior; `failure-provider-precondition-changed` fails the action rather than re-deciding it. Mandatory requirements are not degraded.

**Verification.** `verify-executor-phase-order`, `verify-checkpoint-last`, the exact repository-root `verify-state-ownership-guard`, and `verify-full-repository-gate` are required.

**Witnesses.** Normal `witness-content-conflict-parent-rename` (FR-CAPT-005, ordering): transfer/conflict terminal events precede one parent rename and the cursor event comes last. Adversarial `witness-parent-rename-after-content-failure` (FR-CAPT-004/006, partial effect): a child content failure prevents the structural phase or yields non-clean and no cursor publication according to existing executor behavior. Adversarial `witness-parent-rename-fails-after-content` (FR-CAPT-002/004, replay): successful per-file records remain, live checkpoint aborts, and ordinary COLD/WARM/HOT re-evaluate without a recovery marker. Adversarial `witness-new-state-owner` (NFR-CAPT-002, architecture drift): the root ownership guard fails on a new durable writer or correctness-critical orchestrator field.

## Accepted ADR projection

<!-- anchor: adr-0001-commit-last-cache -->
### ADR 0001 — metadata cache remains subordinate to commit-last

This design applies the accepted decision without superseding it. Requested spelling never becomes cache authority. Mutation responses update only the attempt-local derived projection; cursor, full cache, and scope persist atomically only after a wholly clean cycle. Per-file records still commit after their own admitted I/O.

<!-- anchor: adr-0008-fail-closed-identity -->
### ADR 0008 — Admission owns fail-closed identity decisions

Admission uses complete current component facts to authorize the parent transition and content actions. Unknown, incomplete, ambiguous, crossed, foreign, or recreated identity evidence fails closed. No ambiguous status or recovery instruction is added.

<!-- anchor: adr-four-stage-sync-pipeline -->
### Four-stage sync pipeline — exact execution remains exact

Observation reports facts, Decision proposes actions, Admission authorizes the complete component, and Execution performs that plan. The existing transfer, serial-conflict, and structural barriers are sufficient; no DAG, inference, or re-admission is introduced.

## Implementation units and dependency order

### Unit 0 — production-shape gate

Add test-only production-path characterization and paired adapter controls. This must finish before any production file changes. The gate proves exact COLD component carriers, including a remote-only delta child, and proves that every backend distinguishes an alias lookup response from an explicit rename response. If not, stop and revise this design.

### Unit 1 — provider-resolved topology

After Unit 0, implement the shared negative-authority rule, effective mutation target, single stable-ID projection seam, uniqueness proof, and request bounds. Register the behavior through the existing central three-backend contract.

### Unit 2 — Admission parent transition

After Units 0–1, normalize the complete component using only current immutable evidence: retain every content action, remove only topology-only descendant renames, and add one existing explicit parent folder rename. Tests compare exact action sets under equal COLD/WARM/HOT facts and reject incomplete/foreign targets.

### Unit 3 — convergence and enforcement

After Units 1–2, prove the mixed production path, remote-only cursor safety, provider event order, failure/abort behavior, and all three backends. Clarify existing ADR/design/enforcement owners only; do not create another ADR or state taxonomy. Run the root ownership guard before the full repository gate.

## Verification tiers

- T0: pure/action-shape assertions for component classification and provider path authority where available.
- T1: production-path orchestration, all three adapter fixtures, shared caching contract, exact event ordering, checkpoint finalization, ownership guard, and the full project gate.
- T2 optional evidence: `npm run test:e2e` against Google Drive, Dropbox, and OneDrive with existing credentials. Live differences may strengthen adapter evidence but cannot weaken fail-closed semantics or authorize requested echo.

## Resolved critique issues

```yaml
resolved_issues:
  - issue_ref: issue-clean-checkpoint-hides-consumed-remote-work
    resolution: Adopted the patch hint. Parent-only defer is rejected; every child content action and one explicit parent folder rename execute in the same authorized plan, with a remote-only delta cursor-safety counterexample.
    contract_refs: [contract-admission-parent-transition, contract-exact-execution-and-checkpoint]
  - issue_ref: issue-requested-echo-authority-promoted-before-spike
    resolution: Adopted the negative authority rule from ADR 0008 and made paired alias-lookup/explicit-rename controls a production-change gate for all three adapters; unobserved live behavior remains evidence-seeking and defaults fail-closed.
    contract_refs: [contract-production-shape-gate, contract-provider-resolved-topology]
  - issue_ref: issue-provider-resolution-request-budget-open
    resolution: Adopted the fixed O(U + M) lookup bound using the existing attempt-local live cache, with zero sibling parent lookups and no prefetch or second cache.
    contract_refs: [contract-provider-resolved-topology]
  - issue_ref: issue-ownership-guard-path-does-not-exist
    resolution: Adopted the repository-root sync-state-ownership-guard.test.mjs target and exact focused command.
    contract_refs: [contract-exact-execution-and-checkpoint]
```

## Decision closure

All decision inputs from both drafts are dispositioned in `spine.yaml`. The chosen design fixes owners, authority, evidence partitions, failure behavior, action representation, phase ordering, persistence, and provider-call bounds. There are no open product or architecture choices. Backend request syntax and private helper placement may vary only inside the named unit while preserving these contracts and verification outcomes.
