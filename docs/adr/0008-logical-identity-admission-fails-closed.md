# ADR 0008 — Logical-identity admission fails closed before sync-plan execution

**Status:** Accepted · 2026-08-25
**Context area:** `sync/` — change evidence, scope projection, destructive admission, checkpoint/debt lifecycle
**Related:** [ADR 0001](0001-metadata-cache-is-subordinate-to-commit-last.md), [ADR 0002](0002-backends-verified-by-shared-behaviour-contracts.md), [ADR 0006](0006-remote-rename-detection-is-order-independent.md), [Issue #43](https://github.com/takezoh/obsidian-air-sync/issues/43), [Issue #45](https://github.com/takezoh/obsidian-air-sync/issues/45), [Issue #47](https://github.com/takezoh/obsidian-air-sync/issues/47)

## Context

A path-keyed decision table can represent one reported rename as two ordinary rows:
the old path appears deleted while the new path appears added. If casing/alias
resolution, scope filtering, or a partial observation prevents rename optimization,
those rows can become an independent delete plus transfer. Executing them separately
can destroy the only surviving copy even though the detector had evidence that the two
paths described one logical resource.

Absence from a listing is also not authoritative. Obsidian's vault index can
under-report, and a backend `stat(P)` may return an entity whose `path` merely echoes P
rather than proving the backend-resolved spelling. Content equality and case-folded
spelling are not identity.

The remote metadata-cache causality defect tracked by Issue #46 is separate. Cache
repair may improve the evidence available to the engine, but destructive safety cannot
depend on that repair being complete.

## Decision

1. `ChangeSet` preserves observations separately from exact-path entities. A non-null
   `stat(P)` is `exact` or `alias` only when its producer marks the path
   `actual_resolved`; `requested_echo` or missing authority is
   `present_unresolved`. A thrown stat aborts the cycle and is never absence.

2. Reported local/remote renames remain one normative `RenameEvidence` record through
   collection, refinement, and admission. Backend-native `identityKey` values are
   opaque, same-root evidence only. Equal non-empty keys relate occurrences; unequal
   keys separate them. Missing keys provide no evidence.

3. Scope is projected for both rename endpoints before entries are filtered. The
   origin-aware matrix decides whether the only safe consequence is rename, transfer,
   deletion, no-op, or deferral. `unknown`, `mobile_deferred`, and incomplete folder
   mappings defer the whole connected component.

4. `admitDestructivePlan` is the sole final owner of destructive admissibility. It is
   pure and cycle-local, consumes one immutable cycle snapshot, and emits exactly one
   `authorized`, `resolved_no_action`, or `deferred` disposition for every relevant
   component, including zero-action evidence components. Only Admission can issue the
   nominal `AuthorizedSyncPlan` accepted by `executePlan`; disconnected authorized
   actions retain proposal order.

5. Deferral is visible and non-clean: status is `partial_error`, notifications count
   deferred components, structured logs identify reasons/evidence/scope/paths, the
   checkpoint and scope fingerprint do not advance, and the next normal trigger uses a
   COLD reevaluation without a tight retry loop.

6. Crash recovery is bounded. An unresolved local reported edge and its endpoint
   dispositions are persisted as namespace-scoped `RenameDebt` before plan I/O and
   tracker acknowledgement. Remote edges are captured immediately when the delta
   cursor yields them and are reconstructed after restart by withholding that cursor's
   checkpoint. Admission alone classifies success eligibility, two-sided convergence,
   and explicit scope no-op. Finalization performs only action-completion/membership
   folding; after a safe checkpoint commits it retires the evidence/debt made releasable
   by those dispositions. Backend/root teardown is serialized with sync execution and
   clears the old namespace.

7. SyncState schema version 6 cold-starts the incompatible baseline shape. Old
   `SyncRecord` and merge-base stores are dropped rather than field-migrated; the first
   no-baseline cycle is COLD and cannot derive deletion from legacy baseline absence.

## Consequences

- A suspicious rename may defer and require a later trigger or user intervention, but
  it does not execute a partial destructive interpretation.
- The durable state remains O(U): one record per namespace-unique unresolved local
  edge, not a persistent identity graph or descendant closure.
- Native IDs improve evidence but do not authorize cross-backend/root comparison.
- Optimizers remain performance/plan-shaping steps. Their failure to match is not
  permission to execute the fallback; admission independently proves or rejects it.
- Issue #46 can be fixed without changing this boundary. Better cache causality should
  reduce ambiguity, while this admission policy remains the safety net.

## Rejected alternatives

- Infer identity from lowercased paths, Unicode-looking equivalence, or equal hashes.
- Treat an unresolved rename as two independent path actions and rely on execution
  order, trash, or a later COLD scan to repair it.
- Persist a general occurrence graph or every folder descendant.
- Auto-duplicate every ambiguous component; duplication is conflict policy, not proof
  that a destructive rename interpretation is safe.
- Advance the remote cursor while an unresolved remote edge exists; that would erase
  the only restart replay source.
