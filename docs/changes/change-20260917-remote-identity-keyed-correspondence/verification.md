---
change: change-20260917-remote-identity-keyed-correspondence
role: verification
---

<!-- lifecycle is owned by change.md -->

# Verification

## Content

**The gate, always:**
`npm run lint && npm run lint:bot-repro && npm run build && npm run test:coverage`.

It must be green **at every unit boundary**, not only at the end. In particular, no boundary may
leave the store with a keyPath over an optional property, which is why unit 5 lands the required
field and the construction floor before unit 4 re-keys the store: any other order forces a non-null
assertion or an empty-string fold at the one site this change exists to remove.

Every observable asserted below is a cycle outcome, a stored value, a returned value, or the shape
of a thrown failure. None depends on a log line or a notice: `Logger.enabled` and
`src/sync/sync-cycle-diagnostics.ts` are not on main, and `DEFAULT_SETTINGS.showSyncNotifications`
and `enableLogging` are both `false` (`settings.ts:73-74`).

**No assertion anywhere reads a `DOMException` name.** `src/store/idb-helper.ts:143` registers
`tx.onerror = () => reject(new IDBTransactionError("error", tx.error))` before `tx.onabort`, and
`tx.error` is only set during the abort steps, so the `onerror` rejection wins the race with
`tx.error` still `null` and `IDBTransactionError.domName` is `null` for **every** aborted
transaction. Measured against the repository's own `fake-indexeddb`: `request.onerror` →
`"ConstraintError"`, `tx.onerror` → `null`, `tx.onabort` → `"ConstraintError"`, rows unchanged.
That is an independently repairable helper defect this change neither repairs nor works around.
What the store's failures are asserted on instead is their **shape** — a throw from a CAS method
that otherwise returns `false`, with nothing written.

### Tier map

| tier | meaning here |
|---|---|
| T0 | Unit and behaviour tests: the producers' own tests, the shared cache contract test, `src/sync/*.test.ts` driven through production entry points, and `state.test.ts` over `fake-indexeddb` |
| T1 | Cross-module behaviour, the shared contract composition root, and the mechanical gates (`lint`, `lint:bot-repro`, `build`, `test:coverage`) |
| T2 | Review obligations, stated as such, and the opt-in live e2e — neither is in the gate |

### The two measurement files

Both already exist in the working tree, were driven through production entry points, and changed no
production file. They are part of this change's verification surface — not descriptions of tests
that would be written — and both must be landed, cited and kept green.

`src/sync/plan-admission.test.ts` (+408 lines, six cases) carries the five fixture shapes and the
recorded branch at each of the four observation sites. Its result is what every later claim in this
change cites in place of any earlier analysis: the guard at
`identity-component-decision.ts:106-107` **cannot fail on any fact shape today's Observation layer
emits**, and the replaced-destination shape is authorized with a `match` rather than a wrong rename.
Its sixth case pins the boundary of that answer by constructing the two map-keying divergences where
the guard *does* fail and recording `conflicting_identity` with no actions for both. Deleting or
weakening that case is a failure of verification, because the claim it bounds is a claim about a
population and not about impossibility.

`src/sync/record-rekey-across-commit.test.ts` (508 lines, seven cases) drives the orchestrator's own
chain over the real `SyncStateStore` and records what survives a commit: the same-cycle baseline is
preserved by identity-keyed binding at `identity-component-decision.ts:408-409`, **not** by the
store's key; the split-cycle baseline is not retained, the old row being discarded and the object
re-downloaded as new. That second result is the record model working — a correspondence whose
address now belongs to another object has ended, and a reappearing object is a new file — so the
cases assert it **deliberately, as the expected end state**, rather than recording it as a defect.

What the units must change in them, priced here rather than discovered:

| Unit | Edit |
|---|---|
| 2 | fixtures 1–3's `evidenceFill` moves from `filled_from_newPath_lookup` to the no-fill branch and fixture 4's from `newPath_lookup_missed` to the same; the sixth case's two divergences record the guard as **not reached** where they record `conflicting_identity` |
| 5 | shape 2 — a baseline carrying no identity — is **deleted with its reason cited**, because it becomes unconstructible the moment the field is required and the floor lands; every other `SyncRecord` literal in the file gains a non-empty identity rather than an empty-string fold |
| 4 | `traceCommits` loses its `compareAndMove` spy; the control and same-cycle cases record `compareAndPut` where they record `compareAndMove`; "shape 2, cycle 1" additionally asserts that the incumbent's removal was an **explicit delete inside the claiming transaction**; the merge-base case's relocation leg records the base **preserved** where it records `absent` |

No assertion in either file may be loosened into a partial match, no case may be removed beyond the
one unit 5 deletes, and no instrumentation may be weakened.

### T0 — unit and behaviour

| Id | What it must show | Command |
|---|---|---|
| `verify-renamepair-carries-projected-identity` | A Google Drive delta move of `note.md` → `renamed.md` yields one pair whose `identityKey` equals the delta entry's id and equals `(await fs.stat("renamed.md")).identityKey`. | `npm test -- src/fs/caching/id-delta.test.ts` |
| `verify-dropbox-delta-rename-carries-entry-id` | An id-bearing Dropbox `applyRename` yields a pair whose `identityKey` is the entity projection's — the constructible witness this file can host, since `incremental-sync.ts:158` gates `applyRename` on `entry.id`. | `npm test -- src/fs/dropbox/incremental-sync.test.ts` |
| `verify-fullscan-diff-carries-projected-identity` | **Adversarial, risk *boundary*.** A Dropbox full-scan **case-only** rename of a cached entry whose `id` is absent yields a pair with `identityKey` **absent**, and the test asserts that value **differs** from what `cache.idAt` returns for the same entry, which is `path_lower`. A refactor that re-routes the producers through `extractId` fails here. | `npm test -- src/fs/caching/remote-fs.contract.test.ts` |
| `verify-carried-identity-reaches-evidence` | A pair carrying `id:X` yields evidence carrying `id:X`; a pair carrying none yields evidence with none. | `npm test -- src/sync/identity-evidence.test.ts` |
| `verify-different-identity-same-edge-not-collapsed` | **Adversarial, risk *stale/partial data*.** Two pairs for `a.md → b.md`, one carrying `id:X` and one `id:Y`, produce **two** evidence items; today they collapse to one arbitrarily. | `npm test -- src/sync/identity-evidence.test.ts` |
| `verify-rename-newpath-enrichment-removed` | A report with no carried key reaches Admission with `identityKey` undefined — no identity is attached from any address — and the `stable_identity` and alias passes stay green unchanged. | `npm test -- src/sync/identity-evidence.test.ts` |
| `verify-local-rename-evidence-carries-no-identity` | Local rename evidence carries no `identityKey` and none is inferred. | `npm test -- src/sync/identity-evidence.test.ts` |
| `verify-carried-identity-mismatch-fails-component` | **RED witness, risk *mutation between observation sources*.** A remote rename `a.md → b.md` whose carried identity is `id:X` while current remote at `b.md` is `id:Y` fails the component and produces **no action**. Staged by giving the rename **pair** an identity, never by hand-keying the report: the fill is guarded by `!item.identityKey` (`identity-evidence.ts:41-44`), so a pre-keyed fixture already fails on main. The RED half is that the same producer-level input on main is admitted and produces actions. | `npm test -- src/sync/plan-admission.test.ts` |
| `verify-carried-identity-match-admits-rename` | A matching carried identity admits the relation and produces the same actions main produces today. | `npm test -- src/sync/plan-admission.test.ts` |
| `verify-absent-identity-behaves-as-today` | **Adversarial, risk *partial data*.** A report carrying no key produces exactly main's actions; no component fails for a missing key. | `npm test -- src/sync/plan-admission.test.ts` |
| `verify-identity-only-narrows-report-family` | No fixture admits a report family, folder relation or binding the positional rules reject; a mutation that would allow it fails at least one case. | `npm test -- src/sync/plan-admission.test.ts` |
| `verify-five-shapes-reach-named-branches` | Each of the five shapes reaches a **named** branch at all four observation sites through `admitBatchObservation`, so that a mutation to any of those branches fails at least one assertion. | `npm test -- src/sync/plan-admission.test.ts` |
| `verify-replaced-destination-shape-records-guard-branch` | **Adversarial, risk *stale/partial data*.** Shape 3 — a remote object replaced at an address by a different id — records the guard's branch. Recorded: it does **not** fail; the component is authorized with a `match`. | `npm test -- src/sync/plan-admission.test.ts` |
| `verify-guard-failure-boundary-stays-pinned` | **Adversarial, risk *stale/partial data*.** The two map-keying divergences continue to record `conflicting_identity` with no actions, so the boundary of the "cannot fail" claim stays pinned rather than softened into "never fails". After unit 2 they record the guard as not reached, which is the observable form of the manufactured failures going with the enrichment. | `npm test -- src/sync/plan-admission.test.ts` |
| `verify-committed-baseline-fate-is-recorded` | The same-cycle baseline is preserved by identity-keyed binding at `identity-component-decision.ts:408-409` and not by the store's key; the split-cycle baseline is not retained, the old row discarded and the object re-downloaded as new; no wrong-object operation occurs in either shape (`decision-engine.ts:19` yields `conflict`, never `delete_remote`). Asserted as the model's expected end state. | `npm test -- src/sync/record-rekey-across-commit.test.ts` |
| `verify-localfs-identity-stays-undefined` | `local-fs.test.ts:176`'s `entity?.identityKey === undefined` pin stays green. | `npm test -- src/fs/local/local-fs.test.ts` |
| `verify-replacement-deletes-incumbent-and-inserts-one-row` | Records `{K1,P}` and a terminal `{K2,P}`: the write **deletes `{K1,P}` and inserts `{K2,P}` in one transaction**, the store afterwards holds exactly one row at `P`, `K1`'s `sync-content` row is gone with it, and the delete is observable as its own operation rather than as a side effect of the put. A folder relocation whose terminal subtree already holds baselined records outside the set publishes the same way, per item. | `npm test -- src/sync/state.test.ts` |
| `verify-rename-is-a-single-put-that-deletes-nothing` | A terminal carrying `expectedRow`'s own identity at a new address is a **single `put`**: no delete is issued at all, the primary key is unchanged, and the identically keyed `sync-content` row stays in place. The case fails if any delete is issued. | `npm test -- src/sync/state.test.ts` |
| `verify-duplicate-path-aborts-and-propagates` | **Adversarial, risk *unsupported environment*.** Two distinct records written at one `path` through the uncompared `put` — the only surface that can still reach the index once every replacement deletes its incumbent — abort the transaction having written nothing, and the failure reaches the caller as a **thrown** `IDBTransactionError`, never as the stale-baseline `false`, with both stores unchanged. The test fails if the error is caught, mapped to `false`, or compensated by deleting the incumbent afterwards. It does **not** assert `domName`. | `npm test -- src/sync/state.test.ts` |
| `verify-refusals-return-false-without-reaching-the-index` | Four refusals share one observable — `false` returned, nothing written, the index never reached: a stale `expectedRow`; a stale `expectedOccupant`, including a **replacement** whose expectation no longer matches, which therefore deletes **nothing**; a baseline-free create (`compareAndPut(undefined, record, undefined)`) against a non-vacant address; and a relocation set whose terminal addresses intersect another item's source addresses or which is cyclic. A twelve-child relocation that preserves every identity publishes normally; self-overlap is admitted. Constructed directly so the cases stay true if the production loop is rewritten. | `npm test -- src/sync/state.test.ts` |
| `verify-unchanged-rename-keeps-merge-base` | **Also the collapse-regression witness.** A file renamed remotely with unchanged bytes keeps its three-way merge base. Written against the relocating path specifically, because after `compareAndMove` collapses that path *is* `compareAndPut`, and the case that silently regresses is a merge of the two bodies that carried `compareAndMove`'s unconditional content deletes across. | `npm test -- src/sync/state.test.ts` |
| `verify-content-changing-rename-drops-merge-base` | **Adversarial, risk *mutation*.** A relocation that also changes the content hash deletes the base; merging against bytes that predate the change is forbidden. | `npm test -- src/sync/state.test.ts` |
| `verify-folder-relocation-preserves-every-child-base` | **Adversarial, risk *scale/partial completion*.** A 500-child folder relocation either preserves or invalidates **every** child's base under one transaction image; 498 preserved and 2 lost fails. | `npm test -- src/sync/state.test.ts` |
| `verify-cas-equality-unaffected` | Whole-record JSON equality in every CAS method compares the same field set on both sides after `backendMeta` is removed. | `npm test -- src/sync/state.test.ts` |
| `verify-identityless-publication-writes-nothing` | A publication for a remote entity with no provider identity writes nothing to either store. | `npm test -- src/sync/state.test.ts` |
| `verify-backendmeta-absent-from-record` | `SyncRecord` declares no `backendMeta` and `buildSyncRecord` writes none. | `npm test -- src/sync/state-committer.test.ts` |
| `verify-identityless-record-construction-fails` | **Adversarial, risk *epistemic uncertainty*. This is what retires the positional arm.** A remote entity with `identityKey: undefined` reaching `buildSyncRecord` constructs no record: it throws naming the entity, nothing is written, and both stores are unchanged. The retirement is asserted here and **never** through `npm run build`, which was measured not to discriminate — `""` is falsy, so the arm's exact shape compiles clean under this repository's own `tsc --strict` with `remoteIdentityKey` typed `string`, and `eslint.config.mts` configures no `no-unnecessary-condition`. | `npm test -- src/sync/state-committer.test.ts` |
| `verify-empty-identity-takes-the-same-branch-as-absent` | **Adversarial, risk *boundary*.** A remote entity with `identityKey: ""` takes the **same** branch as an absent one and produces no record — storing `""` verbatim would make a second such entity silently replace the first, since an empty string is a valid IndexedDB key. | `npm test -- src/sync/state-committer.test.ts` |
| `verify-priority-attempt-defers-instead-of-baselining` | **Adversarial, risk *boundary*.** The same absent identity reaching `buildSyncRecord` from `opened-file-priority.ts:88` does **not** escape as an unhandled failure and does not baseline: the target is invalidated and the work defers to the batch cycle. The refused entity is still listed, still compared and still conflict-resolvable — the refusal is at the baseline, not at the backend boundary or the listing. | `npm test -- src/sync/opened-file-priority.test.ts` |
| `verify-file-rename-pair-identity-matches-stat` | `stageRemoteRename("note.md", "renamed.md")` for each family yields `renamed[0].identityKey === (await fs.stat("renamed.md"))!.identityKey`, through the public `IFileSystem` surface only. | `npm test -- tests/fs/remote-backend-contracts.test.ts` |
| `verify-folder-rename-pair-identity-matches-stat` | The same for a folder rename, with children reparented. A family whose projection legitimately yields none records an explicit asserted absence with a cited reason, never a silent skip. | `npm test -- tests/fs/remote-backend-contracts.test.ts` |
| `verify-both-provider-orderings-agree` | **Adversarial, risk *boundary/ordering* and *stale data*.** The Dropbox harness's deliberate `deleted(old)`-first ordering produces the same identity on the pair as the reverse ordering; and a delete-then-recreate at the same path with a **different** id never produces a pair carrying the old occupant's identity. | `npm test -- tests/fs/remote-backend-contracts.test.ts` |

### T1 — integration and mechanical enforcement

| Id | What it must show | Command |
|---|---|---|
| `verify-order-independence-unchanged` | Every existing `ADR 0006` ordering case stays green; Dropbox's path-keyed `upsertedPaths` reclaim guard is untouched. | `npm test -- tests/fs/remote-backend-contracts.test.ts` |
| `verify-stable-identity-and-alias-passes-intact` | The two passes `completeIdentityEvidence` keeps behave unchanged end to end. | `npm test -- src/sync/change-detector.test.ts` |
| `verify-local-tracker-unchanged` | Local rename capture is untouched. | `npm test -- src/sync/local-tracker.test.ts` |
| `verify-renamed-file-still-three-way-merges` | The next conflict on a remotely renamed file with unchanged bytes resolves by three-way merge rather than newer-mtime-wins (`conflict-resolver.ts:135` falls through when `getContent` returns nothing). | `npm test -- src/sync/conflict-resolver.test.ts` |
| `verify-no-production-reader-of-record-backendmeta` | The type change alone makes any production read of `SyncRecord.backendMeta` a compile error. | `npm run build` |
| `verify-entity-backendmeta-untouched` | **Adversarial, risk *boundary*.** An Admission fixture exercising `FileEntity.backendMeta` through `hot-warm-promotion` stays green **unchanged**, proving the two fields were separate all along. | `npm test -- src/sync/plan-admission.test.ts` |
| `verify-matrix-still-fails-closed-on-missing-cell` | `satisfies Record<RemoteBackendFamily, RequiredRemoteContractSet>` still makes a missing family or cell a compile error; no harness inspects private cache state; no registry fixture is extended except for backend-specific construction data. | `npm run build` |

### The enforcement artefacts and the cold start

These carry no verification id of their own in the plan — they are unit 6's acceptance and the
schema half of unit 4's, checked by the gate and by review.

- **The ownership guard, mechanically (AC-RIK-008, AC-RIK-010).** `npm run lint:bot-repro` must be
  green at unit 6's boundary with the mutating-method set at
  `sync-state-ownership-guard.test.mjs:9-12` reduced by exactly `rewritePaths` and `compareAndMove`,
  and the generated negative-fixture list at `:320` reduced by `compareAndMove` **in the same edit**.
  Every remaining CAS method must still have both of its generated fixtures, in the
  `records.<method>` and `records["<method>"]` forms. The claim being checked is that the four
  per-file **inventories** — `imports`, `references`, `constructors`, `mutationCallers` — are
  byte-identical before and after; run the guard before and after the method removals and confirm
  that, and only that. A failure at `:320` in between is the expected consequence of the removal,
  not a falsification. `sync-admission-authority-guard.test.mjs` must be green with **no** fixture
  edit — needing one would mean identity policy had moved into the store.
- **The cold start (AC-RIK-007).** A database seeded at the previous `DB_VERSION` opens at the new
  one with **zero** records and zero content entries; both stores are recreated with
  `keyPath: "remoteIdentityKey"` and `sync-records` carries the unique `path` index. Prove it by
  seeding a previous-version database, **not** by asserting on the upgrade callback. No migration,
  transform or record-preserving upgrade code exists anywhere in `src/`.
  `change-detector.ts:104` already selects COLD on an empty record store independently of
  `forceFullScan`, so the first cycle after the bump is an ordinary COLD cycle under the same
  Admission rules as any other vault.

### T2 — review obligations, stated as such

| Obligation | Mechanical check |
|---|---|
| `docs/sync-pipeline.md`'s state-commit bullets (`:303-305`) name `compareAndPut`, `compareAndRewritePaths` and `compareAndDelete`, and no longer name `put()`, `rewritePaths()` or `delete()`. | **None.** Review, stated rather than dressed up as automated. |
| ADR 0001 records the new key and the unique `path` index as storage mechanism subordinate to commit-last, and the index as a guard on the filesystem layer's path-uniqueness guarantee rather than as an identity-policy owner; its two-publication-point statement is not rewritten. | **None.** Review. |
| `docs/code-enforcement.md`'s two-authority row names the reduced mutating set. | Partially covered by `lint:bot-repro`'s fixture comparison; the prose agreement is review. |
| No artefact states that `AGENTS.md:71-73` compelled the enforcement work. | **None.** Review. |
| The four non-improvements (NFR-RIK-002) are stated where a reader of this change will find them. | **None.** Review against the change's own documents. |

### Opt-in, not in the gate

- `npm run test:e2e:dropbox` — one raw `list_folder` page dump, to settle
  `unknown-dropbox-entry-without-id`. Measurement already bounds the expected population to empty —
  `DropboxEntry.id` is optional only because the type also covers `deleted` tombstones, which its
  own doc comment says are *"never cached"* and which `buildFromFiles` skips, while
  `googledrive/types.ts:25` and `onedrive/types.ts:20` declare `id: string` — so this gates no
  decision in the change. Settling it tells the repository whether the floor's refusal branch is
  dead code or a live user-facing outcome.
- `npm run test:e2e` — the rename-identity cells against the real providers.

### What a green run does and does not prove

It proves that a reported remote rename names its object from its producer's own entity projection,
that the name survives to Admission unchanged, that a carried identity disagreeing with the identity
at the destination fails closed, that a cache-internal synthetic id can never be the carried value,
that one provider object cannot be claimed by two `SyncRecord`s and one address cannot be held by
two, that a **replacement** performs its discard as an explicit compared delete rather than
inheriting it from the key, that a **rename** is a single `put` that preserves the merge base, and
that no new durable authority or store owner appeared.

It does **not** prove that a wrong operation was prevented at the Admission guard. The measurement
records that the guard cannot fail on any fact shape today's Observation layer emits and that the
replaced-destination shape is admitted with a `match`, so what the seam half delivers is a real
cross-source check where there is presently a tautology, plus the removal of the two failures the
enrichment manufactures. Whether the Observation layer can emit either of those two map-keying
divergences is **not** established either way, and nothing here depends on the answer.

It does not prove the `fs` path-uniqueness premise. That is issue #90's to discharge; here the
unique `path` index is a guard on it, and a green run only shows that nothing in this change's own
paths reaches it.

Nor does a green run surface anything to the user. A component that now fails closed is silent and
shows only as work not progressing — the repository's established response to an unprovable
precondition, unchanged by this work but stated rather than assumed benign.
