---
change: change-20260917-remote-identity-keyed-correspondence
role: implementation
contracts:
- contract-seam-carried-identity
- contract-evidence-identity-preservation
- contract-cross-source-rename-validation
- contract-positional-mechanism-evidence
- contract-local-positional-boundary
- contract-record-identity-uniqueness
- contract-merge-base-survives-relocation
- contract-record-field-audit
- contract-record-identity-floor-disposition
- contract-cross-family-identity-conformance
contract_projections:
- id: contract-seam-carried-identity
  verifications:
  - verify-renamepair-carries-projected-identity
  - verify-dropbox-delta-rename-carries-entry-id
  - verify-fullscan-diff-carries-projected-identity
  - verify-order-independence-unchanged
  discretion:
  - discretion-identity-lookup-call-shape
  - discretion-projection-helper-placement
- id: contract-evidence-identity-preservation
  verifications:
  - verify-carried-identity-reaches-evidence
  - verify-different-identity-same-edge-not-collapsed
  - verify-rename-newpath-enrichment-removed
  - verify-stable-identity-and-alias-passes-intact
  discretion:
  - discretion-dedupe-key-encoding
- id: contract-cross-source-rename-validation
  verifications:
  - verify-carried-identity-mismatch-fails-component
  - verify-carried-identity-match-admits-rename
  - verify-absent-identity-behaves-as-today
  - verify-identity-only-narrows-report-family
  discretion:
  - discretion-failure-reason-reuse
- id: contract-positional-mechanism-evidence
  verifications:
  - verify-five-shapes-reach-named-branches
  - verify-replaced-destination-shape-records-guard-branch
  - verify-guard-failure-boundary-stays-pinned
  - verify-committed-baseline-fate-is-recorded
  discretion: []
- id: contract-local-positional-boundary
  verifications:
  - verify-localfs-identity-stays-undefined
  - verify-local-rename-evidence-carries-no-identity
  - verify-local-tracker-unchanged
  discretion: []
- id: contract-record-identity-uniqueness
  verifications:
  - verify-replacement-deletes-incumbent-and-inserts-one-row
  - verify-rename-is-a-single-put-that-deletes-nothing
  - verify-duplicate-path-aborts-and-propagates
  - verify-refusals-return-false-without-reaching-the-index
  discretion:
  - discretion-cas-address-comparison-shape
- id: contract-merge-base-survives-relocation
  verifications:
  - verify-unchanged-rename-keeps-merge-base
  - verify-content-changing-rename-drops-merge-base
  - verify-folder-relocation-preserves-every-child-base
  - verify-renamed-file-still-three-way-merges
  discretion:
  - discretion-merge-base-invalidation-site
- id: contract-record-field-audit
  verifications:
  - verify-backendmeta-absent-from-record
  - verify-no-production-reader-of-record-backendmeta
  - verify-cas-equality-unaffected
  - verify-entity-backendmeta-untouched
  discretion: []
- id: contract-record-identity-floor-disposition
  verifications:
  - verify-empty-identity-takes-the-same-branch-as-absent
  - verify-identityless-record-construction-fails
  - verify-priority-attempt-defers-instead-of-baselining
  - verify-identityless-publication-writes-nothing
  discretion:
  - discretion-identity-floor-refusal-site
- id: contract-cross-family-identity-conformance
  verifications:
  - verify-file-rename-pair-identity-matches-stat
  - verify-folder-rename-pair-identity-matches-stat
  - verify-both-provider-orderings-agree
  - verify-matrix-still-fails-closed-on-missing-cell
  discretion: []
adrs:
- adr-remote-correspondence-identity-carrier
- adr-record-identity-uniqueness-mechanism
- adr-record-key-shape
- adr-record-identity-floor-tolerated
decision_dispositions:
- decision_input_ref: decision-input-owner-purpose-is-misoperation
  disposition: Binding and used as the sole judging criterion, and the criterion is
    now applied against measurement rather than against analysis. The plan previously
    claimed every mechanism was justified by a named wrong operation it prevents.
    Two measurements landed and that claim does not survive intact. src/sync/plan-admission.test.ts
    shows the guard at identity-component-decision.ts:106-107 cannot fail on any fact
    shape today's Observation layer emits and that the replaced-destination shape
    is admitted as a match rather than a wrong rename, because indexFacts and bindFiles:420-421
    discriminate it first, so the seam half is carried as replacing a tautology with
    a real cross-source check and removing failures the enrichment manufactures -
    not as stopping a reachable wrong operation. src/sync/record-rekey-across-commit.test.ts
    shows no wrong-object operation occurring, and owner decision 8a settles that
    its split-cycle end state is the model working rather than a loss, so the record
    half's payoff is claimed as structural and only as structural - M2 and M3 stop
    being representable and the silent discard of an incumbent becomes an admitted,
    compared and asserted operation - and never as baseline continuity across cycles.
    M3's delete_local-of-a-live-file consequence is marked analytical. Collision representation
    remains out of scope and no mechanism that only matters for it was proposed. The
    one graft that failed this test — a store-level identity-preservation check on
    folder relocations — was rejected rather than kept for symmetry.
  adr_refs:
  - adr-remote-correspondence-identity-carrier
  - adr-record-identity-uniqueness-mechanism
  contract_refs:
  - contract-cross-source-rename-validation
  - contract-record-identity-uniqueness
- decision_input_ref: decision-input-conductor-note-boundary-carried-identity
  disposition: Adopted as the change's first half and measured. Boundary-carried identity
    is not sufficient on its own and not subsumed by the store change; it is the only
    thing that closes the in-flight mis-binding, because the rename report never reaches
    any store. Verdict recorded as complementary with a named division of labour across
    M1, M2 and M3.
  adr_refs:
  - adr-remote-correspondence-identity-carrier
  contract_refs:
  - contract-seam-carried-identity
  - contract-cross-source-rename-validation
- decision_input_ref: decision-input-renamepair-has-no-identity-field
  disposition: The historical question is closed by decision rather than by evidence.
    No commit, ADR or design clause states the omission as intentional; the ADR now
    records that the FS contract carries identity, so the provenance no longer gates
    anything and unknown-renamepair-identity-omission-intent is dissolved.
  adr_refs:
  - adr-remote-correspondence-identity-carrier
  contract_refs:
  - contract-seam-carried-identity
- decision_input_ref: decision-input-enrichment-is-self-satisfying
  disposition: 'Established by reading, made the design''s pivot, and now closed by
    measurement rather than carried as an assumption. completeIdentityEvidence fills
    a remote rename''s identity from the same two sources indexFacts builds current.remote
    from, so the guard compares a value to its own source; src/sync/plan-admission.test.ts
    drives five fixtures through the production entry and records exactly that at
    every one. Removing the enrichment for rename evidence is what makes the check
    real, and the claim that it loses nothing is now a recorded result: the only outcomes
    the fill changes are the two map-keying divergences the same file constructs,
    where what it produces is a conflicting_identity the world does not support. What
    the closure also costs the plan is recorded rather than hidden - the guard cannot
    admit a wrong operation today, so no clause rests on that any more.'
  adr_refs:
  - adr-remote-correspondence-identity-carrier
  contract_refs:
  - contract-evidence-identity-preservation
  - contract-cross-source-rename-validation
- decision_input_ref: decision-input-indexfacts-insert-is-a-different-selection
  disposition: Adopted as the limit on the previous input, and the limit is now measured
    at the capture boundary. identity-component-decision.ts:328-329 selects the prior
    entity when it has a hash and the incoming one does not, and the incoming entity
    otherwise — a different selection, not a stricter check — and it keys by entity.path
    where completeIdentityEvidence keys an entry's identity by entry.path at identity-evidence.ts:39.
    src/sync/plan-admission.test.ts constructs both divergences directly and records
    the guard failing with conflicting_identity and no actions for each, so the limit
    is real rather than hypothetical. Whether the Observation layer can emit either
    shape is still not established and is claimed neither way; what follows regardless
    is that the only failures the guard produces are manufactured by the enrichment,
    which is why the removal is lossless and why the divergence case must stay in
    the file to keep the cannot-fail claim bounded to the population it is true of.
  adr_refs:
  - adr-remote-correspondence-identity-carrier
  contract_refs:
  - contract-positional-mechanism-evidence
  - contract-evidence-identity-preservation
- decision_input_ref: decision-input-dropbox-extractid-total-fallback
  disposition: Decisive, and it fixed the contract's wording. Lifting the cache's
    id would carry Dropbox's path_lower pseudo-identity into a rename pair on the
    shared full-scan route, where it can never equal any FileEntity.identityKey and
    would fail every such rename closed, stalling the component forever. contract-seam-carried-identity
    is written against the entity projection, names extractId, idAt, getPathById and
    snapshotPathsById as forbidden sources, and carries the adversarial witness that
    asserts the two values differ for an id-less Dropbox entry — which is the structural
    half a separate projection-source contract used to hold. That contract was removed
    as uncompelled by the minimality audit, since the helper is concrete over the
    already-public abstract toEntity and forces no new member on any subclass; its
    outcome survives in the seam contract and in contract-cross-family-identity-conformance,
    and its discretion moved to the seam contract. extractId remains legitimate as
    the cache-internal total address function it is.
  adr_refs:
  - adr-remote-correspondence-identity-carrier
  contract_refs:
  - contract-seam-carried-identity
  - contract-cross-family-identity-conformance
- decision_input_ref: decision-input-renameevidencekey-omits-identity
  disposition: Adopted as a latent defect to close in the same change. renameEvidenceKey
    at identity-evidence.ts:22-24 omits identityKey while selectReportFamily's own
    unique map already includes report.identityKey ?? "", so the upstream dedupe is
    what makes the downstream arbitration dead. Without the repair, once producers
    carry keys, Map.set last-wins silently drops one of two conflicting claims on
    one edge and a wrong rename is admitted.
  adr_refs:
  - adr-remote-correspondence-identity-carrier
  contract_refs:
  - contract-evidence-identity-preservation
- decision_input_ref: decision-input-selectreportfamily-identity-checks-unreachable
  disposition: Established by reading and used as the safety argument, with the correction
    that reachability also requires the dedupe repair. edgesByIdentity and identitiesByEdge
    cannot fire today because one enrichment pass yields at most one key per newPath
    and two edges sharing a newPath are already conflicting via sourcesByTarget. Producer-carried
    identity plus an identity-bearing dedupe key makes them reachable, and they only
    ever tighten, so no widening risk is introduced.
  adr_refs:
  - adr-remote-correspondence-identity-carrier
  contract_refs:
  - contract-cross-source-rename-validation
  - contract-evidence-identity-preservation
- decision_input_ref: decision-input-adr-0008-missing-keys-no-evidence
  disposition: Binding, and it is why the report.identityKey guard keeps its shape.
    ADR 0008 Decision section 2 has three states and missing keys provide no evidence
    is the third; requiring an identity on every remote rename would encode absence
    of evidence as evidence of conflict against an accepted ADR and would stall Dropbox's
    unsettled id-less case. What changes is the source of the key, not whether it
    is required. This rule is about cycle-local rename evidence only and does not
    discharge the record layer's discipline.
  adr_refs:
  - adr-remote-correspondence-identity-carrier
  - adr-record-identity-floor-tolerated
  contract_refs:
  - contract-cross-source-rename-validation
- decision_input_ref: decision-input-adr-0006-order-independence
  disposition: Binding and treated as a preserved contract. The seam change touches
    only what is reported, never apply ordering, descendant enumeration or the reclaim
    guard, and the existing both-orderings cases in the shared caching contract are
    the regression stop.
  adr_refs:
  - adr-remote-correspondence-identity-carrier
  contract_refs:
  - contract-cross-family-identity-conformance
  - contract-seam-carried-identity
- decision_input_ref: decision-input-dropbox-tombstone-positional-guard
  disposition: Binding and untouched. The upsertedPaths reclaim guard keys on path
    because a Dropbox tombstone carries no id; an identity-keyed guard is unconstructible,
    not merely worse. Nothing in this design changes it, and Dropbox's eighteen path-derived
    topology sites stay path-derived because extractParentIds returns an empty array
    unconditionally.
  adr_refs:
  - adr-remote-correspondence-identity-carrier
  contract_refs:
  - contract-seam-carried-identity
- decision_input_ref: decision-input-local-side-no-identity
  disposition: Binding and made an explicit contract rather than an omission. The
    local endpoint of every correspondence stays positional permanently; neither half
    of this change reaches it, no local identity is invented or inferred, and the
    change states what it does not improve — the missed local rename event and the
    cross-scope local rename — where a reader will find it.
  adr_refs:
  - adr-remote-correspondence-identity-carrier
  contract_refs:
  - contract-local-positional-boundary
- decision_input_ref: decision-input-aliasfolder-is-report-free
  disposition: Settled by reading, closing one of the recovery's four open sub-questions.
    aliasFolder reads only local alias observations and current occupancy; no remote
    identity can produce or replace a local casing alias, so it is not an identification
    mechanism and is unchanged. The eighth part of the residual-obligation unknown
    is the only one reading could not close, and it is measured instead.
  adr_refs:
  - adr-remote-correspondence-identity-carrier
  contract_refs:
  - contract-positional-mechanism-evidence
- decision_input_ref: decision-input-required-contract-matrix
  disposition: Adopted as the placement rule. The seam guarantee is asserted in the
    shared caching contract inside the central composition root so it binds all three
    families at once and a missing cell stays a compile error; no case is registered
    elsewhere and no registry fixture is extended except for backend-specific construction
    data.
  adr_refs:
  - adr-remote-correspondence-identity-carrier
  contract_refs:
  - contract-cross-family-identity-conformance
- decision_input_ref: decision-input-shared-rename-cells-and-harnesses
  disposition: Adopted as a grounding correction. The rename cells are caching-remote-fs.contract.ts:297-360
    with object literals at :314, :333 and :351-356 that break the instant RenamePair
    gains a field; remote-change-detection.contract.ts contains no rename content
    at all and stableIdentity is an option of ifilesystem.contract.ts:42,157. The
    three caching-remote-fs.contract-harness.ts registrations are named in unit-7's
    file list so the widening is costed at design time rather than discovered at build
    time, and the literals are updated rather than loosened.
  adr_refs:
  - adr-remote-correspondence-identity-carrier
  contract_refs:
  - contract-cross-family-identity-conformance
- decision_input_ref: decision-input-agents-two-publication-points
  disposition: Binding and unchanged. Carried identity lives only in the cycle's evidence
    and is discarded with it; the store's DataError and ConstraintError refusals are
    raised and not persisted; no third durable authority, no new persistent-store
    owner and no retained in-memory correctness owner is added, and the measurement
    unit records nothing durable either.
  adr_refs:
  - adr-remote-correspondence-identity-carrier
  - adr-record-identity-uniqueness-mechanism
  contract_refs:
  - contract-seam-carried-identity
  - contract-record-identity-uniqueness
- decision_input_ref: decision-input-record-store-enforces-only-path-uniqueness
  disposition: Adopted as the store half's justification, answered by the key rather
    than by an observation, and narrowed after measurement. Nothing observes identity
    uniqueness across records today, so two baselines may claim one provider object;
    bindFiles binds the first and occurrenceClaimed silently drops the second. The
    further step the plan asserted - that the dropped address then falls through to
    a confirmed-deletion binding that deletes a live local file - is analytical and
    is withdrawn as an established claim, because identity-component-decision.ts:568-569
    refuses delete_local without a provider-reported deletion at that address and
    no measurement produces the destructive outcome; the one wrong-operation candidate
    driven end to end, a local deletion under a substituted path in record-rekey-across-commit.test.ts,
    yields conflict rather than delete_remote. Neither the seam nor the version bump
    closes the two-baseline state. Making remoteIdentityKey the store's key makes
    it unrepresentable rather than merely observed, which is claimed as a structural
    result, so no refusal, no named duplicate-identity error and no holder pre-read
    is built.
  adr_refs:
  - adr-record-identity-uniqueness-mechanism
  contract_refs:
  - contract-record-identity-uniqueness
- decision_input_ref: decision-input-same-transaction-pre-read-is-atomic
  disposition: Correct, and no longer needed. The measurement stands — a read issued
    from the failing put's onerror cannot complete because the transaction is already
    aborting, while an index read issued before the put inside the same readwrite
    transaction completes and returns the holder, since IndexedDB serialises readwrite
    transactions over a store — and it corrected draft-2's rejection of application-level
    checking. But it existed to let a duplicate-identity refusal name the record already
    holding the identity, and under keyPath remoteIdentityKey there is no such refusal
    and no such holder. The pre-read is retired unbuilt, contract-record-identity-uniqueness
    forbids re-adding it, and the store declines to represent the state rather than
    arbitrating it.
  adr_refs:
  - adr-record-identity-uniqueness-mechanism
  contract_refs:
  - contract-record-identity-uniqueness
- decision_input_ref: decision-input-relocation-order-is-load-bearing
  disposition: Adopted, then superseded by the key shape and replaced with an obligation
    of the same kind. Under a unique identity index, delete-before-put was what made
    a folder rename publishable at all. Under keyPath remoteIdentityKey the delete
    disappears, because each relocation is an in-place update of one row, and what
    is load-bearing instead is which sets may be admitted. contract-record-identity-uniqueness
    states the admission rule, and a verification pins it, so a future caller that
    needs an overlapping or cyclic set fails a named test instead of aborting in production.
  adr_refs:
  - adr-record-identity-uniqueness-mechanism
  contract_refs:
  - contract-record-identity-uniqueness
- decision_input_ref: decision-input-merge-base-discarded-by-method-body
  disposition: Adopted as a defect to repair, and still detached from the key choice.
    compareAndMove at state.ts:132-133 and compareAndRewritePaths at :186-187 delete
    sync-content at both addresses unconditionally on CAS success where compareAndPut
    at :104-108 applies a predicate, so every rename destroys the three-way merge
    base and conflict-resolver.ts:135 falls through to newer-mtime-wins. One correction
    to the attribution — commitAction's folder branch returning before maybeStoreMergeBase
    is correct, because a folder has no content, so the repair lands in the CAS bodies
    only. What the key shape supplies for free is the carry, because sync-content
    is keyed by identity and a relocation does not move the row; what it threatens
    is the predicate, which must survive compareAndMove's collapse into compareAndPut
    rather than being carried across as that method's unconditional deletes. The predicate
    repair is owed under any shape and is not counted as a payoff of this one.
  adr_refs:
  - adr-record-identity-uniqueness-mechanism
  contract_refs:
  - contract-merge-base-survives-relocation
- decision_input_ref: decision-input-relocation-terminal-is-a-source-spread
  disposition: Rejected the graft it was offered to support, with the witness, and
    then load-bearing for the key shape. state-committer.ts:104-105 builds each terminal
    as a spread of its source with only path changed, so a terminal's remote identity
    is its source's identity by construction at the only production caller. Under
    keyPath remoteIdentityKey that spread is why a relocation is an in-place field
    update of one row rather than a key change, which is what collapses compareAndMove
    into compareAndPut and what makes the source delete disappear. Identity injectivity
    across terminals reduces to identity injectivity across sources, which the key
    makes unrepresentable, so a store-level identity-preservation check would be structure
    with no reachable failure behind it and is not added.
  adr_refs:
  - adr-record-identity-uniqueness-mechanism
  contract_refs:
  - contract-record-identity-uniqueness
  - contract-merge-base-survives-relocation
- decision_input_ref: decision-input-rewritepaths-uncalled-no-cas
  disposition: Position taken — remove it. Zero callers in src/, no compare-and-swap,
    and a put that silently overwrites whatever occupies the destination address,
    which is a sanctioned route to the exact mis-operation this change exists to remove;
    its documented role at docs/sync-pipeline.md:304 was taken over by compareAndRewritePaths.
    Under the chosen key it is additionally incoherent, since it rewrites a field
    that is no longer the key while leaving the row it should have moved untouched,
    and its content-carry at :216-222 is not a mechanism the merge-base repair reuses
    but one the identity key makes unnecessary. Measured alongside it — SyncStateStore.put
    and putContent also have zero production callers — is recorded and deliberately
    not acted on; they are re-expressed with the rest of the surface, and correcting
    the same doc section removes the only named route to them, so removing them would
    be structure-reduction without a named failure.
  adr_refs:
  - adr-record-identity-uniqueness-mechanism
  contract_refs:
  - contract-record-identity-uniqueness
- decision_input_ref: decision-input-backendmeta-never-interpreted
  disposition: Position taken — remove it from SyncRecord only. Measured — one writer
    at state-committer.ts:43, the type declaration, and hot-warm-promotion.ts:43 merging
    the entity's field, not the record's; no production reader. The identifying half
    of its contents duplicates the correspondence key. Reversal condition recorded
    as a named production reader of SyncRecord.backendMeta.
  adr_refs:
  - adr-record-identity-uniqueness-mechanism
  contract_refs:
  - contract-record-field-audit
- decision_input_ref: decision-input-owner-decision-3-persist-only-underivable
  disposition: Applied field by field rather than to one field. Nine fields are kept
    with a stated reason and one is removed; syncedAt is kept as underivable although
    no production reader was found, and that observation is recorded and carried to
    consultation rather than acted on.
  adr_refs:
  - adr-record-identity-uniqueness-mechanism
  contract_refs:
  - contract-record-field-audit
- decision_input_ref: decision-input-owner-decision-4-version-bump-cold-start
  disposition: Binding and not re-litigated, with its reach corrected. The bump is
    the only place a keyPath or an index can be declared, and the existing onUpgrade
    drop-and-recreate is the whole upgrade. What it does not do is retire the positional
    fallback at identity-component-decision.ts:408-410 — that is the key's doing,
    not the bump's, because buildSyncRecord has no floor of its own and would otherwise
    re-mint the class. The plan says so explicitly rather than crediting the bump
    with a closure it does not give. The standing cold-start cost is not specific
    to this change and is not re-costed.
  adr_refs:
  - adr-record-identity-uniqueness-mechanism
  - adr-record-identity-floor-tolerated
  contract_refs:
  - contract-record-identity-uniqueness
  - contract-record-identity-floor-disposition
- decision_input_ref: decision-input-agents-no-migration
  disposition: Retained without amendment. The existing onUpgrade drop-and-recreate
    is the whole upgrade; no transform is written and no proposal to preserve sync-content
    across the bump is entertained. Preserving the merge base across a rename is a
    method-body policy, not a migration, and is a separate matter.
  adr_refs:
  - adr-record-identity-uniqueness-mechanism
  contract_refs:
  - contract-record-identity-uniqueness
  - contract-merge-base-survives-relocation
- decision_input_ref: decision-input-adr-0001-cache-commits-last
  disposition: Retained and extended by one sentence. The record store's new key and
    its unique path index are storage mechanism subordinate to commit-last, not an
    identity policy owner — the store declines to represent a state rather than deciding
    between claimants, and the path index guards a guarantee the filesystem layer
    owes rather than a policy this layer sets. Identity policy stays confined to identity-component-decision.ts,
    and sync-admission-authority-guard.test.mjs staying green with no fixture edit
    is the machine proof of that. The ADR sentence and the accompanying enforcement-document
    correction are carried by unit-6 as hygiene consequent on the store surface change,
    not as an obligation AGENTS.md:71-73 imposes; that clause binds an intentional
    new writer, owner or field, and removing two dead detector names is neither.
  adr_refs:
  - adr-record-identity-uniqueness-mechanism
  contract_refs:
  - contract-record-identity-uniqueness
- decision_input_ref: decision-input-no-operator-signal-on-main
  disposition: 'Adopted as a constraint on every observable this plan asserts, with
    one claim withdrawn as measured false. Logger.enabled and src/sync/sync-cycle-diagnostics.ts
    are not on main, and DEFAULT_SETTINGS.enableLogging and showSyncNotifications
    are both false, so no requirement or witness here depends on a log line or a notice;
    every asserted observable is a cycle outcome, and a stalled component is silent
    to the user and shows only as work not progressing. The previous revision went
    one step further and said the path index''s constraint classification "is the
    only diagnosable trace a violated fs premise leaves". That is false as the code
    stands: idb-helper.ts:142 registers tx.onerror before tx.onabort and the transaction''s
    error attribute is only set during the abort steps, so the onerror rejection wins
    the race with tx.error still null and IDBTransactionError.domName is null for
    every aborted transaction, not only for a constraint violation. Measured against
    the repository''s own fake-indexeddb: request.onerror ConstraintError, tx.onerror
    null, tx.onabort ConstraintError, rows unchanged. So the diagnosable trace is
    not the name but the shape — a thrown transaction failure from a CAS method that
    never returns false for it, an action that fails, and a checkpoint that stays
    uncommitted — and that is what this plan asserts. The helper defect is independently
    repairable with a blast radius of both persistent stores; it is recorded as open
    question 5, is not repaired by this change, and is not worked around at any call
    site.'
  adr_refs:
  - adr-record-identity-uniqueness-mechanism
  contract_refs:
  - contract-record-identity-uniqueness
  - contract-cross-source-rename-validation
- decision_input_ref: decision-input-owner-decision-5-path-uniqueness-is-upstream
  disposition: Binding, and applied by rejecting a frame rather than by answering
    a question. The owner's authority delta states that trying to hold several records
    at one path is the mistake, that path may simply be a unique constraint, and that
    fs owes the sync engine object-path uniqueness. Four things follow and all four
    are applied. First, adr-record-key-shape resolves to keyPath remoteIdentityKey
    with a unique index over path, and its status moves from reserved to accepted;
    the cost comparison that was reserved for the owner is retired as a decision input
    and survives only as this change's work inventory. Second, the unique path index
    is a guard on a broken upstream and not a policy mechanism — it aborts rather
    than replaces, its ConstraintError is a defect signal, it is never mapped onto
    the ordinary stale-baseline false, and each CAS method compares the target address
    itself so the index is only reachable when the premise is false. Third, the premise
    that fs guarantees object-path uniqueness is stated explicitly under scope with
    its owner named — issue
  adr_refs:
  - adr-record-key-shape
  - adr-record-identity-uniqueness-mechanism
  - adr-record-identity-floor-tolerated
  contract_refs:
  - contract-record-identity-uniqueness
  - contract-record-identity-floor-disposition
  - contract-record-field-audit
  - contract-merge-base-survives-relocation
- decision_input_ref: decision-input-owner-decision-2-identity-keyed
  disposition: Read literally, as owner decision 5 says it always should have been.
    The decision fixes that the remote side of the correspondence is identified by
    provider object identity with path as a persisted field carrying a secondary index.
    The plan previously read it for its observable content, offered a unique index
    as an equivalent realization, and reserved the choice; the owner's authority delta
    confirmed the literal reading and rejected the frame that made the two look interchangeable.
    sync-records now uses keyPath remoteIdentityKey with a unique index over path,
    and adr-record-key-shape is accepted rather than reserved.
  adr_refs:
  - adr-record-key-shape
  contract_refs:
  - contract-record-identity-uniqueness
- decision_input_ref: decision-input-keypath-replacement-probe-withdrawn
  disposition: Withdrawn as a blocker and still not replaced by a substitute defect,
    with one residue relocated to where it is real. The probe wrote one identity at
    two paths, which is one object that moved and whose record correctly updates.
    Under the chosen key the replacement it described is genuine in exactly one case
    — two entities carrying an empty-string identity would fold into one row, because
    an empty string is a valid key — and contract-record-identity-floor-disposition
    refuses an empty identity rather than storing it. Nothing else in this plan is
    justified by the probe.
  adr_refs:
  - adr-record-key-shape
  contract_refs:
  - contract-record-identity-uniqueness
- decision_input_ref: decision-input-path-addressed-call-site-inventory
  disposition: Re-measured from the repository rather than inherited. It was presented
    to the owner as the costing artifact and was explicitly not allowed to decide
    the shape; the owner decided on other grounds, so it is now this change's work
    inventory. Production has 21 SyncStateStore call sites; 17 address a row by the
    primary key and are re-expressed — address-asking reads through the path index,
    row-addressing writes by identity — while getAll at change-detector.ts:84, :96
    and :104 and clear at orchestrator.ts:95 are key-agnostic and do not change. Inside
    state.ts six mutating methods are rewritten plus get, getMany, getContent and
    putContent, and compareAndMove ceases to exist.
  adr_refs:
  - adr-record-key-shape
  contract_refs:
  - contract-record-identity-uniqueness
- decision_input_ref: decision-input-getmany-is-a-primary-key-lookup
  disposition: Adopted as the correction that made the inherited table unusable as
    is, and now as work. SyncStateStore.getMany at state.ts:61-76 issues store.get(p)
    per path, so change-detector.ts:147 and :180 are primary-key lookups and not record.path
    field reads, and the conclusion that three sites need nothing is false; both move
    to the path index. One further correction the critique did not make is carried
    with it — getAll is neither a field read nor a key lookup, because it returns
    every value regardless of keyPath.
  adr_refs:
  - adr-record-key-shape
  contract_refs:
  - contract-record-identity-uniqueness
- decision_input_ref: decision-input-conflict-resolver-reads-content-by-path
  disposition: Adopted as a consumer-disposition correction and now discharged. conflict-resolver.ts:135
    calls getContent(ctx.baselinePath ?? ctx.path), a by-path read of the content
    store, so draft-1's listing of it as needing no change was wrong. sync-content
    is re-keyed with sync-records, so getContent takes the identity and this one caller
    supplies it from the baseline record it already holds — the expression is guarded
    by ctx.baseline && and baseline is typed SyncRecord at conflict-resolver.ts:21
    — and stops consulting ctx.baselinePath there. The content store gains no path
    index, because nothing reads a merge base by address afterwards.
  adr_refs:
  - adr-record-key-shape
  contract_refs:
  - contract-merge-base-survives-relocation
- decision_input_ref: decision-input-relocation-overlap-under-inversion
  disposition: Live, and discharged by refusing the class rather than ordering it.
    Injectivity in addresses and in identities does not imply the terminal address
    set is disjoint from the source address set, and under identity keying the store.delete(item.source.path)
    that makes today's order safe is gone — source and terminal are one row — so an
    overlapping set aborts in one put order and completes in the reverse while a cyclic
    set has no safe order without a temporary. contract-record-identity-uniqueness
    extends compareAndRewritePaths' existing non-injectivity refusal at state.ts:167-169
    with one more admission condition of the same shape — any item's terminal address
    equalling a different item's source address publishes nothing and returns false,
    and self-overlap is admitted because it is one row whose address does not change.
    Ordering is not added, because the only production caller cannot construct either
    class — all sources share the old folder prefix, all terminals the new one, and
    a folder cannot be renamed into its own subtree — so ordering would be structure
    with no reachable failure behind it, the same test that rejected the folder-relocation
    identity graft.
  adr_refs:
  - adr-record-key-shape
  contract_refs:
  - contract-record-identity-uniqueness
- decision_input_ref: decision-input-dropbox-entry-without-id-unsettled
  disposition: Kept on record with its settling observation — the Dropbox list_folder
    contract text plus one opt-in e2e raw page dump — and re-pointed at what it actually
    is under the chosen key — a precondition of the store shape rather than a sizing
    question, and no longer a gate on any decision here. Measurement bounds its expected
    population to empty — DropboxEntry.id is optional only because the same type covers
    deleted tombstones, whose doc comment says they are never cached and which buildFromFiles
    skips at dropbox/metadata-cache.ts:148, while googledrive/types.ts:25 and onedrive/types.ts:20
    declare id as a required string. contract-record-identity-floor-disposition is
    total either way and asserts the id-less outcome by test rather than assuming
    it unreachable. The unknown still gates whether a remote folder rename may ever
    require an identity, which stays out of scope.
  adr_refs:
  - adr-record-key-shape
  - adr-record-identity-floor-tolerated
  contract_refs:
  - contract-record-identity-floor-disposition
  - contract-record-identity-uniqueness
- decision_input_ref: decision-input-dropbox-refusal-creates-the-harm
  disposition: Withdrawn as a mitigation, restated by its real outcome, and still
    honoured under the floor. Refusing an id-less entity at the Dropbox boundary does
    not avoid the unbaselinable object, it creates one and additionally removes it
    from listings, because decision-engine.ts:8-21 puts delete_local, delete_remote
    and cleanup all under if (prevSync). Nothing in this plan does that — the refusal
    is at the baseline, not at the backend boundary, so an id-less entity stays listed,
    compared and conflict-resolvable and only fails to acquire a durable record. That
    narrower consequence is named in contract-record-identity-floor-disposition and
    asserted by test, and no requirement here depends on the unknown resolving a particular
    way.
  adr_refs:
  - adr-record-identity-floor-tolerated
  - adr-record-key-shape
  contract_refs:
  - contract-record-identity-floor-disposition
- decision_input_ref: decision-input-buildsyncrecord-has-no-identity-floor
  disposition: Adopted as the correction to the version bump's stated reach, and inverted
    by owner decision 5. buildSyncRecord at state-committer.ts:42 copies remote?.identityKey
    with no floor of its own, so the bump alone would re-mint the identity-less class.
    Under keyPath remoteIdentityKey the class is unstorable — SyncRecord.remoteIdentityKey
    becomes required, the positional fallback at identity-component-decision.ts:408-410
    stops type-checking and is removed, and the publication path refuses an entity
    that cannot supply an identity with a named error before any store write. The
    consequence for that entity is stated and tested rather than tolerated, and it
    is still not restated as a rule that fails a rename report.
  adr_refs:
  - adr-record-identity-floor-tolerated
  contract_refs:
  - contract-record-identity-floor-disposition
- decision_input_ref: decision-input-identityless-class-is-bounded-to-dropbox
  disposition: Established by reading the three wire types, then sharpened by one
    further measurement and used to size the floor's failure branch rather than to
    bound a tolerated class. googledrive/types.ts:25 and onedrive/types.ts:20 declare
    id as a required string; dropbox/types.ts:23 declares id as optional only because
    the same type also covers deleted tombstones, whose own doc comment says they
    are never cached and which buildFromFiles skips at dropbox/metadata-cache.ts:148.
    Every cached entry of all three families therefore carries a provider id, so the
    floor's refusal branch is expected to be unreachable in production — which is
    why it is asserted by test rather than designed around.
  adr_refs:
  - adr-record-identity-floor-tolerated
  contract_refs:
  - contract-record-identity-floor-disposition
- decision_input_ref: decision-input-empty-string-is-an-index-key
  disposition: Adopted, and its mechanism inverted with the key. Normalizing an empty
    identity to absent was correct when an absent property meant skipped by a unique
    index. Under keyPath remoteIdentityKey an absent property is a DataError and an
    empty string is a perfectly valid key that would silently fold two entities into
    one row — the only place the withdrawn replacement probe describes something real.
    The single construction path therefore refuses both as one inadmissible case,
    and fr-rik-007 states that the field ranges over non-empty strings only. This
    answer is deliberately not exported to the rename-evidence dedupe key, which must
    keep a carried, an absent and an empty key distinct; the two layers ask different
    questions and the plan no longer claims one answer serves both.
  adr_refs:
  - adr-record-identity-floor-tolerated
  contract_refs:
  - contract-record-identity-floor-disposition
  - contract-evidence-identity-preservation
- decision_input_ref: decision-input-warm-escalation-covers-hot-miss
  disposition: Costed and the resulting mechanism excluded, with one caveat carried.
    A by-identity record read was considered and rejected, because rename evidence
    already contributes oldPath to the HOT fetch set and an unreported move leaves
    a component with a current occurrence and no prevSync, which needsWarmComponentAcquisition
    escalates to a full getAll. The caveat neither draft carried — CurrentFacts.records
    is rebuilt per cycle from MixedEntity.prevSync and never read from the store inside
    Admission, but candidateFacts[].baseline is store-derived via getMany at change-detector.ts:147,
    so the no-store-read statement is true of the first and not the second.
  adr_refs:
  - adr-record-identity-uniqueness-mechanism
  contract_refs:
  - contract-record-identity-uniqueness
- decision_input_ref: decision-input-scaffold-lists-deleted-rename-debt
  disposition: Checked and found to need no correction. src/sync/rename-debt.ts and
    adr-20260902-rename-identity-evidence-model.md are both absent from the repository,
    but neither appears in the change package's source_paths; the stale references
    live in recovery-scope.json's seed refs, which is not a change-package artifact.
    No unit owns a correction because none is owed, and the observation is recorded
    so the question is not reopened.
  adr_refs:
  - adr-record-identity-uniqueness-mechanism
- decision_input_ref: decision-input-issue90-cache-bijection-scaffold
  disposition: Kept separate and not merged, and now also named as the owner of this
    change's stated premise. The issue-90 direction owns the derived metadata cache's
    path-to-id bijection and its own change package, and owner decision 5 makes it
    the owner of the filesystem layer's object-path-uniqueness guarantee — a provider
    that permits two objects at one name resolving that below the IFileSystem seam,
    by provider rename, before the sync engine observes it. This change is entitled
    to assume that guarantee, says so explicitly under scope, designs none of it,
    and guards it with a unique path index whose violation is a defect signal rather
    than a branch. This direction owns the durable correspondence and the FS seam;
    the only overlap is the rename pair's shape, and this plan adds one optional field
    without widening getChangedPaths' result type, touching RenameAction, or adding
    an Admission stage.
  adr_refs:
  - adr-record-identity-uniqueness-mechanism
  contract_refs:
  - contract-seam-carried-identity
- decision_input_ref: decision-input-owner-decision-6-ordering-retirement-and-floor
  disposition: Binding, and applied by correcting a decomposition rather than by adding
    a mechanism. The owner's three clauses settle the three blockers the independent
    plan attack returned against the shape-(A) plan, and each is applied as stated.
    6a - an empty identity is impossible, because a SyncRecord is only written after
    the remote side is settled, so the floor is buildSyncRecord's own and must fail
    loudly, naming the entity, across all three production callers in two files; the
    plan's claim that the positional fallback is retired because its arm stops type-checking
    is withdrawn as measured false and replaced with retirement by absent population,
    verified by a construction test. 6b - a SyncRecord is no longer authoritative
    for the address it records once the object it names has left that address; the
    open point the owner required be settled is settled by owner decision 8a, which
    generalises 6b into the record model itself, because the literal "a path the vault
    no longer manages" reading does not reach the attack's witness, where row Z carries
    path B.md and B.md is still managed locally as the move's terminal. Under 8a the
    record is the correspondence, so the correspondence at that address ended when
    the address became another object's, and the claiming publication observes that
    end directly rather than inferring anything about object Z. 6c - the constraint
    violation is not a third problem, and the first reading of this decision, which
    proposed a separate issue with a convergence strategy, was rejected by the owner
    for treating a symptom as a new problem without first checking whether an already-assigned
    upstream guarantee closes it. What this change therefore owes is the replacement
    operation of owner decision 8b - delete the incumbent and insert the terminal
    in one transaction - and not a publication order, which owner decision 8 removed
    along with the evidence rule it served; no convergence strategy, retry, recovery
    path, recovery marker, queue or ordering pass is added, nothing is pushed to the
    executor, and the unique path index stays the pure defect signal owner decision
    5 framed it as.
  adr_refs:
  - adr-record-identity-uniqueness-mechanism
  - adr-record-key-shape
  - adr-record-identity-floor-tolerated
  contract_refs:
  - contract-record-identity-uniqueness
  - contract-record-identity-floor-disposition
- decision_input_ref: decision-input-owner-decision-7-hard-constraint-and-evidence-retirement
  disposition: 'Binding in part, and superseded in part by owner decision 8. 7a stands
    and is applied: keyPath remoteIdentityKey and the unique path index both stay,
    and the proposal to drop the index is rejected, because facts.records is keyed
    by prevSync.path at identity-component-decision.ts:353 and Admission looks up
    the record for this path, so SyncRecord.path is which local file a record is the
    correspondence for and two such rows are a contradiction; a real filesystem resolves
    the contention by silently letting the last writer win and a durable store of
    correspondences must refuse. 7b and 7c are superseded outright. 7b asked for evidence
    that an incumbent''s object is gone before its row could be retired, and 7c made
    the absence of that evidence a fail-closed component. Owner decision 8a dissolves
    the question both were answering rather than answering it differently: a SyncRecord
    records a correspondence, not the object''s existence, so a correspondence whose
    address now belongs to another object has ended - and that end is directly observed,
    because the new object is at the address now. No death evidence is required, ADR
    0008 is not engaged, and the whole apparatus 7b and 7c motivated is removed rather
    than re-contented: the four-way classification, the checkpoint_deleted conjunct,
    currentByIdentity as a retirement input, the analysis of what Admission does not
    hold, the fail-closed disposition, the convergence narrative, the relocating-first
    ordering, the claimer-expects-vacant expectation change and the address-permutation
    refusal. What replaces them is the operation of owner decision 8b - a replacement
    deletes the incumbent and inserts the terminal in one transaction, a rename is
    a single put - stated in contract-record-identity-uniqueness. Two measurements
    drive what survives and are folded into the verification surface rather than described:
    plan-admission.test.ts, which settles that the guard cannot fail on any shape
    Observation emits and that the change may not be justified on it, and record-rekey-across-commit.test.ts,
    whose split-cycle end state is the one owner decision 8a prescribes, and which
    unit-4 must re-price so that the case asserts it deliberately rather than as a
    defect.'
  adr_refs:
  - adr-record-key-shape
  - adr-record-identity-uniqueness-mechanism
  contract_refs:
  - contract-record-identity-uniqueness
  - contract-positional-mechanism-evidence
- decision_input_ref: decision-input-displaced-incumbent-is-implicit-under-path-keying
  disposition: 'Established by measurement and made the whole basis of the replacement
    operation''s minimality. Every publication route on main displaces the record
    occupying the destination address by overwriting its key, and three of them are
    live - identity-component-decision.ts:509-511 and :549-551 build a same-address
    replacement publication whose liveness follows from state.ts:104-106 invalidating
    the merge base on exactly expected.remoteIdentityKey !== record.remoteIdentityKey;
    src/sync/state.test.ts:250-261 moves object X onto an address row Z still holds
    and asserts the move succeeds; and identity-component-decision.ts:719 carries
    a captured foreign destination outside the relocation set, which state.ts:181-183
    compares and today''s store.put displaces. Under keyPath "path" that displacement
    is free and invisible at state.ts:101-103; under keyPath remoteIdentityKey the
    displaced row survives the write, keeps its old path and holds the unique path
    index. The consequence taken is that (A) creates no new obligation at all: the
    discard is exactly the one today''s put already performs, and what changes is
    that it must now be written as a delete inside the claiming action''s own transaction,
    after the incumbent has been compared. That is the whole reason the unique path
    index earns its keep - it converts a silent side effect of the key into an admitted,
    compared and asserted operation. Under owner decision 8a no disposition falls
    outside that equivalence, so the previous revision''s priced behaviour change
    - a component failing closed and writing nothing where no evidence of the incumbent''s
    death existed - is withdrawn along with the rule that produced it. That is why
    no new durable authority, no second publication point, no reaper and no queue
    is introduced, and why the third scope-expansion signal the attack raised - that
    rows for retired identities would accumulate with no reclamation route - is resolved
    outright: every row whose address is claimed by a record for a different object
    is deleted by the claiming write, with its sync-content row under the same key,
    and no row is retained past the end of its correspondence.'
  adr_refs:
  - adr-record-identity-uniqueness-mechanism
  - adr-record-key-shape
  contract_refs:
  - contract-record-identity-uniqueness
- decision_input_ref: decision-input-cas-expectations-separate-under-identity-keying
  disposition: 'Adopted as the correction that closes the store''s outcome partition.
    Under keyPath "path" a single captured record served as both "the row this publication
    continues" and "the row holding this address", because they were the same row,
    which is why state-committer.ts:122 can pass publication.destination as compareAndPut''s
    only expectation. Under (A) they separate, and two representative implementations
    that both satisfied the previous wording diverged observably - addressing the
    row by record.remoteIdentityKey makes a replacement publication return false forever,
    addressing it by expected.remoteIdentityKey drives the write into the path index.
    The plan now states both expectations explicitly with no defaulted parameter,
    so compareAndMove''s inherited expected.path === record.path ? expected : undefined
    at state.ts:119 does not survive in any form, compareAndPut(undefined, record,
    undefined) keeps today''s vacancy check for a baseline-free create, and compareAndDelete
    with no expected record keeps today''s verified no-op. Which record fills each
    expectation is stated in the same contract, which also corrects :509-511''s and
    :549-551''s source: expected for a replacement publication, where the continued
    row is undefined and the incumbent is the destination.'
  adr_refs:
  - adr-record-key-shape
  - adr-record-identity-uniqueness-mechanism
  contract_refs:
  - contract-record-identity-uniqueness
- decision_input_ref: decision-input-idb-helper-loses-every-abort-name
  disposition: 'Measured, accepted, and used to remove a requirement rather than to
    add work. src/store/idb-helper.ts:139-143 registers tx.oncomplete, then tx.onerror
    = () => reject(new IDBTransactionError("error", tx.error)), then tx.onabort; per
    the IndexedDB error-bubbling order the transaction''s error attribute is only
    set during the abort steps, so the onerror rejection wins the race and domName
    is null. Re-measured independently here against the repository''s own fake-indexeddb
    with a keyPath remoteIdentityKey store and a unique path index: request.onerror
    ConstraintError, tx.onerror null, tx.onabort ConstraintError, store empty afterwards.
    This affects every aborted transaction, not only a constraint violation, so it
    is an ordinary helper defect and not a design question for this change - owner
    decision 6c says so explicitly. FR-RIK-006, contract-record-identity-uniqueness,
    AC-RIK-005, verify-duplicate-path-aborts-and-propagates and unit-4''s acceptance
    therefore drop the requirement that the failure name ConstraintError and assert
    what is observable instead: the write throws where a stale baseline returns false,
    nothing is written, the action fails and the cycle does not complete. The two
    repairs an implementer would reach for - catching the request-level error, re-parsing
    the message string - stay forbidden; discretion-cas-address-comparison-shape keeps
    its prohibition on touching idb-helper.ts, which is now consistent rather than
    contradictory, because the observable no longer needs the helper. The defect is
    recorded as open question 5 and is neither repaired nor worked around.'
  adr_refs:
  - adr-record-identity-uniqueness-mechanism
  contract_refs:
  - contract-record-identity-uniqueness
- decision_input_ref: decision-input-required-field-is-not-a-type-error
  disposition: 'Accepted as a falsification and applied by replacing the verification,
    per owner decision 6a. The claim that making SyncRecord.remoteIdentityKey required
    turns the positional arm at identity-component-decision.ts:408-410 into a type
    error was measured false: the empty string is falsy, so x ? A : B over x: string
    is a legal, unflagged condition, the exact shape compiles clean under this repository''s
    own tsc -noEmit -skipLibCheck --strict, and eslint.config.mts configures no @typescript-eslint/no-unnecessary-condition.
    npm run build therefore cannot discriminate whether the arm is present, so AC-RIK-012
    was unachievable and verify-positional-fallback-does-not-type-check was non-discriminating.
    Both are replaced. The arm is retired because the population it serves cannot
    exist - buildSyncRecord refuses an absent or empty identity - and that is asserted
    by verify-identityless-record-construction-fails, a test that fails when an identity-less
    record is constructed. The same false premise is removed from fr-rik-012, unit-5''s
    acceptance and adr-record-identity-floor-tolerated. The attack''s accompanying
    enumeration of other absence-branching sites is taken and extended by re-measurement,
    and disposed of under DP-6 by the distinction it blurred: an absent record stays
    possible and its optional chains are untouched, while an absent field does not
    and every test of it is removed, reduced or tightened, none repaired positionally
    and none folded to the empty string.'
  adr_refs:
  - adr-record-identity-floor-tolerated
  contract_refs:
  - contract-record-identity-floor-disposition
- decision_input_ref: decision-input-buildsyncrecord-has-three-callers-in-two-files
  disposition: 'Measured and made the floor''s placement rule, per owner decision
    6a. buildSyncRecord (state-committer.ts:33-46) is one function with three production
    callers in two files - state-committer.ts:119, opened-file-priority.ts:61 and
    :88 - and the two the previous revision did not name both write to the store,
    at opened-file-priority.ts:62 and :91. So a floor placed in commitAction leaves
    the priority path unguarded, and to keep the required field satisfiable an implementer
    taking that option must write remote?.identityKey ?? "" inside buildSyncRecord,
    which is exactly the fold fr-rik-007 forbids - meaning the discretion''s two permitted
    alternatives did not preserve the same observable. discretion-identity-floor-refusal-site
    now offers only representatives inside buildSyncRecord, scopes to both files,
    and unit-5''s file list carries opened-file-priority.ts. A second gap is closed
    with it: the contract''s unknown outcome no longer describes the priority path
    as a cycle action. It is not one - its outer try/catch at :37 and :116-123 ends
    a failed attempt with a warn, requestNormalLifecycle() and failed_retryable, and
    its inner baseline commit at :89-99 warns and defers - so the refusal takes that
    existing route, and the same entity reaches commitAction in the batch cycle where
    the cycle-level outcome applies.'
  adr_refs:
  - adr-record-identity-floor-tolerated
  contract_refs:
  - contract-record-identity-floor-disposition
- decision_input_ref: decision-input-required-field-binds-the-test-surface
  disposition: Accepted and priced, closing the asymmetry the attack named. tsconfig.json
    includes tests/**/*.ts as well as src/**/*.ts, so npm run build type-checks the
    whole test surface and a required non-empty field binds every SyncRecord construction
    in the repository. Re-measured on main at 60e85b0 - 27 files contain a SyncRecord
    literal, of which three are production, leaving 24 test and mock files; tests/fs/contracts/remote-change-detection.contract.ts
    calls buildSyncRecord at :64, :74 and :90; state.test.ts's makeRecord at :7-17
    omits the field entirely; and compareAndMove is referenced in five files, of which
    fact-first-execution.test.ts and plan-executor.test.ts appeared in no unit's file
    list while unit-4 required that nothing in src/ or tests/ reference it. The seam
    half priced exactly this blast radius through scope-signal-conformance-cell-rewrites-existing-assertions
    and the store half priced none of it. unit-5 now enumerates the record-literal
    surface and unit-4 the compareAndMove surface, the work inventory under approach
    carries a row for it, and scope-signal-required-field-binds-the-whole-test-surface
    records it. The unit boundary is the measured set plus any further file the compiler
    names, because the compiler is the reliable enumerator here.
  adr_refs:
  - adr-record-key-shape
  - adr-record-identity-floor-tolerated
  contract_refs:
  - contract-record-identity-floor-disposition
  - contract-record-field-audit
- decision_input_ref: decision-input-ownership-guard-second-fixture-consumer
  disposition: 'Accepted as a correction to a measurement this plan made and got wrong.
    The claim that MUTATING_SYNC_STATE_METHODS is "consumed at exactly one site, :199"
    is false: sync-state-ownership-guard.test.mjs:320 is a second, hardcoded consumer
    iterating the five compare-and-swap names and generating two negative-fixture
    tests per name, so once compareAndMove leaves the set at :9-12 both of its generated
    tests fail and npm run lint:bot-repro goes red. The claim is removed from DP-5,
    fr-rik-009 and nfr-rik-004. What survives, re-derived by hand here, is the load-bearing
    half: the four per-file inventories stay byte-identical - mutationCallers remains
    [opened-file-priority.ts, orchestrator.ts, state-committer.ts] because each still
    calls a method that remains in the reduced set, and imports, references and constructors
    are untouched - so this is detector hygiene and not the intentional new writer,
    owner or field AGENTS.md:71-73 binds the triple to, and the removal of contract-two-authority-enforcement-triple
    stands. unit-6 now prices the fixture edit at both sites and its tool_guidance
    is corrected, because it previously instructed the implementer to read a :320
    failure as evidence that a removed name was still load-bearing, which would be
    the opposite of the truth: only an inventory change is that evidence.'
  adr_refs:
  - adr-record-identity-uniqueness-mechanism
  contract_refs:
  - contract-record-identity-uniqueness
- decision_input_ref: decision-input-dropbox-idless-rename-is-case-only
  disposition: 'Accepted, and used to re-home a witness and re-ground a rejection
    rather than to drop either. Re-measured - on the delta route dropbox/incremental-sync.ts:158
    computes oldPath only when entry.id is truthy, so applyRename at :201 is unreachable
    for an id-less entry and no pair is pushed; on the full-scan route remote-fs.ts:416-421
    keys on extractId = entry.id ?? entry.path_lower, so for an id-less entry the
    surrogate key is the lowercased path and any path-changing rename changes it,
    missing oldPathById and surfacing as delete-plus-add. The one constructible shape
    is a case-only rename, where path_lower is stable while the cached display path
    changes. contract-seam-carried-identity''s adversarial witness was bound to verify-dropbox-delta-rename-carries-entry-id,
    a verification that runs incremental-sync.test.ts and therefore cannot host it;
    it moves onto the case-only full-scan shape and onto verify-fullscan-diff-carries-projected-identity,
    which runs remote-fs.contract.test.ts where diffById and idAt are both reachable,
    and the delta verification keeps a constructible id-bearing normal witness. DP-1''s
    rejection of option (a) is re-grounded rather than preserved: the decisive reason
    is that fr-rik-002 cannot be stated over extractId at all, because extractId''s
    own doc comment declares it a total address function, so any agreement with the
    entity projection would be coincidental rather than contractual; the stall survives
    at one-sub-case size and is now described at that size. unit-1''s acceptance is
    restated to match.'
  adr_refs:
  - adr-remote-correspondence-identity-carrier
  contract_refs:
  - contract-seam-carried-identity
  - contract-cross-family-identity-conformance
milestones:
- id: evidence
- id: seam
- id: evidence-carrier
- id: admission
- id: store
- id: enforcement
- id: conformance
reference_algorithms: []
---

<!-- lifecycle is owned by change.md -->

# Implementation

## Content

Eight units on two chains that can land in either order but must not be integrated concurrently.

| Unit | Chain | Depends on |
|---|---|---|
| 0 — the two measurements | evidence | — |
| 1 — the seam carries the identity | seam | — |
| 2 — evidence preservation | seam | 0, 1 |
| 3 — the cross-source validation | seam | 2 |
| 7 — cross-family conformance | seam | 1 |
| 5 — the record shape and the identity floor | store | 0 |
| 4 — the store re-key, the two operations, the merge base | store | 5 |
| 6 — the enforcement artefacts | store | 4, 5 |

**Unit 5 runs before unit 4.** That is a deliberate inversion of the numbering: the record type's
required identity and the construction floor have to land while the store is still keyed by `path`,
so no intermediate state ever declares a keyPath over an optional property — which would force a
non-null assertion or an empty-string fold at exactly the site this change exists to remove.

**`src/sync/identity-component-decision.ts` is touched by three units on the two chains** — unit 3
on the seam chain, units 5 and 4 on the store chain. Each chain lands whole before the other
starts. That is also what lets the two halves ship independently: the seam half changes nothing
persistent, and the store half needs nothing the seam half produces.

### Unit 0 — land the two measurements

*Files:* `src/sync/plan-admission.test.ts`, `src/sync/record-rekey-across-commit.test.ts`.
*Contract:* `contract-positional-mechanism-evidence`. *Depends on:* nothing.

Both files already exist in the working tree, changed no production file, and are this change's
evidence base. This unit lands them **unchanged in substance**; neither may be replaced by a
described equivalent, and no file under `src/` other than these two is modified.

`src/sync/plan-admission.test.ts` (+408 lines, six cases in one `describe` block) drives
`captureBatchObservation` into `admitBatchObservation` on unchanged production code for five
shapes, asserting by name the branch taken by `selectReportFamily`, `aliasFolder`,
`completeIdentityEvidence`'s `newPath` lookup and the identity guard at
`identity-component-decision.ts:105-107`:

1. a remote object renamed under an unchanged local file, baseline carrying an identity;
2. the same, baseline carrying **no** identity;
3. a remote object replaced at an address by a different id;
4. a rename whose evidence carries no identity;
5. a folder rename whose descendants are not re-emitted.

What it recorded: the guard **cannot fail on any fact shape today's Observation layer emits** —
either the `newPath` lookup hits, in which case the filled key equals the map it was read from, or
it misses and line 106's own precondition short-circuits the comparison. Shape 3 is admitted with a
`match`, not a wrong rename, because `indexFacts` and `bindFiles:420-421` discriminate it ahead of
the guard. Removing the positional enrichment is therefore lossless, measured rather than analysed.

The **sixth case pins the boundary of that answer** and may not be deleted or weakened: it
constructs the two divergences where the completion map and `current.remote` key one entity
differently — an entry addressed at one path carrying a remote endpoint resolved at another
(`identity-evidence.ts:39` keys by `entry.path`, `identity-component-decision.ts:349` by
`entry.remote.path`), and two remote observations at one address where the keyed one carries no
hash — and records `conflicting_identity` with no actions for both. Whether Observation can emit
either shape is **not** established, and this change claims neither that it can nor that it cannot.
The claim being bounded is a claim about a population, not about impossibility.

`src/sync/record-rekey-across-commit.test.ts` (508 lines, seven cases) drives the orchestrator's own
chain — `collectChanges` → `prepareSyncCycleSnapshotForExecution` → `admitBatchObservation` →
`executePlan` — over the real `SyncStateStore` on `fake-indexeddb`, with pass-through spies on the
durable publication routes. It records that the **same-cycle** baseline is preserved by
identity-keyed binding at `identity-component-decision.ts:408-409`, **not** by the store's key —
mutating `trackedRemote` to a path lookup kills it — and that the **split-cycle** baseline is not
retained: the old row is discarded and the object is re-downloaded as new. No wrong-object
operation occurs in either shape (`decision-engine.ts:19` yields `conflict`, never
`delete_remote`). Under the record model that second result is **correct and expected**, so the
cases assert it deliberately as the model's end state rather than as a defect awaiting repair.

*Boundaries.* Change no production file. Retire, relax or reroute no positional mechanism. Add no
`AdmissionFailureReason` member. Do not assert on internal helpers reached outside
`admitBatchObservation` — that would not answer the unknown. Do not adjust either file to the
post-change behaviour here; the re-pricing belongs to units 2, 4 and 5.

### Unit 1 — carry the identity across the filesystem seam

*Files:* `src/fs/types.ts`, `src/fs/interface.ts`, `src/fs/caching/metadata-cache.ts`,
`src/fs/caching/id-delta.ts`, `src/fs/caching/id-delta.test.ts` (new), `src/fs/caching/remote-fs.ts`,
`src/fs/caching/remote-fs.contract.test.ts`, `src/fs/dropbox/incremental-sync.ts`,
`src/fs/dropbox/incremental-sync.test.ts`.
*Contract:* `contract-seam-carried-identity`. *Depends on:* nothing.

`RenamePair` gains `identityKey?: string`, documented as *the producing filesystem's own
`FileEntity` projection for `newPath`*, with `extractId`, `idAt`, `getPathById` and
`snapshotPathsById` named in the doc comment as forbidden sources for any value crossing the
`IFileSystem` boundary. The field stays **optional**: `ADR 0008`'s third state — missing keys
provide no evidence — governs a cycle-local rename report, and no rule in this change fails a
component for a missing key.

The producers reach the identity through **one** total helper over the already-public
`abstract toEntity(path, file)` (`metadata-cache.ts:59`): given a path, it returns
`toEntity(path, file).identityKey` when a file is cached there and `undefined` otherwise. It never
routes through `extractId`, never throws, holds no state, and forces no new abstract member on any
subclass. This is what makes the rule structural rather than a convention:
`DropboxMetadataCache.extractId` is `entry.id ?? entry.path_lower` (`dropbox/metadata-cache.ts:50-52`)
and its own doc comment declares it a total **address** function, while `dropboxEntryToEntity` sets
`identityKey: entry.id` with no fallback. The two are not defined to agree, so the rule can be
*stated* over the entity projection and cannot be stated over `extractId`.

All three producers set `identityKey` through that one helper and no other source:

- `id-delta.ts` — `applyEntry`'s move branch, where `entry.id` is already in scope a line above the
  `renamedPaths.push`;
- `remote-fs.ts` — `diffById` at `:416`, where `this.cache.entries()` is typed
  `IterableIterator<[string, TFile]>` and the `TFile` is currently destructured away;
- `dropbox/incremental-sync.ts` — `applyRename`, reached only when `entry.id` is truthy because
  `oldPath` came from `getPathById(entry.id)` (`:158`).

**Where the adversarial case is staged, and why it is not where it looks like it should be.** An
id-less Dropbox entry produces a rename pair on exactly one route and in exactly one sub-case. The
delta route never reaches `applyRename` for such an entry. The full-scan route produces no pair for
a *path-changing* rename, because `remote-fs.ts:416-421` keys on `entry.id ?? entry.path_lower`, so
the surrogate key changes with the path and the entry surfaces as delete-plus-add. The one
constructible shape is the **case-only** rename, where `path_lower` is stable while the cached
display path changes, so the surrogate key still hits. That case belongs in
`remote-fs.contract.test.ts`, where `diffById` and the cache's `idAt` are both reachable, and it
asserts that the pair's `identityKey` is **absent** and that this value **differs** from what
`cache.idAt` returns for the same entry. `incremental-sync.test.ts` cannot host it and hosts the
id-bearing delta witness instead.

*Delegated (`discretion-identity-lookup-call-shape`).* Whether each producer calls the helper once
per moved entry, hoists it above the branch, or passes the already-held `TFile`. The three
producers must reach the same single rule; no producer keeps a private identity source. Escalate if
the shape would read `extractId`, `idAt`, `getPathById` or `snapshotPathsById`, if the carried
value could diverge from the entity projection for any backend, or if a backend-specific branch
would appear in `src/fs/caching/`.

*Delegated (`discretion-projection-helper-placement`).* A public method on `AbstractMetadataCache`,
a protected one plus a public accessor, or a free function over the cache's public getters.
Escalate if it forces a new abstract member on every subclass, if it becomes reachable without
`toEntity`, or if a caller outside `src/fs/` would change.

*Boundaries.* Do not change apply ordering, descendant enumeration, `removeTree`, `upsertedPaths`
or any path-derived behaviour. Do not make `identityKey` required. Do not touch `src/sync/`.

### Unit 2 — preserve the identity to Admission

*Files:* `src/sync/identity-evidence.ts`, `src/sync/identity-evidence.test.ts`,
`src/sync/remote-change-source.ts`, `src/sync/plan-admission.test.ts`.
*Contract:* `contract-evidence-identity-preservation`. *Depends on:* units 0 and 1.

`collectRemoteRenameEvidence` copies `identityKey` from the pair onto the `RenameEvidence` and adds
nothing when the pair carries none.

`renameEvidenceKey` (`identity-evidence.ts:22-24`) is
`${side}\0${oldPath}\0${newPath}\0${isFolder}` and omits the identity, while
`selectReportFamily`'s own unique map (`identity-component-report-family.ts:16-21`) already includes
`report.identityKey ?? ""` and `sameRename` compares it. Once producers carry keys, `Map.set`
last-wins would silently drop one of two conflicting claims on one edge — hiding exactly the
conflict the carrier exists to expose. The dedupe key therefore gains the identity, and a carried
key, an absent key and an empty key stay three distinct values. That is this module's **encoding**
rule and is deliberately *not* the record layer's **admissibility** rule, where absent and empty are
one inadmissible case; the two questions differ and this change no longer asserts they share an
answer.

`completeIdentityEvidence` stops attaching a remote rename's identity from the
`currentRemote.get(item.newPath)` lookup. The `stable_identity` occurrence index (`:55-73`) and the
alias pass (`:46-53`) answer different questions and are untouched. Local rename evidence still
carries no `identityKey` and none is inferred for it.

**The precondition is discharged, not pending.** Unit 0's recorded branches are what admit this
removal, and they clear it: on every shape the enrichment supplies the current occupant's own key,
so the comparison it feeds is a tautology. The condition that would have withdrawn the removal —
the enrichment supplying a key the producer could not have supplied *and* that key changing an
outcome — occurs only in the sixth case's two map-keying divergences, where what it produces is a
`conflicting_identity` no fact supports. Removing the enrichment takes those two manufactured
failures with it, which is an intended effect.

**What this unit must change in the measurement file.** Fixtures 1–3's `evidenceFill` expectation
moves from `filled_from_newPath_lookup` to the no-fill branch, and fixture 4's from
`newPath_lookup_missed` to the same; the sixth case's two divergences then record the guard as
**not reached** where they currently record `conflicting_identity`. That is the observable form of
"the removal takes the manufactured failures with it". No assertion may be loosened into a partial
match.

*Delegated (`discretion-dedupe-key-encoding`).* How `identityKey` is encoded into the private key so
`undefined` and `""` cannot alias. The key stays a private string derivation inside this module and
is never persisted or exported. Escalate if a carried and an absent key could collapse, if the
observable order of the returned evidence array changed, or if `RenameEvidence`'s public shape would
change.

*Boundaries.* Do not change `RenameEvidence`'s public shape beyond the field that already exists.
Add no provenance field. Do not alter the alias or `stable_identity` passes.

### Unit 3 — make the validation a cross-source check

*Files:* `src/sync/identity-component-decision.ts`, `src/sync/identity-component-report-family.ts`,
`src/sync/plan-admission.test.ts`, `src/fs/local/local-fs.test.ts`.
*Contracts:* `contract-cross-source-rename-validation`, `contract-local-positional-boundary`.
*Depends on:* unit 2.

The check at `identity-component-decision.ts:105-107` keeps its shape and its `report.identityKey &&`
guard. What changes is that the key now originates at the producer rather than at the map it is
compared against, which is what makes it a check rather than a tautology.

**The RED witness has to be staged at the producer.** A report that *already* carries `id:X` is left
alone by `completeIdentityEvidence` — the map clause is guarded by `!item.identityKey`
(`identity-evidence.ts:41-44`) — so a hand-keyed fixture already fails on main and is no witness at
all. The input that differs between main and this change is the producer's **pair**: on main it
carries no identity, the report reaches Admission keyless, the enrichment fills the destination's
id, the guard passes and the component is admitted. So the witness is *main admits actions for this
input and the change admits none*, and it is staged by giving the pair an identity.

Four outcomes are pinned: a carried identity matching the identity at `newPath` admits the relation
and produces the same actions main produces; a carried identity disagreeing fails the component
with an existing failure reason and produces no action; a report carrying no key produces exactly
main's actions and no component fails for the missing key; and two claims on one edge carrying
different identities reach the report family and are classified `conflicting`, the component
degrading to ordinary actions rather than binding either claim.

The local boundary is stated here as a contract rather than as an omission: `LocalFs` still reports
`identityKey` undefined (`local-fs.test.ts:176`), no branch reads a local entity's `identityKey` as
evidence, and the non-improvements — a missed local rename event, a cross-scope local rename — are
stated where a reader of this change will find them.

*Delegated (`discretion-failure-reason-reuse`).* Reuse `conflicting_identity` or another existing
`AdmissionFailureReason` member. No proposed action may participate in the decision and no failure
may be persisted. Escalate if the public union would grow, if the failure would stop being
cycle-blocking, or if the reason would have to encode which producer supplied the key.

*Boundaries.* Relax no positional rule. Add no `AdmissionFailureReason` member. Persist no failure.
Do not touch `decideFolder`'s suffix coverage or `aliasFolder`.

### Unit 7 — the cross-family conformance

*Files:* `tests/fs/contracts/caching-remote-fs.contract.ts`, `tests/fs/remote-backend-contracts.test.ts`,
`tests/fs/googledrive/caching-remote-fs.contract-harness.ts`,
`tests/fs/dropbox/caching-remote-fs.contract-harness.ts`,
`tests/fs/onedrive/caching-remote-fs.contract-harness.ts`.
*Contracts:* `contract-cross-family-identity-conformance`, `contract-seam-carried-identity`.
*Depends on:* unit 1.

The remote FILE and FOLDER rename cells live at `caching-remote-fs.contract.ts:297-360`. Their
current object literals at `:314`, `:333` and `:351-356` break the instant `RenamePair` gains a
field and are **updated to include the identity, not loosened** — a `toMatchObject` or a dropped
field would retire an assertion that currently holds.
`remote-change-detection.contract.ts` holds no rename content at all, and `stableIdentity` is an
option of `ifilesystem.contract.ts:42,157`.

Cases assert the pair's `identityKey` against a `stat` of `newPath`, through the public
`IFileSystem` surface only — no cache reference, no private-state inspection. Both provider
orderings, including the Dropbox harness's deliberate `deleted(old)`-first ordering, must produce
the same identity. A delete-then-recreate at the same path with a *different* id must never produce
a pair carrying the old occupant's identity. A family whose projection legitimately yields none
records an explicit asserted absence with a cited reason, never a silent skip. The central matrix's
`satisfies Record<RemoteBackendFamily, RequiredRemoteContractSet>` must still make a missing family
or cell a compile error.

*Boundaries.* Add no production capability hook to the backend-agnostic base. Weaken no existing
shared case. Register no case outside the central composition root. Extend a registry fixture only
for backend-specific construction data.

### Unit 5 — the record shape and the identity floor

*Files:* `src/sync/types.ts`, `src/sync/state-committer.ts`, `src/sync/state-committer.test.ts`,
`src/sync/identity-component-decision.ts`, `src/sync/opened-file-priority.ts`,
`src/sync/opened-file-priority.test.ts`, `src/sync/plan-admission.ts`, `src/sync/plan-executor.ts`,
`src/sync/priority-batch-state.ts`, `src/sync/change-hash-enrichment.ts`,
`src/sync/conflict-action-contract.ts`, `src/sync/plan-admission-case-alias.ts`,
`src/sync/sync-cycle-finalization.ts`, `src/sync/identity-evidence.ts`,
`src/__mocks__/sync-test-helpers.ts`, plus the measured set of test files carrying `SyncRecord`
literals (`src/sync/state.test.ts`, `plan-executor.test.ts`, `change-detector.test.ts`,
`conflict-resolver.test.ts`, `conflict.test.ts`, `content-identity.test.ts`, `convergence.test.ts`,
`decision-engine.test.ts`, `delete-safety.test.ts`, `delta-first.test.ts`,
`identity-evidence.test.ts`, `orchestrator.test.ts`, `plan-admission.test.ts`,
`priority-batch-state.test.ts`, `scheduler.test.ts`, `scope-projection.test.ts`,
`sync-cycle-finalization.test.ts`, `sync-cycle-planning.test.ts`,
`admission-action-uniqueness.test.ts`, `change-compare.test.ts`,
`src/fs/onedrive/incremental-sync.test.ts`, `tests/fs/contracts/remote-change-detection.contract.ts`).
*Contracts:* `contract-record-field-audit`, `contract-record-identity-floor-disposition`.
*Depends on:* unit 0.

**The field audit.** `SyncRecord.backendMeta` is removed from the type and from `buildSyncRecord`
(`state-committer.ts:43`): one writer, zero production readers, and the identifying half of its
contents duplicates `remoteIdentityKey`. The type change alone makes any production read a compile
error. `FileEntity.backendMeta`, `hot-warm-promotion.ts:43`'s entity merge and every backend that
populates it are untouched. Reversal condition: a named production reader of
`SyncRecord.backendMeta`. Every other field is kept with its reason recorded — including
`syncedAt`, which passes the underivability test although no production reader was found beyond
`conflict-action-contract.ts:149`'s shape validator.

**The floor.** `SyncRecord.remoteIdentityKey` becomes **required**, and `buildSyncRecord` itself
refuses a remote entity whose `identityKey` is absent or empty with one named error, naming the
entity and the address, **before any store write**. Absent and empty take the same branch: an empty
string is a valid IndexedDB key, so storing it would silently fold two distinct entities into one
row. The refusal belongs to the construction function and not to a caller, because `buildSyncRecord`
has three production callers in two files — `state-committer.ts:119`, `opened-file-priority.ts:61`
and `:88` — and the two that are not `commitAction`'s both write to the store
(`opened-file-priority.ts:62`, `:91`). A floor placed in `commitAction` would leave the priority path
unguarded and would force `remote?.identityKey ?? ""` inside `buildSyncRecord` to keep the required
type satisfiable, which is exactly the fold this change forbids.

Each consumer context disposes of the refusal by its own established discipline, and neither gains a
new branch:

| Caller | Disposition |
|---|---|
| `state-committer.ts:119`, inside `commitAction` | the action fails, the cycle does not complete, the checkpoint stays uncommitted, and the entity is re-observed next cycle — the route `throw new Error("SyncRecord changed before terminal publication")` (`:123`) already takes |
| `opened-file-priority.ts:61` and `:88` | not a cycle action. The outer `try`/`catch` (`:37`, `:116-123`) already ends a failed attempt with a warn, `requestNormalLifecycle()` and `"failed_retryable"`, and the inner baseline commit (`:89-99`) warns and defers. The attempt takes no baseline, the target is invalidated, and the work defers to the batch cycle, where the row above applies |

The id-less entity is **not** refused at the backend boundary: it is still listed, still compared,
still conflict-resolvable, still reachable by `decision-engine.ts:8-21` for every branch that does
not need `prevSync`. What it cannot acquire is a durable baseline. The expected population is empty
— `googledrive/types.ts:25` and `onedrive/types.ts:20` declare `id: string`, and Dropbox's
`id?: string` (`dropbox/types.ts:23`) is optional only because the type also covers `deleted`
tombstones, which its doc comment says are *"never cached"* and which `buildFromFiles` skips — but
the branch is asserted by test rather than assumed unreachable.

**The retirement that follows.** The positional arm at `identity-component-decision.ts:408-410` is
removed. It is retired because **its population cannot exist**, and the assertion is a test that
fails when an identity-less record is constructed — **never `npm run build`**, which was measured
not to discriminate: `""` is falsy, so `x ? A : B` over `x: string` compiles clean under this
repository's own `tsc -noEmit --skipLibCheck --strict`, and `eslint.config.mts` configures no
`@typescript-eslint/no-unnecessary-condition`.

Every production branch that tested a **stored record's own identity absence** goes with it, and
none may be repaired positionally or by folding to `""`:

| Kind | Sites | Disposition |
|---|---|---|
| the positional fallback itself | `identity-component-decision.ts:408-409` | removed |
| whole branch is the absent-identity branch | `opened-file-priority.ts:41` | removed |
| vacuous conjunct or disjunct guarding a comparison | `plan-admission.ts:125`, `plan-executor.ts:556`, `:788`, `priority-batch-state.ts:63`, `change-hash-enrichment.ts:33`, `conflict-action-contract.ts:42`, `plan-admission-case-alias.ts:152`, `sync-cycle-finalization.ts:44`, `identity-evidence.ts:57`, `identity-component-decision.ts:420`, `:459` | the term is dropped; the comparison it guarded is unchanged, and nothing else on the line changes |
| runtime shape validator over `unknown` | `conflict-action-contract.ts:150` | tightened to require a non-empty string — the only site that would otherwise keep admitting a record shape the floor forbids |
| comparisons and optional-**record** chains | `identity-component-decision.ts:445`, `:510-511`, `:550-551`, `:696`, `:760`, `:766-770`; `plan-admission-graph.ts:41`; `change-hash-enrichment.ts:61`, `:66`, `:72` | unchanged. `baseline?.`, `prevSync?.` and `targetRecord?.` test whether the *record* exists, which stays optional |

**What this unit must change in the measurement file.** Unit 0's shape 2 — a baseline carrying no
identity — becomes unconstructible the moment the field is required and the floor lands. It is
**deleted with its reason cited, not repaired**: its disappearance is the observable form of the
retirement. Every other `SyncRecord` literal in that file, and in the measured set above, gains a
non-empty identity rather than an empty-string fold. `tsconfig.json` type-checks `tests/**/*.ts` as
well as `src/**/*.ts`, so the compiler is the reliable enumerator here; the file list above is the
measured set and this unit's boundary is that set plus any further file the compiler names.

*Delegated (`discretion-identity-floor-refusal-site`).* Whether the floor is a guard clause inside
`buildSyncRecord`'s body or a small named predicate it calls that narrows the remote entity's type.
Escalate if the refusal would sit in a caller rather than in `buildSyncRecord`, which would leave
`opened-file-priority.ts:61` and `:88` unguarded while both write to the store.

*Boundaries.* Do not touch the store's `keyPath`, its index or `DB_VERSION` — those are unit 4's and
depend on this unit. Remove no other field. Do not touch `FileEntity`. Do not synthesize an identity
from a path. Do not fold an absent identity to `""` anywhere, including inside `buildSyncRecord` to
satisfy the required type. Do not refuse an id-less entity at the backend boundary or remove it from
a listing. Do not make the opened-file priority attempt fail a cycle. The gate must be green at this
unit's boundary **with the store's keyPath still `"path"`**.

### Unit 4 — the store re-key, the two operations, and the merge base

*Files:* `src/sync/state.ts`, `src/sync/state.test.ts`, `src/sync/state-committer.ts`,
`src/sync/state-committer.test.ts`, `src/sync/plan-executor.ts`, `src/sync/plan-executor.test.ts`,
`src/sync/change-detector.ts`, `src/sync/opened-file-priority.ts`, `src/sync/conflict-resolver.ts`,
`src/sync/identity-component-decision.ts`, `src/sync/plan-admission.test.ts`,
`src/sync/fact-first-execution.test.ts`, `src/sync/record-rekey-across-commit.test.ts`,
`src/__mocks__/sync-test-helpers.ts`.
*Contracts:* `contract-record-identity-uniqueness`, `contract-merge-base-survives-relocation`.
*Depends on:* unit 5.

**The schema.** `sync-records` is created with `keyPath: "remoteIdentityKey"` and
`createIndex("path", "path", { unique: true })`; `sync-content` is re-keyed to `remoteIdentityKey`
with it and needs no index, because nothing reads a merge base by address once
`conflict-resolver.ts:135` reads it by the baseline it already holds. Both declarations go inside
the existing `onUpgrade` recreate (`state.ts:28-40`), which is the only place either is legal, and
`DB_VERSION` is bumped so the existing cold start rebuilds every record. `createIndex` has zero
occurrences in `src/` today; this is unused standard capability, not a missing one.

Two invariants with two very different mechanisms:

| Invariant | Mechanism | What a violation means |
|---|---|---|
| at most one record per remote identity | the keyPath, by construction | unrepresentable; there is no violation to handle |
| at most one record per vault address | the unique `path` index, which **aborts** | the `fs` premise is broken — a defect signal, not an outcome |

**The two expectations every CAS method now takes.** Under `keyPath: "path"` one captured record
served as both "the row this publication continues" and "the row holding this address", because they
were the same row. They separate, so each method takes both **explicitly**, with no defaulted
parameter: `expectedRow`, the row keyed by `record.remoteIdentityKey` (`undefined` means no row for
this identity — a create); and `expectedOccupant`, the current occupant of `record.path` read
through the `path` index (`undefined` means the address is vacant). `compareAndMove`'s inherited
default (`state.ts:119`) disappears with the method and is not recreated, so
`compareAndPut(undefined, record, undefined)` still means exactly what `compareAndPut(undefined, record)`
means today. `compareAndDelete(path, expected)` deletes the row keyed by
`expected.remoteIdentityKey` after comparing that row and the occupant of `path`; with
`expected === undefined` there is no row to address, so it verifies the address is vacant, deletes
nothing and returns `true` — today's verified no-op, stated rather than inherited.

**The two operations.** Every publication is one of exactly two, and the store is told which:

| Operation | Condition | What the store does |
|---|---|---|
| **rename** | `expectedRow` and the terminal carry one identity; only `path` differs | a **single `put`**. The primary key does not move, no row is deleted, and `sync-content`'s row does not move either because it is keyed the same way |
| **replacement** | `expectedOccupant` is a record for a **different** identity than the terminal's | **delete the incumbent and insert the terminal in one transaction**, after comparing the incumbent against `expectedOccupant` |

The rename case is *simpler* than today's `compareAndMove`, which had to delete at the old key and
put at the new one — which is why the method collapses rather than being re-expressed. The
replacement case is what the unique `path` index is for: with `keyPath: "path"`, `store.put`
discards the incumbent **silently** (`state.ts:101-103`), and here the discard must be written,
compared and tested or the constraint aborts the transaction. The comparison **precedes** the
delete, so a replacement whose expectation has gone stale removes nothing.

Admission already distinguishes the two — `identity-component-decision.ts:509-511` and `:549-551`
build `replacement: … baseline.remoteIdentityKey !== remote.identityKey` today — so no new
classification, evidence or ordering is introduced. What must change there is mechanical: those two
sites currently build `publication: { source: expected, destination: expected }` for a same-address
replacement, and a replacement carries **no continued row**. Left as they are, the CAS would look
for a row keyed by the *new* identity, compare it against the *old* record, and return `false` on
every cycle.

**The relocation admission rule.** Every terminal is `{...source, path}`
(`state-committer.ts:104-105`), so each relocation is an in-place update of one identity-keyed row
and the `store.delete(item.source.path)` that made today's order safe is gone.
`compareAndRewritePaths` extends its existing non-injectivity refusal (`state.ts:167-169`): if any
item's terminal address equals a **different** item's source address, it publishes nothing and
returns `false`. Self-overlap — an unmoved child whose terminal address is its own source address —
is not overlap and is admitted, as `if (item.source.path !== item.terminal.path)` already
recognises. Cyclic sets fall under the same refusal, so no temporary address is ever written. The
only production caller cannot produce an overlapping set: every source lies under the old folder
prefix, every terminal under the new one, and a folder cannot be renamed into its own subtree.

That refusal is **intra-set and is not the whole discharge**. The hazard is contention with *any*
row, including one the set never mentions: `identity-component-decision.ts:719` already sets each
item's `destination: facts.records.get(target)` — a record outside the set that already holds the
terminal address — and `compareAndRewritePaths` already captures and compares it
(`state.ts:181-183`). Such an item is a **replacement** at that terminal address and is discharged
by the same rule as every other displacement, applied per item: delete the captured foreign
incumbent and insert the relocated child under the one transaction image. No second rule, no
ordering inside the set — the items publish together.

**The merge base.** `compareAndPut` already has the invalidation predicate (`state.ts:104-108`);
`compareAndMove` is the body that lacks it (`:132-133`). The collapse therefore repairs the defect
by construction on the file-rename path — **but only if the absorbed destination comparison is added
to `compareAndPut` without carrying `compareAndMove`'s unconditional `contentStore.delete` across**,
which is exactly the line a mechanical merge of the two bodies would keep.
`compareAndRewritePaths` keeps its own body, so its two unconditional `content.delete(...)` calls
(`:186-187`) are replaced with the same predicate applied per item — one content row per item to
decide about, not two addresses. `commitAction`'s folder branch returning before
`maybeStoreMergeBase` (`state-committer.ts:99-109`) is **correct as it stands**: the subject of a
folder rename is a folder and has no content, so the repair lands in the CAS bodies and nowhere
else.

**The call sites.** Production has 21 `SyncStateStore` call sites; 17 address a row by the primary
key and are re-expressed, 4 are key-agnostic and are not. Address-asking reads move to the `path`
index — `plan-executor.ts`'s `checkRecord` sites at `:420`, `:421`, `:436` and `:437` over the
single `store.get` at `:414`, `opened-file-priority.ts:38` and `:77`, and `change-detector.ts:147`
and `:180`, whose `getMany` issues `store.get(p)` per path and **is** a primary-key lookup.
Row-addressing writes go by identity. `conflict-resolver.ts:135` reads the merge base by the
baseline record it already holds rather than by `ctx.baselinePath`. `getAll()` at
`change-detector.ts:84`, `:96`, `:104` and `clear()` at `orchestrator.ts:95` are unchanged, as are
the `record.path` field reads at `change-hash-enrichment.ts:32` and `scope-projection.ts:86`,
`:153`. Let the compiler enumerate the set rather than grepping.

**The removals.** `rewritePaths` is deleted: zero callers in `src/`, no compare-and-swap, and a
`store.put({...record, path: newPath})` that silently overwrites whatever occupies the destination
address — a sanctioned route to precisely the mis-operation class this change exists to remove. It
is additionally incoherent under the new key, since it rewrites a field that is no longer the key
while leaving the row it should have moved untouched. `compareAndMove` ceases to exist. Both
removals break the whole type-checked spy surface, which is enumerated and closed rather than
deleted: `src/sync/state.test.ts`, `src/sync/fact-first-execution.test.ts` (`:282`, `:402-417`,
`:671`, `:727-742`), `src/sync/state-committer.test.ts:210-215`,
`src/sync/plan-executor.test.ts:1101` and `src/__mocks__/sync-test-helpers.ts:270` for
`compareAndMove`; `src/sync/state.ts:202` and `src/__mocks__/sync-test-helpers.ts:309` for
`rewritePaths`. Each spy or bind is re-expressed against `compareAndPut`.

`put` and `putContent` are **not** removed, although both also have zero production callers: the
documentation correction in unit 6 takes away the hazard that named them, and neither carries a
mis-operation route of its own. Reversal condition: a named route through either that can publish
without comparing.

**What this unit must change in the measurement file.** `src/sync/record-rekey-across-commit.test.ts`
is **re-priced, not inverted**. Its split-cycle cases already record the correct end state — the old
row discarded and the object re-downloaded as new — and change only to assert it deliberately, as
the model working: "shape 2, cycle 1" keeps its single surviving row at `P` and **additionally
asserts that the incumbent's removal was an explicit delete inside the claiming transaction** rather
than an overwrite, and "shape 2, cycle 2" keeps its assertion that `K1` is treated as a new file.
Three further edits fall out of the same change: `traceCommits` loses its `compareAndMove` spy
because the method ceases to exist; the control and same-cycle cases record `compareAndPut` where
they record `compareAndMove`; and the merge-base case's relocation leg records the base
**preserved** where it records `absent`, because a rename does not move the row. The file is not
deleted, no case is removed, and no instrumentation is weakened.

*Delegated (`discretion-cas-address-comparison-shape`).* Whether each CAS method reads the target
address through the `path` index directly or through one shared private helper issued inside the
same `readwrite` transaction. The comparison is issued inside the transaction it guards, so an
ordinary stale destination is `conflicting` and never reaches the index. Escalate if the shape would
turn a boolean return into a new result type; if it would let the index's abort be caught, mapped to
`false`, or compensated by deleting an incumbent after the fact; if it would issue the incumbent's
delete before comparing it; if it would issue a delete on the rename path; if it would recover the
abort's `DOMException` name by catching the request-level error or re-parsing a message string; or
if it would require a change to `src/store/idb-helper.ts` or a second transaction.

*Delegated (`discretion-merge-base-invalidation-site`).* Whether the predicate is factored into one
private helper the CAS bodies share or applied inline in each — so long as it is `compareAndPut`'s
existing predicate *referenced* rather than a second copy of it. Escalate if the site would need a
second transaction or a read outside the transaction that guards the write, if it would change
`getContent`'s or `putContent`'s public signature beyond the key change, or if it would let a
relocation set apply partially.

*Boundaries.* Add no convergence strategy, retry, recovery path, recovery marker or queue for the
`path`-index violation; the index stays a pure defect signal and a correctly built replacement never
reaches it. Reintroduce nothing the record model removed — no evidence test for whether a displaced
object still exists, no retirement classification vocabulary, no ordering between bindings, no
relocating-first emission, no claimer-expects-vacant expectation, no address-permutation refusal, no
fail-closed disposition. Add no identity-keyed deletion channel, no scope-completeness or
temperature fact carried into Admission, no new observation kind. Push nothing to the executor and
add no ordering, regrouping, dependency graph or recovery queue there. Add no store-side reaper, no
by-identity refusal, no duplicate-identity error and no holder pre-read — there is no holder to name
under this key. Do not order or add a temporary for overlapping relocation sets; refuse them. Add no
new mutating method, add no `AdmissionFailureReason` member, do not remove `put` or `putContent`, do
not repair or work around `src/store/idb-helper.ts`, and design or assume nothing about how `fs`
enforces path uniqueness or how two objects at one address are arbitrated — that is issue #90's. The
record type's required identity and the floor are unit 5's and must not be reopened here.

### Unit 6 — the enforcement artefacts

*Files:* `sync-state-ownership-guard.test.mjs`,
`docs/adr/0001-metadata-cache-is-subordinate-to-commit-last.md`, `docs/code-enforcement.md`,
`docs/sync-pipeline.md`. *Contract:* `contract-record-identity-uniqueness`.
*Depends on:* units 4 and 5.

This is hygiene consequent on the store surface moving, not an obligation the change incurs.
`AGENTS.md:71-73` binds the ADR-0001-plus-enforcement-document triple to an intentional **new**
writer, owner or field; removing names from a detector set is not that, and no artefact may state
that `AGENTS.md:71-73` compelled this work.

`MUTATING_SYNC_STATE_METHODS` (`sync-state-ownership-guard.test.mjs:9-12`) loses exactly the names
`rewritePaths` and `compareAndMove`, both of which no longer exist on `SyncStateStore`. The set has
a **second consumer** at `:320`, a hardcoded method list that generates two negative-fixture tests
per name (`records.<m>` and `records["<m>"]`); it is reduced by `compareAndMove` in the same edit.
A failure at `:320` between the method removals and the detector-set edit is the *expected*
consequence of the removal, not evidence that a removed name was load-bearing — only an **inventory**
change would be that. Every remaining CAS method must still have both of its generated negative
fixtures.

The four per-file inventories stay byte-identical, and that is the machine proof of NFR-RIK-004:
`mutationCallers` stays `[opened-file-priority.ts, orchestrator.ts, state-committer.ts]` because
`opened-file-priority.ts` still calls `compareAndPut`, `orchestrator.ts` still calls `clear`, and
`state-committer.ts` still calls `compareAndDelete`, `compareAndPut`, `compareAndPutContent` and
`compareAndRewritePaths` — all still in the reduced set — while `imports`, `references` and
`constructors` are untouched. `sync-admission-authority-guard.test.mjs` stays green with **no**
fixture edit.

ADR 0001 records the record store's new key and its unique `path` index as storage mechanism
subordinate to commit-last, and records the index as a guard on the filesystem layer's
path-uniqueness guarantee rather than as an identity-policy owner.
`docs/code-enforcement.md`'s two-authority row names the reduced mutating set.
`docs/sync-pipeline.md`'s state-commit bullets (`:303-305`) name `compareAndPut`,
`compareAndRewritePaths` and `compareAndDelete` where they currently name `put()`, `rewritePaths()`
and `delete()`.

*Boundaries.* Widen no writer set. Add no checkpoint accessor. Do not rewrite ADR 0001's
two-publication-point statement. Do not edit `sync-admission-authority-guard.test.mjs`'s fixture.

### Seams and test surfaces

| Component | Seam |
|---|---|
| `component-fs-rename-contract` | the shared contracts under `tests/fs/` |
| `component-metadata-cache-identity` | `src/fs/caching/remote-fs.contract.test.ts` plus each backend's cache tests |
| `component-delta-producers` | new `id-delta.test.ts`, `incremental-sync.test.ts`, `remote-fs.contract.test.ts` |
| `component-rename-evidence` | `src/sync/identity-evidence.test.ts` |
| `component-admission-identity-gate` | `src/sync/plan-admission.test.ts` through `admitBatchObservation`, and `src/sync/record-rekey-across-commit.test.ts` through the orchestrator's own `collectChanges` → `prepareSyncCycleSnapshotForExecution` → `admitBatchObservation` → `executePlan` chain over the real `SyncStateStore` |
| `component-local-endpoint` | `src/fs/local/local-fs.test.ts`, `src/sync/local-tracker.test.ts` |
| `component-record-store` | `src/sync/state.test.ts` with `fake-indexeddb/auto` |
| `component-record-shape` | `src/sync/state-committer.test.ts`, `src/sync/opened-file-priority.test.ts` |
| `component-two-authority-enforcement` | `npm run lint:bot-repro` |
| `component-shared-fs-contracts` | `tests/fs/remote-backend-contracts.test.ts`, opt-in e2e |

### The cross-issue obligation on #90

Issue #90's `rule-keeper` and `input-committed-record` derive *"at most one claimant can hold that
record"* from **"records are path-keyed"**. Under this change that property comes from the **unique
`path` index** instead. The property survives the re-key and #90's rules are unaffected in
substance; only their justification needs updating, and that is two sentences in **#90's** plan. It
is recorded here so it is not lost and is deliberately **not attempted** in this change. Nothing in
#90's mechanism and nothing in this change's mechanism waits on the other.

### Publication order needs nothing added

`bindFiles` already runs its loops in the order this change needs, and the order is deliberate
rather than incidental: unbaselined reports first (`identity-component-decision.ts:390`, under the
stated intent at `:388-389` — *"Bind unbaselined reports before destination history can claim their
endpoints. A destination record is a replacement expectation, not the reported source."*),
record-driven relocations next (`:405`), leftover current entities last (`:496`). Measurement
confirmed it. No ordering rule, relocating-first emission or deferral is introduced anywhere in this
change.
