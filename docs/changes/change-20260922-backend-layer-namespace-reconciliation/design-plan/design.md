# Namespace reconciliation belongs to the remote filesystem (backend layer)

<!-- anchor: goal -->
## Goal

Move ownership of the path↔identity bijection and of provider namespace repair into the remote
filesystem — the backend layer directly in front of the sync engine — so the engine consumes a 1:1
view and converges by retry. This keeps the remedy and the no-loss invariant of
`change-20260916-cache-path-id-bijection` and replaces that change's *placement*: the rename is no
longer an admitted sync action decided by an Admission stage, and the cycle's non-commit is no
longer an `AdmissionResult` field.

## The framing

1. **The destination cannot hold two objects at one path.** Local, Dropbox and OneDrive sync
   targets are path-keyed. That is a property of the destination.
2. **The cache's path-keying mirrors it correctly.** The defect is not that the cache is path-keyed;
   it is that a source state the destination cannot represent is allowed to reach the sync engine.
3. **The layer that fronts the destination must present a 1:1 view.** The remote filesystem holds
   both the provider facts and the derived address; the sync engine holds neither. So the guarantee
   belongs at the filesystem boundary, not in Admission.
4. **Because the destination cannot represent the state, the source must stop containing it.** The
   remote filesystem renames the non-keeper on the backend. The one binding invariant is that
   nothing is lost.
5. **Convergence is a retry.** After the filesystem has changed the namespace, the cycle is not
   committed and is re-run against settled facts.

## Responsibility map

| responsibility | owner | mechanism |
|---|---|---|
| which derived path an object receives | `AbstractMetadataCache` / `address-arbitration` (unchanged) | pure arbiter over the claim set |
| detecting that two provider-resolved objects claim one derived address | remote filesystem (cache + drain, internal) | claim-set assignment; never published to the engine |
| deciding which claimant keeps the plain address | sync engine, supplied per call | committed `SyncRecord`; arbiter fallback inside the FS |
| executing the backend rename | remote filesystem | `identityRename.renameById` (`ManagedRemoteFs` → adapter `move`) |
| excluding a displaced address from `deleted` | remote filesystem, internal | existing displacement accounting |
| deciding the cycle cannot commit and must retry | remote filesystem result | reconciliation status |
| queuing and running the retry | sync engine | existing follow-up queue / abort-working-view |

## The contract

The remote filesystem gains one operation and one per-call policy input.

```ts
/** The engine's keeper decision, read from committed SyncRecords. Stateless in the FS. */
type NamespaceKeeperPolicy = (path: string, claimantIds: readonly string[]) => string | undefined;

type NamespaceReconciliation =
  | { kind: "settled" }                                   // no contention, or nothing to do
  | { kind: "changed" }                                   // provider mutated: abort + retry
  | { kind: "failed"; failures: readonly NamespaceRepairFailure[] };

interface IFileSystem {
  reconcileNamespace(policy: NamespaceKeeperPolicy): Promise<NamespaceReconciliation>;
}
```

- It runs at the cycle boundary **before the engine consumes any view**, and builds the working
  view itself (it reads the delta to find the contentions). The mutation is this explicit
  operation, invoked by the orchestrator, not a side effect of a read. Because it is first, the
  sync engine never sees the withheld claimant missing from `list`/`getChangedPaths`; a `changed`
  cycle is settled and retried before collection runs at all.
- `settled`: the built view holds no provider-resolved contention, or the policy/capability leaves
  nothing actionable. It carries the working delta it built, and change collection reads that same
  delta instead of replaying the cursor (a second replay would see no changes, exposing an empty
  view). The cycle proceeds.
- `changed`: the FS renamed one non-keeper per contended address on the backend and applied the
  provider's answers to its derived cache. It aborts its working view and the orchestrator queues a
  retry.
- `failed`: the backend refused or failed a rename. The FS returns the provider's own error; the
  orchestrator rethrows it through the attempt's classification, backoff and `MAX_RETRIES`, so a
  permanent refusal surfaces as an error rather than an immediate follow-up loop. No collision
  record is persisted; the collision never reaches Admission.

Keeper rule: the policy returns the claimant whose stable id matches a committed `SyncRecord` (by
identity, wherever the object now sits). When it returns `undefined`, the FS uses the arbiter's
admitted claimant. The rename target is
`insertConflictSuffix(path, "id-" + <renamed claimant's stable id>)`.

At most one rename is issued per contended address per cycle; when three or more ids claim one
address, the remaining non-keepers settle in later cycles, so a contention among n claimants
converges in at most n-1 reconciliation cycles. The pick (smallest withheld id) is a function of
the claim set and stable across retries.

## What is removed, and why it is safe

- `plan-admission-address-contention.ts`, `AdmissionResult.checkpointBlocked`, the
  `withheldAddresses` input to `decideIdentityComponent`, `RemoteDelta.contended` / `withheld` /
  `displacements`, the `onRemoteContention` threading, the contended notification/status-bar
  clauses, and the `plan-executor` identity-rename branch.

The arbitration, the drain settlement and the deletion subtraction are unchanged; they simply stop
being *published*. The engine's public `RemoteDelta` becomes `changedPaths` / `renamedPaths` /
`deleted` only. Because the loser is either renamed on the provider (`changed`) or the cycle does
not commit (`failed`), the engine never needs to know a collision existed.

## ADRs

<!-- anchor: adr-backend-layer-namespace-reconciliation -->
### adr-backend-layer-namespace-reconciliation

**Status: proposed.** Supersedes the *placement* of `adr-upstream-rename-remedy` in
`change-20260916-cache-path-id-bijection`; that ADR's remedy and no-loss invariant stand.

**Decision.** The remote filesystem owns the 1:1 view and the provider namespace repair. On a
provider-resolved contention it renames the non-keeper on the backend through the identity-addressed
rename capability, updates its derived cache from the provider's answer, aborts its working view,
and reports that the cycle must be retried. The keeper policy is supplied by the sync engine per
call.

**Considered alternatives.**

- *Keep the Admission stage and fix only the retry* (the state on this branch). Rejected: it leaves
  the engine interpreting a provider namespace limit and produced the measured non-termination /
  repeated-failed-repair stalls.
- *Make the engine tolerant of a stalled contention by bounding follow-ups.* Rejected: a bound is a
  recovery marker and the engine would still own a fact it cannot act on.
- *A vault-local invented address* (PR #83 shape). Rejected already in change-20260916: the invented
  address is not re-derivable from a delta page's own facts and `setFile`'s re-key guard snaps it
  back.

**Consequences.**

- The mutation-authority boundary changes: the remote filesystem performs one rename on the backend
  from the backend layer. This overturns `NFR-ADDR-004` of change-20260916 ("issued from the
  execution phase as an admitted action") and must be reflected in `AGENTS.md` when implemented.
- The remote filesystem is a mutating operation invoked by the orchestrator; reads remain pure, so
  crash-safety and the "no mutation from a drain" rule are preserved in spirit (the mutation is a
  distinct operation, not a side effect of a read).
- A backend that refuses the rename stalls the cursor while other work is retried; no state is kept.

## Failure modes

| mode | behavior |
|---|---|
| backend refuses / errors the rename | `failed`; cycle non-clean; cursor uncommitted; retried under the existing error policy |
| repair target already occupied by another object | the backend rename lands a same-named object at the target, which the next cycle observes as its own contention and reconciles; the discriminator keeps it bounded |
| concurrent writer moves the object between plan and rename | the FS re-observes by id; a mismatch is a `failed` reconciliation, not a wrong-object rename |
| no collision | `settled`; no provider request |
| no reconciliation capability (filesystem cannot repair) | `settled`; no provider mutation; the residual announce-and-withhold path, unchanged, and not asserted as 1:1 |
| many contentions in one cycle | up to one rename per contended address; `changed` retries until settled |

## Residual unknowns

- `keeper-policy-input` — exact per-call spelling.
- `provider-refusal-completion` — whether uncontested paths keep syncing while a reconciliation
  failed, or the whole cycle is incomplete.
- `reconciliation-read-cost` — extra provider reads per contended cycle.

These are recorded in `change.md`'s `unresolved_decisions`; none blocks the boundary decision.
