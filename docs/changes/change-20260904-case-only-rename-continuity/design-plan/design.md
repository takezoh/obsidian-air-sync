# Case-only folder rename continuity

## Decision

The repair returns the engine to ADR 0001's original simple ownership model.

1. The remote cursor and per-file `SyncRecord` are the only authoritative durable sync
   states. A checkpoint is the operation that commits the cursor after a wholly clean
   cycle; it is not separate state.
2. The remote metadata cache remains a non-authoritative provider projection. Every
   clean checkpoint serializes the complete final live cache and atomically replaces
   the durable projection with the cursor. `touchedPaths` and `pendingFullPersist` are
   deleted and receive no replacement.
3. Existing affected installations cold-start only the metadata projection by bumping
   `METADATA_CACHE_VERSION` from 3 to 4. `SyncStateStore` stays at version 7 and retains
   every `SyncRecord`.
4. Admission and identity behavior do not change. `identity_postcondition_unproven`
   remains an existing cycle-local failure reason, never persisted state.
5. The authority catalog and the reviewed `SyncOrchestrator` instance-field inventory
   are mechanically pinned so another owner cannot appear as an incidental fix.

No COLD relation reconstruction, two-store reset, new status, journal, receipt,
affected-path tracker, or pending-full flag is introduced.

## Responsibility and state boundaries

```text
successful admitted file I/O
  -> state committer
  -> commit that file's terminal SyncRecord                    [authority B]

provider observation + successful executor remote mutations
  -> one ordinary live metadata cache
  -> wholly clean cycle
  -> snapshot complete live cache under its existing mutex
  -> atomically replace cache projection + commit remote cursor [authority A]

cycle not clean or checkpoint save fails
  -> no cursor/cache transaction
  -> no additional pending state
  -> existing failure/retry/COLD behavior only
```

The existing scope fingerprint is a validity tag attached to the cursor checkpoint,
not a third authority. The metadata cache is durable only as a subordinate projection;
provider truth can rebuild it. The live cache is ordinary runtime data, not an intent
log and not proof that a file operation is committed.

## Requirements

<!-- anchor: fr-ccr-01 -->
### FR-CCR-01 — Exactly two authoritative durable states

The remote cursor commits only after a wholly clean cycle. A file's `SyncRecord`
commits only after its admitted I/O succeeds. No checkpoint record, cache row, status,
receipt, or in-memory flag becomes a third authority.

<!-- anchor: fr-ccr-02 -->
### FR-CCR-02 — Complete subordinate cache snapshot

At clean finalization, `CachingRemoteFs` snapshots its complete final live cache under
the existing mutex and atomically replaces the durable metadata projection together
with the cursor. The result includes executor and observation effects by construction,
without per-path bookkeeping.

<!-- anchor: fr-ccr-03 -->
### FR-CCR-03 — No pending cache owner

`touchedPaths` and `pendingFullPersist` are removed. Failed or incomplete cycles retain
no new write-set, pending operation, receipt, recovery debt, or relation state.

<!-- anchor: fr-ccr-04 -->
### FR-CCR-04 — Metadata-only cold-start

Metadata cache version 3 is dropped and recreated as version 4. SyncState version 7 and
all `SyncRecord`/sync-content rows remain unchanged. The following sync uses the
existing no-checkpoint COLD flow.

<!-- anchor: fr-ccr-05 -->
### FR-CCR-05 — Admission remains unchanged and cycle-local

`identity_postcondition_unproven` remains an existing cycle-local fail-closed result.
This repair does not add evidence, graph edges, identity decisions, dispositions, or
persisted identity state.

<!-- anchor: nfr-ccr-01 -->
### NFR-CCR-01 — Closed and guarded state ownership

ADR 0001, `AGENTS.md`, and `docs/code-enforcement.md` name the same two authoritative
states. A source-contract test rejects an authority-catalog change, any unreviewed
`SyncOrchestrator` instance field, and the removed cache pending-state identifiers.
Changing the guard requires an explicit architectural revision, not a local exemption.

## Repository grounding and ownership

<!-- anchor: component-cache-checkpoint -->
### Cache checkpoint owner

`src/fs/caching/remote-fs.ts` owns the live cache, its mutex, and the existing
checkpoint method. `src/store/metadata-store.ts` owns atomic replacement of the
subordinate snapshot plus cursor. Backend executor methods mutate the same live cache
but do not own persistence or commit decisions.

<!-- anchor: component-file-commit -->
### File state owner

`src/sync/state-committer.ts` owns per-file `SyncRecord` persistence after successful
admitted I/O. `src/sync/sync-cycle-finalization.ts` owns whether the whole cycle is
clean enough to invoke the remote checkpoint. These boundaries stay independent.

<!-- anchor: component-state-boundary-guard -->
### State boundary guard

The operating guide and enforcement reference explain the closed catalog. A focused
source-contract test parses production source, compares `SyncOrchestrator` instance
fields with the reviewed exact list, checks the two-item authority declaration, and
rejects reintroduced pending-cache fields. The test is enforcement, not a new runtime
registry or owner.

## Implementation contracts

<!-- anchor: contract-complete-cache-checkpoint -->
### Contract: complete cache checkpoint

**Owner and inputs.** `component-cache-checkpoint` receives the live metadata cache,
live cursor, and existing checkpoint-validity metadata only when cycle finalization is
clean.

**Rule.** While holding the existing cache mutex, serialize every live cache file,
folder, path authority, and other data already represented by `MetadataStore.saveAll`.
Commit that complete snapshot and cursor in the existing single IndexedDB transaction.
Do not branch on mutation origin or remembered paths.

**Failure.** A transaction error propagates. Neither cursor nor durable projection
advances. No retry-specific state is retained; a subsequent attempt snapshots whatever
the ordinary live cache contains then.

**Observables.** Recreating a backend after clean write, implicit parent creation,
rename, delete, or folder-subtree mutation restores the exact final live projection.
Recreating after a failed checkpoint restores the prior clean projection and cursor.

**Cost.** Clean checkpoint persistence is O(current cache size). That deliberate simple
cost replaces the correctness-sensitive affected-path state machine.

<!-- anchor: contract-metadata-only-cold-start -->
### Contract: metadata-only cold-start

**Owner and evolution.** `component-cache-checkpoint` changes only
`METADATA_CACHE_VERSION` 3→4. The existing metadata-store `onUpgrade` drops and
recreates the derived stores. `SyncStateStore` remains version 7.

**Rule.** The first open has no metadata checkpoint, so normal orchestration selects its
existing COLD provider full scan. Retained `SyncRecord`s remain the per-file baseline.
There is no migration, relation inference, or special first-cycle decision.

**Observables.** A seeded v3 metadata cache is empty after v4 open. A separately seeded
v7 `SyncRecord` is still present. The first clean cycle can write a complete new
projection and cursor.

<!-- anchor: contract-state-boundary-enforcement -->
### Contract: state boundary enforcement

**Owner.** `component-state-boundary-guard` owns documentation and test-only
enforcement. It has no production runtime state.

**Rule.** The guard's reviewed authority catalog contains exactly remote cursor and
per-file `SyncRecord`. Its reviewed `SyncOrchestrator` field list matches every class
instance field and nothing else. It also asserts absence of `touchedPaths` and
`pendingFullPersist` in the cache owner.

**Change protocol.** Adding an instance field fails the normal gate. Updating the
expected list is valid only with coordinated ADR 0001, `AGENTS.md`, and
`docs/code-enforcement.md` review. An inline disable or broad pattern exception is
forbidden.

## Accepted ADR context

<!-- anchor: adr-0001-commit-last-cache -->
### ADR 0001 — Two authorities and subordinate cache

ADR 0001 is governing. State A is the clean-cycle remote cursor and state B is the
per-file `SyncRecord`. Its runtime state C explains existing same-session recovery but
is not durable authority. This repair does not add a state D. The cache is a complete
subordinate projection atomically co-committed with A.

<!-- anchor: adr-0002-shared-backends -->
### Shared backend behavior

ADR 0002 requires the behavior contract to cover every caching backend through the
central registry. The implementation belongs in the shared cache owner, with provider
tests only where a real mutation shape needs a witness.

<!-- anchor: adr-0008-fail-closed-identity -->
### Existing fail-closed identity

ADR 0008 continues to govern Admission. `identity_postcondition_unproven` is a negative
cycle result, not persisted state and not a repair mechanism for the cache defect.

## Decisions and rejected alternatives

- **Chosen:** complete live-cache snapshot at the one clean checkpoint. This removes
  mutation-footprint ownership and makes every cache producer converge at one boundary.
- **Rejected:** extend `touchedPaths` to executor mutations. It preserves the extra
  owner whose incompleteness caused this defect.
- **Rejected:** retain `pendingFullPersist`. Full versus incremental persistence is no
  longer a correctness state when every clean checkpoint writes the complete snapshot.
- **Chosen:** bump metadata cache 3→4 only. The cache is disposable; `SyncRecord` is an
  authority and must remain.
- **Rejected:** bump SyncState 7→8 or reset both databases. It destroys authority B and
  requires new baseline-free identity policy.
- **Rejected:** change Admission, resolve reported self echoes, or infer a COLD relation.
  Those are different decision algorithms and are not needed to repair the proven
  cache projection defect.

## Implementation order

### Unit 1 — Complete final cache snapshot

Remove both pending fields and convert the existing checkpoint to one complete snapshot.
Update shared cache and Google restart tests. Remove incident tests that presuppose a new
Admission rule.

### Unit 2 — Metadata-only versioned cold-start

Bump metadata cache 3→4, pin its drop/recreate behavior, and prove SyncState v7 records
survive.

### Unit 3 — State ownership enforcement and integration

Update ADR 0001, `AGENTS.md`, and `docs/code-enforcement.md`; add the source-contract
guard; run focused tests and the complete repository gate.

## Verification strategy

T1 tests cover final snapshot recreation across all caching backends, checkpoint
transaction failure, metadata-only upgrade, retained SyncRecords, ordinary COLD
selection, and the state-boundary source guard. The complete gate is
`npm run lint && npm run lint:bot-repro && npm run build && npm run test:coverage`.
Credential-gated E2E remains optional T2 fidelity evidence.

## Implementation discretion

Implementation may choose the private snapshot helper and the source-test parsing
mechanism. Escalate if the fix requires any production field, public API, per-path
bookkeeping, SyncState change, Admission/identity edit, second persistence boundary, or
exception that weakens the exact guard.
