---
change: change-20260927-gdrive-out-of-subtree-exclusion
role: requirements
functional_requirements:
- id: FR-001
  priority: must
  statement: The Google Drive adapter shall exclude an object whose provider `parents` is
    absent or empty from the remote sync view, because the normalized `parent_id` location
    reserves `null` for the bound root and only the bound root.
- id: FR-002
  priority: must
  statement: The system shall exclude such an object from every Google Drive read path
    that feeds the remote view, so it is absent from listAll, listSubtreeById, getById,
    getByPath, and the changes feed.
- id: FR-003
  priority: must
  statement: When the account-wide Google Drive changes feed reports an upsert for an
    object with no provider parent, the system shall not produce a remote change for it,
    so no bare-name root address enters the cache or the plan.
- id: FR-004
  priority: must
  statement: The system shall keep a byte-backed object that does carry a provider parent
    synchronizable, whether the parent is the bound root or an ancestor that resolves
    through the cache.
- id: FR-005
  priority: must
  statement: If a version-bound read targets an object with no provider parent, then the
    system shall return an unverifiable result without requesting its bytes.
- id: NFR-001
  priority: null
  statement: The exclusion is a single representability predicate applied at the adapter
    boundary; the `parent_id` / `provider_path` contract, `NormalizedMetadataCache`, core,
    and the other backends are unchanged.
- id: NFR-002
  priority: null
  statement: A cold listing and a delta feed both keep a no-parent object out of the
    managed remote view, verified through the shared Google Drive managed harness.
role: requirements
---

<!-- lifecycle is owned by change.md -->

## Overview

The account-wide Google Drive changes feed reports items outside the bound subtree. An
item in "Shared with me" has no accessible parent, so the provider returns an empty
`parents`. `normalizeGoogleDriveObject` mapped that to `parentId: null`, which the
normalized `parent_id` contract defines as the bound root; `NormalizedMetadataCache`
therefore resolved the item to a bare-name root address, made it remote-only, and planned
a pull for a file the vault does not contain. Under the `drive.file` scope this is the
common case for a shared item the user has not added to their Drive.

## Constraints

- The remote object model and its `null`-means-bound-root contract are fixed; the fix is
  in what the Google Drive module projects, not in core.
- The backend module reads no cache/cursor/scope/store state, so it cannot resolve a deep
  parent chain; it only refuses an object that has no parent at all.
- No migration; nothing new is persisted.
