# ADR 0008 — Logical-identity admission fails closed before sync-plan execution

**Status:** Accepted · 2026-08-25 · **Revised 2026-09-03** (all deterministic scope exclusions are removed before Admission)
**Context area:** `sync/` — change evidence, scope projection, destructive admission, checkpoint lifecycle
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
   collection and admission. Backend-native `identityKey` values are
   opaque, same-root evidence only. Equal non-empty keys relate occurrences; unequal
   keys separate them. Missing keys provide no evidence.

3. Configured scope is applied before the immutable Admission snapshot is constructed.
   Excluded entries and observations are removed, stable-identity occurrences are
   clipped to included paths, and rename/alias evidence is retained only when every
   endpoint is included. A folder relation crossing scope at any observed descendant
   is discarded, leaving each included path to be planned from its own current and
   baseline facts. Excluded paths have no Admission disposition and cannot affect
   identity topology or folder-mapping completeness. The mobile maximum-size policy
   follows the same boundary using current entity size; it has no Admission
   disposition. `unknown` observations and incomplete mappings among included paths
   fail the whole connected component. An
   included-to-included folder rename remains one opaque folder operation.
   On a case-insensitive local filesystem, COLD replay may expose the requested new
   spelling only as an alias of the old spelling. Admission may reconstruct an
   otherwise actionless child rename only from a complete same-content baseline, an
   unchanged exact remote source, and an authoritatively absent remote destination.

4. `admitDestructivePlan` is the sole owner of cross-path identity-component action
   shaping, destructive admissibility, disposition, and local lifecycle membership.
   It is pure and cycle-local, consumes one immutable cycle snapshot, builds the
   exhaustive component partition once, and emits exactly one `authorized`,
   `resolved_no_action`, or `failed` result for every relevant component, including
   zero-action evidence components. Only Admission can issue the nominal
   `AuthorizedSyncPlan` accepted by `executePlan`; disconnected authorized actions
   retain proposal order.

5. Admission failure is visible and non-clean: status is `partial_error`, notifications
   count failed components, structured logs identify reasons/evidence/scope/paths, the
   checkpoint and scope fingerprint do not advance, and the next normal trigger uses a
   COLD reevaluation without a tight retry loop.

6. Crash recovery persists no operation intent. A failed cycle leaves the prior
   checkpoint and baseline unchanged; the next same-session trigger performs COLD
   observation. Unresolved tracker input is acknowledged only after a clean terminal
   cycle. After restart, current facts may reconstruct an unambiguous case-only local
   relation, but general rename identity is never guessed. Finalization owns only the
   clean checkpoint commit.

7. SyncState schema version 7 cold-starts the incompatible baseline shape. Old
   `SyncRecord` and merge-base stores are dropped rather than field-migrated; the first
   no-baseline cycle is COLD and cannot derive deletion from legacy baseline absence.

## Consequences

- A suspicious rename may fail and require a later trigger or user intervention, but
  it does not execute a partial destructive interpretation.
- There is no durable unresolved-operation state or persistent identity graph.
- Native IDs improve evidence but do not authorize cross-backend/root comparison.
- Local and remote rename shaping helpers are private to Admission. There is no
  standalone whole-plan optimizer or second component build; a failed native
  projection fails unless another complete component outcome is independently proved.
  Case-alias replay reconstruction is limited to the fully observed unchanged
  source/vacant-destination state; it is not evidence inference from spelling alone.
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
