# Case-only folder rename continuity

## Decision

The repair closes two missing parts of existing contracts instead of adding a recovery
mechanism.

1. `CachingRemoteFs` treats its existing deferred touched-path set as the projection of
   every successful live-cache mutation since the last committed checkpoint, regardless
   of whether the mutation came from delta acquisition or execution. A clean checkpoint
   persists the final values or absences for those paths atomically with cursor and scope.
2. Observation supplies the minimum cycle-local identity facts and may reconstruct one
   unambiguous case-only folder relation from current state. Admission alone decides
   whether a relation is terminal. A folder has no new persisted root identity: its
   logical continuity is the complete, non-empty, one-to-one set of included managed
   descendant file identities.

The design adds no Orchestrator policy, operation journal, provider receipt, persisted
schema, folder `SyncRecord`, evidence kind, disposition, or ambiguous status. It reuses
`stable_identity`, `RenameEvidence.authority = current_state`, `resolved_no_action`,
`match`, `cleanup`, and the existing fail-closed reasons.

## Scope and responsibility flow

```text
provider mutation/delta
  -> CachingRemoteFs live cache + exact deferred path projection
  -> clean finalization -> existing atomic file-map/cursor/scope checkpoint

baseline SyncRecords + frozen local/remote observations + optional reported relation
  -> Observation: contextual identity facts / unique current-state case relation
  -> Admission: endpoint + file/folder identity proof
       safe self echo       -> resolved_no_action
       safe stale baseline  -> existing match + cleanup bookkeeping only
       foreign/incomplete   -> existing failed disposition, checkpoint withheld
```

The remote filesystem owns cache projection. Observation owns facts and relation
reconstruction. Admission owns their meaning and all authorization. Execution performs
only admitted existing actions. Finalization remains the only checkpoint boundary. The
Orchestrator only sequences those owners.

In scope are Google Drive, Dropbox, and OneDrive; write, mkdir, rename, delete, implicit
parents, folder subtrees; reported self echoes; and COLD/restart recovery after rename
evidence has already disappeared. Out of scope are provider API changes, a durable
recovery workflow, path/content-as-identity, conflict-policy changes, and retrospective
claims about raw provider events that were not logged.

## Requirements

<!-- anchor: fr-ccr-01 -->
### FR-CCR-01 — Final cache projection at clean checkpoint

When a clean cycle commits its checkpoint, it shall atomically persist the final live
remote-cache values or absences produced by both delta acquisition and successful
executor-side filesystem mutations together with the cursor and scope fingerprint.

<!-- anchor: fr-ccr-02 -->
### FR-CCR-02 — Complete mutation footprint on every caching backend

When write, mkdir, rename, delete, implicit parent creation, or folder subtree mutation
changes the live cache, Google Drive, Dropbox, and OneDrive shall place every changed
old/new root, descendant, and parent key in the same deferred checkpoint projection.

<!-- anchor: fr-ccr-03 -->
### FR-CCR-03 — Commit-last failure behavior

If an action, Admission component, or checkpoint transaction fails, the system shall
advance neither the durable file map nor its cursor/scope and shall retain the in-memory
projection footprint for the next clean commit unless reset or a full scan supersedes it.

<!-- anchor: fr-ccr-04 -->
### FR-CCR-04 — Sparse cycle-local continuity evidence

When a reported rename/alias or a candidate current-state case-only relation needs
continuity proof, Observation shall retain committed and current same-root remote
identity occurrences through the existing `stable_identity` carrier. It shall not emit
same-path evidence for unrelated ordinary unchanged rows.

<!-- anchor: fr-ccr-05 -->
### FR-CCR-05 — Folder continuity from managed descendants

When Admission evaluates a folder relation, it shall treat the complete, non-empty,
suffix-preserving, one-to-one set of included managed descendant files as the folder's
logical identity. Every pair shall have the same non-empty committed/current remote
identity; no folder-root identity or persisted folder record shall be invented.

<!-- anchor: fr-ccr-06 -->
### FR-CCR-06 — Proven actionless self echo

When old/new endpoints are authoritatively converged and file or folder continuity is
proved, Admission shall classify a zero-action reported rename as
`resolved_no_action`, perform no filesystem effect, and permit normal clean finalization.

<!-- anchor: fr-ccr-07 -->
### FR-CCR-07 — Recovery after relation loss

When a COLD observation starts with no reported rename but baseline old-casing paths and
current local/remote new-casing paths uniquely prove the same case-only folder relation,
Observation shall emit that relation with `current_state` authority and Admission shall
permit only the existing non-filesystem `match`/`cleanup` bookkeeping needed to converge
the SyncRecord paths.

<!-- anchor: fr-ccr-08 -->
### FR-CCR-08 — Foreign, incomplete, and unrelated states fail closed

When identity differs, is missing, is duplicated, cannot cover the complete managed
descendant set, has more than one possible case-fold relation, or an alias is unrelated
to the exact proved relation, Admission shall authorize no destructive interpretation,
shall report an existing specific failure reason, and shall withhold the checkpoint.

<!-- anchor: nfr-ccr-01 -->
### NFR-CCR-01 — Minimal compatibility surface

The repair shall preserve the four-stage pipeline and existing public/persisted
contracts. It shall add no schema migration, journal, operation intent, provider receipt,
folder identity field, new evidence/status vocabulary, Orchestrator decision, or ordinary
full-cache rewrite.

## Repository grounding and ownership

<!-- anchor: component-remote-checkpoint-projection -->
### Remote checkpoint projection

`src/fs/caching/remote-fs.ts` owns the deferred path set, live-cache mutex, full-scan
supersession, cursor/scope values, and atomic commit lifecycle. The Google Drive,
Dropbox, and OneDrive subclasses identify mutation-specific affected paths where they
already update their metadata cache. `MetadataStore` remains only the atomic persistence
mechanism; it does not infer mutation footprints or sync success.

Grounding: `src/fs/caching/remote-fs.ts`, `src/fs/caching/metadata-cache.ts`, the three
backend `index.ts` files, `src/store/metadata-store.ts`, and the shared caching contract
registered by `tests/fs/remote-backend-contracts.test.ts`.

<!-- anchor: component-contextual-identity-evidence -->
### Contextual identity observation and current-state relation recovery

`completeIdentityEvidence` remains the identity-fact producer. The existing
WARM/COLD current-state inference in `change-detector.ts` is extended to group a unique
folder relation before the immutable `BatchObservation` is captured. It reads only the
already acquired entries, path observations, baseline records, scope, and reported
evidence; it performs no I/O and persists nothing.

Grounding: `src/sync/change-detector.ts`, `src/sync/identity-evidence.ts`,
`src/sync/path-observation.ts`, `src/sync/sync-cycle-planning.ts`, and their focused
tests.

<!-- anchor: component-actionless-rename-admission -->
### Rename continuity Admission

`evaluateIdentityComponent` remains the terminal policy owner. The component graph and
`plan-admission.ts` continue to bind all related paths, facts, and proposed actions before
execution. This owner validates file continuity, folder descendant-set continuity,
relation-local alias handling, and the restricted bookkeeping shape for COLD recovery.

Grounding: `src/sync/identity-component-decision.ts`,
`src/sync/plan-admission-graph.ts`, `src/sync/plan-admission.ts`, and the Admission and
Orchestrator tests.

## Implementation contracts

<!-- anchor: contract-final-cache-projection -->
### Contract: final cache projection

**Subject, owner, and units.** The subject is the remote cache/cursor checkpoint between
two successful commits. `component-remote-checkpoint-projection` owns it. It implements
FR-CCR-01/02/03 and NFR-CCR-01 in Units 1 and 3.

**Operational inputs.** `input-cache-mutation` is produced by a concrete backend after a
provider response and is captured at the live metadata-cache mutation seam. It is valid
only if the mutex-protected update actually applies; a stale-guard skip produces no
claimed cache change. `input-affected-paths` is produced by that same component from the
pre-mutation root/subtree and the successfully installed post-mutation paths. It is
deduplicated and retained until commit, full-scan supersession, or reset.
`input-checkpoint-meta` is the live cursor plus requested scope fingerprint owned by
`CachingRemoteFs`; it is required at clean finalization. The external provider remains
the producer of file metadata, but no provider response alone proves that the guarded
live-cache update applied.

**Decision rules and observables.** `rule-record-final-projection` adds every path whose
persisted value may now differ: an in-place write/mkdir path; each created or adopted
implicit parent; old and new rename roots and descendant paths; and every removed root
and descendant. Registration happens in the same `cacheMutex` critical section as the
corresponding cache mutation. `rule-skip-stale-projection` records nothing when the
existing compare-and-swap guard skips the mutation. `rule-commit-final-values` reads each
retained key from the final live cache at checkpoint time, upserts present values,
deletes absent values, and writes cursor/scope in the existing transaction. Multiple
changes to one key collapse to its final state. Its effects are
`observable-restarted-cache-equals-live-final` and
`observable-provider-self-delta-does-not-replay-stale-path`.
`rule-retain-projection-on-failure` clears the footprint only after successful commit;
its effect is `observable-failed-checkpoint-remains-prior`.

**Outcome and cost profiles.** A known applied cache mutation is determinate and joins
the footprint; a guarded skip is determinate no-change; persistence failure is
inconclusive and retains the previous durable checkpoint plus pending footprint. The
default is never to advance only the cursor. Time and memory are
O(distinct uncommitted changed keys + affected subtree), the same subtree already walked
by rename/delete; ordinary incremental commit does not become O(vault size).

**Compatibility profile.** The change is private bookkeeping inside the existing
`IncrementalCheckpoint` behavior. Typed consumers are all three `CachingRemoteFs`
subclasses and `MetadataStore.commitIncremental`; public filesystem/checkpoint methods,
record schema, cursor keys, and transaction shape remain compatible. Rollout requires no
migration, and rollback restores the old code without decoding new state. Baseline and
target behavior are discriminated by the restart projection tests.

**Invariants and typed failures.** `invariant-cache-cursor-colocation` requires the map,
cursor, and scope to describe one logical checkpoint. `invariant-projection-origin-
independent` forbids delta-only semantics. `failure-checkpoint-persist` propagates the
store error and retains the footprint. `failure-stale-cache-update` keeps the existing
logged guard result and relies on replay/full scan rather than pretending the skipped
state was installed. A future tree mutation that cannot enumerate its footprint is an
internal contract violation and must not ship with root-only bookkeeping.

**Witnesses and verification.** Normal witness: write, mkdir, implicit parent, rename,
and delete each survive clean commit/recreation (`verify-cache-projection-shared`).
Adversarial data-loss witness: rename `Templates` to `TemplateS` with descendants,
commit, recreate the Google filesystem, and replay the provider self-change; restoring
an old path or re-emitting the rename violates FR-CCR-01/02 and
`observable-provider-self-delta-does-not-replay-stale-path`
(`verify-google-restart-projection`). Adversarial recovery witness: a transaction throws,
then succeeds; cursor-only advancement or an emptied footprint violates FR-CCR-03 and
`observable-failed-checkpoint-remains-prior` (`verify-cache-persist-failure`).

<!-- anchor: contract-contextual-identity-continuity -->
### Contract: sparse identity continuity and COLD relation recovery

**Subject, owner, and units.** The subject is the cycle-local remote identity relation
for one evidence-connected component. `component-contextual-identity-evidence` owns
fact completion and current-state relation reconstruction. It implements FR-CCR-04/05/07
and NFR-CCR-01 in Units 2 and 3.

**Operational inputs.** `input-baseline-records` is produced by the prior successful
state commit, read by `SyncStateStore`, and contributes only non-empty
`remoteIdentityKey` plus its recorded path. `input-current-observations` is produced by
the current WARM/COLD local and remote list/stat boundary; only exact/alias facts with
actual entities are usable, and confirmed absence is required for endpoints.
`input-reported-relations` is the optional cycle-local tracker/provider evidence.
`input-scope-projection` is produced before Admission and limits the managed set to
included file paths. All inputs are frozen for the batch; missing or uncertain input
cannot be replaced with spelling, content, or a cross-root key.

**Decision rules and observables.** `rule-contextual-same-path-continuity` retains
baseline/current occurrences at a relation-connected target even when both use the same
path. X/X remains one `stable_identity` fact; X/Y remains two phase-qualified facts;
missing keys are not synthesized. `rule-suppress-ordinary-same-path` keeps unrelated
unchanged rows outside the evidence graph and produces
`observable-ordinary-same-path-sparse`.

`rule-infer-unique-case-folder` runs only in confirmed WARM/COLD current state and only
when no reported relation already owns the mapping. A candidate consists of a baseline
old path and a current local path whose normalized strings are equal but whose exact
spellings differ at one folder-prefix mapping; the current remote file at the new path
has the same non-empty identity as the baseline. Every included managed descendant under
either candidate root must map one-to-one by the exact suffix to one current local and
remote descendant under the new root. At least one descendant is required. All pairs
must select the same old/new roots, the old local/remote endpoints must be confirmed
absent or resolve only as the new alias, and no independent current occupant or second
case-fold candidate may exist. Only then Observation emits one folder rename plus its
descendant relations with `authority: current_state`, producing
`observable-cold-case-relation-reconstructed`.

For an already reported folder relation, baseline descendant paths may already be under
the new root after a prior state commit; contextual X/X target occurrences are still
retained. For relation-loss recovery, at least one baseline path must be under the old
root, so the result expresses observed local/baseline intent rather than inventing a
rename from an unchanged tree.

**Outcome, scope, and cost profiles.** Complete unique facts yield a determinate
relation. Missing identities/endpoints yield unknown; unequal identity, duplicate
suffix, unmatched descendant, independent occupant, or multiple root candidates yield
conflicting/inconclusive and no inferred relation. Existing alias/stable-identity facts
remain in the batch so Admission fails closed; absence of inference is not permission to
plan paths independently. The claim covers the complete included managed descendant set
of the component, not excluded paths or the whole provider account. Grouping is O(number
of observed entries and descendants) with maps keyed by folded path, root pair, suffix,
and identity; an all-pairs search is forbidden.

**Compatibility profile.** `IdentityEvidence`, `EntityOccurrence`, `RenameEvidence`,
`SyncRecord`, and `FileEntity` are reused unchanged. No ordinary row gains evidence, no
fact survives the cycle, and no schema or public API changes. The existing per-file
current-state case recovery remains compatible and the folder case is a stricter grouped
form.

**Invariants and typed failures.** `invariant-identity-opaque-same-root` allows equality
only between provider keys from the configured root. `invariant-folder-proof-complete`
forbids subset-based identity. `failure-case-relation-ambiguous` and
`failure-folder-continuity-incomplete` emit no inferred relation and preserve facts for
an Admission failure; they do not silently fall back. `failure-observation-unknown`
continues to abort or produce the existing unknown observation rather than manufacture
absence.

**Witnesses and verification.** Normal witness: reported file X/X adds same-target phase
occurrences while an unrelated unchanged row stays absent
(`verify-contextual-identity-evidence`). Adversarial security witness: reported X/Y
retains both identities so Admission can reject it; collapsing to current Y violates
FR-CCR-04/08 (`verify-contextual-identity-evidence`). Recovery witness: persisted
`Templates/a.md`, `Templates/b.md` identities X/Y plus exact local/remote
`TemplateS/a.md`, `TemplateS/b.md` identities X/Y produces one current-state folder
relation (`verify-cold-folder-reconstruction`). Adversarial witnesses use a missing
child, duplicate folded target, empty folder, or one foreign descendant; each produces
no authorized recovery (`verify-cold-folder-reconstruction`).

<!-- anchor: contract-actionless-rename-terminal -->
### Contract: Admission terminality and baseline convergence

**Subject, owner, and units.** The subject is one evidence-connected rename/alias
component immediately before execution. `component-actionless-rename-admission` owns the
decision. It implements FR-CCR-05/06/07/08 and NFR-CCR-01 in Units 2 and 3.

**Operational inputs.** `input-admission-component` is produced by the existing graph
from frozen observations, scope, evidence, baseline membership, and proposed actions.
`input-file-continuity` is the exact target baseline/current identity pair produced by
Contract 2. `input-folder-continuity-set` is the Contract 2 descendant set, keyed by
relative suffix; for each suffix it contains exactly one baseline occurrence (under old
or new root) and one current target occurrence, plus exact current local/remote
entities. `input-relation-authority` is `reported` or `current_state`. These inputs are
valid only within the namespace and batch that produced them.

**Decision rules and observables.** `rule-file-actionless-terminal` requires zero
actions, authoritative old/new convergence on both sides, equal non-empty target X/X,
and agreement from any reported file identity; it produces
`observable-self-echo-terminal` as `resolved_no_action` with no I/O.

`rule-folder-actionless-terminal` applies the same endpoint condition but uses a
complete, non-empty, suffix-preserving descendant set. Every included managed baseline
file under old or new root and every included current target file in the component must
occur exactly once, with equal non-empty baseline/current identity. A reported folder
identity must agree with the current target folder observation when both exist, but is
not treated as a persisted continuity key. Success also produces
`observable-self-echo-terminal`.

`rule-cold-baseline-convergence` applies only to a complete `current_state` folder
relation. If the proposed component contains exactly the existing `match` actions at
proved new paths and `cleanup` actions at their proved old baseline paths, Admission may
authorize them as bookkeeping. They update/delete SyncRecords through the existing
executor/committer and perform no local or remote filesystem mutation, producing
`observable-cold-recovery-idle`. Admission does not construct a new action or authorize
push, pull, delete, rename, or conflict merely from this rule; ordinary content/conflict
proof remains unchanged.

`rule-relation-local-alias` exempts an alias from `alias_target_mutation` only when it
matches the exact old/new file pair or folder/suffix pair proven by one of the preceding
rules. It is not a component-wide alias allowance. `rule-fail-closed-continuity` maps
unequal baseline/current identities to `conflicting_identity`, missing identity or empty
folder proof to `identity_postcondition_unproven`, incomplete/duplicate folder mapping to
`incomplete_folder_mapping`, and unrelated aliases to `alias_target_mutation`. Its
effects are `observable-foreign-target-fail-closed` and
`observable-missing-proof-fail-closed`.

**Outcome partition.** Determinate safe has two forms: zero-action terminal self echo,
or current-state bookkeeping-only baseline convergence. Conflicting identity is failed
`conflicting_identity`. Unknown identity/endpoints and inconclusive or ambiguous folder
coverage are failed with the existing most-specific reason. The outcomes are mutually
exclusive; failure authorizes no action and withholds the checkpoint. There is no
pending/uncertain success state and no Orchestrator override.

**Compatibility profile.** Existing action kinds, Admission dispositions, failures,
executor phases, state-committer methods, and status mapping are unchanged. The only
behavioral expansion is accepting a previously failing component when complete opaque
identity and endpoint proof establish that no filesystem mutation—or only existing
state bookkeeping—is required. Rollback needs no data conversion.

**Invariants and typed failures.** `invariant-admission-sole-authority` keeps all
terminal and bookkeeping authorization here. `invariant-folder-is-managed-set` forbids
root spelling or a provider folder id from replacing descendant coverage.
`failure-foreign-target`, `failure-recreated-descendant`,
`failure-empty-folder-proof`, and `failure-unrelated-alias` are represented by the
existing reasons above and never degrade into success.

**Witnesses and verification.** Normal reported witness: old endpoint absent/alias to
new, new exact on both sides, and target X/X yields no action, no Admission failure, and
a clean checkpoint (`verify-actionless-identity-partition`). Normal recovery witness:
an already failing COLD state with two old baseline records and two same-identity new
local/remote files authorizes only match/cleanup, rewrites the baseline, commits clean,
and the following sync is idle (`verify-cold-recovery-integration`). Adversarial security
witnesses keep the same paths but replace one target X with Y, remove one identity, use
an empty folder, add a duplicate folded candidate, or attach an unrelated alias; no
filesystem action is executed, status remains `partial_error`, and checkpoint is not
committed (`verify-actionless-identity-partition` and
`verify-cold-recovery-integration`).

## Accepted ADR context

<!-- anchor: adr-0001-commit-last-cache -->
### Commit-last cache checkpoint

ADR `0001-metadata-cache-is-subordinate-to-commit-last` already requires cache and cursor
to be neither ahead nor behind. This change fixes the executor-origin projection gap;
it does not create a second checkpoint owner.

<!-- anchor: adr-0002-backends-verified-by-shared-behaviour-contracts -->
### Shared backend behavior contracts

ADR `0002-backends-verified-by-shared-behaviour-contracts` requires the invariant to run
through the central Google Drive, Dropbox, and OneDrive matrix. No backend opt-out or
provider-specific Admission rule is accepted.

<!-- anchor: adr-0003-opt-in-e2e-validates-fakes-against-real-backends -->
### Opt-in provider fidelity

ADR `0003-opt-in-e2e-validates-fakes-against-real-backends` keeps live case-only folder
coverage credential-gated and outside the normal gate. It is evidence about provider
shape, not a substitute for deterministic contracts.

<!-- anchor: adr-0008-fail-closed-identity -->
### Fail-closed logical identity

ADR `0008-logical-identity-admission-fails-closed` remains authoritative: identity is an
opaque same-root key, and path, case folding, size, or content does not prove continuity.
Case folding only finds a candidate relation that the identity set must prove.

<!-- anchor: adr-four-stage-sync -->
### Four-stage ownership

ADR `adr-20260903-four-stage-sync-pipeline` keeps Observation fact-only, Admission as the
sole action authority, Execution policy-free, and Commit terminal. The Orchestrator gains
no decision branch.

<!-- anchor: adr-stateless-current-recovery -->
### Stateless current-state recovery

ADR `adr-20260903-stateless-current-state-recovery` rejects persisted intent. Relation-
loss recovery is recomputed from current authoritative endpoints and committed identities
and uses existing bookkeeping actions to converge the baseline.

No new ADR is required. The durable final-projection and folder-continuity invariants are
promoted into the active four-stage design; ADR 0001/0008 and directly contradictory
backend documentation receive only narrow clarification.

## Decisions and rejected alternatives

- Extend the existing touched-path projection. A provider-specific pending model would
  duplicate lifecycle; a full-store rewrite on every ordinary mutation would inflate
  cost; delta-only bookkeeping is incorrect.
- Reuse contextual `stable_identity`. A new evidence kind adds vocabulary without new
  information, while unconditional same-path evidence creates unrelated zero-action
  components.
- Model a folder as its complete included managed descendant identity set. Persisting a
  folder identity would add schema/lifecycle, and root path equality is not identity.
- Reconstruct only a unique case-only relation in Observation. Orchestrator heuristics or
  Admission I/O would create a second fact/decision owner.
- Reuse `resolved_no_action`, `match`, `cleanup`, and existing failures. A pending or
  ambiguous status does not resolve safety and would require new lifecycle semantics.
- Keep provider-event direction as optional live evidence. The deterministic repair does
  not depend on reconstructing an unlogged historical event.

## Critique issue dispositions

Both `verdict: Y` issues are closed; all pass-2 hints are adopted. There is no remaining
`critique_blockers` entry.

```yaml
resolved_issues:
  - issue_ref: issue-folder-terminal-identity-owner-missing
    disposition: adopted
    resolution: Folder terminality now requires a complete non-empty one-to-one set of included managed descendant identities; no folder SyncRecord or schema is added.
  - issue_ref: issue-existing-failed-state-recovery-unclosed
    disposition: adopted
    resolution: Observation reconstructs only one fully proved current-state case-only folder relation, and Admission permits existing match/cleanup bookkeeping so an old-path baseline converges and the next cycle is idle.
```

## Implementation order

### Unit 1 — Final cache projection

Extend the existing deferred projection across the base class and all three backend
mutation seams. Start from the Google restart RED, then pin every mutation family in the
shared caching contract. Do not change MetadataStore schema, checkpoint API, or sync
pipeline.

### Unit 2 — Contextual folder continuity

Add sparse same-target occurrences, grouped folder managed-descendant proof, and unique
COLD current-state relation reconstruction in Observation. Add paired X/X, X/Y, missing,
empty, incomplete, duplicate, and ordinary-row tests before changing Admission.

### Unit 3 — Admission and integration closure

Close actionless and bookkeeping-only outcomes in Admission, retain all negative paths,
run the reported-self-echo and pre-existing-COLD-state integrations, update the active
design/accepted ADR clarification and shared backend docs, add optional live fidelity,
then run the repository gate.

## Verification strategy

Deterministic Vitest coverage is the release evidence. The Google staged restart test
proves the original cache causality; the central backend matrix proves family parity;
pure Observation/Admission tests discriminate safe and foreign states; Orchestrator
integration proves user-visible idle/partial-error and checkpoint behavior. The full gate
is `npm run lint && npm run lint:bot-repro && npm run build && npm run test:coverage`.
Credential-gated `npm run test:e2e` is recorded separately and is not required to claim
the deterministic contracts green.

## Implementation discretion

Only two private choices are delegated: the helper/container shape used to add exact
paths to the existing deferred `Set`, and the private grouping/helper decomposition used
to calculate the specified descendant set and case-only root pair. Both choices must
preserve the contracts and focused tests. Escalate if implementation requires a public
API/type, persisted state, new status/evidence kind, Orchestrator branch, every-action
full-cache scan, subset folder proof, or authorization of filesystem mutation from the
COLD bookkeeping rule.
