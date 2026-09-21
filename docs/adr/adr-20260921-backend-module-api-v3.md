---
id: adr-20260921-backend-module-api-v3
kind: adr
title: Core holds no per-backend knowledge; a module declares addressing, credential keys, and its disconnect config
status: accepted
created: '2026-09-21'
updated: '2026-09-21'
decision_makers:
- project owner
consulted:
- review-backend-api-boundary
relations:
- {type: refines, target: adr-20260920-backend-module-boundary}
consequences:
  positive:
  - Core no longer branches on a backend id. `addressingOf` (a `moduleId === "dropbox"`
    switch) is gone; each `RemoteBackendAdapter` declares `addressing`, so a new
    `provider_path` backend needs no core change and an empty remote still resolves the
    correct mutation destination.
  - Core no longer guesses a credential key. `BackendAuth.credentialKeys` declares the
    module's plugin-owned logical secrets; core derives readiness from their presence and
    clears exactly those on disconnect, instead of hardcoding `refresh`/`access`.
  - Credential readiness and target presence are separate axes. `isConnected` is
    `targetPresent && credentialReady`; the settings UI gates folder controls on
    `hasCredentials` alone. The unused, misleading synchronous `auth.isAuthenticated`
    is removed rather than left as a verdict that could not read the async secret store.
  - Core no longer knows a backend's config shape. `BackendModule.disconnectConfig`
    returns exactly the bag to keep on disconnect, replacing the `custom*` prefix scan and
    the `module.id === "googledrive"` special case.
  negative:
  - `RemoteBackendAdapter.addressing` is a new required member and `BackendAuth.isAuthenticated`
    is removed, so the contract is a breaking change. The single supported version bumps
    to `apiVersion: 3`; all built-ins and fixtures are updated together. No external
    dynamic loader exists yet, so this has no shipped-artifact impact.
  neutral:
  - The physical secret keys, DB profile names, and remote ids are unchanged. Only how
    core learns about them changes.
confirmation: >-
  `backend-module-boundary-guard.test.mjs` still closes the import boundary;
  `tests/backend-api/validate-module.test.ts` pins that a missing/duplicate credential
  key, a credential key colliding with a `secret_reference` field, a missing/out-of-enum
  addressing, and a non-function `disconnectConfig` are rejected;
  `src/fs/modules/backend-module-provider.test.ts` pins declared-key clearing, the
  module-owned disconnect bag, and the rejection of a non-JSON `disconnectConfig` result;
  `tests/fs/managed/managed-remote-fs.test.ts` parameterizes every adapter seam
  (full scan, delta, getById/getByPath, version-bound read, create/update/move) for an
  addressing mismatch and pins that a checkpoint under a different scheme is refused;
  `tests/backend-api/api-contract.test.ts` pins `BACKEND_MODULE_API_VERSION === 3`.
decision_bindings:
- src/backend-api/module.ts
- src/backend-api/auth.ts
- src/backend-api/remote-adapter.ts
- src/backend-api/remote-object.ts
- src/fs/modules/validate-module.ts
- src/fs/modules/backend-module-provider.ts
source_paths:
- src/backend-api
- src/backends
- src/fs/modules
- src/fs/managed/mutation-bridge.ts
- tests/backend-api
---

# ADR — Backend Module API v3: no per-backend knowledge in core

## Context

The Backend Module API v2 boundary was sound, but two pieces of provider-specific
knowledge stayed in core, plus one config-shape special case:

1. `BackendModuleProvider.addressingOf(moduleId)` chose `provider_path` for Dropbox and
   `parent_id` otherwise. A new backend of the other location form would require editing
   core, and the declaration could not be runtime-validated.
2. `BackendAuth.isAuthenticated` was synchronous while the module-facing
   `BackendSecretStore` is asynchronous, so a module could not actually read credential
   presence. Real modules reported binding state instead, and core compensated by reading
   the hardcoded logical keys `refresh`/`access` in both `hasToken` and
   `clearPluginSecrets`, guessing names the module owns.
3. `disconnectedBag` scanned for a `custom*` key prefix and special-cased
   `module.id === "googledrive"`, so a new backend's disconnect preservation required a
   core change.

The sync-durable boundary itself (module reports provider facts; core owns `ManagedRemoteFs`,
the cache, cursor, and checkpoint) was correct and is not revisited here.

## Decision

1. **`RemoteBackendAdapter.addressing: RemoteAddressing`** (`parent_id` | `provider_path`)
   is a required, runtime-validated declaration. Core builds mutation destinations from
   it and never infers the scheme from a backend id or waits for an observed object.
2. **`BackendAuth.credentialKeys: readonly string[]`** declares the module's plugin-owned
   logical secret keys. Core derives credential readiness from their presence (at least
   one present) and clears exactly those keys on disconnect. `isAuthenticated` is removed:
   provider credential presence cannot be proven synchronously, and `getTarget` already
   supplies target presence.
3. **Readiness and target presence are explicit axes.** `isConnected = target && credentialsReady`;
   `hasCredentials` is promoted to `IBackendProvider`.
4. **`BackendModule.disconnectConfig?(config)`** returns the exact config bag to keep after
   disconnect; core persists it verbatim. Omitting it keeps only `authMode`.
5. These are bundled as `apiVersion: 3`. Core supports exactly one version.

## Rejected alternatives

- **Keep `isAuthenticated` and make it async.** It would ripple through the synchronous
  `IBackendProvider.isConnected` startup path for no benefit the declared keys do not
  already provide; it also leaves two ways to ask the same question.
- **Infer addressing from observed objects only.** Wrong on an empty remote, where no
  object has been seen to reveal the scheme.
- **Keep `addressing` optional for v2 compatibility.** No external artifact exists, so the
  compatibility surface would be a fallback core branch that guesses again — the exact
  defect being removed.

## Consequences

See frontmatter. Physical secret keys are preserved, so an existing vault keeps its
credentials; only core's route to them changes. The dynamic external loader remains future
work and this ADR does not widen or claim it.
