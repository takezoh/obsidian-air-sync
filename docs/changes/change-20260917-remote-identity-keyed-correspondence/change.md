---
id: change-20260917-remote-identity-keyed-correspondence
kind: change
title: Key the remote side of the sync correspondence by object identity
status: draft
created: '2026-09-17'
profile: sdd@1
intent: Make the durable correspondence between a vault file and a provider object name its own
  object, so that displacing a record becomes an admitted action instead of a property of the
  store's key. Under keyPath path, store.put discards whatever row occupies the address
  (state.ts:101-103) — the discard is invisible at the call site, capturable by nothing and
  assertable by no test. With remoteIdentityKey as the key plus a unique index over path, a
  publication that claims an address a different record holds must delete that record explicitly
  or the constraint aborts the transaction, so the discard is captured by Admission, compared by
  the CAS before it is performed, and asserted by a test. Alongside it, carry the provider identity
  the producers already hold across the IFileSystem rename seam, so Admission's remote-rename check
  compares two independently produced values instead of a value against the map it was filled from.
outcomes:
- A reported remote rename names the object it relates, taken from the producing filesystem's own
  FileEntity projection, so the check at identity-component-decision.ts:106-107 becomes a genuine
  cross-source comparison. Measured, that guard cannot fail on any fact shape today's Observation
  layer emits, so what this replaces is a tautology — not a wrong operation.
- A remote rename whose carried identity disagrees with the identity observed at the destination
  fails its component and produces no action. This is a tightening rather than the repair of a
  demonstrated wrong rename — driven end to end through captureBatchObservation into
  admitBatchObservation, the replaced-destination shape is admitted today with a match, because
  indexFacts and bindFiles:420-421 discriminate it ahead of the guard.
- The two failures the destination-address enrichment currently manufactures out of a map-keying
  divergence go away with it, and removing it loses no evidence.
- Two rename claims on one edge carrying different identities both reach the stage that arbitrates
  identity claims, instead of one being dropped arbitrarily by an upstream dedupe key that omits
  the identity.
- Two SyncRecords cannot claim one provider object, because that property is the store's key — the
  state stops being representable rather than being observed and refused. The earlier claim that
  the dropped baseline's address later yields a delete_local of a live file is withdrawn as
  unestablished, since identity-component-decision.ts:568-569 refuses delete_local without a
  provider-reported deletion at that address.
- A publication that claims an address a record for a different object holds deletes that record
  explicitly, in the same transaction, after comparing it against what Admission captured; a
  rename, by contrast, is a single put that issues no delete and moves no key.
- No SyncRecord can carry an absent or empty remoteIdentityKey. buildSyncRecord itself refuses
  both, naming the entity, before any store write, for all three of its production callers in two
  files, so the positional baseline fallback at identity-component-decision.ts:408-410 is retired
  because its population cannot exist.
- A rename no longer destroys the three-way merge base, so the next conflict on a renamed file
  resolves by merge rather than newer-mtime-wins.
- Production Admission's behaviour for five named fixture shapes, and the fate of a committed
  baseline across the publication boundary, are recorded end to end for the first time, which is
  the citation any later retirement of a positional mechanism would need.
- The CAS-free rewrite route that could overwrite whatever occupies a destination address is gone,
  compareAndMove collapses into compareAndPut, and the pipeline document names the compare-and-swap
  routes production actually takes.
scope:
- src/fs/types.ts — RenamePair gains an optional identityKey whose documented source is the
  producing filesystem's own FileEntity projection, with extractId, idAt, getPathById and
  snapshotPathsById named as forbidden sources across the IFileSystem boundary.
- src/fs/interface.ts — the rename contract's documented meaning follows the type.
- src/fs/caching/metadata-cache.ts — one total projection helper over the existing public toEntity,
  the boundary that keeps extractId's total-but-synthetic id from being mistaken for an identity.
- src/fs/caching/id-delta.ts — applyEntry's move branch fills identityKey through that helper.
- src/fs/caching/remote-fs.ts — diffById stops destructuring the TFile away and fills identityKey
  through the same helper.
- src/fs/dropbox/incremental-sync.ts — applyRename fills identityKey through the same helper.
- src/sync/identity-evidence.ts — the rename dedupe key carries the identity so a carried, an
  absent and an empty key stay three distinct values; the destination-address re-attachment of a
  remote rename's identity is removed; the stable_identity and alias passes are untouched; the
  vacuous absence guard at :57 is dropped.
- src/sync/identity-component-decision.ts — the remote-rename check keeps its shape and its guard
  and only the key's source changes; the positional baseline fallback at :408-410 is removed with
  the vacuous absence guards at :420 and :459; and a replacement publication stops passing the
  incumbent as both source and destination at :509-511 and :549-551, because it continues no row.
- src/sync/state.ts — sync-records is created with keyPath remoteIdentityKey and a unique index
  over path inside the existing cold-start recreate, sync-content is re-keyed the same way,
  DB_VERSION is bumped, rewritePaths is deleted and compareAndMove collapses into compareAndPut.
  Every CAS method takes two explicit expectations — the row keyed by the identity it writes and
  the current occupant of the address it claims — and performs either a single put (rename) or a
  delete plus insert in one transaction (replacement), comparing before it deletes.
  compareAndRewritePaths gains one admission condition, refusing a set whose terminal address
  equals a different item's source address, and compareAndPut's invalidation predicate replaces
  the unconditional merge-base deletes at :132-133 and :186-187.
- src/sync/types.ts — SyncRecord loses backendMeta, and remoteIdentityKey becomes required.
- src/sync/state-committer.ts — buildSyncRecord stops writing backendMeta and refuses an absent or
  empty identity with one named error before any store write; the two cases are one, and no caller
  folds an absent identity to the empty string to satisfy the required type.
- src/sync/opened-file-priority.ts — both buildSyncRecord callers reach the same refusal and the
  priority attempt defers to the batch rather than failing a cycle it is not part of; the whole
  absent-identity branch at :41 is removed; the two get calls read the path index.
- src/sync/plan-executor.ts — checkRecord's address proofs read the path index, and the vacuous
  absence guards at :556 and :788 are dropped.
- src/sync/change-detector.ts — getMany's per-path store.get calls read the path index.
- src/sync/conflict-resolver.ts — the merge base is read by the baseline record the caller already
  holds rather than by ctx.baselinePath, following the content store's key.
- src/sync/conflict-action-contract.ts — the runtime shape validator is tightened to require a
  non-empty identity, and the vacuous absence guard at :42 is dropped.
- src/sync/plan-admission.ts, src/sync/priority-batch-state.ts, src/sync/change-hash-enrichment.ts,
  src/sync/plan-admission-case-alias.ts, src/sync/sync-cycle-finalization.ts — each drops one
  vacuous term that tested a stored record's own identity absence, leaving the comparison it
  guarded unchanged. Branches testing whether a record is absent are untouched.
- src/sync/plan-admission.test.ts — six cases driven through the production Admission entry. Five
  fixture shapes are recorded on unchanged production code, and a sixth constructs the two
  capture-boundary divergences under which the guard does fail. Later re-priced as the enrichment
  and the identity-less baseline shape stop being constructible.
- src/sync/record-rekey-across-commit.test.ts — seven cases driven through the orchestrator's own
  chain over the real SyncStateStore, recording what survives a commit. Re-priced, not inverted,
  because its split-cycle result is the record model working.
- src/fs/caching/id-delta.test.ts — first unit coverage for the shared delta applier.
- src/__mocks__/sync-test-helpers.ts — the store double loses rewritePaths and compareAndMove; the
  entity helper's backendMeta is unaffected.
- src/sync/**/*.test.ts, src/fs/onedrive/incremental-sync.test.ts and
  tests/fs/contracts/remote-change-detection.contract.ts — the type-checked test surface. 24 test
  and mock files constructing SyncRecord literals gain a non-empty identity rather than an
  empty-string fold, and the five files spying on compareAndMove re-express against compareAndPut.
  tsconfig.json type-checks tests/**/*.ts as well as src/**/*.ts, so the compiler enumerates the
  set.
- tests/fs/contracts/caching-remote-fs.contract.ts — the remote FILE and FOLDER rename cells assert
  the pair's identity against a stat of newPath; their object literals are updated, not loosened.
- tests/fs/remote-backend-contracts.test.ts — the required-contract matrix cell per family.
- tests/fs/googledrive|dropbox|onedrive/caching-remote-fs.contract-harness.ts — per-family staging
  for the identity assertion.
- sync-state-ownership-guard.test.mjs — the mutating-method set at :9-12 loses exactly rewritePaths
  and compareAndMove, and the hardcoded list at :320 that generates two negative fixtures per name
  loses compareAndMove in the same edit. The four per-file inventories stay byte-identical, and
  that, not an untouched file, is what proves this is detector hygiene rather than a new writer.
- docs/adr/0001-metadata-cache-is-subordinate-to-commit-last.md — records the record store's new key
  and its unique path index as storage mechanism subordinate to commit-last, and the index as a
  guard on the filesystem layer's path-uniqueness guarantee rather than as an identity-policy owner.
- docs/code-enforcement.md — the two-authority row names the reduced mutating set.
- docs/sync-pipeline.md — the state-commit section names compareAndPut, compareAndRewritePaths and
  compareAndDelete where it currently names put, rewritePaths and delete.
- docs/design/design-remote-backend-implementation-contract.md — the rename-pair identity source
  rule; this document carries its normative items in prose rather than in frontmatter, so it is
  declared here rather than in the promotion manifest.
non_goals:
- Any local identity. Obsidian exposes no per-file id and local-fs.test.ts:176 keeps pinning its
  absence; a missed local rename event and a cross-scope local rename are not improved.
- Changing Dropbox's eighteen path-derived topology sites or its path-keyed upsertedPaths reclaim
  guard. A tombstone carries no id, so an identity-keyed guard is unconstructible, not merely worse.
- Adding any read of the record store to close HOT's path-keyed getMany hole. It is already closed
  by needsWarmComponentAcquisition's escalation to getAll, so such a read would be a performance
  change with no named failure behind it.
- Removing SyncStateStore.put or putContent. Both are measured to have zero production callers, like
  rewritePaths, but correcting the pipeline document removes the only route that named them and
  neither carries a mis-operation route of its own.
- Widening getChangedPaths' result type, adding an identity input to RenameAction, or adding an
  Admission stage. Those belong to the issue-90 direction and are not merged here.
- Preserving sync-content across the DB_VERSION bump. That is migration code, excluded by owner
  decision 4 and by AGENTS.md. Preserving it across a rename is a method-body policy and is in scope.
- Retiring selectReportFamily, aliasFolder or any other positional mechanism. This change produces
  the measurement such a retirement would have to cite and retires nothing.
- Making the filesystem layer enforce path uniqueness, and arbitrating two provider objects observed
  at one address. That premise and its collision rule belong to issue 90, which already carries
  them; this change states the premise, assumes it, and refuses loudly when it is violated.
- Any convergence strategy, retry, recovery path, recovery marker or queue for a unique-path-index
  violation. The index stays a pure defect signal, and a correctly built replacement deletes its
  incumbent inside its own transaction and never reaches it.
- Any evidence rule for whether a displaced object still exists, and any ordering machinery to defer
  a publication until an incumbent's own action has run. The correspondence's end is directly
  observed, so nothing is inferred, classified, sequenced or deferred.
- Repairing src/store/idb-helper.ts, which rejects on tx.onerror at :143 with tx.error still null,
  so every aborted transaction on main arrives unnamed rather than only a constraint violation. It
  is an independently repairable helper defect; no requirement, witness or verification here depends
  on the name, and no call site works around it.
- Any operator-visible signal for the failures this change introduces. Logger.enabled and
  src/sync/sync-cycle-diagnostics.ts are not on main and both logging settings default to false, so
  every asserted observable is a cycle outcome.
- A new AdmissionFailureReason member, a persisted Admission failure, a recovery marker, or any rule
  that fails a component because a rename report carries no identity.
change_classes:
- behavior
- boundary
- invariant
- internal_design
governance:
  gate: hard
  reasons:
  - Replaces the durable record store's primary key and adds the repository's first IndexedDB index,
    a unique constraint over path. The key changes what the store can represent for every future
    record, not only for the case the requirement names.
  - Makes a class of cycle fail that previously completed, in three places — a remote rename whose
    carried identity disagrees with the identity observed at its destination, a publication for an
    entity whose provider supplied no id, and a durable write that would leave two records at one
    address — and nothing on main surfaces a cycle failure to the user by default.
  - Widens the shared IFileSystem rename contract, which binds all three backend families, every
    registered harness and every test double at once, and rewrites three already-passing shared
    conformance assertions.
  - Removes two methods from the SyncStateStore public surface, removes a field from SyncRecord and
    makes another required, which moves the ownership-guard fixture at both sites that consume its
    mutating-method set, ADR 0001, docs/code-enforcement.md and the whole type-checked test surface.
    The guard's four per-file inventories stay byte-identical, so this is hygiene consequent on the
    surface moving rather than an intentional new writer, owner or field.
  approval_evidence: Owner decisions 1 to 8 are settled and recorded in the design run's
    owner-decision.md. They fix the purpose (avoiding mis-operation), the identity-keyed remote
    side, the persist-only-what-cannot-be-derived discipline, the DB_VERSION bump with a cold start,
    the record key shape as keyPath remoteIdentityKey with a unique path index (decision 5), the
    identity floor inside buildSyncRecord and the exclusion of any convergence strategy for the
    index (decision 6), the index as a hard constraint (decision 7a), and the record model with its
    two publication operations (decision 8, which supersedes 7b and 7c). Three blockers from the
    independent critique and three from the plan attack were settled with the owner afterwards and
    recorded. What decisions 1 to 8 do not themselves cover is listed in unresolved_decisions — the
    IFileSystem rename contract widening across all three families, and the removal of rewritePaths,
    compareAndMove and SyncRecord.backendMeta.
members:
- role: requirements
  path: changes/change-20260917-remote-identity-keyed-correspondence/requirements.md
  required: true
- role: implementation
  path: changes/change-20260917-remote-identity-keyed-correspondence/implementation.md
  required: true
- role: verification
  path: changes/change-20260917-remote-identity-keyed-correspondence/verification.md
  required: true
promotion:
- target: design-four-stage-sync-pipeline
  section: invariants
  action: upsert
  item:
    id: INV-017
    statement: A durable baseline names the remote object it relates by the provider's own object
      identity, and at most one baseline claims one such identity — by construction, because that
      identity is the record store's key, so a second row for one object has nowhere to exist. At
      most one baseline claims one vault address, enforced by a unique index that aborts rather
      than replaces; a violation is a defect signal about the filesystem layer's path-uniqueness
      guarantee, never an expected branch, and the store still chooses no winner. A baseline
      carries a non-empty provider identity or is not constructed at all — never an empty string,
      never synthesized from an address — so no baseline resolves its remote endpoint
      positionally. A publication that claims an address a different baseline holds deletes that
      baseline explicitly, in the same transaction, after comparing it; the discard is an admitted
      action, not a property of the key. Identity that crosses the IFileSystem boundary comes from
      the producing filesystem's own entity projection; a cache-internal id extractor is an
      address function, not a sync identity.
    enforcement: contract
  reason: 'This is the cross-cutting rule the change exists to establish. It binds future judgement
    about what may key or claim a durable baseline, about what an absent provider identity means,
    and about which producer may supply an identity at the filesystem seam — none of which is
    derivable from the code once written. INV-016 is the highest invariant id on main; the untracked
    superseded package change-20260916-cache-path-id-bijection also drafts an INV-017 and is not
    promoted, so the id is reconciled at whichever package promotes first.'
unresolved_decisions:
- 'unknown-dropbox-entry-without-id — can a cached Dropbox file or folder entry arrive with no id?
  dropbox/types.ts:23 declares it optional while googledrive/types.ts:25 and onedrive/types.ts:20
  declare it required, but the optionality exists only because the same type also covers deleted
  tombstones, which its own doc comment says are never cached and which buildFromFiles skips at
  dropbox/metadata-cache.ts:149. The expected population is therefore empty and this gates no
  decision here — contract-record-identity-floor-disposition is total either way and asserts the
  outcome rather than assuming it cannot occur. Settling it tells the repository whether that
  refusal branch is dead code or a live user-facing outcome, and it still gates whether a remote
  folder rename may ever require an identity. Settle from the list_folder contract text plus one
  opt-in e2e raw page dump.'
- 'unknown-local-rename-missed-event-recovery — a missed local rename event stays unrecoverable and
  indistinguishable from delete-plus-create, because there is no local identity to recover from.
  Out of reach rather than deferred. Settle by an explicit owner statement that the product
  consequence is accepted.'
- 'syncedAt retention — the field passes owner decision 3''s underivability test and is kept, but no
  production reader was found beyond conflict-action-contract.ts:149''s shape validator. Recorded as
  an observation, not acted on. Dropping it in this same bump is free if the owner wants the record
  shape smaller.'
- 'issue-90-fs-path-uniqueness-premise — the filesystem layer guarantees to the sync engine that a
  provider object path is unique below the IFileSystem seam. This change is entitled to that premise
  and refuses loudly when it is violated, but the premise is undischarged until issue 90 lands, and
  until then the unique path index is the only thing standing between a violation and a wrong
  operation. Not this change''s to answer and not a blocker for it.'
- 'idb-helper-abort-name-lost — not a question but a measured defect, recorded so it is not lost.
  src/store/idb-helper.ts registers tx.onerror at :143 before tx.onabort at :144, and tx.error is
  only set during the abort steps, so the onerror rejection wins the race with tx.error still null
  and IDBTransactionError.domName is null for every aborted transaction, not only a constraint
  violation. Probed against the repository''s own fake-indexeddb, request.onerror reports
  ConstraintError while tx.onerror reports null and tx.onabort reports ConstraintError, with the
  store empty afterwards. Fail-closed is intact; only the reason is lost. Repairable on its own,
  with a blast radius of both persistent stores. This change neither repairs it nor works around it,
  and no requirement, witness or verification here depends on the name.'
- 'issue-90-cross-issue-obligation — issue 90''s rule-keeper and input-committed-record derive that
  at most one claimant can hold that record from the premise that records are path-keyed. After this
  change that property comes from the unique path index instead. The property survives the re-key
  and issue 90''s rules are unaffected in substance; only their justification needs updating, and it
  is two sentences in issue 90''s plan. Recorded here so it is not lost, and deliberately not
  attempted in this change. Neither issue''s mechanism waits on the other.'
- 'hard-gate-approval-remaining — does the owner approve the two items owner decisions 1 to 8 do not
  cover? First, widening the shared IFileSystem rename contract, which binds all three backend
  families, every registered harness and every test double at once. Second, removing rewritePaths
  and compareAndMove from the SyncStateStore public surface and backendMeta from SyncRecord. The
  storage-level abort and the cycle failures it produces are covered by decisions 5, 6c and 7a; the
  identity floor and the retirement of the tolerance disposition by 6a and 8c. Settle by explicit
  approval recorded against this change before implementation starts.'
tags:
- sync-identity
- sync-state
- cross-backend
owners: []
relations:
- {type: conformsTo, target: design-four-stage-sync-pipeline}
- {type: conformsTo, target: design-remote-backend-implementation-contract}
source_paths:
- src/fs/types.ts
- src/fs/caching/metadata-cache.ts
- src/fs/caching/remote-fs.ts
- src/fs/caching/id-delta.ts
- src/fs/dropbox/incremental-sync.ts
- src/sync/state.ts
- src/sync/state-committer.ts
- src/sync/types.ts
- src/sync/opened-file-priority.ts
- src/sync/identity-component-decision.ts
- src/sync/identity-evidence.ts
- src/sync/plan-admission.test.ts
- src/sync/record-rekey-across-commit.test.ts
- tests/fs/contracts/caching-remote-fs.contract.ts
summary: durable な対応関係の主キーをプロバイダのオブジェクト ID にし、path へ unique index を張る。
  住所を奪う書き込みはキーの副作用としての暗黙の破棄ではなく、Admission が捕捉し CAS が比較しテストが検証する明示的な delete になる。
  identity は IFileSystem の rename 契約にも通し、恒真だった検査を実在の突き合わせへ変える。
updated: '2026-09-17'
---

## Summary

The correspondence between a vault file and a provider object is positional on the remote side.
This change keys the remote side of that correspondence by the provider's own object identity, and
carries the identity across the `IFileSystem` rename seam so the report names the object it relates.

**What the store half actually buys, stated at the size the measurements support.** With
`keyPath: "path"`, `store.put` discards whatever row occupies the address as a **property of the
key** (`state.ts:101-103`) — invisible at the call site, capturable by nothing, assertable by no
test. With `remoteIdentityKey` as the key plus a unique index over `path`, writing a new
correspondence **must delete the incumbent explicitly or the constraint aborts the transaction**.
The discard becomes an admitted action: captured by Admission as the publication's destination,
compared by the CAS before it is performed, and asserted by a test. That is structural, and it is
**not** the prevention of a wrong operation that happens today.

**The record model.** A `SyncRecord` is the record of **a local file that is synced**. `path` is
mandatory. When either side deletes the file, the deletion synchronises and the record is deleted
with it; if the object later reappears it is **a new file**, and no baseline is retained to
recognise it as the same object returning. It follows that a correspondence whose address now
belongs to a different object **has ended**, and that end is **directly observed** — the new object
is at the address now. Nothing has to be inferred about whether the incumbent's object still exists
somewhere, because the record never asserted that it did. So there is no retirement classification,
no evidence-of-death rule, no ordering machinery and no fail-closed disposition anywhere in this
change.

**The change, in four parts.**

1. `sync-records` is created with `keyPath: "remoteIdentityKey"` and a unique index over `path`.
   **Both fields are mandatory.** `sync-content` is re-keyed the same way.
2. An identity floor in `buildSyncRecord` itself, reaching all **three** production callers in
   **two** files (`state-committer.ts:119`, `opened-file-priority.ts:61`, `:88`). A record is only
   ever written after the remote side is settled, so an empty identity is not a case to tolerate but
   a contradiction: it must **fail loudly, naming the entity**, and must never fold to `""`.
3. `DB_VERSION` is bumped and the existing cold start (`state.ts:28-40`) drops and recreates every
   store — v7→v8 is the exact precedent. No record survives without an identity, so the positional
   fallback at `identity-component-decision.ts:410` has an **empty population** and is retired by
   unreachability. Not by a type check: that claim was measured false, because `""` is falsy and the
   arm compiles clean under the repository's own `tsc --strict`.
4. **Two operations.** A *rename* — the same identity at a new path — changes the `path` field and
   is a **single `put`**; the primary key does not move, which is simpler than today's
   `compareAndMove`. A *replacement* — a different identity at an address a record already holds —
   is a **delete plus insert in one transaction**, after comparing the incumbent against what
   Admission captured.

**The seam half, and what it is not.** `RenamePair` (`src/fs/types.ts:74-79`) carries `oldPath`,
`newPath` and `isFolder` and no identity, while every producer holds the material at the moment it
builds the pair. `completeIdentityEvidence` then re-attaches an identity by looking up the
destination address — out of the same two sources `indexFacts` builds `current.remote` from — so the
guard at `identity-component-decision.ts:106-107` compares a value to its own source. Driven end to
end through `captureBatchObservation` → `admitBatchObservation`, that guard **cannot fail on any
fact shape today's Observation layer emits**, and the replaced-destination shape is admitted with a
**`match`**, because `indexFacts` and `bindFiles:420-421` discriminate it first. So this half
replaces a tautology with a genuine cross-source comparison and removes the two failures the
enrichment manufactures out of a map-keying divergence. It does **not** repair a live wrong
operation, and nothing in this change is justified on that basis.

Two repairs ride along because they are the same code and the same class of defect. Every rename
currently destroys the three-way merge base — `compareAndMove` (`state.ts:132-133`) and
`compareAndRewritePaths` (`:186-187`) delete `sync-content` at both addresses where `compareAndPut`
(`:104-108`) applies a predicate — so the next conflict on a renamed file resolves by
newer-mtime-wins. And `rewritePaths`, which has no callers, no compare-and-swap, and a `put` that
overwrites whatever occupies the destination address, is still what `docs/sync-pipeline.md:304`
tells the next reader to reach for.

**The measurements this change rests on.** Two test files exist in the working tree, driven through
production entry points with no production file changed. `src/sync/plan-admission.test.ts` (+408
lines, six cases) records the branch production Admission takes for five never-measured shapes, and
its sixth case constructs the two capture-boundary divergences under which the guard *does* fail —
whether Observation can emit either is **not established either way**, and nothing here depends on
the answer. `src/sync/record-rekey-across-commit.test.ts` (508 lines, seven cases) records that a
same-cycle relocation preserves the baseline through identity-keyed binding at
`identity-component-decision.ts:408-409` — not through the store's key — while a relocation split
across cycles does not. Under the record model that loss is correct and expected, so those cases
assert it deliberately rather than as a defect. Both files are part of this change; every claim it
makes cites their recorded results rather than any earlier analysis.

**The premise this change is entitled to, and who owes it.** `fs` guarantees to the sync engine that
a provider object path is unique below the `IFileSystem` seam. This change assumes that and says so;
discharging it — a provider that permits two objects at one name resolving that below the seam, by
provider rename, before the engine observes it — is issue #90's and is not designed here. The unique
`path` index is a **guard on that premise**: it aborts, never replaces, its abort is a defect signal
rather than an expected branch, and no convergence strategy, retry or recovery path is designed for
it.

**Cross-issue obligation on #90, recorded and not attempted here.** #90's `rule-keeper` and
`input-committed-record` derive *"at most one claimant can hold that record"* from *"records are
path-keyed"*; under this change that property comes from the unique `path` index instead. The
property survives the re-key and #90's rules are unaffected in substance — only their justification
needs updating, and that is two sentences in #90's plan.

**Publication order needs nothing added.** `bindFiles` already binds unbaselined reports first
(`identity-component-decision.ts:390`, under the stated intent at `:388-389`), record-driven
relocations next (`:405`) and leftover current entities last (`:496`); measurement confirmed it. No
ordering rule, relocating-first emission or deferral is introduced anywhere.

## Closure Notes

Not closed. Implementation has not started.

Owner decisions 1–8 are settled and binding, and none is reopened here. The record key shape is
**not** among the open items: it is `keyPath: "remoteIdentityKey"` with a unique `path` index, and
the identity floor, the cold start and the two publication operations follow from it. What remains
open is recorded in `unresolved_decisions` and is, in substance:

- **`unknown-dropbox-entry-without-id`** — can a *cached* Dropbox `file`/`folder` entry arrive with
  no `id`? Measurement bounds the expected population to empty, so it gates no decision here and the
  floor's disposition is total either way; settling it tells the repository whether that refusal
  branch is dead code or a live user-facing outcome. It still gates whether a remote *folder* rename
  may ever **require** an identity, which stays out of scope.
- **`unknown-local-rename-missed-event-recovery`** — out of reach, not deferred: there is no local
  identity to recover from. Needs an explicit owner statement that the product consequence is
  accepted.
- **`syncedAt`** — kept, because it passes the underivability test, but no production reader was
  found beyond one shape validator. Recorded as an observation; dropping it in this same bump is
  free if the owner wants the record shape smaller.
- **Issue #90's discharge of the `fs` path-uniqueness premise** — not this change's to answer and
  not a blocker for it, but the premise is undischarged until #90 lands, and the unique `path` index
  is the only thing standing between a violation and a wrong operation.
- **`src/store/idb-helper.ts:143`** — not a question but a measured defect, recorded so it is not
  lost: the helper registers `tx.onerror = () => reject(new IDBTransactionError("error", tx.error))`
  before `tx.onabort`, and `tx.error` is only set during the abort steps, so `domName` is `null` for
  **every** aborted transaction, not only a constraint violation. Fail-closed is intact; only the
  reason is lost. It is repairable on its own, and this change neither repairs it nor works around
  it — no requirement, witness or verification here depends on the name.
