---
id: change-20260916-cache-path-id-bijection
kind: change
title: Give the metadata cache one owner for cache-path assignment
status: draft
created: '2026-09-16'
profile: sdd@1
intent: Give derived cache-path assignment a single owner, stop the cache destroying a
  live object to free an address, and repair the provider namespace upstream so both
  colliding objects survive and sync.
outcomes:
- Derived cache-path assignment has one pure, backend-agnostic owner whose decision is a
  total function of the claim set, so provider event order cannot change the result.
- Address assignment is computed over an evidence unit's whole claim set, so a losing
  claimant's subtree is never bound under the winning claimant in any listing order.
- Every displacement is a returned fact naming the path, both stable ids and the removed
  descendants; nothing leaves the cache silently.
- A contention between two provider-resolved claims is repaired at its source by renaming
  one object on the provider with the existing conflict-suffix convention, so both objects
  survive and both sync.
- No cycle commits its checkpoint while a claimant is withheld, so the cross-drain route
  from a withheld claimant to delete_local is unreachable without a provider probe or any
  retained state.
- A displaced path never reaches RemoteDelta.deleted at any of its three producers, while a
  genuine deletion and an out-of-root move still do.
- A user who has changed no settings is told how many addresses were contended.
- One shared contract case pins two stable ids at one cache path, and the survival of both
  objects, for every registered caching family or a cited non-producibility.
scope:
- src/fs/caching/address-arbitration.ts — new single owner for derived address assignment.
- src/fs/caching/metadata-cache.ts — claim-set assignment, non-silent occupant eviction,
  returned displacement facts.
- src/fs/caching/id-delta.ts — drain accumulation, unit-end settlement, separation of the
  two causes of an unresolvable entry.
- src/fs/caching/remote-fs.ts — one attribution rule at all three producers of `deleted`,
  and the declared carrier on the full-scan route.
- src/fs/interface.ts — widened getChangedPaths result and the optional identity-addressed
  rename capability.
- src/fs/googledrive/index.ts — the Google Drive implementation of that capability.
- src/sync/plan-admission-address-contention.ts — new Admission stage producing the
  remediation and the checkpoint block.
- src/sync/types.ts — optional provider-identity input on RenameAction.
- src/sync/plan-executor.ts — remote-only namespace-repair branch for rename_remote.
- src/sync/remote-change-source.ts — optional contention callback alongside
  onIdentityEvidence.
- src/sync/change-detector.ts — threading that callback from the orchestrator's deps.
- src/sync/orchestrator.ts — contention facts to Admission, count to the outcome and the
  status change, checkpoint block.
- src/sync/sync-notification.ts — non-error contended clause in the cycle summary.
- src/main.ts — contended count in the status bar, the only unconditional per-cycle surface.
- src/fs/caching/metadata-cache.test.ts — first unit coverage for the shared cache.
- src/fs/caching/id-delta.test.ts — first unit coverage for the shared delta applier.
- src/fs/caching/remote-fs.contract.test.ts — cursor-expiry and displacement-exclusion cases.
- src/fs/googledrive/metadata-cache.test.ts — update the test that pins silent displacement.
- tests/fs/contracts/caching-remote-fs.contract.ts — shared collision and survival cases.
- tests/fs/remote-backend-contracts.test.ts — required-contract matrix cell per family.
- tests/fs/googledrive/caching-remote-fs.contract-harness.ts — collision-staging seam.
- tests/fs/dropbox/caching-remote-fs.contract-harness.ts — cited non-producibility.
- tests/fs/onedrive/caching-remote-fs.contract-harness.ts — cited non-producibility.
- docs/design/design-remote-backend-implementation-contract.md — RB-level rules for the
  single address-assignment owner and the optional identity-addressed rename capability;
  this document carries its normative items in prose rather than in frontmatter, so they
  are declared here rather than in the promotion manifest.
non_goals:
- Any Dropbox or OneDrive production change. Dropbox's address is the provider key and its
  path-keyed replacement is correct for it; OneDrive is path-unique in practice and its
  unknown is unsettled.
- Any IndexedDB schema change, METADATA_CACHE_VERSION bump, or migration code.
- A new SyncActionType, a DAG, or a recovery queue.
- Persisting a collision record, disposition, failure reason, repair queue or recovery
  marker; adding a persistent store, a retained in-memory correctness owner, or an
  AbstractMetadataCache instance field.
- A PathAuthority branded type, schema or AST enforcement mechanism; no main-today violation
  of the recorded labels is constructible.
- An AST ownership guard for cache address assignment, and the package.json,
  docs/code-enforcement.md and AGENTS.md edits it would oblige.
- A consent prompt, setting or opt-out for the provider rename.
- A provider-liveness probe on the delta route, a byId-primary cache, or any other
  cross-cycle carrier for a withheld claimant.
- Changing rewriteChildPaths, whose five callers all compensate for its missing occupant
  check today.
- Any dependence on Logger.enabled or src/sync/sync-cycle-diagnostics.ts, neither of which
  is on main.
change_classes:
- behavior
- responsibility
- boundary
- invariant
- internal_design
governance:
  gate: hard
  reasons:
  - Introduces a provider mutation (a rename of the user's remote object) as a remedy for an
    internal representational limit.
  - Adds an optional filesystem capability and a new Admission stage, both of which extend
    accepted shared boundaries governed by ADR 0001 and the remote backend implementation
    contract.
  - Blocks checkpoint commit on an observed contention, which changes when the remote cursor
    advances.
  approval_evidence: The repository owner settled the remedy during design — a provider-side
    rename using the existing conflict-suffix convention, with "nothing is lost" as the
    binding invariant, and explicitly withdrew the authorization objection and any consent
    prompt or opt-out. Recorded in the design plan's adr-upstream-rename-remedy. The
    remaining HARD-gate approvals (the capability, the Admission stage, the commit block)
    are not yet obtained and are listed in unresolved_decisions.
members:
- role: requirements
  path: changes/change-20260916-cache-path-id-bijection/requirements.md
  required: true
- role: implementation
  path: changes/change-20260916-cache-path-id-bijection/implementation.md
  required: true
- role: verification
  path: changes/change-20260916-cache-path-id-bijection/verification.md
  required: true
promotion:
- target: design-four-stage-sync-pipeline
  section: responsibilities
  action: upsert
  item:
    id: RESP-005
    statement: Derived cache-address assignment has one owner whose decision is a total,
      pure function of the evidence unit's claim set, never of arrival order, acquisition
      temperature, checkpoint contents, record count or prior errors. A claimant that is
      not admitted, and every entry whose resolved parent chain passes through it, is a
      returned fact of the call that withheld it and never an absence in the remote delta.
      A provider-keyed address, where the provider's own address is the stable id, is
      outside this owner's domain.
  reason: 'GitHub issue #90 asks who owns address assignment; this fixes the answer, its
    allowed inputs and its domain boundary so a fourth local rule cannot be added, and it
    binds every future caching backend.'
- target: design-four-stage-sync-pipeline
  section: invariants
  action: upsert
  item:
    id: INV-017
    statement: No object is destroyed, emptied or made permanently unreachable to free a
      cache address. Where the provider namespace holds a state the destination cannot
      represent, the repair is an admitted provider rename of the object that is not to
      keep the address, and a cycle that owes such a repair does not commit its checkpoint,
      so no cursor advances past a withheld claimant. A remote filesystem may provide an
      optional identity-addressed rename capability for an object holding no cache path;
      where it is absent no such action is produced and there is no path-addressed
      fallback.
    enforcement: contract
  reason: This is the cross-cutting invariant the change exists to establish, and it binds
    future judgement about what may be done to free an address and about how an object
    with no cache path may be addressed.
unresolved_decisions:
- 'unknown-onedrive-duplicate-names — can OneDrive produce two same-named children under
  one folder? Decides whether OneDrive must implement the identity-addressed rename
  capability; its shared-contract cell is a cited non-producibility until this settles.
  Settle by attempting the creation through the Graph API in the opt-in OneDrive e2e.'
- 'unknown-dropbox-folder-replacement-contract — is Dropbox''s folder-replacement eviction
  the correct reading of its provider contract? No impact on this change, which leaves
  Dropbox untouched and takes no position; cited in the shared matrix. Settle by the
  provider''s documented contract or an observed e2e.'
- 'unknown-admission-outcome-on-main — what does Admission actually do end to end for these
  shapes on main? No impact on this change, which does not depend on Admission failing
  closed as a damage bound; the conflicting_identity stall in issue #90 was measured on a
  PR-83-rebased worktree. Settle by driving the production admission entry over a
  two-sibling delta on main.'
- 'unknown-relist-collision-interaction — how does a mid-drain relistTargets walk interact
  with a collision in the re-listed subtree? The subtree enters the same arbitration and
  unit-end settlement, but the interaction is unmeasured. Settle by a fixture that moves a
  folder containing a name collision into the synced root mid-drain.'
- 'unknown-collision-stall-escape — what happens when the provider permanently refuses the
  repair rename? The remote cursor stalls while the rest of the vault keeps syncing and the
  user is told each cycle; no recovery machinery is built and nothing is persisted. Settle
  by observing a permission-refused rename against a real Drive account.'
- 'hard-gate-approval-remaining — does the owner approve the optional filesystem rename
  capability, the new Admission stage, and blocking checkpoint commit on an observed
  contention? These are the HARD-gate items the owner''s remedy decision does not itself
  cover. Settle by explicit approval recorded against this change before implementation
  starts.'
tags:
- metadata-cache
- deletion-safety
- cross-backend
owners: []
relations:
- {type: conformsTo, target: design-four-stage-sync-pipeline}
- {type: conformsTo, target: design-remote-backend-implementation-contract}
source_paths:
- src/fs/caching/metadata-cache.ts
- src/fs/caching/id-delta.ts
- src/fs/caching/remote-fs.ts
- src/fs/interface.ts
- src/sync/plan-executor.ts
- src/sync/orchestrator.ts
- src/sync/conflict.ts
- tests/fs/contracts/caching-remote-fs.contract.ts
summary: path↔stable-id の全単射に owner を与え、3 writer が別ルールで独立にアドレスを決める状態を解消する。
  衝突は provider 側リネームで源から解消し、どちらのオブジェクトも失わない。
updated: '2026-09-17'
---

## Summary

`AbstractMetadataCache` has no owner for "which cache path does this object get?". Three writers
answer independently, and when two distinct stable ids resolve to one cache path the answer is
`setFile`'s occupant branch (`metadata-cache.ts:110-116`): `removeTree(path)`, with no log line, no
throw and no entry in any result object. The evicted object, and everything beneath it if it was a
folder, never syncs again.

This change gives derived address assignment one pure owner whose decision is a total function of
the evidence unit's claim set; computes assignment over the whole claim set so a loser's subtree is
never bound under the winner in any listing order; makes every displacement a returned fact; and
keeps a displaced path out of `deleted` at all three producers of that set.

The condition itself is repaired **upstream**. Because the destination is a real filesystem that
cannot hold two objects at one address, no design can place both there — so the source stops
containing the state instead. When two provider-resolved claims contend, Admission authorizes a
`rename_remote` of the claimant that is not to keep the address, to
`insertConflictSuffix(path, "id-" + <its stable id>)`, the convention users already meet through
conflict resolution. Both objects then exist at distinct addresses and both sync. The binding
invariant is that nothing is lost, on every path including the failure path.

A cycle that owes a repair is checkpoint-blocked, which is existing machinery
(`sync-cycle-finalization.ts:47`, `:74`, `:81-84`). That is what makes the cross-drain route —
a withheld claimant forgotten across a cursor advance, whose address then reads absent and becomes
`delete_local` while the object is live on the provider — structurally unreachable, with no provider
probe, no retained claimant and no new completion kind.

Two scoping facts bound how much machinery this deserves. The built-in Drive connection runs on
`drive.file` (`googledrive/auth.ts:10`, `README.md:53`), so a duplicate created on the cloud side is
invisible and never reaches the cache; duplicate-name collisions are largely a custom-OAuth surface,
while orphan collapse — reachable by every user — is resolved by the arbiter's authority tier alone,
with no rename and no provider cost. And both existing user-facing channels are off by default
(`enableLogging` and `showSyncNotifications`, `settings.ts:73-74`), so the contended count goes to
the status bar, the only surface every cycle updates unconditionally.

Dropbox and OneDrive receive no production change, and `rewriteChildPaths` is left alone: its five
callers all compensate for its missing occupant check today.

## Closure Notes
