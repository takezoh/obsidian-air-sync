# Design — consolidated backend implementation directory and its dependency boundary

## Decision

Move every built-in backend implementation under `src/backends/`, split into one directory per
canonical module id plus a `shared/` directory for the provider-neutral helpers they use, and
enforce with the existing boundary guard that the whole family depends only on the public API,
its own files, and a named set of browser-safe shared helpers.

```
src/
  backend-api/            public Backend Module API (unchanged; guard-pinned self-contained)
  backends/
    shared/               error-shape, adapter-state, module-utils, pkce-module-auth
    googledrive/          module, adapter, client, auth, normalize-object, …
    dropbox/
    onedrive/
  fs/                     shared library + core IFileSystem, managed/caching/local, modules/
```

## Contract

**Allowed imports from `src/backends/**` (non-test).**

| Source | Why |
|---|---|
| `src/backend-api/**` | the public module contract plus the runtime helpers a module bundles |
| `src/backends/**` | the implementation family, including `shared/` |
| non-relative, non-host packages | a module may bundle a pure library (none do today) |

**Forbidden:** any relative import outside those two roots — `src/fs/**` (including the
internal backend-module API `src/fs/modules/**` and the former shared helpers), `src/queue/**`,
`src/store/**`, `src/sync/**`, `src/logging/**`, `src/ui/**`, `src/platform/**`, `src/main`,
`src/backend-manager` — and `obsidian` / `electron` / `node:*`.

`src/backend-api/**` keeps its own rule: no import outside itself, no Obsidian/Node/Electron.

## What moved into the public API

`error-classification`, `headers`, `http-transport`, `backend-error-log`, `oauth-pkce`, and
`remote-vault-contract` moved from `src/fs/` and `async-queue` from `src/queue/` into
`src/backend-api/`, re-exported from its index. They are provider-neutral, browser-safe, and
already used by both core and modules; moving them lets a backend depend on the public boundary
alone. `auth-config` (the built-in client ids and auth-relay URL) is Air Sync configuration, not
SDK surface, so it moved to `src/backends/shared/`.

## Why `shared/` for the module-boundary helpers

`error-shape`, `adapter-state`, `module-utils`, and `pkce-module-auth` are used only by the
built-in implementations and by tests; they are not part of the versioned public contract. Keeping
them inside `src/backends/shared/` lets the implementation family stay self-contained without
widening the public API. `adapter-state` still attaches the non-authoritative `readState` that core
persists.

## Structural fatal-auth, not class identity

The public error contract is structural, so a module can be a separately bundled
artifact whose `AuthError` class differs from core's. `backend-api/error-classification.ts`
exposes `isAuthFailure` (a shape carrying `kind: "auth"` first) and `toAuthError`; the
executor's cycle-abort decisions, `content-snapshot`'s error classification, and the
connect error notice all use it. `AuthError` remains the core bundle's `Error` identity
and the helper falls back to it for errors raised inside the core bundle.

## One module = one backend, enforced per provider

The guard resolves each file's location: a provider may import only `src/backend-api/**`,
`src/backends/shared/**`, and its own directory; `shared/` may import only the public API
and itself. A cross-provider import or a `shared → provider` import fails, as does a bare
Node builtin (`fs`, `path`, …) even without the `node:` prefix.

## Removing the legacy auth scaffolding

`DropboxAuthProvider`/`OneDriveAuthProvider` (and `pkce-auth-provider`/`token-store`) were unused
in production — the modules use `createPkceBackendAuth` — but carried the only implementation of
the stated durable-publication postcondition: a required credential is published only if the
physical key immediately reads back the exact candidate. Before deleting them, that postcondition
is moved into the core `createSecretHost().set`, so the live module path now proves it for every
non-empty secret write. `tests/backend-modules/secret-host.test.ts` pins the host behavior and
`tests/backend-modules/pkce-module-auth.test.ts` pins the live completion path (publication,
readback failure, CSRF, verifier).

## Invariant

A backend implementation owns provider integration only. It never owns the filesystem, the
normalized metadata cache, the delta cursor, scope, checkpoint commit/abort, priority observation,
or a store. The consolidated directory plus the guard make that structural rule true for every
non-test backend file rather than for a hand-maintained filename list.
