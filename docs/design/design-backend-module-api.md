---
id: design-backend-module-api
kind: design
title: Backend Module API v2
status: active
created: '2026-09-20'
updated: '2026-09-20'
relations:
- {type: references, target: design-remote-backend-implementation-contract}
- {type: references, target: adr-20260920-backend-module-boundary}
summary: The public Backend Module API v2 contract a backend implements — module shape,
  runtime context, adapter operations, JSON-safe config, declarative auth/binding/settings,
  errors, and checksums.
---

# Backend Module API v2

This document specifies the **public extension boundary** between Air Sync core and a
backend. It is implemented in `src/backend-api/` and versioned as `apiVersion: 2`. A
backend implements provider operations only; core owns the filesystem, cache, cursor,
scope, and checkpoint (see
[design-core-backend-integration.md](design-core-backend-integration.md) and
[adr-20260920-backend-module-boundary.md](../adr/adr-20260920-backend-module-boundary.md)).

## Module shape

`BackendModule` is a plain, stateless data carrier. It must not hold per-connection auth
state, perform I/O during enumeration/validation, or register anything beyond its declared
capabilities.

| Field | Meaning |
|---|---|
| `id` | Globally unique canonical id; equals persisted `settings.backendType`. |
| `displayName` | Human-readable name. |
| `version` | Module version (SemVer), independent of `apiVersion`. |
| `apiVersion` | Must be `2`. |
| `auth` | `BackendAuth`: `isAuthenticated`, `start`, `complete`, optional `revoke`. |
| `settings?` | Declarative field list (text / secret_reference / select / toggle). |
| `binding` | `resolveDefault`, optional `beginPick`/`completePick`/`getDisplayPath`. |
| `getTarget(config)` | Stable target from config, **no network**; `null` if unbound. |
| `createAdapter(context, config, target)` | Builds the provider adapter for a bound connection. |

`id` is canonical: `googledrive` / `onedrive` / `dropbox`. The legacy `*-custom` ids are
settings aliases only and are refused as module ids by the registry.

## Bundled runtime helpers

Besides the types, `src/backend-api/` exposes the provider-neutral, browser-safe
runtime helpers a module may bundle instead of reaching into core: error
classification and retry decisions (`AuthError`, `classifyHttpError`, `decideRetry`),
the HTTP transport seam, OAuth/PKCE primitives, response-header access, lossless
backend error logging, the remote-vault contract constants, and the concurrency
primitive. A backend imports only the public API and its own `src/backends/` tree; the
boundary guard fails any other relative import.

## Runtime context

Core builds a per-connection `BackendRuntimeContext`; a module never receives `App`,
`AirSyncSettings`, the internal logger, a metadata/checkpoint store, or `IFileSystem`.

| Surface | Contract |
|---|---|
| `http` | Core transport wrapper (binary/text/headers/status). Provider-specific verdicts stay in the module. |
| `secrets` | Get/set/delete by declared **logical** key. No enumeration, no physical names, no cross-module access. |
| `logger` | `debug`/`info`/`warn`/`error`; core applies module attribution and redaction. |
| `auth` | Open an external auth screen and accept callback/manual input. Not a general core API. |

`isAuthenticated` receives the context because SecretStorage presence cannot be proven
from `config` alone; core never persists a `hasToken` flag as a second truth.

## Adapter operations

`RemoteBackendAdapter` reports provider facts and performs provider mutations:

- Observation: `getStartCursor` (taken **before** a full scan), `listAll` (complete
  recursive snapshot), `assertRootAlive` (empty vs gone), `getChanges(cursor)` (complete
  delta or explicit `cursor_invalid`).
- Detached facts: `getById(id)`, `getByPath(path)` (may report several occupants).
- Version-bound `read`: returns content bound to an observed version, or
  `target_changed` / `unverifiable`. A version mismatch is never published as success.
- Mutation: `createFile`, `updateFile`, `createDirectory`, `move`, `delete`. `updateFile`,
  `move`, and `delete` all carry a **required** `expected: ExpectedVersion`; a caller with
  no version evidence passes an empty `versionToken`, and a provider that requires
  metadata CAS rejects it. Each has an explicit destination/expected-version. Update and
  create are never merged into an unversioned upsert. A copy+delete is not an
  identity-preserving `move`.

Every paginating method either returns a complete result or fails. A partial page, a
partial object set, or an empty `nextCursor` is never published as complete.

### Adapter capabilities (`RemoteBackendAdapter.capabilities`)

Every adapter declares the preconditions its provider actually enforces. `expected` is
always required input on update/move/delete; a capability only states whether the
provider itself closes the check-to-use window, never that the adapter may skip the
comparison. Where `conditionalMetadataMutation` is `true`, an empty expected token or a
re-observation with no version evidence fails closed (`unverifiable`) before the
provider is called.

| Field | Value | Meaning |
|---|---|---|
| `exclusiveCreate` | boolean | The provider rejects a create at an occupied destination. |
| `conditionalContentUpdate` | `"all"` \| `"none"` | Provider-enforced content-overwrite coverage. `"all"`: every content write carries an enforced version precondition. `"none"`: no provider content precondition that binds the commit; compare-before only. |
| `conditionalMetadataMutation` | boolean | The provider enforces `expected` on move/rename and delete. |
| `versionBoundRead` | `"revision"` \| `"reobserve"` | How `read` proves bytes belong to the requested version: download the exact revision, or re-observe the version after download and return `target_changed` if it moved. |

Where a capability is `false`/`"none"` for an operation, the adapter still compares the
expected version before mutating and fails closed on an observed mismatch, but the
provider offers no guarantee against a change inside the check-to-use window. A provider
with no directory version evidence declares no directory `versionToken`; one that has it
must surface it (the concurrency contract pins both). `validateAdapterCapabilities`
runtime-checks this shape immediately after `createAdapter`.

## Normalized object model

`RemoteObject` is the only durable remote representation. It carries a stable `id`,
`kind` (`file`/`directory`), optional `size`/`mtimeMs` (absent = unknown; `0` is real),
`checksum`, `versionToken` (race evidence, **not** a content checksum), a discriminated
`RemoteLocation` (`parent_id` tree vs stable-root `provider_path`), and explicit
`pathAuthority` (`provider_resolved` vs `requested_echo`).

## JSON-safe config and patches

Config is a `JsonObject` of finite numbers, strings, booleans, `null`, arrays, and plain
objects. `undefined`, `Date`, `Map`, functions, cycles, and prototype keys are invalid.
A `JsonPatch` is a top-level `set`/`unset` against the active backendData bag only — never
global settings, secret values, cursors, or metadata snapshots. Core applies a patch to
the latest bag and only while the issuing connection generation is current.

## Declarative auth, binding, and settings

A module declares fields and workflows; core renders Obsidian `Setting`/modals and owns
the connection lifecycle. Built-in vs custom OAuth is an `authMode` **inside** a module.
Protocol names `air-sync-auth` / `air-sync-folder` are unchanged; callback state must
match the originating module/authMode/generation. Core owns the disconnect sequence:
revoke (best effort) → clear the module's plugin-owned secret namespace → clear config →
clear the target checkpoint → reset baseline → dispose the connection (closing the prepared
filesystem). User-owned secret
references are never deleted.

## Errors and checksums

Errors cross the boundary in one taxonomy (`auth` / `permission` / `rate_limit` /
`not_found` / `target_changed` / `cursor_invalid` / `transient` / `permanent` /
`unverifiable`) with a bounded `retryAfterMs`; core owns retry/backoff. Core-standard
checksum ids (`sha256`/`sha1`/`md5`) and compatibility ids (`dropbox`/`quickxor`) are
reserved; `ChecksumRegistry.register` is the extension point (proven by the
checksum-extension test), and no built-in module declares an algorithm in this
milestone — reaching the registry from a loaded module is future-loader work. An
unregistered algorithm fails closed and is never substituted by mtime/size or a remote
body download.

## Runtime validation

`validateBackendModule` structurally validates a candidate (identity, interface version,
required functions, settings, checksums, paired pickers) before registration. Duplicate
ids, legacy alias ids, unknown API versions, and missing required functions are rejected
before any adapter/auth is created. `validateAdapterCapabilities` then validates the
returned adapter's `capabilities` shape (missing or out-of-enum values are rejected)
before it reaches `ManagedRemoteFs`. TypeScript compatibility alone is insufficient for a
future dynamically loaded artifact.

## Scope

This milestone implements and tests API v2 for **static built-ins**. No external artifact
discovery, dynamic import, install UI, integrity manifest, or hot reload is implemented or
claimed. See [support-policy.md](../support-policy.md).
