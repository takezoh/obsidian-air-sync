# ADR 0009 — Proved local-folder fallback and targeted Rescan recovery

**Status:** Proposed · 2026-09-03
**Context area:** `sync/` — local folder rename admission, manual recovery, rename debt
**Related:** [ADR 0001](0001-metadata-cache-is-subordinate-to-commit-last.md), [ADR 0008](0008-logical-identity-admission-fails-closed.md)

## Context

A local folder rename can be accompanied by a file added to, removed from, or edited
inside the destination before the next sync. The native `rename_remote` projection is
then intentionally incomplete: its descendant mapping cannot cover every path in the
component. ADR 0008 correctly rejects that native rename, but treating native-rename
failure as the end of the decision can retain a local `RenameDebt` forever even when
the original path-local proposal already proves every survivor and deletion.

The existing **Rescan** action resets only the remote checkpoint. A persisted local
rename constraint is therefore replayed into the cold reconcile and can reproduce the
same deferral. Disconnecting works only because it clears far more state, including
baselines and merge bases, and requires every device to re-establish its target.

## Decision

Admission may replace an incomplete *local-origin folder* native projection with the
original path-local actions only when all of these predicates hold:

- every identity edge in the component is a reported local rename, and at least one is
  a folder rename;
- every component path is currently `included` in scope;
- every action is `push`, `delete_remote`, `match`, or `cleanup`;
- every present endpoint has exact path authority and every absent endpoint used to
  authorize a consequence is confirmed by `stat`;
- every `delete_remote` has a baseline and current remote entity, and every existing-
  destination `push` has a baseline.

The executor's existing phase barrier uploads transfers before structural deletes.
The local rename candidates remain crash-safe debt before I/O and are retired only
after every fallback action and the checkpoint commit succeed. Remote-origin rename,
alias/stable-identity evidence, unknown scope, unresolved observations, pull/local
delete/conflict, or any other unproved consequence continues to defer.

**Rescan** becomes an explicit, target-scoped recovery boundary. Under the sync mutex
it resets the live remote checkpoint, clears only local rename debt for the currently
configured backend/root namespace, removes only matching in-memory local evidence,
and forces a cold reconcile. Sync records, merge bases, other target namespaces, and
all remote pending evidence remain intact. If checkpoint reset fails, debt is not
cleared.

## Consequences

- A folder rename plus independently safe child edits converges without requiring a
  disconnect or weakening remote-rename safety.
- Rescan can recover stale local rename constraints while preserving sync history and
  concurrent remote changes still become normal conflicts.
- Native folder rename remains preferred because it is cheaper and atomically rewrites
  descendant baselines. The fallback is deliberately narrow and may still defer when
  a backend cannot provide exact path authority.
- Rescan now intentionally forgets current-target local rename intent. This is narrower
  than disconnect, but it is a semantic recovery operation rather than only a cache
  refresh.

## Confirmation

Focused Admission tests cover the positive fallback and fail-closed missing-authority
and remote-origin cases. Orchestrator tests reproduce a local folder rename with an
added descendant, prove convergence and debt retirement, and prove target-scoped
Rescan recovery. Rescan unit tests preserve remote evidence and retain debt when
checkpoint reset fails. The full repository gate remains required.
