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
3. Existing affected installations cold-start both persistence databases by bumping
   `METADATA_CACHE_VERSION` from 3 to 4 and `SyncStateStore` from 7 to 8. Current local
   and remote facts rebuild the subordinate projection and terminal records.
4. Every ordinary cycle reconstructs the case-alias decision from current component
   facts. `LocalFs` resolves stale case-colliding index entries against the raw adapter;
   Observation records endpoint, alias, identity, absence, and content facts only;
   Admission normalizes those facts and alone authorizes an explicit
   `case_alias_canonicalization`/`rename_remote` protocol.
5. `identity_postcondition_unproven` remains an existing cycle-local failure reason,
   never persisted state. No new status or cross-cycle relation is introduced.
6. The authority catalog and the reviewed `SyncOrchestrator` instance-field inventory
   are mechanically pinned so another owner cannot appear as an incidental fix.

No general rename reconstruction, coordinated two-store transaction, new status,
journal, receipt, affected-path tracker, or pending-full flag is introduced.

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

current component contains a local case alias
  -> LocalFs raw adapter proves one physical local spelling
  -> Observation proves exact/absent endpoints + unique remote identity + equal bytes
  -> Admission revalidates hash/size/scope and authorizes rename_remote
  -> evidence discarded after cycle                              [no new authority]
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
### FR-CCR-04 — Versioned cold-start

Metadata cache version 3 is dropped and recreated as version 4. SyncState version 7 is
dropped and recreated as version 8. The following sync uses the existing no-checkpoint,
no-baseline COLD flow; neither database migrates old state.

<!-- anchor: fr-ccr-05 -->
### FR-CCR-05 — Current-fact case-alias canonicalization

Only complete current component facts may authorize a case-only remote rename.
Observation acquires facts without inferring identity or action; Admission alone
normalizes and decides the component. The same facts produce the same result in COLD,
WARM, and HOT cycles regardless of unrelated records or earlier failures. Incomplete or
contradictory evidence is an explicit fail-closed decision. Evidence, dispositions, and
`identity_postcondition_unproven` stay cycle-local and are never persisted.

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

<!-- anchor: component-case-alias-canonicalization -->
### Case-alias canonicalization boundary

`src/fs/local/` owns physical-path casing resolution. `change-detector.ts` and
`change-hash-enrichment.ts` publish current observations and content facts only.
`case-alias-admission.ts` parses the fact-only alias component, while
`local-rename-admission.ts` owns typed move-state normalization. `plan-admission.ts`
owns the exhaustive decision and turns only an admitted result into an explicit
cycle-local action protocol. Executor owns pre-effect/terminal re-observation and returns no new state;
Orchestrator gains no decision or state ownership.

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

<!-- anchor: contract-metadata-cache-cold-start -->
### Contract: metadata-cache cold-start

**Owner and evolution.** `component-cache-checkpoint` changes
`METADATA_CACHE_VERSION` 3→4. Its existing `onUpgrade` independently drops and
recreates the derived cache and checkpoint stores.

**Observables.** A seeded v3 metadata cache is empty after v4 open, so the ordinary
no-checkpoint path performs a provider full scan.

<!-- anchor: contract-syncstate-cold-start -->
### Contract: SyncState cold-start

**Owner and evolution.** `component-file-commit` changes SyncState 7→8. Its existing
`onUpgrade` independently drops and recreates terminal record and merge-base stores.

**Rule.** The first open has no terminal baseline, so normal orchestration rebuilds from
current facts. The same Admission rules also apply to partial and established state.
There is no migration, persisted relation, cross-database transaction, or special
first-cycle status.

**Observables.** A seeded v7 old-casing `SyncRecord` and merge base are absent after v8
open. The first clean cycle can write current terminal records plus a complete new
projection and cursor.

<!-- anchor: contract-case-alias-canonicalization -->
### Contract: case-alias canonicalization

**Observation.** Resolve case-fold collisions from the vault index against segment-wise
raw-adapter listings and keep genuine case-sensitive siblings. Publish only local
old→new alias, exact/absent endpoints, remote identity, SHA-256, and size facts in the
immutable cycle snapshot. Do not publish rename evidence or an action, and do not read
cycle temperature, whole-store record count, prior failure, or database version.

**Admission.** Normalize one component from its entries, observations, scope, and
component-local baseline. For an unbaselined alias require local old→new alias, exact local new, exact and unique
remote old identity, stat-absent remote new, included scope, and equal SHA-256 plus
size. Complete proof yields one explicitly tagged `case_alias_canonicalization` action
whose effect is `rename_remote`; incomplete or contradictory proof yields an explicit
reject and cannot fall through to unrelated path-local rules.

For an unbaselined component, equal content does not prove historical identity. The
rule is a declared canonicalization policy for an otherwise indistinguishable current
state: the raw adapter proves there is one local physical file, its actual spelling is
canonical, and the one remote stable identity moves to that spelling without replacing
either file's content.

A baseline-backed alias enters the existing typed fresh-reconciliation state table.
The baseline-relative relation may yield rename/write, conflict, or settled; it never
uses the unbaselined equal-content protocol and Executor still receives only Admission's
explicit chosen action.

**Execution.** Re-observe the exact endpoints, expected remote identity, vacancy, size,
and byte equality immediately before the move. Afterward prove old absence, exact new
identity, and equal local/remote bytes and size. Only this terminal proof reaches normal
`SyncRecord` commit; a race is blocked and the cycle remains non-clean.

**State.** Persist none of the candidate, proof, disposition, or failure. Successful
execution writes only the normal terminal `SyncRecord`; a wholly clean cycle may then
commit the normal cursor checkpoint.

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
### Fail-closed identity and current proof

ADR 0008 continues to govern Admission. Observation may produce evidence, but Admission
alone turns complete current proof into an executable rename. Missing proof produces an
existing negative cycle result such as `identity_postcondition_unproven`; no result is
persisted.

## Decisions and rejected alternatives

- **Chosen:** complete live-cache snapshot at the one clean checkpoint. This removes
  mutation-footprint ownership and makes every cache producer converge at one boundary.
- **Rejected:** extend `touchedPaths` to executor mutations. It preserves the extra
  owner whose incompleteness caused this defect.
- **Rejected:** retain `pendingFullPersist`. Full versus incremental persistence is no
  longer a correctness state when every clean checkpoint writes the complete snapshot.
- **Chosen:** bump metadata cache 3→4 and SyncState 7→8 under their existing drop/recreate
  policy. The incompatible old path identity is discarded; this is not migration.
- **Chosen:** make the narrow current-fact case-alias proof an acquisition-temperature-
  independent Admission rule, with Observation restricted to facts.
- **Rejected:** general COLD rename pairing, content heuristics, or an ambiguous
  Admission status. These cannot prove identity and would add correctness state.

## Implementation order

### Unit 1 — Complete final cache snapshot

Remove both pending fields and convert the existing checkpoint to one complete snapshot.
Update shared cache and Google restart tests. Remove incident tests that presuppose a new
Admission rule.

### Unit 2 — Versioned persistence cold-start

Bump metadata cache 3→4 and SyncState 7→8, pin both drop/recreate behaviors, and prove
v7 old-casing records do not survive.

### Unit 3 — Current-fact case-alias canonicalization

Repair LocalFs casing observation, acquire the strict cycle-local facts, and normalize
and shape the action only inside Admission. Pin temperature/whole-store invariance plus
positive and counterexample tests at all three boundaries.

### Unit 4 — State ownership enforcement and integration

Update ADR 0001, `AGENTS.md`, and `docs/code-enforcement.md`; add the source-contract
guard; run focused tests and the complete repository gate.

## Verification strategy

T1 tests cover final snapshot recreation across all caching backends, checkpoint
transaction failure, both versioned upgrades, discarded v7 SyncRecords, actual-casing
resolution, strict case-alias Admission, temperature/record-count invariance,
end-to-end convergence, and the
state-boundary source guard. The complete gate is
`npm run lint && npm run lint:bot-repro && npm run build && npm run test:coverage`.
Credential-gated E2E remains optional T2 fidelity evidence.

## Implementation discretion

Implementation may choose the private snapshot helper and the source-test parsing
mechanism. Escalate if the fix requires any production field, public API, per-path
bookkeeping, SyncState change beyond the specified 7→8 cold-start, identity behavior
beyond the strict case-only contract, second persistence boundary, or exception that
weakens the exact guard.
