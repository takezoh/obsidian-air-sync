# Error Handling

## Error classification

`getErrorInfo()` (`sync/error.ts`) extracts structured information from errors:

```typescript
interface ErrorInfo {
  status: number | null;     // HTTP status code
  retryAfter: number | null; // Retry-After header value in seconds
}
```

It handles both Fetch API `Headers` objects and plain `Record<string, string>` headers. The `Retry-After` header is parsed as either a number of seconds or an HTTP-date (RFC 7231). `status` is taken from `err.status` if present (no numeric validation). For an HTTP-date `Retry-After`, `retryAfter` is the relative delay in seconds: `max(0, ceil((parsedDate - now) / 1000))`. Both fields are `null` when absent or unparseable.

`isRateLimitError()` checks whether a 403 error is actually a Google Drive rate limit by inspecting `error.json.error.errors[].reason` for:
- `rateLimitExceeded`
- `userRateLimitExceeded`
- `dailyLimitExceeded`

This distinction is important because 403 rate limits should be retried, while 403 permission errors should not.

## Retry strategy

`SyncOrchestrator.runSync()` wraps `executeSyncOnce()` in a retry loop:

- **Maximum retries**: 3 (`MAX_RETRIES`)
- **Backoff**: exponential with jitter -- `2^(attempt-1) * 1000 * (0.5 + random())` ms
- **Rate-limit override**: a non-rate-limit 403 has already aborted earlier; among surviving errors, if `status` is 429 or 403 and `retryAfter !== null`, the delay is `retryAfter * 1000` ms instead of computed backoff

Only a *thrown* error from `executeSyncOnce()` triggers a retry. Per-file failures are caught inside `executePlan` (in `executeAction`/`executeConflictAction`) and recorded in `result.failed` without throwing, so they never cause a retry — a sync with failed actions returns a normal result reported as `"partial_error"`. The only error that propagates out of action execution is `AuthError` (re-thrown to abort the whole sync). Errors thrown *outside* per-action try/catch — change detection (`collectChanges`), planning (`planSync`/`refinePlan`), or `saveSettings` — do reach the retry loop.

### Non-retryable errors

| Error | Behavior |
|-------|----------|
| `AuthError` | Immediate abort, status set to `"error"`, notification to reconnect |
| 403 (non-rate-limit) | Immediate abort, permission denied notification |
| 404 | Break the retry loop immediately (no backoff); falls through to the generic failure tail → status `error`, notification `Sync error: <message>`, returns null. The retries-exhausted case (`attempt === MAX_RETRIES`) reaches the same tail. |

## Rate limiting

Google Drive rate limits manifest as:

| Status | Condition | Detection |
|--------|-----------|-----------|
| 429 | Too Many Requests | `getErrorInfo().status === 429` |
| 403 | Rate limit exceeded | `isRateLimitError()` checks `error.json` for rate limit reasons |

Both are retried with the `Retry-After` header value when available, falling back to exponential backoff.

A transport-level 401 auto-refresh-retry happens inside `GoogleDriveClient.request()` before errors reach this orchestrator-level retry loop — see [google-drive-backend.md § Transport-level 401 retry](google-drive-backend.md#transport-level-401-retry).

## Recovery scenarios

| Scenario | Recovery |
|----------|----------|
| Network drop | Retry up to 3x with backoff. If all retries fail, set status to `"error"`. On network restore (`online` event), `SyncScheduler` triggers a new sync. |
| Crash mid-sync | State is committed per action after successful I/O; uncommitted actions are re-detected next cycle. See [sync-pipeline.md § State commit](sync-pipeline.md#state-commit). |
| IndexedDB eviction | `GoogleDriveFs` falls back to cold path (full scan). `SyncStateStore` returns empty `getAll()`, triggering cold change detection which does a full outer join. `resolveEmptyHashes` is implicit: cold mode treats all paths as candidates. |
| Auth error | `AuthError` causes immediate abort. On a 400/401 token-refresh failure, `GoogleAuthBase.handleRefreshError()` records `authFailedAt = Date.now()`; for the next `AUTH_FAILED_COOLDOWN` (60 s) `getAccessToken()` short-circuits and throws `AuthError(401)` without attempting a refresh. After the cooldown a refresh is retried. Reconnecting (`setTokens()`) or any successful token store/refresh (`storeTokenResponse()`) resets `authFailedAt = 0`. Non-400/401 refresh errors are re-thrown unchanged and do not arm the cooldown. |
| Individual file error | Caught per-action; the failed action is recorded in `result.failed`, other actions continue, status set to `"partial_error"`. See [sync-pipeline.md § Execution groups](sync-pipeline.md#execution-groups) and [Per-file error isolation](#per-file-error-isolation) below. |
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

Execution is grouped and ordered. Group A (`push`, `pull`, `match`, `cleanup`) runs concurrently, bounded to 5 in-flight actions via `AsyncPool(POOL_CONCURRENCY = 5)` and awaited with `Promise.all`. Group B (`rename_remote`, `rename_local`, `delete_remote`) runs serially. Group C (`delete_local`) runs serially. Group D (`conflict`) runs serially via `executeConflictAction` (which may show a UI modal). Both `executeAction` and `executeConflictAction` apply the same per-action isolation: each action is wrapped in its own try/catch that re-throws only `AuthError` (aborting the whole sync) and records every other error in `result.failed` so remaining actions continue.

## Acknowledge pattern

`LocalChangeTracker.acknowledge(paths)` is called only after a successful sync cycle completes:

```typescript
// In orchestrator.runSync():
const allPaths = this.deps.localTracker.getDirtyPaths();
this.deps.localTracker.acknowledge(allPaths);
```

`acknowledge(paths)` for each path removes it from `dirtyPaths` and from `renamePairs` (keyed by `newPath`, so a rename pair is only dropped when its `newPath` is acknowledged); it then clears the entire `folderRenamePairs` map regardless of the `paths` argument (even `acknowledge([])` wipes all folder rename pairs), and sets `initialized = true`.

`acknowledge` is reached only when `executeWithRetry()` returns a non-null result. A *fatal* error — `AuthError`, a non-rate-limit 403, a 404 (which breaks the retry loop), or retries exhausted — returns null, so `runSync` returns early at `if (!result) return;` and dirty paths are preserved for the next cycle. A *per-file* failure (recorded in `result.failed`, status `partial_error`) still completes the cycle, so `acknowledge(getDirtyPaths())` runs and clears those paths from the dirty set. Because a failed action never commits a `SyncRecord`, the baseline mismatch persists and the file is re-detected next cycle via warm/cold change detection, not via the dirty set.

The `pullSingle()` method also calls `acknowledge([path])` after completion (success or failure) to prevent re-triggering the file-open priority sync for the same path.

Setting `initialized = true` is a precondition for hot-mode change detection, but hot mode is selected only when the tracker is initialized AND has at least one dirty path (`collectHot`); an initialized tracker with no dirty paths uses warm mode, or cold mode when the state store is empty. Because `acknowledge()` clears the acknowledged paths from the dirty set, the immediately following cycle, absent new edits, runs in warm mode rather than hot.
