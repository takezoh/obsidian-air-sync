---
change: change-20260902-sync-outcome-convergence
role: requirements
functional_requirements:
- id: REQ-LOCAL-RENAME-EDIT-CONVERGENCE
  statement: An unchanged baseline remote resource renamed and edited locally converges
    to the new remote path with current local content and is not itself a conflict.
  priority: must
- id: REQ-REMOTE-CHANGE-CONFLICT
  statement: Freshly observed remote identity/content/path or destination change enters
    the configured existing auto_merge or duplicate behavior before rename/write.
  priority: must
- id: REQ-FRESH-STATE-CLASSIFICATION
  statement: Every invocation classifies current local, committed baseline, and fresh
    remote state into six exhaustive states without stored phase or pending state.
  priority: must
- id: REQ-RETRYABLE-NO-PENDING
  statement: Observation/transport failure ends the current bounded invocation, persists
    no pending row, and is recomputed by the next ordinary sync.
  priority: must
- id: REQ-FRESH-CRASH-RECOVERY
  statement: Crash or uncertain partial effect resumes through next-invocation fresh
    classification without raw substep retry or rollback rename.
  priority: must
- id: REQ-COMMIT-LAST-EXISTING
  statement: New-path SyncRecord follows verified rename/write and the existing checkpoint
    commits only on a clean cycle; no receipt protocol is added.
  priority: must
- id: REQ-DISCONNECTED-COMPONENT-PROGRESS
  statement: A failed component stops while disconnected authorized components may
    finish; the failed cycle withholds the existing global checkpoint.
  priority: must
- id: REQ-LEGACY-DEBT-EVIDENCE-ONLY
  statement: Existing v6 RenameDebt is non-authoritative COLD endpoint evidence and
    is exact- released only by existing successful consequence plus safe checkpoint.
  priority: must
- id: NFR-EXISTING-PROVIDER-BOUNDARY
  statement: Current provider/checkpoint interfaces and shared contract families remain
    unchanged; only backend-agnostic sync behavior tests are added.
  priority: must
---

<!-- lifecycle is owned by change.md -->

# Requirements

## Intended outcome

A synchronized regular file renamed and edited locally is not a conflict. When fresh remote state still matches its committed baseline and the destination is absent, sync automatically converges to the new path and current local content. Only an observed remote identity/content/path or destination change enters configured `auto_merge | duplicate` behavior.

## Functional requirements

- `REQ-LOCAL-RENAME-EDIT-CONVERGENCE` — Unchanged baseline remote `R@old` plus current local `new` shall become remote `R@new` with current local content.
- `REQ-REMOTE-CHANGE-CONFLICT` — Observed remote identity/content/path or destination change shall enter the configured existing conflict behavior before rename/write.
- `REQ-FRESH-STATE-CLASSIFICATION` — Every invocation shall classify current local, committed baseline, and fresh remote evidence as `old_path_baseline`, `post_rename_old_content`, `converged`, `remote_changed`, `destination_conflict`, or `unknown`. No stored phase/pending operation exists.
- `REQ-RETRYABLE-NO-PENDING` — Observation/transport failure shall exhaust the current bounded retry path, perform no unsafe fallback, advance no checkpoint, and persist no pending row. The next ordinary sync reacquires all evidence.
- `REQ-FRESH-CRASH-RECOVERY` — Crash/uncertain completion shall resume through next-invocation fresh classification; blind substep retry and rollback rename are forbidden.
- `REQ-COMMIT-LAST-EXISTING` — The new-path `SyncRecord` follows verified rename/write completion and the existing remote checkpoint commits only on a fully clean cycle.
- `REQ-DISCONNECTED-COMPONENT-PROGRESS` — Failure stops that identity component while disconnected authorized components may complete; checkpoint remains withheld.
- `REQ-LEGACY-DEBT-EVIDENCE-ONLY` — Existing v6 `RenameDebt` may keep endpoints in COLD acquisition but cannot authorize replay. No migration/quarantine/store is added; exact release uses existing successful-consequence plus checkpoint finalization.

## Architecture requirement

- `NFR-EXISTING-PROVIDER-BOUNDARY` — Keep current `IFileSystem`, checkpoint, registry, and shared contract families. Add only backend-agnostic behavior tests needed by this flow. No journal, pinned payload, durable pending replay, deferred, attention workflow, operation receipt, or all-provider conditional mutation boundary.

## Acceptance criteria

- `AC-01`: baseline `R@A/H0`, local `A -> B/H1`, unchanged fresh remote `R@A/H0`, and absent `B` ends `R@B/H1`, new-path record, clean checkpoint, and no conflict/pending state.
- `AC-02`: changed remote or destination enters configured existing conflict handling before rename/write and preserves the observed remote version.
- `AC-03`: crash/timeout before rename, after rename, after write, or after record commit re-enters one fresh state next invocation; no raw substep replay or rollback.
- `AC-04`: exhausted observation/transport failure creates no row/checkpoint and a later ordinary sync reacquires fresh evidence.
- `AC-05`: a v6 fixture never authorizes effects and is exact-released only by existing successful consequence plus safe checkpoint.
- `AC-06`: current filesystem/checkpoint/provider contract surfaces remain unchanged and no removed mechanism survives.
- `AC-07`: a failed component stops while disconnected work completes its per-file record and checkpoint stays withheld.

## Non-goals

No folder/chain support, interactive conflict strategy, new provider capability, persistent recovery workflow, SyncState migration, or atomic external-writer guarantee beyond the current fresh snapshot boundary.
