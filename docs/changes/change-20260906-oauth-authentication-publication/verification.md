---
change: change-20260906-oauth-authentication-publication
role: verification
---

<!-- lifecycle is owned by change.md -->

# Verification

## T0 — pure and storage boundary

- `npm test -- --run src/fs/token-store.test.ts`
  - Exact nonempty candidate writes/readbacks succeed.
  - Empty, dropped, stale/unequal, and throwing reads/writes fail with fixed secret-free errors.
  - Existing key formats, skip-empty optional writes, explicit clear, and legacy key reads remain.
- Pure denial helper tests assert the exact tuples:
  - `access_denied` → `Authorization was denied.`
  - every other nonempty code → `Authorization failed (<code>).`
  - descriptions/URIs do not affect output.

## T1 — production-boundary integration

- Six completion variants:
  - `npm test -- --run src/fs/googledrive/auth-completion-audit.test.ts src/fs/dropbox/auth-completion-audit.test.ts src/fs/onedrive/auth-completion-audit.test.ts`
  - Cover missing initial refresh, retained existing refresh with omitted replacement, equal fresh publication, dropped replacement over empty/old storage, thrown storage, and no reusable provisional response after failure.
- Caller effects and rotation lifecycle:
  - `npm test -- --run src/fs/backend-manager.test.ts src/fs/backend-auth-folder-pick.test.ts src/fs/oauth-pkce.test.ts src/sync/orchestrator.test.ts`
  - Assert no save/reset/filesystem/folder-selection success on failure; all shared/detached paths publish before response installation; a second access cannot reuse failed response; successful rotation remains readable after checkpoint failure; sync closeout ordering stays unchanged.
- Attempt identity:
  - `npm test -- --run src/fs/dropbox/auth.test.ts src/fs/onedrive/auth.test.ts src/fs/dropbox/auth-completion-audit.test.ts src/fs/onedrive/auth-completion-audit.test.ts`
  - Capture authorize URL and token request identity after failure/settings edit, through reload, and for missing/wrong snapshot. Rejected cases make zero token requests.
- Plugin denial:
  - Execute the actual protocol handler with matching, missing, unequal, and active-backend-switched pending state. Only exact current equality shows Notice; all denial cases make zero completion/picker calls. Mixed success parameters cannot win.
- Relay/static:
  - `npm test --prefix /workspace/obsidian-air-sync-auth/worker`
  - Google invalid JSON/null/array/access/expiry/refresh shapes fail both routes with bounded 502; valid omitted/rotated refresh and Picker/state controls pass; existing transport exception behavior is pinned unchanged.
  - pCloud malformed shapes fail, valid access-only US/EU/default-host cases pass, invalid host makes zero requests, and logical/upstream status controls pass.
  - Worker/static/plugin-equivalent denial fixtures assert exact message parity and absence of description/token sentinels.
  - Static production script rejects null/primitive/array/wrong fields/prototype names/invalid encodings without redirect or throw; both valid encodings preserve raw state.

## T2 — repository gates

- Plugin: `npm run lint && npm run lint:bot-repro && npm run build && npm run test:coverage`
- Relay: `npm test --prefix /workspace/obsidian-air-sync-auth/worker && npm run typecheck --prefix /workspace/obsidian-air-sync-auth/worker`
- Run relay commands from repository-owned dependencies/scripts. No `/tmp` audit harness, credentials, external network, deployment, or CI workflow is part of the pass condition.

## Manual native evidence

For each representative desktop/mobile target: complete authorization, verify authenticated UI without recording token values, restart Obsidian and verify continuity, induce or observe a refresh-token rotation, then restart and verify continuity again. Record platform/app/plugin versions and pass/fail only—never secret contents. Any unexecuted target remains `unverified`; automated Map/store tests do not upgrade that status.

## Completion criteria

All seven roots' discriminating tests and compatibility controls are green, both T2 gates pass, no late refresh writer or success leakage remains, error outputs contain no sentinels, documentation states current versus legacy callback paths, and deployment/native claims match actual evidence. Worker/Pages deployment is explicitly `not performed` unless separately approved later.

## Recorded evidence — 2026-09-06

- Plugin focused OAuth/callback suites: 54 tests passed.
- Plugin complete suite/coverage gate: 94 files, 1923 tests passed; statements 84.56%, branches 80.70%, functions 83.34%, lines 86.13%.
- Plugin lint, Dashboard reproduction guard, TypeScript production build, and `git diff --check`: passed.
- Auth relay actual worktree: repository-owned Node suite 15 tests passed; `npm run typecheck` and `git diff --check`: passed.
- Dev-docs lint: passed without warnings.
- Worker/Pages deployment: not performed (outside approved scope).
- Native desktop/mobile restart and observed-rotation restart checks: unverified; no OS-level durability claim is made.
- Dropbox App Console additional-user setting was reported changed by the owner, but current console state and a new-account end-to-end authorization remain unverified from this workspace.
