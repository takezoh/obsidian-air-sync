---
change: change-20260919-googledrive-folder-binding-seam
role: requirements
---

<!-- lifecycle is owned by change.md -->

# Requirements

## Content

### R1 — One binding decision

When any Google Drive binding path reads a folder, the system SHALL classify it as usable,
`not_found`, `inaccessible`, `not_folder` or `trashed` in exactly one place, and every binding
path SHALL read that classification rather than re-deriving it.

### R2 — Preserve caller presentation

When the seam classifies a folder as not usable, the system SHALL let each caller decide how to
present it (throw with its own message, or map to `null`), preserving existing wording:
- Picker: re-pick / select-a-folder / Trash messages.
- Cached-id rebind: `Failed to access remote vault folder: …` / `… is in Trash`.
- Sync-time root liveness: the original 404/403 error object for accessibility failures, and the
  Trash abort message for a trashed root.

### R3 — Unclassified failures surface unchanged

When `getFile` fails for a reason other than 404/403 (auth, rate-limit, server), the seam SHALL
rethrow the original error unchanged so existing classification and retry behaviour are preserved.

### R4 — Custom typed id is validated at connect

When a custom-OAuth user connects with an already-bound folder id, the system SHALL validate that
id against Drive after auth completes and before a filesystem is created. On a definite unusable
verdict the system SHALL notify `Folder selection failed: <reason>`, create no filesystem, and
return the session to a disconnected state (so the id is editable and no later `initBackend` /
`runSync` can rebuild the target).

### R5 — Re-validation, and recovery after connect

A target already bound at connect time SHALL be re-validated at the connect boundary. A target
that becomes unusable after a successful connect, or while the plugin is closed, SHALL be caught
by the existing sync-time root-liveness check (`assertRootAlive`), which re-observes every cycle
and recovers automatically once the folder is restored — no stopped-state branch. Validation SHALL
NOT be added to the network-free `initBackend` lifecycle step.

### R6 — Trash is visible in settings

When the bound folder is in Drive's Trash, the settings field SHALL show the folder path together
with a Trash warning instead of an ordinary path, using the same single `getFile` the path walk
already performs (no additional request).

### R7 — No new durable state

The seam SHALL be stateless. It SHALL NOT persist a validation verdict, a recovery marker or any
cross-cycle field.
