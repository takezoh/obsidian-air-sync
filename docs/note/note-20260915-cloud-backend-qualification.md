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
- {type: references, target: note-20260915-pcloud-backend-investigation}
source_paths:
- docs/design/design-remote-backend-implementation-contract.md
- docs/note/note-20260915-pcloud-backend-investigation.md
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

## Evidence and status definitions

Research reviewed on 2026-09-15: current Air Sync source and contract, the archived pCloud
study, provider documentation, and provider SDK source. External links below identify
the evidence; moving documentation and SDK branches must be checked again before any
implementation. The pCloud note preserves its original prototype commit and observations.

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

The [existing investigation](note-20260915-pcloud-backend-investigation.md) is retained as
the detailed evidence, including original prototype provenance. Its decisive observation
was result `2096` when a Specific-folder-only application called the account-wide `diff`
endpoint. Full access enables the feed but exceeds the accepted permission scope solely
to obtain incremental changes. This fails RB-SVC-009 and its authorization boundary.

Recursive `listfolder` can support reconciliation but cannot replace ordinary delta
cycles (RB-CHK-006). Numeric file/folder identities, region-specific REST endpoints,
root-liveness errors, and `requestUrl()` transport were adaptable. The opaque listing
`hash` is not locally reproducible and cannot satisfy RB-SVC-006. A separate `checksumfile`
request is a potential conforming route, subject to fidelity and request-cost validation;
the prototype's opaque-hash approach was an additional implementation gap, not proof that
the service has no checksum endpoint. The permission/delta mismatch alone was decisive.

Sources: archived note above, [pCloud diff](https://docs.pcloud.com/methods/general/diff.html),
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

Before reopening any excluded candidate, record the maintenance/adoption reason and
updated primary-source evidence for the failed or unresolved requirements. Then complete
the contract's qualification worksheet: bound-root liveness, stable identity and
replacement, no-clobber mutations, checksum availability/encoding, version-bound reads,
authorization, mobile transport, pagination, replay/reset and cost/rate limits.

Technical acceptance still requires the real adapter's four shared contracts, provider
unit coverage, registry integration, credentials-gated live E2E, and repository gates.
Neither a policy change nor a successful upload/download demonstration waives these.
