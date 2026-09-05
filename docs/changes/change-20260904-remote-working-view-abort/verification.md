---
change: change-20260904-remote-working-view-abort
role: verification
---

<!-- lifecycle is owned by change.md -->

# Verification

## Adversarial matrix

| Profile | Tier | Command | Pass condition |
|---|---|---|---|
| Checkpoint owner | T1 wired | `npm test -- tests/fs/remote-backend-contracts.test.ts` | Live-only abort restores same-instance replay; fresh scan does not create a durable checkpoint; getter read failures return `false/null`; reset remains destructive. |
| Returned closeout | T0 contract | `npm test -- src/sync/sync-cycle-finalization.test.ts` | Admission reject, failed, blocked, missing proof, and `checkpointBlocked` abort and never commit; clean and priority-superseded terminal outcomes commit and never abort. |
| Exceptional closeout | T1 wired | `npm test -- src/sync/orchestrator.test.ts` | Observation/preparation/Admission/execution/commit exceptions abort before classification or retry; post-closeout settings errors cause no second abort; no-capability cycles remain valid. |
| Executor settlement | T0 contract | `npm test -- src/sync/plan-executor.test.ts` | `AuthError` and `InternalFreshInvariantError` invalidate queued work; started siblings settle; later phases do not start; the exact rejection selected by the original aggregate is rethrown afterward. |
| Temperature convergence | T1 wired | `npm test -- src/sync/orchestrator.test.ts` | Stateful COLD/WARM/HOT cases are blind without abort, then rediscover the same remote gap and converge after abort with no prior-error state. |
| Ownership | T0 structural | `npm run lint:bot-repro` | `recoverViaColdScan` is absent and no replacement field/store/schema/writer or weakened state-owner fixture appears. |
| Full gate | T2 repository | `npm run lint && npm run lint:bot-repro && npm run build && npm run test:coverage` | All project gates pass with the revised shared contract registered for all three providers. |

## Required counterexamples

1. **Durable/live split:** commit baseline A, consume remote delta B into the live view, show a second same-instance read is blind, abort, then prove the next read reports B from durable cursor A. A fake that always reports B fails the setup requirement.
2. **First scan:** with an empty store, let cursor-before-list finish and leave the cycle non-clean. `hasCheckpoint` remains false, abort leaves the store empty, and the next run performs the ordinary COLD scan.
3. **Durable read failure:** inject `MetadataStore.getMeta` failure while live fields contain newer values. `hasCheckpoint`/`getScopeFingerprint` return `false/null`, never echo live values, and ordinary orchestration selects COLD.
4. **Commit failure:** advance live cursor and supply a new scope candidate, reject atomic save, then abort. The old durable cursor/scope remain and the same FS replays the delta.
5. **Post-closeout settings failure:** complete commit, then reject `readBackendState` and separately `saveSettings`. Abort count remains unchanged and a retry observes the committed cursor.
6. **Returned unsafe outcomes:** independently cover Admission failure, failed execution, blocked execution, missing fresh proof, and actionless priority `checkpointBlocked`; each must abort exactly once and never commit.
7. **Fatal settlement:** for each of `AuthError` and `InternalFreshInvariantError`, gate sibling B after it has begun and leave sibling C queued. A must select the same error object as the pre-change `Promise.all`; before B releases, neither executor rejection nor abort may occur. After release, B's `SyncRecord` exists, C made no provider call, no later phase started, and only then the same object is observed.
8. **Mixed rejection selection:** arrange two deferred rejections at one existing aggregate and resolve/reject them in the order that makes pre-change `Promise.all` select a known object. Settlement delays observation but must not substitute another reason by type or input order.
9. **Priority:** a priority-completed exact superseded pull remains terminal and permits commit; detached invalidation/`checkpointBlocked` aborts and its already requested normal lifecycle replays from durable facts.
10. **No checkpoint capability:** remove `remoteFs.checkpoint`, not merely its cursor. Clean and incomplete cycles invoke neither commit nor abort and continue through ordinary list/stat observation.
11. **Arbitrary-prefix pagination:** for each provider registration, make a later page fail after zero or more live derived updates may have occurred. The test asserts no provider-specific prefix amount; after abort and removal of the injected failure, the same instance replays the complete delta from the durable cursor.
12. **Folder rename replay:** consume a folder rename, inspect `listCurrentSnapshot`, fail before checkpoint, abort, and repeat. The same rename pair and reparented descendants must reappear without consuming an extra delta.

## Provider registration proof

`tests/fs/remote-backend-contracts.test.ts` must continue to register the revised caching contract for exactly:

- `GoogleDriveFs` via `tests/fs/googledrive/caching-remote-fs.contract-harness.ts`;
- `DropboxFs` via `tests/fs/dropbox/caching-remote-fs.contract-harness.ts`;
- `OneDriveFs` via `tests/fs/onedrive/caching-remote-fs.contract-harness.ts`.

The design does not assume whether a provider applies zero, one, or several pages before failure. Only whole-view invalidation and durable-cursor replay are normative.

## Completion gate

Focused tests must pass before the full gate. Documentation closure additionally checks that ADR 0001, `AGENTS.md`, `docs/code-enforcement.md`, and the source ownership guard all describe exactly two durable authorities, the live view as attempt-bounded derived state, and no `recoverViaColdScan` successor.

## Verification results

- Focused lifecycle suite: 5 files, 400 tests passed.
- Full repository coverage: 90 files, 1,758 tests passed; all configured coverage floors passed.
- `npm run lint`, `npm run lint:bot-repro`, and `npm run build` passed.
- `docs_cli.py lint --conformance` passed with 39 indexed documents and no warnings.
- Dev-evidence matched every change path declared by this package. Its closure aggregate
  additionally reports the pre-existing ignored `.claude/settings.local.json` as an
  out-of-scope untracked path; normal `git status --untracked-files=all` does not expose
  that ignored user-owned file, and this change does not modify or include it.
