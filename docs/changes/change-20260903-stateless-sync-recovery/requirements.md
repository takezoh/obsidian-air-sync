---
change: change-20260903-stateless-sync-recovery
role: requirements
---

<!-- lifecycle is owned by change.md -->

# Requirements

## Persistence invariant

- **REQ-PERSIST-1:** The system shall persist only a verified terminal unit's
  `SyncRecord` bundle, including its merge base where applicable, and the remote
  cache/cursor/scope checkpoint of a clean cycle.
- **REQ-PERSIST-2:** The system shall not persist observation, rename evidence,
  executable intent, debt, pending/deferred work, retry/quarantine state, or a startup
  resume instruction.
- **REQ-PERSIST-3:** If a unit fails before terminal verification, its prior `SyncRecord`
  shall remain unchanged. Other independently completed units remain committed facts.
- **REQ-PERSIST-4:** If Admission fails, execution fails, an action remains blocked, or
  the cycle is invalidated, the system shall not advance the remote checkpoint.

## EARS functional requirements

- **FR-OBSERVE:** When a sync begins after any error or process restart, the system shall
  derive decisions from the committed baseline and a current local/remote observation;
  it shall not replay a failed action or stored rename edge.
- **FR-RENAME:** When a local rename event is present in the current tracker snapshot,
  Admission may use it for native-rename optimization and remote-change conflict
  classification. When that snapshot is gone, the system shall use ordinary current-path
  add/change/delete/conflict rules and shall not infer a general rename.
- **FR-RENAME-EDIT:** When local name and content change while remote remains at the
  baseline, the system shall converge to the new local path and content without conflict.
  If remote also changed from the baseline, the existing conflict-preservation behavior
  shall retain both independently changed versions.
- **FR-CASE-CANDIDATE:** Where a committed old path and a currently observed local path
  differ only by exact casing, Observation shall derive a case-only candidate only when
  the local producer reports that exact resolved path, remote old has the expected stable
  identity and unchanged baseline version/content, and remote new is vacant or is the
  same identity returned as a casing alias. A foreign target identity shall reject the
  candidate. Stable id and exact canonical/display casing shall both participate in the
  check.
- **FR-RETRY:** When a user starts another sync after an error, every action authorized
  by the new snapshot shall be immediately executable. The system shall not suppress it
  because an equivalent action failed in an earlier cycle.
- **FR-DROPBOX:** When Dropbox executes an authorized case-only rename, it shall preflight
  old/new/temp using expected stable id plus exact display casing, perform `old -> temp ->
  new` only inside that invocation, and update its cache only after exact-new terminal
  verification.
- **FR-DROPBOX-ERROR:** If the second move returns an error, Dropbox shall re-observe all
  three endpoints. Exact new with expected id is success. Exact temp with expected id
  causes one rollback attempt to old followed by re-observation. Exact old alone with
  expected id is a verified unsuccessful result and returns the original error. Multiple
  placements, no placement, foreign occupancy, or failed observation is an indeterminate
  error and permits no further mutation or success claim.
- **FR-EXCLUSION:** Policy-excluded paths shall be removed before Observation supplies
  facts to Admission and shall never appear in rename evidence, actions, `SyncRecord`, or
  sync diagnostics.

## Constraints and honest limits

- Dropbox offers no atomic case-only folder move. A hard process kill between the two
  moves, or an unavailable/failed rollback, cannot be made crash-atomic without a journal
  or provider primitive. The system shall report this limit, not rename it as pending or
  deferred recovery.
- A deterministic temp name shall not encode or serve as a cross-cycle recovery journal,
  and initialization shall never scan or resume it.
- Existing bounded retries within one provider invocation remain transport policy; they
  are not cross-cycle state.

## Acceptance scenarios

- Given a rename effect fails, when sync is run again in the same process, then the
  unacknowledged tracker input and COLD current-state planning converge without any
  persisted intent row. Given a case-only rename is observed after restart, then the
  committed baseline and unchanged remote old path reconstruct the relation.
- Given a rename is reverted before retry and both endpoints match the baseline, when
  sync runs again, then it is a no-op rather than an Admission contradiction.
- Given a folder contains `desktop.ini`, when its managed content is synchronized, then
  `desktop.ini` is absent from observation, evidence, actions, records, and diagnostics.
- Given Dropbox's second move response is lost but exact new holds the expected id, then
  the invocation succeeds; given exact temp holds it, rollback is verified before error;
  given settlement is indeterminate, no cache, `SyncRecord`, or checkpoint is committed.
