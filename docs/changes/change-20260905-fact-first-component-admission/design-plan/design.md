# Fact-first component admission

Approved design contract; local implementation and independent code review are complete (see [implementation progress](../implementation.md)). Final command gates, persistent-design promotion and actual-vault acceptance are reported separately in [verification](../verification.md). Public no-action alias, rename-content, exact publication, conflict preservation and interruption witnesses are implemented. These counterexamples establish engine defects and regression protection, not that the logged vault error has been repaired in Obsidian.

## Goal and alternatives

The engine must converge from current facts and successful file records, including after partial I/O. It must not remember why an earlier attempt failed. This changes the direction of computation inside Admission, not the four-stage ownership model.

| Alternative | Decision |
|---|---|
| Skip alias checks when there are no proposed actions | Reject: absence of work is not proof of identity, content, scope, or baseline convergence. |
| Keep action-first planning and add a second no-op coverage proof | Reject: retains two meanings of topology and the repair/validation feedback loop. |
| Replace the engines with a general state machine, IR, or dependency framework | Reject: existing components, dispositions, action kinds, pool capacity, stores, and execution seams suffice with explicit component ordering. |
| Bind current facts first; construct effects once; close each cycle once | Select: removes circular inference and independent completion decisions. |

## Requirements

<!-- anchor: fr-001 -->
The system SHALL derive sync decisions only from current component facts and committed SyncRecords; equal complete facts SHALL have equal decisions under COLD, WARM, and HOT. No new persistent authority, cross-cycle correctness owner, recovery marker, database-version branch, or special stopped-state procedure is permitted.

<!-- anchor: fr-002 -->
WHEN unique identity, current endpoints, content, scope, and committed baseline are aligned, Admission SHALL return resolved_no_action even when coherent already-satisfied reports or aliases are present. WHEN only baseline publication is missing, it SHALL authorize terminal publication before returning no action on a later cycle.

<!-- anchor: fr-003 -->
WHEN one identity is renamed and edited, the system SHALL preserve the rename and the admitted content outcome; concurrent differing edits and foreign versions SHALL follow existing conflict policy without conflating different identities or losing a version that the selected policy requires preserved.

<!-- anchor: fr-004 -->
IF required identity, absence, content, or included-scope evidence is unknown or contradictory, Admission SHALL fail closed for that component. Every report-, alias-, actual-endpoint- and baseline-derived relation SHALL use the same captured pure configured-scope compatibility query before authorization. Existing inclusion policy is preserved; excluded metadata SHALL not acquire engine actions or identity claims.

<!-- anchor: fr-005 -->
WHEN an admitted effect reaches its verified terminal state, its SyncRecord publication SHALL compare exact admitted source and destination record expectations atomically. Admission-authorized foreign destination replacement SHALL require the selected conflict policy's preservation proof, not same-identity-only store policy. Failed comparisons SHALL preserve existing records and prevent successful action publication.

<!-- anchor: fr-006 -->
WHEN all admitted obligations terminate and the working view closes cleanly, the orchestrator SHALL acknowledge only the captured existing tracker generations. Incomplete execution, missing terminal evidence, invalid supersession, or checkpoint failure SHALL not acknowledge those inputs.

<!-- anchor: nfr-001 -->
Maintainability: one identity-policy owner and one cycle-completion predicate; actions are outputs, never evidence inputs. Remove the old production optimizer/repair route, duplicate factual action state, and independent orchestrator topology predicates. No feature flag, dual run, new action kind, or general-purpose operation language.

## Ownership and data direction

```text
existing acquisition + scope entrance
    current BatchObservation (no actions)
    + immutable cycle-local pure scope compatibility query
                    |
Admission: fact-only components -> identity binding -> content comparison
                    |                    decision-engine (pure subordinate)
             final dispositions + readonly ordered existing actions per component
                    |
Execution: independent singleton pool settles -> complex components serially
           each component action: preconditions -> I/O -> proof -> publication
                    |
existing SyncRecord owner: successful terminal publication
                    |
Finalization: exact obligations + commit/abort -> clean | incomplete
                    |
Orchestrator: use result; acknowledge captured generations only on clean
```

<!-- anchor: observation -->
Observation remains acquisition plus configured scope projection. Adapter/provider-resolved paths, authoritative stat absence, identity, content/version and subtree completeness are current facts. Reports are evidence to interpret in this cut, not pending commands. No action, failure history, or executor result enters BatchObservation. The existing ScopeProjection additionally exposes one fixed pure compatibility query over a privately captured immutable pre-projection scope surface and settings. This explicitly relaxes the earlier fully-data-only carrier/no-additional-scope-information restriction; it is not a live callback or a second correctness owner. Excluded metadata remains unavailable to identity grouping and policy.

<!-- anchor: admission -->
Admission remains the sole identity/topology policy owner. `identity-component-decision.ts` owns the exhaustive result. Component grouping includes entries, baselines, endpoint observations and every retained evidence claim, including zero-action file/folder claims. Close a component over current endpoints, actual source/destination baseline keys and overlapping parent/child namespaces that its authorized effects can touch; a common vault ancestor alone is not a relation. Resolve overlapping footprints inside the existing component before authorization, not by merging action patterns or adding an executor dependency graph. Each authorized component contains a readonly ordered array of existing actions. A helper may return a call-local readonly identity binding, not a retained correctness object or another policy stage.

<!-- anchor: content-comparison -->
`decision-engine.ts` remains pure content/baseline comparison, but receives endpoints already bound to the same identity. Path differences alone cannot manufacture local-only/remote-only or both-changed. It cannot interpret reports, aliases, scope, or choose topology.

<!-- anchor: execution-publication -->
The executor preserves each admitted component's action order, including terminal record publication before starting its next action. A failed action blocks all remaining actions of that component. State committer/store retain terminal SyncRecord publication. Runtime precondition mismatch means failure, never a switch of policy/protocol. The finalizer owns complete-cycle classification; orchestration remains scheduling/lifecycle and consumes that result. Flat global action-type phases are replaced for complex components; existing pool capacity is reused only for independent singleton transfer or same-key match components.

## Closed contracts

<!-- anchor: contract-facts -->
### Fact-first decision

`admitBatchObservation` is the only production admission entry. Remove its leading `planSync(entries)`, `AdmissionSnapshot.plan`, `bindAdmissionPlan`, and production `admitDestructivePlan`. Construct all relevant components without actions. Each component is decided once:

1. Reject unresolved contradictory claims, nonunique stable identity, unresolved presence, unknown required absence, and incomplete included scope. Coherent report precedence remains; no fallback to a weaker family when a claim is unresolved.
2. Bind baseline identity to current physical endpoint occurrences. Requested spelling is an address; aliases do not create entities. An authoritative recreated source is a separate identity, not evidence that the moved identity remains there.
3. Decide current topology and compare content for each bound identity. Compare current local/remote equality before classifying both changed against the baseline: if both changed but current bytes are positively equal (compatible hash plus size, or existing stronger content proof), authorize match to refresh the stale baseline, not conflict. Unknown equality is not assumed. Already-satisfied reports impose no extra operation when all their endpoints/claims are positively accounted for. Conflicting reports are not ignored merely because some endpoints agree.
4. Return existing `failed`, `resolved_no_action`, or `authorized` directly. Aligned endpoints with stale/missing baseline authorize `match` (with baseline relocation payload when necessary). Only fully aligned baseline permits no action. Necessary topology effects and content policy are materialized once.

This is not `actions.length === 0` bypass. No predicate can prove identity by finding a proposed rename action. Folder completeness inventories unchanged descendants too. Baseline alignment applies to SyncRecord-bearing files and existing baseline keys, not pure topology folder roots: do not create folder records solely to prove no-op. Ordinary no-change components remain cheap call-local decisions, not omitted obligations.

<!-- anchor: contract-effects -->
### Existing-action fixed protocols

**Scheduling is part of the authorization contract.** Admission emits readonly ordered existing actions within the existing component; this is not a new operation language, DAG, queue or owner. Execution may pool only independent components containing one simple transfer or one same-key match. It first settles that pool, then runs all complex, conflict and structural components globally serially, preserving component order and each component's exact action order. Publication of action N must succeed before action N+1 begins; prefix failure blocks the suffix without effects. Before entering the serial interval, use the existing priority coordinator drain/barrier to settle already-running priority work while deferring new priority work; deferral alone is insufficient. All priority work remains deferred throughout that globally serial interval. Priority replacement of an eligible independent singleton retains its existing exact-object protocol outside the interval. No pool work or priority effect may overlap the serial interval. Replace the old flat transfer/conflict/structural phase contract where it would reorder a component; retaining action kinds does not retain flat scheduling or global one-action-per-path as a correctness rule.

Use existing action kinds. Replace duplicated `freshRenameState` and `normalizedRenameState` with only exact readonly execution/publication inputs. A rename action has current `from`/`to`, precondition endpoint snapshots, and a closed content case: `{ mode: "equal" }` or `{ mode: "copy", read: observedEndpoint, write: postMoveEndpoint, expectedContent: observedVersion }`. The rename direction is already encoded in `rename_local`/`rename_remote`; do not add a second direction state. `match` may carry only expected baseline relocation. Conflict retains its existing selected strategy, exact remote identity source, destination snapshot and additional-version preservation contract; normalized decision history is removed.

The payload is not a list of arbitrary steps. The read snapshot includes the observed identity plus available provider version/checksum and local content hash/size. Read bytes before destructive work, compute the existing content digest, and compare against the admitted content proof using the provider's existing checksum conversion/comparison contract (never equate unlike hash algorithms). Re-stat/version-check the read endpoint after reading and immediately before its destructive use; changed/unknown proof fails preparation. The captured immutable bytes are the intended terminal bytes, so terminal verification compares destination bytes directly with that capture, not only timestamps. Each kind has a fixed implementation:

| Admitted case | I/O and successful publication order |
|---|---|
| Pure rename, either direction | Revalidate source identity/version and destination vacancy/same physical alias; rename once; verify actual destination identity and equal local/remote content; atomically publish relocated baseline. |
| Local rename + local edit; remote unchanged | Capture/revalidate local bytes at new path and remote identity at old path; rename remote old→new; write captured local bytes at new; verify both endpoints/content and moved identity; publish once. |
| Remote rename + remote edit; local unchanged | Capture/revalidate remote bytes at new path and local old content; rename local old→new; write captured remote bytes locally at new; verify both endpoints/content and remote identity; publish once. |
| Rename, edit on the opposite side only | Same fixed rename-then-copy protocol; read may be the soon-to-move source, so capture bytes before rename. Admission chooses read and post-move write endpoints; executor cannot infer a different direction from timestamps. |
| Topology already aligned, contents differ | Existing push/pull/conflict at actual endpoints; no redundant rename. Baseline relocation is attached to that successful action if old key remains. |
| Topology/content aligned, baseline missing/stale | Revalidate current endpoints/content; existing match with expected source/destination baseline; atomically publish; no filesystem mutation. |

Terminal proof is a single existing executor-brand pattern extended from fresh rename to every compound/relocation action. It references the exact action object and verified actual endpoints, identity, content and required preserved outputs. It does not persist and is released with the cycle. Pure rename cannot publish a record assembled from unequal bytes. `equal` requires content proof; rename evidence is not that proof. A source may be absent or a different, admitted preserved identity after the move; demanding unconditional old-path absence would incorrectly reject recreated-source cases.

Network cost boundary: reuse authoritative version/checksum/hash/size and stats already needed by existing execution. Pure rename needs no content download when preserved identity plus comparable content proof establishes equality; no-op causes no execution read. Where no comparable proof exists, require the existing hash acquisition or a targeted read of that affected file before admitting `equal`, never a whole-vault read. Copy/conflict reuses necessary transfer buffers; a targeted post-write read is required only when the backend cannot prove stored bytes with its authoritative returned checksum/version. Additional affected-endpoint re-stat or fallback read must be disclosed in implementation and asserted in call-count tests. No all-physical-subtree scan or blanket double-full-read rule.

**Concurrent edits and foreign versions.** Admission selects existing conflict policy over the same bound identity and supplies exact read endpoints for both versions. The existing conflict preparation preserves every version the selected policy requires before any overwrite or rename that could destroy it; duplicate policy preserves both differing bytes, and merge retains existing fallback semantics. Foreign destination and additional remote versions receive the distinct verified preservation outputs required by that policy before rotation. Revalidate all protected source identities/versions immediately before destructive effects. Rotate the tracked identity only if that exact source is still present; write the selected resolved bytes at the admitted final target; verify terminal target plus each required preservation output; then publish its baseline. A recreated old-path identity is neither moved nor deleted by the tracked identity's operation: it remains a separate current identity whose effects and shared publication keys must be resolved in the same ordered component where they overlap. If unique binding or required preservation cannot be proven, fail the component without destructive work. Do not introduce a special recreated-source recovery operation.

The last rule requires actual read/write footprints and baseline keys, not merely distinct action target paths. For remote A(X)→B(X), remote A(Y) recreated, local A(X), reject a source-mutating rename plus independently scheduled `pull A(Y)`: the latter can overwrite the former's source. Admission instead emits one component with B materialization followed by ordinary source-address resolution at A. B is existing pull, match or conflict according to its current facts; A is existing match or conflict according to current equality and selected preservation policy. A foreign B uses conflict preservation when required, not unconditional pull and not blanket rejection. The executor preserves B→A for all six B pull/match/conflict × A match/conflict combinations, including B conflict→A match; it does not regroup them by action kind.

When captured baseline A(X) exists, successful B pull/match/conflict publishes through exact source/destination CAS relocation A→B, including an authorized replacement of captured foreign baseline B(Z) after policy-required versions are proven preserved. It never uses an independent B put retaining A(X). A's content comparison may use captured old baseline A(X), but its publication expectation is explicitly absent, distinct from that comparison input. Check that expectation before A's destructive effects and again in its final CAS transaction; never delete a newly arrived Y record. Any B I/O, proof or publication failure blocks A directly by component ordering, rather than relying on A's CAS failure to enforce ordering. B success followed by A failure leaves baseline B only, so the next cycle evaluates A without a baseline using ordinary match/conflict. When no A baseline was captured, B uses target compare-and-put with the exact expected record or absent, and A's expectation remains absent. A successful filesystem change followed by CAS failure leaves the old records as comparison history, not current identity claims: ordinary re-observation binds the actual identities and can authorize the remaining publication/preservation outcome. No recovery branch or duplicate-identity diagnosis may be derived from stale baseline history alone. Symmetric cases use the same component ordering and publication rules.

**Folders.** For an eligible suffix-preserving root relation, emit one ordered component: child content actions at current provider addresses, then one root rename. Each child publishes before the next action; prefix failure blocks the remaining children and parent. Parent proof covers the complete admitted included mapping, including unchanged children; parent publication atomically rotates all mapped terminal records. This component runs in the global serial interval, with priority deferred and the independent pool already settled. No per-child topology recovery or manufactured child rename solely to prove coverage.

**Interruption.** Rename succeeds/write fails: no file record for that compound action, no clean checkpoint; next observation finds the identity at its current destination and old baseline, and uses ordinary content comparison. Child write succeeds/parent fails: keep successful child records at current addresses, abort checkpoint. Parent succeeds/record transaction fails: no partially rotated records; next facts bind moved endpoints to old committed records and authorize match relocation. No preceding error is an input. After any conflict-preservation interruption, verified copies are ordinary current files; no ledger is needed.

<!-- anchor: contract-publication -->
### Exact baseline CAS, same key, and folder atomicity

Use the existing SyncRecord and merge-content stores, existing committer, and existing transaction helper. An action carries exact expected baseline values (or explicit absent) for every key it will publish. This is bounded authorization payload, never stored intent.

- Same key: `compareAndPut(expected | absent, terminalRecord)`. Never put-then-delete. Use compare-and-put for baseline-absent match too; unconditional put cannot overwrite a concurrent foreign baseline.
- Distinct keys: extend existing compare-and-move to compare source and destination expectations (`absent | exactRecord`) in one transaction before any mutation. The store has no identity replacement policy. Admission may authorize a foreign destination replacement only with the selected conflict policy's required version-preservation obligations; executor terminal proof must establish them before publication. On success put the terminal destination, delete the source and invalidate old merge content incompatible with either replaced/deleted record in the same transaction. On mismatch preserve all keys/content and return failure. A record arriving after capture is never silently replaced, including when its identity happens to match.
- Folder: replace unconditional `rewritePaths` use with the same existing-store transaction discipline over an injective complete mapping. Read/compare all unique source and destination keys first, with duplicate targets rejected. Then apply all removals and terminal puts as one transaction. Same-key members use put-only. Overlapping keys are read from the pretransaction image; validation precedes all writes. Any mismatch aborts the entire rewrite.
- Child-content-before-parent: the parent consumes exact successful descendant publication receipts from the executor's existing call-local result collection. Those receipts, not stale Admission values, become expected source records for children changed in this cycle; unchanged children use admitted expectations. Add only the necessary terminal record to existing successful result/proof objects; no separate receipt map, ledger or retained owner. This is a fixed parent dependency, not a new mutable baseline tracker. Missing receipt blocks the parent. A failed parent transaction preserves every previously successful child record unchanged.
- Merge content follows the same key transaction: retain/move an eligible known base only with its matching terminal record; invalidate incompatible source and destination bases atomically with source removal/destination replacement. Existing best-effort refresh compares the corresponding exact terminal record in its transaction before installing refreshed content, so a late refresh cannot attach old bytes to a newly arrived record. Refresh failure cannot manufacture a record or roll back successful publication.

Action success is published only after terminal proof and record transaction success. CAS failure is ordinary incomplete execution; there is no persisted retry instruction or cleanup compensation.

<!-- anchor: contract-scope -->
### One captured pure scope compatibility query for every relation

Excluded paths/dispositions/identity edges remain absent from the identity graph. Existing ScopeProjection gains exactly one fixed pure query, for example `isConfiguredScopeCompatible(from, to)`, whose private immutable capture contains the current scope surface before projection and configured settings. It exists only for the cycle. It performs no I/O and reads no live settings, clock, tracker or mutable callback state. This intentionally changes the earlier claim that the entrance representation and scope information remain unchanged and that Observation is entirely data-only; a narrowly scoped pure query over frozen captured facts is now allowed.

Every relation, whether derived from reports, aliases, actual endpoints or committed baseline paths, must invoke that same query before Admission authorizes it. Candidate enumeration is not duplicated in scope acquisition or in several helper-specific filters. Thus a report filtered at the entrance cannot reappear as an alias-/baseline-derived parent transition with different eligibility. The query answers inclusion compatibility only: it cannot bind identity, assert subtree completeness, select actions or authorize a relation. Admission retains all those responsibilities and verifies complete current managed facts separately. Equal included identity facts may legitimately produce different eligibility when their captured scope surfaces/settings differ; strategy equivalence requires equal complete inputs including that capture.

Preserve the exact present contract: `crossesScope` removes a folder relation when a known mapped descendant changes inclusion regime (old/new inclusion XOR). `scope-projection.test.ts` explicitly retains a folder report when desktop.ini is excluded at both endpoints. Therefore this design does not promise that a native parent rename leaves every physically excluded descendant's absolute path unchanged. Excluded descendants receive no independent transfer/delete/action/baseline treatment; native parent addressing retains existing semantics.

Admission requires complete current facts for the managed included subtree and a unique suffix-preserving mapping, including unchanged managed children. Unknown required managed facts fail closed. It does not require an all-physical-files inventory, expose excluded metadata to the identity graph, add per-candidate eligibility markers or initiate a new recursive scan. The scope-private immutable capture is permitted and is not an identity inventory. A valid alias-only root remains admissible through the same query plus existing stat/identity/content/completeness proofs; coherent reports are not universally required. Unit tests pin all derivation routes, cross-regime exclusion and both-endpoints-excluded retention. A stronger physical-exclusion policy remains outside this change.

<!-- anchor: contract-closeout -->
### One completion result and exact acknowledgment

`finalizeSyncCycle` returns a call-local closed union `{ kind: "clean" } | { kind: "incomplete" }` only after the working view is closed. Orchestrator stores no new field and performs no endpoint/count-based completion predicate.

Clean requires: no failed disposition; every authorized exact action has successful terminal publication; no failed/blocked result or detached checkpoint block; every compound/relocation action has its exact-object terminal proof. An action may be superseded only under the existing priority protocol for that disposition's exact `priorityPullAction`, with the exact authorized replacement successfully terminal; a bare member of a superseded set is not sufficient when the replacement failed or its relationship is missing. No other action can borrow its completion.

For checkpoint-capable attempts: await scheduled sibling effects, then commit exactly once if clean, otherwise abort exactly once. Commit exception triggers abort before classification/retry and yields no clean result. Abort failure throws existing WorkingViewAbortError and escapes ordinary retry without another abort. A checkpoint-less backend uses the same terminal conditions and may return clean without a checkpoint call. Exceptional paths share this finalization boundary; avoid outer catch double-abort.

Place the attempt callback wrapper in the existing finalization module: its single exception boundary covers observation, admission, execution, record publication and checkpoint publication. It settles scheduled siblings and owns abort on each exceptional/incomplete exit. Orchestrator's executeWithRetry catch only classifies/retries the already-closed attempt; remove its competing abort path. An abort failure escapes that wrapper directly. No retained closed/aborted flag or new lifecycle owner is needed.

Only clean permits tracker acknowledgment or the UI's successful/up-to-date cycle presentation. UI/notification code mechanically projects this result and existing diagnostic reasons; zero failed counts alone cannot display clean completion when proof is missing or checkpoint is blocked. No new persistent UI status or failure vocabulary is introduced. Existing captured endpoint generations must match for dirty paths and rename/folder claims; stamp folder parent endpoints in the existing generation map where needed. A same-value A→B→A→B event sequence cannot be consumed by pair-value equality alone. No new generation map, pending queue, or cross-cycle status. All retained reports belong to decided components, replacing `unsettledLocalRenameInput` and the orchestrator's independent folder predicate rather than merely deleting their checks.

## Removal and integration inventory

- Remove action-bearing AdmissionSnapshot, bindAdmissionPlan and production admitDestructivePlan; remove component membership/liveness derived from actions.
- Remove action-dependent deriveTopologyCoverage, hasAliasTargetMutation, hasUncoveredStableIdentity and the post-no-op evaluator pass. Retain their identity/scope safety requirements as current-fact decisions, not bypasses.
- Remove shapeIdentityComponentActions, action-pair rename optimizers/coalescers and reconstructCaseAliasChildRenames. Retain current-provider-path addressing and folder suffix mapping as private pure helpers.
- Fold local move identity/content relation logic into the sole component decision; remove duplicated normalize→decide→re-evaluate policy and duplicate fresh factual action state.
- Retain pure report uniqueness/coherence arbitration; reports do not become unconditional pending operations.
- Remove actionCoversRename, unsettledLocalRenameInput, unsettledFolderRename, remoteAtNew/remoteLeftOld and counts-based acknowledgment. Keep lifecycle barriers and existing pool capacity, replacing flat scheduling with the specified independent-singleton pool followed by globally serial ordered components and priority deferral.
- Retain action kinds, conflict policies, authorized-plan brand, state stores, finalizer, generation bookkeeping, adapter/provider boundaries and four-stage ownership. No new orchestrator field or database schema change.

<!-- anchor: adr-20260905-fact-first-component-admission -->
## Decision and normative change

The [accepted ADR](../../../adr/adr-20260905-fact-first-component-admission.md) changes four-stage INV-006/INV-007's action-first/evaluator ordering and the accepted 20260904 ADR's raw-action materialization/root-action binding and residual actionless failure clauses. It additionally replaces flat action-phase scheduling/global path-only independence with ordered component execution and priority deferral, and relaxes the fully-data-only/no-additional-scope-information boundary to permit the single captured pure ScopeProjection query. ADR 0001 A/B and attempt closeout, configured inclusion policy, excluded identity-data filtering, report conflict fail-closed and exact version-preserving authorization remain. Historical ADR text is preserved; implementation/promotion must update the corresponding active-design clauses and guards together. Acceptance is not a claim of current production conformance.

## Dependency-ordered units

### unit-1 — Fact-only Admission and public reproduction

Replace the public Admission path and graph, bind identities before the content helper, directly return final dispositions/readonly ordered actions, and remove old optimizer/repair production code. Close components over actual endpoints, baseline publication keys and effect-overlapping parent/child namespaces without merging the whole vault. Strengthen the two existing RED fixtures into complete public cases. Add the single immutable-capture scope query and require every relation derivation route to use it; preserve inclusion policy and verify managed-subtree completeness without action-derived inventory. Approximate size: one substantial Admission work unit; no feature-flag fallback.

### unit-2 — Exact execution and atomic successful publication

Depends on unit-1's ordered component contract. Replace duplicated fresh-state fields with fixed readonly protocol payloads; implement both-direction rename/content, policy-required foreign-version preservation and identity-neutral exact source/destination CAS/folder transactions with merge-base invalidation and refresh CAS. Run independent singleton transfer/same-key-match components in the existing pool, settle it, then run complex/conflict/structural components globally serially with priority deferred. Preserve action order through publication and block failed suffixes. Extend real store/executor tests and re-observe every interruption. No flat regrouping by kind, new scheduler owner or arbitrary step framework.

### unit-3 — Sole finalization and generation acknowledgment

Depends on unit-2's terminal result. Return clean/incomplete only after closeout, wire all normal/exception paths, remove orchestrator reclassification, and acknowledge only matching existing generations. Test priority exact replacement, optional checkpoint, commit/abort failures and ABA. Approximate size: one bounded lifecycle work unit; no new retained state.

### unit-4 — Enforcement and end-to-end convergence acceptance

Depends on units 1–3. Update architecture/ownership guards for fact-only input, sole identity owner and sole completion predicate; promote the accepted ADR's corresponding active-design changes with implementation review. Full gate, independent adversarial review, and actual-vault post-rename repeated sync (both directions, file/folder, edit/no edit). Approximate size: one verification/documentation unit. No data reset, production deployment, PR merge or release is implied by this design document.

Implementation discretion is confined to private helper names, file placement within existing owners, and test fixture factoring. Protocol order, source/destination expectations, failure results, scope and publication ownership are fixed above. A new action kind/state owner or need to overwrite an unpreserved version requires design review, not local discretion.

## Acceptance

AC-convergence: complete public file and folder facts, both report sides and alias-only where authorized, baseline aligned→zero actions and clean; baseline absent/old→match publication→next cycle zero actions and clean. Repeat after successful rename and inverse rename. COLD/WARM/HOT with equal complete facts produce equal effects/disposition. Unknown, collision or contradictory report remains failed even with no proposed work.

AC-preservation: execute admitted pure rename and rename+edit in both directions, opposite-side-only edit, concurrent differing edits, foreign destination and recreated source. Assert exact final bytes/identities and every policy-required preserved version. Inject failure after each I/O effect, proof and publication boundary; re-observe normally without prior-failure input. Test every B pull/match/conflict × A match/conflict order, including B conflict→A match, and verify each prefix publication precedes suffix effects. On prefix failure the suffix is blocked, not executed until a CAS happens to reject it. Assert no independent pool or priority effect overlaps any globally serial component interval; only independent singleton transfers and same-key matches are pool eligible.

In particular, remote A(X)→B(X) with recreated A(Y) must never schedule a rename reading local A together with an independent transfer overwriting local A. Assert direct B materialization with atomic A→B baseline relocation and version-preserving A resolution with expected-absent publication, including foreign B occupancy. B failure blocks A and retains prepublication records; B success/A failure leaves baseline B only and ordinary baseline-absent A resolution converges. For a foreign destination, test selected-policy preservation→I/O success→CAS failure→ordinary re-observation and eventual publication; stale baseline identity must not override current endpoint identity. Newly arrived source/destination records and their matching merge bases survive CAS races and late refresh.

AC-scope (part of AC-preservation): with identical included identity facts but distinct captured scope surfaces/settings, verify compatible and incompatible candidate results. Exercise report, alias, actual-endpoint and baseline-derived relations through the same pure query, including attempts to reconstruct a filtered parent relation. Scope compatibility alone never proves identity/completeness or authorizes effects. Preserve known descendant inclusion XOR rejection and both-endpoints-excluded desktop.ini retention; no all-physical-subtree scan, live callback or excluded metadata in identity grouping.

AC-publication: same-key CAS never deletes its new record; distinct-key expectation mismatch preserves every record/content item, while an exact foreign destination may be replaced only after Admission authorization and policy-required terminal preservation proof. The store compares exact records/absence without identity policy. Source deletion, destination replacement and incompatible merge-base invalidation are atomic; best-effort refresh is CAS-bound to its terminal record. Injective folder rotation is all-or-nothing; failed parent CAS preserves successful child records. I/O success then CAS failure converges through ordinary re-observation. A failed CAS never counts as successful execution.

AC-closeout: zero failed counts but missing proof is incomplete; detached block, priority replacement failure/mismatch, commit failure and abort failure never acknowledge tracker. Valid exact replacement and checkpoint-less clean cycles do. New or same-value ABA rename/folder events during execution survive acknowledgment. Every checkpoint-capable attempt has exactly one successful commit or completed abort, with abort failure escaping without a second abort.

AC-structure: full lint/bot/build/coverage and structural guards pass; no action-first production fallback, independent topology/completion owner, new durable state or orchestrator field. Actual vault repeatedly completes post-rename cycles, not merely the first rename action. Design review or unit tests alone do not establish that the user's vault is fixed.

## Verification seams and present evidence

| Profile | Tier | Command / seam | Discriminating result |
|---|---|---|---|
| Admission | T0 | `npx vitest run src/sync/plan-admission.test.ts` | Public facts, no caller-supplied proposed actions; negative identity/scope counterexamples retained. |
| Execution/store | T1 | `npx vitest run src/sync/plan-executor.test.ts src/sync/state.test.ts src/sync/state-committer.test.ts` | Existing injectable filesystems and IDB test store; bytes, identities, transaction atomicity and interrupted replay. |
| Lifecycle | T1 | `npx vitest run src/sync/sync-cycle-finalization.test.ts src/sync/orchestrator.test.ts src/sync/local-tracker.test.ts` | Exact completion and captured-generation acknowledgment, not counts. |
| Full gate | T2 | `npm run lint && npm run lint:bot-repro && npm run build && npm run test:coverage` | All gates green; no weakened RED scenarios or guard bypass. |
| Actual vault | T2 | User-observed Obsidian rename followed by repeated sync, recording build hash and logs | Both directions and edit variants converge; no destructive automatic data reset. |

Pre-implementation gate rerun: lint, bot reproduction and build passed; 1787 existing tests passed and 2 investigation reproductions remain RED. Those RED seams lack complete baseline entries; strengthen them as unit-1 specifies rather than deleting them. These counts are not implementation verification of this revised contract. The user approved the responsibility-contract revision and fresh independent design review returned approved with no findings; see the verification member for review provenance. Production implementation and actual-vault convergence remain unverified/pending. The earlier design approval was withdrawn after three P1 contract findings; their design correction is specified below, not established by implementation tests.

### Three-P1 correction trace

| Finding | Contract correction | Required discriminating acceptance |
|---|---|---|
| Flat phases can execute dependent A before B publication | Existing component owns readonly action order; independent singleton pool settles before global serial components; every action publishes before its successor; priority defers | All six B pull/match/conflict × A match/conflict combinations, prefix I/O/proof/CAS failure blocks suffix, pool/priority exclusion |
| Same-identity-only destination policy prevents authorized foreign replacement and retry | Admission owns replacement policy, executor proves selected-policy preservation, store performs exact src/dst CAS plus atomic incompatible-base invalidation and record-bound refresh | Foreign target preserved/replaced, concurrent record protection, I/O success/CAS failure/re-observation convergence, late refresh race |
| Post-filter facts cannot distinguish scope-incompatible re-derived parent relation | One fixed pure query over immutable pre-projection scope surface/settings in existing ScopeProjection; all derivations consult it | Same included facts/different scope eligibility, report/alias/actual/baseline routes, XOR and both-excluded cases, no live source or excluded identity metadata |
