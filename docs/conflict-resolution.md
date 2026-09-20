# Conflict Resolution

This document owns the conflict-policy judgements. The resolver's implementation lives in
the code.

## Conflict strategies

The settings surface exposes three user-facing strategies. Observation uses the captured
strategy only to decide whether bounded conflict-hash facts are required; Admission
compiles each conflict into a required, closed execution policy, and the resolver consumes
that action-local policy without reading or reinterpreting the setting.

| Strategy | Behavior |
|----------|----------|
| `auto_merge` | Try a 3-way merge; if the file is ineligible, the base content is missing, or the merge throws, fall back to newer-wins. Two narrower cases produce a duplicate: within newer-wins, equal or unknown mtimes with differing content; and for JSON/Canvas, a merge that produced conflict markers or invalid JSON. |
| `prefer_local` | Keep local at the original path only for a simple same-path edit/edit conflict whose local and remote SHA-256 values both differ from the same non-empty committed baseline and from each other. Otherwise use the same preservation behavior as `duplicate`. |
| `duplicate` | Delete-aware (see below). When both sides exist, save remote as a `.conflict` file and keep local at the original path. |

The setting is stored as `conflictStrategy`. An interactive `ask` strategy existed earlier
and was removed (it always fell back to `duplicate` anyway); a vault saved while it was
selected is normalized to `duplicate` on load.

## prefer_local proof boundary

`prefer_local` is a conflict-resolution policy, not a general direction rule. Ordinary
one-sided changes still push or pull normally. Admission authorizes local-wins only when
current facts prove a bilateral edit of the same previously synchronized file. The proof is
deliberately unavailable without a committed baseline, for edit/delete conflicts, or for
compound identity/topology conflicts; those preserve the surviving or competing versions
through the duplicate route.

The proof predicate is a responsibility-local pure helper, not a generic strategy service:
Observation may answer only whether more facts are needed, while the Admission helper owns
the exhaustive mapping to merge / local-win / preserve. This boundary prevents an old device
from overwriting newer remote content merely because it cold-started — a first sync, schema
cold-start, cleared state, or any missing hash cannot establish which side is the intended
edit, so differing files are preserved as two versions. COLD, WARM, and HOT therefore
produce the same decision from the same complete facts.

## auto_merge fallback chain

```
auto_merge
  ├── local + remote + baseline all present?
  │     ├── yes → attempt 3-way merge
  │     │           ├── merge-eligible (text, bounded) + base content in store?
  │     │           │     ├── success → write merged to both sides → "merged"
  │     │           │     ├── has conflicts → write merged to both sides → "merged" (markers)
  │     │           │     └── JSON/Canvas with markers OR invalid JSON → duplicate
  │     │           └── not eligible / no base → newer-wins fallback
  │     └── no  → newer-wins
  └── newer-wins
        ├── one side deleted → other side wins
        ├── both deleted → no-op
        ├── both exist, both mtimes known → newer wins
        ├── same mtime + same content → keep local
        └── same/unknown mtime, different content → duplicate
```

The 3-way branch is reachable only when `enableThreeWayMerge` is on (default true), which
gates whether base content is persisted at commit time: with it off no base is stored, so
`auto_merge` always falls back to newer-wins. The resolver never reads the setting — the
gate is entirely upstream at commit time, expressed as the presence of stored base content,
and base content is only stored for merge-eligible files. Stored content is compressed and
decoded transparently. Content identity in newer-wins compares the local hash, falling back
to the typed remote checksum; if either side lacks a usable checksum the pair is treated as
different content.

## 3-way merge

Implemented in `merge.ts` using `node-diff3`. Eligibility requires the larger side to be at
most a bounded size (about 1 MiB, inclusive) and the extension to be in a fixed text
allowlist — not a content sniff. The merge normalizes CRLF to LF, short-circuits when any
two of base/local/remote are equal, computes independent diffs against the base, applies
non-overlapping hunks (adjacent insertions/deletions merge cleanly with half-open ranges),
inserts minimal per-hunk conflict markers where hunks overlap, and restores CRLF if either
side used it. All short-circuit and zero-overlap paths are clean successes.

**JSON/Canvas guard**: if the extension is a structured format and the merge has conflicts
(or the result is invalid), the resolver falls back to `duplicate` instead of writing broken
content. The guard validates only the merged output, runs for clean and conflicted merges,
and matches the extension case-insensitively.

**Rollback**: writes happen local-first, then remote; if the remote write throws the local
file is restored to its pre-merge content and mtime and the error is re-thrown so the action
is reported failed. A thrown merge itself falls back to the configured policy with nothing
written, so no rollback is needed.

## Conflict file naming

`generateConflictPath()` inserts a `.conflict` suffix before the extension (appended for
extensionless paths). If that exists it numbers upward to a bounded limit, then falls back
to a single timestamp suffix. It checks all involved filesystems to avoid overwrites.

## Internal resolver strategies

`conflict.ts` defines the low-level building blocks used by `resolveConflict()`: `keep_newer`
(newer side overwrites the other), `duplicate` (delete-aware), and `auto_merge` (3-way merge
falling back to newer-wins). These are not exposed in the settings UI.

`duplicate` is delete-aware: exactly one side deleted restores the survivor to the deleted
side (no `.conflict` file); both deleted is a no-op; only when both exist is the remote saved
as a `.conflict` duplicate on BOTH sides, the local kept at its original path and also pushed
to remote. `keep_newer` and `duplicate` preserve source mtimes on the written copies; a
successful 3-way merge is the only path that stamps both sides with the current time, which
affects subsequent newer-wins comparisons.

## Conflict history

`ConflictHistory` (`conflict-history.ts`) is an audit-log writer for resolved conflicts,
targeting a per-device file under `.airsync/conflicts/`. It is not a sync authority; the
orchestrator passes each resolved record to it as an append hook. The history is bounded per
device file; a missing file or any read/parse error returns an empty list rather than
throwing; the device name is pre-sanitized as in logging. The recorded strategy is projected
from the exact admitted action's policy, so a later settings change cannot alter audit
provenance.
