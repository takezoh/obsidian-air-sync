---
id: design-remote-backend-implementation-contract
kind: design
title: Remote backend implementation contract
status: active
created: '2026-09-15'
scope_type: area
responsibilities: []
invariants: []
boundaries:
  provides: []
  consumes: []
  forbidden: []
variability:
  fixed: []
  free: []
capabilities: []
failure_responsibilities: []
trust_boundaries: []
compatibility_policies: []
tags: []
owners: []
relations:
- {type: references, target: note-20260915-pcloud-backend-investigation}
- {type: references, target: note-20260915-cloud-backend-qualification}
source_paths:
- src/fs/interface.ts
- src/fs/backend.ts
- src/fs/types.ts
- src/fs/caching/remote-fs.ts
- src/fs/caching/metadata-cache.ts
- src/fs/priority-observation.ts
- src/fs/registry.ts
- tests/fs/contracts/remote-backend-family.ts
- tests/fs/contracts/remote-change-detection.contract.ts
- tests/fs/remote-backend-contracts.test.ts
summary: Normative requirements and verification obligations for adding an Air Sync
  remote backend.
---

## Purpose

Define the minimum provider capabilities, Air Sync integration responsibilities, and
verification evidence required for a remote storage service to become a supported
backend. This document is a qualification contract: an API being able to upload and
download files is not sufficient. A backend is implementable only when it can preserve
the sync engine's identity, topology, change-detection, crash-safety, and no-clobber
semantics through the existing backend boundaries.

The change-detection objective is to decide whether current local and remote file bytes
differ without downloading the remote file body. Remote metadata must therefore expose
a content checksum that Air Sync can recompute from the local bytes; provider versions,
opaque hashes, timestamps, and sizes are supplemental evidence rather than substitutes.
This prohibition applies to content comparison: an admitted pull, conflict capture, or
other operation whose purpose is to consume the remote bytes may still download them.

`MUST`, `SHOULD`, and `MAY` are normative. A requirement is satisfied by observable
behaviour, not by using the same provider API or internal class layout as an existing
backend.

The current production reference families are Google Drive, Dropbox, and OneDrive. The
[archived pCloud investigation](../note/note-20260915-pcloud-backend-investigation.md)
records a rejected candidate and is evidence for this qualification boundary, not an
additional source of authority over the current interfaces and shared contracts.

## Support policy

Air Sync is a non-commercial OSS project with finite maintenance capacity. Supported
backends MUST be limited to major cloud storage services with broad personal adoption
that also satisfy this implementation contract. Current support is limited to **Google
Drive, OneDrive, and Dropbox**. iCloud Drive belongs to the major personal-service group,
but is not supported because it does not meet the current integration requirements.

Product selection and technical qualification are separate gates. Technical feasibility,
an available SDK, a contribution, or a large registered-account count does not alone
justify adding a maintained backend. Personal adoption is a qualitative product selection
criterion, not a claimed numerical market-share ranking; registration counts, paid seats,
active users, and ecosystem-wide accounts are not interchangeable measurements.

The [consolidated investigation](../note/note-20260915-cloud-backend-qualification.md)
records supported services, known technical failures, unresolved qualification evidence,
and exclusions based on maintenance scope. An unverified candidate MUST NOT be described
as technically impossible, and a policy exclusion MUST NOT be described as a failed
contract test. Investigated candidates are not a roadmap commitment.

Built-in integration evaluation assumes a web-based authorization experience. Hosted
exchange is allowed, but does not establish that a provider offers a suitable grant,
acceptable scope, or safe key handoff. This policy does not change the existing providers'
auth routes or permit proxying vault data through an auth service. Plugin-side operations
remain subject to RB-SVC-007/008 and RB-PROV-003/006.

Adding support requires an explicit maintenance-scope decision, concrete evidence for
every service prerequisite, and the full Conformance evidence below. Reconsider a
candidate when its relevant API/access model changes and the maintenance/adoption case
justifies it; do not weaken checksum, delta, permission, or mobile requirements to expand
the provider list.

## Responsibilities

### Service qualification

A service is a viable backend target only if all hard prerequisites below can be met.
Emulation is acceptable where the resulting public behaviour is indistinguishable and
does not weaken failure safety.

| ID | Hard prerequisite | Why Air Sync needs it |
|---|---|---|
| RB-SVC-001 | A vault can be bound to one bounded remote root, and every operation can be confined to that root and its descendants. | Prevents account-wide observations or mutations from escaping the selected vault. |
| RB-SVC-002 | Every file and folder has an opaque identity stable across rename/move within the bound root; deleting and recreating an item at the same path yields a different identity. | Admission uses identity to distinguish movement from replacement and to preserve case-only rename continuity. |
| RB-SVC-003 | The API can completely enumerate the bound subtree and can distinguish an empty live root from a deleted, trashed, inaccessible, or wrong root. | A false empty list could otherwise authorize mass local deletion during COLD reconciliation. |
| RB-SVC-004 | The API supports byte-exact read and write, recursive directory creation, recursive removal, and identity-preserving rename/move without overwriting an occupied destination. | These are the observable `IFileSystem` mutation semantics. Copy-delete is not an identity-preserving rename. |
| RB-SVC-005 | Current metadata can identify file versus directory, byte size, provider spelling/topology, and a version signal sufficient to prove whether a detached read still refers to the observed version. | The pipeline needs complete current facts; foreground priority reads must fail closed on races. |
| RB-SVC-006 | For every synchronizable regular file, the service exposes a content checksum without downloading the file body. Its documented algorithm and representation can be reproduced from the local file bytes. The checksum may come from listing/stat/delta metadata or a dedicated metadata/checksum request. | Air Sync must prove whether current local and remote bytes differ without downloading the remote content. Provider-only version ids, opaque hashes, mtime, and size cannot prove cross-side byte equality. |
| RB-SVC-007 | Authentication and authorization can be implemented without shipping a confidential client secret in the plugin, and credentials can be removed locally on disconnect. | Air Sync is a distributed mobile-capable client and stores secrets only in Obsidian SecretStorage. |
| RB-SVC-008 | All production network operations are possible through Obsidian `requestUrl()` and browser-compatible APIs. | Shipped code cannot depend on Node, Electron, `fetch`, a background daemon, or an SDK that requires any of them. |
| RB-SVC-009 | The acceptable production authorization mode exposes a replayable incremental change feed with a durable cursor/token. It reports creates, content/metadata changes, deletes, and rename/move evidence completely enough to update the bound-root view. | Delta-first operation is a supported-backend requirement. Re-listing the complete vault on every ordinary cycle is not an accepted substitute. |
| RB-SVC-010 | The provider distinguishes byte-backed files that support byte-exact read/write and RB-SVC-006 from provider-native or otherwise unsupported objects. Unsupported objects can be excluded from the remote sync view or rejected as unverifiable before Admission; they are never projected as an ordinary file with incomplete content evidence. | Treating a non-downloadable or checksum-less object as a regular file would turn an unsupported provider type into a false match, conflict, or destructive action. |

The incremental feed MAY be natively scoped to the bound root or account-wide and
filtered by the backend, but its required permission scope must itself be acceptable for
Air Sync. Account-wide access is not justified solely to obtain a feed when the product's
intended least-privilege mode cannot expose one. The feed and the full checkpoint
lifecycle travel together; a partial delta capability or an empty-cursor steady-state
COLD loop is forbidden for a supported backend.

### Reference implementation evidence

The production backends all separate a locally reproducible content checksum from a
provider version token:

| Backend | No-download checksum projected to `remoteChecksum` | Detached version evidence |
|---|---|---|
| Google Drive | `md5Checksum` as `md5` | `md5Checksum` plus size; provider `version` is retained as metadata |
| Dropbox | `content_hash` as the locally implemented `dropbox` algorithm | `rev` |
| OneDrive | `quickXorHash` as the locally implemented `quickxor` algorithm | `cTag` or `eTag` |

Their remote projections leave `FileEntity.hash` empty and carry the provider checksum
separately. [`enrichHashesForInitialMatch()`](../../src/sync/change-hash-enrichment.ts)
then reads only the local file, computes the advertised remote algorithm, and compares
it with `remoteChecksum`. This is the required direction of comparison. A provider
version token may bind a later read to the observation, but is not a content digest.
Google Drive native Workspace objects do not expose `md5Checksum`; they therefore cannot
be counted as synchronizable byte-backed files under RB-SVC-010.

### Filesystem implementation

RB-FS-001 — The backend MUST implement [`IFileSystem`](../../src/fs/interface.ts) with
the following path model:

- paths are relative to the bound root, use `/`, and have no leading or trailing slash;
- all inputs are normalized consistently;
- `list()` is recursive, `listDir()` returns direct children only, and both return
  snapshots rather than mutable backend state;
- `stat()` returns `null` only for authoritative absence, and `read()` returns a detached
  `ArrayBuffer`;
- `write()` creates parents, does not alias the caller's buffer, rejects an existing
  directory, and returns the entity actually produced;
- `mkdir()` is idempotent for a directory and rejects every file/directory type
  collision;
- `delete()` is recursively idempotent and does not affect prefix-sharing siblings;
- `rename()` creates parents, preserves item identity, rejects missing sources,
  self/subtree moves, and occupied destinations, and never silently clobbers.

Exact error messages and edge cases are owned by the shared filesystem contract; this
summary does not replace it.

RB-FS-002 — Every observed remote entity MUST project a truthful
[`FileEntity`](../../src/fs/types.ts). Every synchronizable remote file presented for
content comparison MUST use `hash: ""` and carry in `remoteChecksum` the
provider-supplied checksum required by RB-SVC-006. Before Admission compares the file,
the backend MAY obtain that value from listing/stat/delta metadata or a dedicated
checksum request, but MUST NOT download the remote file body to derive it. `write()` MAY
return a local SHA-256 because it already has the uploaded bytes, but the resulting
entity MUST also obtain the provider checksum before it is published as the remote
baseline. The checksum algorithm MUST be implemented by [`digest()`](../../src/utils/hash.ts),
stable for identical bytes, sensitive to byte edits, and normalized to the exact
encoding produced locally. An `opaque` fingerprint, provider version id, or mtime/size
fallback does not satisfy this requirement; those signals may supplement the checksum
only for temporal remote-change detection and race protection.

The shared TypeScript surfaces are intentionally wider than the supported production
remote profile: `remoteChecksum`, `identityKey`, `pathAuthority`, `checkpoint`,
`listCurrentSnapshot`, `getScopeFingerprint`, and `priority` are optional so local
filesystems and narrow test doubles can implement the same interfaces. For a production
remote backend, RB-FS-002/003/005 and RB-CHK-001/005 make these observations and
capabilities mandatory; their optional type markers are not qualification waivers.

RB-FS-003 — `identityKey` MUST be scoped to the configured backend/root and implement
RB-SVC-002. `pathAuthority` MUST distinguish provider-resolved spelling
(`actual_resolved`) from a caller address merely echoed by a sparse response
(`requested_echo`). A requested echo MUST NOT re-key a stable identity or its
descendants. Only provider-resolved metadata or the successful endpoint of an explicit
provider rename may change cached topology.

RB-FS-004 — The backend MUST hide and reject writes to
[`INTERNAL_METADATA_PATH`](../../src/fs/remote-vault-contract.ts) if that reserved path
can appear through the provider. It MUST NOT invent backend-specific sync exclusion
policy; dot-path and ignore policy remains owned by the orchestrator.

RB-FS-005 — Remote filesystems MUST provide the detached
[`PriorityObservationCapability`](../../src/fs/priority-observation.ts). Observation
MUST resolve the current path occupant and admitted identity without reading or advancing
the batch delta/cache working view. The subsequent read MUST be bound to the observed
version and return `target_changed` or `unverifiable` instead of content when the target
cannot still be proven. Missing, replacement, duplicate occupants, incomplete parent
chains, and unavailable version evidence MUST fail closed using the public result
variants. A current synchronizable file observation MUST carry the same locally
reproducible `remoteChecksum` required of batch observations.

### Cache, change feed, and attempt lifecycle

RB-CHK-001 — A production remote implementation MUST adopt
[`CachingRemoteFs`](../../src/fs/caching/remote-fs.ts) and an
[`AbstractMetadataCache`](../../src/fs/caching/metadata-cache.ts), unless a separately
accepted design supplies the same four-contract integration and proves an equivalent
attempt-bounded checkpoint. Backend code supplies provider-specific listing, delta,
detached lookup, download/delete, projection, and mutation seams; it MUST NOT duplicate
sync policy. A production remote checkpoint MUST also implement `listCurrentSnapshot()`
for a post-delta folder-move view and `getScopeFingerprint()` for scope widening, even
though both are optional for narrow `IncrementalCheckpoint` test doubles.

RB-CHK-002 — A full scan MUST capture its start position before listing when a native
feed is used, enumerate the complete subtree, prove root liveness on an empty result, and
build a flat identity-indexed snapshot. Pagination MUST be fully drained or fail; a
partial listing MUST never be presented as complete.

RB-CHK-003 — Delta application MUST be limited to the bound subtree and MUST produce
complete `modified`, `deleted`, and `renamed` facts. A native file rename is one rename
pair plus its old/new changed paths. A folder rename is one folder pair and a re-keyed
descendant snapshot, not independent child renames. Provider event order MUST NOT alter
the result. Deletes lacking a path MUST be reverse-resolved from stable identity. Cursor
expiry/reset MUST fall back to a complete scan, never silently advance.

RB-CHK-004 — The live metadata, cursor, and scope form one attempt-bounded derived
working view. They MUST be protected from concurrent corruption and MUST NOT be persisted
incrementally while fetching pages or executing mutations.

RB-CHK-005 — The complete final metadata snapshot, non-empty usable cursor, and scope
fingerprint MUST commit atomically in the backend's per-target `MetadataStore`, only
after a wholly clean cycle. `abortWorkingView()` MUST discard only the live view and
reload the last durable checkpoint on the next access. `resetCheckpoint()` MUST discard
the durable cursor, cache, and scope so the next cycle is COLD. An unreadable or absent
checkpoint MUST be treated as absent.

RB-CHK-006 — The supported production configuration MUST acquire a non-empty usable
start cursor and advance it through incremental observations. Initial sync, manual
rescan, scope change, unreadable state, and feed reset/expiry MAY use a complete COLD scan,
but that scan MUST establish a new usable cursor before a clean checkpoint can be
published. Loss of feed permission aborts the attempt and requires reconfiguration; it
MUST NOT silently convert ordinary operation into a permanent full-list loop or commit a
fabricated cursor.

### Provider, authentication, settings, and errors

RB-PROV-001 — The backend MUST implement
[`IBackendProvider`](../../src/fs/backend.ts). `type` is a stable, unique, published key;
`displayName` is user-facing; `createFs()` returns `null` until both credentials and a
remote root are ready; `isConnected()` agrees with that readiness; and `getIdentity()`
combines the backend family with the stable bound-root identity. Changing that identity
must cause the existing manager path to clear the prior baseline/checkpoint.

RB-PROV-002 — Remote-vault binding MUST be explicit. A provider MAY implement the
`obsidian-air-sync/<vault>` convention, a picker, manual root-id entry, or more than one
of these. A picker is all-or-nothing (`start` plus `complete`), validates CSRF state and
the selected folder, and returns only non-secret backend updates. A local vault rename
may or may not rename the remote root; the stable root binding MUST remain unchanged.

RB-PROV-003 — Plugin-owned access/refresh credentials MUST use the stable
`air-sync-<type>-<name>-token` SecretStorage keys through
[`token-store.ts`](../../src/fs/token-store.ts). Raw access/refresh tokens and client
secrets MUST NOT enter `settings.backendData`, logs, URLs not mandated by the
authorization protocol, or checkpoint storage. A user-managed SecretStorage key name
MAY appear in `backendData` as a reference; its secret value may not. Required refresh
credentials MUST be published with immediate exact readback before dependent state
becomes reusable. `backendData` holds only the active backend's non-secret binding,
expiry, region, pending CSRF, public-client configuration, or secret-name reference.

RB-PROV-004 — Disconnect MUST clear every plugin-owned secret and reset backend data.
If `fs.checkpoint` exists, `clearCheckpointStore(settings)` MUST also exist so disconnect
can clear the same per-target store without a live filesystem. Failures may leave only
an unreachable store keyed by the old target; they MUST NOT preserve a reusable stale
checkpoint under a future identity.

RB-PROV-005 — Provider-specific errors MUST be translated to the backend-neutral
`auth`, `permission`, `rateLimit`, `notFound`, `transient`, or `permanent` categories
when HTTP status alone is insufficient. Server retry hints must be preserved. Logical
errors delivered in HTTP-200 bodies, provider-specific auth codes, and cursor-expiry
signals MUST be checked before data is accepted. Retry/backoff MAY live in the typed
client or the orchestrator, but the layers MUST NOT multiply retries unintentionally.

RB-PROV-006 — Production clients and auth flows MUST use `requestUrl()`, bound all
pagination/retry loops, avoid unbounded response buffering where provider upload APIs
offer resumable/chunked transfer, and remain mobile compatible. Provider SDKs are
acceptable only if they meet the same shipped-code restrictions and do not introduce a
second filesystem or retry-policy owner.

## Boundaries

The backend owns translation between a provider's wire model and Air Sync's filesystem
facts. It does not own sync admission, conflict policy, durable `SyncRecord` publication,
configured-path exclusion, retry classification policy, or cycle completion.

The dependency direction is:

```text
BackendManager / sync pipeline
          |
          v
IBackendProvider + IFileSystem + FileEntity
          |
          v
provider implementation -> typed client -> requestUrl()
          |
          +-> CachingRemoteFs / AbstractMetadataCache / MetadataStore
```

Adding a backend MUST NOT add backend-specific imports or branches to `sync/`,
`main.ts`, `store/`, `queue/`, or `utils/`. The allowed production extension points are
the backend implementation/provider, `fs/registry.ts`, and backend-specific settings UI.
Shared contract adapters and live E2E are verification extension points, not production
core exceptions.

## Invariants

- RB-INV-001 — Provider facts are untrusted observations until Admission authorizes an
  exact action. A backend never proposes a sync action.
- RB-INV-002 — The only durable correctness authorities remain successful per-file
  `SyncRecord`s and the wholly clean-cycle remote checkpoint. Backend caches are derived
  projections, never mutation ledgers or recovery queues.
- RB-INV-003 — Absence, path spelling, identity, checksum, and version are reported only
  at the authority actually established by the provider response. Unknown is not
  absence or content equality.
- RB-INV-004 — No backend operation overwrites or deletes a newly observed, unadmitted
  version. Destination occupancy and source/version races fail closed.
- RB-INV-005 — COLD, WARM, and HOT acquisition produce the same facts for the same
  current provider state; prior errors and recovery markers are not backend inputs.
- RB-INV-006 — Network and storage optimization never changes public filesystem or
  checkpoint semantics.

## Collaboration

Backend-specific code should be split into the same responsibility seams where they
exist, without requiring identical filenames:

- a typed client owns wire calls, response validation, pagination, and provider error
  shapes;
- an auth implementation owns authorization and token acquisition/refresh;
- a metadata projector/cache owns provider-entry-to-`FileEntity` conversion and stable
  identity/path resolution;
- the filesystem owns the `IFileSystem`, checkpoint, priority-observation, and mutation
  seams;
- the provider owns configuration readiness, root binding, identity, disconnect, and
  renderer creation;
- a settings renderer owns only backend-specific UI;
- tests own faithful fake behaviour and conformance evidence.

Use existing shared helpers before introducing another owner: `CachingRemoteFs`,
`AbstractMetadataCache`, `resolveDetachedIdPath`, token-store helpers, PKCE helpers,
backend-neutral error classification, and `MetadataStore`.

## Failure Responsibility

- An incomplete/ambiguous list, delta, path resolution, detached observation, checksum,
  or version proof fails the current operation. It is never converted into authoritative
  absence or content equality.
- Any delta-page or checkpoint-write failure leaves the prior durable checkpoint
  replayable after `abortWorkingView()`.
- Root deletion, trashing, permission loss, and wrong-root binding abort before a COLD
  empty result can become local delete evidence.
- Authentication and permission failures surface for user action; rate limits and
  transient failures remain retryable under the shared policy; permanent protocol
  failures are not retried indefinitely.
- A provider limitation that prevents a normative requirement is a backend
  qualification failure. It is not a reason to opt out of a shared contract case.

## Variability

The following differences are supported when declared in the contract harness and
verified against the live service:

| Dimension | Allowed variants |
|---|---|
| Addressing | Item-id/parent-id trees; stable-root-id plus relative provider paths; another model that preserves RB-SVC-002/003. |
| Change acquisition | Native scoped delta; account-wide delta filtered to the root under an acceptable permission scope; ordered path delta normalized by identity. All variants provide a replayable cursor and the same complete changed/deleted/renamed facts. |
| Content checksum acquisition | Locally reproducible (`md5`, `sha1`, `sha256`, `dropbox`, `quickxor`, or another implemented algorithm), obtained without downloading the remote body. It may be included in listing/stat/delta metadata or obtained through a dedicated checksum request. Provider-only `opaque` values and absent checksums are not conforming variants. |
| Written mtime | Exact; stored at a declared precision; provider-assigned positive timestamp. The shared contract's sanctioned knobs are `mtimePrecisionMs` and `preservesWrittenMtime`. |
| Authentication | Hosted exchange, direct public-client PKCE, or another mobile-safe flow; refreshable or long-lived access token. No shipped confidential secret. |
| Root selection | Convention folder, in-app picker, web picker, or explicit stable id. |
| Delete mechanism | Hard delete or trash, with the same idempotent path-absence result. |
| Retry placement | Typed client or orchestrator, provided classification is preserved and retries are bounded once. |

The following are conveniences, not prerequisites: receiving the required checksum in
the same listing/delta response rather than through a separate metadata request, a
folder picker, a refresh token, exact millisecond mtime preservation, a provider-native
recursive listing call, and a provider-native root-scoped delta feed. A locally
reproducible remote checksum and an incremental feed are mandatory; only their
acquisition shape, algorithm, provider scope, and wire representation vary.

## Conformance

A backend is supportable only when all of the following evidence exists on the same
implementation tree.

1. Add the exact filesystem constructor to
   [`tests/fs/contracts/remote-backend-family.ts`](../../tests/fs/contracts/remote-backend-family.ts).
   Provider aliases that create the same constructor share one family; subclasses do
   not inherit conformance implicitly.
2. Add four backend adapters under `tests/fs/<backend>/` and register every cell in the
   sole composition root,
   [`tests/fs/remote-backend-contracts.test.ts`](../../tests/fs/remote-backend-contracts.test.ts):
   `filesystem`, `caching`, `changeDetection`, and `priorityObservation`.
3. Run shared contracts against the real filesystem implementation over faithful fakes
   at the typed-client/transport boundary. Do not reimplement the filesystem in the
   fake, inspect private cache state as proof, make the fake more generous than the real
   API, or opt out of a failing shared case. The change-detection evidence MUST include
   a same-size local/remote comparison which recomputes the advertised algorithm from
   local bytes, proves equality and inequality against the remote checksum, and asserts
   that no remote content read occurred. Make each new assertion load-bearing by a
   RED-first or mutation witness.
4. Register every built-in/custom provider in `src/fs/registry.ts`, extend
   `src/fs/registry.test.ts` construction data and expected types, and keep the generic
   registry guard green. A checkpoint-bearing filesystem must pair with
   `clearCheckpointStore`.
5. Add backend-specific unit coverage for wire validation, auth completion and secret
   publication, root binding, error classification, pagination/reset behaviour,
   provider-specific rename/casing, and API-route fidelity of detached priority lookup.
6. Add a credentials-gated live E2E that reuses the shared filesystem contract, uses a
   fresh isolated remote root, cleans up best-effort, declares only empirically proven
   mtime/hash knobs, and runs the live priority and composed rename-safety scenarios.
   Missing credentials skip; live E2E remains opt-in and outside CI.
7. Update the backend's user/settings documentation, [`ARCHITECTURE.md`](../../ARCHITECTURE.md),
   [`docs/code-enforcement.md`](../code-enforcement.md) where catalogs are named, and
   [`docs/e2e-testing.md`](../e2e-testing.md). Add the backend-specific live E2E command.
8. Pass the repository gate: `npm run lint`, `npm run lint:bot-repro`, `npm run build`,
   and `npm run test:coverage`. Before release, also run the backend's live E2E against
   a throwaway account and record any intentional provider divergence.

### Qualification worksheet

Before implementation, record concrete provider evidence for:

- root scoping and empty-versus-missing root behaviour;
- file/folder stable-id lifecycle, rename continuity, and same-path replacement;
- exact and case-only rename/move collision semantics;
- complete listing and pagination guarantees;
- delta authorization scope, ordering, pagination, replay cursor, reset/expiry, deletes,
  and rename representation;
- the checksum endpoint or metadata field, proof that it does not download the file
  body, its algorithm/encoding, local reproducibility, availability on every
  synchronizable file type and size, and request-cost/rate-limit implications;
- the provider-native object types that are not byte-backed or lack the required
  checksum, and the fail-closed exclusion/error behaviour for each;
- version-id and mtime precision semantics as supplemental temporal/race signals;
- detached lookup by identity and by exact requested path, including duplicate results;
- upload size limits, resumable/chunked requirements, and byte fidelity;
- auth scopes/access mode, token rotation/expiry/revocation, regional API hosts, and
  logical-error shapes;
- rate-limit signals and retry hints;
- mobile `requestUrl()` compatibility.

An unanswered item is an implementation risk, not evidence that the service satisfies
the requirement.

### pCloud rejection evidence

The [archived pCloud investigation](../note/note-20260915-pcloud-backend-investigation.md)
is the source study from which this requirement was clarified. pCloud was not adopted as
a supported backend. Its intended Specific-folder-only application mode cannot call the
account-wide `diff` feed and receives result `2096`. Full access would expose the feed but
would broaden authorization beyond the accepted vault-scoped product boundary. A full
recursive `listfolder` on every cycle was considered as a correctness fallback, but it
does not satisfy RB-SVC-009 or Air Sync's delta-first requirement.

The rejected investigation still demonstrates that several provider differences are
technically adaptable without changing sync policy:

- numeric item/parent ids fit the shared metadata-cache model;
- the opaque 64-bit hash is usable only as supplemental temporal evidence, while the
  separate `checksumfile` operation is the candidate route for satisfying RB-SVC-006
  without downloading the file body;
- an account-wide path-less feed can be filtered and delete paths reverse-resolved when
  its authorization scope is acceptable;
- HTTP-200 logical errors, long-lived access-only auth, US/EU host pinning, recursive
  listing, and hand-built multipart are isolated in provider/client seams;
- the investigation confirmed root liveness because `listfolder` errors for a missing
  root rather than returning a false empty list.

Those adaptation findings do not override the rejection. The investigation branch also
predates the current central four-contract matrix and detached priority requirements;
its prototype is neither a current implementation nor conformance evidence.

## Related Decisions

- [ADR 0001 — metadata cache is subordinate to commit-last](../adr/0001-metadata-cache-is-subordinate-to-commit-last.md)
- [ADR 0002 — backends use shared behaviour contracts](../adr/0002-backends-verified-by-shared-behaviour-contracts.md)
- [ADR 0003 — live E2E backstops fake fidelity](../adr/0003-opt-in-e2e-validates-fakes-against-real-backends.md)
- [ADR 0005 — change detection prefers free fingerprints](../adr/0005-change-detection-prefers-free-fingerprints.md)
- [ADR 0006 — remote rename detection is order-independent](../adr/0006-remote-rename-detection-is-order-independent.md)
- [Four-stage sync pipeline design](design-four-stage-sync-pipeline.md)
