---
change: change-20260917-remote-identity-keyed-correspondence
role: requirements
functional_requirements:
- id: FR-RIK-001
  statement: Every RenamePair a remote filesystem produces shall carry, in an identityKey
    field, the provider identity of the object at newPath as that filesystem's own
    FileEntity projection yields it; the field shall be absent only when that projection
    yields none.
  priority: must
- id: FR-RIK-002
  statement: The carried identity shall never be the metadata cache's internal total
    id (extractId); in particular Dropbox's entry.path_lower fallback shall never
    appear as a RenamePair.identityKey, and a carried identity shall always equal
    the identityKey a later stat or list observation of the same object in the same
    cycle would report.
  priority: must
- id: FR-RIK-003
  statement: A carried identity shall survive unchanged from producer to Admission;
    no downstream stage shall overwrite it, two rename claims that agree on side,
    oldPath, newPath and isFolder but disagree on identityKey shall not be collapsed
    into one claim, and a carried key, an absent key and an empty key shall be three
    distinct values to the rename-evidence dedupe key with none aliasing another.
  priority: must
- id: FR-RIK-004
  statement: Admission's validation of a reported remote rename shall compare the
    report's carried identity against current remote facts derived independently of
    that report; the path-keyed re-attachment of a remote rename's identity from the
    destination address shall be removed, a report carrying no identity shall be handled
    exactly as it is on main, and no rule shall fail a component because a report
    carries no key.
  priority: must
- id: FR-RIK-005
  statement: Carried identity shall only narrow report-family selection and component
    admission; no report family, folder relation or binding that the current positional
    rules reject shall become admissible because an identity is now present.
  priority: must
- id: FR-RIK-006
  statement: The durable record store shall hold at most one SyncRecord per remoteIdentityKey
    by construction, because that property is the store's key, and at most one SyncRecord
    per path, enforced by a unique index over that field, with both fields mandatory.
    Every publication shall be exactly one of two operations. A rename - the same
    identity at a new address - shall change only the path field of one row and shall
    be a single put, moving no primary key, deleting no row and leaving the identically
    keyed sync-content row in place. A replacement - a terminal whose identity differs
    from that of the record holding the claimed address - shall delete that incumbent
    and insert the terminal within one transaction, after comparing the incumbent
    against the expectation Admission captured, so that the discard is an admitted,
    compared and asserted operation rather than a silent side effect of the key as
    it is under keyPath path at state.ts:101-103; nothing shall be inferred about
    whether the incumbent's object still exists, because the record asserts a correspondence
    and that correspondence's end is directly observed. A write that would place a
    second record at an address a different record already holds without deleting
    that record shall abort its transaction having written nothing and shall reach
    its caller as a thrown transaction failure, never as the ordinary stale-baseline
    false return, and shall never be resolved by catching the abort, by re-parsing
    or recovering its name, or by replacing the incumbent after the fact; no requirement,
    witness or verification shall depend on that failure naming itself, because idb-helper.ts:142
    rejects on tx.onerror where tx.error is still null so every aborted transaction
    on main arrives unnamed, and that helper defect shall be neither repaired nor
    worked around by this change; each CAS method shall take two explicit expectations
    - the row keyed by the record's identity, and the current occupant of the record's
    address read through the path index - with no defaulted parameter, so a baseline-free
    create keeps today's vacancy check and a replacement's continued row is undefined;
    the comparison shall precede the delete, so a stale expectation returns false
    having removed nothing; and a relocation set in which every terminal record carries
    its own source record's identity shall never be refused by either rule, whatever
    its size.
  priority: must
- id: FR-RIK-007
  statement: SyncRecord.remoteIdentityKey shall be a required, non-empty string, and
    no SyncRecord with an absent or empty identity shall exist; absent and empty shall
    be one inadmissible case, refused inside buildSyncRecord itself - not in any one
    of its three production callers in two files, src/sync/state-committer.ts:119,
    src/sync/opened-file-priority.ts:61 and :88 - with a named error before any store
    write, rather than surfacing as a storage-level DataError or as a silently replaced
    row; no caller shall fold an absent identity to the empty string to satisfy the
    required type; each caller shall dispose of the refusal by its own established
    route, a failed action and an incomplete cycle from commitAction and an invalidated
    target deferred to the batch from the opened-file priority attempt; and this shall
    constrain only what a durable record carries, never what a rename report carries,
    where an absent key remains admissible.
  priority: must
- id: FR-RIK-008
  statement: DB_VERSION shall be bumped so the existing onUpgrade drop-and-recreate
    rebuilds every record from current facts under the new key; no migration, transform,
    or record-preserving upgrade code shall be added, and the version comment shall
    record both the reason and what the bump does not do — it is not what closes the
    identity-less record class, the key is, and it is the same cold start the product
    already performs on reconnect, on a bound-root change and on resetAll.
  priority: must
- id: FR-RIK-009
  statement: SyncStateStore.rewritePaths shall be removed from the public surface,
    from the ownership guard's mutating-method set and from the shared store test
    double, compareAndMove shall leave the same three places as it collapses into
    compareAndPut, the state-commit section of docs/sync-pipeline.md shall name compareAndPut,
    compareAndRewritePaths and compareAndDelete where it currently names put, rewritePaths
    and delete, and the ownership guard's import, reference, constructor and mutation-caller
    inventories shall be byte-identical afterwards, which is what proves the removal
    is detector hygiene; the guard's fixture itself shall be edited in the same change
    at both of the two sites that consume the mutating-method set - the set at sync-state-ownership-guard.test.mjs:9-12
    and the hardcoded method list at :320 that generates two negative-fixture tests
    per name - and the previous claim that the set is consumed at exactly one site
    shall not be restated.
  priority: must
- id: FR-RIK-010
  statement: SyncRecord.backendMeta shall be removed, since it has one writer and
    no production reader and the identifying half of its contents duplicates the now-uniquely-observed
    remoteIdentityKey; FileEntity.backendMeta and every backend that populates it
    shall be unaffected.
  priority: must
- id: FR-RIK-011
  statement: The shared caching contract shall assert, for googledrive, dropbox and
    onedrive alike and in both provider orderings, that a reported remote file rename
    and a reported remote folder rename each carry an identityKey equal to the identityKey
    observed at newPath, and that the pair never carries the identity previously observed
    at oldPath's occupant when that occupant is a different object.
  priority: must
- id: FR-RIK-012
  statement: The positional baseline fallback at identity-component-decision.ts:408-410
    shall be retired because the population it serves cannot exist once remoteIdentityKey
    is the record store's key and buildSyncRecord refuses an absent or empty one;
    the retirement shall be verified by a test that fails when an identity-less record
    is constructed and shall not be asserted through npm run build, because a required
    string is not always-truthy to TypeScript - the empty string is falsy, the ternary
    compiles clean under this repository's own tsc --strict, and eslint.config.mts
    configures no no-unnecessary-condition; every other production branch that tested
    a stored record's own identity absence shall be disposed of with it, removed where
    the whole branch was the absent-identity branch, reduced to its comparison where
    the absence test was a vacuous term, and tightened where a runtime shape validator
    would otherwise keep admitting the forbidden shape, with none repaired by restoring
    a positional route or by folding an absent identity to the empty string, and with
    tests of an absent record rather than an absent field left untouched; and no rename
    report shall be failed in order to compensate for anything at the record layer.
  priority: must
- id: FR-RIK-013
  statement: A publication that relocates a record to a different vault address shall
    preserve the stored three-way merge base exactly when an in-place publication
    of the same record would — that is, under compareAndPut's existing invalidation
    predicate — and no rename shall destroy a merge base that an in-place publication
    of the same record would have kept; the predicate shall survive compareAndMove's
    collapse into compareAndPut rather than disappearing with the method, and shall
    replace compareAndRewritePaths' unconditional content deletes.
  priority: must
- id: FR-RIK-014
  statement: Before any positional rename mechanism is removed or its removal is accepted
    as lossless, five named fixture shapes shall be driven through the production
    Admission entry on unchanged production code and the branch taken by selectReportFamily,
    aliasFolder, completeIdentityEvidence's newPath lookup and the identity guard
    shall be asserted by name for each; this measurement shall retire no mechanism.
    The measurement has been taken and its recorded result is binding on this plan
    - src/sync/plan-admission.test.ts carries the five shapes plus a sixth case pinning
    the two map-keying divergences under which the guard does fail, and records that
    identity-component-decision.ts:106-107 cannot fail on any fact shape today's Observation
    layer emits, so removing the positional enrichment is lossless and the change
    is not justified on that guard. A second measurement, src/sync/record-rekey-across-commit.test.ts,
    shall carry the same discipline across the publication boundary on the real SyncStateStore
    over fake-indexeddb and record that the same-cycle baseline is preserved by identity-keyed
    binding at identity-component-decision.ts:408-409 while the split-cycle baseline
    is not retained, the old row being discarded and the object re-downloaded as new.
    That second result shall be asserted deliberately as the model's expected end
    state under owner decision 8a, which settles that a correspondence whose address
    now belongs to another object has ended and that a reappearing object is a new
    file, and shall not be recorded as a defect or a loss awaiting repair. Both files
    shall be landed, cited and kept green; no clause of this plan shall describe an
    equivalent test that does not exist, and no later claim shall cite the plan's
    earlier analysis over these recorded results.
  priority: must
- id: NFR-RIK-001
  statement: The change shall add no third durable authority, no persisted evidence,
    rename intent, Admission disposition, retry instruction or recovery marker, and
    no retained in-memory correctness owner; carried identity shall live only in the
    cycle's evidence and be discarded with it; the record layer's refusal for an identity-less
    entity and the store's abort for a second record at one address shall be raised
    and never recorded, with no persisted marker explaining either; no row shall be
    removed by anything other than the publication that claims its address or the
    publication that deletes the file it records; and because a replacement simply
    deletes the displaced row under owner decision 8a, no classification, ordering
    pass, disposition, evidence test or deferral shall exist for anything to persist.
  priority: must
- id: NFR-RIK-002
  statement: No local identity shall be invented or inferred, LocalFs shall keep emitting
    identityKey undefined and no production branch shall read a local entity's identityKey
    as evidence; and the change shall state where a reader will find it that a missed
    local rename event, a cross-scope local rename, Dropbox's path-derived topology
    and acquisition reach are not improved by it.
  priority: must
- id: NFR-RIK-003
  statement: Remote rename detection shall remain order-independent per ADR 0006,
    Dropbox's path-keyed upsertedPaths reclaim guard shall be unchanged, and no backend-specific
    import or branch shall be added to src/sync/.
  priority: must
- id: NFR-RIK-004
  statement: The change shall introduce no new SyncStateStore importer, referencer,
    constructor or mutation caller and no new persistent-store owner; the ownership
    guard's four per-file inventories shall stay byte-identical, which is the machine
    proof that removing two names from its mutating-method set is detector hygiene
    over methods that no longer exist rather than the intentional new writer, owner
    or field that AGENTS.md:71-73 binds the ADR-0001-plus-enforcement-document triple
    to; the guard's own fixture shall nonetheless be edited at both sites that consume
    that set, which is a consequence of the removal and not evidence of a new writer;
    and sync-admission-authority-guard.test.mjs shall stay green with no fixture edit,
    since needing one would mean identity policy had moved into the store.
  priority: must
---

<!-- lifecycle is owned by change.md -->

# Requirements

## Content

The engine must never rename or delete the wrong object because the correspondence between a
vault file and a provider object is positional. That is the whole purpose. Two objects at one
vault path stay impossible; representing them is not a goal here.

The problem separates into three places where the correspondence is positional. Two of them close
together under one mechanism, and each of the three is stated at the size the measurements in this
change support — not at the size the analysis behind it originally claimed.

- **M1, the in-flight mis-binding.** A remote rename report says "object X moved `old` → `new`",
  and nothing in the report names X: `RenamePair` (`src/fs/types.ts:74-79`) carries `oldPath`,
  `newPath` and `isFolder` only. Admission's cross-check on that claim is the guard at
  `identity-component-decision.ts:106-107`, and **that guard is measured to be a tautology.**
  `completeIdentityEvidence` (`identity-evidence.ts:41-44`) fills `report.identityKey` out of the
  same map `indexFacts` builds `current.remote` from, so the comparison is a value against its own
  source; when the lookup misses, line 106's own `report.identityKey &&` precondition
  short-circuits it. What carrying the identity *with the report* buys is therefore narrow and is
  claimed at that size: it replaces a check that cannot check anything with one that compares two
  independently produced values. It is **not** the repair of a demonstrated wrong operation — the
  replaced-destination shape is admitted today as a `match`, because `indexFacts` and
  `bindFiles:420-421` discriminate it ahead of the guard.
- **M2, the baseline with no identity.** `identity-component-decision.ts:408-410` resolves a
  baseline's remote endpoint by `baseline.remoteIdentityKey` when it has one and by position —
  `facts.remote.get(path)` — when it does not. In the measured fixture the occupant happens to be
  the right object; nothing in the code makes it so.
- **M3, two baselines claiming one object.** Nothing observes identity uniqueness across records.
  With two records carrying one `remoteIdentityKey`, `bindFiles` binds the first and
  `occurrenceClaimed` drops the second. The harm this was once said to cause downstream — a
  `delete_local` of a live file — **is withdrawn as unestablished**:
  `identity-component-decision.ts:568-569` refuses `delete_local` without a provider-reported
  deletion at that address, and no measurement produces the destructive outcome. What is required
  here is that the two-baseline state stop being **representable**.

**M2 and M3 are one mechanism apart.** Keying the record by `remoteIdentityKey` closes both by
construction: one row per identity is what a keyPath is, and a keyPath over a missing property is a
`DataError`, so M2's fallback arm has no input. Neither needs a uniqueness observation or a
recovery branch. What the store gains besides the key is a unique index over `path`.

**And the structural gain the store half is actually for.** With `keyPath: "path"`, `store.put`
discards whatever row sat at the address as a **property of the key** (`state.ts:101-103`) —
invisible at the call site, capturable by nothing, assertable by no test. With identity as the key
plus a unique `path` index, writing a new correspondence **must delete the incumbent explicitly or
the constraint aborts the transaction**. The discard becomes an admitted action: captured by
Admission as the publication's destination, compared by the CAS before it is performed, and
asserted by a test. That is what this half delivers, and it is structural rather than the
prevention of a wrong operation.

A fourth candidate — HOT's path-keyed `getMany` missing a record whose object moved — is already
closed on main by `needsWarmComponentAcquisition`'s escalation to `getAll()`, so nothing is added
for it.

**The upstream premise this change is entitled to.** `fs` guarantees to the sync engine that a
provider object path is unique — at most one object exists at one address below the `IFileSystem`
seam. This change assumes that premise and says so; discharging it belongs to issue #90. A
`SyncRecord` store asked to arbitrate two records at one path has already been handed a violated
precondition, which is why the unique `path` index below is a guard on the premise and not a policy
mechanism.

### Functional requirements

- **FR-RIK-001 — the seam carries the identity.** Every `RenamePair` a remote filesystem produces
  shall carry, in an `identityKey` field, the provider identity of the object at `newPath` as that
  filesystem's own `FileEntity` projection yields it; the field shall be absent only when that
  projection yields none.
- **FR-RIK-002 — the carried value is the projection, never the cache id** *(invariant)*. The
  carried identity shall never be `extractId`'s value; in particular Dropbox's `entry.path_lower`
  fallback shall never appear as a `RenamePair.identityKey`. Equivalently: a carried identity shall
  always equal the `identityKey` a later `stat` or `list` observation of the same object in the
  same cycle reports.
- **FR-RIK-003 — the identity survives to Admission unchanged** *(invariant)*. No downstream stage
  shall overwrite a carried identity; two rename claims that agree on side, `oldPath`, `newPath`
  and `isFolder` but disagree on `identityKey` shall not be collapsed into one claim; and a carried
  key, an absent key and an empty key shall be three distinct values to the rename-evidence dedupe
  key, with none aliasing another.
- **FR-RIK-004 — the validation compares independent sources.** Admission's validation of a
  reported remote rename shall compare the report's carried identity against current remote facts
  derived independently of that report; the path-keyed re-attachment of a remote rename's identity
  from the destination address shall be removed; a report carrying no identity shall be handled
  exactly as it is on main; and no rule shall fail a component because a report carries no key.
- **FR-RIK-005 — identity may only narrow** *(invariant)*. No report family, folder relation or
  binding that the current positional rules reject shall become admissible because an identity is
  now present. `conflicting` is fail-safe — it degrades to ordinary actions planned from current
  facts — so there is no benefit to trade against the risk of widening.
- **FR-RIK-006 — one object, one row; one address, one row** *(invariant)*. The durable record
  store shall hold at most one `SyncRecord` per `remoteIdentityKey`, **by construction**, because
  that property is the store's key; and at most one record per `path`, enforced by a unique index
  over that field. **Both fields shall be mandatory.**

  A publication shall be one of exactly two operations. A **rename** — the same identity at a new
  address — changes the `path` field of one row and is a **single `put`**; the primary key does not
  move and no row is deleted. A **replacement** — a different identity at an address a record
  already holds — moves the primary key, and **deletes the incumbent row and inserts the new one in
  one transaction**, after comparing the incumbent against the expectation Admission captured. The
  deletion shall be explicit and shall never be left to the key to perform implicitly.

  A write that would place a second record at an address a different record already holds *without
  deleting that record* shall abort its transaction having written nothing and shall **throw**
  rather than return the ordinary stale-baseline `false`; it shall never be caught, mapped onto
  that return, or resolved by replacing the incumbent after the fact. No requirement here depends
  on the abort naming itself: `idb-helper.ts:143` rejects on `tx.onerror` with `tx.error` still
  `null`, so on main every aborted transaction arrives unnamed, and that is a separately repairable
  helper defect this change neither repairs nor works around. A relocation set in which every
  terminal record carries its own source record's identity shall never be refused, whatever its
  size.
- **FR-RIK-007 — every stored record carries a non-empty identity** *(invariant)*.
  `SyncRecord.remoteIdentityKey` shall be a required, non-empty string. No `SyncRecord` with an
  absent or empty identity shall exist, and the two cases are one: an empty string is a valid
  IndexedDB key, so storing it would silently fold two distinct entities into one row, while an
  absent one is a `DataError`. **`buildSyncRecord` itself** shall admit neither and shall refuse,
  naming the entity, before any store write — the floor belongs to the construction function, not
  to one caller, because it has three production callers in two files (`state-committer.ts:119`,
  `opened-file-priority.ts:61`, `:88`). No caller shall fold an absent identity to `""` to satisfy
  the declared type. This constrains what a *durable record* may carry and does not constrain what
  a *rename report* may carry, where `ADR 0008`'s "missing keys provide no evidence" governs.
- **FR-RIK-008 — version bump, no migration.** `DB_VERSION` shall be bumped so the existing
  `onUpgrade` drop-and-recreate (`state.ts:28-40`) rebuilds every record from current facts under
  the new key; v7→v8 is the exact precedent. No migration, transform or record-preserving upgrade
  code shall be added. The version comment shall record the reason in the style of the v4/v5/v7/v8
  comments, and shall record what the bump does **not** do: it is not what closes the identity-less
  record class — the key and the floor are — and it is not a cost specific to this change, being
  the same cold start the product already performs on reconnect, on a bound-root change and on
  `resetAll`.
- **FR-RIK-009 — the CAS-free rewrite route is deleted.** `SyncStateStore.rewritePaths` shall be
  removed from the public surface, from the ownership guard's mutating-method set and from the
  shared store test double, and `compareAndMove` shall leave the same three places as it collapses
  into `compareAndPut`. `docs/sync-pipeline.md`'s state-commit section shall name the
  compare-and-swap routes production actually takes — `compareAndPut`, `compareAndRewritePaths`
  and `compareAndDelete` — where it currently names `put()`, `rewritePaths()` and `delete()`. The
  guard's per-file **inventories** shall be byte-identical afterwards; its **fixture** is not
  untouched, because the detector set at `sync-state-ownership-guard.test.mjs:9-12` and the
  hardcoded method list at `:320` that generates two negative-fixture tests per name are edited
  together in the same change.
- **FR-RIK-010 — `SyncRecord.backendMeta` is removed.** It has one writer
  (`state-committer.ts:43`) and no production reader, and the identifying half of its contents
  duplicates `remoteIdentityKey`. `FileEntity.backendMeta` and every backend that populates it
  shall be unaffected (`hot-warm-promotion.ts:43` merges the *entity's* field, not the record's).
- **FR-RIK-011 — the guarantee binds all three families.** The shared caching contract shall
  assert, for googledrive, dropbox and onedrive alike and in both provider orderings, that a
  reported remote file rename and a reported remote folder rename each carry an `identityKey` equal
  to the `identityKey` observed at `newPath`, and that the pair never carries the identity
  previously observed at `oldPath`'s occupant when that occupant is a different object.
- **FR-RIK-012 — the positional baseline fallback is retired by construction.** The positional
  fallback at `identity-component-decision.ts:408-410` shall be **removed**, because no stored
  baseline can lack an identity once that property is the record store's key and the construction
  function refuses an absent or empty one. The retirement is **population-based, not type-based**:
  a required `string` is not always-truthy to TypeScript (`""` is falsy), so the arm still compiles
  and `npm run build` cannot discriminate. What discriminates is a test that fails when an
  identity-less record is constructed. Every production guard that tested the stored field's own
  absence shall be disposed of with the arm — removed where the whole branch was the
  absent-identity branch, reduced to its comparison where the absence test was a vacuous conjunct,
  and tightened where a runtime shape validator would otherwise keep admitting the forbidden shape
  — and none of them shall be repaired by restoring a positional route or by folding an absent
  identity to `""`. Branches that test whether a *record* is absent are untouched; a `SyncRecord`
  may still be absent, its identity may not.
- **FR-RIK-013 — a rename preserves the merge base under the same predicate as an in-place
  publication** *(invariant)*. A publication that relocates a record to a different address shall
  preserve the stored three-way merge base exactly when an in-place publication of the same record
  would — that is, under `compareAndPut`'s existing invalidation predicate. Today every rename
  destroys it: `compareAndMove` (`state.ts:132-133`) and `compareAndRewritePaths` (`:186-187`)
  delete `sync-content` at both addresses unconditionally on CAS success, where `compareAndPut`
  (`:104-108`) deletes only when there is no expected record, when the record has no hash, or when
  `hash`, `localSize` or `remoteIdentityKey` changed. The *carry* half is discharged by the key —
  `sync-content` is re-keyed to `remoteIdentityKey`, so a relocation does not move the base row at
  all — and what survives as work is the predicate, which must survive `compareAndMove`'s collapse
  into `compareAndPut` rather than disappear with the method.
- **FR-RIK-014 — the positional mechanisms are measured before anything is removed.** Five named
  fixture shapes shall be driven through the production Admission entry — `captureBatchObservation`
  into `admitBatchObservation` — on unchanged production code, and the branch taken by
  `selectReportFamily`, `aliasFolder`, `completeIdentityEvidence`'s `newPath` lookup and the
  identity guard shall be asserted by name for each. The shapes are: a remote object renamed under
  an unchanged local file with a baseline carrying an identity; the same with a baseline carrying
  none; a remote object replaced at an address by a different id; a rename whose evidence carries
  no identity; and a folder rename whose descendants are not re-emitted. **This requirement is
  discharged, not pending** — `src/sync/plan-admission.test.ts` carries the five shapes plus a
  sixth case that pins the boundary of the result, and `src/sync/record-rekey-across-commit.test.ts`
  carries the same discipline across the publication boundary on the real `SyncStateStore`. Both
  files are part of this change and must be landed, cited and kept green; the plan may not describe
  an equivalent test that does not exist, and the recorded results, not any earlier analysis, are
  what every later claim cites. This change retires no mechanism.

### Non-functional requirements

- **NFR-RIK-001 — no third authority, nothing persisted.** No third durable authority; no persisted
  evidence, rename intent, Admission disposition, retry instruction or recovery marker; no retained
  in-memory correctness owner. Carried identity lives only in the cycle's evidence and is discarded
  with it. The record layer's refusal for an identity-less entity, and the store's abort for a
  second record at one address, are raised and never recorded. No row is removed by anything other
  than the publication that claims its address or the publication that deletes the file it records.
  Nothing classifies, sequences or defers a displaced row — a replacement simply deletes it — so
  there is no classification, order, disposition or deferral for anything to persist.
- **NFR-RIK-002 — no invented local identity, and the non-improvements are written down.** `LocalFs`
  keeps emitting `identityKey` undefined (`local-fs.test.ts:176` pins it), local rename evidence
  keeps carrying no `identityKey`, and no production branch reads a local entity's `identityKey` as
  evidence. The change states, where a reader will find it, what it does **not** improve: a missed
  local rename event stays unrecoverable and indistinguishable from delete-plus-create; a
  cross-scope local rename still degrades to a `markDirty` on the in-scope side only, with no
  surviving relation; Dropbox's topology stays path-derived; and acquisition reach is unchanged,
  because the WARM escalation already closed it.
- **NFR-RIK-003 — ADR 0006 and the backend boundary are preserved.** Remote rename detection stays
  order-independent; Dropbox's path-keyed `upsertedPaths` reclaim guard is unchanged; no
  backend-specific import or branch is added to `src/sync/` (lint-enforced by
  `BACKEND_SPECIFIC_IMPORTS`).
- **NFR-RIK-004 — no new store owner, and the triple moves together.** No new `SyncStateStore`
  importer, referencer, constructor or mutation caller, and no new persistent-store owner. The
  ownership guard's four per-file **inventories** stay byte-identical, and that — not an untouched
  file — is the machine proof that the two names removed from the mutating-method set are detector
  hygiene over methods that no longer exist, rather than the intentional new writer, owner or field
  that `AGENTS.md:71-73` binds the ADR-0001-plus-enforcement-document triple to. Those documents are
  still corrected here, as consequences of the store surface moving rather than as an obligation
  this change incurs. `sync-admission-authority-guard.test.mjs` stays green with no fixture edit —
  needing one would mean identity policy had moved into the store.

### Invariants this change must not break

`ADR 0008` Decision §2 has three states — equal non-empty keys relate occurrences, unequal keys
separate them, **missing keys provide no evidence**. Nothing here encodes absence of evidence as
evidence of conflict: no rule fails a component because a rename report carries no key, and no row
is retired because nothing observed its object. `ADR 0006`'s order-independence and `ADR 0001`'s two
publication points are preserved unchanged. The new key and the unique `path` index are storage
mechanism subordinate to commit-last, not an identity-policy owner: the store chooses no winner, it
declines to represent a state its caller was told could not arise, which
`sync-admission-authority-guard.test.mjs` proves by staying green with no fixture edit.

### Acceptance

- **AC-RIK-001** *(FR-RIK-001, FR-RIK-002, FR-RIK-011)* — For every registered backend family and
  both provider orderings, each reported remote rename pair carries the `identityKey` a `stat` of
  `newPath` reports, or explicitly no identity with a cited reason; no pair ever carries a
  cache-internal synthetic id, and a Dropbox entry with no provider id yields a pair whose
  `identityKey` is absent rather than `path_lower`.
- **AC-RIK-002** *(FR-RIK-003)* — A carried identity reaches Admission unchanged, and two rename
  claims on one edge carrying different identities both survive the evidence stage and are
  classified `conflicting` rather than collapsed by the dedupe key.
- **AC-RIK-003** *(FR-RIK-004)* — Driven through `admitBatchObservation`, a remote rename whose
  carried identity disagrees with the identity observed at `newPath` fails its component and
  produces no action, where the same **producer-level** input on main produces one or more actions.
  The RED half is staged by giving the rename *pair* an identity, never by hand-keying the report:
  `completeIdentityEvidence`'s fill is guarded by `!item.identityKey`
  (`identity-evidence.ts:41-44`), so a pre-keyed report already fails on main and is no witness.
  The action main produces for that input is not a wrong rename — fixture 3 records a `match` for
  the same-address form.
- **AC-RIK-004** *(FR-RIK-005, NFR-RIK-003)* — No fixture exists in which a report family, folder
  relation or binding that the positional rules reject becomes admissible because an identity is
  present; a report with no carried identity produces exactly main's actions and no component fails
  for a missing key.
- **AC-RIK-005** *(FR-RIK-006)* — Two `SyncRecord`s cannot both claim one `remoteIdentityKey`,
  because that property is the store's key and the second write updates the one row rather than
  creating a second; both `remoteIdentityKey` and `path` are mandatory. A **rename** — a terminal
  carrying the expected row's own identity at a new address — is a single `put` that issues no
  delete, leaves the primary key unchanged and leaves the identically keyed `sync-content` row in
  place. A **replacement** — a terminal whose identity differs from that of the record holding the
  claimed address — deletes that incumbent and inserts the terminal within one transaction, after
  comparing the incumbent, so that afterwards exactly one row holds the address, the incumbent's
  `sync-content` row is gone with it, and the delete is observable as its own operation rather than
  as a side effect of the put. A replacement whose captured expectation no longer matches deletes
  nothing and returns `false`, because the comparison precedes the delete. A replacement carries no
  continued row, so `identity-component-decision.ts:509-511` and `:549-551` no longer pass the
  incumbent as both source and destination. Two distinct records written at one `path` without the
  incumbent being deleted abort the transaction having written nothing, the failure reaching the
  caller as a throw and never as the stale-baseline `false`, asserted on that shape rather than on
  a `DOMException` name. A baseline-free create still refuses a non-vacant address; a delete with
  no expected record verifies vacancy, deletes nothing and returns `true`; a twelve-child
  relocation that preserves every identity publishes normally; and a relocation set whose terminal
  addresses intersect another item's source addresses, or which is cyclic, publishes nothing and
  returns `false`.
- **AC-RIK-006** *(FR-RIK-007)* — No stored `SyncRecord` has an absent or empty
  `remoteIdentityKey`; a remote entity supplying either is refused inside `buildSyncRecord` with one
  named error before any store write, so all three production callers in two files reach the same
  refusal and none folds the value to `""`; both inputs take the same branch and nothing is
  written; `commitAction`'s caller fails the action so the cycle does not complete; the opened-file
  priority attempt takes no baseline and defers to the batch; and the refused entity is still
  listed, still compared and still conflict-resolvable.
- **AC-RIK-007** *(FR-RIK-008)* — A database seeded at the previous version opens at the new one
  with zero records and zero content entries, both stores are recreated with
  `keyPath: "remoteIdentityKey"`, `sync-records` carries a unique index over `path`, no migration,
  transform or record-preserving upgrade code exists anywhere in `src/`, and the version comment
  records what the bump does not do.
- **AC-RIK-008** *(FR-RIK-009, NFR-RIK-004)* — `rewritePaths` and `compareAndMove` are both absent
  from `SyncStateStore`, from the store test double, from the ownership guard's mutating-method set
  at `:9-12`, from the generated negative-fixture list at `:320` and from `docs/sync-pipeline.md`;
  every remaining CAS method still has both of its generated negative fixtures; that document names
  the three compare-and-swap routes production takes; the guard's import, reference, constructor
  and mutation-caller inventories are byte-identical before and after; and `lint:bot-repro` is
  green.
- **AC-RIK-009** *(FR-RIK-010)* — `SyncRecord` carries no `backendMeta`, `FileEntity.backendMeta` is
  unchanged, and whole-record CAS equality compares the same field set on both sides.
- **AC-RIK-010** *(NFR-RIK-001, NFR-RIK-004)* — No persisted evidence, rename intent, Admission
  disposition, retry instruction or recovery marker exists; no new retained in-memory correctness
  owner exists; the `SyncStateStore` import, reference, constructor and mutation-caller sets are
  unchanged; and `sync-admission-authority-guard.test.mjs` is green with no fixture edit.
- **AC-RIK-011** *(NFR-RIK-002)* — `LocalFs` still reports `identityKey` undefined, local rename
  evidence carries no `identityKey`, no production branch reads a local entity's `identityKey` as
  evidence, and the four non-improvements are stated in the change's own documents.
- **AC-RIK-012** *(FR-RIK-012)* — The positional arm at `identity-component-decision.ts:408-410` no
  longer exists, and what stops it returning is the absence of its population, not a type error: a
  test fails when a `SyncRecord` is constructed without a non-empty identity, and `npm run build`
  is **not** the assertion, because the arm's exact shape compiles clean under this repository's
  own `tsc --strict` with `remoteIdentityKey` typed `string` and `eslint.config.mts` configures no
  `no-unnecessary-condition`. Every stored baseline resolves its remote endpoint through
  `currentByIdentity` with no address fallback available; every production branch that tested a
  stored record's own identity absence is removed, reduced or tightened, with none repaired
  positionally and none folding to `""`; and nothing in the change claims that fallback is still
  live or asserts its retirement through the build.
- **AC-RIK-013** *(FR-RIK-013)* — A file renamed remotely with unchanged bytes keeps its three-way
  merge base and the next conflict on it resolves by merge rather than newer-mtime-wins, including
  on the path `compareAndMove` used to take before it collapsed into `compareAndPut`; a rename that
  changes the content hash drops the base; a 500-child folder relocation preserves or invalidates
  every child's base under one transaction image.
- **AC-RIK-014** *(FR-RIK-014)* — Five fixture shapes are recorded against unchanged production code
  with the branch taken named at each of the four observation sites; the record says that
  `identity-component-decision.ts:106-107` cannot fail on any fact shape today's Observation layer
  emits, and a sixth case pins that boundary by recording `conflicting_identity` for the two
  map-keying divergences where it does fail; a second measurement over the real `SyncStateStore`
  records that the same-cycle baseline is preserved by identity-keyed binding while the split-cycle
  baseline is not retained, the old row being discarded and the object re-downloaded as new, which
  the record model settles is the model working and which the case asserts deliberately rather than
  as a defect; both measurement files exist in the change rather than being described; every later
  claim cites their recorded results; and no positional mechanism is retired by the measurement
  itself.
- **AC-RIK-015** *(NFR-RIK-003, FR-RIK-011)* — `npm run lint`, `npm run lint:bot-repro`,
  `npm run build` and `npm run test:coverage` are all green at **every unit boundary**, not only at
  the end — in particular no boundary leaves a keyPath over an optional property, so no non-null
  assertion and no empty-string fold is ever required — with Dropbox's path-keyed `upsertedPaths`
  reclaim guard and every `ADR 0006` ordering case unchanged.

### What the change deliberately does not do

- It does not give the local side an identity. There is none, and `local-fs.test.ts:176` keeps
  pinning that.
- It does not prevent a demonstrated wrong rename at the Admission guard. The guard cannot fail on
  any fact shape today's Observation layer emits; what the change does there is make a real check
  out of a tautology and remove the two failures the enrichment manufactures out of a map-keying
  divergence.
- It does not retain a baseline for an object that reappears. A `SyncRecord` is the record of a
  local file that is synced; when either side deletes the file the deletion synchronises and the
  record goes with it, and a reappearing object is a new file. The split-cycle result the second
  measurement records — the old row discarded, the object re-downloaded as new — is that model
  working, not a loss awaiting repair.
- It does not design the filesystem layer's path-uniqueness mechanism or the collision arbiter for
  two objects at one address. Those are issue #90's, already written there, and this change only
  states the premise, assumes it, and refuses loudly when it is violated.
- It does not repair `src/store/idb-helper.ts`, which rejects on `tx.onerror` with `tx.error` still
  `null` (`:143`) so that every aborted transaction on main arrives unnamed. That is an
  independently repairable helper defect with its own blast radius; no requirement, witness or
  verification here depends on the name, and no call site works around it.
- It does not retire any positional mechanism. `selectReportFamily`, `aliasFolder`,
  `decideFolder`'s suffix coverage, `path-observation`'s endpoint re-observation and Dropbox's
  `upsertedPaths` reclaim guard all stay; the change produces the measurement a later retirement
  would have to cite.
- It adds no operator-visible signal. `Logger.enabled` and `src/sync/sync-cycle-diagnostics.ts` are
  not on main, and `DEFAULT_SETTINGS.showSyncNotifications` and `enableLogging` are both `false`
  (`settings.ts:73-74`), so every observable asserted here is a cycle outcome. The consequence is
  stated rather than assumed benign: a failed component is silent to the user and shows only as
  work not progressing.
