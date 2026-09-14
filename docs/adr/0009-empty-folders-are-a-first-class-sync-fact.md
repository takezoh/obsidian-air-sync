# ADR 0009 — Empty folders are a first-class sync fact, reusing existing action kinds

**Status:** Accepted · 2026-09-13
**Context area:** `sync/` — path observation, change detection, Admission, execution
**Related:** [ADR 0001](0001-metadata-cache-is-subordinate-to-commit-last.md), [ADR 0005](0005-change-detection-prefers-free-fingerprints.md), [ADR 0006](0006-remote-rename-detection-is-order-independent.md), [ADR 0008](0008-logical-identity-admission-fails-closed.md), [adr-20260903-four-stage-sync-pipeline](adr-20260903-four-stage-sync-pipeline.md), [adr-20260905-fact-first-component-admission](adr-20260905-fact-first-component-admission.md)

## Context

An empty folder never synced on any backend (Google Drive, Dropbox, OneDrive, or
Proton Drive): creating one locally never uploaded it, and creating one directly in
cloud storage never downloaded it. A folder only ever appeared on both sides as a
side effect of a *file* being created inside it (every backend's `write()` already
auto-creates missing parent directories).

This was not a backend defect — every backend already implements
`IFileSystem.mkdir()` correctly, and `LocalFs.list()` already reports empty
directories. The gap was entirely in the shared sync engine: `path-observation.ts`'s
`exactEntity()` — the helper every acquisition temperature (COLD, WARM, HOT) and the
HOT→WARM promotion path uses to turn a raw `stat()`/`list()` result into a
`MixedEntity.local`/`.remote` fact — unconditionally discarded any directory. A
folder's presence or absence therefore never reached Admission at all, regardless of
backend.

## Decision

1. **A directory is a first-class fact**, surfaced through a new `resolvedEntity()`
   (in `path-observation.ts`) used everywhere `exactEntity()` previously built
   `MixedEntity.local`/`.remote`. `exactEntity()` itself is unchanged and still
   excludes directories — it remains the boundary for content-identity-sensitive
   callers (hash enrichment, alias-collision preservation) that have no defined
   behavior for a directory and must stay file-only.

2. **No new `SyncActionType`.** A directory reuses the exact same `push` / `pull` /
   `match` / `delete_local` / `delete_remote` kinds a file already produces from
   `compareContent`, once two narrow gaps in the content-comparison helpers are
   closed:
   - `content-identity.ts`'s `sameContent()` now treats two directories as always
     identical (a directory's identity is its existence and location, never its
     bytes — it has none to compare).
   - `change-compare.ts`'s `hasChanged`/`hasRemoteChanged` now report a directory as
     always unchanged (a directory has no usable mtime — `LocalFs.list()` always
     reports `mtime: 0` for folders — and no checksum; the "no signal → assume
     changed" fallback these functions otherwise use would make every already-synced
     folder look changed forever).

   With those two fixed, `identity-component-decision.ts`'s existing exact-path
   materializer (`bindFiles`/`materializeExactPath`) needs only its two
   directory-exclusion `continue`/`return null` guards removed to admit a bare
   directory fact exactly like a file. `plan-executor.ts` needs one new branch in
   the shared push/pull case: when the source entity is a directory, call
   `mkdir()` instead of reading and writing content. Everything downstream —
   `proveAdmittedTerminal`'s terminal proof, `commitAction`'s generic
   `SyncRecord` construction — already had a symmetric `isDirectory` branch (built
   for folder renames) and needed no change.

   This matches [adr-20260905](adr-20260905-fact-first-component-admission.md)'s
   standing rule to reuse existing states/action kinds rather than invent a new
   mechanism for a new fact shape.

3. **Folder deletion reuses `delete_local`/`delete_remote`, guarded by a
   descendant check that only defers, never fabricates deletion authority.**
   `delete_local` (propagating a remote-confirmed folder deletion to local) is
   always safe to admit once proven not to strand a live local descendant, because
   `LocalFs.list()` is a complete listing every cycle — `facts.local` never lies by
   omission. `delete_remote` (propagating a local deletion to remote) is the harder
   direction: in WARM/HOT mode, `facts.remote` is populated only for paths already
   in that cycle's narrow `changedPaths`/dirty set, so an unrelated, unchanged
   remote descendant may simply not be present in this cycle's facts — its absence
   there is not proof of its absence in reality.

   Two additions close this gap for the common case without inventing a new
   mechanism:
   - `plan-admission-graph.ts` unions a **baselined** directory fact with its
     currently-known descendants (`pathsWithPrefix`, the same helper the existing
     folder-rename case already uses) — deliberately scoped to folders that
     already have a `SyncRecord`, since only those can ever reach a delete
     decision in `compareContent`. Unioning every bare directory unconditionally
     was tried first and rejected: it pulled unrelated siblings (a brand-new
     folder and the files being created inside it) into one *serial* execution
     component, so a transient failure on the folder's own `mkdir` blocked those
     siblings from even attempting their own I/O ("component prefix did not
     publish") — turning independent, individually-recoverable pushes into one
     all-or-nothing unit for no safety benefit (see Rejected alternatives).
   - `change-detector.ts`'s `collectWarm` escalates to a full COLD collection
     when a previously-tracked folder has gone missing from the local listing —
     the exact same escalate-rather-than-guess pattern `collectWarm` already uses
     for folder renames (`hasFolderRename`), just triggered by a second, narrow
     condition. COLD's full `remoteFs.list()` gives a genuinely complete
     descendant view, closing the gap WARM's own targeted stats cannot.
   - `identity-component-decision.ts`'s `materializeFile` checks
     `hasDescendant(facts, side, path)` immediately before admitting
     `delete_local`/`delete_remote` for a directory; if a descendant is visible in
     this cycle's (possibly graph-unioned) facts, it returns no action instead —
     the folder becomes deletable once its children are individually resolved,
     re-evaluated fresh next cycle (never a persisted "pending delete" marker).

   One small, additive `SyncRecord.isDirectory?: true` field (never `false` —
   omitted for every existing file record, so no existing record shape or test
   is affected) is what lets the WARM escalation check distinguish "a folder
   record went missing" from an ordinary file deletion, without adding a new
   `IFileSystem` method or an extra network call for the common (file deletion)
   case.

## Consequences

- Folders sync like any other fact: created on either side, they appear on the
  other; deleted on either side (once safely provable), they disappear on the
  other; already-synced and unchanged, they cost nothing every cycle.
- **This is deliberately not a mathematically airtight guarantee against every
  possible interleaving.** An entirely untouched remote descendant that never
  enters *any* cycle's facts before its parent folder is deleted locally in HOT
  mode can still be missed — HOT only ever gathers facts for dirty/delta-reported
  paths, and nothing here changes that. This is a known, accepted tradeoff, not an
  oversight: closing it fully would require a new `IFileSystem` "list one folder's
  children" primitive implemented by every backend, which is out of scope for
  reusing existing machinery. In practice this rarely bites — folders are usually
  deleted as a whole subtree (local and remote descendants disappear together, so
  they're observed together), and a later WARM/COLD cycle (or the escalation rule
  above) closes the gap for anything it doesn't. `crash-safety.test.ts` pins both
  the guarantee that holds (a descendant visible this cycle defers the delete) and
  the residual gap that doesn't (an entirely untouched descendant in HOT mode), so
  neither is a silent surprise for a future maintainer.
- No new `SyncActionType`, no new state store, no new orchestrator field, no new
  cross-file import relationship — confirmed by both
  `sync-state-ownership-guard.test.mjs` (inventories `SyncStateStore`/
  `IDBHelper`/`MetadataStore` import/construct/mutate ownership and the
  `SyncOrchestrator` field list) and `sync-admission-authority-guard.test.mjs`
  (inventories cross-file value imports of the identity-decision modules), which
  both stayed green with no fixture changes.
- Alias-collision preservation and hash enrichment remain file-only by design —
  `exactEntity()` is untouched, and neither has a defined behavior for a directory.
- **A dot-path root's own local absence is observable, so it must be listed
  correctly.** `LocalFs.list()` merges in `DotPathAdapter.listAll()` for hidden
  roots (e.g. the vault's configDir under Config Sync) — and that adapter only
  ever pushed an entity for something it found as *someone else's* child while
  recursing, never for a configured root itself. Once such a root could carry a
  directory `SyncRecord` (this ADR), that gap meant `collectWarm`'s own
  missing-folder escalation (above) always saw it as absent, live-testing showed
  — forcing a full COLD collection on essentially every cycle for any vault with
  Config Sync enabled. Fixed by pushing an entity for each existing root itself,
  matching how its children are already handled; a `"WARM escalated to COLD"`
  debug diagnostic (logging which of the two escalation reasons fired, and for
  which paths) is what made this directly diagnosable from a live log instead of
  another round of count arithmetic.

## Rejected alternatives

- **Union every bare directory fact with its descendants unconditionally**
  (not just baselined ones), to keep the graph-union logic simpler. Rejected: it
  regressed ordinary folder creation by forcing a brand-new folder and the
  (unrelated, independently succeedable) files being pushed into it into one
  serial component, so a transient `mkdir` failure blocked its siblings from even
  attempting their own write — confirmed by a real orchestrator test
  (`orchestrator.test.ts`) that regressed under this version and passed once the
  union was scoped to baselined folders only.
- **Treat a wholly-ignored directory as ordinary scope-included content.** A
  directory whose entire contents match a glob like `"private/**"` is not itself
  matched by that pattern (standard gitignore semantics: it matches contents, not
  the directory entry) — so without an explicit check, a folder meant to be fully
  invisible would still sync as an empty container, leaking its name to the
  remote. `scope-projection.ts`'s `applyScope` now probes an arbitrary,
  never-real child name against the configured `ignorePatterns` before including
  a directory entry; a narrower pattern (e.g. `"private/*.secret"`) correctly
  leaves the directory included, since the probe won't match it.
- **A new `IFileSystem` "list one folder's children" primitive**, to make the
  delete-descendant check provably complete in every temperature. Rejected as
  out of scope for reusing existing machinery — see Consequences above.
- **New `mkdir_local`/`mkdir_remote`/folder-delete action kinds**, mirroring
  `rename_local`/`rename_remote`'s dedicated shape. Rejected: `push`/`pull`/
  `match`/`delete_local`/`delete_remote` already carry everything a directory
  action needs (source/target sides, baseline, publication), and the executor's
  existing terminal-proof and commit paths already handle directories correctly
  once given the chance — a new action kind would only duplicate that machinery
  for no new capability.
