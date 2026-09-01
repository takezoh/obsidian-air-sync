# PR54-centered priority pull implementation design

## Architecture

The normal pipeline remains:

```text
prepareSyncCycleSnapshot
  -> admitDestructivePlan
  -> persist Admission-selected rename debt
  -> execute exact AuthorizedSyncPlan actions through global phases
  -> finalize exact completion, checkpoint, and debt release
```

File-open is one coordinated pull-only operation: detached observe/read, pure eligibility against the active Admission, Local revalidation/write, whole-record CAS, and optional supersession of the same pending singleton pull object.

## Ownership

- `plan-admission.ts`: component/action policy and priority-substitutable singleton projection.
- `plan-executor.ts`: exact action ordering, global phases, permit-through-effect-and-commit.
- `orchestrator.ts`: lifecycle wiring and cycle-local exact action state; no action policy.
- `sync-cycle-finalization.ts`: exact terminality, checkpoint commit-last, debt release.
- filesystem providers: detached identity/path/version authority behind `IFileSystem.priority`.

## Verification ownership

- Contract modules define public observable semantics and are not Vitest discovery roots.
- Backend harness modules own faithful fakes and provider API-route assertions; they do not
  register themselves.
- `remote-backend-contracts.test.ts` is the only remote unit composition root. A typed
  implementation-family × contract matrix makes every required cell structural, while the
  registry guard rejects providers that create an uncatalogued FS implementation.
- Generic `CachingRemoteFs` integration owns cache/checkpoint non-interference; the Priority
  contract does not inspect checkpoint state.
- E2E owns authentication, real transport, remote isolation/cleanup, shared live CRUD, and the
  four public-operation Priority fidelity scenarios. It does not import the unit composition root
  or fake-only fault injection.

## Invariants

1. Normal actions never call the priority provider capability.
2. Only Admission-marked pending singleton pulls can be superseded.
3. Supersession requires successful whole-record CAS.
4. Stale exact pulls are invalidated, never rerouted.
5. Planning/debt persistence, normal effect+commit, priority mutation, and finalization are mutually exclusive.
6. Global phase barriers and rename lifecycle remain unchanged.
7. Coordination state is cycle-local exact object identity, not durable IDs or receipts.
8. Hash enrichment diagnostics remain batch-owned and unchanged.

## Dependency order

1. Detached provider capability and contracts.
2. Coordinator, mutation barrier, tracker generation, and whole-record CAS.
3. Admission projection, executor action state, and finalization terminality.
4. Orchestrator file-open integration and deterministic race tests.
5. Documentation, full gate, real-backend E2E, independent review.

## Contract anchors

<!-- anchor: fr-priority-001 -->
### FR-PRIORITY-001 — detached pull-only file-open

<!-- anchor: fr-supersede-001 -->
### FR-SUPERSEDE-001 — exact pending singleton supersession after CAS

<!-- anchor: fr-fail-closed-001 -->
### FR-FAIL-CLOSED-001 — stale or broad topology performs no effect

<!-- anchor: fr-order-001 -->
### FR-ORDER-001 — planning, action commit, priority, and finalization exclusion

<!-- anchor: fr-finalize-001 -->
### FR-FINALIZE-001 — exact terminality and commit-last

<!-- anchor: nfr-admission-001 -->
### NFR-ADMISSION-001 — Admission remains the normal decision SSOT

<!-- anchor: nfr-calls-001 -->
### NFR-CALLS-001 — no normal targeted calls

<!-- anchor: nfr-observe-001 -->
### NFR-OBSERVE-001 — hash enrichment observability remains batch-owned

<!-- anchor: component-filesystem-priority -->
### component-filesystem-priority

<!-- anchor: component-scheduling-primitives -->
### component-scheduling-primitives

<!-- anchor: component-plan-admission -->
### component-plan-admission

<!-- anchor: component-plan-executor -->
### component-plan-executor

<!-- anchor: component-cycle-finalization -->
### component-cycle-finalization

<!-- anchor: component-orchestrator -->
### component-orchestrator

<!-- anchor: component-design-verification -->
### component-design-verification

<!-- anchor: contract-detached-provider -->
### contract-detached-provider

<!-- anchor: contract-priority-ordering -->
### contract-priority-ordering

<!-- anchor: contract-whole-record-cas -->
### contract-whole-record-cas

<!-- anchor: contract-exact-supersession -->
### contract-exact-supersession

<!-- anchor: contract-finalization -->
### contract-finalization

<!-- anchor: adr-20260901-admission-priority-pull -->
### adr-20260901-admission-priority-pull

<!-- anchor: adr-20260831-admission-owns-identity-component-decisi -->
### adr-20260831-admission-owns-identity-component-decisi

<!-- anchor: adr-20260831-admission-owned-local-rename-constraint-lifecycle -->
### adr-20260831-admission-owned-local-rename-constraint-lifecycle
