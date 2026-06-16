# Error Handling

## Error classification

Error classification is **backend-neutral and centralized in `fs/errors.ts`**, so the sync engine and the fs-layer backends all act on one taxonomy without knowing any backend's error shape.

`getErrorInfo()` (`fs/errors.ts`) extracts the transport-level facts from an arbitrary thrown value:

```typescript
interface ErrorInfo {
  status: number | null;     // HTTP status code
  retryAfter: number | null; // Retry-After header value in seconds
}
```

It handles both Fetch API `Headers` objects and plain `Record<string, string>` headers. The `Retry-After` header is parsed as either a number of seconds or an HTTP-date (RFC 7231). `status` is taken from `err.status` if present (no numeric validation). For an HTTP-date `Retry-After`, `retryAfter` is the relative delay in seconds: `max(0, ceil((parsedDate - now) / 1000))`. Both fields are `null` when absent or unparseable; a malformed negative `Retry-After` is clamped to 0.

`classifyHttpError()` (`fs/errors.ts`) maps those facts to a small, retry-policy-facing **`ErrorClassification`** (`{ kind, retryAfterMs? }`):

| `kind` | Trigger | Policy |
|--------|---------|--------|
| `auth` | `AuthError` or 401 | abort, prompt to reconnect |
| `permission` | 403 (not a rate limit) | abort, prompt about permissions |
| `rateLimit` | 429 | retry, honoring `retryAfterMs` |
| `notFound` | 404 | stop retrying |
| `transient` | network blip / 5xx / unknown | retry with backoff |

A backend with a quirkier convention wraps this in its own `classifyError` (the `IBackendProvider` hook). Google Drive does: `classifyGoogleDriveError()` (`fs/googledrive/errors.ts`) re-tags a **403 that is actually a rate limit** as `rateLimit` (retry) rather than `permission` (abort), detected by inspecting `error.json.error.errors[].reason` for `rateLimitExceeded` / `userRateLimitExceeded` / `dailyLimitExceeded`. This is the one Drive-specific wrinkle the neutral classifier can't know; everything else defers to `classifyHttpError`.

## Retry strategy

The retry **policy** is one pure function — `decideRetry(classification, attempt, maxRetries, rng)` (`fs/errors.ts`) — shared by every retry site so behaviour can't drift between them and the policy is unit-testable with an injected `rng`. Given a classification it returns `abort` (`auth`/`permission`), `stop` (`notFound`), `retry` (with a `delayMs`), or `exhausted`. The delay honors a server-set `retryAfterMs` when present, else full-jitter exponential backoff: `2^(attempt-1) * 1000 * (0.5 + rng())` ms.

`SyncOrchestrator.executeWithRetry()` drives each `executeSyncOnce()` cycle through that policy:

- **Classify**: `provider.classifyError?.(err) ?? classifyHttpError(err)` — the backend override (e.g. Google's 403-means-rate-limit) when present, else the neutral classifier.
- **Decide**: `decideRetry(classification, attempt, MAX_RETRIES = 3, Math.random)` — `abort`/`stop` end the loop early (no backoff); `retry` sleeps `delayMs` then re-runs; `exhausted` falls through to the generic failure tail.

Only a *thrown* error from `executeSyncOnce()` triggers a *cycle-level* retry. Per-file failures are caught inside `executePlan` (in `executeAction`/`executeConflictAction`) and recorded in `result.failed` without throwing, so they never cause a cycle-level retry — a sync with failed actions returns a normal result reported as `"partial_error"`. The only error that propagates out of action execution is `AuthError` (re-thrown to abort the whole sync). Errors thrown *outside* per-action try/catch — change detection (`collectChanges`), planning (`planSync`/`refinePlan`), or `saveSettings` — do reach the retry loop.

### Two retry layers

There are **two independent retry layers** (they do not multiply):

1. **Per-action, in-cycle** (`withIoRetry`, `plan-executor.ts`): each action's network I/O is retried up to `MAX_ACTION_RETRIES = 3` for `rateLimit`/`transient` classifications, honoring `Retry-After` (else the same jittered backoff) — the **same shared `decideRetry` policy** the cycle-level loop uses (see [Retry strategy](#retry-strategy)). It classifies via `ctx.classifyError` — the backend's own override (e.g. Google's 403-means-rate-limit) when present, else `classifyHttpError`. `AuthError` is rethrown immediately (the only cycle-abort path); `permission`/`notFound` are not retried. An exhausted retry rethrows the *original* error so the per-action catch records it in `result.failed` — a *return*, never a throw, so it does **not** reach the cycle-level loop. On a `rateLimit`, the transfer phase's `AdaptivePool` is signalled (`noteRateLimit`) before the backoff sleep so its concurrency ceiling halves immediately. Net effect: a transient 429 no longer defers a file to the next (forced-cold) cycle, so cycles complete clean more often (a clean cycle commits the checkpoint and avoids a repeated cold reconcile).
2. **Cycle-level** (`MAX_RETRIES = 3`, above): only a *thrown* error (effectively `AuthError`, or an error outside per-action try/catch) re-runs the whole cycle.

Worst case for a single action is `MAX_ACTION_RETRIES` (3) I/O attempts; it never compounds with `MAX_RETRIES`.

### Non-retryable errors

| Error | Behavior |
|-------|----------|
| `AuthError` | Immediate abort, status set to `"error"`, notification to reconnect |
| 403 (non-rate-limit) | Immediate abort, permission denied notification |
| 404 | Break the retry loop immediately (no backoff); falls through to the generic failure tail → status `error`, notification `Sync error: <message>`, returns null. The retries-exhausted case (`attempt === MAX_RETRIES`) reaches the same tail. |

## Rate limiting

Google Drive rate limits manifest as:

| Status | Condition | Classification |
|--------|-----------|----------------|
| 429 | Too Many Requests | `classifyHttpError` maps 429 → `rateLimit` |
| 403 | Rate limit exceeded | `classifyGoogleDriveError` re-tags 403 → `rateLimit` when `error.json.error.errors[].reason` is a rate-limit reason |

Both land on `rateLimit`, so `decideRetry` retries them honoring the `Retry-After` header value when available, falling back to exponential backoff.

A transport-level 401 auto-refresh-retry happens inside `GoogleDriveClient.request()` before errors reach this orchestrator-level retry loop — see [google-drive-backend.md § Transport-level 401 retry](google-drive-backend.md#transport-level-401-retry).

## Recovery scenarios

| Scenario | Recovery |
|----------|----------|
| Network drop | Retry up to 3x with backoff. If all retries fail, set status to `"error"`. On network restore (`online` event), `SyncScheduler` triggers a new sync. |
| Crash mid-sync | State is committed per action after successful I/O; uncommitted actions are re-detected next cycle. See [sync-pipeline.md § State commit](sync-pipeline.md#state-commit). |
| IndexedDB eviction | `GoogleDriveFs` falls back to cold path (full scan). `SyncStateStore` returns empty `getAll()`, triggering cold change detection which does a full outer join. `resolveEmptyHashes` is implicit: cold mode treats all paths as candidates. |
| Auth error | `AuthError` causes immediate abort. On a 400/401 token-refresh failure, `GoogleAuthBase.handleRefreshError()` records `authFailedAt = Date.now()`; for the next `AUTH_FAILED_COOLDOWN` (60 s) `getAccessToken()` short-circuits and throws `AuthError(401)` without attempting a refresh. After the cooldown a refresh is retried. Reconnecting (`setTokens()`) or any successful token store/refresh (`storeTokenResponse()`) resets `authFailedAt = 0`. Non-400/401 refresh errors are re-thrown unchanged and do not arm the cooldown. |
| Individual file error | Caught per-action; the failed action is recorded in `result.failed`, other actions continue, status set to `"partial_error"`. See [sync-pipeline.md § Execution phases](sync-pipeline.md#execution-phases-lanetier-scheduling) and [Per-file error isolation](#per-file-error-isolation) below. |
| Mass deletion | No volume-based abort; erroneous deletions are prevented structurally. See [sync-pipeline.md § Deletion safety](sync-pipeline.md#deletion-safety). |
| Stale cache (Google Drive) | `withCacheMutex()` verifies the file ID hasn't changed during I/O. If stale, the cache update is skipped with a warning. |

## Per-file error isolation

In `plan-executor.ts`, each action is wrapped in a try/catch:

```typescript
try {
  const { localEntity, remoteEntity } = await runActionIO(action, ctx);
  await commitAction(action, localEntity, remoteEntity, ctx.committer);
  result.succeeded.push({ action, localEntity, remoteEntity });
} catch (err) {
  if (err instanceof AuthError) throw err;  // re-throw to abort entire sync
  const error = err instanceof Error ? err : new Error(String(err));
  result.failed.push({ action, error });     // isolate, continue with other actions
} finally {
  reportProgress();
}
```

Execution runs in three phases (lane/tier scheduling — see [sync-pipeline.md](sync-pipeline.md)). Phase 1 runs transfers (`push`, `pull`) concurrently via an `AdaptivePool` (AIMD: desktop start 5 / max 10, mobile start 2 / max 3; +1 every 8 clean runs, halve on a rate-limit), with the state-only `match`/`cleanup` run inline; Phase 2 runs `conflict` serially in its own phase via `executeConflictAction`; Phase 3 runs the remote and local structural lanes concurrently, each doing its renames serially then its deletes pooled (`AsyncPool(DELETE_CONCURRENCY = 5)`). Both `executeAction` and `executeConflictAction` apply the same per-action isolation (and the per-action `withIoRetry` above): each action is wrapped in its own try/catch that re-throws only `AuthError` (aborting the whole sync) and records every other error in `result.failed` so remaining actions continue.

## Acknowledge pattern

Each sync cycle captures a `snapshot()` of the tracker at the start — a frozen copy of `dirtyPaths`, `renamePairs`, `folderRenamePairs`, and `initialized` — drives change detection from it, and acknowledges exactly that snapshot at the end:

```typescript
// In orchestrator.runSync(), once per do/while cycle:
const snapshot = this.deps.localTracker.snapshot();
// …change detection + execution read `snapshot`…
this.deps.localTracker.acknowledge(snapshot);
```

`acknowledge(snapshot)` removes each of the snapshot's dirty paths from `dirtyPaths`, and clears each captured rename pair and folder-rename pair **only when the live entry still equals the snapshot's value** — a mid-cycle rename that re-created or overwrote that key (a fresh pair, or the same `newPath` with a different source) differs from the snapshot and survives. It then sets `initialized = true`. Acknowledging the start-of-cycle snapshot rather than the live set is deliberate: a `markDirty`/rename arriving mid-cycle (after the snapshot was taken) is left intact for the next cycle instead of being swept — keeping it on the fast hot path instead of degrading the next cycle to a warm full-scan. This is robustness, not correctness: even if a mid-cycle change were swept, the unchanged baseline would re-surface it via warm/cold detection.

`acknowledge` is reached only when `executeWithRetry()` returns a non-null result. A *fatal* error — `AuthError`, a non-rate-limit 403, a 404 (which breaks the retry loop), or retries exhausted — returns null, so `runSync` returns early at `if (!result) return;` and the snapshot is never acknowledged, preserving the dirty set for the next cycle. A *per-file* failure (recorded in `result.failed`, status `partial_error`) still completes the cycle, so the snapshot is acknowledged and its paths are cleared from the dirty set. Because a failed action never commits a `SyncRecord`, the baseline mismatch persists and the file is re-detected next cycle via warm/cold change detection, not via the dirty set.

The `pullSingle()` method calls `acknowledgePath(path)` after completion (success or failure) to prevent re-triggering the file-open priority sync for the same path. Unlike `acknowledge`, it clears only that path's dirty and rename-pair entry, intentionally leaving `folderRenamePairs` and `initialized` untouched — a single-file pull must not wipe pending folder renames or flip the tracker out of its cold-start state.

Setting `initialized = true` is a precondition for hot-mode change detection, but hot mode is selected only when the tracker is initialized AND has at least one dirty path (`collectHot`); an initialized tracker with no dirty paths uses warm mode, or cold mode when the state store is empty. After a cycle with no concurrent edits the dirty set is empty, so the immediately following cycle (absent new edits) runs in warm mode rather than hot.
