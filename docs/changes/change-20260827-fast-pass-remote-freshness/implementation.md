---
change: change-20260827-fast-pass-remote-freshness
role: implementation
contracts:
- contract-detached-targeted-observation
- contract-cooperative-priority-safe-point
- contract-path-mutation-cas
contract_projections:
- id: contract-detached-targeted-observation
  verifications:
  - verify-detached-no-mutation
  - verify-authoritative-ancestry
  - verify-provider-observation-parity
  - verify-live-provider-fidelity
  discretion: []
- id: contract-cooperative-priority-safe-point
  verifications:
  - verify-priority-linearization
  - verify-current-action-only
  - verify-finalization-safe-point
  - verify-coordinator-liveness
  discretion:
  - discretion-priority-waiter-container
- id: contract-path-mutation-cas
  verifications:
  - verify-priority-cas
  - verify-normal-action-replan
  - verify-typed-handoff
  - verify-content-equal-convergence
  discretion: []
adrs:
- adr-0001-commit-last
- adr-0002-shared-backend-contracts
- adr-0006-order-independent-rename
- adr-0008-logical-identity-admission
- adr-20260827-file-open-fast-pass-preserves-remote-change-batches
decision_dispositions:
- decision_input_ref: decision-input-global-batch-handoff
  disposition: rejected — file-open must not consume the global cursor; deleting the
    handoff also removes accumulator, COLD, reset-reporting, and capacity policy.
  adr_refs:
  - adr-0001-commit-last
  - adr-20260827-file-open-fast-pass-preserves-remote-change-batches
  contract_refs:
  - contract-detached-targeted-observation
- decision_input_ref: decision-input-detached-observation
  disposition: adopted — identity-addressed authoritative provider observation and
    token-bound read preserve the later global batch by construction.
  adr_refs:
  - adr-0002-shared-backend-contracts
  - adr-0008-logical-identity-admission
  - adr-20260827-file-open-fast-pass-preserves-remote-change-batches
  contract_refs:
  - contract-detached-targeted-observation
- decision_input_ref: decision-input-whole-batch-mutex
  disposition: rejected for priority ordering — it serializes safely but places file-open
    behind the full in-flight batch.
  adr_refs:
  - adr-20260827-file-open-fast-pass-preserves-remote-change-batches
  contract_refs:
  - contract-cooperative-priority-safe-point
- decision_input_ref: decision-input-priority-safe-point
  disposition: adopted — a batch lease stops new action starts, waits only for already-started
    indivisible actions, drains priority, and rechecks before finalization.
  adr_refs:
  - adr-0001-commit-last
  - adr-20260827-file-open-fast-pass-preserves-remote-change-batches
  contract_refs:
  - contract-cooperative-priority-safe-point
- decision_input_ref: decision-input-action-cas
  disposition: adopted — expected SyncRecord/local/tracker/remote stamps, the Air
    Sync mutation lease, exact acknowledgement, and admission-time replan close the
    reviewed wait/provider-I/O edit race and prevent stale batch overwrite without
    claiming external-write atomicity.
  adr_refs:
  - adr-0001-commit-last
  - adr-0008-logical-identity-admission
  - adr-20260827-file-open-fast-pass-preserves-remote-change-batches
  contract_refs:
  - contract-path-mutation-cas
- decision_input_ref: decision-input-live-provider-evidence
  disposition: supplemental evidence — token fields and per-request fail-closed semantics
    are fixed by mandatory shared fake/contract tests; credential-gated live point-read/ancestry/token/read-reobserve
    runs are optional, non-gating observations with no receipt or provider-state lifecycle.
  adr_refs:
  - adr-0002-shared-backend-contracts
  contract_refs:
  - contract-detached-targeted-observation
milestones:
- id: chunk-1
- id: chunk-2
- id: chunk-3
- id: chunk-4
reference_algorithms: []
---
# Implementation — detached observation, priority safe point, and mutation CAS

## Design seams

### Detached observation seam

Replace `statFresh` with a provider-neutral priority capability that accepts normalized
path plus the baseline remote identity. Its result is a discriminated union containing
authoritative relative path/root proof, entity metadata, and an opaque version token.
The bound read must either use a provider conditional read or reobserve after reading and
return success only when the final token is equal.

The capability must not call initialization, cache restoration, global delta replay,
cache setters, root-anchor setters, or checkpoint methods. Dropbox builds a request-local
root descriptor by point-reading current metadata with the live `DropboxFs` instance's
inherited `CachingRemoteFs.rootFolderId`. The existing producer chain is
`src/fs/dropbox/provider-base.ts::DropboxBackendData.remoteVaultFolderId` (typed
`settings.backendData.remoteVaultFolderId`) →
`src/fs/pkce-app-folder-provider.ts::PkceAppFolderProvider.createFs` →
`src/fs/dropbox/index.ts::DropboxFs` inheriting
`src/fs/caching/remote-fs.ts::CachingRemoteFs.rootFolderId`; no new
setting, record, receipt, cache anchor, or durable authority is introduced. A same-id root
rename only changes the stripped absolute prefix and leaves the child vault-relative path
unchanged; missing/malformed root identity, root-id mismatch, outside-root, or ambiguous
ancestry is `unverifiable`/`structural`. The shared mutable cache root path is neither read
nor written. Google Drive and OneDrive fetch enough current parent metadata to prove one
complete chain to the configured root.

Provider fields are normative. Google Drive observes id/parents/name/type/trashed plus
numeric `version`, md5/size/mtime. Dropbox observes id/`rev`/content hash/size and treats
unequal revisions as opaque. OneDrive observes id/parents plus `cTag`, quickXor/size and
uses `eTag` only for opaque equality fallback. Missing fields fail closed. Fake contracts
are mandatory and fix response shape, required-field validation, token equality/order,
authoritative ancestry, read/reobserve, and the no-global-mutation partition for all
three providers. Missing, empty, non-numeric where numeric is required, or otherwise
malformed token/identity/ancestry fields return `unverifiable` for that request.
Credential-gated live E2E remains an optional, non-gating fidelity suite and produces no
release/runtime enablement receipt or permanent backend state.

### Priority safe-point seam

Introduce an orchestrator-owned `PriorityCoordinator`. A `BatchLease` covers global
capture, planning, action execution, and finalization but does not exclude detached
provider observation for the whole batch. The coordinator atomically owns pending paths,
active normal-action permits, safe-point drainer election, invalidations, and lease seal.

Executor pools request a permit immediately before starting an action. If priority is
pending they stop admitting new work. Existing permits finish and release; at zero active
permits the elected drainer completes queued priority attempts. Finalization requests the
same safe point and seals only with no active action, pending priority, or unresolved
invalidation. Phase barriers and transfer concurrency remain otherwise unchanged.

After the final enqueue, the work bound is: settle at most the existing pool-concurrency
permits, settle one attempt per distinct pending path, then perform one resume/seal
transition. Continuous arrivals intentionally keep strict priority. The coordinator
coalesces duplicate paths, reports active/pending/coalesced/completed/cancelled and oldest
pending age through existing diagnostics, and retires every permit, node, waiter, and
invalidation exactly once in `finally`.

### Mutation CAS seam

Both priority and normal actions carry immutable stamps:

- record fingerprint or expected absence;
- local path/entity/content key/mtime/size and tracker generation;
- remote stable identity, authoritative path, provider version/content token;
- for normal work, frozen batch generation and remote evidence.

Priority validates before provider I/O and immediately before local write. Baseline save
uses record compare-and-put. Tracker acknowledgement identifies the exact self-write
generation and occurs only after record persistence plus post-write tracker/content
observation; later or different edit evidence remains dirty.

Add an orchestrator-owned path-local
mutation barrier shared by every Air Sync `LocalFs.write` (including conflict and
rename-copy writes) and every `LocalChangeTracker` mark/acknowledgement transition. Hold
its lease across final record/local/tracker validation, `LocalFs.write`, record CAS,
post-write tracker/content observation, and exact self-write acknowledgement. An edit
observed by final validation aborts as `local_changed`. An edit observed during or after
the write cannot match the exact self-write generation/content, is not acknowledged, and
remains dirty for normal Admission. Priority ordering plus this last lease-held
revalidation closes the long queue/provider-I/O check-use race.

The lease serializes Air Sync participants only. It neither requires nor claims atomic
exclusion of editor/other-plugin adapter writes. A truly simultaneous external write
after the Air Sync mutation linearization point has the same ordering limitation as an
existing normal sync write; implementation and tests must state that limitation rather
than inventing an unavailable platform fence.

Every normal action validates at permit admission. On mismatch it reruns existing path
decision logic with current record/local and the frozen batch remote entity. Exact
priority-applied content becomes `match`/no-op. Frozen V1 versus current persisted V2 is
terminal `superseded`/no-op when provider numeric order or the active lease's exact
priority-application receipt proves V1 older; V1 never re-enters the ordinary rule as a
pull. Unordered remote versions, changed structural endpoints, or unprovable input
produce deferred stale-plan failure and block a clean checkpoint.

## Typed result and handoff

Priority results are `applied`, `not_eligible`, `local_changed`, `unchanged`,
`structural`, `superseded`, `auth`, `rate_limited`, `provider_failure`, `read_failure`,
`write_failure`, `applied_unbaselined`, and `target_changed`.

Scheduler awaits and maps results to current user notification/logging policy. It does
not catch all errors into success. Authoritative changed/structural outcomes not applied
register an active-lease invalidation or request the existing normal trigger. A failed
record save leaves tracker evidence. The existing normal detector handles restart by
selecting an exact non-directory entry with a baseline, both sides changed, equal size,
and incomparable content proof; it reads local and remote bytes once, hashes both with
SHA-256, and supplies equality to the normal decision engine. Failure/inequality remains
conflict. Exact scope is `src/sync/change-detector.ts`,
`src/sync/change-hash-enrichment.ts`, `src/sync/change-detector.test.ts`,
`src/sync/decision-engine.ts`, and `src/sync/decision-engine.test.ts`. There is no marker,
priority token after restart, or dedicated partial-baseline session state.

## Dependency-ordered units

1. Define detached types/capability and shared no-mutation contract.
2. Implement authoritative provider observations and token-bound reads.
3. Add batch lease/coordinator and executor action-admission safe points.
4. Add record/local/tracker/remote stamps, replan, typed scheduler handoff, finalizer
   integration, docs, and full gate.

## Declared repository scope

The implementation may change only these repository-relative paths (new test/type files
are explicitly listed):

- `src/fs/interface.ts`
- `src/fs/priority-observation.ts`
- `src/fs/caching/remote-fs.ts`
- `src/fs/caching/remote-fs.contract.test.ts`
- `src/fs/googledrive/index.ts`
- `src/fs/googledrive/client.ts`
- `src/fs/googledrive/client.test.ts`
- `src/fs/googledrive/types.ts`
- `src/fs/googledrive/types.test.ts`
- `src/fs/googledrive/targeted-observation.test.ts`
- `src/fs/dropbox/index.ts`
- `src/fs/dropbox/targeted-observation.test.ts`
- `src/fs/onedrive/index.ts`
- `src/fs/onedrive/types.ts`
- `src/fs/onedrive/types.test.ts`
- `src/fs/onedrive/targeted-observation.test.ts`
- `src/sync/priority-coordinator.ts`
- `src/sync/priority-coordinator.test.ts`
- `src/sync/plan-executor.ts`
- `src/sync/plan-executor.test.ts`
- `src/sync/orchestrator.ts`
- `src/sync/orchestrator.test.ts`
- `src/sync/scheduler.ts`
- `src/sync/scheduler.test.ts`
- `src/sync/state.ts`
- `src/sync/state.test.ts`
- `src/sync/local-tracker.ts`
- `src/sync/local-tracker.test.ts`
- `src/sync/local-mutation-barrier.ts`
- `src/sync/local-mutation-barrier.test.ts`
- `src/fs/local/index.ts`
- `src/fs/local/local-fs.test.ts`
- `src/main.ts`
- `src/sync/change-detector.ts`
- `src/sync/change-detector.test.ts`
- `src/sync/change-hash-enrichment.ts`
- `src/sync/decision-engine.ts`
- `src/sync/decision-engine.test.ts`
- `src/sync/sync-cycle-finalization.ts`
- `src/sync/sync-cycle-finalization.test.ts`
- `docs/sync-pipeline.md`
- `docs/adr/adr-20260827-file-open-fast-pass-preserves-remote-change-batches.md`

Other provider client files remain outside scope. The listed Google client/type changes
are required to request/type numeric `version`; OneDrive type changes add `cTag`/`eTag`.
Dropbox already carries `rev` and content hash. Any further client expansion must be
escalated before editing.

## Removed scope

Do not implement `contract-remote-batch-handoff`,
`contract-checkpoint-reset-parity`, or `contract-partial-baseline-recovery`. Remove the
old `statFresh` shared-cache mutation path. Do not add remote batch accumulators, count/
byte thresholds, new reset content reporting, a file-open COLD marker, or baseline-only
retry state.

## Implementation discretion

Only the private waiter container is discretionary. Provider response token fields,
ordering/equality semantics, missing/malformed per-request fail-closed behavior,
path-local write boundary, one pending node per path, authoritative ancestry,
no-global-mutation, exact stamp validation, failure types, and checkpoint blocking are
normative and covered by mandatory shared fake/contract tests. Any need to consume delta,
mutate shared root/cache, persist queue state, relax stale-action replan, claim overwrite
safety outside the scoped Air Sync ordering guarantee, or make release/runtime capability
depend on optional live-E2E evidence requires escalation. External adapter atomicity must
not be claimed.
