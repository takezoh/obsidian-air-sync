---
change: change-20260904-remote-working-view-abort
role: requirements
functional_requirements:
- id: FR-WV-001
  statement: An incomplete checkpoint-capable attempt shall invoke a required idempotent
    live-only abort and leave provider state and the durable checkpoint unchanged.
  priority: must
- id: FR-WV-002
  statement: Finalization shall commit exactly a wholly safe cycle, abort every incomplete
    result, and abort after commit rejection before propagation.
  priority: must
- id: FR-WV-003
  statement: Observation through execution exceptions shall abort before classification
    or retry, while post-closeout backend-state or settings errors shall not issue
    a second abort.
  priority: must
- id: FR-WV-004
  statement: AuthError and InternalFreshInvariantError shall invalidate queued work,
    settle scheduled siblings, and rethrow the exact rejection selected by the existing
    aggregate before discard.
  priority: must
- id: FR-WV-005
  statement: Equivalent durable and current facts shall converge through ordinary
    COLD, WARM, or HOT acquisition without prior-error state.
  priority: must
- id: FR-WV-006
  statement: Checkpoint presence and scope queries shall read durable metadata only
    and conservatively return false or null on absence or read failure, while reset
    alone remains destructive.
  priority: must
- id: FR-WV-007
  statement: Priority invalidation or checkpointBlocked shall abort, while an exact
    completed pull superseded by priority remains terminal for a clean commit.
  priority: must
- id: FR-WV-008
  statement: Google Drive, Dropbox, and OneDrive shall run one shared observable abort
    and replay contract without provider-specific recovery policy.
  priority: must
- id: NFR-WV-001
  statement: The change shall add no durable authority, schema, migration, recovery
    ledger, intermediate correctness state, or replacement orchestrator field.
  priority: must
- id: NFR-WV-002
  statement: Tests shall distinguish live from durable facts and fail when abort is
    absent, a no-op, or races scheduled siblings.
  priority: must
---

<!-- lifecycle is owned by change.md -->

# Requirements

- **FR-WV-001 — checkpoint-owned abort:** When a checkpoint-capable sync attempt does not publish a clean checkpoint, the system shall call the required `IncrementalCheckpoint.abortWorkingView()` operation, which clears only the current live cache/cursor/scope/initialization view under the existing mutex and performs no durable or provider mutation.
- **FR-WV-002 — exhaustive closeout:** When Admission rejects, execution returns failed or blocked work, terminal proof is missing, or priority sets `checkpointBlocked`, finalization shall abort and shall not commit; when all admitted work is terminal and unblocked, finalization shall commit and shall not abort. If commit rejects, abort shall complete before classification or retry.
- **FR-WV-003 — exceptional ordering:** If observation, preparation, Admission, or execution rejects, the attempt shall abort before error classification, sleep, retry, notification, or return. If `readBackendState` or `saveSettings` rejects after checkpoint closeout, the system shall preserve the completed commit-or-abort result and shall not issue a second abort.
- **FR-WV-004 — fatal settlement:** When `AuthError` or `InternalFreshInvariantError` escapes an action, the existing batch lifecycle shall enter `aborting` before permit release, every promise already scheduled in the active parallel join shall settle, and only then shall `executePlan` rethrow the exact rejection that the existing fail-fast `Promise.all` selected. Queued actions shall perform no provider I/O and no later phase shall start.
- **FR-WV-005 — ordinary convergence:** When an incomplete attempt is rerun in the same process, COLD, WARM, or HOT shall be selected only from durable checkpoint/scope facts, current `SyncRecord`s, and the current tracker snapshot. Equivalent current facts shall converge without prior-error input, forced-recovery mode, or a replacement for `recoverViaColdScan`.
- **FR-WV-006 — durable queries and reset separation:** `hasCheckpoint` and `getScopeFingerprint` shall query the durable metadata store only; absence or read failure shall return `false`/`null` and conservatively select the ordinary COLD path. An uncommitted fresh scan shall not change those answers. `resetCheckpoint` shall remain the only operation that clears durable checkpoint data and shall be used only by existing explicit Rescan/identity lifecycle paths.
- **FR-WV-007 — priority and supersession:** When detached priority evidence invalidates a batch or blocks its checkpoint, the batch shall abort and the requested normal lifecycle shall re-observe from the durable boundary. A priority-completed exact admitted pull that is marked superseded remains terminal for a clean commit and shall not by itself force abort.
- **FR-WV-008 — provider-shared replay:** Google Drive, Dropbox, and OneDrive shall run one shared checkpoint contract proving same-instance replay after abort, first-scan/no-checkpoint behavior, arbitrary-prefix paginated failure, checkpoint failure, scope restoration, folder-rename replay, replay-free subtree snapshots, crash reconstruction, and abort/reset separation without provider-specific recovery policy.
- **NFR-WV-001 — closed authority set:** The change shall remove `recoverViaColdScan` and shall add no durable state, store, schema/version, migration, journal, pending-work ledger, replacement orchestrator field, or second working-view snapshot. The only durable correctness authorities remain successful per-file `SyncRecord`s and the complete remote cache/cursor/scope checkpoint committed after a wholly clean cycle.
- **NFR-WV-002 — discriminating verification:** Tests shall keep durable and live cursor/cache facts distinct and shall fail if abort is omitted or races executor siblings. A no-op abort spy or delta fake that repeats without rollback shall not be the sole convergence evidence.

## Acceptance

- Every returned or exceptional lifecycle path has exactly the commit/abort behavior in the design lifecycle table.
- Abort never calls `MetadataStore.saveAll`, `MetadataStore.clear`, or a provider API; reset still clears durable and live checkpoint data.
- A started fatal sibling completes its effect and per-file commit before abort, a queued sibling performs no I/O, and the originally selected rejection object is rethrown after settlement.
- COLD, WARM, and HOT stateful cases rediscover uncommitted remote work and converge to the same endpoint bytes and records.
- Durable getter failure yields `false`/`null`, does not expose live values, and drives normal COLD observation without adding recovery state.
- A post-checkpoint settings failure causes no additional abort and preserves the already completed checkpoint result.
- All three production provider registrations pass the shared abort/replay, paginated-failure, fresh-scan, and folder-rename cases.
- Ownership guards and the full gate find no new correctness owner and no weakened commit-last test.
