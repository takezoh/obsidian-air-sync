---
change: change-20260904-remote-working-view-abort
role: implementation
contracts:
- contract-working-view-lifecycle
- contract-cycle-closeout
- contract-fatal-settlement
- contract-temperature-convergence
- contract-provider-replay
contract_projections:
- id: contract-working-view-lifecycle
  verifications:
  - verify-working-view-abort
  - verify-durable-query-fallback
  - verify-commit-failure-scope
  - verify-reset-separation
  discretion: []
- id: contract-cycle-closeout
  verifications:
  - verify-returned-partition
  - verify-exception-order
  - verify-post-closeout-exclusion
  - verify-no-capability
  discretion: []
- id: contract-fatal-settlement
  verifications:
  - verify-auth-fatal-settlement
  - verify-invariant-fatal-settlement
  - verify-mixed-rejection-identity
  - verify-no-later-work
  discretion: []
- id: contract-temperature-convergence
  verifications:
  - verify-cold-convergence
  - verify-warm-convergence
  - verify-hot-convergence
  - verify-read-failure-cold
  discretion: []
- id: contract-provider-replay
  verifications:
  - verify-three-provider-registration
  - verify-provider-same-instance-replay
  - verify-provider-folder-rename
  - verify-provider-arbitrary-prefix
  discretion: []
adrs:
- adr-remote-working-view-abort-boundary
decision_dispositions:
- decision_input_ref: decision-input-user-no-special-recovery
  disposition: Accepted; incomplete attempts rebuild from durable and current facts
    after checkpoint-owned abort, with no history-dependent recovery branch.
  adr_refs:
  - adr-remote-working-view-abort-boundary
  contract_refs:
  - contract-cycle-closeout
  - contract-temperature-convergence
- decision_input_ref: decision-input-commit-last
  disposition: Retained; abort performs no persistence, clean cursor/cache/scope commit
    remains atomic, and successful per-file records remain independently valid.
  adr_refs:
  - adr-remote-working-view-abort-boundary
  contract_refs:
  - contract-working-view-lifecycle
  - contract-cycle-closeout
- decision_input_ref: decision-input-explicit-abort-api
  disposition: Selected as the smallest coherent boundary because IncrementalCheckpoint
    already owns the live fields, mutex, store, commit, and reset.
  adr_refs:
  - adr-remote-working-view-abort-boundary
  contract_refs:
  - contract-working-view-lifecycle
- decision_input_ref: decision-input-implicit-alternatives
  disposition: Rejected reset, filesystem reconstruction, copy-on-write, acquisition
    rollback, and implicit destructor alternatives because they destroy durable data,
    widen ownership, add state, or cannot observe the final cycle result.
  adr_refs:
  - adr-remote-working-view-abort-boundary
- decision_input_ref: issue-fatal-class-abort-gap
  disposition: Resolved; the complete cycle-fatal set is exactly AuthError and InternalFreshInvariantError
    and both enter the existing aborting phase.
  contract_refs:
  - contract-fatal-settlement
- decision_input_ref: issue-provider-partial-delta-overreach
  disposition: Resolved provider-neutrally; failure may leave any live prefix including
    none, and all providers must invalidate and replay the whole working view.
  contract_refs:
  - contract-provider-replay
- decision_input_ref: issue-error-precedence-untraced
  disposition: Resolved by retaining each existing Promise.all as rejection selector
    and rethrowing its exact captured reason only after sibling settlement.
  contract_refs:
  - contract-fatal-settlement
- decision_input_ref: issue-committed-query-read-error-gap
  disposition: Resolved by the latest governing decision; durable read failure conservatively
    returns false or null and selects ordinary COLD without new state.
  contract_refs:
  - contract-working-view-lifecycle
  - contract-temperature-convergence
- decision_input_ref: decision-input-provider-registration
  disposition: Resolved by the central composition root; Google Drive, Dropbox, and
    OneDrive register the same shared caching contract.
  contract_refs:
  - contract-provider-replay
- decision_input_ref: decision-input-provider-partial-delta
  disposition: Kept abstract; no provider-specific page-application timing is promoted
    without source authority.
  contract_refs:
  - contract-provider-replay
milestones:
- id: checkpoint-api-and-contract
- id: executor-fence
- id: orchestrator-boundary
- id: documentation-and-verification
reference_algorithms: []
---

<!-- lifecycle is owned by change.md -->

# Implementation

## Fixed contracts

- `IncrementalCheckpoint` gains required `abortWorkingView(): Promise<void>`. Capability absence remains the only representation of a filesystem with no checkpoint lifecycle.
- `CachingRemoteFs.abortWorkingView` acquires `cacheMutex`, clears the existing cache, `_changesPageToken`, `_scopeFingerprint`, and `initialized`, and touches neither `MetadataStore` nor the provider. It is idempotent and adds no field.
- `hasCheckpoint` and `getScopeFingerprint` read `MetadataStore` rather than live fields. Missing store/key or read failure returns `false`/`null`. `commitCheckpoint` supplies the candidate scope to the atomic save and publishes no live scope candidate before success.
- `finalizeSyncCycle` owns the returned-outcome choice: safe means commit; every unsafe result means abort. Commit rejection is followed by abort before retry/error classification.
- Attempt exceptions abort before the existing retry decision. Post-closeout `readBackendState`/`saveSettings` errors use the existing classifier without another abort. An internal abort failure propagates, leaves the boundary unclosed, and must not be treated as a successful retry.
- Cycle-fatal action classes remain exactly `AuthError` and `InternalFreshInvariantError`. Both invoke the existing active-batch abort transition before rethrowing the same object; all current nonfatal errors remain `failed`/`blocked` values.
- At each current `Promise.all` boundary, that original aggregate remains the rejection selector. The executor captures its exact rejection object, awaits `Promise.allSettled` for all promises already scheduled in the join, then rethrows the captured object. No AuthError-first, input-order, or new precedence rule is introduced.
- `recoverViaColdScan`, `needsColdRecovery`, and all assignments/comments that make prior failure an acquisition input are removed. No replacement outcome fact or orchestrator field is added.

## Dependency-ordered units

1. **Checkpoint lifecycle and shared contract**
   - Files: `src/fs/interface.ts`, `src/fs/caching/remote-fs.ts`, `src/store/metadata-store.ts`, checkpoint test doubles, `tests/fs/contracts/caching-remote-fs.contract.ts`, and the three provider caching harnesses.
   - Add the required abort API, durable-only getters with `false/null` fallback, commit-success-only scope publication, and discriminating replay/fresh-scan/pagination/folder-rename tests.
   - Do not change store schema/version, provider APIs, or `resetCheckpoint` semantics.

2. **Executor settlement fence**
   - Files: `src/sync/plan-executor.ts`, `src/sync/priority-batch-state.ts`, and focused tests.
   - Extend the existing fatal callback to both current fatal classes; invalidate queued work through the existing `aborting` phase; preserve each current `Promise.all` as error selector while separately awaiting scheduled sibling settlement.
   - Do not change pool limits, per-action retry classification, phase order, or already-started effect/per-file commit behavior.

3. **Cycle commit-or-abort integration**
   - Files: `src/sync/sync-cycle-finalization.ts`, `src/sync/orchestrator.ts`, `src/sync/change-detector.ts`, their tests, and the ownership guard fixture.
   - Make returned finalization exhaustive; abort exceptional attempts before classification/retry; structurally exclude post-closeout settings failures from a second abort; remove the recovery field and predicate.
   - Preserve priority finalizer serialization, tracker acknowledgment, notifications, retry count/backoff, and explicit Rescan.

4. **Architecture and full verification**
   - Files: `docs/adr/0001-metadata-cache-is-subordinate-to-commit-last.md`, `docs/sync-pipeline.md`, `AGENTS.md`, `docs/code-enforcement.md`, the central provider registry, and ownership guards.
   - Revise ADR 0001 in place: same-session convergence now follows from attempt-bounded working-view abort and ordinary reconstruction, while the two durable authorities and commit rules remain unchanged.
   - Verify the exact Google Drive, Dropbox, and OneDrive registrations and run the full repository gate.

## Implementation discretion

Private helper names and whether the settlement wrapper is expressed once or inlined are discretionary. They must preserve the original aggregate rejection object and cover every nested parallel join. Escalate any proposal that changes provider interfaces beyond the required checkpoint method, error classification/precedence, pool scheduling, persistent schema, checkpoint/reset ownership, or per-file commit timing.
