---
id: note-20260927-abort-notice-auth-asymmetry
kind: note
title: Abort-notice auth asymmetry is intentional
status: published
created: '2026-09-27'
tags: []
owners: []
relations:
- {type: references, target: change-20260927-actionable-sync-diagnostics}
- {type: references, target: design-backend-module-api}
source_paths:
- src/sync/failure-notice.ts
- src/sync/orchestrator.ts
- src/main.ts
- src/fs/backend-manager.ts
- src/backend-api/oauth-pkce.ts
summary: The sync failure notice reports the fact only, except an authentication failure
  which names the reconnect action. The connect/token paths keep their reconnect prompt
  too, so the two behaviours are intentionally aligned on auth and divergent elsewhere.
---

## Summary

After `change-20260927-actionable-sync-diagnostics`, the sync failure notices report only
the failure fact (operation/phase, HTTP status, neutral classification) with no user
instruction — with one deliberate exception: an **authentication failure** names the one
recovery action the user alone can take, `Please reconnect in settings.` The connect/token
paths keep the same prompt. This note records the exception and the asymmetry so they are
not "fixed" by accident.

## Notes

- The sync-abort and retry-exhausted notices in `src/sync/orchestrator.ts` and the
  unhandled-error notice in `src/main.ts` render a `formatFailureClause(...)` string. For
  `auth` it appends the reconnect action, e.g.
  `Cycle abort failed (401, auth). Please reconnect in settings.`; every other
  classification yields the fact-only clause (`Push failed (429, rateLimit)`,
  `Cycle abort failed (unclassified)`).
- Rationale for the auth exception: the cycle cannot recover credentials by retrying, so
  naming the reconnect action is a fact of the failure, not a generic task. For every other
  failure the plugin does not turn the failure into a user task: it retries what it can and
  otherwise reports the fact, assigning no work.
- `src/fs/backend-manager.ts` and `src/backend-api/oauth-pkce.ts` still surface
  "Authentication expired. Please reconnect in settings." Those paths run while the user is
  already acting on the connection; they are intentionally left unchanged, so the reconnect
  guidance is consistent wherever auth can fail.
- Do not add a generic next step back to the non-auth notices, and do not strip the
  reconnect prompt from the auth or connect/token paths, without superseding this note and
  the change's `req-notice-no-user-instructions`.
