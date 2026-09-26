---
change: change-20260927-gdrive-native-object-exclusion
role: requirements
functional_requirements:
- id: FR-001
  priority: must
  statement: The Google Drive adapter shall treat any object whose mimeType begins with
    application/vnd.google-apps. and is not the folder mimeType as provider-native and
    exclude it from the remote sync view.
- id: FR-002
  priority: must
  statement: The system shall exclude a provider-native object from every Google Drive
    read path that feeds the remote view, so it is absent from listAll, listSubtreeById,
    getById, and getByPath.
- id: FR-003
  priority: must
  statement: When the Google Drive changes feed reports an upsert for a provider-native
    object, the system shall not produce a remote change for it, while still reporting
    its delete by id.
- id: FR-004
  priority: must
  statement: If a version-bound read targets a provider-native object, then the system
    shall return an unverifiable result without requesting its bytes.
- id: FR-005
  priority: must
  statement: The system shall keep a byte-backed file synchronizable regardless of its
    mimeType, including a non-folder object that does not carry the native prefix.
- id: FR-006
  priority: must
  statement: While a bound root contains a provider-native object, a sync cycle shall
    plan no pull for it and shall complete without a failure attributed to it.
- id: NFR-001
  priority: null
  statement: The exclusion is a single provider-fact predicate applied at the adapter
    boundary; core, the harness contracts, the other backends, and the RemoteObject
    shape are unchanged.
- id: NFR-002
  priority: null
  statement: A cold listing and a delta feed both keep the native object out of the
    managed remote view, verified through the shared Google Drive managed harness.
role: requirements
---

<!-- lifecycle is owned by change.md -->

# Requirements

## Overview

Google Drive exposes two kinds of non-folder objects: byte-backed files, whose bytes can
be read and written exactly, and provider-native Workspace objects (Docs Editors documents,
sheets, presentations, drawings, forms, scripts, and shortcuts), which have no byte content
on the Drive media route. The current adapter projects both as `RemoteObject` kind `"file"`,
so a native object is planned as a pull, the download answers 403 `fileNotDownloadable`, and
the object is re-detected and re-failed every cycle.

`design-remote-backend-implementation-contract` RB-SVC-010 requires the provider layer to
distinguish these and to exclude the native ones from the remote sync view (or reject them as
unverifiable before Admission) rather than project them as ordinary files with incomplete
content evidence. This change implements the exclusion at the Google Drive adapter boundary.

## Constraints

- The Backend Module API boundary is unchanged: the adapter reports provider facts only and
  gains no cache, cursor, scope, or store dependency (`adr-20260920-backend-module-boundary`).
- No new `RemoteObject` kind and no core-side branch: native objects are absent from the view.
- No migration; nothing new is persisted.
