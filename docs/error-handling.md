# Error Handling

This document owns the resilience judgements: how failures are classified, retried, and
isolated, and what is deliberately *not* done. Classification and policy code lives in the
module pointers below.

## Error classification

Error classification is **backend-neutral and centralized** (`fs/errors.ts`), so the sync
engine and the fs-layer backends act on one taxonomy without knowing any backend's error
shape. A thrown value is reduced to transport-level facts (HTTP status and a parsed
`Retry-After`, handling both Fetch headers and plain header records; absence or unparseable
values become null), then mapped to a small retry-policy-facing classification:

| `kind` | Trigger | Policy |
|--------|---------|--------|
| `auth` | `AuthError` or 401 | abort, prompt to reconnect |
| `permission` | 403 (not a rate limit) | abort, prompt about permissions |
| `rateLimit` | 429 | retry, honoring `Retry-After` |
| `notFound` | 404 | stop retrying |
| `transient` | network blip / 5xx / unknown | retry with backoff |
| `permanent` | explicit backend/protocol invariant failure | stop retrying; quarantine only with a stable `permanentCode` |

A backend with a quirkier convention wraps this via the provider hook. Google Drive does:
a **403 that is actually a rate limit** is re-tagged as `rateLimit` (retry) rather than
`permission` (abort), detected from the error body's rate-limit reasons. This is the one
Drive-specific wrinkle the neutral classifier cannot know.

## Retry strategy

The retry **policy** is one pure function (`decideRetry` in `fs/errors.ts`) shared by every
retry site, so behaviour cannot drift and the policy is unit-testable with an injected RNG.
Given a classification it returns abort (`auth`/`permission`), stop (`notFound`/`permanent`),
retry with a delay, or exhausted; the delay honors a server-set `retryAfterMs` when present,
else full-jitter exponential backoff. The orchestrator classifies with the backend override
when present, else the neutral classifier, then decides.

Only a *thrown* error from a cycle triggers a *cycle-level* retry. Per-file failures are
caught inside execution and recorded without throwing, so they never cause a cycle-level
retry — a sync with failed or blocked actions returns a normal `partial_error` result. The
only error that propagates out of action execution is `AuthError`. Errors thrown *outside*
the per-action try/catch (Observation, Admission, Commit/finalization, settings save) do
reach the retry loop.

### Two retry layers

There are **two independent retry layers** (they do not multiply):

1. **Per-action, in-cycle**: each action's network I/O is retried a bounded number of times for `rateLimit`/`transient`, honoring `Retry-After` else the same jittered backoff, using the **same shared policy** as the cycle-level loop. `AuthError` is rethrown immediately (the only cycle-abort path); `permission`/`notFound` are not retried. An exhausted retry rethrows the *original* error so the per-action catch records it as a failure — a return, never a throw, so it does not reach the cycle-level loop. On a rate limit the transfer pool is signalled before the backoff sleep so its concurrency ceiling halves immediately. Net effect: a transient rate limit no longer defers a file to a forced-cold cycle, so cycles complete clean more often.
2. **Cycle-level**: only a *thrown* error (effectively `AuthError`, or an error outside per-action try/catch) re-runs the whole cycle.

Worst case for a single action is the per-action bound; it never compounds with the
cycle-level bound.

### Admission failures

If fresh rename reconciliation cannot prove one terminal state, Admission emits no
executable action for that identity component. The cycle remains visible as `partial_error`
and counts an ordinary error, but writes no pending operation, phase, or checkpoint. A later
ordinary trigger performs fresh acquisition; this is re-observation, not a promise that
unchanged contradictory evidence will converge. Legacy rename rows can only supply candidate
endpoints and never authorize a replayed effect.

### Non-retryable errors

`AuthError` and a non-rate-limit 403 abort immediately (with a reconnect / permission
notification). A 404 or a `permanent` error breaks the retry loop immediately with no
backoff; as a per-action error it is recorded as failed without an in-cycle retry.

## Rate limiting

Google Drive rate limits manifest as a 429 or a 403 with a rate-limit reason (re-tagged by
the Drive classifier). Both then retry under the shared policy, honoring `Retry-After` when
available and falling back to exponential backoff. A transport-level 401 auto-refresh-retry
happens inside the Google Drive client before errors reach the orchestrator-level loop — see
[google-drive-backend.md § Transport-level 401 retry](google-drive-backend.md#transport-level-401-retry).

## Recovery scenarios

| Scenario | Recovery |
|----------|----------|
| Network drop | Retry up to the bound with backoff; if all fail, status `error`. On network restore, the scheduler triggers a new sync. |
| Crash mid-sync | State commits per action after successful I/O; uncommitted actions are re-detected next cycle. See [sync-pipeline.md § State commit](sync-pipeline.md#state-commit). |
| IndexedDB eviction | The state store returns an empty set, triggering cold change detection, which treats all paths as candidates. |
| Auth error | `AuthError` aborts immediately. A 400/401 token-refresh failure arms a cooldown during which token acquisition short-circuits and throws without a network attempt; after the cooldown a refresh is retried. Reconnecting or any successful token store/refresh resets it, and non-400/401 refresh errors do not arm it. |
| Individual file error | Caught per-action; the failure is recorded, other actions continue, status `partial_error`. After one forced cold recovery, a repeated local-origin poison action classified `permanent` with a stable `permanentCode` may be blocked for a bounded period instead of executed again. See [sync-pipeline.md § Execution phases](sync-pipeline.md#execution-phases-lanetier-scheduling). |
| Mass deletion | No volume-based abort; erroneous deletions are prevented structurally. See [sync-pipeline.md § Deletion safety](sync-pipeline.md#deletion-safety). |
| Stale cache (Google Drive) | A write verifies the file ID has not changed during I/O; if stale, the cache update is skipped with a warning. |

## Per-file error isolation

Each action is wrapped in its own try/catch: only `AuthError` is re-thrown (aborting the
whole sync); every other error is recorded as a failed action so remaining actions
continue. The same isolation applies to ordinary and conflict actions, each with the
per-action retry above; execution's phases are described in
[sync-pipeline.md](sync-pipeline.md).

The orchestrator also keeps an in-memory failed-action tracker that never persists across
reloads. Only local-origin actions that are safe to skip after recovery and whose failure is
`permanent` with a stable `permanentCode` are eligible. If the same signature fails in two
consecutive cycles, the third cycle records it as blocked without executing its I/O;
success, action/content changes, action-type changes, a non-eligible classification, or the
TTL clear the block. Remote-origin and conflict actions are deliberately excluded, and
`transient`/`rateLimit` failures are deliberately excluded so a recovered provider is
retried immediately.

A local source changing, moving, or disappearing after the final pre-write check is not
itself an action failure when the executor already captured the admitted bytes and proves
the remote terminal contains them; it publishes that exact captured revision as the
historical baseline. This does not relax stale pre-write inputs, an unproved or corrupt
remote terminal, exact record CAS, or a pull whose remote source changes. See
[ADR 20260914](adr/adr-20260914-publish-captured-push-revision.md).

## Acknowledge pattern

Each sync cycle captures a snapshot of the tracker at the start, drives change detection
from it, and acknowledges exactly that snapshot at the end.

A full acknowledge (after a clean result) removes each snapshot dirty path and clears each
captured rename pair only when the live entry still equals the snapshot value — a mid-cycle
rename that re-created or overwrote that key differs from the snapshot and survives — then
marks the tracker initialized. A terminal partial result acknowledges only the
generation-aware relations, leaving dirty paths and initialization unchanged: a failed
content edit stays HOT, but a stale failed relation is not replayed forever. Using the
start-of-cycle snapshot is deliberate: a mid-cycle `markDirty`/rename is never swept.

A fatal error (AuthError, non-rate-limit 403, 404, or retries exhausted) returns no result
and preserves the whole snapshot. Folder rename events put both root addresses in the dirty
set; if those unbaselined roots are absent at address-local stat after relation abandonment,
HOT promotes to WARM to rediscover descendants, and a relation report recreated after
capture survives for the next cycle.

The priority pull acknowledges the path after completion (success or failure) to prevent
re-triggering, clearing only that path's dirty and rename-pair entry and intentionally
leaving folder-rename state and initialization untouched — a single-file pull must not wipe
pending folder renames or flip the tracker out of its cold-start state.

Hot mode requires the tracker to be initialized AND to have at least one dirty path; an
initialized tracker with no dirty paths uses warm mode, or cold mode when the state store is
empty. After a cycle with no concurrent edits the dirty set is empty, so the following cycle
(absent new edits) runs warm rather than hot.
