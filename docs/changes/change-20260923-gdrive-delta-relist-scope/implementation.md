---
adrs:
- adr-20260923-core-entered-folder-target-selection
- adr-20260923-backend-delta-completion-operation
- adr-20260923-executable-relist-cost-measurement
change: change-20260923-gdrive-delta-relist-scope
contract_projections:
- discretion:
  - discretion-target-iteration-placement
  - discretion-target-carrier-shape
  - discretion-entered-detection-encoding
  id: contract-entered-target-projection
  verifications:
  - verify-target-set-unit
- discretion: []
  id: contract-completion-orchestration
  verifications:
  - verify-orchestration-unit
  - verify-cursor-invalid-fallback
  - verify-scope-entry-contract
- discretion: []
  id: contract-googledrive-subtree-read
  verifications:
  - verify-subtree-read-unit
  - verify-subtree-typed-410
- discretion: []
  id: contract-relist-attempt-atomicity
  verifications:
  - verify-abort-atomicity
- discretion: []
  id: contract-relist-cost-bound
  verifications:
  - verify-relist-request-count
- discretion: []
  id: contract-shared-scope-entry-completeness
  verifications:
  - verify-catalog-completeness
- discretion: []
  id: contract-provider-delta-completion
  verifications:
  - verify-completion-api-shape
  - verify-completion-facts-contract
- discretion: []
  id: contract-module-api-version-evolution
  verifications:
  - verify-module-compat
- discretion: []
  id: contract-entered-bookkeeping-lifetime
  verifications:
  - verify-ownership-guards
contracts:
- contract-entered-target-projection
- contract-completion-orchestration
- contract-googledrive-subtree-read
- contract-relist-attempt-atomicity
- contract-relist-cost-bound
- contract-shared-scope-entry-completeness
- contract-provider-delta-completion
- contract-module-api-version-evolution
- contract-entered-bookkeeping-lifetime
decision_dispositions:
- adr_refs:
  - adr-20260923-core-entered-folder-target-selection
  contract_refs:
  - contract-entered-target-projection
  - contract-completion-orchestration
  decision_input_ref: decision-input-entered-target-selection
  disposition: adopted
- adr_refs:
  - adr-20260923-backend-delta-completion-operation
  contract_refs:
  - contract-provider-delta-completion
  decision_input_ref: decision-input-delta-completion-seam
  disposition: adopted
- adr_refs:
  - adr-20260923-backend-delta-completion-operation
  contract_refs:
  - contract-module-api-version-evolution
  decision_input_ref: decision-input-api-version-evolution
  disposition: adopted
- adr_refs: []
  contract_refs:
  - contract-shared-scope-entry-completeness
  decision_input_ref: decision-input-scope-entry-completeness
  disposition: adopted
- adr_refs: []
  contract_refs: []
  decision_input_ref: decision-input-whole-drive-drain
  disposition: not_applicable
- adr_refs:
  - adr-20260923-executable-relist-cost-measurement
  contract_refs:
  - contract-relist-cost-bound
  decision_input_ref: decision-input-performance-evidence
  disposition: adopted
- adr_refs:
  - adr-20260923-core-entered-folder-target-selection
  contract_refs: []
  decision_input_ref: decision-input-documentation-authority
  disposition: adopted
- adr_refs: []
  contract_refs:
  - contract-relist-attempt-atomicity
  decision_input_ref: decision-input-walk-abort-acceptance
  disposition: adopted
- adr_refs: []
  contract_refs: []
  decision_input_ref: decision-input-target-iteration-placement
  disposition: implementation_detail
- adr_refs: []
  contract_refs: []
  decision_input_ref: decision-input-target-carrier-shape
  disposition: implementation_detail
- adr_refs: []
  contract_refs: []
  decision_input_ref: decision-input-entered-detection-encoding
  disposition: implementation_detail
milestones:
- id: chunk-core-target-selection
- id: chunk-backend-completion-and-contracts
reference_algorithms: []
role: implementation
---
# Implementation

## Contracts

The nine implementation contracts are projected into this member's frontmatter
(`contracts` and `contract_projections`). Their decision rules, invariants, failure
semantics and witnesses are expanded here; `design_dimensions` classifies the plan as
`boundary-complete`.

### contract-entered-target-projection

Owner `component-core-delta`, dimension `data_model`. Requirements FR-001, FR-002, FR-006;
unit "Project entered-folder targets from the shared apply accumulator".

- `decision-record-entered-at-apply` — condition: an id-addressed upsert entry had no prior
  cached path before its own application, resolves to a path, and is a folder. Outcome: the
  entry's stable id is added to the per-call entered-folder target set in first-entered
  order.
- `decision-project-target-set` — condition: the drain's last page has closed and the delta
  caller reads the apply accumulator. Outcome: the accumulator's entered-folder ids are
  projected out of `applyRemoteChanges` to the delta caller for this call only.
- Observable `observable-entered-target-set`.
- Invariants: populated at apply time, never sampled before or after a page; discarded with
  the call and never persisted or copied into `IncrementalChangesResult`; a folder already
  addressable in the working view is never added.
- `failure-target-set-not-projected` — internal violation, fail fast: the completion walk
  cannot run and descendants stay invisible until a COLD rescan.
- Discretion: `discretion-target-iteration-placement`, `discretion-target-carrier-shape`
  and `discretion-entered-detection-encoding` (below).

### contract-completion-orchestration

Owner `component-core-delta`, dimension `control_flow`. Requirements FR-002, FR-004, FR-005,
FR-008; unit "Orchestrate delta completion over the per-call entered targets".

- `decision-orchestrate-after-drain` — after the whole drain, core resolves each target's
  current cached path, drops ids that no longer resolve and targets nested under another
  target, and walks the remainder in first-entered order strictly one at a time by invoking
  the declared operation with the folder's stable id.
- `decision-merge-upsert-only` — returned entries merge through `applyIdDeltaPage`; absence
  never removes, tombstones or re-keys a cached entry.
- `decision-cursor-invalid-full-scan` — a `cursor_invalid` outcome for any target makes core
  return the existing `needsFullScan` outcome for the whole call.
- `decision-invoke-in-fetch-changes` — core drives the walk inside
  `ManagedRemoteFs.fetchChanges` before returning `IncrementalChangesResult`, while the
  cache mutex is held.
- Observables `observable-relist-walk` and `observable-scope-completeness`.
- Invariants: no per-page listing, concurrency or retry layer; unresolved and nested targets
  are dropped; resolution, deduplication, ordering and the upsert-only merge stay in core
  and the declared operation never reads core state.
- `failure-orchestration-listing-rejected` (transient, retry) aborts the attempt; no partial
  delta publishes. `failure-cursor-invalidated` (environmental, degrade) takes the complete
  full-scan fallback. `failure-orchestration-partial-delta` (internal violation, fail fast)
  is forbidden: the checkpoint must never advance past unfetched facts.

### contract-googledrive-subtree-read

Owner `component-googledrive-adapter`, dimension `integration_contract`. Requirements FR-004,
FR-007, FR-008, FR-009; unit "Implement the Google Drive identity-addressed subtree read".

- `decision-identity-only-read` — the adapter lists the provider subtree scoped to the
  supplied id via `client.listAllFiles(id)` and returns the entries as provider facts,
  reading no cache, cursor, scope or store.
- `decision-typed-result` — on success `{kind:'subtree', objects}`; on 410
  `{kind:'cursor_invalid'}`; retryable errors propagate; a partial subtree is never returned
  as complete.
- Observable `observable-subtree-result`.
- Invariants: addressed by provider identity, never a derived path; one invocation issues one
  scoped recursive listing; no core state is read.
- `failure-subtree-listing-rejected` (transient, retry) propagates to core, which aborts.
  `failure-subtree-cursor-invalid` (environmental, degrade) is surfaced for the full-scan
  fallback.

### contract-relist-attempt-atomicity

Owner `component-core-delta`, dimension `failure_recovery`. Requirements FR-005, FR-006,
NFR-003; unit "Orchestrate delta completion over the per-call entered targets".

- `decision-abort-on-listing-failure` — a rejected completion listing makes
  `getChangedPaths()` reject, `runSyncCycleAttempt` aborts the working view, and the durable
  checkpoint is not advanced.
- `decision-replay-recompute` — a subsequent attempt replays the same committed window and
  re-derives the same targets with no persisted recovery marker.
- Observable `observable-checkpoint-unmutated`.
- Invariants: the entered target list is local to the call and never persisted; no recovery
  marker, intent log or second correctness owner; the checkpoint commits only after a wholly
  clean cycle.
- `failure-attempt-aborted` (transient, retry) is the ordinary outcome.
  `failure-partial-delta-published` (internal violation, fail fast) is forbidden under owner
  acceptance.

### contract-relist-cost-bound

Owner `component-core-delta`, dimension `performance_budget`. Requirements NFR-001, FR-003;
units "Orchestrate delta completion over the per-call entered targets" and "Register the
shared scope-entry case across all three families".

- `decision-zero-steady-state` — a warm/hot drain with no entered folder issues zero
  subtree-listing requests.
- `decision-one-walk-per-target` — one topmost entered folder yields exactly one
  declared-operation subtree listing.
- Observable `observable-listing-count`.
- `profile-relist-cost` (`cost_convergence`, workload axis = changed folders in the
  account-wide feed, metric = subtree-listing provider requests per delta cycle, bound =
  count of topmost folders newly entering the bound root, resource cap = no request when
  none enters, measurement `verify-relist-request-count`, witness
  `witness-relist-cost-adversarial`).
- Invariants: listing cost is proportional to the entered subtree, never to whole-drive
  folder activity; a change to an already-cached folder never triggers a listing.
- `failure-account-wide-relist` (internal violation, fail fast) is the regression to remove.

### contract-shared-scope-entry-completeness

Owner `component-contract-harness`, dimension `integration_contract`. Requirements FR-004,
NFR-002; unit "Register the shared scope-entry case across all three families".

- `decision-one-shared-case` — every registered family runs the one shared scope-entry case
  and no family is filtered out.
- `decision-recorded-delta-shape` — a family harness emits its own recorded provider delta
  shape for a move into the root, so the working view must end up holding what a cold scan
  would.
- Observables `observable-scope-entry-set` and `observable-catalog-completeness`.
- Invariants: no skip, optional member or family-filtered module; OneDrive and Dropbox
  production code is unchanged; the exact-set assertion runs through
  list/stat/getChangedPaths only, never the cache.
- `failure-family-opted-out` — internal violation; the catalog completeness check fails.

### contract-provider-delta-completion

Owner `component-backend-api`, dimension `integration_contract`. Requirements FR-004, FR-007,
FR-009; unit "Declare the optional provider delta-completion operation".

- `decision-declare-optional-completion` — a declaring adapter lets core invoke the operation
  for the per-call target set without adding a required member to a backend that does not
  need it.
- `decision-backend-reports-facts` — the module returns the folder's current subtree entries
  or `cursor_invalid`, reading no cache, cursor, scope or store.
- Observables `observable-completion-declaration` and `observable-completion-facts`.
- Invariants: a module reads no metadata cache, cursor, scope or store; OneDrive and Dropbox
  production adapters and request shapes are unchanged; the operation is addressed by
  provider identity, never a derived path.
- `failure-completion-undeclared` (unsupported input, none) means core treats the backend's
  delta as already complete. `failure-completion-boundary-violation` (internal violation,
  fail fast) fails the backend-module-boundary guard.

### contract-module-api-version-evolution

Owner `component-backend-api`, dimension `migration_compatibility`. Requirements FR-009,
NFR-002; unit "Declare the optional provider delta-completion operation".

- `decision-optional-additive-member` — the operation is optional and declared, so a backend
  that omits it remains valid and unchanged.
- `decision-declaration-shape-validated` — a declared-but-malformed member is rejected by
  `validateAdapter` with an `invalid_member` issue before it reaches `ManagedRemoteFs`,
  while a valid omitting adapter is accepted.
- Observable `observable-version-compatibility`.
- `profile-api-evolution` (`contract_evolution`, surface `RemoteBackendAdapter` / Backend
  Module API, consumers `component-googledrive-adapter` and third-party backend modules,
  `backward_compatible`, additive optional migration, same-change rollout, rollback by
  dropping the member, baseline/target `verify-module-compat`, witness
  `witness-evolution-adversarial`).
- Invariants: no required member is forced on a backend that does not need the operation; the
  operation is declared, never silently assumed; the API version stays at 3.
- `failure-silent-omission` and `failure-malformed-declaration-accepted` are internal
  violations that fail fast at registration.

### contract-entered-bookkeeping-lifetime

Owner `component-core-delta`, dimension `concurrency`. Requirements FR-006, NFR-003; unit
"Project entered-folder targets from the shared apply accumulator".

- `decision-discard-with-call` — the entered-folder target set is discarded with the call and
  never read by a later cycle.
- `decision-single-writer` — the set has exactly one writer (the apply seam) and is read once
  by the same call.
- Observable `observable-no-cross-cycle-state`.
- Invariants: exactly two durable publication points remain (the per-file `SyncRecord` and
  the wholly-clean-cycle checkpoint); no new mutable correctness owner is added to
  `SyncOrchestrator`.
- `failure-cross-cycle-owner` — internal violation; the sync-state ownership guard fails.

## Implementation discretion

The contract `contract-entered-target-projection` delegates three private, local, reversible
and mechanically verified interior choices to the projection unit. They preserve the
contract and its observables; none may add a provider request or a durable field.

- `discretion-target-iteration-placement` — inline computation while reading the apply
  accumulator vs. a frozen descriptor projected from `delta-projection`.
- `discretion-target-carrier-shape` — an ordered `Set<string>` snapshot vs. a frozen
  `string[]` in first-entered order.
- `discretion-entered-detection-encoding` — a `!oldPath && isFolder` predicate inside
  `applyEntry` vs. observing that the cache write yielded a path for an id with no resolved
  path immediately before the write.

## Milestones and units

### chunk-core-target-selection

**Project entered-folder targets from the shared apply accumulator** — files
`src/fs/caching/id-delta.ts`, `src/fs/managed/delta-projection.ts`,
`src/fs/caching/id-delta.test.ts`. Surface the per-call entered set from the shared apply
result and discard it with the call. Boundaries: no provider request, durable field or
cross-cycle state; no change to the sort comparator, tombstone branch or moved branch; no
orchestration or merge. Acceptance: the projection surfaces the entered set for the current
call only; `id-delta.test.ts` covers apply-time recording and per-call discard;
`npm run lint:bot-repro` keeps the ownership guards green.

**Declare the optional provider delta-completion operation** — files
`src/backend-api/remote-adapter.ts`, `src/backend-api/module.ts`, `src/backend-api/index.ts`,
`src/fs/modules/validate-module.ts`. Add the optional, declared, typed operation and
validate it additively, including malformed declarations. Boundaries: not required; no core
cache/cursor/scope/store read; no path resolution or merge. Acceptance: a declaring adapter
validates; an omitting adapter also validates; a declared-but-malformed member is rejected;
the typed result is complete entries or `cursor_invalid`; the catalog remains complete.

**Orchestrate delta completion over the per-call entered targets** — files
`src/fs/managed/managed-remote-fs.ts`, `src/fs/managed/delta-projection.ts`. Depends on the
two units above. Drive the declared operation from core: resolve and deduplicate, invoke one
at a time after the drain, merge upsert-only, and translate `cursor_invalid` to the
full-scan fallback. Boundaries: no per-page listing, concurrency or retry layer; no
resolution or merge in the module; no persisted target list. Acceptance: zero invocations on
a no-entry drain; one invocation per remaining topmost target in first-entered order;
nested and unresolved targets dropped in core; `cursor_invalid` yields `needsFullScan` with
no partial delta; a rejected listing aborts before any durable commit.

### chunk-backend-completion-and-contracts

**Implement the Google Drive identity-addressed subtree read** — file
`src/backends/googledrive/adapter.ts`. Depends on the declared operation. Implement the
operation as a pure folder-identity subtree read with a typed complete/`cursor_invalid`
result. Boundaries: no derived-path resolution, no core cache/cursor/scope/store read, no
merge, no retry or concurrency layer, no change to whole-root `listAll()`. Acceptance: one
scoped listing per invocation via `client.listAllFiles(folderId)`; provider entries with no
cache read; a 410 yields `cursor_invalid`; an adapter omitting the operation remains valid.

**Register the shared scope-entry case across all three families** — files
`tests/fs/contracts/caching-remote-fs.contract.ts`,
`tests/fs/contracts/remote-backend-family.ts`,
`tests/fs/remote-backend-contracts.test.ts`,
`tests/fs/googledrive/managed.contract-harness.ts`. Depends on the Google Drive read.
Register the one shared scope-entry case for Google Drive, OneDrive and Dropbox against
their recorded delta shapes, and expose the declared-operation invocation count
deterministically. Boundaries: no skip, optional member or family-filtered module.
Acceptance: `validateRemoteBackendCatalog` returns no issues; all three families run the
case and report the exact set; the harness fake records every declared-operation invocation
so the cost count is deterministic.

**Align the incremental re-list documentation** — files
`src/backends/googledrive/adapter.ts`, `src/backends/googledrive/list-all.ts`. Code-comment
edit only. Acceptance: the adapter class doc no longer claims an account-wide
per-changed-folder re-list; the `list-all.ts` comment no longer cites the removed
incremental-sync walk and names the single entered-folder exception. This unit holds
`decision_closure_reason`: the wording changes no provider fact, decision, owner, observable
effect, failure semantics or compatibility bound.

## Targets and seams

- `ManagedRemoteFs.fetchChanges` is the invocation seam for the completion walk.
- `applyRemoteChanges` / `applyIdDeltaPage` are the apply and merge seams in
  `src/fs/caching/id-delta.ts`.
- `RemoteBackendAdapter` and `validateAdapter` are the API and validation seams.
- `GoogleDriveAdapter.listSubtreeById` over `client.listAllFiles` is the provider read seam;
  the existing client injection is the fake seam for unit tests.
- The shared contract harness fake declares the operation and records every invocation,
  which is the deterministic cost seam.

## Decision dispositions

All planner `decision_inputs` are closed. Adopted decisions are bound by the three ADRs and
the implementation contracts above; the three interior choices are delegated as
`implementation_discretion`; `decision-input-whole-drive-drain` is `not_applicable` because
the whole-drive `changes.list` drain is not changed. `resolved_issues` records the
resolution of the blocker (walk ownership), the FR-008 mechanism, the ADR owner relation,
malformed-declaration validation, the documentation retarget, the harness cost count and the
RED-baseline timing.
