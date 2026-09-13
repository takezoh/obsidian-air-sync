# Conflict Resolution

## Conflict strategies

The settings surface exposes 3 user-facing strategies via `ConflictStrategy`.
Observation uses the captured strategy only to decide whether bounded conflict-hash
facts are required. Admission then compiles each conflict into a required
`ConflictExecutionPolicy`; `conflict-resolver.ts` consumes that action-local policy
and does not read or reinterpret the setting.

| Strategy | Behavior |
|----------|----------|
| `auto_merge` | Try a 3-way merge; if the file is ineligible, the base content is missing, or the merge throws, fall back to newer-wins. Two narrower cases produce a duplicate: within newer-wins, equal or unknown mtimes with differing content; and for `.json`/`.canvas`, a merge that produced conflict markers or invalid JSON. |
| `prefer_local` | Keep local at the original path only for a simple same-path edit/edit conflict whose local and remote SHA-256 values both differ from the same non-empty committed baseline and from each other. Otherwise use the same preservation behavior as `duplicate`. |
| `duplicate` | Delete-aware (see below). When both sides exist, save remote as a `.conflict` file and keep local at the original path. |

The setting is stored as `conflictStrategy` in `AirSyncSettings` (values `auto_merge` \| `prefer_local` \| `duplicate`).

> NOTE: an interactive `ask` strategy existed in an earlier version. It was removed (it always fell back to `duplicate` anyway). A vault saved while it was selected is normalized to `duplicate` on load (`normalizeConflictStrategy` in `settings-normalize.ts`).

## prefer_local proof boundary

`prefer_local` is a conflict-resolution policy, not a general direction rule. Ordinary one-sided changes still push or pull normally. Admission authorizes local-wins only when current facts prove a bilateral edit of the same previously synchronized file. The proof is deliberately unavailable without a committed baseline, for edit/delete conflicts, or for compound identity/topology conflicts; those cases preserve the surviving or competing versions through the existing duplicate route.

The proof/read predicate is a responsibility-local pure helper, not a generic strategy
service: Observation may answer only whether more facts must be acquired, while the
Admission helper owns the exhaustive mapping to `auto_merge`, `local_win`, or
`preserve`. Every conflict action carries that closed policy together with its protocol.

This boundary prevents an old device from overwriting newer remote content merely because it cold-started. A first sync, schema cold-start, cleared sync state, or any missing hash cannot establish which side is the intended local edit, so differing files are preserved as two versions. COLD, WARM, and HOT acquisition therefore produce the same decision from the same complete facts.

## auto_merge fallback chain

`resolveAutoMerge()` implements a cascading resolution:

```
auto_merge
  ├── local + remote + baseline all present?
  │     ├── yes → attempt 3-way merge
  │     │           ├── merge-eligible (text, <=1 MB) + base content in store?
  │     │           │     ├── success (no conflicts) → write merged to both sides → "merged"
  │     │           │     ├── has conflicts (markers) → write merged to both sides → "merged" (hasConflictMarkers: true)
  │     │           │     └── JSON/Canvas with conflict markers OR invalid-JSON result → duplicate
  │     │           └── not eligible / no base → newer-wins fallback
  │     └── no  → newer-wins
  └── newer-wins
        ├── one side deleted → other side wins
        ├── both deleted → no-op (kept_local)
        ├── both exist, both mtimes > 0 → newer wins (overwrites older side)
        ├── same mtime + same content → keep local (content identical)
        └── same mtime or unknown mtime, different content → duplicate
```

The 3-way merge branch is only reachable when the `enableThreeWayMerge` setting is true (default `true`). That setting gates whether base content is persisted at commit time (`state-committer.ts`): when off, no base content is stored, so `stateStore.getContent()` returns undefined and `auto_merge` always falls back to newer-wins (`keep_newer`). Stored base content is compressed in IndexedDB (`store/content-codec.ts`); `getContent()` decodes it transparently, so the merge always sees the original bytes. `resolveAutoMerge` itself never reads the setting — the gate is entirely upstream at commit time, expressed as the presence or absence of stored base content. Base content is also only stored for merge-eligible files (see eligibility), so non-eligible files never have base content to merge.

Content identity in newer-wins is determined by `sameContent()`, which compares `FileEntity.hash`, falling back to `remoteChecksum` (the typed `{ algo, value }` checksum used by backends like Google Drive that return `hash:""` from list/stat). If either side lacks a usable checksum, the pair is treated as different content and resolved as a duplicate.

## 3-way merge

Implemented in `merge.ts` using `node-diff3`. `diffIndices(base, side)` computes each side's line hunks, which drive both overlap detection and clean (non-overlapping) merges. When hunks overlap, `diff3Merge(local, base, remote)` emits minimal per-hunk conflict markers.

**Eligibility** (`isMergeEligible()`):
- The larger of the two sides' sizes (`Math.max(local.size, remote.size)`) must be <= `MAX_MERGE_SIZE` (1 MiB = 1024*1024 = 1,048,576 bytes). The check is strict greater-than (`size > MAX_MERGE_SIZE`), so a file of exactly 1,048,576 bytes is still eligible. (At commit time, base-content persistence checks the single `localSize` instead.)
- Extension in the fixed `TEXT_EXTENSIONS` allowlist (not a content sniff): `.md`, `.txt`, `.json`, `.canvas`, `.css`, `.js`, `.ts`, `.html`, `.xml`, `.yaml`, `.yml`, `.csv`, `.svg`, `.tex`, `.bib`, `.org`, `.rst`, `.adoc`, `.toml`, `.ini`, `.cfg`, `.conf`, `.log`, `.sh`, `.bash`, `.zsh`, `.fish`, `.py`, `.rb`, `.lua`, `.sql`, `.graphql`, `.env`, `.gitignore`

**Merge process** (`threeWayMerge()`):
1. Normalize CRLF to LF in all three inputs
2. Short-circuit before diffing: if base==local return remote; if base==remote return local; if local==remote return either side (identical)
3. Compute independent diffs: `diffIndices(base, local)` and `diffIndices(base, remote)`. If diffing produced zero hunks on one side (unchanged from base), return the other side
4. Check if any hunk pair overlaps in base line ranges. Overlapping hunks with identical content (false conflicts) are skipped
5. No overlaps → apply both sides' clean hunks to a copy of base in descending `baseStart` order. Overlap uses half-open ranges with a minimum width of 1, so adjacent but non-overlapping changes (insertions and deletions) merge cleanly. Overlaps → insert conflict markers via `diff3Merge`
6. If LOCAL or REMOTE used CRLF (base is ignored for this decision), convert output back to CRLF
7. Return `{ success, content, hasConflicts }`. All short-circuit and zero-overlap paths are clean `success: true` results (`hasConflicts: false`, no markers)

Conflict markers use labels `LOCAL` and `REMOTE`:
```
<<<<<<< LOCAL
local version
=======
remote version
>>>>>>> REMOTE
```

**JSON/Canvas guard**: if the file extension is `.json` or `.canvas` and the merge has conflicts (or the result is invalid JSON), the resolver falls back to `duplicate` instead of writing broken JSON. The guard validates only the merged output (not the inputs), runs for both clean and conflicted merges, and matches the extension case-insensitively via `getFileExtension()`.

**Rollback**: writes happen local-first, then remote. If the remote write throws, the local file is restored to its pre-merge content with the original `local.mtime`, and the remote write error is re-thrown (so the conflict action is reported as failed). Separately, if `threeWayMerge` itself throws, the resolver falls back to its configured fallback (`keep_newer` by default) — no rollback is needed because nothing was written yet.

## Conflict file naming

`generateConflictPath()` in `conflict.ts` creates duplicate paths:

- `notes/file.md` -> `notes/file.conflict.md`
- If that exists: `notes/file.conflict-2.md`, `notes/file.conflict-3.md`, ..., up to 100
- Beyond 100: a single timestamp suffix (`.conflict-{Date.now()}`) — a same-path, same-millisecond collision on top of 100 existing copies is not a real scenario
- The suffix is inserted before the file extension, or appended to the end for extensionless paths
- Checks all involved filesystems to avoid overwrites on either side

## Internal resolver strategies

`conflict.ts` defines `ResolverStrategy` — low-level building blocks used internally by `resolveConflict()`:

| Strategy | Behavior |
|----------|----------|
| `keep_newer` | Compare mtime; newer side overwrites the other |
| `duplicate` | Delete-aware (see below); when both sides exist, save remote copy with `.conflict` suffix and keep local |
| `auto_merge` | Attempt 3-way merge, fall back to `keep_newer` |

These are not exposed in the settings UI. Internally, `keep_newer` delegates the actual write to two helpers — push-local-to-remote (or delete remote when local is gone) and pull-remote-to-local (or delete local when remote is gone) — which surface as the `kept_local` / `kept_remote` actions.

`duplicate` is delete-aware. If exactly one side is deleted, the surviving version is restored to the deleted side (action `duplicated`, no `.conflict` file). If both sides are deleted, nothing happens (action `kept_local`). Only when both sides exist is the remote saved as a `.conflict` duplicate on BOTH local and remote, the local file kept at its original path, and that local version also pushed to remote at the original path (action `duplicated`).

`keep_newer` and `duplicate` preserve source mtimes on the written copies. A successful 3-way merge is the only resolver path that instead stamps both sides with the current time (`Date.now()`), which affects subsequent newer-wins comparisons.

## Conflict history

`ConflictHistory` (`conflict-history.ts`) is an audit-log writer for conflict resolutions, targeting `.airsync/conflicts/{device}.json`.

It is wired into the sync pipeline via the orchestrator's `recordConflicts` hook: `main.ts` passes `recordConflicts: (records) => this.conflictHistory.append(records)` into `SyncOrchestrator`, so each resolved conflict is appended as a `ConflictRecord`.

```typescript
interface ConflictRecord {
  path: string;
  actionType: SyncActionType;
  strategy: ConflictStrategy;
  action: "kept_local" | "kept_remote" | "duplicated" | "merged";
  local?: FileEntity;
  remote?: FileEntity;
  duplicatePath?: string;
  hasConflictMarkers?: boolean;
  resolvedAt: string;   // ISO timestamp
  sessionId: string;
}
```

- Maximum 500 records per device file (`MAX_RECORDS`); trimming keeps the newest 500 (slice from the tail) on append. `append([])` is a no-op
- `load()` returns `[]` for a missing file or any read/parse error (never throws)
- The file is written as pretty-printed JSON (2-space indent). Parent dirs `.airsync` and `.airsync/conflicts` are each created only if missing
- The device name is pre-sanitized (same as logging)

Field contract: `action` is copied from the resolver's `ConflictResolutionResult.action`. `actionType` is the originating `SyncActionType` (`"conflict"` for the standard path). `strategy` is projected from the exact admitted action's `ConflictExecutionPolicy`, so a later settings change cannot alter audit provenance. `duplicatePath`/`hasConflictMarkers` are populated only when the resolution produced them.
