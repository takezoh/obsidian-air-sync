# Issue #51 — Admission-owned local rename constraint lifecycle

<!-- anchor: goal -->
## Goal and scope

Restore convergence when a never-synchronized local file is renamed, while preserving fail-closed handling for any rename that might affect a synchronized resource. The structural correction is to make Admission the sole owner of promotion from a transient local rename report to a durable safety constraint. Collection owns facts, the orchestrator owns ordering, persistence owns crash carriage, and Finalization owns only mechanical commit-last retirement.

In scope are the local rename fact channel, the immutable proof projection shared with Admission, Admission lifecycle output, pre-I/O persistence, safe-checkpoint retirement, compatibility with existing SyncState v6 debts, structured lifecycle diagnostics, and discriminating tests. Out of scope are the unproven blank-file symptom, rollback of unrelated `ff87f7d` work, remote rename authority, a general identity graph, a persistent lifecycle state machine, and any IndexedDB schema migration or manual reset.

<!-- anchor: approach -->
## Root cause and selected boundary

The defect is not a missing retry or a single rename matcher condition. `collectLocalRenameDebts` currently decides before Admission that every projected local rename is durable debt. That scope-only decision collapses four meanings into one `RenameEvidence`: tracker event, optimizer hint, destructive safety constraint, and cross-cycle obligation. An unbaselined `old -> new` report whose only safe proposal is `push(new)` is therefore treated as a requirement to prove a native rename, deferred as `rename_mismatch`, replayed forever, and never reaches Finalization's valid release boundary.

The selected design keeps the existing `RenameEvidence` path tuple and v6 `RenameDebt` wire shape, but separates their semantic channels:

1. Fresh tracker reports and replayed v6 rows enter the cycle as local rename candidates. Replay means “must be reconsidered after restart”, not “already proven to bind a synchronized resource”.
2. Acquisition constructs one immutable candidate proof projection. The shared shape is fixed: edge identity, authoritative endpoint observations, baseline membership, identity/alias/conflict facts, folder and chain completeness, current-cycle scope, proposal membership, origin, and namespace. Admission does not consume mutable `MixedEntity` internals as an alternative wire contract.
3. Current scope is reprojected from current settings in the cycle and is authoritative. The old/new scope dispositions stored in a v6 debt are historical diagnostics and conservative hints only; they never upgrade current `unknown` to included or otherwise authorize release.
4. Admission classifies each connected candidate component. A candidate is non-binding only when the whole component positively proves an additive, unbaselined interpretation. Every missing, unknown, conflicting, destructive, synchronized, scope-transition, folder-incomplete, or mixed case is safety-binding and continues through the existing exact postcondition checks.
5. Admission emits explicit lifecycle membership with two meanings: `persistBeforeExecution` and `releaseAfterSafeCheckpoint`. A safety-binding native rename belongs to both: it must survive before I/O, and it becomes eligible for exact-edge retirement only after its admitted consequence succeeds and the clean checkpoint commits. Deferred, failed, blocked, or checkpoint-failed membership remains retained. A proven additive fresh report is in neither persistence membership; a matching loaded v6 false debt is only in post-checkpoint release membership.
6. The orchestrator mechanically upserts every `persistBeforeExecution` edge before executor I/O and tracker acknowledgement. If any upsert fails, the cycle ends visibly before either begins; loaded debt and pending in-memory evidence remain available for retry.
7. Finalization does not inspect evidence or infer release from action names. It applies the Admission-provided exact membership only when the corresponding disposition is `authorized` with all actions successful, or `resolved_no_action`, and the checkpoint commits. Every other result retains the debt.

This boundary avoids a second normative rename DTO, a migration, and a general graph/state-machine rewrite. The new ADR explicitly amends only the persistence trigger in ADR 0008 section 6: pre-I/O durability applies to an unresolved local constraint classified safety-relevant by Admission, not every raw local reported edge. ADR 0008's other fail-closed and commit-last decisions, and Issue 43's exclusive Admission authority, remain intact.

<!-- anchor: fr-rename-001 -->
## Requirements

### FR-RENAME-001 — Admission owns promotion and lifecycle membership

When a cycle contains a fresh or replayed local rename candidate, only Admission shall classify it as non-binding or safety-binding and emit the exact pre-I/O persistence and post-checkpoint release memberships consumed downstream.

<!-- anchor: fr-rename-002 -->
### FR-RENAME-002 — proven additive progress

When a connected local rename component is positively proven to have no synchronized anchor or destructive consequence and proposes only additive pushes to current terminal paths, Admission shall authorize those pushes without `rename_mismatch`; a fresh report shall create no debt.

<!-- anchor: fr-rename-003 -->
### FR-RENAME-003 — genuine and ambiguous cases fail closed

When a component has baseline membership, remote identity, a destructive or native consequence, current scope transition, unknown/conflicting observation, incomplete folder mapping, or mixed evidence, Admission shall retain it as safety-binding and use the existing exact authorization rules; unproved consequences defer with zero destructive I/O.

<!-- anchor: fr-compat-001 -->
### FR-COMPAT-001 — existing v6 false debt converges safely

When a v6 debt is replayed, current authoritative facts shall reclassify it through the same Admission rule. A proven non-binding row may be retired only after successful admitted progress and a clean checkpoint; an ambiguous or genuine row remains stored. No schema migration or manual reset is permitted.

<!-- anchor: fr-persist-001 -->
### FR-PERSIST-001 — persistence is a pre-I/O prerequisite

Every Admission-retained local constraint shall be durably upserted before executor I/O or tracker acknowledgement. If any upsert fails, neither operation shall start and the cycle shall return a visible failure while preserving retry evidence.

<!-- anchor: fr-finalize-001 -->
### FR-FINALIZE-001 — retirement is consequence-bound and commit-last

Finalization shall retire an exact edge only when Admission marked it release-eligible, its corresponding admitted consequence completed successfully or resolved with no action, and the checkpoint committed. Deferral, failure, blocking, or checkpoint failure retains it.

<!-- anchor: nfr-safety-001 -->
### NFR-SAFETY-001 — authority and proof continuity

Only Admission may issue executable authority; listing absence alone shall never prove endpoint absence; current-cycle scope shall be authoritative; stale v6 scope dispositions shall not fill current unknowns; incomplete or conflicting proof shall default to safety-binding retention.

<!-- anchor: nfr-observe-001 -->
### NFR-OBSERVE-001 — lifecycle diagnostics without sensitive data

Structured diagnostics shall distinguish fresh report, replayed candidate, non-binding classification, safety-binding promotion, retained debt, released debt, and persistence failure, recording edge/path and reason metadata but never content or credentials.

<!-- anchor: nfr-scope-001 -->
### NFR-SCOPE-001 — bounded structural correction

The change shall reuse the `RenameEvidence` tuple, add only a semantic candidate channel and Admission lifecycle output, keep SyncState v6, and shall not introduce a general identity graph, persistent state machine, blanket debt deletion, or unsupported blank-file claim.

<!-- anchor: component-cycle-acquisition -->
## Components and contracts

### component-cycle-acquisition — immutable candidate proof producer

Grounded in `src/sync/change-detector.ts`, `src/sync/identity-evidence.ts`, and `src/sync/sync-cycle-planning.ts`. It merges fresh and replayed candidates, explicitly observes required endpoints, and captures the fixed candidate proof projection. It owns facts but cannot classify relevance, persistence, or release.

<!-- anchor: contract-candidate-proof -->
### contract-candidate-proof — shared proof shape and authority

The immutable projection contains edge identity, origin, namespace, authoritative local and remote endpoint observations, baseline membership for endpoints and covered descendants, identity/alias/conflict facts, folder/chain completeness, proposal membership, and current scope. Absence requires authoritative stat/delta evidence. Stored v6 scope dispositions are labeled historical and may preserve conservative context but cannot replace, strengthen, or authorize from current scope. If current scope or a required fact is unavailable, the projection stays unknown/inconclusive.

Normal witness: an explicitly observed unbaselined `draft.md -> final.md` candidate has old endpoints absent, terminal local exact, terminal remote absent, no baseline/identity, complete file mapping, current included scope, and only `push(final.md)`. Adversarial witness: the v6 row says included but current projection is unknown; Admission must not use the old value to classify non-binding.

<!-- anchor: component-plan-admission -->
### component-plan-admission — executable and rename lifecycle authority

Grounded in `src/sync/plan-admission.ts` and `src/sync/plan-admission-graph.ts`. It owns the positive additive proof, fail-closed promotion, `AuthorizedSyncPlan`, and exact persist/release membership. No helper before or after Admission may infer lifecycle membership from raw reports, scope alone, or action spelling.

<!-- anchor: contract-admission-lifecycle -->
### contract-admission-lifecycle — total candidate and lifecycle partition

Admission applies a positive whitelist to an evidence-connected component. `additive_unbaselined` requires: local origin; current scope known and included without a structural transition; no baseline, remote identity, alias, conflict, or unresolved presence anywhere in the covered component; authoritative absence at old/intermediate endpoints on both sides; exact local presence and remote absence only at terminal destinations; complete file/folder/chain coverage; and actions limited to unbaselined terminal pushes. It contributes no destructive rename edge.

All other components are `safety_binding` or `inconclusive`, enter the existing destructive graph, and retain the existing exact native/scope/no-action authorization rules. Inconclusive is fail-closed. The lifecycle output is fixed as exact edge memberships for `persistBeforeExecution` and `releaseAfterSafeCheckpoint`, associated with the component disposition that can satisfy release. A successful safety-binding native rename is in both memberships; a deferred edge is persist-only; a fresh additive report is in neither; a loaded additive v6 candidate is release-only.

<!-- anchor: component-rename-debt-carrier -->
### component-rename-debt-carrier — unchanged v6 crash carrier

Grounded in `src/sync/rename-debt.ts`, `src/sync/state.ts`, and `src/sync/orchestrator.ts`. It serializes explicit Admission persistence membership to the unchanged v6 row/key, replays rows as candidates, and performs exact-key upsert/delete. It owns no relevance rule.

<!-- anchor: contract-v6-persistence -->
### contract-v6-persistence — compatibility and persistence failure boundary

The current `RenameDebt` shape and namespace key remain unchanged. Loaded rows are candidate inputs, not self-authenticating obligations. Every retained membership is upserted after Admission and before plan I/O or tracker acknowledgement. One failed upsert aborts the cycle before both side effects; no best-effort continuation or eviction is allowed. Existing loaded rows remain stored during execution even when classified non-binding. Rollback to old code sees an unchanged v6 shape; rollout requires no migration or store clear.

Diagnostics emit lifecycle stage and reason for raw/replayed/promoted/non-binding/retained/released/persist-failed outcomes without file content or credentials.

<!-- anchor: component-cycle-finalization -->
### component-cycle-finalization — mechanical commit-last consumer

Grounded in `src/sync/sync-cycle-finalization.ts` and `src/sync/orchestrator.ts`. It consumes the same snapshot's dispositions, action completion, checkpoint result, and exact release membership. It performs no stat, scope, baseline, graph, or relevance evaluation.

<!-- anchor: contract-commit-last-retirement -->
### contract-commit-last-retirement — exact consequence-bound release

For each release-eligible edge, Finalization requires its associated disposition to be `resolved_no_action`, or `authorized` with every action succeeded, and then requires the clean checkpoint commit. Only then may it delete the exact loaded/retained record and retire matching pending evidence. Any deferred disposition, failed/blocked action, missing membership association, or checkpoint failure retains all corresponding debt. Deletion is idempotent and happens after checkpoint commit.

<!-- anchor: component-design-verification -->
### component-design-verification — provenance and regression guard

Grounded in focused sync tests, `ARCHITECTURE.md`, `docs/sync-pipeline.md`, accepted ADR 0008, the Issue 43 ADR, and the accepted Issue 51 ADR. It prevents regression to scope-only persistence and keeps the blank-file symptom outside this success claim.

<!-- anchor: adr-0008-logical-identity-admission-fails-closed -->
<!-- anchor: adr-20260825-issue43-destructive-authorization -->
<!-- anchor: adr-20260831-admission-owned-local-rename-constraint-lifecycle -->
## ADR disposition

The accepted ADR `adr-20260831-admission-owned-local-rename-constraint-lifecycle` amends the persistence trigger in ADR 0008 section 6 from every unresolved raw local report to every unresolved local constraint that Admission classified safety-binding. It preserves all other ADR 0008 decisions and preserves Issue 43's rule that Admission alone owns executable safety classification.

## Critique closure

- `issue-persistence-failure-not-closed`: upsert failure is a typed pre-I/O abort; executor I/O and tracker acknowledgement remain zero and retry evidence is preserved.
- `issue-retained-success-release-membership-ambiguous`: persist and post-checkpoint release memberships are separate and tied to exact disposition success.
- `issue-legacy-scope-authority-ambiguous`: only fresh current-cycle scope is authoritative; v6 dispositions are historical conservative hints.
- `issue-snapshot-carrier-delegates-shared-proof-shape`: the cross-component proof projection is fixed by contract and removed from private discretion.
- `issue-adr-0008-amendment-not-governed`: the accepted ADR explicitly amends only ADR 0008 section 6's persistence trigger and preserves Issue 43 authority.

## Dependency-ordered implementation units

1. `unit-candidate-proof`: carry fresh and replayed candidates through the fixed immutable proof projection and test stat/current-scope authority.
2. `unit-admission-lifecycle`: add the pure positive additive classifier plus explicit persist/release memberships and component tests.
3. `unit-persistence-integration`: replace scope-only debt creation, enforce upsert-before-I/O abort semantics, wire v6 replay, and test fresh/legacy compatibility end to end.
4. `unit-finalization`: consume consequence-bound release membership after clean checkpoint and test all failure paths.
5. `unit-design-verification`: record the ADR/boundary and run focused plus full gates.

## Acceptance and verification

- Fresh unbaselined rename: exactly the terminal push is executable, `rename_mismatch` is absent, and no fresh debt is written.
- Existing false v6 debt: the same push converges without reset; the row remains through execution and is deleted only after checkpoint.
- Synchronized native rename: the edge is persisted before I/O, exact rename succeeds, and the row is released after checkpoint.
- Ambiguous/destructive/folder-incomplete case: whole component defers, destructive I/O is zero, and debt remains.
- Upsert failure: executor I/O and tracker acknowledgement are zero; the cycle fails visibly and retries the same candidate.
- Execution failure, blocked action, and checkpoint failure: all associated debt remains.
- Old v6 included scope plus current unknown: no additive release is authorized.
- Diagnostics distinguish raw, replayed, promoted, non-binding, retained, released, and persist-failed lifecycle stages without sensitive payloads.
- `npm run lint && npm run lint:bot-repro && npm run build && npm test` is green; docs lint is green; no blank-file fix is claimed.

## Open questions

None for this bounded design. The separate blank-file causality question remains outside this change and requires second-device runtime evidence before any claim or implementation.
