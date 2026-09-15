---
id: note-20260915-pcloud-backend-investigation
kind: note
title: pCloud backend investigation (rejected)
status: published
created: '2026-09-15'
tags: []
owners: []
relations:
- {type: references, target: note-20260915-cloud-backend-qualification}
source_paths:
- docs/design/design-remote-backend-implementation-contract.md
summary: Archived investigation of the rejected pCloud backend candidate and the incremental-change-feed
  limitation that prevented adoption.
updated: '2026-09-15'
---

## Summary

pCloud was investigated as a possible Air Sync remote backend and was not adopted. The
decisive blocker was incremental change access: pCloud exposes its account-wide
`diff` feed only to Full-access applications, while the intended least-privilege
Specific-folder-only application receives result `2096`. Air Sync requires a replayable
incremental change feed in the supported production authorization mode. Granting
account-wide access only to obtain that feed was not acceptable, and recursively listing
the entire vault on every ordinary cycle did not satisfy the delta-first requirement.

This note retains the useful provider findings and the rejection rationale without
describing pCloud as a supported or planned backend.

The [consolidated provider investigation](note-20260915-cloud-backend-qualification.md)
places these findings alongside the other evaluated services. The current
[support policy](../design/design-remote-backend-implementation-contract.md#support-policy)
also limits maintenance to selected major personal cloud services. That policy is
separate from pCloud's already-established technical rejection below; it does not
replace or weaken this archived evidence.

## Provenance

The investigation was performed on the former `pcloud-fs` branch. Its source snapshot
was `docs/pcloud-backend.md` at commit
`daca3df0816dd41c0ee33526305687a56b777743`. The findings are recorded in this
`main`-branch note so they do not depend on that remote branch remaining available.

## Decision

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

## Incremental-change investigation

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

## Provider findings retained for future evaluations

### Addressing and topology

pCloud exposes numeric `fileid`, `folderid`, and `parentfolderid` values. A typed
identity namespace such as `f<fileid>` and `d<folderid>` avoids collisions between file
and folder ids. Parent chains can be projected through the shared metadata-cache model,
and a bound folder id remains stable when the folder is remotely moved or renamed.

A recursive `listfolder` response is a nested tree. It can be flattened into the
identity-indexed representation expected by `AbstractMetadataCache` by stamping each
child's parent id from the tree position and removing nested `contents` from persisted
records.

### Root liveness

A missing pCloud folder causes `listfolder` to return logical error `2005` instead of a
successful empty listing. Therefore a successful recursive listing with no children
proves an empty live root. This is safer than providers where a deleted or trashed root
can look like an empty result and require a separate liveness request.

### No-download content comparison

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

### Time semantics

`uploadfile` accepts mtime at whole-second precision. The expected filesystem contract
class would therefore use `mtimePrecisionMs: 1000`, subject to confirmation against the
live API. This differs from exact-millisecond preservation and from a provider-assigned
upload timestamp.

### Wire protocol

pCloud reports many logical failures as HTTP 200 responses with a non-zero `result`.
Every response must therefore validate the body before accepting metadata. Auth-related
result codes must map to Air Sync's `auth` classification and all other stable protocol
failures to the appropriate backend-neutral category.

Uploads require multipart form data. Because shipped code uses `requestUrl()` and cannot
depend on `FormData`, a client would need to construct the multipart byte body explicitly
while preserving UTF-8 filenames and rejecting partial uploads. Downloads require
`getfilelink` followed by a GET to the returned content host.

### Authentication and region

pCloud OAuth supplies one long-lived access token rather than an access/refresh pair.
Expiry would be handled reactively by classifying the provider's invalid-token result and
asking the user to reconnect. The callback also supplies the API hostname, which must be
stored as non-secret configuration so later calls remain pinned to the user's US or EU
region.

The access mode is configured on the pCloud application rather than requested through an
authorization-time scope parameter. This is what made the incremental-feed limitation a
product-level blocker rather than a client-side scope bug.

## Lessons for backend qualification

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
