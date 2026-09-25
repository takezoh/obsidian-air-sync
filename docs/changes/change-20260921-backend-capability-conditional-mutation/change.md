---
id: change-20260921-backend-capability-conditional-mutation
kind: change
title: Carry provider preconditions to the provider operation and declare capability
status: draft
created: '2026-09-21'
profile: design@1
intent: The Backend Module API promised version-bound reads and no unversioned overwrite, but
  every adapter compared the observed version locally and then issued an unconditional provider
  mutation, and read metadata before an unconditional download. Provider CAS is available for
  Dropbox content writes and all OneDrive mutations, but not for Google Drive at all, so a single
  uniform promise is unachievable. Declare each provider's real precondition capability and enforce
  it to the wire where the provider has it; prove version-bound reads; make Google Drive version
  evidence the provider's monotonic version.
outcomes:
- Each adapter declares `capabilities` with exclusiveCreate, conditionalContentUpdate
  (`all` | `none`), conditionalMetadataMutation, and versionBoundRead.
- Dropbox create uses `WriteMode.add`, update uses `WriteMode.update(rev)` with
  `strict_conflict`, and read downloads the exact `rev`.
- OneDrive version evidence is the full-item `eTag` (metadata + content) for files and
  folders; create is provider-enforced by `conflictBehavior.fail`; move/delete send
  `If-Match`; content updates have no precondition that binds the commit, so
  `conditionalContentUpdate` is declared `none` and content compares-before-mutate (a
  zero-byte write additionally conditions its mtime PATCH on its own PUT's eTag).
- Google Drive and OneDrive reads re-observe the version after download and return
  target_changed when it moved; Google Drive version tokens are the provider's true
  version for files AND directories.
- A shared adapter-level concurrency contract injects content and metadata-only changes,
  guards folder mutation, and asserts the requested revision's exact bytes.
- The adapter capability is runtime-validated at creation and the API version is 2; an
  identity-addressed rename carries the observed version like every other mutation. Every
  adapter rejects an `expected` that names a different object before mutating.
scope:
- src/backend-api/remote-adapter.ts — BackendCapabilities type and adapter field; precise doc comments on the version-bound read and mutation inputs.
- src/backend-api/module.ts — Backend Module API version 2.
- src/backend-api/auth.ts — API v2 doc comment.
- src/backend-api/checksums.ts — API v2 doc comment.
- src/backend-api/errors.ts — API v2 doc comment.
- src/backend-api/json.ts — API v2 doc comment.
- src/backend-api/remote-object.ts — API v2 doc comment.
- src/backend-api/runtime.ts — API v2 doc comment.
- src/backend-api/settings.ts — API v2 doc comment.
- src/backend-api/index.ts — export the capability type and API v2 header.
- src/fs/modules/validate-module.ts — runtime validation of the adapter capabilities.
- src/fs/modules/backend-module-provider.ts — validate the adapter right after createAdapter.
- src/fs/modules/backend-module-provider.test.ts — capability on the stub adapter and the prepare() rejection wiring.
- src/fs/interface.ts — IdentityAddressedRename carries the admitted source path.
- src/fs/managed/mutation-bridge.ts — carry the observed version on identity-addressed rename.
- src/sync/plan-executor.ts — pass the admitted old path to renameById.
- src/sync/plan-executor.test.ts — assert the admitted path reaches the capability.
- src/sync/orchestrator.test.ts — assert the admitted path reaches the capability.
- tests/fs/contracts/caching-remote-fs.contract.ts — pass the admitted path to renameById.
- docs/design/design-backend-module-api.md — the API reference is v2 and defines the adapter capabilities.
- docs/design/design-remote-backend-implementation-contract.md — the boundary section names API v2 and the per-backend version evidence.
- ARCHITECTURE.md — the boundary section names API v2.
- docs/adr/adr-20260920-backend-module-boundary.md — the boundary ADR names v2.
- src/fs/managed/managed-remote-fs.ts — version-bound read helper and priority outcome.
- src/fs/caching/detached-priority.ts — DetachedReadOutcome; priority read returns a typed change outcome.
- src/fs/caching/remote-fs.ts — downloadForPriority seam.
- src/fs/caching/metadata-cache.ts — exact-id object query for merged-folder delete.
- src/fs/dropbox/client.ts — upload mode parameter; download rev.
- src/fs/dropbox/client.test.ts — wire assertions for add/update(rev)/strict_conflict/rev.
- src/fs/dropbox/adapter.ts — capability, exclusive/conditional content writes, rev read, expected-evidence guard.
- src/fs/onedrive/normalize-object.ts — version evidence is the full-item eTag.
- src/fs/onedrive/client.ts — precondition/conflict-behaviour on upload, simple zero-byte path, conditional mtime PATCH, move/delete If-Match.
- src/fs/onedrive/upload-session.ts — carry If-Match/If-None-Match and conflict behaviour.
- src/fs/onedrive/adapter.ts — capability, conditional writes, reobserve read, metadata guard.
- src/fs/onedrive/client.test.ts — wire assertions for zero-byte, session preconditions, move/delete If-Match.
- src/fs/googledrive/normalize-object.ts — version token from provider `version` for files and directories.
- src/fs/googledrive/resumable-upload.ts — request `version` in the resumable create fields.
- src/fs/googledrive/adapter.ts — capability, reobserve read, expected-evidence guard.
- src/fs/googledrive/client.test.ts — resumable fields include version.
- tests/backend-api/fake-module.ts — capability on the compile fixture.
- tests/backend-api/validate-module.test.ts — adapter capability validation cases.
- tests/backend-api/api-contract.test.ts — pin API version 2.
- backend-module-boundary-guard.test.mjs — boundary guard header names API v2.
- tests/fs/managed/managed-remote-fs.test.ts — identity rename carries expected.
- tests/fs/managed/fake-adapter.ts — capability on the test double.
- tests/fs/contracts/backend-concurrency.contract.ts — shared adapter-level concurrency contract.
- tests/fs/contracts/remote-backend-family.ts — register the fifth contract kind.
- tests/fs/remote-backend-contracts.test.ts — central required-contract matrix.
- tests/fs/dropbox/managed.contract-harness.ts — concurrency harness + race hooks.
- tests/fs/googledrive/managed.contract-harness.ts — concurrency harness + version model.
- tests/fs/onedrive/managed.contract-harness.ts — concurrency harness, eTag/cTag model, metadata-only race.
- AGENTS.md — shared contract count moves from four to five.
- docs/code-enforcement.md — the remote-backend completeness rule names the fifth contract.
- eslint.config.mts — re-pin the remote-fs and dropbox adapter line caps.
- docs/adr/adr-20260921-backend-capability-tiered-conditional-mutation.md — the decision record.
- src/sync/change-detector.ts — pre-existing worktree change carried by the branch; declared so the change surface is closed, not authored here.
- src/sync/change-detector.test.ts — pre-existing worktree change carried by the branch; declared so the change surface is closed, not authored here.
non_goals:
- A provider-side CAS for Google Drive. It does not exist in v3; the adapter declares it absent.
- Persisting retry, recovery, or conflict markers, or adding a recovery queue.
- Changing the sync engine's fresh-state reconciliation or Admission.
- Migrations; settings or IndexedDB schema are untouched.
- Unrelated pre-existing worktree changes (src/fs/local, src/main.ts, src/sync/change-detector.ts, src/sync/sync-cycle-diagnostics.ts, e2e/bench, tests/bench) that predate this change.
change_classes:
- behavior
- boundary
- failure_semantics
governance:
  gate: hard
  reasons:
  - Widens the public Backend Module API with a required adapter capability, binding every module
    and every test double at once.
  - Changes provider write calls on the sync-critical path for all three backends.
  approval_evidence: Provider capabilities were verified against files.stone, the Graph v1.0
    reference, and the Drive v3 discovery document; the owner selected the capability-tier route.
members:
  requirements: requirements.md
  design: design-plan/design.md
  implementation: implementation.md
  verification: verification.md
promotion: []
promotion_applied_at: null
unresolved_decisions:
- Whether the sync engine should branch on a declared capability, or only the adapter enforces it
  and tests assert the declaration. This change takes the latter and keeps core unchanged.
---

# Carry provider preconditions to the provider operation and declare capability

See `design-plan/design.md` for the implementation contract and
`docs/adr/adr-20260921-backend-capability-tiered-conditional-mutation.md` for the decision.
