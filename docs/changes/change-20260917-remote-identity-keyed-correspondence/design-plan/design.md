# Remote identity-keyed correspondence — technical plan

Built on draft-2, with draft-1's surviving results grafted in and the conductor's three
settled findings applied. Reworked under the repository owner's binding authority delta
(`authority-deltas/000001-c7074fbeca79fc0c.message`, elaborated as **owner decision 5**),
which settles `adr-record-key-shape` on **(A)** — `keyPath: "remoteIdentityKey"` with a unique
index over `path` — by rejecting the frame the question was posed in rather than by answering
it on those terms. Where this document and the drafts disagree, this wins; where it and the
critique disagree about what the code does, every claim below was re-measured against `main`
at `60e85b0`.

**Second rework, under the independent plan attack and owner decision 6.** The attack returned
three blockers against the shape-(A) plan. Owner decision 6 reframed two of them and settled the
third, and this revision applies all of it:

- **6c — the constraint violation is not a third problem.** No convergence strategy, retry,
  recovery marker or queue is designed for it. Owner decision 8 then settles what *does* dispose of
  a displaced incumbent, and it is neither an ordering rule nor an evidence rule: the replacement
  deletes it (`contract-record-identity-uniqueness`).
- **6b — a `SyncRecord` whose object has left its address is removed.** Owner decision 8a
  generalises this to the model itself — the record is the correspondence, and the correspondence
  ends when the address becomes another object's — which is why no ordering hazard survives.
- **Blocker 2 is not this change's.** `idb-helper.ts:142` rejects on `tx.onerror`, where
  `tx.error` is still `null`, so **every** aborted transaction — not only a constraint
  violation — surfaces unnamed. Re-measured here against the repository's own `fake-indexeddb`:
  `[["request.onerror","ConstraintError"],["tx.onerror",null],["tx.onabort","ConstraintError"]]`
  with the store empty afterwards. The requirement that the engine name `ConstraintError` is
  **removed**; what is asserted is what is observable — fail-closed. The helper defect is
  independently repairable and is **not** repaired or worked around here.
- **6a — an empty identity is impossible and must fail loudly.** The floor belongs to
  `buildSyncRecord` itself, across all three production callers in two files, and the claim that
  the positional fallback stops type-checking is withdrawn as measured false.

Every claim added in this revision was measured against `main` at `60e85b0`; the measurements
are named where they are used, and the attack's own line references were re-checked rather than
copied.

**Third rework, under two landed measurements.** Two test files now exist in the working tree,
changed no production file, and are this plan's evidence base. Where they contradict an analytical
claim made earlier, they win, and the claim is **corrected rather than softened**.

- **`src/sync/plan-admission.test.ts`** (+408 lines, six cases) settles `unit-0`'s question. On
  every fact shape today's Observation layer emits, the guard at
  `identity-component-decision.ts:106-107` **cannot fail**: either `completeIdentityEvidence`
  fills `report.identityKey` out of the same map `indexFacts` builds `current.remote` from, so the
  comparison is a value against its own source, or the lookup misses and line 106's own
  `report.identityKey &&` precondition short-circuits it. The structural reason is that
  `RenamePair` (`fs/types.ts:74-79`) carries no identity and `collectRemoteRenameEvidence`
  (`identity-evidence.ts:16-20`) sets none, so `report.identityKey` has no independent source. The
  file's last case is the exception that fixes the shape of the claim: the guard fails **only**
  where the completion map and `current.remote` key the same entity differently, so what it
  reports there is manufactured by the enrichment, not found by the check. Two consequences are
  carried below: removing the positional enrichment is **lossless**, now measured rather than
  analysed; and **the change may no longer be justified on this guard**, because `indexFacts` does
  the discriminating work ahead of it and `bindFiles:420-421` handles the wrong-object case
  downstream.
- **`src/sync/record-rekey-across-commit.test.ts`** (508 lines, seven cases) settles what survives
  a commit, using the real `SyncStateStore` over `fake-indexeddb` driven through the
  orchestrator's own chain. **Same cycle:** the baseline is **preserved** — by identity-keyed
  binding at `identity-component-decision.ts:408-409`, **not** by the store's key; mutating
  `trackedRemote` to a path lookup kills it. **Split across cycles:** the baseline is **not
  retained** — the old row is discarded, the object is treated as new, and it is re-downloaded in
  full. No wrong-object operation occurs in either shape (`decision-engine.ts:19` yields
  `conflict`, not `delete_remote`). **Owner decision 8a settles what that second result means:** the
  split-cycle end state — the old row discarded and the object re-downloaded as new — is the
  model's **correct** behaviour, not a defect to be repaired. It is re-priced accordingly below.

**Fourth rework, under owner decision 8, which supersedes decision 7 wherever they differ and
removes work rather than adding it.** The owner settled the record model, and the settlement
collapses most of what the previous two revisions grew.

- **8a — the model.** A `SyncRecord` is the record of **a local file that is synced**. `path` is
  **mandatory**. When either side deletes the file the deletion synchronises and the record is
  deleted with it; if the object later reappears it is **a new file**, and no baseline is retained
  to recognise it as the same object returning.
- **The error this corrects.** The plan treated `SyncRecord` as a record *of the remote object*.
  It is a record *of the correspondence*, and a correspondence whose address now belongs to another
  object **has ended** — an end that is **directly observed** (`K2` is at `P` now). No evidence of
  the object's death is required, `ADR 0008` is not engaged, and the impasse the previous revision
  worked around does not exist.
- **What that dissolves, and this revision deletes.** The four-way retirement classification, the
  `checkpoint_deleted` conjunct, `currentByIdentity` as a retirement input, the fail-closed
  disposition for an unproven incumbent and its convergence narrative, `DP-7`'s ordering machinery
  — relocating-first emission, the claimer-expects-vacant expectation change, the permutation
  refusal, the `continuing`/`vacated`/`retired`/`unproven` vocabulary — and the
  baseline-continuity argument as a motivation. `DP-7`, `fr-rik-015`,
  `contract-displaced-record-retirement` and `AC-RIK-016` are **removed**, not hollowed out.
  Decision 7a survives on its own terms: the unique `path` index stays, and stays a hard
  constraint.
- **8b — two operations, cleanly separated.** A **rename** (same identity, new path) changes the
  `path` field and is a **single `put`**; the primary key does not move, which is *simpler* than
  today's `compareAndMove`. A **replacement** (same path, different identity) moves the primary
  key and is a **delete plus insert in one transaction**.
- **8d — collision resolution is #90's**, already written there, and the coupling between the two
  issues is recorded under `scope`, and again as open question 6, as a cross-issue obligation on
  #90 rather than designed here.

<!-- anchor: goal -->

The engine must never rename or delete the wrong object because the correspondence between a
vault file and a provider object is positional. That is the whole purpose (owner decision 1).
Two objects at one vault path stay impossible; representing them is not a goal here.

The problem separates into three mis-operations. None subsumes another, and no single mechanism
closes all three — though two of them turn out to close together, which is owner decision 5's
result and not the plan's original reading:

- **M1 — the in-flight mis-binding.** A remote rename report says "object X moved `old` →
  `new`", and nothing in the report names X. Admission's only cross-check on that claim is the
  guard at `identity-component-decision.ts:104-107`, and **that guard is measured to be a
  tautology**: `src/sync/plan-admission.test.ts`'s five fixtures drive the production entry and
  show the compared value is filled, by `completeIdentityEvidence`, out of the very map
  `indexFacts` builds `current.remote` from — or is absent, in which case line 106's own
  precondition skips the comparison. **The wrong-operation story this plan previously told here
  is withdrawn as false.** Fixture 3 drives exactly it — a remote object replaced at an address
  by a different id — and production admits a `match`, not a wrong rename, because
  `indexFacts` (the insert conflict at `:344-346`, the identity-multiplicity check at `:362-368`,
  the absent-versus-present check at `:374-376`) and `bindFiles:420-421` discriminate the case
  ahead of the guard. What carrying identity *with the report* buys is therefore narrower and is
  stated at that size: it replaces a check that cannot check anything with one that compares two
  independently produced values, and it removes the only failures the present guard does produce,
  which the same file's last case shows are manufactured by the enrichment out of a
  map-keying divergence rather than found in the world.
- **M2 — the baseline with no identity.** `identity-component-decision.ts:408-410` resolves
  the remote endpoint by `baseline.remoteIdentityKey` when it has one and falls back to
  `facts.remote.get(path)` — pure position — when it does not. Fixture 2 measures this arm
  end-to-end: a baseline carrying no identity binds whatever occupies the reported destination.
  In that fixture the occupant happens to be the right object; nothing in the code makes it so.
- **M3 — two baselines claiming one object.** Nothing observes identity uniqueness across
  records. With two records carrying one `remoteIdentityKey`, `bindFiles` binds the first and
  `occurrenceClaimed` silently drops the second. **The harm this plan attributed to the dropped
  address is analytical and is now marked as such**: the fall-through reaches a
  `propagate_confirmed_deletion` binding, but `materializeFile` refuses `delete_local` without a
  provider-reported deletion at that address (`identity-component-decision.ts:568-569`), so the
  "`delete_local` of a live file" claim is not established and no measurement produces it. The one
  wrong-operation candidate that *was* driven end-to-end — a local deletion under a substituted
  path, in `record-rekey-across-commit.test.ts` — yields `conflict`, never `delete_remote`. What
  the record key delivers against M3 is that the two-baseline state stops being representable, and
  that is claimed as **structural** rather than as a prevented wrong operation.

**M2 and M3 are one mechanism apart, and owner decision 5 supplies it.** Making
`remoteIdentityKey` the record store's key closes both by construction rather than by
observation: one row per identity is what a keyPath *is*, so M3 cannot be represented; and a
keyPath over a missing property is a `DataError`, so no stored baseline can lack an identity
and M2's fallback arm has no input. Neither needs a uniqueness index or a recovery branch. M2
does need one **refusal**, which owner decision 6a places in `buildSyncRecord` itself: the
`DataError` names nothing useful from inside a transaction and an empty-string identity is a
perfectly valid key, so the construction function refuses both, naming the entity, before any
store write. What the store gains besides the key is a unique index over `path`. Owner decision 7a
makes it a **hard constraint** and corrects its reason: `facts.records` is keyed by
`prevSync.path` (`identity-component-decision.ts:353`) and Admission looks up *the record for
this path*, so `SyncRecord.path` is which local file a record is the correspondence for. Two
records at one path are two correspondences for one local file — a contradiction, not two
historical facts coexisting. A real filesystem resolves such a contention by silently letting the
last writer win; the durable store must refuse instead. The index therefore refuses both a
precondition the filesystem layer already owes the engine (see the premise under `scope`) and a
state the record model cannot mean.

**What the displaced row becomes, under owner decision 8.** Under `keyPath: "path"` a publication
to an address silently displaced whatever row sat there. Under the identity key the displaced row
survives the write and holds the unique `path` index, so the displacement has to be performed
rather than inherited — and decision 8a says exactly what it is. A `SyncRecord` is the record of a
correspondence between a local file and a provider object; a correspondence whose address now
belongs to a different object **has ended**, and that end is **directly observed** by the fact
that the new object is at the address now. So the incumbent row is deleted, in the same
transaction as the write that claims its address. Nothing has to be inferred about whether the
incumbent's object still exists somewhere, because the record never asserted that it did.

**That is the whole structural argument, and it is why the unique `path` index earns its keep.**
With `keyPath: "path"`, `store.put` overwrites the incumbent **silently** (`state.ts:101-103`):
the discard is a side effect of the key, invisible at the call site and untestable. With
`remoteIdentityKey` as the key plus a unique index over `path`, writing the new correspondence
**requires deleting the old row explicitly**, or the constraint aborts the transaction. The
discard becomes an **admitted action** — captured by Admission as the publication's destination,
compared by the CAS before it is removed, and asserted by a test — instead of a property of the
keyPath nobody wrote down. That is the owner's original objection, *実ファイルシステムでは
サイレントにあと勝ちになるだけ*, answered structurally rather than by adding a mechanism.

A fourth candidate, **M4** — a record whose object moved is missed by HOT's path-keyed
`getMany` — is *already closed* on main by `needsWarmComponentAcquisition`
(`hot-acquisition-completeness.ts`), which escalates a component with a current occurrence and
no `prevSync` to WARM's `getAll()`. This plan adds nothing for it. One caveat the drafts
omitted and the critique supplied: `candidateFacts[].baseline` **is** store-derived, by
`getMany` at `change-detector.ts:147`, so the "Admission never reads the store" statement is
true of `CurrentFacts.records` (rebuilt each cycle by `indexFacts` from `MixedEntity.prevSync`)
and **not** of the direct-conflict candidate baselines.

**What the `DB_VERSION` bump does and does not do, restated for (A).** Both drafts credited
the bump with closing M2. It does not: the bump removes today's *population* of identity-less
records, not the *class*, because `buildSyncRecord` (`state-committer.ts:42`) is
`remoteIdentityKey: remote?.identityKey` with no floor. That is draft-1's result and it
stands — but under (A) the class is closed by the **key**, not by the bump, and the bump's
remaining job is what owner decision 4 always said it was: make the new store shape possible
at all, since `onUpgrade`'s drop-and-recreate is the only place a keyPath or an index can be
declared. The bound draft-1 lacked is still recorded, because it now sizes a *precondition*
rather than a residual class: Google Drive and OneDrive declare `id: string`, required
(`googledrive/types.ts:25`, `onedrive/types.ts:20`); Dropbox declares `id?: string`
(`dropbox/types.ts:23`) only because the same type also covers `deleted` tombstones, which
its own doc comment says are *"never cached"* and which `buildFromFiles` skips at
`dropbox/metadata-cache.ts:148`. Every **cached** entry of all three families therefore
carries a provider id.

**Verdict on the conductor's lens question: complementary, and now differently weighted.**
Boundary-carried identity is the only thing that can reach M1, because the rename report never
touches a store — but M1 is measured *not* to be reachable through the present guard, so the seam
half is carried as making an existing check real and removing a manufactured failure, not as
stopping a wrong operation that happens today. The record key is necessary for M2 and M3 and
cannot be replaced by anything the seam does; its payoff is **structural** and is claimed as
structural — M2 and M3 stop being representable, and the silent discard of an incumbent becomes an
admitted, compared, tested action. It is **not** baseline continuity across cycles: owner decision
8a settles that a reappearing object is a new file and no baseline is retained to recognise it, so
the split-cycle result `record-rekey-across-commit.test.ts` measures is the model working, not a
loss this change repairs. The two halves remain separable and ship independently, and the seam half
is now the one whose justification an owner should weigh hardest.

<!-- anchor: scope -->

**In scope.** `RenamePair` gains an optional identity field and three producers fill it from
one rule; rename evidence preserves it and stops re-deriving it from the destination address;
Admission's remote-rename check becomes a genuine cross-source comparison; the record store is
re-keyed to `remoteIdentityKey` with a unique index over `path` and a `DB_VERSION` bump, which
carries with it the seventeen primary-key-addressed production call sites, the six mutating
methods in `state.ts` (with `compareAndMove` collapsing into `compareAndPut`), the
`sync-content` store's key and `conflict-resolver.ts:135`; `SyncRecord.remoteIdentityKey`
becomes required and non-empty with its floor at the single construction function, and the
positional baseline fallback is retired along with every production guard that tested the
stored field's own absence; `rewritePaths` is deleted; a rename stops destroying the three-way
merge base; the relocation write order is restated over overlapping and cyclic sets;
**a replacement — a publication claiming an address a record for a different object holds — deletes
that record and inserts the new one in one transaction, where a rename is a single `put`**;
`SyncRecord.backendMeta` is
removed; the shared caching contract moves with the seam; and one measurement unit records what
production Admission actually does for five fixture shapes before any enrichment is removed.

**The upstream premise this change is entitled to, and who owes it.**

> `fs` guarantees to the sync engine that a provider object path is unique — at most one
> object exists at one address below the `IFileSystem` seam.

This is a **stated premise, not a derived result**, and this change assumes it rather than
establishing it. Owner decision 5 grants the entitlement and names the owner: a provider that
permits two objects at one name must resolve that *below* the seam, by provider rename, before
the sync engine ever observes it. That mechanism belongs to **issue #90** and its scaffold
(`docs/changes/change-20260916-cache-path-id-bijection/`); it is **out of this change's scope**
and nothing here designs it. A `SyncRecord` store asked to arbitrate two records at one path is
already being handed a violated precondition, and no keyPath choice repairs that — which is why
the unique `path` index below is a guard on this premise and not a policy mechanism.

**The coupling to issue #90, recorded precisely and not acted on (owner decision 8d).** When the
provider presents two objects at one address, the collision rule is **#90's**, already written
there as `rule-keeper` (the claimant holding a committed `SyncRecord` at the path keeps the plain
address) and `rule-target-address` (the other is renamed under a stable-id suffix), and confirmed
by the owner. For the all-new case — no claimant holds a record — the owner confirmed #90's
**deterministic** arbiter rather than a processing-order rule, because order-dependence would let
COLD and HOT rename different sides on identical facts, which `AGENTS.md` forbids: *"COLD, WARM,
and HOT are acquisition strategies only. They must produce the same Admission decision for the
same complete component facts."*

The dependency between the two issues is exactly this, and it is two sentences of **#90's** plan,
not this one:

> #90 derives *"at most one claimant can hold that record"* from **"records are path-keyed"**.
> Under this change that property comes from the **unique `path` index** instead.

The property survives the re-key; only its justification moves. **Cross-issue obligation:** #90's
`rule-keeper` and `input-committed-record` need their justification updated to cite the unique
index rather than the keyPath. That edit belongs to #90's plan and is **not attempted here**, and
it is not a seam dependency — nothing in #90's mechanism and nothing in this change's mechanism
waits on the other.

**Out of scope, deliberately.**

- Any local identity. There is none (`local-fs.test.ts:176` pins
  `entity?.identityKey === undefined`; Obsidian's `TAbstractFile`/`TFile`/`FileStats` expose no
  per-file id). See `nfr-rik-002` and `contract-local-positional-boundary`.
- Dropbox's `upsertedPaths` reclaim guard. It is positional because a tombstone has no id at
  all (`ADR 0006:63-65`); an identity-keyed guard is unconstructible, not merely worse.
- Dropbox's 18 path-derived topology sites. `extractParentIds()` returns `[]` unconditionally,
  so the shared id-chain resolver is structurally unusable there. Nothing here makes Dropbox's
  topology identity-derived.
- Any by-identity *read* of the record store. M4 is already closed; adding one would be a
  performance change with no named failure behind it.
- Making the filesystem layer *enforce* path uniqueness. That is the premise above and issue
  #90's; this change only states it, assumes it, and refuses loudly when it is violated.
- Removing `SyncStateStore.put` / `putContent`. Measured: both have zero production callers,
  exactly like `rewritePaths`. They are re-expressed with the rest of the store surface under
  the new key and otherwise recorded as an observation, not acted on. Reversal condition: a
  named mis-operation route through either.
- Widening `getChangedPaths`' result type, adding an identity input to `RenameAction`, or a new
  Admission stage. Those belong to the issue-#90 direction's scaffold
  (`docs/changes/change-20260916-cache-path-id-bijection/`) and are not merged here.
- Preserving `sync-content` **across the version bump**. That is migration code; excluded by
  owner decision 4 and by AGENTS.md. (Preserving it across a *rename* is a method-body repair
  and is in scope — see `fr-rik-013`.)
- Any operator-visible signal for the new refusal. `Logger.enabled` and
  `src/sync/sync-cycle-diagnostics.ts` are **not on main** (PR #94, `50c02c2`), and both
  `DEFAULT_SETTINGS.enableLogging` and `showSyncNotifications` are `false`
  (`settings.ts:73-74`). Every observable this plan asserts is therefore a cycle outcome — a
  failed action, an incomplete cycle, an uncommitted checkpoint — never a log line or a notice.
- **Repairing `src/store/idb-helper.ts:142`.** It registers
  `tx.onerror = () => reject(new IDBTransactionError("error", tx.error))` before
  `tx.onabort`, and per the IndexedDB error-bubbling order `tx.error` is only set during the
  abort steps — so the `onerror` rejection wins the race with `tx.error` still `null` and
  `IDBTransactionError.domName` is `null`. Measured against the repository's own
  `fake-indexeddb`: `request.onerror` → `"ConstraintError"`, `tx.onerror` → `null`,
  `tx.onabort` → `"ConstraintError"`, rows unchanged. This makes **every** aborted transaction
  surface unnamed, not only a constraint violation, so it is an ordinary helper defect with its
  own blast radius (both persistent stores) and its own repair. It is **not** repaired here and
  is **not** worked around at any call site: no CAS body catches the request-level error and no
  code re-parses a message string. What this change asserts instead is what is observable
  without the repair — the write throws, nothing is written, the action fails and the cycle does
  not complete. See open question 5.
- A convergence strategy, retry, recovery path, recovery marker or queue for the `path`-index
  violation. Owner decision 6c: the index stays a pure defect signal. A correctly built
  replacement deletes the incumbent in its own transaction and never reaches the index.
- Any evidence rule for "this object is gone", and any ordering machinery to defer a publication
  until an incumbent's own action has run. Owner decision 8a removes the question: the
  correspondence's end is directly observed, so nothing is inferred and nothing is sequenced.
  Admission gains no identity-keyed deletion report, no scope-completeness fact, no new observation
  kind, no classification vocabulary and no new failure reason.
- **Collision resolution when two provider objects are observed at one address.** That is issue
  **#90**'s, already written there as `rule-keeper` and `rule-target-address`, and confirmed by the
  owner — including, for the all-new case, #90's deterministic arbiter over a processing-order
  rule. See the coupling note below; nothing here designs it.

**Assumptions and their falsifiers.**

1. *`identity-component-decision.ts:106-107` cannot currently fail.* **No longer an assumption —
   measured, and narrowed by the measurement.** `src/sync/plan-admission.test.ts` drives five
   fixtures through `captureBatchObservation` → `admitBatchObservation` and records the branch
   taken at four sites; on every one the guard is either skipped for want of a key or passes
   against the map its key was filled from. The surviving statement is therefore *the guard cannot
   fail on any fact shape today's Observation layer emits* — **not** *the guard cannot fail*. The
   same file's last case constructs two fact shapes at the capture boundary where it **does** fail
   (`conflicting_identity`, no actions): one where an entry addressed at `P` carries a remote
   endpoint resolved at `Q`, so `completeIdentityEvidence` keys the identity by `entry.path`
   (`identity-evidence.ts:39`) while `indexFacts` keys it by `entry.remote.path`
   (`identity-component-decision.ts:349`); and one where two remote observations sit at one
   address, the keyed one carrying no hash, so `insert` keeps the hashed unkeyed prior (`:329`)
   while the completion map takes the last keyed writer (`identity-evidence.ts:36`). Both are
   divergences between the two maps' *keying*, which is `decision-input-indexfacts-insert-is-a-
   different-selection`'s limit made concrete. Whether the Observation layer can emit either shape
   is **not** established, and this plan does not claim it cannot; what it claims is that the only
   failures the guard produces are ones the enrichment manufactures, which is why removing the
   enrichment loses nothing and why it also removes those two failures. Residual falsifier: a
   *production* Observation flow reaching either divergence, which would make the removal a
   behaviour change on that flow rather than a lossless one — and would still not restore the
   wrong-operation justification, because the failures are not evidence.
2. *`selectReportFamily`'s two identity checks are currently unreachable.* Still an assumption,
   and **not** settled by the landed measurement, which asserts on the report family through the
   admitted evidence and the scope-compatibility trace rather than on `edgesByIdentity` /
   `identitiesByEdge` directly. Falsifier: a report set reaching `edgesByIdentity.size > 1` or
   `identitiesByEdge.size > 1` without a producer-carried key. It gates nothing this change
   removes, because the checks only ever tighten (`fr-rik-005`).
3. *`SyncRecord.backendMeta` has no production reader.* Measured true: the only
   non-test references are the writer (`state-committer.ts:43`), the type declaration
   (`sync/types.ts:22`), the *entity*-side merge at `hot-warm-promotion.ts:43`, and the backend
   projections that populate `FileEntity.backendMeta`. Falsifier: any named reader of
   `SyncRecord.backendMeta`.
4. *A cached Dropbox `file`/`folder` entry can lack `id`.* Under (A) this is a **precondition
   of the chosen store shape**, not a sizing question: such an entity cannot be baselined.
   Measured support: `DropboxEntry.id` is optional only because the type also covers `deleted`
   tombstones, its doc comment says a deleted entry is *"never cached"*, and `buildFromFiles`
   skips `.tag === "deleted"` (`dropbox/metadata-cache.ts:148`), so the expected population is
   near-empty. It stays on record as `unknown-dropbox-entry-without-id` — the sealed recovery's
   id for what the owner's note calls `unknown-dropbox-entity-without-id` — with its settling
   observation, the Dropbox `list_folder` contract text plus one opt-in e2e raw page dump, and
   and `contract-record-identity-floor-disposition` states what happens if it is ever violated
   rather than assuming it cannot be.
5. *The filesystem layer guarantees object-path uniqueness to the sync engine.* The premise
   above. Falsifier: a provider surface that presents two distinct objects at one address
   through `IFileSystem`. Discharging it is issue #90's; the observable here is that the
   unique `path` index aborts and the cycle fails with a constraint cause rather than the
   engine silently relating the wrong pair.

<!-- anchor: approach -->

## The measurement that drives this plan, and its limit

`completeIdentityEvidence` (`identity-evidence.ts:41-44`) attaches a remote rename's
`identityKey` by looking up `currentRemote.get(item.newPath)`. `currentRemote` is built from
`component.observations` (exact/alias) plus `component.entries`. `indexFacts`
(`identity-component-decision.ts:318-360`) builds `current.remote` from **the same two
sources**. The guard at `:106-107` then compares the attached key against
`current.remote.get(report.newPath)?.identityKey`. So the guard compares a value to the map it
was read from, and producer-carried identity is the only way to give it a second, independent
source — which is exactly what makes it a check.

**The limit, now measured rather than reserved.** Draft-2 concluded "the two maps differ only
where `indexFacts` is stricter", and that sentence outran its evidence. `indexFacts`' insert
(`identity-component-decision.ts:328-329`) is
`target.set(entity.path, prior?.hash && !entity.hash ? prior : entity)` — a different
*selection*, not a stricter check — and it keys by `entity.path`, where
`completeIdentityEvidence` keys an entry's identity by `entry.path` (`identity-evidence.ts:39`)
and takes any truthy key last-wins (`:36`). `src/sync/plan-admission.test.ts` now settles this
instead of reserving it. Its five fixtures — the shapes `fr-rik-014` names — each reach a named
branch at all four observation sites, and at none of them does the guard fail: it is skipped when
the claim carries no key (fixture 4, the lookup misses) and it passes against the map the key came
from otherwise (fixtures 1, 2, 3). Its sixth case constructs the two keying divergences directly
and shows the guard failing on both, which is exactly the limit above made concrete.

**What that buys and what it costs the plan.** It buys the removal: the enrichment's only
discriminating effect measured anywhere is to *manufacture* a `conflicting_identity` out of a
map-keying divergence, so removing it for rename evidence loses no evidence and removes two false
failures. It costs the plan its previous motivation: the guard cannot admit a wrong operation
today, so no clause here rests on that, and where the plan used to say the guard was the thing
standing between a rename report and a wrong local rename, the discrimination is measured to
happen in `indexFacts` and at `bindFiles:420-421` instead. What producer-carried identity supplies
is a second, independent source — a check where there is presently a tautology.

## Decision points

### DP-1 — Where does the carried identity come from?

| Option | Verdict |
|---|---|
| (a) `cache.idAt(newPath)` / `extractId` — the id the cache already keys on | **Rejected**, on the contract's terms rather than on a population. `DropboxMetadataCache.extractId` is `entry.id ?? entry.path_lower` (`dropbox/metadata-cache.ts:50-52`) and its own doc comment declares it a total **address** function; `dropboxEntryToEntity` sets `identityKey: entry.id` with no fallback (`dropbox/types.ts:178,188`). Under (a) the rule *"a carried identity always equals the `identityKey` a later `stat`/`list` of the same object reports"* would hold only by coincidence of the data, because the two expressions are not defined to agree — so `fr-rik-002` could not be stated as a rule at all. The reachable failure is narrower than this plan first claimed and is re-grounded below. |
| (b) `entry.id` at each producer | Correct for Drive/OneDrive and for Dropbox's delta `applyRename`, but has no answer for `diffById`, which destructures the pair as `for (const [newPath] of this.cache.entries())` and keeps only the path. Three rules instead of one. |
| (c) **the producing filesystem's own entity projection for `newPath`** | **Chosen.** One rule, definitionally equal to what Admission will later observe, and it makes (a)'s synthetic id unreachable by construction. The material is already in hand: `entries()` is typed `IterableIterator<[string, TFile]>` (`metadata-cache.ts:72`) and `abstract toEntity(path, file): FileEntity` (`:59`) is public and implemented by every backend. |

`extractId` stays legitimate as what it is — a cache-internal total *address* function, where
`path_lower` is a genuine Dropbox address for download and delete. It is not the sync identity.
`contract-seam-carried-identity` names `extractId`, `idAt` and `getPathById` as forbidden
sources for any value crossing the `IFileSystem` boundary, and that document owns the rule.

**Where (a)'s stall is actually reachable, re-measured.** The plan previously said (a) "would
fail every such rename closed". Measured, an id-less Dropbox entry produces a rename pair on
exactly one route and in exactly one sub-case:

- **Delta route — unreachable.** `dropbox/incremental-sync.ts:158` computes
  `const oldPath = entry.id ? cache.getPathById(entry.id) : undefined`, so `applyRename`
  (`:201`) is never entered for an entry with no id and no pair is pushed.
- **Full-scan route — unreachable for any path-changing rename.** `remote-fs.ts:416-421` keys on
  `this.cache.idAt(newPath)`, which for Dropbox is `entry.id ?? entry.path_lower`. For an
  id-less entry the surrogate key *is* the lowercased path, so a path-changing rename changes
  the key, `oldPathById.get(id)` misses, and the entry surfaces as delete-plus-add with no pair.
- **Full-scan route, case-only rename — reachable.** `path_lower` is stable across a case-only
  rename while the cached display path changes, so the surrogate key hits and a pair *is*
  produced. Under (a) that pair would carry `path_lower`, which no `FileEntity.identityKey` can
  ever equal, and `identity-component-decision.ts:104-107` would fail the component every cycle —
  a permanent stall on that file.

So the stall survives, at one-sub-case size rather than at class size, and the decisive argument
for (c) is the first one: the contract can be *stated* over the entity projection and cannot be
stated over `extractId`. The same correction re-homes `contract-seam-carried-identity`'s
adversarial witness, which the plan had bound to the delta-route verification that cannot host
it, onto the full-scan case-only rename where it is constructible.

### DP-2 — What happens to `completeIdentityEvidence`'s `newPath` lookup?

| Option | Verdict |
|---|---|
| (i) **Remove it for rename evidence** | **Chosen, gated on `unit-0`.** It is what makes the downstream check tautological. Keep the `stable_identity` occurrence index (`:55-73`) and the alias pass (`:46-53`), which answer different questions. |
| (ii) Keep it as a fallback | Rejected. A positionally-derived key would then be fed to `identitiesByEdge`, i.e. an *address* would masquerade as an identity claim in the very stage meant to arbitrate identity claims. |
| (iii) Keep it with a provenance tag | Rejected under constitution 4 and 8: it adds structure to preserve something whose only effect is to weaken the check. |

The claim that (i) "loses nothing" **is no longer an assumption**. `src/sync/plan-admission.test.ts`
measured it: across the five fixtures the enrichment's filled key is always the current occupant's
own key, so the comparison it feeds is a tautology, and the only shapes where the fill changes an
outcome are the two keying divergences in that file's last case — where it produces a
`conflicting_identity` the world does not support. Removing it therefore removes a tautology and
two manufactured failures and no evidence. (ii) does not become live: the condition that would
have revived it — the enrichment carrying a key the producer could not have supplied *and that key
mattering* — occurs only in those two divergences, where what it produces is noise. This DP is
closed on measurement rather than gated on one.

### DP-3 — Must a remote rename report carry an identity to be admitted?

**No.** `ADR 0008` Decision §2 has three states, verbatim: *"Equal non-empty keys relate
occurrences; unequal keys separate them. Missing keys provide no evidence."* Demanding an
identity would collapse the third into the second — treating absence of evidence as evidence of
conflict — against an accepted ADR, and would stall Dropbox's unsettled id-less case forever.
`RenamePair.identityKey` is **optional**, the `report.identityKey &&` guard keeps its shape, and
only the key's *source* changes. No rule anywhere in this plan fails a component for a missing
key.

This is a rule about **cycle-local rename evidence**. It is a different layer from what a
durable `SyncRecord` must carry, and neither discharges the other — see DP-6.

The tempting variant — require identity for *folder* renames, where the blast radius is a whole
subtree — is recorded as an open choice, gated on `unknown-dropbox-entry-without-id`.

### DP-4 — Which property keys the record? **Settled: (A), by owner decision 5.**

The plan posed this as "which mechanism delivers at-most-one-record-per-address", and offered
(A) `keyPath: "remoteIdentityKey"` + unique `path` index against (B) `keyPath: "path"` + unique
`remoteIdentityKey` index. The owner **rejected the frame**:

> 同一path のレコードを複数持とうとしているのが間違っている。path は unique制約でよい。fs は
> sync engine にオブジェクトパスのユニーク性を保証する必要がある

The store was never the thing that had to refuse a second record at one path. Path uniqueness is
an invariant the filesystem layer owes the sync engine, *upstream* of the store; a store asked to
arbitrate two records at one address has already been handed a violated precondition. With the
frame gone, the question is only what the record's identity **is**, and owner decision 2 already
answered that literally: the remote side of the correspondence is keyed by provider object
identity, with path a persisted, queryable field. **(A).** This is not reopened here, and the
comparison that once justified reopening it is retired below rather than restated.

**What (A) fixes, and it is not what the comparison was about.** Under (B) both invariants were
mechanisms the store *enforced*: one refusal for a duplicate identity, one for a duplicate
address, each needing a named error and a recovery story. Under (A) neither is a mechanism. One
row per identity is what a keyPath is; a record with no identity is a `DataError` and cannot
exist. M2 and M3 stop being things the store observes and become things the store cannot
represent. The unique `path` index that remains is a different kind of object — see the next
paragraph — and the argument that a keyPath "silently replaces" a colliding record stays
**withdrawn**, because the probe that produced it wrote one identity at two paths, which is one
object that moved and whose record correctly updates.

**The unique `path` index is a hard constraint and a guard on the premise, not a policy
mechanism.** Owner decision 7a settles that it stays, and corrects the reason the previous
revision gave for it. That revision treated two rows carrying one `path` as a benign coexistence
of historical facts. It is not: `facts.records` is keyed by `prevSync.path`
(`identity-component-decision.ts:353`) and Admission looks up *the record for this path*, so
`SyncRecord.path` is **which local file this record is the correspondence for**. Two records at
one path are two correspondences for one local file — a contradiction the record model cannot
mean, quite apart from the `fs` premise. A real filesystem resolves such a contention by silently
letting the last writer win; a durable store of correspondences must refuse. Consequently:

- It **aborts; it never replaces.** A write that would place a second record at an address held
  by a different record writes nothing.
- A `ConstraintError` from it is a **defect signal about the `fs` layer's guarantee**, not an
  expected branch. There is no recovery path, no retry, no compensating delete after the fact,
  and nothing anywhere reads the constraint as "re-plan and try again". An ordinary displacement
  never reaches the index, because a **replacement** deletes the incumbent explicitly inside its
  own transaction before inserting (owner decision 8b, below) — which is precisely the discipline
  the index exists to compel.
- It is **never mapped to the ordinary stale-baseline `false`.** Every CAS method already returns
  `false` for "the world changed under me, re-plan"; swallowing a constraint failure into that
  return would make a violated premise indistinguishable from routine staleness. It propagates as
  a thrown `IDBTransactionError`, fails the action, refuses cycle completeness
  (`sync-cycle-finalization.ts:47-49`) and leaves the checkpoint uncommitted. What distinguishes
  it from routine staleness is that **shape** — a throw where a CAS returns `false` — and not the
  `DOMException` name, which `idb-helper.ts:142` loses for every abort (see `scope`); no
  requirement here depends on the name, and the helper is not repaired or worked around.
- Because a CAS method must therefore *not* reach the index in the ordinary case, each one still
  compares the current occupant of the target address against its own expectation and returns
  `false` on mismatch. The index is what is left over when that comparison has already passed —
  which is exactly the case the premise says cannot happen.

**What follows from (A): two operations, cleanly separated (owner decision 8b).** The key change
splits what `keyPath: "path"` conflated into two operations that differ in whether the primary key
moves, and the plan owes nothing beyond naming them:

| Event | What changes | Operation |
|---|---|---|
| **rename** — same identity, new path | the `path` field only | a **single `put`**; the primary key does not move |
| **replacement** — same path, different identity | the primary key | **delete + insert, in one transaction** |

The rename case gets *simpler* than today, where path-keying forces `compareAndMove` to delete at
the old key and put at the new one — which is why that method collapses rather than being
re-expressed. The replacement case is the one the unique `path` index is for: the incumbent's
correspondence has ended, directly observed, and deleting its row is the work the old keyPath
performed silently. Admission already distinguishes the two — `identity-component-decision.ts:509-511`
and `:549-551` build `replacement: … baseline.remoteIdentityKey !== remote.identityKey` today — so
no new classification, no new evidence and no ordering is introduced; what changes is that the
store is told which operation it is performing. `contract-record-identity-uniqueness` states it.

**The work (A) carries, enumerated from `main`.** Production has 21 `SyncStateStore` call sites.
17 address a row by the store's primary key and are re-expressed; 4 are key-agnostic and are not.
This table was the owner's costing artifact; it is now the change's work inventory:

| Site | Call | Under (A) |
|---|---|---|
| `plan-executor.ts:420`, `:421`, `:436`, `:437` (via `checkRecord`, defined `:413`, whose single `store.get` is `:414`) | `store.get(path)` | reads the `path` index. It proves *absence at an address*, which is what an index answers and a keyPath no longer does. **Corrected**: the plan previously wrote `:419/:420/:435/:436`; all four were off by one, and there is exactly one `store.get` in the function |
| `state-committer.ts:24`, `:113` | `compareAndDelete(path, expected)` | deletes the row keyed by `expected.remoteIdentityKey` after comparing both that row and the occupant of `path` against `expected`. When `expected` is `undefined` there is no row to address: the call verifies the address is vacant, deletes nothing, and returns `true` — today's verified no-op, stated rather than inherited |
| `state-committer.ts:121` | `compareAndMove(source, record, destination)` | **collapses into `compareAndPut`.** When `source` and `record` carry one identity they are one row and a relocation is a field update, not a key change |
| `state-committer.ts:122` | `compareAndPut(destination, record)` | the same method. Under (A) it takes **two explicit expectations and no defaulted parameter**: `expectedRow`, for the row keyed by `record.remoteIdentityKey`, and `expectedOccupant`, for the current occupant of `record.path` read through the `path` index. `compareAndMove`'s inherited `expectedDestination` default (`state.ts:119`) disappears with the method, so `compareAndPut(undefined, record, undefined)` still means exactly what `compareAndPut(undefined, record)` means today — no row for this identity **and** the address vacant. When `expectedOccupant` names a record for a *different* identity, the call is a **replacement** and deletes that row in the same transaction before inserting |
| 24 test and mock files constructing `SyncRecord` literals; 5 files referencing `compareAndMove` | the whole type-checked test surface | **priced here, because `tsconfig.json` includes `tests/**/*.ts` as well as `src/**/*.ts`.** Measured: 27 files contain a `SyncRecord` literal (`syncedAt:`), of which three are production (`types.ts`, `state.ts`, `state-committer.ts`); `compareAndMove` is referenced in `src/sync/state.test.ts`, `src/sync/fact-first-execution.test.ts` (`:282`, `:402-417`, `:671`, `:727-742`), `src/sync/state-committer.test.ts:210-215`, `src/sync/plan-executor.test.ts:1101` and `src/__mocks__/sync-test-helpers.ts:270`; `rewritePaths` in `src/sync/state.ts:202` and `src/__mocks__/sync-test-helpers.ts:309`. The required-field change breaks every literal that omits the field and the method removal breaks every spy, so both sets are enumerated in the units that own them |
| `state-committer.ts:107` | `compareAndRewritePaths(relocations)` | every terminal is `{...source, path}` (`state-committer.ts:104-105`), so each item is an in-place update of one identity-keyed row and `store.delete(item.source.path)` disappears. What replaces it is a stated admission rule over overlapping and cyclic sets — see the discharge below |
| `state-committer.ts:70` | `compareAndPutContent(record, content)` | `sync-content` is re-keyed by `remoteIdentityKey` with the record; a merge base then survives a relocation because its key does not move |
| `conflict-resolver.ts:135` | `getContent(ctx.baselinePath ?? ctx.path)` | **a by-path read**, which draft-1 wrongly listed as "needs no change". The caller already holds the record — the expression is guarded by `ctx.baseline &&` and `baseline?: SyncRecord` (`conflict-resolver.ts:21`) — so it reads by the baseline's identity and `ctx.baselinePath` stops being consulted here |
| `opened-file-priority.ts:38`, `:77` | `get(ctx.path)` | reads the `path` index; both are "what is baselined at this address", which is an address question |
| `opened-file-priority.ts:62`, `:91` | `compareAndPut(expected, record)` | keyed by identity; the address does not move, so the destination comparison is degenerate |
| `change-detector.ts:147`, `:180` | `getMany(paths)` | **primary-key lookups**, so they move to the `path` index. `SyncStateStore.getMany` (`state.ts:61-76`) issues `store.get(p)` per path; draft-1's FR-3 table recorded `:147` as a `record.path` *field* read and concluded "three need nothing", which is false |
| `change-detector.ts:84`, `:96`, `:104` | `getAll()` | **unchanged** — `getAll` returns every value regardless of keyPath. A further correction the critique did not make: these are neither field reads nor key lookups |
| `orchestrator.ts:95` | `clear()` | unchanged |
| `change-hash-enrichment.ts:32`, `scope-projection.ts:86`, `:153` | `record.path` as a field | unchanged. `path` remains a real, persisted, queryable fact; it is simply not the identity of the row |

Inside `state.ts`, six mutating methods are rewritten — `compareAndPut` (absorbing
`compareAndMove`), `compareAndDelete`, `compareAndRewritePaths`, `compareAndPutContent`,
`delete`, and `put`, which has no production caller but must move with the surface — plus `get`,
`getMany`, `getContent` and `putContent`. `compareAndMove` ceases to exist, which is a **removal**
from the store's surface and from the ownership guard's detector set, exactly like `rewritePaths`.

**Two consequences of (A) that are not work, and are discharged here rather than deferred.**

1. *An identity-less record is unstorable, so the record layer has a floor.* A keyPath over a
   missing property is a `DataError`. `SyncRecord.remoteIdentityKey` therefore becomes
   **required**, which makes the *declared* shape a compile-time property of every construction
   site. It does **not** make `identity-component-decision.ts:408-410`'s positional arm a type
   error: the attack compiled exactly that shape with `remoteIdentityKey: string` under this
   repository's own `tsc -noEmit --skipLibCheck --strict` and it exits 0, because `""` is falsy
   so `x ? A : B` over `x: string` is a legal condition, and `eslint.config.mts` configures no
   `@typescript-eslint/no-unnecessary-condition`. The arm is retired because **the population it
   served cannot exist** — the floor at the construction function refuses an absent or empty
   identity — and that is verified by a test that fails when an identity-less record is
   constructed, never by `npm run build`. The consequence for an entity whose provider supplied
   no id is real and is named rather
   than mitigated away: it cannot be baselined, the publication fails, the cycle does not complete,
   and the same work is re-observed next cycle. That is the outcome
   `contract-record-identity-floor-disposition` states and tests. Its expected population is
   near-empty — every cached entry of all three families carries an id (assumption 4) — and the
   critique's falsification of "refuse at the Dropbox boundary" is not contradicted, because
   nothing here refuses an entity at the backend boundary or removes it from listings; the entity
   is still listed, still compared, still conflict-resolvable. What it cannot do is acquire a
   durable baseline.
2. *The relocation write order must be restated over overlapping and cyclic sets.* Today
   `compareAndRewritePaths` (`state.ts:180-188`) issues every `store.delete(item.source.path)`
   before every `store.put(item.terminal)`, and that delete is what makes an overlapping set safe.
   Under (A) it disappears, because source and terminal are one row. The hazard is now the `path`
   index: a set whose terminal addresses intersect the *other* items' source addresses aborts
   under one put order and completes under the reverse, and a cyclic set has no safe order without
   a temporary.

   **Discharge: refuse the class, do not order it.** `compareAndRewritePaths` already returns
   `false` without writing when its source or terminal address set is non-injective
   (`state.ts:167-169`). It gains one more admission condition of the same shape: if any item's
   terminal address equals a *different* item's source address, publish nothing and return
   `false`. Self-overlap (`item.source.path === item.terminal.path`, the unmoved child the current
   code already special-cases) is not overlap — it is one row whose address does not change. The
   caller's existing `throw new Error("Folder records changed before publication")`
   (`state-committer.ts:107`) is then the outcome, which is the same fail-closed route a stale
   baseline already takes.

   **Why refusing costs nothing measurable.** The only production caller builds its set from one
   folder rename: every source address lies under the old folder prefix and every terminal address
   under the new one, and a folder cannot be renamed into its own subtree, so the two sets are
   disjoint. A topological ordering would therefore be structure with no reachable failure behind
   it — the same test that rejected draft-1's folder-relocation identity check (graft 3). If a
   future caller needs overlapping sets, the refusal is a named test failure rather than a
   `ConstraintError` in production, and that is the point at which ordering earns its place.

### DP-5 — `rewritePaths`

**Remove it.** Zero callers in `src/` (measured); no compare-and-swap; its
`store.put({...record, path: newPath})` silently overwrites whatever occupies `newPath` — a
sanctioned route to precisely the mis-operation class this change exists to remove. Its
documented role (`docs/sync-pipeline.md:304`) was taken over by `compareAndRewritePaths`. Under
(A) it is additionally incoherent, since `store.put({...record, path: newPath})` rewrites a field
that is no longer the key while leaving the row it should have moved untouched.

`docs/sync-pipeline.md`'s state-commit section is stale in three further ways in the same three
lines: `:303` names `put()` for a baseline-free action and `:305` names `delete()` for deletes,
where production takes `compareAndPut` and `compareAndDelete`. Those corrections are **in
scope**, in the same edit, because leaving them is the same "the documentation routes the next
reader to the uncompared method" hazard that justifies removing `rewritePaths`. Correcting the
doc is also why `put` and `putContent` are *not* removed: the doc fix takes away the hazard
without a surface change, and neither method has a named mis-operation route of its own.

**On the enforcement triple, with the previous revision's measurement corrected.**
`rewritePaths` and `compareAndMove` both leave `MUTATING_SYNC_STATE_METHODS`
(`sync-state-ownership-guard.test.mjs:9-12`). The plan said that set is "consumed at exactly one
site, `:199`". **That is false.** Re-measured: `:199` is the call-site detector, and
`:320` is a second, hardcoded consumer —
`for (const method of ["compareAndPut", "compareAndMove", "compareAndDelete", "compareAndRewritePaths", "compareAndPutContent"])`
— which generates two negative-fixture tests per name (`records.<m>` and `records["<m>"]`) that
assert `sourceInventory(...).SyncStateStore.mutations === true` over a synthetic source. Once
`compareAndMove` leaves the detector set, both generated tests for it fail and
`npm run lint:bot-repro` goes red. So the guard file is **not** untouched.

What *is* true, and is the load-bearing half, was re-verified by hand: the four per-file
inventories stay byte-identical. `mutationCallers` is
`[opened-file-priority.ts, orchestrator.ts, state-committer.ts]`; after the change
`opened-file-priority.ts` still calls `compareAndPut`, `orchestrator.ts` still calls `clear`,
and `state-committer.ts` still calls `compareAndDelete`, `compareAndPut`, `compareAndPutContent`
and `compareAndRewritePaths` — all still in the reduced set — while `imports`, `references` and
`constructors` are untouched. That is the machine proof that this is detector hygiene and not an
intentional new writer, owner or field, so `AGENTS.md:71-73`'s triple is still not compelled and
`contract-two-authority-enforcement-triple` stays removed. What changes is that `unit-6` must
**price a fixture edit** — the two names in the detector set at `:9-12` and the generated
negative-fixture list at `:320`, edited together — and that `unit-6`'s tool guidance must stop
telling the implementer that a fixture mismatch falsifies the claim. It does not: a `:320`
failure is the *expected* consequence of removing a name from the detector set, and only an
**inventory** mismatch would falsify the claim. The fixture edit, ADR 0001's sentence and the
pipeline document's correction are carried by `unit-6` as hygiene consequent on the store
surface change, under `contract-record-identity-uniqueness` and `fr-rik-009`, with no normative
contract of their own — see the disposition of `contract-two-authority-enforcement-triple` below.

### DP-6 — What does the record layer do about an absent identity? **No longer a choice.**

This was posed as a choice between a floor and documented tolerance. Owner decision 5 removes
the choice: under (A) the floor is the store's own mechanism, and tolerance is not available at
any price. What remains is not *whether* to have a floor but *what an id-less entity gets*, and
the plan owes that answer explicitly rather than by omission.

| Option | Verdict |
|---|---|
| (a) **A floor enforced by the key, and named by the constructor** | **In force.** A keyPath over a missing property is a `DataError`, so the store cannot hold an identity-less record. `SyncRecord.remoteIdentityKey` becomes required, which makes the declared shape a compile-time property. The *value* floor is a runtime refusal and must be, because an empty string is a valid key and `remote?.identityKey` is an optional entity field: `buildSyncRecord` itself refuses an absent or empty identity, naming the entity, before any store write. Owner decision 6a puts the floor in the constructor and not in one caller, because `buildSyncRecord` has **three** production callers in **two** files — `state-committer.ts:119`, `opened-file-priority.ts:61` and `:88` — and the two the previous revision did not name both write to the store (`opened-file-priority.ts:62` and `:91`). |
| (b) Documented tolerance, with the positional fallback declared live | **Withdrawn.** It was chosen against (B), where an index skips an absent property. Under (A) there is nothing to tolerate: an identity-less record has no key. |
| (c) Synthesize an identity from the path | Rejected outright, unchanged. `ADR 0008` fixes that a missing key is no evidence, and a path-derived key would be a positional binding wearing an identity's name — the precise defect this work exists to remove. Note that (A) makes this *more* tempting, not less, because a synthetic key would make the floor go away; it is refused for exactly that reason. |

**What the id-less entity gets, stated and not mitigated away.** It is listed, compared,
conflict-resolvable and deletable-from-the-remote like any other entity. What it cannot acquire
is a durable baseline. The refusal is one branch in one function, and each of its two consumer
contexts disposes of the throw by its **own established discipline**, which the previous revision
did not distinguish:

| Caller | Disposition of the refusal |
|---|---|
| `state-committer.ts:119`, inside `commitAction` | the action fails, the cycle does not complete, the checkpoint stays uncommitted, and the entity is re-observed next cycle — the same fail-closed route `throw new Error("SyncRecord changed before terminal publication")` (`:123`) already takes |
| `opened-file-priority.ts:61` and `:88`, inside the opened-file priority attempt | this is **not** a cycle action, and its outer `try`/`catch` (`:37`, `:116-123`) already ends a failed attempt with a `warn`, `requestNormalLifecycle()` and `"failed_retryable"`, while the inner baseline commit at `:89-99` warns and defers. The refusal takes that existing route: the priority attempt does not baseline, the target is invalidated, and the work defers to the batch cycle — where the same entity reaches `commitAction` and the row above applies. Nothing is persisted and nothing is retried on the priority path's own authority |

The critique's falsification of "refuse it at the Dropbox boundary" is untouched and still
governs — nothing here removes an entity from a listing or from `decision-engine.ts:8-21`'s
reach. The expected population of this outcome is near-empty (assumption 4), and
`contract-record-identity-floor-disposition` asserts the outcome rather than asserting it cannot
occur.

**The guards that tested the stored field's own absence, enumerated and disposed of.** Making
the field required and non-empty makes every production branch that asked whether a *stored
record* carries an identity vacuous. The attack named thirteen; re-measured from `main`, the set
is larger and — more usefully — splits cleanly, because the distinction that matters is
**absent record** versus **absent field**. A `SyncRecord` may still be absent; its identity may
not. Only the second kind of test is affected:

| Kind | Sites | Disposition |
|---|---|---|
| The positional fallback itself | `identity-component-decision.ts:408-409` | **removed** (`fr-rik-012`) |
| Whole branch is the absent-identity branch | `opened-file-priority.ts:41` (`if (!expectedRecord.remoteIdentityKey) return deferToBatch(ctx);`) | **removed**; a stored baseline cannot reach it, and leaving it would assert that the population still exists |
| A vacuous conjunct or disjunct guarding a comparison | `plan-admission.ts:125`, `plan-executor.ts:556`, `:788`, `priority-batch-state.ts:63`, `change-hash-enrichment.ts:33`, `conflict-action-contract.ts:42`, `plan-admission-case-alias.ts:152`, `sync-cycle-finalization.ts:44`, `identity-evidence.ts:57`, `identity-component-decision.ts:420`, `:459` | the conjunct/disjunct is **dropped**; the comparison it guarded is unchanged. No observable changes, because the dropped term was always true (or always false, for the negated form) |
| A runtime shape validator over `unknown` | `conflict-action-contract.ts:150` (`value.remoteIdentityKey === undefined \|\| typeof value.remoteIdentityKey === "string"`) | **tightened** to require a non-empty string. This one is not vacuous: it is the only site that would otherwise keep admitting a record shape the floor forbids |
| Comparisons and optional-**record** chains — unaffected, and three of them the attack miscounted as absence branches | `identity-component-decision.ts:445`, `:510-511`, `:550-551`, `:696`, `:760`, `:766-770`; `plan-admission-graph.ts:41`; `change-hash-enrichment.ts:61`, `:66`, `:72` | **unchanged.** `baseline?.`, `prevSync?.` and `targetRecord?.` test whether the *record* exists, which stays optional; `!==` comparisons over the field are unaffected by its optionality |

Forbidden in every row: repairing a now-vacuous guard by restoring a positional route, or by
folding an absent identity to `""`.

**The empty string inverts with it.** Under (B), `""` had to be normalized to absent so that an
index would skip it. Under (A), `""` is a perfectly valid *key*, so two entities carrying it
would silently become one row — the replacement hazard the withdrawn probe was reaching for, in
the one place it is real. So the record layer's rule is that an identity is a **non-empty**
provider id, and absent and empty are one and the same violated precondition, handled by one
branch at one site. That is a different question from the rename-evidence dedupe key, where
absent and empty must remain distinguishable so two claims cannot collapse (`fr-rik-003`); one is
about admissibility, the other about encoding, and this plan no longer asserts they share an
answer.

## What stays positional, and why

This answers `unknown-positional-rename-mechanisms-residual-obligation` for seven of its eight
parts by reading; the eighth is `unit-0`'s measurement, which has now been taken and whose result
is recorded in the last two rows rather than deferred.

| Mechanism | Residual obligation |
|---|---|
| The three `RenamePair` producers | Keep path pairing for **apply ordering** and **descendant enumeration** only; identification moves to the carried key. |
| Dropbox `upsertedPaths` reclaim guard | Unchanged and unchangeable — tombstones carry no id. |
| `path-observation`'s endpoint re-observation | Unchanged — it addresses the **local** side and computes un-re-emitted descendant counterparts by suffix arithmetic. |
| `decideFolder`'s suffix coverage | Unchanged — a **completeness** obligation, not an identification one. |
| `aliasFolder` (`:628-639`) | **Settled by reading: unchanged, still needed.** Its only inputs are local *alias* observations and current occupancy. No remote identity can produce or replace a local casing alias. |
| `selectReportFamily` | **Settled: unchanged, still needed.** Its fan-out / folder-root / alignment rules are conservativeness rules whose outcome (`conflicting`) is fail-safe. Carried identity may only *tighten* (`fr-rik-005`). |
| `completeIdentityEvidence`'s `newPath` lookup | **Removed for rename evidence. `unit-0` is taken**, and it measured the removal lossless: the filled key is the current occupant's own key in every fixture, so the comparison it feeds is a tautology. Retained for `stable_identity` and the alias pass. |
| `:106-107`'s `report.identityKey &&` | **Deliberate** under `ADR 0008` (DP-3). **Measured: the guard cannot fail on any fact shape today's Observation layer emits.** The only failures it produces are the two map-keying divergences `plan-admission.test.ts`'s last case constructs at the capture boundary, which the enrichment manufactures; whether Observation can emit either is not established and is not claimed. |

One latent defect found and closed in passing: `renameEvidenceKey` (`identity-evidence.ts:22-24`)
is `${side}\0${oldPath}\0${newPath}\0${isFolder}` and omits `identityKey`, while
`selectReportFamily`'s own unique map (`identity-component-report-family.ts:16-21`) already
includes `report.identityKey ?? ""` and `sameRename` compares it. The **upstream dedupe** is
what makes the downstream arbitration dead. Once producers carry keys, `Map.set` last-wins would
silently drop one of two conflicting claims on one edge — hiding exactly the conflict the
carrier exists to expose.

## The risk the owner should see before accepting this

This makes a class of cycle *fail* that previously completed, in three places. Owner decision 8
removed the two largest items this section carried in the previous revision — the refusal to order
an address permutation and the fail-closed component — because the rules that produced them are
gone.

1. **A remote rename whose carried identity disagrees with the identity at the destination.**
   After this change the component fails with an existing `AdmissionFailureReason`, no action is
   constructed, cycle completeness is refused (`sync-cycle-finalization.ts:47-49`), the checkpoint
   stays uncommitted and the same delta replays. **What this revision removes is the claim that
   the same input mis-operates today.** `plan-admission.test.ts`'s fixture 3 drives exactly that
   shape — a remote object replaced at an address by a different id — and production admits a
   `match`, because `indexFacts` and `bindFiles:420-421` already discriminate it. So the honest
   statement of this risk is that a component which today completes on other evidence will, after
   the change, fail when the two identity sources disagree; it is a tightening, not the repair of
   a demonstrated wrong rename.
2. **A publication for a remote entity that carries no provider id.** Today it commits a record
   with `remoteIdentityKey` absent, which later resolves its endpoint positionally. After this
   change it cannot be baselined: the publication fails with a named error, nothing is written,
   and the cycle does not complete. The expected population is near-empty (assumption 4) and the
   entity is not otherwise degraded — but this is the one place where a defect *below* the
   design, in a backend's own entity projection, now stops a cycle instead of quietly producing a
   positional baseline. That trade is owner decision 5's and is recorded, not re-argued.
3. **A durable write into an address a different record already holds.** Today
   `compareAndMove`'s and `rewritePaths`' puts overwrite. After this change the unique `path`
   index aborts, the write throws, nothing is written and the cycle does not complete. This one
   should never fire at all: an ordinary displacement is a **replacement**, which deletes the
   incumbent inside its own transaction before inserting, so the index is only reachable when the
   `fs` premise is false, and if it fires the defect is upstream of the sync engine (issue #90),
   not in the code this change touches.

   **What the failure can and cannot say, stated rather than assumed.** It fails closed —
   nothing written, action failed, checkpoint uncommitted — but it arrives **unnamed**, because
   `idb-helper.ts:142` rejects on `tx.onerror` where `tx.error` is still `null` (measured
   above). That is a property of every aborted transaction on `main`, not of this change, and it
   is not repaired here. So a violated `fs` premise and any other transaction abort are, today,
   indistinguishable from the classification alone; what distinguishes them is the *shape* of
   the failure — a thrown transaction error from a CAS method that never returns `false` for it —
   and that is what this plan's witnesses assert. If the helper is repaired independently, the
   name becomes available and no requirement here needs to change to use it.

**Two behaviours an owner might expect to find here, and why they are not risks.** A publication
that claims an address held by a record for a different object **discards that record**, exactly as
`keyPath: "path"` does today — the difference is that the discard is now performed, compared and
tested rather than inherited from the key. Under owner decision 8a that is the model working: the
correspondence at that address has ended. And an address permutation behaves exactly as on `main` —
the first publication commits, the second finds its captured expectation stale and returns `false`,
the action fails, the cycle does not complete and the same delta replays. Neither is a new failure
class, and no refusal, ordering or convergence strategy is designed for either.

The reachable new *defect* risk is none of those; it is a pair that names its object **wrongly**
because the identity was drawn from a cache-internal extractor. Its mitigation is the
entity-projection source rule, owned by `contract-seam-carried-identity`, which makes the wrong
value unconstructible — not a totality guarantee on any backend's entity. The
*unnameable*-object stall is not a risk of this design at all: no rule here fails a component for
a missing key on a rename report.

Because nothing on main surfaces a cycle failure to the user by default — `Logger.enabled` and
`sync-cycle-diagnostics.ts` are not on main, and both logging settings default to `false` — a
failed component is silent to the user and visible only as work not progressing. That is the
repository's established response to an unprovable precondition and this change does not alter it,
but it is the cost of the three failures above and it is stated rather than assumed benign.

## The five high-impact unknowns carried forward

1. `unknown-renamepair-identity-omission-intent` — **dissolved by decision.** No commit, ADR or
   design clause states the omission as intentional; `adr-remote-correspondence-identity-carrier`
   now decides it, so provenance gates nothing.
2. `unknown-positional-rename-mechanisms-residual-obligation` — **settled.** Seven parts by
   reading, above; the eighth by the measurement `unit-0` owns, which has been taken. The
   enrichment's filled key is the current occupant's own key on every shape Observation emits, so
   the guard it feeds is a tautology and the removal is lossless. What replaces the unknown is a
   narrower, stated one: whether the Observation layer can emit either of the two map-keying
   divergences under which the guard does fire is not established either way, and nothing in this
   plan depends on the answer.
3. `unknown-dropbox-entry-without-id` — kept on record with its settling observation: the
   Dropbox `list_folder` contract text plus one opt-in e2e raw page dump
   (`npm run test:e2e:dropbox`). Under (A) it is a **precondition of the chosen shape**, not a
   sizing question, and it is no longer something the design waits on: measurement bounds the
   expected population to empty (`DropboxEntry.id` is optional only for `deleted` tombstones,
   which its own doc comment says are *"never cached"* and which `buildFromFiles` skips at
   `dropbox/metadata-cache.ts:148`; Drive and OneDrive declare `id: string`), and
   `contract-record-identity-floor-disposition` states the outcome for a violation instead of
   assuming one truth. It still gates whether a remote *folder* rename may ever **require** an
   identity, which stays out of scope.
4. `unknown-local-rename-missed-event-recovery` — out of reach; there is no local identity to
   recover from. Needs an explicit owner statement about the accepted product consequence.
5. `unknown-admission-outcome-end-to-end-on-main` — **taken, and its result is now load-bearing.**
   `unit-0`'s five fixture shapes exist in `src/sync/plan-admission.test.ts`, driven through
   `captureBatchObservation` → `admitBatchObservation` with the branch recorded per shape, and a
   second measurement, `src/sync/record-rekey-across-commit.test.ts`, carries the same discipline
   across the publication boundary on the real `SyncStateStore`. Both are uncommitted
   working-tree additions that changed no production file; both are part of this change's
   verification surface rather than descriptions of tests that would be written.

## Requirements

<!-- anchor: fr-rik-001 -->
### FR-RIK-001 — the seam carries the identity

Every `RenamePair` a remote filesystem produces carries, in an `identityKey` field, the provider
identity of the object at `newPath` as that filesystem's own `FileEntity` projection yields it.
The field is absent only when the projection yields none. Witness of the gap:
`src/fs/types.ts:74-79` declares exactly `oldPath`, `newPath`, `isFolder`, while all three
producers hold the material at the moment they build the pair —
`id-delta.ts:114` uses `entry.id` on a line above the `renamedPaths.push`,
`dropbox/incremental-sync.ts:158-161` reaches `applyRename` only when `entry.id` is truthy, and
`remote-fs.ts:416` destructures a `TFile` away.

<!-- anchor: fr-rik-002 -->
### FR-RIK-002 — the carried value is the projection, never the cache id

The carried identity is never `extractId`'s value. Dropbox's `entry.path_lower` fallback must
never appear as a `RenamePair.identityKey`. Equivalently: a carried identity always equals the
`identityKey` a later `stat`/`list` observation of the same object in the same cycle reports.
The counterexample this forbids is concrete — `diffById` keys on `cache.idAt(newPath)`, which for
an id-less Dropbox entry is a lowercased absolute path.

<!-- anchor: fr-rik-003 -->
### FR-RIK-003 — the identity survives to Admission unchanged

No downstream stage overwrites a carried identity, and two rename claims agreeing on side,
oldPath, newPath and isFolder but disagreeing on identityKey are not collapsed into one. A
carried key, an absent key and an empty key are three distinct values to the dedupe key and none
aliases another. This closes the `renameEvidenceKey` defect and keeps a genuine conflict visible
to the report family.

<!-- anchor: fr-rik-004 -->
### FR-RIK-004 — the validation compares independent sources

Admission's validation of a reported remote rename compares the report's carried identity
against current remote facts derived independently of that report. The path-keyed re-attachment
of a remote rename's identity from the destination address is removed. After this, "unvalidated"
means "the producer carried no identity", not "the identity was reconstructed from the address
being validated". A report carrying no identity is handled exactly as on main; no rule fails a
component for a missing key.

<!-- anchor: fr-rik-005 -->
### FR-RIK-005 — identity may only narrow

No report family, folder relation or binding that the current positional rules reject becomes
admissible because an identity is now present. `conflicting` is fail-safe — it degrades to
ordinary actions planned from current facts — so there is no benefit to trade against the risk
of widening.

<!-- anchor: fr-rik-006 -->
### FR-RIK-006 — one object, one row; one address, one row

The durable record store holds at most one `SyncRecord` per `remoteIdentityKey`, **by
construction**, because that property is the store's key. It additionally holds at most one
record per `path`, enforced by a unique index over that field. **Both fields are mandatory.**

A publication is one of exactly two operations. A **rename** — the same identity at a new address —
changes the `path` field of one row and is a **single `put`**; the primary key does not move and no
row is deleted. A **replacement** — a different identity at an address a record already holds —
moves the primary key, and **deletes the incumbent row and inserts the new one in one transaction**:
the incumbent's correspondence ended when the address became another object's, which the claiming
publication directly observes. The deletion is explicit, it is compared against the expectation
Admission captured before it is performed, and it is never left to the key to perform implicitly.

A write that would place a second record at an address a different record already holds **without
deleting that record** aborts its transaction having written
nothing and **throws** rather than returning the ordinary stale-baseline `false`; it is never
caught, never mapped onto that return, and never resolved by replacing the incumbent after the
fact. No
requirement here depends on the abort naming itself: `idb-helper.ts:142` rejects on `tx.onerror`
with `tx.error` still `null`, so on `main` every aborted transaction arrives unnamed, and that
is a separately repairable helper defect this change neither repairs nor works around. A
relocation set in which every terminal record carries its own source record's identity is never
refused by either rule, whatever its size. The failure fails the action, blocks cycle
completeness (`sync-cycle-finalization.ts:47-49`) and leaves the checkpoint uncommitted, which is
the repository's established response to an unprovable precondition.

<!-- anchor: fr-rik-007 -->
### FR-RIK-007 — every stored record carries a non-empty identity

`SyncRecord.remoteIdentityKey` is a required, non-empty string. No `SyncRecord` with an absent or
empty identity exists, and the two cases are one: an empty string is a valid IndexedDB key, so
storing it would silently fold two distinct entities into one row, while an absent one is a
`DataError`. **`buildSyncRecord` itself** admits neither and refuses, naming the entity, before
any store write — the floor belongs to the construction function, not to one caller, because it
has three production callers in two files (`state-committer.ts:119`,
`opened-file-priority.ts:61`, `:88`) and the refusal must reach all three. No caller folds an
absent identity to `""` to satisfy the declared type. This is a statement about what a *durable
record* may carry and does not constrain what a *rename report* may carry, where `ADR 0008`'s
"missing keys provide no evidence" governs and an absent key remains admissible (`fr-rik-004`).

<!-- anchor: fr-rik-008 -->
### FR-RIK-008 — version bump, no migration

`DB_VERSION` is bumped so the existing `onUpgrade` drop-and-recreate rebuilds every record from
current facts under the new key. No migration, transform or record-preserving upgrade code is
added. The version comment records the reason in the style established by the v4/v5/v7/v8
comments, and it records what the bump does **not** do: it is not what closes the identity-less
record class — the key is — and it is not a cost specific to this change, since it is the same
cold start the product already performs on reconnect, on a bound-root change and on `resetAll`.

<!-- anchor: fr-rik-009 -->
### FR-RIK-009 — the CAS-free rewrite route is deleted

`SyncStateStore.rewritePaths` is removed from the public surface, from the ownership guard's
mutating-method set and from the shared store test double, and `compareAndMove` leaves the same
three places as it collapses into `compareAndPut`. `docs/sync-pipeline.md`'s state-commit section
names the compare-and-swap routes production actually takes: `compareAndPut`,
`compareAndRewritePaths` and `compareAndDelete`. The guard's per-file **inventories** —
`imports`, `references`, `constructors` and `mutationCallers` — are byte-identical afterwards,
because the detector set is consumed as a call-site predicate and `state-committer.ts` still
calls methods that remain in it. The guard's **fixture** is not untouched: the detector set at
`sync-state-ownership-guard.test.mjs:9-12` and the hardcoded method list at `:320`, which
generates two negative-fixture tests per name, are edited together in the same change, and the
byte-identical inventories — not an untouched file — are what prove this is hygiene rather than
a new writer.

<!-- anchor: fr-rik-010 -->
### FR-RIK-010 — `SyncRecord.backendMeta` is removed

One writer (`state-committer.ts:43`), zero production readers; the identifying half of its
contents (`googleDriveId` / `oneDriveId` / `dropboxId`) duplicates `remoteIdentityKey`.
`FileEntity.backendMeta` and every backend that populates it are unaffected
(`hot-warm-promotion.ts:43` merges the *entity's* field, not the record's).

<!-- anchor: fr-rik-011 -->
### FR-RIK-011 — the guarantee binds all three families

The shared caching contract asserts, for googledrive, dropbox and onedrive alike and in both
provider orderings, that a reported remote file rename and a reported remote folder rename each
carry an `identityKey` equal to the `identityKey` observed at `newPath`, and that the pair never
carries the identity previously observed at `oldPath`'s occupant when that occupant is a
different object.

<!-- anchor: fr-rik-012 -->
### FR-RIK-012 — the positional baseline fallback is retired by construction

The positional fallback at `identity-component-decision.ts:408-410` — resolving a baseline's
remote endpoint by `facts.remote.get(path)` when `baseline.remoteIdentityKey` is absent — is
**retired**, because no stored baseline can lack an identity once that property is the record
store's key and the construction function refuses an absent or empty one. The retirement is
**population-based**, not type-based: a required `string` is not always-truthy to TypeScript
(`""` is falsy), so the arm still compiles and `npm run build` cannot discriminate. What
discriminates is a test that fails when an identity-less record is constructed. Every production
guard that tested the stored field's own absence is disposed of with the arm — removed where the
whole branch was the absent-identity branch, reduced to its comparison where the absence test was
a vacuous conjunct, and tightened where a runtime shape validator would otherwise keep admitting
the forbidden shape — and none of them is repaired by restoring a positional route or by folding
an absent identity to `""`. No rule elsewhere in this change is stated as if the fallback were
still live, and no rename report is failed in order to compensate for anything.

<!-- anchor: fr-rik-013 -->
### FR-RIK-013 — a rename preserves the merge base under the same predicate as an in-place publication

A publication that relocates a record to a different address preserves the stored three-way merge
base exactly when an in-place publication of the same record would — that is, under
`compareAndPut`'s existing invalidation predicate. Today every rename destroys it:
`compareAndMove` (`state.ts:132-133`) and `compareAndRewritePaths` (`:186-187`) delete
`sync-content` at both addresses unconditionally on CAS success, where `compareAndPut`
(`:104-108`) deletes only when `hash`, `localSize` or `remoteIdentityKey` changed. The
user-visible effect of the defect is that the next conflict on a renamed file resolves by
newer-mtime-wins instead of by three-way merge (`conflict-resolver.ts:135` falls through when
`getContent` returns nothing). Under (A) the *carry* half of this requirement is discharged by
the key rather than by code — `sync-content` is keyed by the same `remoteIdentityKey`, so a
relocation does not move the base row at all — and what survives as work is the predicate: the
two methods that delete unconditionally must apply `compareAndPut`'s predicate instead. The
predicate must survive `compareAndMove`'s collapse into `compareAndPut`, not disappear with the
method.

<!-- anchor: fr-rik-014 -->
### FR-RIK-014 — the positional mechanisms are measured before anything is removed

Five named fixture shapes are driven through the production Admission entry —
`captureBatchObservation` into `admitBatchObservation` — on unchanged production code, and the
branch taken by `selectReportFamily`, `aliasFolder`, `completeIdentityEvidence`'s `newPath`
lookup and the identity guard is asserted by name for each. The shapes are: a remote object
renamed under an unchanged local file with a baseline carrying an identity; the same with a
baseline carrying none; a remote object replaced at an address by a different id; a rename whose
evidence carries no identity; and a folder rename whose descendants are not re-emitted. No
mechanism is retired by this change; the measurement is the citation a later retirement would
need, and it is the falsifier for the claim that removing the rename enrichment loses nothing.

**This requirement is discharged, not pending.** `src/sync/plan-admission.test.ts` carries the
five shapes and its recorded result is that the guard at `identity-component-decision.ts:106-107`
**cannot fail on any fact shape today's Observation layer emits**; a sixth case records the two
map-keying divergences under which it does fail at the capture boundary, so the record is complete
in both directions rather than only in the convenient one. A second measurement,
`src/sync/record-rekey-across-commit.test.ts`, carries the same discipline across the publication
boundary on the real `SyncStateStore` over `fake-indexeddb`, and records that the same-cycle
baseline is preserved by identity-keyed binding at `identity-component-decision.ts:408-409` while
the split-cycle baseline is not retained — the old row is discarded and the object re-downloaded as
new. Under owner decision 8a that second result is the **model working**, not a defect: a
correspondence whose address now belongs to another object has ended, and a reappearing object is a
new file. The test therefore asserts it **deliberately**, as the expected end state, rather than
recording it as a loss awaiting repair. Both files are part of this change and must be landed,
cited and kept green; the plan may not describe an equivalent test that does not exist, and the
recorded results, not the plan's earlier analysis, are what any later claim cites.

<!-- anchor: nfr-rik-001 -->
### NFR-RIK-001 — no third authority, no persisted evidence

No third durable authority; no persisted evidence, rename intent, Admission disposition, retry
instruction or recovery marker; no retained in-memory correctness owner. Carried identity lives
only in the cycle's evidence and is discarded with it. The record layer's refusal for an
identity-less entity, and the store's abort for a second record at one address, are raised and
never recorded; no marker explains either; and no row is removed by anything other than the
publication that claims its address or the publication that deletes the file it records. Nothing
classifies, sequences or defers a displaced row — under owner decision 8a a replacement simply
deletes it — so there is no classification, order, disposition or deferral for anything to persist.

<!-- anchor: nfr-rik-002 -->
### NFR-RIK-002 — no invented local identity, and the non-improvements are written down

`LocalFs` keeps emitting `identityKey` undefined, local rename evidence keeps carrying no
`identityKey`, and no production branch reads a local entity's `identityKey` as evidence.
Alongside that, the change states what it does **not** improve, where a reader of the change will
find it: a missed local rename event stays unrecoverable and indistinguishable from
delete-plus-create; a cross-scope local rename still degrades to a `markDirty` on the in-scope
side only, with no surviving relation; Dropbox's topology stays path-derived; and acquisition
reach is unchanged, because the WARM escalation already closed it.

<!-- anchor: nfr-rik-003 -->
### NFR-RIK-003 — ADR 0006 and the backend boundary are preserved

Remote rename detection stays order-independent; Dropbox's `upsertedPaths` reclaim guard is
unchanged; no backend-specific import or branch is added to `src/sync/` (lint-enforced by
`BACKEND_SPECIFIC_IMPORTS`).

<!-- anchor: nfr-rik-004 -->
### NFR-RIK-004 — no new store owner, and the triple moves together

No new `SyncStateStore` importer, referencer, constructor or mutation caller, and no new
persistent-store owner. The ownership guard's four per-file **inventories** stay byte-identical,
and that — not an untouched file — is the machine proof that the two names removed from the
mutating-method set are detector hygiene over methods that no longer exist, rather than the
intentional new writer, owner or field that `AGENTS.md:71-73` binds the
ADR-0001-plus-enforcement-document triple to. The guard's own fixture **is** edited, at both
sites that consume that set (`:9-12` and the generated negative-fixture list at `:320`), which is
a consequence of the removal and not evidence of a new writer. Those
documents are still corrected in this change, as consequences of the store surface moving rather
than as an obligation this change incurs. `sync-admission-authority-guard.test.mjs` stays green
with no fixture edit — needing one would mean identity policy had moved into the store.

## Components

<!-- anchor: component-fs-rename-contract -->
### component-fs-rename-contract

`src/fs/types.ts`, `src/fs/interface.ts`. Owns `RenamePair`'s shape and its documented meaning.
`RenamePair` lives in `fs/` precisely because it is part of the `IFileSystem` contract
(`types.ts:69-73`) and appears in `IncrementalCheckpoint.getChangedPaths`, so widening it is a
cross-family act — see `scope-signal-fs-contract-widening`. Test seam: the shared contracts under
`tests/fs/`.

<!-- anchor: component-metadata-cache-identity -->
### component-metadata-cache-identity

`src/fs/caching/metadata-cache.ts`. Holds the existing public `abstract toEntity(path, file)`
(`:59`) through which the producers reach a cached path's provider identity, and `extractId`'s
total-but-synthetic id (`:48`) which they must not reach. It participates in
`contract-seam-carried-identity`, whose forbidden-source rule is what keeps the two apart; the
placement of whatever helper the producers use is interior to that contract
(`discretion-projection-helper-placement`). Test seam:
`src/fs/caching/remote-fs.contract.test.ts` plus each backend's own cache tests.

<!-- anchor: component-delta-producers -->
### component-delta-producers

`src/fs/caching/id-delta.ts` (`applyEntry`'s move branch — `entry.id` is in scope on a line above
the push), `src/fs/caching/remote-fs.ts` (`diffById`, `:411-440`),
`src/fs/dropbox/incremental-sync.ts` (`applyRename`, `:201-236` — `entry.id` is truthy by
construction, since `oldPath` was obtained through `getPathById(entry.id)`). These are the three
sites where the identity is discarded today. Test seams: new `id-delta.test.ts`, existing
`incremental-sync.test.ts`, `remote-fs.contract.test.ts`.

<!-- anchor: component-rename-evidence -->
### component-rename-evidence

`src/sync/identity-evidence.ts`, `src/sync/remote-change-source.ts`. Owns the pair→evidence
projection (`collectRemoteRenameEvidence`, `:16-20`), the dedupe key (`:22-24`) and the
completion pass (`:26-75`). Test seam: `src/sync/identity-evidence.test.ts`.

<!-- anchor: component-admission-identity-gate -->
### component-admission-identity-gate

`src/sync/identity-component-decision.ts`, `src/sync/identity-component-report-family.ts`. The
sole owner of identity policy (`AGENTS.md:109-113`; `docs/code-enforcement.md:300`). This change
touches one comparison's *source*, adds nothing to the failure union, and leaves every positional
rule alone. It is also the component the measurement in `fr-rik-014` observes, without changing
it. One further consequence of the key change lands here and is mechanical rather than policy: a
publication carries two separated expectations — the row keyed by the identity it writes, and the
row holding the address it claims — where `keyPath: "path"` conflated them, so `:509-511` and
`:549-551` must stop passing the incumbent as both. `contract-record-identity-uniqueness` states
the calling convention and owns it; Admission fills it from facts it already holds. Test seams:
`src/sync/plan-admission.test.ts` driven through
`admitBatchObservation`, and `src/sync/record-rekey-across-commit.test.ts` driven through the
orchestrator's own `collectChanges` → `prepareSyncCycleSnapshotForExecution` →
`admitBatchObservation` → `executePlan` chain over the real `SyncStateStore`.

<!-- anchor: component-local-endpoint -->
### component-local-endpoint

`src/fs/local/index.ts`, `src/sync/local-tracker.ts`, `src/sync/scheduler.ts`. Named as a
component so the boundary is a stated contract rather than an omission: this side has no identity
and this change does not give it one. Test seams: `src/fs/local/local-fs.test.ts:170-177`,
`src/sync/local-tracker.test.ts`.

<!-- anchor: component-record-store -->
### component-record-store

`src/sync/state.ts`. Owns the schema, the version counter, every CAS method, the merge-base
invalidation predicate and the store's public surface. A failed transaction already reaches the
caller as a thrown `IDBTransactionError` (`store/idb-helper.ts:158-172`), which is the observable
this change asserts and needs no change to the helper. It arrives **unnamed** —
`idb-helper.ts:142` rejects on `tx.onerror` where `tx.error` is still `null`, for every abort —
and that defect is separately repairable and deliberately untouched here (open question 5). Test
seam: `src/sync/state.test.ts` with `fake-indexeddb/auto`.

<!-- anchor: component-record-shape -->
### component-record-shape

`src/sync/types.ts`, `src/sync/state-committer.ts`. Owns `SyncRecord`'s fields, the values they
may carry, and their single construction function (`buildSyncRecord`, `:33-46`, called from
`state-committer.ts:119` and `opened-file-priority.ts:61`/`:88`). Test seam:
`src/sync/state-committer.test.ts`.

<!-- anchor: component-two-authority-enforcement -->
### component-two-authority-enforcement

`sync-state-ownership-guard.test.mjs`, `docs/code-enforcement.md`,
`docs/adr/0001-metadata-cache-is-subordinate-to-commit-last.md`, `docs/sync-pipeline.md`. The
enforcement artefacts that describe the store surface this change moves, plus the pipeline
document whose state-commit section names three methods production does not take. It carries no
contract of its own: the guard's inventories do not change, so nothing here is a normative
obligation — the work is hygiene under `contract-record-identity-uniqueness` and `fr-rik-009`,
executed by `unit-6`. Test seam: `npm run lint:bot-repro`.

<!-- anchor: component-shared-fs-contracts -->
### component-shared-fs-contracts

`tests/fs/contracts/caching-remote-fs.contract.ts`, `tests/fs/remote-backend-contracts.test.ts`
and the three `caching-remote-fs.contract-harness.ts` files. The central composition root's
`satisfies Record<RemoteBackendFamily, RequiredRemoteContractSet>` is what makes a missing family
or cell a compile error. The remote FILE/FOLDER rename cells live at
`caching-remote-fs.contract.ts:297-360`, and their current
`toEqual({ oldPath, newPath, isFolder })` literals at `:314`, `:333` and `:351-356` break the
moment `RenamePair` gains a field; they must be **updated, not loosened**.
`remote-change-detection.contract.ts` — draft-1's chosen home — contains no rename content at all,
and `stableIdentity` is an option of `ifilesystem.contract.ts:42,157`.

## Implementation contracts

<!-- anchor: contract-seam-carried-identity -->
### contract-seam-carried-identity

`RenamePair.identityKey?: string`, documented as *the producing filesystem's own `FileEntity`
projection for `newPath`*, with `extractId`, `idAt` and `getPathById` named as forbidden sources
for any value crossing the `IFileSystem` boundary. **This document owns that rule**; no other
contract restates it. Outcome partition: **determinate** (projection yields a key) / **unknown**
(it does not). There is no third outcome, no default value and no fallback.

*Operational input.* The identity of the object at `newPath`. Owner: `component-delta-producers`.
Producer: the provider, through the backend's own `toEntity` projection (external identity,
reached only through an internal component). Acquisition boundary: the cache entry already held
at the moment the pair is built. Needed by: the same expression that pushes the pair. Stability
basis: the provider's own object id, stable across rename and move by each backend's contract.
Preservation: none — the value is cycle-local and discarded with the cycle. If unavailable: the
field is absent and the `unknown` outcome applies; no substitute is read.

Normal witness (FR-RIK-001): a Google Drive delta move of `note.md` → `renamed.md` yields one
pair whose `identityKey` equals the delta entry's id and equals
`(await fs.stat("renamed.md")).identityKey`; verified by
`verify-renamepair-carries-projected-identity`. Second normal witness, Dropbox's delta route: an
id-bearing `applyRename` yields a pair whose `identityKey` is the projection's, verified by
`verify-dropbox-delta-rename-carries-entry-id`.

Adversarial witness, risk *boundary* (FR-RIK-002): **a Dropbox full-scan case-only rename of a
cached entry whose `id` is absent** yields a pair with `identityKey` **absent**, and the test
asserts that this value **differs** from what `cache.idAt` returns for the same entry, which is
`path_lower`; verified by `verify-fullscan-diff-carries-projected-identity`, which runs
`src/fs/caching/remote-fs.contract.test.ts` — the surface where `diffById` and the cache's `idAt`
are both reachable. That asserted difference is what makes `fr-rik-002` structural rather than a
convention: a future refactor that re-routes the producers through `extractId` fails a named
test.

**Why the witness is this shape and not the one the previous revision named.** It was written as
"a Dropbox full-scan rename of an entry whose `id` is absent" and bound to
`verify-dropbox-delta-rename-carries-entry-id`, which runs `incremental-sync.test.ts` — a file
that cannot host it, because `incremental-sync.ts:158` gates `applyRename` on `entry.id`. And
the full-scan route produces no pair either for a **path-changing** rename of an id-less entry,
because `remote-fs.ts:416-421` keys on `extractId = entry.id ?? entry.path_lower`, so the
surrogate key changes with the path and the entry surfaces as delete-plus-add. The one shape that
is constructible is the **case-only** rename, where `path_lower` is stable while the cached
display path changes, so the surrogate key still hits. The witness is re-homed onto that shape
and that verification; it is the same outcome, now reachable.

Forbidden result: any pair whose `identityKey` is a value no `FileEntity` for that object would
ever carry.

Preserved: `ADR 0006`'s order-independence, apply ordering, descendant enumeration, `removeTree`,
`upsertedPaths`. The change is purely additive to what is *reported*.

**Why no separate projection-helper contract.** The producers reach the identity through
`abstract toEntity(path, file)`, which is **already public** on `AbstractMetadataCache`
(`metadata-cache.ts:59`). Whatever helper they use is concrete over that public member, so no
subclass gains an obligation and no new base-class member is forced — and the outcome that would
have justified a separate document (the carried value equals the entity projection's identity) is
already stated here, adversarially witnessed here, and asserted through the public `IFileSystem`
surface by `contract-cross-family-identity-conformance`. A second statement of it at mechanism
level would forbid and verify nothing these two do not.

Delegated (`discretion-identity-lookup-call-shape`): whether each producer calls the helper once
per moved entry, hoists it, or passes the already-held `TFile`.

Delegated (`discretion-projection-helper-placement`): whether the helper is a public method on
`AbstractMetadataCache`, a protected one plus a public accessor, or a free function over the
cache's public getters.

<!-- anchor: contract-evidence-identity-preservation -->
### contract-evidence-identity-preservation

`collectRemoteRenameEvidence` copies `identityKey` through and adds nothing when absent. The
dedupe key distinguishes carried / absent / different, and a carried key, an absent key and an
empty key never alias into one entry. That is a question about *encoding*, and it is deliberately
**not** the record layer's question: `contract-record-identity-floor-disposition` decides
admissibility, where absent and empty are one violated precondition. The two answers differ
because the questions do, and this plan no longer claims they are one answer given once.
`completeIdentityEvidence` no longer attaches a remote rename's identity from a
destination-address lookup; its `stable_identity` occurrence index and alias pass are untouched.

Partition: **determinate** (producer carried a key) / **unknown** (it did not — no identity is
attached from any address) / **conflicting** (two claims share side/oldPath/newPath/isFolder and
carry different keys, now preserved for the report family to reject). Local claims are always
`unknown` by construction and that is not a failure.

Normal witness (FR-RIK-003): a pair carrying `id:X` yields evidence carrying `id:X`. Adversarial
witness, risk *stale/partial data*: two pairs for `a.md → b.md`, one carrying `id:X` and one
carrying `id:Y`, produce **two** evidence items — today they collapse to one arbitrarily, because
`renameEvidenceKey` omits the identity while `selectReportFamily`'s own map includes it.
Forbidden result: a remote rename reaching Admission with an `identityKey` the producer did not
supply.

**Precondition, discharged.** The removal of the `newPath` enrichment is admitted only after
`contract-positional-mechanism-evidence` has recorded the branch each of its five shapes takes on
unchanged production code. That measurement has been taken and it clears the removal: on every
shape the enrichment supplies the current occupant's own key, so the guard it feeds compares a
value to its own source. The condition that would have withdrawn this clause — the enrichment
supplying a key the producer could not have supplied *and* that key changing an outcome — occurs
only in the two map-keying divergences the measurement constructs directly, where the outcome it
changes is a `conflicting_identity` unsupported by any fact. Removing the enrichment therefore
removes those two manufactured failures along with the tautology, and that is an intended effect,
not a withdrawn precondition.

Delegated (`discretion-dedupe-key-encoding`): how `identityKey` is encoded into the private key.

<!-- anchor: contract-cross-source-rename-validation -->
### contract-cross-source-rename-validation

The remote-rename check at `identity-component-decision.ts:105-107` keeps its shape and its
`report.identityKey &&` guard; what changes is that the key now originates at the producer rather
than at the map it is compared against.

Partition: **determinate** — carried key equals the current remote fact at `newPath`; the relation
may be bound. **unknown** — no carried key; `ADR 0008` forbids reading absence as evidence, so the
report is handled exactly as on main. **conflicting** — carried key differs; the component fails
with an existing failure reason, cycle completeness is blocked, the checkpoint stays uncommitted
and the same delta replays. No outcome authorizes a rename the positional rules already reject
(`fr-rik-005`).

*Operational input.* The current remote fact at `newPath`. Owner:
`component-admission-identity-gate`. Producer: `indexFacts`, from `component.observations` and
`component.entries` (internal). Acquisition boundary: the component's own fact index, built in
this cycle. Needed by: the guard, in the same pass. Stability basis: current-cycle observation
only; nothing is carried across cycles. If unavailable: the map yields `undefined`, the
comparison is against a carried key, and the mismatch is `conflicting` — which is the same
fail-closed direction as every other unprovable precondition here.

Normal witness (FR-RIK-004): remote rename `a.md → b.md` carrying `id:X`, current remote at `b.md`
is `id:X`, baseline at `a.md` carries `id:X` → the same actions main produces today. Adversarial
witness, risk *mutation between observation sources*: the same rename with the current remote at
`b.md` being `id:Y` → component fails, **no action**.

**The RED half of that witness has to be staged at the producer, and the plan previously staged it
wrongly.** It said "on main this produces an action: the local `a.md` is renamed to `b.md` and X's
baseline is relocated onto Y's address". Both halves are corrected here. First, a *report* that
already carries `id:X` is left alone by `completeIdentityEvidence` — the map clause is guarded by
`!item.identityKey` (`identity-evidence.ts:41-44`) — so such a fixture **already fails on main**
and is no RED witness at all. The input that differs between main and the change is the producer's
**pair**, which on main carries no identity: the report reaches Admission keyless, the enrichment
fills `id:Y` from the destination, the guard passes and the component is admitted. Second, the
action main then produces is not a wrong rename. With `currentByIdentity` unable to resolve `id:X`,
`bindFiles` binds the baseline at its own address and the component decides `a.md` on its own
content; `src/sync/plan-admission.test.ts`'s fixture 3 measures the same-address form of this and
records a `match`. So the RED witness is *main admits actions for this input and the change admits
none*, and it must be staged by giving the pair an identity rather than by hand-keying the report.
Second adversarial witness, risk *partial data* (FR-RIK-005): the same report carrying no key →
main's behaviour exactly, unchanged.

Forbidden results: a new `AdmissionFailureReason` member; a persisted failure; any relaxation of
`selectReportFamily`, `decideFolder` or `aliasFolder`; any rule that fails a component because a
report carries no key.

Delegated (`discretion-failure-reason-reuse`): reuse `conflicting_identity` or another existing
member.

<!-- anchor: contract-positional-mechanism-evidence -->
### contract-positional-mechanism-evidence

Five fixtures drive `captureBatchObservation` into `admitBatchObservation` on **unchanged**
production code and assert, by name, the branch taken by `selectReportFamily`, `aliasFolder`,
`completeIdentityEvidence`'s `newPath` lookup and the identity guard. The assertions must fail
when a branch changes.

**The measurement has been taken, and this contract records its result rather than the work.**
`src/sync/plan-admission.test.ts` carries it as one `describe` block of six cases, added without
modifying any production file, instrumented through the one production input
`immutableSnapshot` copies by reference (`ScopeProjection.isConfiguredScopeCompatible`) so the
execution trace is obtained without calling an internal. What it recorded:

| Shape | `selectReportFamily` | `aliasFolder` | evidence fill | identity guard | outcome |
|---|---|---|---|---|---|
| 1 — remote rename, baseline with an identity | `reported` | no directory alias candidate | filled from the `newPath` lookup | passed; filled key equals the current identity | `rename_local` |
| 2 — the same, baseline with **no** identity | `reported` | no directory alias candidate | filled from the `newPath` lookup | passed | `rename_local` |
| 3 — a remote object replaced at an address by a different id | `reported` | no directory alias candidate | filled from the `newPath` lookup, yielding the **current occupant's** id, not the baseline's | passed | `match` — **not** a wrong rename |
| 4 — a rename whose evidence carries no identity | `reported` | no directory alias candidate | lookup ran and **missed** | not reached; line 106's precondition short-circuits | `rename_local` |
| 5 — a folder rename whose descendants are not re-emitted | `none` | relation selected | no remote rename evidence | not reached | `rename_remote` |

**The recorded answer to the question this contract exists to settle.** The guard at
`identity-component-decision.ts:106-107` **cannot fail on any fact shape today's Observation layer
emits**: either the `newPath` lookup hits, in which case the filled key equals the map it was read
from, or it misses and line 106's own precondition short-circuits the comparison. The structural
reason is that `RenamePair` (`fs/types.ts:74-79`) carries no identity and
`collectRemoteRenameEvidence` (`identity-evidence.ts:16-20`) sets none, so `report.identityKey` has
no independent source. Removing the positional enrichment is therefore **lossless — measured, not
analysed** — and the change is **not** justified on this guard, because shape 3 shows `indexFacts`
doing the discriminating work ahead of it and `bindFiles:420-421` handling the wrong-object case
downstream.

**The record is complete in both directions.** The sixth case constructs the two divergences under
which the guard *does* fail at the capture boundary — an entry addressed at one path carrying a
remote endpoint resolved at another (`identity-evidence.ts:39` keys by `entry.path`,
`identity-component-decision.ts:349` by `entry.remote.path`), and two remote observations at one
address where the keyed one carries no hash (`insert` keeps the hashed unkeyed prior at `:329`
while the completion map takes the last keyed writer at `identity-evidence.ts:36`) — and records
`conflicting_identity` with no actions for both. Whether Observation can emit either shape is
**not** established, and this plan claims neither that it can nor that it cannot; what follows
either way is that the only failures the guard produces are manufactured by the enrichment, so
removing it loses no evidence.

Partition: **determinate** (every shape reaches a named branch and the branch is recorded) /
**unknown** (a shape cannot be constructed through the production entry, which is recorded with
the reason rather than replaced by a direct call to an internal function). This contract retires
nothing and claims nothing about what *should* survive; it produces the citation a later
retirement would need, and the falsifier for assumptions 1 and 2.

*Operational input.* The branch production Admission actually takes. Owner:
`component-admission-identity-gate`. Producer: the production Admission entry itself (internal).
Acquisition boundary: a Vitest run — the recovery states explicitly that reading cannot settle
this. Needed by: before `contract-evidence-identity-preservation`'s removal clause is admitted.
Stability basis: production code at the commit under test; the fixtures are re-run by the gate, so
the record cannot silently rot. If unavailable: no mechanism is retired and the enrichment removal
does not proceed, which is this change's default.

Normal witness (FR-RIK-014): shape 1 — a remote object renamed under an unchanged local file with
a baseline carrying an identity — reaches a named branch at each of the four sites and produces the
action main produces. **Recorded green.** Adversarial witness, risk *stale/partial data*: shape 5 —
a folder rename whose descendants are not re-emitted — reaches a named branch rather than an
unclassified fall-through, and shape 3 — a remote object replaced at an address by a different
id — is the one that had to show whether `:106-107` can fail today. **Recorded: it does not; the
component is authorized with a `match`.** Second adversarial witness, risk *stale/partial data*:
the two map-keying divergences, which must continue to record `conflicting_identity` with no
actions, so that the boundary of the "cannot fail" claim stays pinned rather than being softened
into "never fails". Forbidden results: asserting on an internal function called directly instead of
through `admitBatchObservation`, which would not answer the unknown; and deleting or weakening the
divergence case in order to make the lossless-removal claim read more cleanly.

Shape 2 — the same rename with a baseline carrying **no** identity — is measurable here precisely
because this contract runs against unchanged production code. It becomes unconstructible as soon
as `SyncRecord.remoteIdentityKey` is required and `buildSyncRecord` acquires its floor, which is
the observable form of `fr-rik-012`'s retirement; the measurement is therefore taken before
`unit-5` — which, after the sequencing inversion, is the first unit that touches the record
shape — and the shape's disappearance is the expected outcome rather than a lost case. It has been
taken: the fixture asserts `baseline.remoteIdentityKey` is `undefined` before driving the entry, so
the case is self-documenting about why it must later be deleted rather than repaired.

**What must change in the measurement file when the change lands, priced here.** Shape 2 and the
`recordFor(entity(...))` helper it uses stop compiling once `SyncRecord.remoteIdentityKey` is
required, so `unit-5` deletes shape 2 and cites this paragraph as the reason; every other fixture
gains a non-empty identity on its baseline literal. `unit-2` must update fixtures 1-3's
`evidenceFill` expectation from `filled_from_newPath_lookup` to the no-fill branch, and fixture 4's
from `newPath_lookup_missed` to the same, because the enrichment it measures is the thing being
removed — and the sixth case's two divergences must then record the guard as **not reached** rather
than as `conflicting_identity`, which is the observable form of "the removal takes the manufactured
failures with it". None of these edits may loosen an assertion into a partial match.

<!-- anchor: contract-local-positional-boundary -->
### contract-local-positional-boundary

A stated contract, not an omission: every local endpoint is `unknown` with respect to provider
identity, permanently and by construction. `LocalFs` emits `identityKey` undefined at all six
construction sites; Obsidian's `TAbstractFile`/`TFile`/`FileStats` expose no per-file id; the only
old→new local pairing is the live `vault.on("rename")` event, held in memory and never persisted
(`adr-20260903-stateless-current-state-recovery`).

A local rename is therefore bound by the event plus `bindFiles`'s vacancy checks plus the
executor's terminal proofs, never by an identity. Normal witness (NFR-RIK-002):
`local-fs.test.ts:176` continues to pin `entity?.identityKey === undefined`. Adversarial witness,
risk *unsupported environment*: a rename performed outside Obsidian, or across a restart, remains
indistinguishable from delete-plus-create — this design does not improve it and does not pretend
to (`unknown-local-rename-missed-event-recovery`). Second adversarial witness, risk *boundary*: a
local rename that crosses the sync scope still degrades to a `markDirty` on the in-scope side
only, with no surviving relation; the change must not be read as giving a guarantee there.
Forbidden result: any production branch reading a local entity's `identityKey` as evidence.

<!-- anchor: contract-record-identity-uniqueness -->
### contract-record-identity-uniqueness

`sync-records` is created with `keyPath: "remoteIdentityKey"` and
`createIndex("path", "path", { unique: true })`; `sync-content` is re-keyed to
`remoteIdentityKey` with it and needs no index, because nothing reads a merge base by address
once `conflict-resolver.ts:135` reads it by the baseline it already holds. `DB_VERSION` is
bumped; the existing `onUpgrade` drops and recreates, which is the only place either declaration
is legal. `rewritePaths` is deleted and `compareAndMove` collapses into `compareAndPut`.

**Two invariants, two very different mechanisms.**

| Invariant | Mechanism | What a violation means |
|---|---|---|
| at most one record per remote identity | the keyPath, by construction | unrepresentable; there is no violation to handle |
| at most one record per vault address | the unique `path` index, which aborts | the `fs` premise under `scope` is broken — a defect signal, not an outcome |

**The two expectations every CAS method now takes.** Under `keyPath: "path"` one captured record
served as both "the row this publication continues" and "the row holding this address", because
they were the same row. Under (A) they separate, so each method takes both **explicitly**, with
no defaulted parameter:

| Parameter | Meaning | `undefined` means |
|---|---|---|
| `expectedRow` | the row keyed by `record.remoteIdentityKey` | the store holds no row for this identity — a create |
| `expectedOccupant` | the current occupant of `record.path`, read through the `path` index | the address is vacant |

`compareAndMove`'s inherited default `expected.path === record.path ? expected : undefined`
(`state.ts:119`) disappears with the method and is not re-created anywhere, so
`compareAndPut(undefined, record, undefined)` still carries today's vacancy check for a
baseline-free create exactly as `compareAndPut(undefined, record)` does — an occupied address
where vacancy was expected is a stale destination, so
`verify-refusals-return-false-without-reaching-the-index` covers the create case as
well as the update case and must include it, alongside the stale replacement expectation and the
overlapping and cyclic relocation sets — all four are the same observable, a `false` return with
nothing written and the index never reached. `compareAndDelete(path,
expected)` deletes the row keyed by `expected.remoteIdentityKey` after comparing that row and the
occupant of `path`; with `expected === undefined` there is no row to address, so it verifies the
address is vacant, deletes nothing and returns `true` — today's verified no-op, stated rather than
inherited.

Admission fills the two expectations from facts it already holds, and the derivation is mechanical
rather than a policy: `expectedRow` is the row carrying the identity this publication writes —
`undefined` for a **replacement**, because the store holds no row for the new object yet — and
`expectedOccupant` is the row holding the claimed address. Under `keyPath: "path"` one captured
record filled both roles, which is why `identity-component-decision.ts:509-511` and `:549-551`
today build `publication: { source: expected, destination: expected }` for a same-address
replacement. That must separate: a replacement's continued row is `undefined` and the incumbent is
the destination. Left as it is, the CAS would look for a row keyed by the *new* identity, compare
it against the *old* record, and return `false` on every cycle.

**The two operations (owner decision 8b).** Every publication is one of exactly two, and the store
is told which:

| Operation | Condition | What the store does |
|---|---|---|
| **rename** | `expectedRow` and the terminal carry one identity; only `path` differs | a **single `put`**. The primary key does not move, no row is deleted, and `sync-content`'s row does not move either because it is keyed the same way |
| **replacement** | `expectedOccupant` is a record for a **different** identity than the terminal's | **delete the incumbent and insert the terminal, in one transaction**, after comparing the incumbent against `expectedOccupant` |

The rename case is *simpler* than today's `compareAndMove`, which had to delete at the old key and
put at the new one; that is why the method collapses rather than being re-expressed. The
replacement case is the whole point of the unique `path` index: under `keyPath: "path"`,
`store.put` discards the incumbent **silently** (`state.ts:101-103`), and here the discard must be
written, compared and tested or the constraint aborts the transaction. Nothing is inferred about
the incumbent's object — owner decision 8a settles that a correspondence whose address now belongs
to another object has ended, and the claiming publication observes that end directly.

Partition: **determinate** — the CAS method's own comparisons pass and the write applies, deleting
a displaced incumbent in the same transaction when the publication is a replacement.
**conflicting** — a comparison fails (the
identity-keyed row is not `expectedRow`, or the current occupant of the target address is not
`expectedOccupant`), so nothing is written and the method returns `false`, exactly as a stale
baseline does today. The comparison **precedes** the delete, so a replacement whose expectation has
gone stale removes nothing: a stale expectation can never destroy a row the engine did not admit.
**unknown** — the write nonetheless reached the unique `path` index and the
index aborted it, which means both comparisons passed while two distinct records still claimed
one address; nothing is written and the transaction failure **propagates as a throw**.
Conflicting produces the ordinary re-plan; unknown fails the action, blocks cycle completeness
and leaves the checkpoint uncommitted.

**The `unknown` outcome is the guard, and it must stay loud — but "loud" is a shape, not a
name.** Each CAS method compares the current occupant of the address it is about to claim against
`expectedOccupant` before writing, so an ordinary stale destination is `conflicting` and never
reaches the index; and an ordinary *displacement* is a replacement, which deletes the incumbent in
its own transaction before inserting, so it never reaches the index either. The index is
therefore only reachable when the `fs` premise is false, and the contract's obligation is
negative: the abort is **not** caught, **not** mapped to the boolean `false`, and **not**
compensated by deleting the incumbent. It reaches the caller as a thrown `IDBTransactionError`
from `idb-helper.ts`, and that — a throw where a stale baseline returns `false` — is the
observable this contract asserts.

**What this contract deliberately no longer requires, and why.** The previous revision required
the failure to carry `domName === "ConstraintError"`. Measured, it cannot:
`idb-helper.ts:139-143` registers `tx.onerror` before `tx.onabort`, and per the IndexedDB
error-bubbling order the transaction's `error` attribute is only set during the abort steps, so
the `onerror` rejection wins the race with `tx.error` still `null`. Probed against the
repository's own `fake-indexeddb`:
`[["request.onerror","ConstraintError"],["tx.onerror",null],["tx.onabort","ConstraintError"]]`,
store empty afterwards. Every aborted transaction surfaces unnamed, not only a constraint
violation. Both repairs an implementer would otherwise reach for — catching the request-level
error, or re-parsing the message string — remain **forbidden** below, and the helper is **not**
changed by this contract or worked around at any call site; it is an independently repairable
defect (open question 5). Fail-closed is intact throughout; only the name is lost.

There is no pre-read here at all: under (B) a pre-read existed to name the holder of a duplicated
*identity*, and that refusal no longer exists.

Nothing about this moves identity policy into the store (`AGENTS.md:114-119`, `INV-010`). The
store chooses no winner; it declines to represent a state its caller was told could not arise.

**The relocation admission rule is part of this contract, not an accident.** Every terminal is
`{...source, path}` (`state-committer.ts:104-105`), so each relocation is an in-place update of
one identity-keyed row and the `store.delete(item.source.path)` that made today's order safe is
gone. In its place, `compareAndRewritePaths` extends its existing non-injectivity refusal
(`state.ts:167-169`): if any item's terminal address equals a **different** item's source
address, it publishes nothing and returns `false`. Self-overlap — an unmoved child whose terminal
address is its own source address — is not overlap and is admitted, as today's
`if (item.source.path !== item.terminal.path)` already recognises. Cyclic sets fall under the
same refusal, so no temporary address is ever written. The only production caller cannot produce
an overlapping set: every source lies under the old folder prefix, every terminal under the new
one, and a folder cannot be renamed into its own subtree.

**That refusal is intra-set, and it is not the whole discharge — the correction the attack
forced.** The plan offered the prefix-disjointness argument as the complete discharge of the
relocation hazard, and it is not: the hazard under (A) is contention for the unique `path` index
with **any** row, including a row the set never mentions. `identity-component-decision.ts:719`
already sets each item's `destination: facts.records.get(target)` — a record **outside** the
relocation set that already holds the terminal address — and `compareAndRewritePaths` already
captures and compares it (`state.ts:181-183`), while today's `store.put(item.terminal)` displaces
it by key. A folder rename into a destination subtree that already holds baselined files is
therefore an ordinary, captured, compared state, not a broken `fs` premise. It is discharged by
the **same** rule as every other displacement, applied per item: the item is a **replacement** at
that terminal address, so it deletes the captured foreign incumbent and inserts the relocated child
under the one transaction image, after comparing the incumbent against what
`identity-component-decision.ts:719` captured. No second rule, no ordering inside the set — the
items publish together — and the intra-set refusal above stays exactly as stated for the case it
does cover. One arm of this is already closed upstream: `decideFolder` takes
`facts.records.get(from) ?? facts.records.get(to)` as the baseline
(`identity-component-decision.ts:695`) and fails with `conflicting_identity` when that baseline's
identity disagrees with the observed remote (`:696-698`), so the surviving case is specifically
the one where a source record exists *and* a different record already holds the terminal.

Normal witness (FR-RIK-006): a folder rename relocating twelve child records through
`compareAndRewritePaths` publishes normally — each child is one row whose `path` field changes,
and no two children contend for an address. Adversarial witness, risk *data loss*: record `A`
carries `id:K` at `a.md`; a write publishes record `B` also carrying `id:K` at `b.md`. Today both
survive, `bindFiles` binds one and `occurrenceClaimed` drops the other. (The further step the plan
used to assert — that the dropped address then yields a `delete_local` of a live file — is
**analytical and is withdrawn as an established claim**: `identity-component-decision.ts:568-569`
refuses `delete_local` without a provider-reported deletion at that address, and no measurement
produces the destructive outcome. What is asserted here is the representability, not a prevented
deletion.) Under this contract only one row can exist for `K`, so `B` is that row with its address
updated and the two-baseline state is unrepresentable; the test asserts the store holds exactly one
record for `K` rather than asserting a refusal. Second normal witness, the **replacement**
(FR-RIK-006): records `{K1,P}` and a terminal `{K2,P}`; the write deletes `{K1,P}` and inserts
`{K2,P}` in one transaction, the store afterwards holds exactly one row at `P`, `K1`'s
`sync-content` row is gone with it, and the delete is observable as its own operation rather than
as a side effect of the put. Third normal witness, the **rename** (FR-RIK-013): a terminal carrying
`expectedRow`'s own identity at a new address is a single `put`; no delete is issued at all, the
primary key is unchanged, and the merge base survives because its key did not move. Second
adversarial witness, risk *ordering*: a relocation set whose terminal addresses intersect another
item's source addresses, and a cyclic two-item set, each publish **nothing** and return `false`,
so a future caller that needs them fails a named test instead of aborting in production. Third
adversarial witness, risk *unsupported environment*: two distinct records are written at one
`path` — the state the `fs` premise forbids — through the uncompared `put`, which is the only
surface that can reach the index now that every replacement deletes its incumbent; the second write
aborts having written nothing and the failure reaches the caller as a **throw**, never as the
stale-baseline `false`, with both stores unchanged. The test asserts the throw and the unchanged
stores and **does not** assert `domName`, which is `null` on `main` for every abort. Fourth
adversarial witness, risk *data loss*: a **replacement** publication whose `expectedOccupant` no
longer matches the row at the address deletes **nothing** and returns `false` — the compare
precedes the delete, so a stale expectation can never destroy a row the engine did not admit.

Forbidden results: catching the `path`-index abort and returning `false`; catching the
request-level error or re-parsing a message string to recover the name; changing
`src/store/idb-helper.ts` from within this contract; deleting an incumbent record **other than**
the one captured as the publication's destination and compared by the CAS in the same transaction,
or deleting one before that comparison; issuing a delete on the **rename** path, where the primary
key does not move; a pre-read added to name a holder; a new mutating method; a by-path *write* API;
any
change to `keyPath`, which is
`adr-record-key-shape`'s and the owner's, not an implementer's.

**The measurement file this contract must re-price, stated here rather than discovered.**
`src/sync/record-rekey-across-commit.test.ts` exists and records the split-cycle end state today:
"shape 2, cycle 1" asserts `compareAndPut(destination=P@K1, terminal=P@K2)=true`, a single
surviving row `P@K2`, `mergeBaseAt(Q) === "absent"` and
`getAll().map(r => r.remoteIdentityKey) === [K2]`; "shape 2, cycle 2" asserts that `K1` is then
treated as brand new. **Under owner decision 8a all of that is correct and stays.** What changes is
the framing and one added assertion, both `unit-4`'s: the case stops being written as a measured
loss and is written as the model's expected end state — the correspondence `{K1,P}` ended when `P`
became `K2`'s, and `K1` reappearing at `Q` is a new file — and cycle 1 additionally asserts that
`{K1,P}` was removed by an **explicit delete inside the claiming transaction** rather than
overwritten. Three further edits fall out of the same change and are also `unit-4`'s:
`traceCommits` loses its `compareAndMove` spy because the method ceases to exist; the control and
same-cycle cases record `compareAndPut` where they record `compareAndMove`; and the merge-base
case's relocation leg records the base **preserved** rather than `absent`, because a rename does
not move the row (`contract-merge-base-survives-relocation`). The file is not deleted, no case is
removed, and its instrumentation is not weakened.

Delegated (`discretion-cas-address-comparison-shape`): whether each CAS method reads the target
address through the `path` index directly or through one shared private helper inside the same
transaction.

<!-- anchor: contract-merge-base-survives-relocation -->
### contract-merge-base-survives-relocation

The relocating publication paths apply `compareAndPut`'s existing invalidation predicate — delete
the base when `!expected`, `!record.hash`, or when `hash`, `localSize` or `remoteIdentityKey`
changed — instead of deleting at both addresses unconditionally.

**The predicate is the contract; the carry is now the key's job.** Because `sync-content` is
re-keyed to `remoteIdentityKey` with `sync-records`, a relocation does not move the base row at
all: its key is the record's identity, which a rename does not change. `rewritePaths:216-222`'s
address-carrying `contentStore.put({ ...content, path: newPath })` is therefore not a mechanism to
reuse — it is a mechanism that stops existing, and it is deleted with the method. What must not be
lost in that simplification is the predicate itself. It has to survive two structural moves that
would otherwise drop it silently:

- **`compareAndMove` collapses into `compareAndPut`.** `compareAndPut` already *has* the predicate
  (`state.ts:104-108`); `compareAndMove` is the body that lacks it (`:132-133`). The collapse
  therefore repairs the defect by construction on the file-rename path — but only if the absorbed
  destination comparison is added to `compareAndPut` **without** an accompanying unconditional
  `contentStore.delete`, which is exactly the line a mechanical merge of the two bodies would
  carry across. The witness below fails if it is carried across.
- **`compareAndRewritePaths` keeps its own body**, so its two unconditional
  `content.delete(...)` calls (`:186-187`) must be replaced with the same predicate applied
  per item. Under the identity key there is only one content row per item to decide about, not
  two addresses.

`conflict-resolver.ts:135` moves with the content store's key: the caller already holds the
baseline record (`baseline?: SyncRecord`, `conflict-resolver.ts:21`, and the expression is guarded
by `ctx.baseline &&`), so it reads by that record's identity and stops consulting
`ctx.baselinePath` here.

`commitAction`'s folder branch returning before `maybeStoreMergeBase` (`state-committer.ts:99-109`)
is **correct as it stands** — the subject of a folder rename is a folder and has no content. The
children's bases were stored during their own publications and are destroyed by
`compareAndRewritePaths`, so the repair lands in the CAS bodies and nowhere else. That correction
is stated because the critique's graft attributed part of the defect to the folder branch.

Partition: **determinate** (the predicate decides, and a preserved row simply stays where it is,
keyed by an identity the relocation did not change) / **conflicting** (the enclosing CAS
comparison fails — publish nothing and return false, exactly as a stale baseline does today, with
the base untouched).

**The defect is measured, not only read.** `src/sync/record-rekey-across-commit.test.ts`'s
merge-base case drives the three shapes through the production chain with three-way merge **off**
— so `maybeStoreMergeBase` (`state-committer.ts:124`) cannot re-derive a base and mask the store's
own behaviour — and records: a same-address identity replacement drops the base through
`compareAndPut`'s identity clause (`state.ts:104-108`), and a pure relocation with nothing else
writing drops it at **both** keys through `compareAndMove`'s unconditional deletes
(`state.ts:132-133`) although the bytes never changed. That second result is this contract's RED
witness on `main`, and it is `unit-4`'s to invert: after the collapse the relocation leg must
record the base **preserved**. The first result is correct and must stay.

Normal witness (FR-RIK-013): a file renamed remotely with unchanged bytes keeps its base, and the
next conflict on that file resolves by three-way merge rather than newer-mtime-wins. Adversarial
witness, risk *mutation*: a relocation that also changes the content hash deletes the base —
merging against bytes that predate the change is forbidden. Second adversarial witness, risk
*scale/partial completion*: a folder rename of 500 children either preserves or invalidates every
child's base under one transaction image; 498 preserved and 2 lost is forbidden. The normal witness
doubles as the **collapse regression witness**, and `verify-unchanged-rename-keeps-merge-base` must
be written against the relocating path specifically: after the collapse that path *is*
`compareAndPut`, so the case that silently regresses is the one where the merge of the two bodies
carried `compareAndMove`'s unconditional content deletes across.

Delegated (`discretion-merge-base-invalidation-site`): whether the predicate is factored into one
private helper the CAS bodies share, or applied inline in each, so long as it is
`compareAndPut`'s existing predicate referenced rather than a second copy of it.

<!-- anchor: contract-record-field-audit -->
### contract-record-field-audit

Owner decision 3 applied field by field, not to one field.

| Field | Underivable? | Read by production? | Disposition |
|---|---|---|---|
| `path` | yes (where it was at last sync) | yes — the 17 sites that address a row today, of which the address-asking ones move to the `path` index, plus three field reads that do not move | keep as a persisted, queryable fact carrying a unique index — owner decision 5's "path は unique制約でよい". A constraint, not the identity of the row |
| `remoteIdentityKey` | yes (provider-only) | yes, every endpoint resolution and replacement check | keep, and **promote to the keyPath**; becomes required and non-empty |
| `remoteChecksum` | yes | yes, `hasRemoteChanged` | keep |
| `hash`, `localMtime`, `remoteMtime`, `localSize`, `remoteSize` | yes | yes, the comparer and `compareAndPut`'s predicate | keep |
| `syncedAt` | yes | **no production reader found** (only `conflict-action-contract.ts:149`'s shape validator) | keep — it passes the underivability test; the observation is recorded, not acted on |
| `backendMeta` | no useful part — the id half duplicates `remoteIdentityKey`, the rest is unread | **no production reader** (measured: writer at `state-committer.ts:43`, type at `sync/types.ts:22`, and `hot-warm-promotion.ts:43` merging the *entity's* field) | **remove** |

Partition: **determinate** (a field's disposition follows the two-question test) / **unknown** (no
field reached this). Reversal condition for the one removal: a named production reader of
`SyncRecord.backendMeta`. Forbidden result: touching `FileEntity.backendMeta` or any backend that
populates it.

Normal witness (FR-RIK-010): `SyncRecord` no longer declares `backendMeta`, `buildSyncRecord` no
longer writes it, and whole-record JSON equality in every CAS method compares the same field set on
both sides. Adversarial witness, risk *boundary*: an Admission fixture that exercises
`FileEntity.backendMeta` through `hot-warm-promotion` stays green unchanged, proving the two fields
were separate all along.

<!-- anchor: contract-record-identity-floor-disposition -->
### contract-record-identity-floor-disposition

The record layer's answer to "what identity value must a `SyncRecord` carry, and what does an
entity get that cannot supply one?", stated here so that no rule about *rename reports* is asked
to compensate for it (DP-3 and DP-6 are different layers, and only this one has a floor).

**Rule.** `SyncRecord.remoteIdentityKey` is `string`, required. `buildSyncRecord` is the single
construction function and cannot produce a record without a non-empty provider identity. The type
enforces the *declared shape* at compile time; the *value* floor is a runtime refusal and must
be, because `""` is a valid IndexedDB key and `remote?.identityKey` is an optional entity field.
**The refusal lives in `buildSyncRecord` itself** and not in any one caller: it has three
production callers in two files — `state-committer.ts:119`, `opened-file-priority.ts:61` and
`:88` — and the two that were previously unnamed both write to the store
(`opened-file-priority.ts:62`, `:91`). A floor placed in `commitAction` would leave the priority
path unguarded and would force `remote?.identityKey ?? ""` inside `buildSyncRecord` to keep the
required type satisfiable, which is the exact fold `fr-rik-007` forbids. The refusal throws
before any store write, naming the entity and the address, so the violation never surfaces as a
`DataError` from inside a transaction. Absent and empty are one case.

**Consequence for an id-less entity, stated and not mitigated away.** It is still listed, still
compared, still conflict-resolvable, still reachable by `decision-engine.ts:8-21` for every branch
that does not need `prevSync`. What it cannot acquire is a durable baseline. The refusal is one
branch at one function and each consumer context disposes of it by its own established
discipline:

- **`commitAction` (`state-committer.ts:119`)** — the action fails, the cycle does not complete,
  the checkpoint stays uncommitted, and the entity is re-observed next cycle. This is the same
  route `throw new Error("SyncRecord changed before terminal publication")` (`:123`) already
  takes.
- **the opened-file priority attempt (`opened-file-priority.ts:61`, `:88`)** — this is not a cycle
  action and must not be described as one. Its own outer `try`/`catch` (`:37`, `:116-123`) already
  ends a failed attempt with a warn, `requestNormalLifecycle()` and `"failed_retryable"`, and its
  inner baseline commit (`:89-99`) warns and defers to the batch. The refusal takes that existing
  route: no baseline is taken on the priority path, the target is invalidated, and the same entity
  reaches `commitAction` in the batch cycle, where the bullet above applies. Nothing is persisted,
  nothing is retried on the priority path's own authority, and no new branch is added for it.

This is not the "refuse it at the backend boundary" mitigation the critique falsified — nothing
here removes an entity from a listing — but it is a real user-visible consequence and it is the
price of owner decision 5's floor, recorded rather than argued away.

**Why the expected population is empty.** `googledrive/types.ts:25` and `onedrive/types.ts:20`
declare `id: string`. `dropbox/types.ts:23` declares `id?: string` **only** because the same type
covers `deleted` tombstones; its own doc comment says a deleted entry is *"never cached"*, and
`buildFromFiles` skips `.tag === "deleted"` at `dropbox/metadata-cache.ts:148`. Every cached
file/folder entry of all three families therefore carries a provider id, and the failure branch
above is expected to be unreachable in production.

Partition: **determinate** (the provider supplied a non-empty identity; the record carries it and
is the unique row for it) / **unknown** (it supplied none or an empty string; no record is
constructed, `buildSyncRecord` throws naming the entity, nothing is written, and the caller's own
established failure route runs — a failed action and an incomplete cycle from `commitAction`, an
invalidated target and a deferral to the batch from the priority path).

*Operational input.* Whether a **cached** Dropbox `file`/`folder` entry can arrive with no `id`.
Owner: `component-record-shape`. Producer: the Dropbox `list_folder` / `list_folder/continue` API
(external identity). Acquisition boundary: the documented contract text plus one opt-in live e2e
raw page dump (`npm run test:e2e:dropbox`). Needed by: not by this change, which is total either
way — it is needed to know whether the `unknown` branch is dead code or a live user-facing
outcome. Preservation: none; the answer is a statement about the provider, recorded in the design,
not in any store. If unavailable: the rule above stands and the `unknown` branch stands with it,
asserted by test rather than assumed unreachable.

Normal witness (FR-RIK-012): a Drive push commits a record whose `remoteIdentityKey` equals the
Drive file id, and a later cycle resolves that baseline through `currentByIdentity` with **no path
lookup available** in the resolution, because the positional arm no longer exists. Adversarial
witness, risk *epistemic uncertainty*: a remote entity with `identityKey: undefined` reaches
`buildSyncRecord` — no record is constructed, it throws naming the entity, nothing is written,
and both stores are unchanged. **This witness is what retires the positional arm**, and it is the
verification the previous revision got wrong: it asserted the arm "no longer type-checks", which
was measured false (`""` is falsy, so `x ? A : B` over `x: string` compiles clean under this
repository's own `tsc --strict`, and `eslint.config.mts` configures no
`no-unnecessary-condition`). `npm run build` therefore cannot discriminate and is **not** the
assertion; a test that fails when an identity-less record is constructed is. Second adversarial
witness, risk *boundary* (FR-RIK-007): a remote entity with `identityKey: ""` takes the **same**
branch as an absent one and produces no record — where storing `""` verbatim would have made a
second such entity silently replace the first, which is the one place the withdrawn replacement
probe describes something real. Third adversarial witness, risk *boundary*: the same absent
identity reaching `buildSyncRecord` from `opened-file-priority.ts:88` does **not** escape as an
unhandled failure and does not baseline; the target is invalidated and the work defers to the
batch.

Forbidden results: storing a record with an absent or empty `remoteIdentityKey`; folding an
absent identity to `""` anywhere, including inside `buildSyncRecord` to satisfy the required
type; placing the floor in a caller so that another caller is unguarded; synthesizing an identity
from the path; persisting a "why this entity has no identity" marker; removing an id-less entity
from a listing or from comparison; asserting the retirement of the positional arm through
`npm run build`; stating anywhere that the positional fallback is still live.

Delegated (`discretion-identity-floor-refusal-site`): whether the floor is a guard clause inside
`buildSyncRecord`'s body or a small named predicate `buildSyncRecord` calls that narrows the
remote entity's type for it.

<!-- anchor: contract-cross-family-identity-conformance -->
### contract-cross-family-identity-conformance

The existing remote FILE and FOLDER rename cells in
`tests/fs/contracts/caching-remote-fs.contract.ts:297-360` assert the pair's `identityKey` against
a `stat` of `newPath`, through the public `IFileSystem` surface only — no cache reference, no
private-state inspection. Their `toEqual({ oldPath, newPath, isFolder })` literals at `:314`,
`:333` and `:351-356` are **updated to include the identity, not loosened**; a `toMatchObject` or a
dropped field would retire an assertion that currently holds.

Partition: **determinate** (pair identity equals `stat`'s) / **unknown** (the family's projection
legitimately yields none, which the case asserts as an explicit absence with a cited reason —
never a silent skip) / **conflicting** (the pair carries an identity `stat` does not report, which
fails that family with no opt-out).

Normal witness (FR-RIK-011): `stageRemoteRename("note.md", "renamed.md")` for each family yields
`renamed[0].identityKey === (await fs.stat("renamed.md"))!.identityKey`. Adversarial witness, risk
*boundary/ordering* (NFR-RIK-003): the Dropbox harness's deliberate `deleted(old)`-first ordering
produces the same identity on the pair as the reverse ordering. Second adversarial witness, risk
*stale data* (FR-RIK-001): a delete-then-recreate at the same path with a *different* id never
produces a pair carrying the old occupant's identity. Forbidden results: adding a production
capability hook to the backend-agnostic base; weakening an existing shared case; registering a case
outside the central composition root; extending a registry fixture for anything but
backend-specific construction data.

## Architecture decisions

<!-- anchor: adr-remote-correspondence-identity-carrier -->
### adr-remote-correspondence-identity-carrier — identity crosses the filesystem seam

**Decision.** The `IFileSystem` rename contract carries provider identity. The carrier is the
producing filesystem's own entity projection, never the cache's internal id, and
`contract-seam-carried-identity` is the single document that owns that rule. Admission's
remote-rename validation stops re-deriving the identity from the address it validates. Identity is
**optional** on the pair and may only narrow what Admission admits; no rule fails a component for a
missing key.

**Why the obvious implementation is wrong.** `cache.idAt(newPath)` resolves to
`DropboxMetadataCache.extractId` = `entry.id ?? entry.path_lower`, while `dropboxEntryToEntity`
sets `identityKey: entry.id` with no fallback. Both `identityKey: entry.id` and
`identityKey: cache.idAt(newPath)` satisfy a contract that says only "the provider id the producer
read", and they differ observably for Dropbox — so the contract must name the permitted producer,
not just forbid one derivation. `extractId` remains legitimate as a cache-internal total *address*
function; `path_lower` is a real Dropbox address for download and delete, and is not a sync
identity.

**Why the guard stays conditional.** `ADR 0008` Decision §2 has three states and "missing keys
provide no evidence" is the third. Requiring an identity would encode absence of evidence as
evidence of conflict, against an accepted ADR, and would stall Dropbox's id-less case every cycle.
This is a rule about cycle-local rename evidence and is explicitly **not** the record layer's
identity discipline, which `adr-record-identity-floor-tolerated` owns — and the two stay apart
even though that ADR now decides a floor. A durable record must name its object because it *is* a
correspondence; a rename report need not, because it is one piece of evidence among several and
absence of evidence is not evidence.

**Consequences, corrected against the measurement.** `:106-107` and `selectReportFamily`'s two
identity checks become reachable — the latter only once `renameEvidenceKey` stops collapsing
conflicting claims upstream. `:106-107` is **not** reachable today in any useful sense, and this
ADR no longer claims it is: `src/sync/plan-admission.test.ts` records that on every fact shape the
Observation layer emits the guard compares a value to the map it was filled from, and that the
replaced-destination shape is admitted as a `match` rather than as a wrong local rename, because
`indexFacts` and `bindFiles:420-421` discriminate it first. So the consequence this ADR commits to
is that a remote rename whose **carried** identity disagrees with the identity observed at the
destination now fails its component — a check where there was a tautology — and that the two
failures the enrichment currently manufactures out of a map-keying divergence go away with it. It
is **not** that a demonstrated wrong rename is prevented; that claim was analytical and is
withdrawn. A rename report with no identity degrades to exactly today's behaviour rather than
stalling. Nothing persistent changes, so this half can ship independently of the store half — and
an owner weighing the two halves should know that this is the one whose justification rests on a
check being real rather than on a measured harm.

<!-- anchor: adr-record-identity-uniqueness-mechanism -->
### adr-record-identity-uniqueness-mechanism — the durable store cannot represent two baselines for one object

**Decision.** One `SyncRecord` per provider object is **structural**, not observed: the record's
key is its `remoteIdentityKey` (`adr-record-key-shape`), so a second row for one identity has
nowhere to exist. The store adds no refusal, no named duplicate-identity error and no pre-read for
this, because there is no state to arbitrate. Alongside it the store carries a unique index over
`path`, which is a **guard on the `fs` premise** rather than a mechanism of this design: it aborts,
never replaces, and its abort propagates as a thrown cycle failure instead of being mapped to
the ordinary stale-baseline `false`. Nothing in this design reads that abort's `DOMException`
name: `idb-helper.ts:142` rejects on `tx.onerror` where `tx.error` is still `null`, so every
aborted transaction on `main` arrives unnamed. That is an independently repairable helper defect
(open question 5), it is neither repaired nor worked around here, and the observable this ADR
commits to is the failure's shape — a throw where a CAS returns `false`, with nothing written. `DB_VERSION` is bumped and every record is rebuilt by the
existing cold start, which is also the only place either declaration can be created.
`rewritePaths` is deleted, `compareAndMove` collapses into `compareAndPut`, and
`SyncRecord.backendMeta` is removed. The relocation write order is replaced by a stated admission
rule over overlapping and cyclic address sets.

**The displacement the keyPath used to perform implicitly becomes explicit, and that is the
point.** Under `keyPath: "path"` every publication to an address silently destroyed whatever row
sat there (`state.ts:101-103`); the discard was a property of the key, invisible at the call site.
Under (A) the displaced row survives the write and holds the unique `path` index, so the discard
must be performed. **Owner decision 8a settles what it is**, and it is not an inference: a
`SyncRecord` is the record of a correspondence, a correspondence whose address now belongs to a
different object **has ended**, and the claiming publication observes that end directly. So a
**replacement** deletes the incumbent and inserts the terminal in one transaction, having compared
the incumbent first; a **rename** is a single `put` and deletes nothing. There is no
classification, no evidence test, no ordering between bindings and no failure reason — the
durable effect is exactly the one `keyPath: "path"` already performed, and what changes is that it
is now admitted, compared and testable rather than inherited.

Four alternatives were weighed and rejected. Retiring an incumbent because no binding in the
component names it infers deletion from the absence of an observation, against `ADR 0008`'s third
state. Retiring it only on evidence that its object is gone, and failing the component closed
otherwise, is refused by owner decision 8a: it asks for evidence of the *object's* death when what
ended is the *correspondence*, which is directly observed — so it buys a stall, an ordering rule
and a convergence narrative for a question that is not open. Pushing the order to the executor, or
retrying the failed action, is refused by owner decision 6c and independently by `AGENTS.md`'s
executor rule — the executor runs the exact admitted order with no regrouping, DAG or recovery
queue — and would additionally make the `path`-index abort an expected branch, which owner
decision 5 forbids. A store-side reaper for rows whose address another row holds is refused because
it would be a second correctness owner over the durable store, choosing between claimants inside
the store (`INV-010`, `AGENTS.md:109-119`).

**Why no application-level uniqueness check, and why no error message either.** Under the earlier
index shape this ADR argued that a check outside the transaction is not atomic, that a check inside
it would put identity policy in the store, and that a same-transaction pre-read could therefore
compose an error naming both addresses. All of that was answering a question the key shape
dissolves. The store now declines to represent a state rather than deciding between two claimants,
so it chooses no winner in the strongest possible sense (`INV-010`, `AGENTS.md:109-113`), and
`contract-record-identity-uniqueness` explicitly forbids re-adding a pre-read to name a holder that
cannot exist.

**Consequences.** M2 and M3 both become unrepresentable rather than merely unobserved. The cost is
the work inventory under `approach` — seventeen call sites, six mutating methods, the content
store's key and one consumer — and one new way for a cycle to fail: an entity whose provider
supplied no id cannot be baselined (`adr-record-identity-floor-tolerated`). Because nothing on main
surfaces a cycle failure by default, that failure is silent to the user and shows only as work not
progressing; that is the repository's standing behaviour and this change does not alter it. The
cold start is the standing one, not a new one.

<!-- anchor: adr-record-key-shape -->
### adr-record-key-shape — which property keys the record: **(A), accepted by owner decision 5**

**Status: accepted.** The decision is the repository owner's, delivered as the binding authority
delta `authority-deltas/000001-c7074fbeca79fc0c.message`, elaborated as owner decision 5 and
**re-affirmed against a proposal to drop the unique index by owner decision 7a**. This ADR
previously reserved the question; it no longer does, and this plan does not reopen it.

**Decision.** `sync-records` uses `keyPath: "remoteIdentityKey"` with a unique index over `path`.
`sync-content` is re-keyed the same way. `path` remains a real, persisted, queryable field — a
*constraint* rather than the identity of the row. This is owner decision 2 read literally, which is
what owner decision 5 says it always meant.

**One argument against the index was raised after the fact and rejected.** It ran: two rows
carrying the same `path` are a benign coexistence of historical facts — "where each object was at
last sync" — so the index buys nothing and costs a failure mode. Owner decision 7a rejects it, and
the code says why. `facts.records` is keyed by `prevSync.path`
(`identity-component-decision.ts:353`) and Admission looks up *the record for this path*, so
`SyncRecord.path` is **which local file this record is the correspondence for**, not merely where
the object used to be. Two records at one path are two correspondences for one local file — a
contradiction the model cannot mean. A real filesystem resolves such a contention by silently
letting the last writer win; a durable store of correspondences must refuse, which is what a unique
index does.

**Why the alternative was not weighed again.** The plan offered (B) — `keyPath: "path"` with a
unique index over `remoteIdentityKey` — and argued that both shapes deliver both invariants, so the
choice turned on cost: seventeen call sites and six CAS rewrites against one index. The owner
**rejected the frame**, not the arithmetic:

> 同一path のレコードを複数持とうとしているのが間違っている。path は unique制約でよい。fs は
> sync engine にオブジェクトパスのユニーク性を保証する必要がある

The comparison presupposed that the store had to be the thing that refuses a second record at one
path. It does not. Path uniqueness is an invariant the **filesystem layer owes the sync engine**,
upstream of the store; a `SyncRecord` store asked to arbitrate two records at one path has already
been handed a violated precondition, and no keyPath choice repairs that. With the presupposition
gone, the only question left is what the record's identity *is* — and both owner decisions 2 and 3
answer that the same way. The cost table survives as the change's work inventory
(under `approach`); it is no longer a decision input, and nothing here re-argues it.

**What the choice makes true, and what it makes this change owe.**

- One row per provider object, by construction. M3 is unrepresentable; the duplicate-identity
  refusal, its named error and its same-transaction pre-read are all retired unbuilt.
- No record without an identity, by construction at the store and by refusal at the construction
  function (a keyPath over a missing property is a `DataError`, and `""` is a valid key that must
  be refused before it folds two entities into one row). M2's positional fallback is retired —
  by the absence of its population, verified by a test, not by a type error;
  `adr-record-identity-floor-tolerated` inverts to record the floor and what an id-less entity
  gets instead.
- **A publication's two expectations separate, and the displaced row is deleted by the write that
  takes its address.** "The row this publication continues" and "the row holding this address" were
  one record under `keyPath: "path"`. Under (A) they are two, and the displaced one survives the
  write unless the write removes it. **Owner decision 8a and 8b settle that in one line**: a
  replacement deletes it in the same transaction, because the correspondence at that address has
  ended and the publication observes that end directly. This is the obligation (A) carries that the
  reserved version did not foresee, and it turns out to be an operation rather than a rule —
  `contract-record-identity-uniqueness` states it, and no evidence test, ordering pass or
  classification is needed to reach it.
- The unique `path` index is a **hard constraint and a guard, not a policy mechanism**: it aborts
  rather than replaces, its `ConstraintError` is a defect signal about the `fs` guarantee, and it
  is never mapped to the ordinary stale-baseline `false`. Each CAS method compares the target
  address itself first, so the index is only reachable when the premise is false. Owner decision 7a
  also corrects why the constraint is right in the first place: `facts.records` is keyed by
  `prevSync.path` (`identity-component-decision.ts:353`), so `SyncRecord.path` says which local
  file a record is the correspondence for, and two rows at one path are two correspondences for one
  file — a contradiction, not two coexisting historical facts. A real filesystem lets the last
  writer win silently; the durable store must not.
- The obligations the reserved version listed as an "if (A) were chosen" delta are now live and
  discharged in the body rather than deferred: the seventeen call sites, the six mutating methods
  with `compareAndMove` collapsing into `compareAndPut`, `conflict-resolver.ts:135` moving with the
  content store's key, and the relocation order restated over overlapping and cyclic sets as an
  admission rule (`contract-record-identity-uniqueness`).

**The premise this depends on, and who owes it.** `fs` guarantees object-path uniqueness to the
sync engine. This change assumes it and says so (`scope`); discharging it — a provider that permits
two objects at one name resolving that below the `IFileSystem` seam, by provider rename, before the
sync engine observes it — belongs to **issue #90** and is out of this change's scope.

<!-- anchor: adr-record-identity-floor-tolerated -->
### adr-record-identity-floor-tolerated — the record layer requires an identity, and states what an id-less entity gets

**The anchor id is retained from the superseded framing** so the minimality audit, the authority
delta and every existing reference keep resolving to this decision point. The decision it records
is now the **floor**, not tolerance; it inverted under owner decision 5 and it stays, because under
(A) it is load-bearing rather than optional.

**Decision.** `SyncRecord.remoteIdentityKey` is required and non-empty. `buildSyncRecord` cannot
construct a record without one — the type declares the shape and **`buildSyncRecord` itself
refuses the value**, with a named error, before any store write, for all three of its production
callers in two files. Absent and empty are one case. The positional fallback at
`identity-component-decision.ts:408-410` is consequently **retired because its population cannot
exist**, verified by a test that fails when an identity-less record is constructed — not by a
type error, which was measured not to occur.

**Why tolerance is no longer available.** It was chosen against shape (B), where an index skips a
record whose indexed property is absent. Under (A) a keyPath over a missing property is a
`DataError`: the floor is the storage mechanism, and there is nothing left to choose. The third
option — synthesizing a key from the path — stays forbidden by `ADR 0008` and is *more* tempting
under (A) precisely because it would dissolve the floor, which is why it is named and refused here
rather than left unmentioned.

**What the id-less entity gets, which is the part this ADR owes.** It cannot be baselined: its
publication fails, the cycle does not complete, nothing is written, and it is re-observed next
cycle. It is **not** refused at the backend boundary, so it is still listed, still compared, still
conflict-resolvable — the critique's falsification of that mitigation stands and is not
contradicted. The expected population is empty: Drive and OneDrive declare `id: string`, and
Dropbox's `id?: string` is optional only because the type also covers `deleted` tombstones, which
its own doc comment says are *"never cached"* and which `buildFromFiles` skips
(`dropbox/metadata-cache.ts:148`). `unknown-dropbox-entry-without-id` stays on record with its
settling observation, now as a precondition of the chosen shape rather than a sizing question.

**Why this is still a separate ADR from the seam's.** The seam's rule
(`adr-remote-correspondence-identity-carrier`) is about what a *cycle-local rename report* must
name, and it stays optional under `ADR 0008`. This is about what a *durable record* must carry, and
it is now required. The layers did not merge when one of them acquired a floor: a record **is** the
correspondence and must name its object; a rename report is one piece of evidence among several,
and absence of evidence is not evidence of conflict. Collapsing them is how draft-1 arrived at a
requirement contradicting `ADR 0008`.

**Consequences.** M2 is closed — by the key, not by the version bump, and `fr-rik-012` now states
the retirement instead of the tolerance. `fr-rik-007` inverts with it: the claim is no longer that
every value the field ranges over is unconstrained, but that the field ranges over non-empty
strings only. One user-visible failure mode is created and named rather than hidden.

## Critique disposition

Every issue the critique recorded with `verdict: "Y"` is accounted for below, one to one. The one
`verdict: "N"` issue is answered too, because answering it cost nothing.

| Issue | Resolution |
|---|---|
| `issue-d1-keypath-silently-replaces` (blocker) | **Withdrawn**, per the conductor's resolution 1, and still not carried as a defect. Its residue was the cost comparison; owner decision 5 retired the comparison by rejecting its frame, so `adr-record-key-shape` is accepted on (A) and the 21-call-site table under `approach` is the change's work inventory rather than a decision input. One thing the probe described *is* real and is now handled where it belongs: under an identity keyPath, two entities carrying `remoteIdentityKey: ""` would silently become one row, which is why `contract-record-identity-floor-disposition` refuses an empty identity rather than storing it. |
| `issue-d1-extractid-trap-at-diffbyid` (blocker) | Resolved by `fr-rik-002` and `contract-seam-carried-identity`, which is the single owner of the rule and forbids `extractId`/`idAt`/`getPathById`/`snapshotPathsById` as sources across the `IFileSystem` boundary, while leaving `extractId` legitimate as the cache-internal address function. Its adversarial witness asserts that the carried value **differs** from `cache.idAt`'s for an id-less Dropbox entry, which is the structural half the separate `contract-identity-projection-source` used to carry; that document was removed as uncompelled (see below) and the outcome it stated survives here and in `contract-cross-family-identity-conformance`. The three shared rename cells assert the projected value. |
| `issue-d1-fr8-contradicts-adr-0008` (blocker) | Resolved by DP-3: the guard keeps its shape, `RenamePair.identityKey` is optional, and no rule fails a component for a missing key. `contract-cross-source-rename-validation`'s `unknown` outcome is "handled exactly as on main", not a named failure. Kept strictly apart from the record-layer floor, which `adr-record-identity-floor-tolerated` owns. |
| `issue-d1-shared-contract-misplaced` | Resolved: `contract-cross-family-identity-conformance` targets `caching-remote-fs.contract.ts:297-360`, names the three `toEqual` literals at `:314`/`:333`/`:351-356`, and `unit-7` enumerates them plus the three `caching-remote-fs.contract-harness.ts` registrations. `remote-change-detection.contract.ts` is recorded as containing no rename content (measured: zero occurrences of "rename"). |
| `issue-d1-renameevidencekey-collapse` | Resolved by `fr-rik-003` and `contract-evidence-identity-preservation`: the dedupe key carries the identity, and a carried, an absent and an empty key never alias. Under (A) this is no longer the same answer as the record layer's — there, absent and empty are one inadmissible case — and the plan now says why the two questions differ instead of asserting one answer serves both. |
| `issue-d1-merge-base-misattributed` | Resolved by `fr-rik-013` and `contract-merge-base-survives-relocation`. The predicate repair stands and is still not counted as a payoff of the key shape; what (A) changes is that the *carry* half is discharged by the key — `sync-content` is keyed by identity, so a relocation does not move the base row — and the contract now names the two structural moves that could drop the predicate silently, `compareAndMove`'s collapse into `compareAndPut` and `compareAndRewritePaths`' own body. `conflict-resolver.ts:135` is recorded as a by-path content read, corrected from "needs no change", and moves with the content store's key using the baseline record it already holds. `commitAction`'s folder branch returning without `maybeStoreMergeBase` is correct for a folder. |
| `issue-d1-getmany-misclassified` | Resolved: the inventory was rebuilt from the repository rather than patched. `getMany` issues `store.get(p)` per path and is a primary-key lookup at `:147` and `:180`, so both move to the `path` index. A further correction the critique did not make: `getAll()` is key-agnostic and is neither a field read nor a key lookup. The corrected table is under `approach`; it did not decide `adr-record-key-shape` and now records the work that decision implies. |
| `issue-d1-dropbox-refusal-does-not-mitigate` | Resolved and **still honoured under the inversion**. Refuse-at-the-backend-boundary remains withdrawn: nothing in this plan removes an id-less entity from a listing or from comparison, so the permanently-unbaselinable-and-undeletable outcome the critique constructed is not created. What (A) does create is narrower and is named — such an entity cannot acquire a durable *baseline*, so its publication fails and the cycle does not complete — and `contract-record-identity-floor-disposition` asserts that outcome by test rather than assuming the input cannot occur. `unknown-dropbox-entry-without-id` is kept with its settling observation, now as a precondition of the chosen shape whose expected population is measured empty. |
| `issue-d1-risk-stated-in-wrong-place` | Resolved: the owner-facing risk section under `approach` names the **three** classes of cycle that now fail — the mis-bound rename, the unbaselinable id-less entity, and the `path`-index abort that should never fire — names the reachable *defect* risk as a pair that names its object wrongly, gives the seam contract's forbidden-source rule as its mitigation, and states that the unnameable-object stall is not a risk of this design. It also states that a stalled component is silent to the user on main. |
| `issue-d2-refusal-cannot-name-holder` | **Dissolved by the key shape, not answered.** The issue was that a duplicate-identity refusal could not name the record already holding the identity, because a read from the failing `put`'s `onerror` returns `AbortError`. Under (A) there is no duplicate-identity refusal: one row per identity is what a keyPath is, so nothing needs naming and the same-transaction pre-read is retired unbuilt. The measurement that answered it — IndexedDB serialises `readwrite` transactions over a store, so a pre-read issued before the write is atomic with it — is recorded in `adr-record-identity-uniqueness-mechanism` as a correction to draft-2 that this design no longer needs, and `contract-record-identity-uniqueness` forbids re-adding the pre-read. |
| `issue-d2-m2-not-closed-by-the-bump` | Resolved, and its finding is preserved rather than overtaken. The bump still does not close M2 — `buildSyncRecord` has no floor of its own — and the `goal` section says so explicitly. What closes M2 is the **key**: an identity-less record has no keyPath value and cannot exist. `fr-rik-012` therefore states retirement by construction, `contract-record-identity-floor-disposition` states the floor and what an id-less entity gets, and `adr-record-identity-floor-tolerated` inverts to record the floor. Nothing anywhere credits the bump with the closure. |
| `issue-d2-empty-string-identity-indexed` | Resolved, with the mechanism **inverted** by (A). Normalizing `""` to absent was correct when an absent property meant "skipped by the index"; under an identity keyPath an absent property is a `DataError` and an empty string is a perfectly valid key that would fold two entities into one row. So the single construction site now refuses both, as one case, and `fr-rik-007` states that the field ranges over non-empty strings only. The rename-evidence dedupe key keeps its own distinct answer, and the plan no longer claims one answer serves both layers. |
| `issue-d2-relocation-order-unpinned` | Resolved, restated for (A). Delete-before-put is not the obligation any more, because source and terminal are one identity-keyed row and the delete disappears. What is pinned instead, in the same contract and with its own adversarial witness and verification, is an **admission rule**: a relocation set whose terminal addresses intersect another item's source addresses, or that is cyclic, publishes nothing and returns `false`. A refactor that needs those sets fails a named test rather than aborting in production, which is the property the issue asked for. |
| `issue-d1-relocation-overlap-unpriced` | Resolved **unconditionally**, as the chosen shape now requires. The hazard is live: `store.delete(item.source.path)` is gone, so an overlapping set aborts under one put order and completes under the reverse, and a cyclic set has no safe order without a temporary. `contract-record-identity-uniqueness` refuses both classes — publish nothing, return `false` — rather than ordering them or naming a temporary, because the only production caller cannot construct either (all sources share the old folder prefix, all terminals the new one, and a folder cannot be renamed into its own subtree). Ordering would be structure with no reachable failure behind it, which is the same test that rejected graft 3. |
| `issue-d2-enrichment-removal-overstated` | Resolved, and now **settled by the measurement rather than by a reservation**. DP-2(i)'s "loses nothing" was withdrawn and restated as assumption 1 with its falsifier; `src/sync/plan-admission.test.ts` has since taken that measurement and the recorded result is that the filled key is the current occupant's own on every shape Observation emits, so the removal loses no evidence. `indexFacts`' insert stays recorded as a different *selection*, not a stricter check, and the two divergences it permits are now constructed and pinned rather than reasoned about. `contract-evidence-identity-preservation`'s precondition on `unit-0` stands and is satisfied. |
| `issue-both-rewritepaths-test-double-unlisted` | Resolved: `src/__mocks__/sync-test-helpers.ts` is in the file list of **both** `unit-4` (the `rewritePaths` double at `:309`, and now `compareAndMove`'s too) and `unit-5` (the `backendMeta` carrier at `:118`), consistently as the hint asks. |
| `issue-d1-dimension-vocabulary` | Resolved: the spine declares `contracts[].dimension` in the shared enum only (`data_model`, `control_flow`, `integration_contract`, `migration_compatibility`, `failure_recovery`, `state_lifecycle`). Non-discriminating; the winner already complied. |
| `issue-d2-scaffold-correction-outside-scope` (`verdict: "N"`) | Answered anyway and found to need nothing: the change package's `source_paths` lists `state.ts`, `state-committer.ts`, `identity-component-decision.ts` and `identity-evidence.ts` — neither `src/sync/rename-debt.ts` nor `adr-20260902-rename-identity-evidence-model.md` appears there. Both are absent from the repository, confirmed; the stale references live in `recovery-scope.json`'s seed refs, which is not a change-package artifact. No unit owns a correction because none is owed. |

### Plan-attack disposition

The independent attack on the shape-(A) plan recorded twelve issues — three blockers, eight
further `verdict: "Y"` findings and one `verdict: "N"`. Every one is accounted for below, one to
one. Nothing is closed by restating it, by deferring it to an open question, or by an appeal to
authority that does not reach it; where the attack was wrong, the counter-measurement is given.

| Issue | Resolution |
|---|---|
| `issue-pa-displaced-destination-record-never-retired` (blocker) | **Accepted in full and resolved by owner decision 8 as an operation, not a rule.** All three routes are carried, re-measured, and closed by one operation rather than three: `identity-component-decision.ts:509-511` and `:549-551`'s same-address replacement (whose liveness the attack proved from `state.ts:104-106`'s `expected.remoteIdentityKey !== record.remoteIdentityKey` invalidation), `state.test.ts:250-261`'s move onto an occupied address, and `:719`'s folder relocation onto a captured **foreign** destination. Each is a **replacement**: it deletes the incumbent and inserts the terminal in one transaction, after comparing the incumbent against what Admission captured. `contract-record-identity-uniqueness` states it and `fr-rik-006` requires it. **Two earlier answers to this blocker are withdrawn.** The first retired an incumbent whenever no binding named it, which reads absence of observation as evidence of deletion against `ADR 0008`. The second — classification into `continuing`/`vacated`/`retired on evidence`/`unproven`, relocating-first ordering, a `checkpoint_deleted` evidence test and a fail-closed stall — is removed by owner decision 8a, which dissolves the question rather than answering it: the record asserts a **correspondence**, not the object's existence, and a correspondence whose address now belongs to another object has ended in a way the cycle **directly observes**. No death evidence is needed, `ADR 0008` is not engaged, and the attack's "permanently repeating action failure" is removed for every shape without a stall being introduced anywhere. The minimality claim is now exact rather than qualified: the durable effect is in every case the one today's `keyPath: "path"` put already writes, and what changes is that the discard is admitted, compared and tested instead of silent. |
| `issue-pa-constraint-classification-is-lost-by-the-helper` (blocker) | **Accepted as a measurement, rejected as this change's defect**, per owner decision 6c. Re-measured independently here against the repository's own `fake-indexeddb`: `[["request.onerror","ConstraintError"],["tx.onerror",null],["tx.onabort","ConstraintError"]]`, store empty afterwards. The cause is `idb-helper.ts:142` rejecting on `tx.onerror` where `tx.error` is still `null`, and it makes **every** aborted transaction unnamed, not only a constraint violation — so it is an ordinary helper defect with its own blast radius, not a design question here. The requirement is therefore **removed**: `fr-rik-006`, `contract-record-identity-uniqueness`, `AC-RIK-005`, `verify-duplicate-path-aborts-and-propagates` and `unit-4`'s acceptance now assert what is observable — the write **throws** where a stale baseline returns `false`, nothing is written, the action fails and the cycle does not complete. Both forbidden repairs (catching the request error, re-parsing the message) stay forbidden, `idb-helper.ts` is not changed and is not worked around at any call site, and `decision-input-no-operator-signal-on-main`'s claim that the classification "is the only diagnosable trace a violated fs premise leaves" is corrected, because it was false as the code stands. Recorded as open question 5. |
| `issue-pa-unit4-keypath-over-optional-property-breaks-the-gate` (blocker) | **Accepted in full; the sequencing is inverted rather than patched**, per owner decision 6a. The attack is right that `IDBObjectStore.get(query: IDBValidKey \| IDBKeyRange)` cannot take `string \| undefined`, that the only repairs available inside the old boundary were a non-null assertion or the `?? ""` fold `fr-rik-007` exists to forbid, and that `state.test.ts`'s `makeRecord` (`:7-17`) omits the field. `unit-5` (record shape and identity floor) now runs **before** `unit-4` (store re-key) and no longer depends on it: the required field, the floor in `buildSyncRecord`, the positional arm's removal, the absence-guard disposition and the whole test-literal surface land first, with the keyPath still `"path"` and the gate green; `unit-4` then re-keys against a `remoteIdentityKey` that is already `string`. No intermediate state forces an assertion or a fold. |
| `issue-pa-required-field-does-not-make-the-fallback-a-type-error` | **Accepted.** `AC-RIK-012` and `verify-positional-fallback-does-not-type-check` are unachievable and are **replaced**: the arm is retired because its population cannot exist, asserted by `verify-identityless-record-construction-fails`, and `npm run build` is explicitly not the assertion. The same false premise is removed from `fr-rik-012`, `unit-5`'s acceptance and `adr-record-identity-floor-tolerated`. The attack's list of other absence-branching sites is taken and **extended**: re-measured from `main` the set is larger than thirteen, and it is disposed of by the distinction the attack blurred — an absent *record* is still possible, an absent *field* is not — so only tests of the field's own absence are affected. The enumeration and each site's disposition are under `DP-6`. |
| `issue-pa-cas-row-address-and-empty-expectation-undecided` | **Accepted and decided.** `compareAndPut` now takes two explicit expectations, `expectedRow` (the row keyed by `record.remoteIdentityKey`) and `expectedOccupant` (the occupant of `record.path` through the `path` index), with **no defaulted parameter**, so `compareAndMove`'s inherited `expected.path === record.path ? expected : undefined` (`state.ts:119`) does not survive in any form and `compareAndPut(undefined, record, undefined)` keeps today's vacancy check for a baseline-free create. `compareAndDelete(path, undefined)` is stated: no row to address, verify the address is vacant, delete nothing, return `true` — today's verified no-op. Which record fills each expectation is stated in the same contract and corrects `:509-511`'s and `:549-551`'s `source: expected` for a replacement publication, where the continued row is `undefined` and the incumbent is the destination. The attack's representative (a) — address the row by `record.remoteIdentityKey` and return `false` forever — is exactly what that correction prevents. |
| `issue-pa-relocation-refusal-covers-only-intra-set-overlap` | **Accepted.** The prefix-disjointness argument is true and, as the attack says, irrelevant to contention with a row the set never mentions. `contract-record-identity-uniqueness` now says so, and the case is discharged by the same operation as every other displacement: each such item is a **replacement** at its terminal address, deleting the captured foreign incumbent (`identity-component-decision.ts:719`) and inserting the relocated child under the one transaction image, after comparing it. Still no second rule and no ordering inside the set, and the intra-set refusal stands unchanged for the case it does cover. The fail-closed outcome the previous revision proposed for this shape is withdrawn with the rest of the evidence rule. |
| `issue-pa-dropbox-idless-adversarial-witness-unconstructible` | **Accepted, and the witness is re-homed rather than dropped.** Both unreachability results were re-verified: `incremental-sync.ts:158` gates `applyRename` on `entry.id`, and `remote-fs.ts:416-421`'s surrogate key `entry.id ?? entry.path_lower` changes with any path-changing rename. The one constructible shape is the **case-only** full-scan rename, where `path_lower` is stable while the display path changes; the witness moves onto it and onto `verify-fullscan-diff-carries-projected-identity` (`remote-fs.contract.test.ts`), where `diffById` and `idAt` are both reachable, and `verify-dropbox-delta-rename-carries-entry-id` keeps a constructible id-bearing normal witness instead. **DP-1's rejection of option (a) is re-grounded**, not preserved: the decisive reason is now that `fr-rik-002` cannot be *stated* over `extractId`, whose own doc comment declares it an address function, so any agreement with the entity projection would be coincidental; the stall survives at one-sub-case size and is described at that size. `unit-1`'s acceptance item is restated to match. |
| `issue-pa-identity-floor-scope-misses-two-construction-callers` | **Accepted in full**, and it is owner decision 6a. `discretion-identity-floor-refusal-site` no longer offers "the check sits in `commitAction`" — that alternative leaves `opened-file-priority.ts:62` and `:91` unguarded and forces the `?? ""` fold — and its two remaining representatives are both inside `buildSyncRecord`, so they preserve the same observable. Its `scope.files` and `unit-5`'s file list both carry `src/sync/opened-file-priority.ts`. The attack's further point is taken too: the contract's `unknown` outcome no longer describes the priority path as a cycle action, and states its actual disposition — invalidate the target, defer to the batch, where the same entity reaches `commitAction`. |
| `issue-pa-ownership-guard-has-a-second-consumer-of-the-removed-names` | **Accepted; the measurement is corrected and the fixture edit is priced.** `:320` is verified as a second hardcoded consumer generating two negative-fixture tests per name, so "consumed at exactly one site, `:199`" is **false** and is removed from `DP-5`, `fr-rik-009` and `nfr-rik-004`. The attack's own confirmation that the four per-file inventories stay byte-identical was re-derived here and stands, so the removal of `contract-two-authority-enforcement-triple` stands with it — the inventories, not an untouched file, are the machine proof this is hygiene. `unit-6` now owns the two-name edit at `:9-12` **and** the list at `:320`, and its `tool_guidance` is corrected: a `:320` failure is the expected consequence of the detector-set edit, and only an **inventory** mismatch would falsify the claim. |
| `issue-pa-store-work-inventory-omits-the-test-surface-it-breaks` | **Accepted; the store half now prices what the seam half already priced.** Re-measured: `tsconfig.json` includes `tests/**/*.ts`; 27 files contain a `SyncRecord` literal, of which three are production, leaving 24 test and mock files; `compareAndMove` is referenced in five files (`state.test.ts`, `fact-first-execution.test.ts` at `:282`/`:402-417`/`:671`/`:727-742`, `state-committer.test.ts:210-215`, `plan-executor.test.ts:1101`, `__mocks__/sync-test-helpers.ts:270`); `tests/fs/contracts/remote-change-detection.contract.ts` calls `buildSyncRecord` at `:64`, `:74` and `:90`. The work inventory under `approach` carries a row for it, `unit-5` enumerates the record-literal surface and `unit-4` the `compareAndMove` surface, and a new scope-expansion signal records the blast radius the way `scope-signal-conformance-cell-rewrites-existing-assertions` records the seam's. |
| `issue-pa-call-site-inventory-line-refs-drift` | **Accepted and corrected.** Re-measured: `checkRecord` is defined at `plan-executor.ts:413`, its single `store.get` is `:414`, and its four call sites are `:420`, `:421`, `:436`, `:437`. The table row is fixed and the correction is noted in place so the drift is not silently re-absorbed. The attack's re-measurement of every other cited anchor matched this pass. |
| `issue-pa-report-family-dedupe-still-aliases-absent-and-empty` (`verdict: "N"`) | **Dismissed as a defect, and the reason is recorded rather than the finding.** The attack could not establish it and said so: `identity-component-report-family.ts:32-34` accumulates `edgesByIdentity` and `identitiesByEdge` only when `claim.identityKey` is truthy, so a claim carrying `""` contributes no identity evidence and is indistinguishable in outcome from one carrying none, and no mis-binding can be constructed from the alias. `selectReportFamily` stays unchanged, as `fr-rik-005` and "What stays positional, and why" already rule. One wording debt it names **is** paid: the plan quotes `report.identityKey ?? ""` as the reason the downstream arbitration is currently dead, and now also records that the same expression keeps two of its three inputs indistinguishable afterwards — harmlessly, for the reason above, and `fr-rik-003`'s three-value rule is scoped to the rename-evidence dedupe key where a collapse would be a real loss. |

The attack's three scope-expansion signals are disposed of with them:
`scope-signal-pa-required-field-binds-the-whole-test-surface` is **adopted** as
`scope-signal-required-field-binds-the-whole-test-surface`;
`scope-signal-pa-retired-identity-rows-persist` is **resolved outright under owner decision 8** —
every row whose address is claimed by a record for a different object is deleted by the claiming
write, inside its own transaction, with `sync-content`'s row under the same key; a row whose file
is deleted on either side is removed by that deletion's own publication. No row is retained past
the end of its correspondence, so no reaper is needed, none is added, and nothing accumulates. The
previous revision's narrower resolution — a row persisting deliberately because the cycle did not
observe its object — is withdrawn with the fail-closed rule that produced it;
`scope-signal-pa-constraint-classification-needs-the-helper` is
**dissolved**, because the requirement that needed the helper is gone.

### Minimality audit dispositions

The audit classified ten scope-expansion signals: six `necessary`, three `optional`, one
`requires_user_authority`. The six `necessary` targets stand — `contract-seam-carried-identity`,
`contract-record-identity-uniqueness`, `contract-record-identity-floor-disposition`,
`contract-merge-base-survives-relocation`, `contract-cross-family-identity-conformance` and
`contract-positional-mechanism-evidence` — re-expressed where (A) changes them and removed nowhere.
The other four are disposed of here.

| Target | Classification | Disposition |
|---|---|---|
| `contract-identity-projection-source` | `optional` | **Removed.** The audit is right twice: the helper is concrete over the already-public `abstract toEntity(path, file)` (`metadata-cache.ts:59`), so no subclass gains an obligation and no new base-class member is forced, and `discretion-projection-helper-placement` already permitted "a free function over public getters". Its outcome does **not** go with it: the carried value equalling the entity projection's identity is stated by `contract-seam-carried-identity` (`fr-rik-002`), adversarially witnessed there by the Dropbox id-less case whose assertion is that the carried value **differs** from `cache.idAt`'s, and asserted through the public `IFileSystem` surface for every family by `contract-cross-family-identity-conformance`. The discretion moves to the seam contract, whose `unit-1` already carries it and already lists `metadata-cache.ts`. |
| `contract-two-authority-enforcement-triple` | `optional` | **Removed**, and the over-read is corrected in the plan rather than only in the audit. `AGENTS.md:71-73` binds the ADR-0001-plus-enforcement-document triple to an intentional **new** writer, owner or field; removing a name from a detector set is not that. `MUTATING_SYNC_STATE_METHODS` (`sync-state-ownership-guard.test.mjs:9-12`) feeds a call-site predicate at `:199` that decides per-file booleans. **Re-checked under (A):** the shape now removes two names, not one — `rewritePaths`, with zero production callers, and `compareAndMove`, whose one caller `state-committer.ts:121` moves to `compareAndPut`, which stays in the set. `state-committer.ts` therefore still registers as a mutation caller, and `imports`, `references`, `constructors` and `mutationCallers` are all byte-identical. **Corrected under the plan attack:** the set has a second consumer at `:320`, which generates two negative-fixture tests per name, so the guard's *fixture* is edited rather than untouched — but the argument here never rested on an untouched file, it rests on the byte-identical inventories, and those are what the attack re-derived and confirmed. (A) does **not** make the triple compelled, and neither does the fixture edit. The fixture, ADR 0001 and pipeline-document work stays in `unit-6` as hygiene under `contract-record-identity-uniqueness` and `fr-rik-009`. |
| `adr-record-identity-floor-tolerated` | `optional` | **Kept, inverted.** The classification was made under shape (B), where the ADR recorded a *choice* that `fr-rik-012` and `contract-record-identity-floor-disposition` already discharged. Under (A) there is no choice — the floor is the storage mechanism — and the ADR carries what nothing else does: what an id-less entity gets, why synthesizing a key stays forbidden precisely because it would dissolve the floor, and why the record layer's floor does not propagate to rename reports. Load-bearing, not restatement. |
| `adr-record-key-shape` | `requires_user_authority` | **Resolved by that authority.** The audit correctly refused to promote it while owner decision 2's literal text and the conductor's "still open" were in conflict. The authority delta settled the conflict by rejecting the frame; the ADR is now `accepted` on (A), and the smaller structural alternative it was measured against is recorded as measured, presented and overruled — not as unconsidered. |

### Graft dispositions

The critique recorded six elements to take from draft-1. Five are taken; one does not survive
scrutiny and is rejected with its witness.

1. **The identity floor argument** — **taken**, and draft-1's resolution is now the one in force.
   The graft was taken as an argument and a decision point rather than as draft-1's answer, and
   owner decision 5 then made draft-1's answer correct: the floor exists. `fr-rik-012`,
   `contract-record-identity-floor-disposition` and `adr-record-identity-floor-tolerated` carry it,
   with the measured bound the graft did not have and with the consequence for an id-less entity
   stated rather than assumed benign.
2. **The merge-base defect** — **taken**, and still detached from the key choice, as `fr-rik-013`
   and `contract-merge-base-survives-relocation`, with the folder-branch attribution corrected. The
   predicate repair is owed under any shape; what (A) supplies for free is the carry, because the
   base row's key does not move on a relocation.
3. **FR-6's folder-relocation identity obligation** — **rejected**, with the witness. The
   obligation is already true by construction at the only production caller:
   `state-committer.ts:104-105` builds each terminal as `{ ...source, path: item.newPath }`, so a
   terminal's identity is its source's identity, always. A provider that replaced the object cannot
   change that spread; what it changes is the stored row, and `compareAndRewritePaths`' existing
   whole-record `JSON.stringify` comparison — which includes `remoteIdentityKey` — already fails
   the set. Identity injectivity across terminals reduces to identity injectivity across sources,
   which is M3 and is unrepresentable under (A)'s key. Adding a store-level check would be
   structure with no reachable failure behind it, so it is not added — the same test that refuses a
   topological put ordering for overlapping relocation sets.
4. **The five Admission fixture shapes** — **taken** in full, as `fr-rik-014`,
   `contract-positional-mechanism-evidence` and `unit-0`, including the two shapes draft-2 lacked
   (a remote object replaced at an address by a different id; a folder rename whose descendants are
   not re-emitted), promoted from a deferral into work that gates the enrichment removal, and now
   **executed**: `src/sync/plan-admission.test.ts` carries all five plus a sixth case that pins the
   boundary of the result, and a second measurement,
   `src/sync/record-rekey-across-commit.test.ts`, extends the same discipline across the
   publication boundary. The graft therefore stops being a promise and becomes the evidence this
   revision's corrections rest on.
5. **NFR-3's explicit non-improvement statement** — **taken** into `nfr-rik-002` and
   `contract-local-positional-boundary`, including the cross-scope local rename that draft-2's
   version omitted. Folded into the existing requirement rather than given a new one.
6. **The corrected FR-3 site inventory** — **taken**, and re-measured rather than patched: 21
   production call sites, 17 primary-key-addressed, `getAll`/`clear` key-agnostic. It was presented
   as the owner's costing artifact and was explicitly not allowed to decide `adr-record-key-shape`;
   the owner decided on other grounds, and it is now the change's work inventory.

## Open questions

`adr-record-key-shape` is no longer among them: owner decision 5 settled it on (A), and neither it
nor owner decisions 1-4 nor the conductor resolution is reopened here.

1. **`unknown-dropbox-entry-without-id`.** Can a **cached** Dropbox `file`/`folder` entry arrive
   with no `id`? Measurement bounds the expected population to empty — the optionality exists only
   for `deleted` tombstones, which are never cached — so this no longer gates any decision in this
   plan; `contract-record-identity-floor-disposition` is total either way. It settles from the
   `list_folder` contract text plus one opt-in e2e raw page dump, and settling it tells the
   repository whether the floor's failure branch is dead code or a live user-facing outcome. It
   still gates whether a remote *folder* rename may ever **require** an identity.
2. **`unknown-local-rename-missed-event-recovery`.** Out of reach — there is no local identity to
   recover from. Needs an explicit owner statement that the product consequence is accepted, not a
   design.
3. **`syncedAt`.** Kept, because it passes the underivability test, but no production reader was
   found. Recorded as an observation; removing it in this same bump is free if the owner wants the
   shape smaller.
4. **Issue #90's discharge of the `fs` path-uniqueness premise.** Not a question for this plan to
   answer and not a blocker for it — this change is entitled to the premise and refuses loudly when
   it is violated — but the premise is undischarged until #90 lands, and the unique `path` index is
   the only thing standing between a violation and a wrong operation.
5. **`src/store/idb-helper.ts:142` loses every aborted transaction's name.** Not a question but a
   measured defect, recorded here so it is not lost: the helper registers
   `tx.onerror = () => reject(new IDBTransactionError("error", tx.error))` before `tx.onabort`,
   and `tx.error` is only set during the abort steps, so `domName` is `null` for **every** abort.
   Measured against the repository's own `fake-indexeddb`: `request.onerror` →
   `"ConstraintError"`, `tx.onerror` → `null`, `tx.onabort` → `"ConstraintError"`, rows unchanged.
   Fail-closed is intact; only the reason is lost. It is repairable on its own — reject from
   `tx.onabort`, or read the failing request's `error` — with a blast radius of both persistent
   stores, and **this change does not repair it and does not work around it**. No requirement,
   witness or verification here depends on the name. Owner decision 6c is explicit that this is a
   separate, much smaller defect and not a convergence strategy.
6. **A cross-issue obligation on #90, not a question (owner decision 8d).** #90's `rule-keeper` and
   `input-committed-record` justify *"at most one claimant can hold that record"* by **"records are
   path-keyed"**. After this change that property comes from the **unique `path` index** instead.
   The property survives and #90's rules are unaffected in substance; only their justification needs
   updating, and it is two sentences in **#90's** plan. It is recorded here so it is not lost and is
   deliberately **not attempted** here. The collision rule itself — `rule-keeper`,
   `rule-target-address`, and the deterministic arbiter for the all-new case — is #90's, already
   written, and confirmed by the owner.
