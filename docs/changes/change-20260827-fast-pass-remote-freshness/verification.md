---
change: change-20260827-fast-pass-remote-freshness
role: verification
evidence_refs:
- {type: test, ref: src/sync/priority-coordinator.test.ts}
- {type: test, ref: src/sync/orchestrator.test.ts}
- {type: contract, ref: src/fs/caching/remote-fs.contract.test.ts}
- {type: test, ref: src/fs/googledrive/targeted-observation.test.ts}
- {type: test, ref: src/fs/dropbox/targeted-observation.test.ts}
- {type: test, ref: src/fs/onedrive/targeted-observation.test.ts}
- {type: command, ref: npm run lint}
- {type: command, ref: npm run lint:bot-repro}
- {type: command, ref: npm run build}
- {type: command, ref: npm test}
---
# Verification — file-open priority with correct following batch

## North-star proof

A deterministic integration test pauses multiple normal actions after admission, opens
`note.md`, and records linearization events. Actions already admitted may complete. No
new normal action start may appear between priority enqueue and priority completion. The
priority attempt updates `note.md`; the following same-path planned action revalidates to
`match`/no-op; a same global delta sibling is still processed; and the normal checkpoint
commits only after clean dispositions.

Forbidden observations are: priority waits for the complete batch, file-open advances a
global cursor, delayed targeted metadata rewrites cache/root state, an edit observed
before mutation is overwritten, edit evidence observed during/after is acknowledged,
a stale normal action writes after priority, or a priority failure resolves as success.
Also forbidden are treating the Air Sync mutation lease as external atomic exclusion,
turning frozen older V1 back into pull, treating a same-id Dropbox root rename as a child
path change, authorizing a request with missing/malformed provider token or ancestry,
adding a live-E2E-dependent release/runtime switch, or losing a permit/counter under a
continuous open stream.

## T0 — unit and deterministic concurrency

- `verify-detached-no-mutation`: snapshot live/committed cursor, cache generation/content,
  and root anchor; delay a targeted result while applying a newer delta; assert all
  targeted-side shared state remains unchanged.
- `verify-authoritative-ancestry`: prove current identity/exact path and reject ancestor
  rename/move, ambiguous parents, root mismatch, delete, and same-path replacement. Its
  Dropbox cases race request-local root resolution with normal delta re-anchoring, preserve
  the relative child path across a same-id root rename, prove that
  `src/fs/dropbox/provider-base.ts::DropboxBackendData.remoteVaultFolderId` (the typed
  `settings.backendData.remoteVaultFolderId`) is passed through
  `src/fs/pkce-app-folder-provider.ts::PkceAppFolderProvider.createFs` to the
  `src/fs/dropbox/index.ts::DropboxFs` instance's inherited
  `src/fs/caching/remote-fs.ts::CachingRemoteFs.rootFolderId`, consume that instance value
  in the point-read, and
  prohibit reading or calling the shared root-path setter.
- `verify-priority-linearization`: enumerate enqueue before/after action-admit, during
  planning, during action failure, and before finalization; assert the state-machine
  partial order.
- `verify-coordinator-liveness`: throw from observation/read/write/callback and cancel on
  target switch; all permits and waiters settle exactly once. Enqueue distinct and
  duplicate paths around active permits; after the final enqueue assert the work-unit
  bound, and under continued arrivals assert strict priority, diagnostics, and no stranded
  counters.
- `verify-priority-cas`: edit local during queue wait and provider I/O, change record, and
  supersede remote token; interleave every `LocalFs.write` caller with tracker mark/ack
  transitions and assert the single path-lease order through final revalidation, write,
  record CAS, post-write tracker/content observation, and exact acknowledgement. Assert
  edits observed before mutation return `local_changed` without writing; later/different
  edit evidence observed during or after the write is never acknowledged and remains
  dirty. Exercise a simultaneous external adapter write after the Air Sync linearization
  point only as the documented existing-normal-sync ordering limitation; do not assert
  or require an unavailable atomic fence.
- `verify-normal-action-replan`: priority changes baseline after batch planning; assert
  frozen V1 against applied V2 becomes terminal `superseded`/no-op and cannot call the
  pull executor. Incomparable versions defer and block clean commit.
- `verify-typed-handoff`: every typed failure reaches scheduler/orchestrator policy and no
  logger-only fulfilled success exists.
- `verify-content-equal-convergence`: record save fails after write; equal bytes/size
  restart with only stale record/current entities; assert the normal detector performs
  one local and one remote byte read for the exact same-size both-changed incomparable
  candidate, SHA-256 equality converges as match, and read failure/divergence reaches
  conflict Admission without consulting a marker.

Focused commands:

```bash
npm test -- src/fs/caching/remote-fs.contract.test.ts
npm test -- src/fs/googledrive/targeted-observation.test.ts src/fs/dropbox/targeted-observation.test.ts src/fs/onedrive/targeted-observation.test.ts
npm test -- src/sync/priority-coordinator.test.ts src/sync/plan-executor.test.ts
npm test -- src/sync/local-mutation-barrier.test.ts src/fs/local/local-fs.test.ts src/sync/orchestrator.test.ts src/sync/scheduler.test.ts src/sync/state.test.ts src/sync/local-tracker.test.ts src/sync/change-detector.test.ts src/sync/decision-engine.test.ts src/sync/sync-cycle-finalization.test.ts
```

## T1 — shared behavior and integration

Run the provider-targeted suite through one shared behavior factory for all three
backends. It must cover current update, unchanged, missing, directory, replacement,
ancestor move, root ambiguity, token supersession, auth/rate/provider error, and
no-global-state mutation. Google cases use numeric file `version`; Dropbox uses
id/`rev`/content hash with opaque inequality and request-local current root proof;
OneDrive uses id/`cTag`/quickXor with `eTag` equality fallback. Missing required fields
and empty, malformed, or non-numeric required tokens/identity/ancestry must be
per-request fail-closed `unverifiable` outcomes. These shared fake/contract cases are
mandatory and run in the ordinary repository gate; they are the acceptance proof for
provider token and ancestry semantics.

Run normal crash-safety/change-detection contracts unchanged to prove that detached
observation did not weaken initial, persisted, reset, rename, delete, non-replay, or
commit-last behavior:

```bash
npm test -- src/fs/googledrive/crash-safety-contract.test.ts src/fs/dropbox/crash-safety-contract.test.ts src/fs/onedrive/crash-safety-contract.test.ts
npm test -- src/fs/googledrive/remote-change-detection.test.ts src/fs/dropbox/remote-change-detection.test.ts src/fs/onedrive/remote-change-detection.test.ts
npm test -- src/fs/caching/remote-fs.contract.test.ts src/sync/orchestrator.test.ts src/sync/plan-executor.test.ts
```

Required adversarial integration witnesses:

- opened path plus unopened sibling in one global delta;
- same-path planned pull and priority update overlap;
- priority arrives with several transfer-pool actions already admitted;
- user edit after enqueue and after bound read;
- delayed old targeted observation while delta applies a newer metadata generation;
- Dropbox root moves during targeted observation and normal delta processing;
- Google Drive/OneDrive ancestor moves while child metadata also changes;
- local write succeeds and record save fails;
- priority enqueue races finalization seal and backend target switch.
- final enqueue followed by quiescence and a separate continuous-arrival diagnostic run;
- external adapter write after the Air Sync mutation linearization point, with the test
  asserting only that observed later/different evidence is not acknowledged and remains
  dirty, not that the adapter write is atomically excluded;

## T2 — optional credentials-gated live fidelity

Run `npm run test:e2e:google`, `npm run test:e2e:dropbox`, and
`npm run test:e2e:onedrive` independently when that provider's credentials are available.
For each provider, create an external update, observe/read/reobserve it, rename/move an
ancestor (and for Dropbox rename the same root id), and preserve a same-batch sibling.
Record token change/equality, current-path ancestry, request count, and bound-read result.

T2 remains outside the ordinary CI/repository gate and cannot replace T0/T1. It is
optional, non-gating fidelity evidence only. Missing credentials, no run, or a failed
live case creates no release/runtime capability state or receipt lifecycle and does not
alter provider availability; investigate the observation without weakening the mandatory
contract. Per-request missing/malformed token or ancestry still returns `unverifiable`
and performs no priority write. No latency or page threshold is an acceptance gate.

## Mechanical gate

After focused tests, run exactly:

```bash
npm run lint
npm run lint:bot-repro
npm run build
npm test
```

All four commands must pass. Existing tests may be strengthened or extended but not
disabled, skipped, or loosened.

## Closure criteria

Verification is complete only when AC-FAST-PASS-01 through AC-FAST-PASS-09 are each
covered by a named normal and adversarial witness, all three provider implementations
pass the shared contract, the old global-mutating `statFresh` behavior is absent, and the
repository gate is green. Live E2E absence or failure is supplemental evidence to record
and investigate, never a repository, release, or runtime provider-capability gate.

## Observed implementation evidence — 2026-08-27

- `src/sync/priority-coordinator.test.ts`: current normal permit only, strict priority,
  duplicate-path coalescing, priority-before-finalization, and normal resume all pass.
- `src/sync/plan-executor.test.ts`: admission-time `superseded` performs no remote write;
  `deferred_stale_plan` is checkpoint-blocking.
- `src/sync/orchestrator.test.ts`: detached apply updates content/one `SyncRecord`, local
  edits fail closed, missing baseline is ineligible, and post-write record CAS failure
  retains tracker evidence as `applied_unbaselined`.
- Provider suites `googledrive/targeted-observation.test.ts`,
  `dropbox/targeted-observation.test.ts`, and `onedrive/targeted-observation.test.ts`
  pass token validation, request-local path/root proof, bound read/re-observation, and
  malformed/missing evidence rejection.
- `src/fs/caching/remote-fs.contract.test.ts` proves the opened-file observation leaves
  the same multi-path global delta available to the following normal lifecycle.
- Repository gate: `npm run lint`, `npm run lint:bot-repro`, `npm run build`, and
  `npm test` all passed on the same worktree; Vitest reported 100 files / 1621 tests.
- Optional credential-gated live provider E2E was not run and is not a closure gate.
