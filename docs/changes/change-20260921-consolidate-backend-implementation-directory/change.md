---
id: change-20260921-consolidate-backend-implementation-directory
kind: change
title: Consolidate backend implementations under src/backends and close their dependency boundary
status: draft
created: '2026-09-21'
profile: design@1
intent: The three backend implementations were spread across src/fs/<service> and borrowed
  provider-neutral helpers from the core-internal backend-module API (src/fs/modules). That
  made the implementation family impossible to read as one unit and left it dependent on
  internals that a future external-artifact boundary cannot expose. Consolidate the
  implementations into one directory and guarantee they depend only on the public Backend
  Module API plus browser-safe shared helpers.
outcomes:
- The three built-ins live under src/backends/{googledrive,dropbox,onedrive}; the
  provider-neutral helpers they use live under src/backends/shared.
- Every provider-neutral runtime helper a backend needs is part of the public
  src/backend-api; no backend implementation imports anything under src/fs/**,
  src/queue/**, or another core area.
- The boundary guard scans all non-test src/backends/**/*.ts and fails any relative
  import outside src/backend-api/** and src/backends/**, plus Obsidian/Node/Electron.
- The legacy PkceAuthProvider-based auth scaffolding (and its token-store helper) is
  removed; its durable-publication guarantee is ported into the core secret host, so
  the live module auth path now proves readback for every non-empty secret write.
- Sync semantics and persisted state are unchanged.
scope:
- src/backends/googledrive/** — moved from src/fs/googledrive; imports repointed.
- src/backends/dropbox/** — moved from src/fs/dropbox; imports repointed.
- src/backends/onedrive/** — moved from src/fs/onedrive; imports repointed.
- src/backends/shared/error-shape.ts — moved from src/fs/modules; imports the public error classification.
- src/backends/shared/adapter-state.ts — moved from src/fs/modules.
- src/backends/shared/module-utils.ts — moved from src/fs/modules.
- src/backends/shared/pkce-module-auth.ts — moved from src/fs/modules; imports the public oauth helpers.
- src/backends/shared/auth-config.ts — moved from src/fs (backend-only built-in client ids).
- src/backend-api/{headers,http-transport,backend-error-log,oauth-pkce,remote-vault-contract,async-queue,error-classification}.ts — moved from src/fs/{...}/src/queue; index re-exports them.
- src/backends/dropbox/auth.ts, src/backends/onedrive/auth.ts — remove the legacy *AuthProvider classes.
- src/fs/pkce-auth-provider.ts, src/fs/token-store.ts (+test) — deleted.
- src/backends/{dropbox,onedrive}/{auth,auth-completion-audit}.test.ts — deleted; coverage migrated to tests/backend-modules/{secret-host,pkce-module-auth}.test.ts.
- src/fs/modules/secret-host.ts — enforce immediate exact readback on every non-empty secret write.
- src/backends/{dropbox,onedrive}/types.ts — drop the dead FileEntity converters and use the public RemoteChecksum.
- src/fs/modules/builtin-modules.ts, tests/fs/**, e2e/**, eslint.config.mts, vitest.config.ts, lint-bot-repro.mjs — path repointing.
- backend-module-boundary-guard.test.mjs — the strict public-API-or-backend rule.
- ARCHITECTURE.md, docs/code-enforcement.md, docs/design/*.md, the boundary ADR, the capability ADR, docs/*-backend.md — module map, enforced rule, and current paths.
non_goals:
- Changing sync semantics, settings, or IndexedDB schema.
- Dynamic external module loading (issue #89 phase 6).
- Adding a third-party SDK package; the public boundary remains src/backend-api.
change_classes:
- boundary
- behavior
- docs
governance:
  gate: hard
  reasons:
  - Moves the production implementation of every built-in backend and rewrites its imports.
  - Widens the public API with the runtime helpers a module bundles.
  - Deletes the legacy auth scaffolding and moves its durable-publication postcondition into the live core secret host.
  approval_evidence: Owner directed consolidation into a single directory separate from shared
    modules/interface code, to follow issue #89's boundary intent, and to resolve the recorded
    remaining task (legacy removal + public-API promotion).
members:
  requirements: requirements.md
  design: design-plan/design.md
  implementation: implementation.md
  verification: verification.md
promotion: []
promotion_applied_at: null
unresolved_decisions:
- Whether the public runtime-helper set should move to a distinct package-ready SDK entry
  rather than the existing src/backend-api index. This change keeps one boundary.
---

# Consolidate backend implementations under src/backends and close their dependency boundary

See `design-plan/design.md` for the boundary contract, `implementation.md` for the mechanical
move, and `verification.md` for the gate evidence.
