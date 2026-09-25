---
id: adr-20260923-backend-delta-completion-operation
kind: adr
title: An optional declared provider delta-completion operation on the Backend Module API
status: accepted
created: '2026-09-23'
updated: '2026-09-23'
decision_makers:
- project owner
consulted:
- dev:design planner, critic, and integrator
consequences:
  positive:
  - Core can request exactly one identity-addressed folder subtree read through a declared,
    provider-neutral operation without observing the metadata cache or stores.
  - OneDrive and Dropbox production adapters and request shapes stay unchanged; a module
    that does not need the operation declares nothing and remains valid.
  - The surface evolves additively at v3; a declared-but-malformed member is rejected at
    registration instead of failing at call time.
  negative:
  - The Backend Module API surface, adapter validation, the implementation-family catalog,
    the shared contract harnesses and the central required-contract matrix must all change
    in the same change.
  - The operation is a new contract that every future family claiming folder-entry
    completeness must satisfy.
  neutral:
  - The addressing and identity model of the adapter is unchanged.
  - The backend-boundary import guard is unchanged and stays green.
confirmation: >-
  src/fs/modules/validate-module.ts rejects a module that declares the operation with a
  malformed member, pinned by a unit witness in tests/backend-api/validate-module.test.ts;
  the central tests/fs/remote-backend-contracts.test.ts registers the one shared scope-entry
  case for Google Drive, OneDrive and Dropbox; the implementation-family catalog lists the
  operation; npm run lint:bot-repro keeps the backend-module boundary guard green.
tags:
- sync
- backend-api
- googledrive
owners: []
relations:
- {type: originatedFrom, target: change-20260923-gdrive-delta-relist-scope}
- {type: references, target: adr-20260921-backend-module-api-v3}
- {type: references, target: adr-20260920-backend-module-boundary}
source_paths:
- src/backend-api/remote-adapter.ts
- src/fs/modules/validate-module.ts
- src/backends/googledrive/module.ts
- src/backends/googledrive/adapter.ts
- src/backends/onedrive/adapter.ts
- src/backends/dropbox/adapter.ts
- tests/backend-api/validate-module.test.ts
- tests/fs/remote-backend-contracts.test.ts
summary: The Backend Module API gains an optional, declared, identity-addressed
  delta-completion (folder-scoped subtree read) operation with a typed cursor_invalid
  outcome; a malformed declaration is rejected at registration.
---

# An optional declared provider delta-completion operation on the Backend Module API

## Context

`adr-20260916-gdrive-delta-relists-entered-folders` delegated one raw provider read —
`client.listAllFiles(folderId)` — to Google Drive. When built-ins moved behind the Backend
Module API (`adr-20260920-backend-module-boundary`,
`adr-20260921-backend-module-api-v3`), no operation existed that core could invoke by folder identity, so the
adapter absorbed the entire walk and its target selection. The module boundary forbids an
adapter from reading the metadata cache, so the selection cannot go back into the adapter.

## Decision

Add an optional, declared, provider-neutral delta-completion operation to the Backend
Module API. It takes one folder stable id and returns a typed result: the folder's current
subtree observations, or `cursor_invalid` when the provider reports an expired cursor. The
operation reads no cache, cursor, scope or store and performs no mutation. `validateAdapter`
rejects a module that declares the member with a malformed shape. The API surface, module
validation, implementation-family catalog, shared contract harnesses and the central
required-contract matrix update ship in the same change. Google Drive implements it over the
existing `listAllFiles(folderId)`; OneDrive and Dropbox declare nothing.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| A generic folder-scoped listing primitive driven by core | Moves sequencing, the 410 fallback and abort policy into core and forces every family to implement an operation it does not need. |
| Keep the account-wide re-list in the adapter | Violates `adr-20260916` decisions 1-2 and makes cost track account-wide activity. |
| Let the operation reject on 410 and have core parse the provider error | Core must not re-parse provider errors; `cursor_invalid` is the one typed taxonomy outcome for an expired cursor. |

## Consequences

Positive: core can drive exactly one identity-addressed subtree read per target; modules
that do not need the operation stay valid; malformed declarations fail at registration.
Negative: the API surface, validation and contract registrations must change together, and
future families claiming folder-entry completeness must satisfy the operation. Neutral: the
addressing model and the backend-boundary import guard are unchanged.

## Confirmation

`validateAdapter` rejects a declared-but-malformed member with a pinned unit witness; the
central remote backend contract test registers the shared scope-entry case for all three
families; the implementation-family catalog lists the operation; the backend-module boundary
guard stays green.
