# ADR 0008 — Logical-identity admission fails closed before sync-plan execution

**Status:** Accepted · 2026-08-25 · **Revised 2026-09-04** (v8 cold-start discards incompatible v7 path identity; current component facts reconstruct strict case-alias continuity in every acquisition mode)
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
   identity topology or folder-mapping completeness. `unknown`, `mobile_deferred`, and
   incomplete mappings among included paths fail the whole connected component. An
   included-to-included folder rename remains one opaque folder operation.
   On a case-insensitive local filesystem, COLD replay may expose the requested new
   spelling only as an alias of the old spelling. Admission may reconstruct an
   otherwise actionless child rename only from a complete same-content baseline, an
   unchanged exact remote source, and an authoritatively absent remote destination.
   When one case-only parent mapping contains both content-changing and unchanged
   descendants, Admission decides the complete component in the same cycle: it retains
   each child content decision at the provider-current old-casing path, consumes only
   redundant child topology renames, and emits one existing folder `rename_remote`.
   Execution's existing content-before-structural barrier then completes the content
   before the parent transition; it does not infer or recover that transition later.

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
   checkpoint and scope fingerprint do not advance, and finalization aborts the live
   remote working view without a tight retry loop.

6. Crash recovery persists no operation intent. A failed cycle leaves the prior
   checkpoint and baseline unchanged; same-process retry and restart both reload that
   checkpoint and select ordinary COLD, WARM, or HOT observation from durable/current
   facts. Unresolved tracker input is acknowledged only after a clean terminal cycle.
   After restart, current facts may reconstruct an unambiguous case-only local
   relation, but general rename identity is never guessed. Finalization owns only the
   clean checkpoint commit.

   In every acquisition mode, an unbaselined file-level local case alias may be canonicalized only
   when the raw local adapter proves old→new aliasing, local new and remote old are
   exact, remote new is stat-authoritatively absent, the remote identity occurs once,
   and direct reads prove identical bytes. Observation records these endpoint,
   identity, SHA-256, and size facts without inferring a rename. Admission normalizes
   the component and independently requires equal hash and size plus included scope
   before shaping one explicit `case_alias_canonicalization`/`rename_remote` protocol.
   Missing or contradictory facts produce an explicit fail-closed component result and
   cannot fall through to unrelated path-local rules. Execution re-observes the endpoints and equal bytes immediately
   before the move, then proves old absence, exact new identity, and equal local/remote
   bytes before the normal `SyncRecord` commit. A race remains non-clean and commits no
   record. The same complete component facts yield the same decision in COLD, WARM, or
   HOT acquisition and with unrelated records. Evidence and disposition are discarded
   after the cycle.

   A baseline-backed case alias is instead endpoint evidence for the ordinary typed
   fresh-reconciliation states in rule 4. It may authorize rename/write, conflict, or
   no action according to current local/baseline/remote content; it does not use the
   unbaselined equal-content protocol.

   With no baseline, those facts cannot distinguish a historical case-only rename from
   two independently created same-content files whose names differ only by case. The
   admitted result is therefore an explicit canonicalization policy, not inferred
   historical identity: when the local adapter proves both requested spellings are one
   physical local file, the local physical spelling wins and the unique remote object
   is renamed without changing its stable identity.

7. SyncState schema version 7 cold-starts the incompatible operation-intent shape.
   Version 8 cold-starts v7 path identity after the metadata-cache checkpoint defect:
   retaining an old-casing `SyncRecord` can otherwise keep an already-converged
   old/new component alive. Old `SyncRecord` and merge-base stores are dropped rather
   than field-migrated; the first no-baseline cycle is COLD and cannot derive deletion
   from legacy baseline absence. The narrow current-fact case-alias proof in rule 6
   does not consult or reconstruct legacy records.

## Consequences

- A suspicious rename may fail and require a later trigger or user intervention, but
  it does not execute a partial destructive interpretation.
- There is no durable unresolved-operation state or persistent identity graph.
- Native IDs improve evidence but do not authorize cross-backend/root comparison.
- Local and remote rename shaping helpers are private to Admission. There is no
  standalone whole-plan optimizer or second component build; a failed native
  projection fails unless another complete component outcome is independently proved.
  Case-alias canonicalization is limited to the fully observed component proof in rule
  6; it is never inferred from spelling or content alone, nor selected by acquisition
  temperature or whole-store state.
- Issue #46 can be fixed without changing this boundary. Better cache causality should
  reduce ambiguity, while this admission policy remains the safety net.

## Rejected alternatives

- Infer identity from lowercased paths, Unicode-looking equivalence, or equal hashes
  without the exact alias, occupancy, unique remote identity, and scope proof in rule 6.
- Treat an unresolved rename as two independent path actions and rely on execution
  order, trash, or a later COLD scan to repair it.
- Persist a general occurrence graph or every folder descendant.
- Auto-duplicate every ambiguous component; duplication is conflict policy, not proof
  that a destructive rename interpretation is safe.
- Advance the remote cursor while an unresolved remote edge exists; that would erase
  the only restart replay source.
