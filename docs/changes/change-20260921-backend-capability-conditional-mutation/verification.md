# Verification — backend capability-tiered conditional mutation

## Gate

All four required commands passed with exit code 0 on the same source tree:

```
npm run lint          # eslint --max-warnings 0
npm run lint:bot-repro # structural / boundary / ownership guards
npm run build         # tsc -noEmit -skipLibCheck && esbuild production
npm run test:coverage # vitest + coverage
```

- **116 test files / 2,385 tests passed**, no skipped/todo.
- Coverage: statements 85.28% (7392/8667), branches 81.64% (5253/6434),
  functions 85.89% (1571/1829), lines 87.1% (6523/7489).

## Machine-closed change declaration

`dev-evidence` (the repo's local runtime) returns PASS for both binding contracts
against this change:

- `out-of-scope-changes.v2` → PASS (only the package's own `docs/changes/<id>/` and the
  declared pre-existing `src/sync/change-detector.*` worktree changes remain).
- `closure.evidence-readiness.v1` → PASS.

## Adapter-level concurrency contract

`tests/fs/contracts/backend-concurrency.contract.ts` is registered for all three modules;
**37 concurrency cases** run. The harness derives each object's token from the adapter's
own observation, so seeding cannot smuggle in the field the implementation should use.
It asserts:

- the declared capability table (`conditionalContentUpdate` is `all` / `none`),
- a read of a version the provider has left returns `target_changed`,
- an update with a stale expected version is rejected and the concurrent bytes survive,
- a stale update whose concurrent bytes already EQUAL the bytes being written does not
  pass as a no-op (Dropbox must carry `strict_conflict`; an enforced revision covers
  OneDrive),
- a mid-read change on a `reobserve` backend returns `target_changed`; a `revision`
  backend returns the requested revision's exact bytes,
- a change landing immediately after the adapter's observation is rejected by the
  provider where the capability covers it,
- a METADATA-ONLY delete race is rejected — a `cTag`-based adapter would treat its stale
  content token as current and issue the delete,
- a folder move is guarded by its own version,
- an expected version that cannot be re-proven fails closed with `unverifiable` before
  any mutation, an EMPTY expected token is `unverifiable` too where
  `conditionalMetadataMutation` is declared, an expected `id` naming a different object
  is rejected, a stale move/delete is rejected even where the provider has no metadata
  precondition, and an absent metadata `eTag` with a present content `cTag` does not
  fall back to a content-only token,
- directory version evidence exactly equals the provider's own version/eTag and
  advances after a metadata-only change, so a fixed or modifiedTime-derived token (or a
  dropped directory token) fails,
- a ZERO-BYTE create at an occupied destination is rejected and the existing bytes
  survive,
- a create at an occupied destination is rejected when `exclusiveCreate`, and the
  original bytes survive on Google Drive where it is not.

## Runtime boundary

- `validateAdapterCapabilities` unit cases reject a missing `capabilities` and an
  out-of-enum `conditionalContentUpdate` / `versionBoundRead`; the provider validates the
  adapter returned by `createAdapter` before it reaches `ManagedRemoteFs`.
- `BACKEND_MODULE_API_VERSION` is pinned at 2.
- A merged folder's members are deleted with their OWN observed version, not the
  representative's: `deleteRemote` resolves by exact id through the cache, so an
  id-addressed provider does not reject a member's delete as `target_changed`.
- `ManagedRemoteFs` identity-addressed rename is covered by three separate cases: an
  unchanged object passes its observed version (v1) to `adapter.move`; an object that
  moved after Admission fails without any provider mutation; and an object whose version
  advanced at the same path is re-observed and CASed at the new version (v2).
  plan-executor and orchestrator tests assert the admitted path reaches the capability.
- A module whose `createAdapter` returns an adapter with missing OR out-of-enum
  capabilities makes `BackendModuleProvider.prepare()` reject and yields no filesystem.

## Provider wire shape

Client tests pin the mechanisms the adapters rely on:

- Dropbox: `mode:"add"`, `mode:{" .tag":"update","update":rev}` + `strict_conflict:true`,
  and `download` sends `rev`.
- OneDrive: zero-byte create uses the simple PUT with
  `@microsoft.graph.conflictBehavior=fail` in the URL and `If-None-Match:*`; the
  post-PUT mtime PATCH carries `If-Match: <eTag from the PUT>`; a non-empty
  preconditioned create/update routes through `createUploadSession` with
  `If-None-Match`/`If-Match`; `move`/`deleteItem` send `If-Match`.
- Google Drive: the resumable create `fields` include `version`.

## Boundary and ownership guards
`npm run lint:bot-repro` ran 66 tests, including the two-authority ownership fixture,
the Admission authority guard, and the backend-module boundary guard; all passed.

## Limits

- Google Drive has no documented provider-side content/metadata CAS
  (`conditionalContentUpdate: "none"`, `conditionalMetadataMutation: false`), recorded
  in the ADR, not a verified guarantee.
- OneDrive zero-byte content has no documented conditional carrier: its create is
  provider-enforced by `conflictBehavior`; OneDrive content updates have no
  precondition that binds the commit, so `conditionalContentUpdate` is `none` and the
  zero-byte mtime PATCH is conditional on its own PUT's eTag.
- Live provider acceptance is out of scope; the opt-in E2E is unchanged.
