# Requirements — consolidate backend implementations and close their boundary

## Context

The backend implementation of the three built-ins was spread across `src/fs/googledrive`,
`src/fs/dropbox`, and `src/fs/onedrive`, mixed into `src/fs/` with shared library code and the
core `IFileSystem` interface. Those implementations imported provider-neutral helpers from the
core-internal backend-module API (`src/fs/modules/{error-shape,adapter-state,module-utils,
pkce-module-auth}`). Issue #89 makes `BackendModule` the extension boundary and keeps the
internal module API, stores, cursor, and checkpoint inside core, so a backend implementation
must be readable and enforceable as one family that does not reach into core internals.

## Requirements

**R1 — Single implementation directory.** The three built-in backend implementations and the
provider-neutral helpers they build on SHALL live under one directory separated from
`src/fs/`'s shared library code and `IFileSystem` interface. When the directory is listed, it
SHALL contain `googledrive/`, `dropbox/`, `onedrive/`, and `shared/`, and no backend source
SHALL remain under `src/fs/<service>/`.

**R2 — Public-API-only dependency set.** A backend implementation SHALL import only
`src/backend-api/**` and files inside `src/backends/**` (plus non-relative, host-free
packages). Every provider-neutral runtime helper it needs SHALL be available in the
public API.

**R3 — Core internals are forbidden.** A backend implementation SHALL NOT import any
relative path outside `src/backend-api/**` / `src/backends/**`: `src/fs/**` (including
`src/fs/modules/**`, `managed`, `caching`, `local`, and the former plain helpers),
`src/queue/**`, `src/store/**`, `src/sync/**`, `src/logging/**`, `src/ui/**`,
`src/platform/**`, `src/main`, or Obsidian/Node/Electron.

**R4 — Enforced, not documented.** When a backend file imports a forbidden path, the boundary
guard SHALL fail; when it imports the public API or a sibling backend file, the guard SHALL
pass. The guard SHALL scan every non-test `*.ts` under `src/backends/`, not a filename-pattern
subset.

**R5 — Behaviour preserved.** Moving the implementations SHALL NOT change sync semantics,
settings, persisted state, or public module ids.

**R6 — Durability postcondition preserved.** Removing the legacy auth scaffolding SHALL NOT
drop the invariant that a required credential is published only after the physical
SecretStorage key immediately reads back the exact candidate. The live module path SHALL
prove it for every non-empty secret write.

## Acceptance

- `npm run lint`, `npm run lint:bot-repro`, `npm run build`, `npm run test:coverage` pass.
- `backend-module-boundary-guard.test.mjs` fails on a probe import of
  `src/fs/modules/module-utils` or `src/fs/headers`, and passes on `src/backend-api`.
- `src/fs/{googledrive,dropbox,onedrive}` no longer exist; `src/backends/googledrive`,
  `src/backends/dropbox`, `src/backends/onedrive`, and `src/backends/shared` do.
- `src/fs/pkce-auth-provider.ts` and `src/fs/token-store.ts` no longer exist;
  `tests/backend-modules/secret-host.test.ts` and `pkce-module-auth.test.ts` pass.
