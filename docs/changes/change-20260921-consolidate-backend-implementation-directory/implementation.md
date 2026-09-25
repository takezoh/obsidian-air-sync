# Implementation — consolidate backend implementations under src/backends

## Move

- `git mv src/fs/googledrive src/backends/googledrive`
- `git mv src/fs/dropbox src/backends/dropbox`
- `git mv src/fs/onedrive src/backends/onedrive`
- `git mv src/fs/modules/error-shape.ts src/backends/shared/error-shape.ts`
- `git mv src/fs/modules/adapter-state.ts src/backends/shared/adapter-state.ts`
- `git mv src/fs/modules/module-utils.ts src/backends/shared/module-utils.ts`
- `git mv src/fs/modules/pkce-module-auth.ts src/backends/shared/pkce-module-auth.ts`

## Import repointing (moved files)

Inside `src/backends/<service>/*.ts`: `../modules/<helper>` → `../shared/<helper>`;
`../<fs-shared>` → `../../fs/<fs-shared>` (errors, headers, http-transport,
backend-error-log, oauth-pkce, secret-store, auth-config, remote-vault-contract, types,
pkce-auth-provider, platform-http-transport in the test helper). `../../backend-api` and
`../../queue/async-queue` keep their depth.

Inside `src/backends/shared/*.ts`: `error-shape` now imports `../../fs/errors`;
`pkce-module-auth` now imports `../../fs/oauth-pkce`; `../../backend-api` unchanged.

## Import repointing (core, tests, e2e, tooling)

- `src/fs/modules/builtin-modules.ts`, `src/fs/modules/backend-module-provider.test.ts` →
  `../../backends/<service>/module`.
- `src/sync/plan-executor.test.ts`, `tests/backend-modules/adapter-error-shape.test.ts` →
  `src/backends/shared/error-shape`.
- `src/fs/token-store.test.ts` → `../backends/googledrive/test-helpers.test`.
- `tests/fs/contracts/remote-backend-family.ts`, `tests/fs/{googledrive,dropbox,onedrive}/
  managed.contract-harness.ts`, `tests/fs/backend-module-auth-url.test.ts`, and every `e2e/**`
  importer → `src/backends/<service>/…`.
- `eslint.config.mts` per-file `max-lines` pins; `vitest.config.ts` test-helper include;
  `lint-bot-repro.mjs` config sentinel.

## Guard

`backend-module-boundary-guard.test.mjs` now collects every non-test `*.ts` under
`src/backends/` and fails on a forbidden import (internal module API, core state, host,
Node/Electron). It keeps the existing `src/backend-api/**` self-containment tests and the
mutation witnesses, and adds a witness that the public API and named browser-safe shared
helpers are allowed.

## Docs

`ARCHITECTURE.md` module map gains a `backends/` row and the moved service rows;
`docs/code-enforcement.md` §4 describes both halves of the guard; the boundary ADR and the
capability ADR name the new paths; the per-service backend docs point at `backends/<service>/`.

## Public-API promotion

- `git mv src/fs/errors.ts src/backend-api/error-classification.ts`
- `git mv src/fs/headers.ts src/backend-api/headers.ts`
- `git mv src/fs/http-transport.ts src/backend-api/http-transport.ts`
- `git mv src/fs/backend-error-log.ts src/backend-api/backend-error-log.ts`
- `git mv src/fs/oauth-pkce.ts src/backend-api/oauth-pkce.ts`
- `git mv src/fs/remote-vault-contract.ts src/backend-api/remote-vault-contract.ts`
- `git mv src/queue/async-queue.ts src/backend-api/async-queue.ts`
- `git mv src/fs/auth-config.ts src/backends/shared/auth-config.ts`
- The matching `*.test.ts` files moved with them. `backend-api/index.ts` re-exports the
  helpers and their types. A script repointed every importer across `src/`, `tests/`,
  and `e2e/`; the moved `oauth-pkce`/`error-classification` files reference each other
  by the new sibling path.

## Backend `FileEntity` dependency removed

- `dropboxEntryToEntity` / `oneDriveItemToEntity` (dead production helpers used only by
  unit tests) are deleted; `toRemoteChecksum` now returns the public
  `RemoteChecksum` (`algorithm`) and is inlined in `onedrive/normalize-object.ts`.
  The corresponding test blocks and imports are removed.

## Legacy auth removal and durability port

- Deleted `src/fs/pkce-auth-provider.ts`, `src/fs/token-store.ts`, `token-store.test.ts`,
  and the four `*AuthProvider` test files; removed the `DropboxAuthProvider` /
  `OneDriveAuthProvider` classes and their now-unused imports.
- `src/fs/modules/secret-host.ts` `set()` now rejects when a non-empty write does not
  read back exactly (returning a rejected promise rather than throwing synchronously).
- New `tests/backend-modules/secret-host.test.ts` (readback + delete) and
  `tests/backend-modules/pkce-module-auth.test.ts` (live Dropbox module completion:
  durable publication, readback failure, CSRF, missing verifier).

## Guard and docs

- `backend-module-boundary-guard.test.mjs` now treats any relative import outside
  `src/backend-api/**` and `src/backends/**` as a violation, and adds witnesses for the
  former shared helpers.
- `ARCHITECTURE.md`, `docs/code-enforcement.md`, `docs/design/design-backend-module-api.md`,
  `docs/design/design-remote-backend-implementation-contract.md`, and the boundary ADR
  updated.

## Review remediation

- **Structural fatal-auth.** `backend-api/error-classification.ts` adds `isAuthFailure`
  (shape `kind: "auth"` first, core `AuthError` second) and `toAuthError`. The fatal
  decisions in `sync/plan-executor.ts` (`withIoRetry`, both action catch blocks, the
  `external_auth_failure` cause) and the classification in `sync/content-snapshot.ts` and
  `fs/backend-manager.ts` now use the structural check, so a separately bundled module's
  `AuthError` class identity is not authoritative.
- **Wrapped plain-shape failures.** `content-snapshot` wraps a module's plain
  `BackendErrorShape` in a `ContentProofError` cause. `withIoRetry` now unwraps any defined
  cause (not only an `Error`) before the fatal/retry decision, so a plain `auth` aborts and
  a plain `rate_limit` still classifies and retries; `executeAction` handles an
  `external_auth_failure` wrapper directly, and `executeConflictAction` normalizes its cause
  through `toAuthError`.
- **Diagnostic preservation.** `backend-api/error-classification.ts` also exposes
  `errorMessage(err)` and `toError(err)`. `withIoRetry` throws the normalized `toError(cause)`
  on final failure; both action catch blocks and the cycle-level loop in
  `sync/orchestrator.ts` normalize before logging/notifying, so a plain
  `rate_limit`/`permission`/`not_found`/`permanent`/`transient` shape can no longer surface
  as `"[object Object]"` or `Unknown error`.
- **Connection/binding preservation.** `fs/modules/backend-module-provider.ts` (`validateRemoteVault`
  rethrow), `fs/backend-manager.ts` (connect/auth/folder-pick/bind notices),
  `fs/backend-auth-folder-pick.ts`, `ui/app-folder-picker.ts`, `main.ts`,
  `fs/caching/remote-fs.ts`, `sync/state-committer.ts`, `sync/opened-file-priority.ts`,
  `sync/sync-cycle-finalization.ts`, the backend clients/auth, and `backend-api/oauth-pkce.ts`
  now use `errorMessage`/`toError` instead of `String(err)`, preserving the message and the
  structural `kind`/retry hint.
- **One-module-one-backend guard.** `backend-module-boundary-guard.test.mjs` computes the
  allowed roots per file: a provider may reach only `src/backend-api`, `shared/`, and its
  own directory; `shared/` may reach only the public API and itself. Cross-provider
  imports and `shared → provider` imports are rejected, with witnesses.
- **Bare Node builtins.** The guard rejects bare builtin names (`fs`, `path`, …) from
  Node's own `builtinModules` list, not only `node:*`, with a mutation witness.
- **Unrelated sync change removed.** The pre-existing startup-overlap edit to
  `src/sync/change-detector.ts`/`.test.ts` is reverted out of this change (preserved at
  `/tmp/opencode/change-detector-startup-overlap.patch` for a separate change).
- **Readback counterexample.** `tests/backend-modules/secret-host.test.ts` adds a
  stale-non-empty-value case that a presence-only check would wrongly accept.
- **Provider wire coverage.** `tests/backend-modules/pkce-module-auth.test.ts` asserts the
  Dropbox and OneDrive token endpoints, PKCE parameters, absent `client_secret`, required
  refresh-token rejection, and the `buildPkceTokenGetter` rotation/expiry lifecycle.

## Not changed

No sync semantics, settings shape, persisted state, module id, or public module contract
type. Secrets still use the stable `air-sync-<type>-<name>-token` physical keys.
