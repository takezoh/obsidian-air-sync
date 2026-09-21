# Verification — consolidate backend implementations under src/backends

## Gate

All four gate commands run from the change worktree:

| Command | Result |
|---|---|
| `npm run lint` | pass |
| `npm run lint:bot-repro` | pass (69 behavior tests + classifier; guard 14/14) |
| `npm run build` | pass (`tsc -noEmit -skipLibCheck` + esbuild production) |
| `npm run test:coverage` | pass (113 files / 2353 tests) |
| `git diff --check` | pass (no trailing blank lines at EOF) |

## Boundary witnesses

`backend-module-boundary-guard.test.mjs` (12/12):

- `a backend implementation imports no internal module API, core store, sync engine, or host
  runtime` — scans every non-test `*.ts` under `src/backends/`; zero violations.
- `the module guard rejects the internal backend-module API` — a probe importing
  `../../fs/modules/module-utils` or `../../fs/modules/adapter-state` is reported.
- `the module guard rejects a former shared fs helper now that it is public` — probes
  importing `../../fs/errors`, `../../fs/headers`, and `../../queue/async-queue` are reported.
- `only the public API and the backend tree are allowed` — `src/backend-api`,
  `src/backend-api/error-classification`, and `../shared/adapter-state` probes pass.
- `the module guard rejects a cross-provider import (one module = one backend)` — a
  Google Drive file importing `../dropbox/module` or `../onedrive/client` is reported,
  while `./module` passes; a `shared → provider` probe is also reported.
- `the module guard rejects bare Node builtins, not only node: specifiers` — `fs`, `path`,
  and `node:crypto` are reported.
- `module guard rejects an import of the metadata store` / `IFileSystem or the Obsidian App` /
  `platform import` / `logging import` — unchanged mutation witnesses rooted at
  `src/backends/googledrive`.

## Durability witnesses

- `tests/backend-modules/secret-host.test.ts` — a non-empty write that cannot read back
  (null result or a stale non-empty value) rejects with
  `Secret credential could not be saved securely`; a presence-only check would accept the
  stale case; a delete write does not require readback.
- `tests/backend-modules/pkce-module-auth.test.ts` — the live Dropbox and OneDrive
  `module.auth.complete` publish both credentials on success, POST to the provider token
  endpoints with the PKCE parameters and no `client_secret`, reject a response without a
  required refresh credential, reject a readback failure, and reject CSRF/verifier errors;
  `buildPkceTokenGetter` seeds from secrets, exposes expiry, and persists a rotated refresh
  token.

## Structural fatal-auth witnesses

`sync/plan-executor.ts`, `sync/content-snapshot.ts`, and `fs/backend-manager.ts` detect an
auth failure with `isAuthFailure` (shape `kind: "auth"` first), so a separately bundled
module's class identity cannot turn a cycle abort into an ordinary action failure. The
existing `plan-executor`/`orchestrator` auth-abort tests continue to pass.

Two new `pull` tests exercise a plain structural shape thrown by `remoteFs.read` (wrapped
by `content-snapshot`):

- `aborts the cycle on a plain structural auth shape from a remote read (no Error identity)`
  — rejects as auth and calls `onActionFatal`.
- `retries and signals the transfer pool on a plain structural rate_limit shape from a
  remote read` — the wrapper is unwrapped, the shape classifies as rate-limit, the pool is
  signalled, and the read retries to the cap.

Both were confirmed discriminating: with the `cause instanceof Error` unwrap restored (and
the `external_auth_failure` catch removed), each fails; with the fix, each passes.

The plain-shape tests also assert the final `result.failed[0].error.message` (`"slow down"`,
`"the object is gone"`), so the safe provider diagnostic cannot regress to
`"[object Object]"`; confirmed failing before the `toError` normalization and passing after.

Additional plain-shape witnesses at the other core entry points:

- `sync/orchestrator.test.ts` — a `localFs.list` rejection with a plain
  `backendError("transient", "network blip")` retries to exhaustion and the notice is
  `"Sync error: network blip"` (not `Unknown error`).
- `fs/backend-manager.test.ts` — a folder-pick rejection with a plain
  `backendError("permission", "folder denied")` yields
  `"Folder selection failed: folder denied"` (not `[object Object]`).
- `fs/modules/backend-module-provider.test.ts` — `validateRemoteVault` rethrows a plain
  structural root-validation error with its message intact.

## Structural check

- `src/fs/googledrive`, `src/fs/dropbox`, and `src/fs/onedrive` no longer exist.
- `src/backends/{googledrive,dropbox,onedrive,shared}` exist.
- `src/fs/pkce-auth-provider.ts`, `src/fs/token-store.ts`, `src/fs/errors.ts`,
  `src/fs/headers.ts`, `src/fs/http-transport.ts`, `src/fs/backend-error-log.ts`,
  `src/fs/oauth-pkce.ts`, `src/fs/remote-vault-contract.ts`, and
  `src/queue/async-queue.ts` no longer exist; their public replacements do.
- A repository scan (excluding the historical `docs/changes/**` records and the archived
  ADRs that describe the pre-move tree) finds no stale import specifier to the old paths,
  apart from the guard's own intentional probe strings.

## Manual / not covered

The opt-in live E2E suites are not part of the gate; their imports were repointed and the
production adapters are unchanged, so no behaviour change is expected. No live run was made.
