---
id: note-20260915-cloud-backend-qualification
kind: note
title: Cloud backend investigation and support decisions
status: published
created: '2026-09-15'
updated: '2026-09-15'
tags: []
owners: []
relations:
- {type: references, target: design-remote-backend-implementation-contract}
source_paths:
- docs/design/design-remote-backend-implementation-contract.md
- src/fs/registry.ts
- tests/fs/contracts/remote-backend-family.ts
- tests/fs/remote-backend-contracts.test.ts
summary: Consolidated provider evidence, technical disqualification reasons, unresolved
  questions, and maintenance-scope exclusions for personal cloud storage backends.
---

## Decision and scope

Air Sync supports **Google Drive, OneDrive, and Dropbox**. Maintenance capacity limits
support to selected major personal cloud services that meet the technical contract.
**iCloud Drive is in the major personal-service group but is technically excluded under
the current integration model.** Other investigated services are not planned additions.
The normative [support policy and implementation contract](../design/design-remote-backend-implementation-contract.md#support-policy)
own acceptance; this note records the research behind the decisions.

This is not a numerical market-share study. Comparable personal active-user shares were
not established. Large registration totals for MEGA or TeraBox do not establish their
share of active personal file synchronization, and Proton ecosystem totals do not measure
Drive usage. No invented percentages, exact ranking, or unsupported claim that all
excluded services are small is needed for this maintenance decision. Box was screened
out of this personal-use-focused investigation; no technical rejection is asserted.

### Infrastructure and customization exclusions

Air Sync targets easy adoption and everyday use of synchronization. S3/S3-compatible
storage, generic WebDAV endpoints, and self-managed servers are excluded by product
scope. Users who want advanced storage features, infrastructure control, or extensive
customization are served by power-user-oriented projects. These are not candidate
backends awaiting spare maintenance capacity.

No protocol-wide technical failure is asserted: managed S3/WebDAV services also exist,
and individual implementations have different capabilities. The exclusion is a product
choice, independent of any future adapter's technical conformance. The existing custom
OAuth option for the supported services does not change that boundary.

## Evidence and status definitions

Research reviewed on 2026-09-15: current Air Sync source and contract, the archived pCloud
study, provider documentation, and provider SDK source. External links below identify
the evidence; moving documentation and SDK branches must be checked again before any
implementation. The pCloud section preserves its original prototype commit and observations.

- **Supported reference:** an existing production family, not a claim that this research
  reran its live tests.
- **Known mismatch:** a specific investigated integration fails a named requirement.
  This does not assert impossibility under every future API or a different product.
- **Unverified:** available evidence does not establish conformance; missing documentation
  alone does not prove the capability is absent.
- **Policy exclusion:** outside the maintained provider set, independently of technical
  possibility. No experimental implementation is promised.

No new provider implementation, candidate contract tests, or candidate live E2E was run
for this investigation. Existing-family registrations were inspected. A capability table
is not a substitute for the contract's four shared suites and live verification.

## Decision matrix

| Service | Product selection | Technical finding | Current outcome |
|---|---|---|---|
| Google Drive | Selected major personal service | Existing reference family | Supported |
| OneDrive | Selected major personal service | Existing reference family | Supported |
| Dropbox | Selected major personal service | Existing reference family | Supported |
| iCloud Drive | Major personal service | Reviewed native/CloudKit routes do not supply the required integration with ordinary iCloud Drive through the plugin transport | Excluded: current technical model |
| pCloud | Outside maintained set | Specific-folder-only mode cannot access `diff`; Full access is unacceptable solely to obtain delta | Rejected: known authorization/delta mismatch, plus policy exclusion |
| MEGA | Outside maintained set; potentially substantial personal reach | Standard fingerprint fails byte-only full-content checksum requirements; alternative route unverified | Not supported: policy exclusion and technical qualification incomplete |
| TeraBox | Outside maintained set; large registration totals are not comparable active shares | Replayable delta in the acceptable app authorization mode not established | Not supported: policy exclusion and technical qualification incomplete |
| Proton Drive | Outside maintained set; comparable Drive-only adoption not established | Promising Web SDK; auth/key handoff, scope, transport and full contract unverified | Not supported: policy exclusion; not rejected as impossible or prohibited |
| Box | Outside this personal-use-focused selection | Not technically evaluated | Not supported: policy exclusion |

## Supported reference services

| Service | Content equality without remote-body download | Changes and version evidence | Authorization |
|---|---|---|---|
| Google Drive | `md5Checksum` for ordinary byte-backed files | Changes API with page tokens; current implementation uses checksum plus size for detached evidence and retains provider version metadata | `drive.file`; built-in hosted exchange |
| OneDrive | Locally reproducible `quickXorHash` | Delta links; `cTag`/`eTag` for version evidence | App Folder via `Files.ReadWrite.AppFolder`, with offline refresh |
| Dropbox | Published block-based SHA-256 `content_hash` algorithm | `list_folder` cursor/continue; `rev` for version evidence | App Folder, OAuth code plus PKCE and offline refresh |

Stable identity, complete listing, collision safety, root liveness, detached observation,
and clean-cycle checkpoint ownership remain mandatory, even for these providers. Google
Workspace-native objects without byte-backed content and the required digest are not
ordinary synchronizable files (RB-SVC-010). A version token never replaces a checksum.

Sources: [Drive files](https://developers.google.com/workspace/drive/api/reference/rest/v3/files),
[Drive changes](https://developers.google.com/workspace/drive/api/reference/rest/v3/changes/list),
[Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth),
[Graph hashes](https://learn.microsoft.com/en-us/graph/api/resources/hashes?view=graph-rest-1.0),
[Graph delta](https://learn.microsoft.com/en-us/graph/api/driveitem-delta?view=graph-rest-1.0),
[OneDrive app folder](https://learn.microsoft.com/en-us/graph/onedrive-sharepoint-appfolder),
[Dropbox content hash](https://www.dropbox.com/developers/reference/content-hash),
[Dropbox HTTP API](https://www.dropbox.com/developers/documentation/http/documentation),
[Dropbox authorization guide](https://developers.dropbox.com/oauth-guide).
Implementation evidence: [registry](../../src/fs/registry.ts),
[reference families](../../tests/fs/contracts/remote-backend-family.ts), and
[four-contract registrations](../../tests/fs/remote-backend-contracts.test.ts).

## iCloud Drive: major service, unsuitable integration route

Apple's documented document synchronization route is based on native platform APIs and
iCloud containers. CloudKit, including its web interfaces, works with application
containers/databases; it is not a general-purpose HTTP filesystem API for a user's
ordinary iCloud Drive files. Neither reviewed route establishes the complete ordinary
iCloud Drive backend required by Air Sync.

The decisive mismatch is RB-SVC-008: native-only integration or reliance on an OS cloud
sync process cannot be the shipped, cross-platform `requestUrl()` backend. Suitable
ordinary-Drive listing, checksum, version and replayable delta access through that model
also remain unestablished (RB-SVC-003/005/006/009). This does not mean CloudKit lacks all
such concepts; substituting an app-specific CloudKit database would be a different storage
product and requires its own design. Opening an OS-synced vault also contradicts the
single-sync-owner setup and does not constitute an Air Sync backend.

Sources: [Apple document synchronization](https://developer.apple.com/documentation/uikit/synchronizing-documents-in-the-icloud-environment),
[CloudKit](https://developer.apple.com/icloud/cloudkit/),
[CloudKit web services](https://developer.apple.com/library/archive/documentation/DataManagement/Conceptual/CloudKitWebServicesReference/).

## pCloud: proven permission/delta mismatch

pCloud is rejected under the acceptable authorization mode (RB-SVC-009), and is also
outside the maintained provider set. Its detailed investigation is integrated below,
including the original prototype provenance. The separate checksum gap maps to
RB-SVC-006; a permanent full-list fallback also fails RB-CHK-006.

### Provenance

The investigation was performed on the former `pcloud-fs` branch. Its source snapshot
was `docs/pcloud-backend.md` at commit
`daca3df0816dd41c0ee33526305687a56b777743`. The findings are recorded in this
consolidated note so they do not depend on that remote branch remaining available.
The prototype predates the current central four-contract matrix and detached priority
requirements; it is neither a current implementation nor conformance evidence.

### Decision

**Rejected.** pCloud did not meet the remote-backend qualification boundary under the
acceptable access mode.

| Requirement | Finding | Evaluation |
|---|---|---|
| Bounded vault access | Specific-folder-only mode confines the application to its application folder. | Suitable |
| Replayable incremental changes | `diff` is unavailable in Specific-folder-only mode and returns result `2096`. | Blocking failure |
| Acceptable permission scope | `diff` becomes available only after granting Full access to the account. | Rejected |
| Full reconciliation | Recursive `listfolder` can enumerate the bound vault. | Recovery-capable, not a steady-state substitute |
| Stable identity | Files and folders have numeric ids and one numeric parent-folder id. | Suitable |
| No-download content comparison | Listing metadata exposes only an opaque 64-bit hash; a locally reproducible digest requires a separate `checksumfile` request. | Prototype did not satisfy the requirement; service route required further cost/fidelity validation |
| Mobile transport | The REST API can be called through Obsidian `requestUrl()`. | Suitable |
| Authentication | OAuth returns a long-lived access token and a region hostname. | Adaptable |

The blocker was not CRUD feasibility. It was the mismatch between the permission model
and Air Sync's mandatory incremental-change requirement.

### Incremental-change investigation

pCloud's `diff` endpoint is an account-wide chronological event stream keyed by
`diffid`. It can represent create, modify, delete, rename, and move events, but event
metadata does not contain an absolute path. A conforming adapter would therefore need to:

- filter every event to the bound vault subtree;
- resolve path-less deletes through the stable id-to-path cache;
- treat parent/name changes on one stable id as rename or move evidence;
- apply events in provider order rather than regrouping them by action kind;
- drain the feed until the cursor advances to an empty page;
- treat a provider `reset` event as a full-scan requirement;
- commit the final cache and cursor together only after a wholly clean cycle.

Those mechanics were implementable. The access mode was not: the least-privilege app
could not call the endpoint at all. Returning an empty cursor and running recursive
`listfolder` every cycle was explored, but it permanently disables WARM delta
acquisition and turns the recovery path into normal operation. That option was rejected.

### Provider findings retained for future evaluations

#### Addressing and topology

pCloud exposes numeric `fileid`, `folderid`, and `parentfolderid` values. A typed
identity namespace such as `f<fileid>` and `d<folderid>` avoids collisions between file
and folder ids. Parent chains can be projected through the shared metadata-cache model,
and a bound folder id remains stable when the folder is remotely moved or renamed.

A recursive `listfolder` response is a nested tree. It can be flattened into the
identity-indexed representation expected by `AbstractMetadataCache` by stamping each
child's parent id from the tree position and removing nested `contents` from persisted
records.

#### Root liveness

A missing pCloud folder causes `listfolder` to return logical error `2005` instead of a
successful empty listing. Therefore a successful recursive listing with no children
proves an empty live root. This is safer than providers where a deleted or trashed root
can look like an empty result and require a separate liveness request.

#### No-download content comparison

pCloud listing and stat metadata includes an opaque content `hash`. It cannot be
reproduced from local bytes, so it can only supplement temporal remote-change detection.
It cannot prove whether the current local and remote byte content is equal and therefore
does not meet Air Sync's content-comparison requirement.

The separate `checksumfile` endpoint can return a locally computable digest without
downloading the file body. A pCloud implementation would have to retrieve that digest
for every remote file entering content comparison, normalize its algorithm and encoding
into `remoteChecksum`, and validate request-cost, pagination-scale, file-type, file-size,
and rate-limit behaviour against the live API. The investigated prototype deliberately
used the opaque listing hash instead and therefore did not satisfy this requirement.
This was not the adoption decision's decisive blocker—the unacceptable permission scope
for the mandatory incremental feed already rejected the backend—but it is an additional
prototype gap rather than an optional first-sync optimization.

#### Time semantics

`uploadfile` accepts mtime at whole-second precision. The expected filesystem contract
class would therefore use `mtimePrecisionMs: 1000`, subject to confirmation against the
live API. This differs from exact-millisecond preservation and from a provider-assigned
upload timestamp.

#### Wire protocol

pCloud reports many logical failures as HTTP 200 responses with a non-zero `result`.
Every response must therefore validate the body before accepting metadata. Auth-related
result codes must map to Air Sync's `auth` classification and all other stable protocol
failures to the appropriate backend-neutral category.

Uploads require multipart form data. Because shipped code uses `requestUrl()` and cannot
depend on `FormData`, a client would need to construct the multipart byte body explicitly
while preserving UTF-8 filenames and rejecting partial uploads. Downloads require
`getfilelink` followed by a GET to the returned content host.

#### Authentication and region

pCloud OAuth supplies one long-lived access token rather than an access/refresh pair.
Expiry would be handled reactively by classifying the provider's invalid-token result and
asking the user to reconnect. The callback also supplies the API hostname, which must be
stored as non-secret configuration so later calls remain pinned to the user's US or EU
region.

The access mode is configured on the pCloud application rather than requested through an
authorization-time scope parameter. This is what made the incremental-feed limitation a
product-level blocker rather than a client-side scope bug.

### Lessons for backend qualification

- Verify the production app's actual permission mode, not only whether the provider has a
  delta endpoint in some broader mode.
- Treat a full recursive listing as cold-start/reset recovery, not as an ordinary-cycle
  replacement for incremental changes.
- Evaluate delete and rename evidence before implementation; a path-less feed needs stable
  ids and a complete reverse index.
- Require a locally reproducible remote content checksum obtainable without downloading
  the file body; treat provider-only temporal hashes as supplemental evidence only.
- Verify logical response errors even when HTTP status is successful.
- Record region, token, mtime, pagination, and root-liveness semantics before committing
  to a backend.

The normative acceptance criteria are in
[Remote backend implementation contract](../design/design-remote-backend-implementation-contract.md).

Provider references: [pCloud diff](https://docs.pcloud.com/methods/general/diff.html),
[pCloud checksumfile](https://docs.pcloud.com/methods/file/checksumfile.html).

## MEGA: standard fingerprint is not the required checksum

The official SDK's standard file fingerprint combines size, mtime, and content-derived
data. For larger files (above the implementation's 8 KiB full-read threshold), its CRC
calculation samples content instead of covering every byte. It is therefore not a
byte-only full-content checksum: mtime can change independently of content, and edits
outside the samples can be missed. Using that fingerprint as `remoteChecksum` fails
RB-SVC-006 and RB-FS-002.

This finding rejects the standard-fingerprint route, not all conceivable MEGA adapters.
An alternative must establish a remotely retrievable full-content digest without body
download, local algorithm/encoding equivalence, and availability for all admitted files.
The reviewed native SDK is not itself a drop-in Obsidian adapter. Browser-compatible
transport, acceptable authorization scope, replayable/durable change acquisition, and
complete rename/delete evidence still need proof (RB-SVC-007/008/009). No claim is made
that MEGA has no change notifications; notifications alone do not prove cursor replay.

Sources: [official SDK](https://github.com/meganz/sdk),
[fingerprint implementation](https://github.com/meganz/sdk/blob/master/src/filefingerprint.cpp).

## TeraBox: delta qualification unresolved

The reviewed integration documentation describes app-restricted storage, file identifiers
(`fs_id`), MD5 metadata, file operations, and multipart/chunked upload. These are useful
building blocks. Their presence does not yet prove checksum fidelity across supported
sizes/types, identity-preserving collision-safe moves, or the full Air Sync contract.

A replayable incremental feed with a durable cursor in the acceptable app access mode
was not found in the reviewed public documentation. RB-SVC-009 is therefore **unverified**,
not proven impossible. A recursive listing loop would not resolve the gap. Reconsideration
requires a concrete feed endpoint and evidence for create/update/delete/move, pagination,
replay and reset, followed by the normal implementation verification.

The documented authorization-code exchange requires an app secret; that is not by itself
a rejection because built-in web authorization may use a hosted exchange. No confidential
secret may ship in the plugin. The actual grant, refresh lifecycle, region behaviour and
all file operations through `requestUrl()` remain to be validated.

Source: [official integration documentation](https://www.terabox.com/integrations/docs).

## Proton Drive: technically promising, outside maintenance scope

Proton's official SDK includes a Web JavaScript/TypeScript client. The reviewed source
provides node/revision identities, file operations, `claimedDigests.sha1` metadata,
`iterateEvents(treeEventScopeId, lastEventId)`, and revision-specific downloads.
These provide plausible routes to RB-SVC-002/004/005/006/009. The digest is optional:
missing or undecryptable checksums cannot enter Admission as valid ordinary files.
Encryption does not inherently prevent comparison; decrypting metadata is different
from downloading the file body to calculate a checksum.

The HTTP interface is injectable, so adapting it to `requestUrl()` is plausible, not
verified. Browser crypto, buffering, cancellation, polyfills, and mobile behaviour must
be tested. SDK caching/events must remain subordinate to Air Sync's attempt-bounded
working view and atomic clean-cycle checkpoint. Available event IDs do not alone prove
the entire checkpoint and detached-observation contract.

Built-in authentication is evaluated as a **web-based flow**, not a requirement to add
password entry to the plugin. The SDK does not supply login or session management.
An actual provider authorization route, acceptable permission scope, decryption-key
handoff and SecretStorage lifecycle remain unresolved. A hosted page does not create a
provider OAuth grant or justify collecting unrestricted account credentials. Do not
assume an App Folder-equivalent scope exists without evidence.

Air Sync is non-commercial OSS. The SDK README allows personal non-commercial projects
under its guidelines; third-party production readiness is a stability/support caveat,
not a blanket technical impossibility or an automatic ban on this project. SDK code
licensing and hosted-service conditions are distinct. Integration must follow the
provider's current service guidelines. Its announced cryptographic migration is an
additional maintenance consideration, not the sole reason for exclusion.

**Decision:** not in the maintained service set; comparable Drive-only adoption is not
established and qualification is incomplete. Do not label Proton rejected merely because
it uses a SDK, is encrypted, or is a third-party integration. No implementation is planned
under the current scope, even though an experimental adapter may be feasible.

Sources: [SDK README](https://github.com/ProtonDriveApps/sdk/blob/main/README.md),
[Web SDK](https://github.com/ProtonDriveApps/sdk/blob/main/client/js/README.md),
[client methods](https://github.com/ProtonDriveApps/sdk/blob/main/client/js/src/protonDriveClient.ts),
[node/revision metadata](https://github.com/ProtonDriveApps/sdk/blob/main/client/js/src/interface/nodes.ts),
[events](https://github.com/ProtonDriveApps/sdk/blob/main/client/js/src/interface/events.ts),
[HTTP transport](https://github.com/ProtonDriveApps/sdk/blob/main/client/js/src/interface/httpClient.ts).

## Reconsideration requirements

Before reopening any excluded candidate, record the target-user fit and maintenance/adoption reason and
updated primary-source evidence for the failed or unresolved requirements. Then complete
the contract's qualification worksheet: bound-root liveness, stable identity and
replacement, no-clobber mutations, checksum availability/encoding, version-bound reads,
authorization, mobile transport, pagination, replay/reset and cost/rate limits.

Technical acceptance still requires the real adapter's four shared contracts, provider
unit coverage, registry integration, credentials-gated live E2E, and repository gates.
Neither a policy change nor a successful upload/download demonstration waives these.
