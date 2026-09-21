---
id: adr-20260921-backend-capability-tiered-conditional-mutation
kind: adr
title: Declare provider precondition capability and enforce it to the provider operation
status: accepted
created: '2026-09-21'
updated: '2026-09-21'
decision_makers:
- project owner
consulted:
- review-verdict-all-backends-concurrency
consequences:
  positive:
  - The adapter states, per provider, whether a create, content overwrite, or
    metadata mutation is rejected by the provider on a stale version; `conditionalContentUpdate`
    is `all` | `none`, so a carrier whose condition is checked only at session
    creation (not at commit) is not overclaimed.
  - Every backend that can enforce a precondition now passes the observed version to
    the provider operation (Dropbox `mode:update(rev)` / `mode:add`, OneDrive
    `If-Match` on metadata and `conflictBehavior:fail` on create), so a change inside
    the check-to-use window is rejected by the provider rather than silently overwritten.
  - OneDrive metadata evidence is the item `eTag` alone (metadata + content, returned for
    folders too), so a metadata-only rename/move is a version change and folders are
    guarded; an item that reports no `eTag` fails closed instead of falling back to the
    content-only `cTag`. A real expected token that cannot be re-proven fails closed
    before the mutation.
  - Read proves bytes correspond to the requested version. Dropbox downloads the exact
    `rev`; Google Drive and OneDrive re-observe the version after download and return
    `target_changed` if it moved. An old object can no longer be paired with new bytes.
  - Google Drive version evidence becomes the provider's monotonic `version` for files
    AND directories (a folder rename must still move it), and the resumable upload path
    requests it too.
  - The new required adapter member is reflected in the API version (v2) and validated
    at runtime right after `createAdapter`, so a dynamically loaded module that omits
    `capabilities` or uses a value outside the declared enums is rejected instead of
    silently accepted; an identity-addressed rename carries the observed version like
    every other mutation.
  negative:
  - Google Drive v3 has no documented provider-side CAS for content or metadata
    mutation; the adapter declares those capabilities off (`none`) and keeps the
    compare-before-mutate with post-hoc conflict handling. The residual
    check-to-use race is explicit, not hidden behind a stronger API comment.
  - OneDrive content writes have no precondition that binds the COMMIT: the upload
    session's `If-Match` is checked only when the session is created, and the final
    chunk commits without re-checking it (no documented `deferCommit`-plus-conditional
    commit route was established). `conditionalContentUpdate` is therefore declared
    `none` and content updates compare-before-mutate with the residual window explicit.
    Exclusive create remains provider-enforced by `@microsoft.graph.conflictBehavior`
    in the URL, and the zero-byte mtime PATCH is conditional on the eTag its PUT
    returned.
  neutral:
  - ExpectedVersion stays required on update/move/delete; the adapter still fails closed
    on a mismatch it observed. Capability only marks whether the provider itself closes
    the window.
confirmation: >-
  A new shared adapter-level concurrency contract injects a provider change between
  the metadata read and the download/mutation for all three backends and requires the
  adapter to fail closed (or the provider to reject) with zero overwrite; the existing
  five managed contracts stay green; `npm run lint && npm run lint:bot-repro &&
  npm run build && npm run test:coverage` pass.
decision_bindings:
- src/backend-api/remote-adapter.ts
- src/backend-api/module.ts
- src/fs/modules/validate-module.ts
- src/fs/modules/backend-module-provider.ts
- src/fs/managed/mutation-bridge.ts
- src/fs/managed/managed-remote-fs.ts
- src/fs/dropbox/client.ts
- src/fs/dropbox/adapter.ts
- src/fs/onedrive/client.ts
- src/fs/onedrive/upload-session.ts
- src/fs/onedrive/adapter.ts
- src/fs/googledrive/normalize-object.ts
- src/fs/googledrive/adapter.ts
- tests/fs/contracts/backend-concurrency.contract.ts
source_paths:
- src/backend-api
- src/fs/modules
- src/fs/managed
- src/fs/dropbox
- src/fs/onedrive
- src/fs/googledrive
- tests/fs/contracts
---

# Declare provider precondition capability and enforce it to the provider operation

## Context

The Backend Module API declared strong promises — `VersionBoundReadResult` "a version
mismatch ... is never reported as success", `UpdateFileInput` "`expected` fixes the
source version (no unversioned overwrite)" — but all three adapters compared the
observed version, then issued an unconditional provider operation. The declared
guarantee was not carried to the wire (`review-verdict-all-backends-concurrency`).

Provider facts (verified against primary sources):

- **Dropbox** (`files.stone`): `WriteMode.add` refuses to overwrite, `WriteMode.update(rev)`
  overwrites only when `rev` matches, and `strict_conflict` forces a conflict even on
  identical contents. `files/download` accepts a `rev`. `move_v2`/`delete_v2` carry no
  revision precondition.
- **OneDrive** (Graph v1.0): `PATCH /items/{id}` and `DELETE /items/{id}` accept
  `If-Match` (412 on mismatch); `createUploadSession` accepts `If-Match`/`If-None-Match`
  and `@microsoft.graph.conflictBehavior`.
- **Google Drive** (v3 discovery): `files.update`/`files.delete` expose no version or
  revision precondition, and no HTTP `If-Match` is documented. `files.update` PATCH is
  unconditional; `file.version` is monotonic per server change. `revisions.get`
  (`alt=media`) can download a revision.

A provider-enforced compare-and-set is therefore available for everything except Google
Drive, where it is impossible across all operations. Claiming the same guarantee for all
three is what produced the boundary mismatch.

## Decision

1. The adapter declares `capabilities: RemoteBackendCapabilities` naming, per provider,
   `exclusiveCreate`, `conditionalContentUpdate`, `conditionalMetadataMutation`, and how
   `read()` proves its bytes (`revision` | `reobserve`). The API doc comments state the
   guarantee is provider-enforced only where the capability is `true`; otherwise the
   adapter compares before mutating and fails closed on an observed mismatch, but the
   provider closes no window.
2. Where the capability is `true`, the adapter passes the observed version to the
   provider operation, not just to a local comparison.
3. `read()` must prove bytes belong to the requested version, not merely check the
   version before downloading.
4. Google Drive version evidence becomes the provider's `version`.

This supersedes the "no provider-side precondition" conclusion of the rejected
`adr-20260902-compound-conflict-resolution-and-conditional-mutation`: that proposal was
rejected for trying to require a strong precondition uniformly before any provider
capability was established. Capability declaration is the answer to that objection —
strength where the provider has it, honesty where it does not.

## Rejected alternatives

- **Fail-closed everywhere.** Correct in the abstract, but Google Drive would reject
  every content update, making the backend unusable. The user rejected this explicitly.
- **Weaken the API to best-effort.** Removes the overpromise but also removes the
  enforcement the providers *can* give; Dropbox and OneDrive would keep overwriting.
- **Add HTTP `If-Match` to Google Drive writes.** Undocumented, unverifiable, and not
  guaranteed by the API contract.

## Consequences

See frontmatter. The residual Google Drive race is recorded as an accepted, declared
limitation: the adapter compares the current `version` immediately before the mutation
and the sync engine's fresh-state reconciliation handles a divergence it observes.

## Confirmation

`tests/fs/contracts/backend-concurrency.contract.ts` is registered for all three
managed backends and injects a provider change at the metadata-check/download and
metadata-check/mutation seams.
