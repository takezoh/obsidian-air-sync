---
change: change-20260916-cache-path-id-bijection
role: implementation
contracts:
- contract-derived-address-arbitration
- contract-claim-set-assignment
- contract-drain-settlement
- contract-absence-authority
- contract-no-loss-remediation
- contract-identity-addressed-rename
- contract-contention-user-signal
- contract-enumeration-uniqueness-conformance
contract_projections:
- id: contract-derived-address-arbitration
  verifications:
  - verify-arbitration-permutation-invariance
  - verify-authority-tier-precedes-lowest-id
  - verify-arbiter-pure-and-total
  - verify-no-backend-import-in-arbiter
  discretion:
  - discretion-arbiter-outcome-spelling
- id: contract-claim-set-assignment
  verifications:
  - verify-both-permutations-equal-contents
  - verify-setfile-returns-displacement
  - verify-bijection-after-every-mutation
  - verify-dropbox-pinned-tests-unmodified
  discretion:
  - discretion-displacement-accumulator-threading
- id: contract-drain-settlement
  verifications:
  - verify-folder-collision-names-children
  - verify-later-tombstone-readmits-claimant
  - verify-page-permutation-equal-result
  - verify-two-causes-of-null-separated
  discretion:
  - discretion-withheld-carrier-shape
- id: contract-absence-authority
  verifications:
  - verify-snapshot-fixture-empty-deleted
  - verify-genuine-deletion-still-reported
  - verify-cursor-expiry-excludes-displaced
  - verify-no-absence-decided-under-src-sync
  discretion: []
- id: contract-no-loss-remediation
  verifications:
  - verify-keeper-and-target-order-independent
  - verify-remediation-plan-partition
  - verify-failed-rename-leaves-cursor-uncommitted
  - verify-two-cycle-both-objects-present
  discretion: []
- id: contract-identity-addressed-rename
  verifications:
  - verify-executor-renames-by-provider-identity
  - verify-remote-only-rename-no-longer-throws
  - verify-backend-without-capability-gets-no-action
  - verify-live-drive-identity-rename
  discretion: []
- id: contract-contention-user-signal
  verifications:
  - verify-one-warn-per-contended-address
  - verify-count-distinct-from-error-count
  - verify-default-settings-status-bar-states-count
  - verify-no-unmerged-symbol-referenced
  discretion:
  - discretion-contended-summary-wording
- id: contract-enumeration-uniqueness-conformance
  verifications:
  - verify-two-ids-one-path-both-orderings
  - verify-both-objects-survive-the-repair
  - verify-matrix-requires-script-or-citation
  - verify-live-onedrive-shape
  discretion: []
adrs:
- adr-cache-address-assignment-owner
- adr-derived-vs-provider-keyed-address-domain
- adr-upstream-rename-remedy
- adr-rename-target-and-discriminator
decision_dispositions:
- decision_input_ref: decision-input-address-owner-location
  disposition: Adopted, scoped to derived addresses. The owner is a pure module reached
    from the base's buildFromFiles claim-set pass and from applyFileChange — the two
    places the cache composes an address from a provider name and a parent chain.
    Placement, not a runtime predicate, is what keeps Dropbox's provider-keyed address
    out of its domain.
  adr_refs:
  - adr-cache-address-assignment-owner
  - adr-derived-vs-provider-keyed-address-domain
  contract_refs:
  - contract-derived-address-arbitration
  - contract-claim-set-assignment
- decision_input_ref: decision-input-bulkload-as-choke-point
  disposition: 'Rejected. DropboxMetadataCache.buildFromFiles (dropbox/metadata-cache.ts:147-154)
    overrides the base and reaches setEntry then setFile directly, so Dropbox''s full
    scan never passes bulkLoad; and bulkLoad (metadata-cache.ts:155-173) has no address
    rule of its own — it validates stable-id uniqueness and calls setFile in a loop.
    This is an independent reason PR #83''s placement could not have worked.'
  adr_refs:
  - adr-cache-address-assignment-owner
  contract_refs:
  - contract-claim-set-assignment
- decision_input_ref: decision-input-inverted-keying
  disposition: Rejected on principle as well as cost. The destination is a real filesystem
    that cannot hold two objects at one address, so the cache's path-keying mirrors
    it correctly; inverting it would make the cache model something the destination
    cannot represent. The measured cost (roughly 100 path-addressed call sites, three
    backends, the path-keyed children index, a version bump forcing re-enumeration)
    stands and was independently re-verified. Its three surviving findings — explicit
    ownership, a set-based rather than arrival-based rule, and displacement as typed
    output — are in the design.
  adr_refs:
  - adr-cache-address-assignment-owner
  contract_refs:
  - contract-derived-address-arbitration
- decision_input_ref: decision-input-winner-rule-stable-fact
  disposition: Closed as lexicographically lowest stable id, after the authority tier.
    Under the upstream remedy both objects survive and both sync, so which claimant
    holds the plain address is not a correctness property; determinism and order-independence
    are. Oldest creation timestamp is better motivated but needs a new per-backend
    seam that does not exist uniformly across the three families, which is variability
    bought for no observable gain.
  adr_refs:
  - adr-cache-address-assignment-owner
  contract_refs:
  - contract-derived-address-arbitration
- decision_input_ref: decision-input-single-upsert-distinguishability
  disposition: 'Dissolved by the evidence unit rather than answered at the upsert.
    A single upsert need not distinguish a genuine second object from a re-key: the
    contention is provisional until the close of the unit, a later tombstone withdraws
    it, and PR #83''s per-route fork — the thing that made the routes reverse each
    other — is therefore unnecessary.'
  adr_refs:
  - adr-cache-address-assignment-owner
  contract_refs:
  - contract-drain-settlement
- decision_input_ref: decision-input-orphan-fallback-removal
  disposition: Rejected. Making the full-scan resolver decline would leave the entry
    with no cache record while it is still in the pre-scan snapshot, so diffById's
    sweep at remote-fs.ts:429-431 would convert it into checkpoint_deleted and delete_local
    — a new instance of the harm this plan removes — and it would break what googledrive/metadata-cache.test.ts:410-421
    pins.
  adr_refs:
  - adr-cache-address-assignment-owner
  contract_refs:
  - contract-claim-set-assignment
  - contract-absence-authority
- decision_input_ref: decision-input-resolver-guessing-asymmetry
  disposition: Kept and demoted rather than aligned, and the asymmetry is given a
    second job. The bare-name guess already carries requested_echo (path-authority.ts:26,30),
    so the arbiter's tier 1 makes it lose in every listing order without either resolver
    changing; and the same fact identifies the claimant as being outside the bound
    sync root, which is what makes it ineligible for a provider rename.
  adr_refs:
  - adr-cache-address-assignment-owner
  - adr-upstream-rename-remedy
  contract_refs:
  - contract-derived-address-arbitration
  - contract-no-loss-remediation
- decision_input_ref: decision-input-rewritechildpaths-inclusion
  disposition: Rejected. rewriteChildPaths propagates an address already decided rather
    than assigning one, and Correction 1 established that all five callers compensate
    for its missing occupant check today. Including it would be structure without
    a witness. Any new caller inherits the obligation the existing five discharge,
    and that obligation is recorded in the plan.
  adr_refs:
  - adr-cache-address-assignment-owner
  contract_refs:
  - contract-claim-set-assignment
- decision_input_ref: decision-input-rewritechildpaths-occupant-guard
  disposition: Subsumed into decision-input-rewritechildpaths-inclusion and resolved
    the same way. Draft-2 included it only for ownership closure rather than for a
    measured defect; with the owner scoped to derived-address assignment, propagation
    is outside it and the existing guards stay as defence-in-depth.
  adr_refs:
  - adr-cache-address-assignment-owner
  contract_refs:
  - contract-claim-set-assignment
- decision_input_ref: decision-input-throw-on-collision
  disposition: 'Rejected for path duplication. A deterministic throw classifies as
    transient (fs/errors.ts:104) and burns MAX_RETRIES full enumerations, which is
    issue #88 verbatim. bulkLoad''s existing duplicate-stable-id throw keeps exactly
    its current message and breadth.'
  adr_refs:
  - adr-cache-address-assignment-owner
  contract_refs:
  - contract-claim-set-assignment
- decision_input_ref: decision-input-cold-warm-hot-sameness
  disposition: Binding, and it eliminates the most tempting comparator tier. Incumbency
    drawn from the committed checkpoint would make COLD and HOT decide differently
    for the same current facts, so the cache's arbiter may not use it. The same rule
    permits the committed SyncRecord as an Admission-level input, which is where the
    keeper choice legitimately reads it.
  adr_refs:
  - adr-cache-address-assignment-owner
  - adr-rename-target-and-discriminator
  contract_refs:
  - contract-derived-address-arbitration
  - contract-no-loss-remediation
- decision_input_ref: decision-input-commit-last-adr0001
  disposition: Retained without amendment. The cache stays a derived projection committed
    last; every displacement is a return value inside one evidence unit and is never
    persisted. The new checkpoint block tightens when the commit happens; it does
    not change who owns it.
  adr_refs:
  - adr-cache-address-assignment-owner
  contract_refs:
  - contract-absence-authority
  - contract-no-loss-remediation
- decision_input_ref: decision-input-no-migration-cold-start
  disposition: Binding, and moot for the chosen design. No schema change is made,
    METADATA_CACHE_VERSION stays 4, FILES_STORE keeps keyPath "path", and no cold
    start is engaged. The rejected byId-primary carrier would have engaged one, and
    that is recorded as part of its cost.
  adr_refs:
  - adr-cache-address-assignment-owner
  - adr-upstream-rename-remedy
  contract_refs:
  - contract-claim-set-assignment
- decision_input_ref: decision-input-shared-contract-shape
  disposition: Adopted and extended. The shared case asserts at the public filesystem
    boundary in both provider orderings, and — because the remedy makes both objects
    survivable — it asserts the survival of both rather than merely a stable winner.
    Cases for cold-versus-delta parity, the cursor-expiry route and the no-commit-while-withheld
    rule are included because they are the only ones that turn red for the measured
    defects.
  adr_refs:
  - adr-cache-address-assignment-owner
  contract_refs:
  - contract-enumeration-uniqueness-conformance
- decision_input_ref: decision-input-shared-harness-capability
  disposition: 'Adopted as test infrastructure only. The per-family seam and the cited-non-producibility
    field live entirely under tests/fs/, which AGENTS.md already sanctions for backend-specific
    construction data; no production capability hook is added to the backend-agnostic
    base, which is the distinction from PR #83.'
  contract_refs:
  - contract-enumeration-uniqueness-conformance
- decision_input_ref: decision-input-dropbox-replacement-policy
  disposition: Closed as a deliberate retention with its reason stated, not a silent
    exemption. Dropbox's address is the provider key (extractId is entry.id ?? entry.path_lower),
    so a second id at one address is provider topology rather than a contention; setEntry
    keeps its path-keyed last-write-wins policy and Dropbox receives no production
    change. Draft-2's claim that setEntry could inherit the arbiter and still preserve
    dropbox/metadata-cache.test.ts:92-98 and :100-116 is falsified by the source.
    No position is taken on unknown-dropbox-folder-replacement-contract.
  adr_refs:
  - adr-derived-vs-provider-keyed-address-domain
  contract_refs:
  - contract-claim-set-assignment
  - contract-enumeration-uniqueness-conformance
- decision_input_ref: decision-input-onedrive-duplicate-names
  disposition: Carried as an unsettled unknown, with its consequence fixed in advance.
    OneDrive receives no production change and its matrix cell is a cited non-producibility.
    If the unknown settles positive, OneDrive implements the same optional rename
    capability and inherits every contract here unchanged — nothing in the design
    is Drive-shaped except that capability's implementation.
  adr_refs:
  - adr-derived-vs-provider-keyed-address-domain
  contract_refs:
  - contract-identity-addressed-rename
  - contract-enumeration-uniqueness-conformance
- decision_input_ref: decision-input-provider-liveness-probe
  disposition: Not adopted, and no longer needed. It was one of the two admissible
    carriers for the cross-drain tombstone failure under a no-repair remedy; with
    the upstream rename and the checkpoint gate, no withheld claimant survives a committed
    cursor advance, so there is nothing to carry. It would also have cost a provider
    read per vacated address on every deletion, and AbstractMetadataCache holds no
    client (RB-INV-001).
  adr_refs:
  - adr-upstream-rename-remedy
  - adr-derived-vs-provider-keyed-address-domain
  contract_refs:
  - contract-no-loss-remediation
- decision_input_ref: decision-input-remedy-tiebreak-vs-rewrite
  disposition: 'Closed by the repository owner during design, in favour of neither:
    the remedy is a provider-side rename that removes the condition at its source.
    The bare tie-break and the vault-local rewritten address are recorded as considered
    and rejected with their reasons. The tie-break''s machinery is not eliminated
    — arbitration still decides who keeps the plain address, and announce-and-stall
    is the fallback when the repair cannot be performed.'
  adr_refs:
  - adr-upstream-rename-remedy
  contract_refs:
  - contract-no-loss-remediation
  - contract-derived-address-arbitration
- decision_input_ref: decision-input-pr83-rewrite-shape
  disposition: 'Rejected, and the upstream rename is distinguished from it point by
    point. A vault-local invented address is not re-derivable from a delta page''s
    own facts, must be requested_echo, and is snapped back by setFile''s re-key guard
    at :104-109 — PR #83''s measured reversal. The upstream rename''s new name exists
    on the provider, is reported by the delta with provider authority, and is therefore
    re-derivable on both routes.'
  adr_refs:
  - adr-upstream-rename-remedy
  contract_refs:
  - contract-no-loss-remediation
  - contract-identity-addressed-rename
- decision_input_ref: decision-input-issue-doc-tiebreak-recommendation
  disposition: Partly adopted, and superseded as the primary path. Its criterion —
    stop the listing-order flip-flop — is met by the arbiter, and its pathAuthority-preferring
    preference is tier 1. Its recommendation that the remedy stop there is superseded
    by the owner's decision to repair the source.
  adr_refs:
  - adr-upstream-rename-remedy
  - adr-cache-address-assignment-owner
  contract_refs:
  - contract-derived-address-arbitration
- decision_input_ref: decision-input-pathauthority-enforcement-mechanism
  disposition: Deferred as a mechanism; retained as an obligation. NFR-ADDR-003 stands,
    and the design strengthens it by never writing the disambiguated address before
    the provider reports it. No main-today violation of the labels is constructible
    (path-authority.ts:26,30, pinned by googledrive/metadata-cache.test.ts:410-421),
    so a branded type, a schema and an AST guard would enforce a label that is not
    currently forgeable.
  adr_refs:
  - adr-upstream-rename-remedy
  contract_refs:
  - contract-claim-set-assignment
  - contract-identity-addressed-rename
- decision_input_ref: decision-input-pathauthority-enforceable-type
  disposition: Subsumed into decision-input-pathauthority-enforcement-mechanism and
    resolved the same way. Draft-2 made the deferral conditional on the reserved remedy;
    the owner's decision removes the condition, because the upstream rename creates
    no invented address inside the vault for PathAuthority to arbitrate.
  adr_refs:
  - adr-upstream-rename-remedy
  contract_refs:
  - contract-claim-set-assignment
- decision_input_ref: decision-input-probe-cost
  disposition: Closed at zero. NFR-ADDR-004 fixes zero additional provider read requests
    on both routes; the only provider mutation is one rename per contended address
    per cycle, issued from the execution phase as an admitted action. Draft-1's bounded-probe
    clause is not needed because no probe is built.
  adr_refs:
  - adr-upstream-rename-remedy
  contract_refs:
  - contract-no-loss-remediation
  - contract-identity-addressed-rename
- decision_input_ref: decision-input-contested-signal-reach
  disposition: Closed at three surfaces, after a verification that changes the answer
    both drafts assumed. enableLogging is false by default (settings.ts:74) and showSyncNotifications
    is also false (settings.ts:73, orchestrator.ts:230-233), so neither the warn log
    nor the cycle summary reaches a default user; the status bar (main.ts:287-304)
    is the only unconditional per-cycle surface and therefore carries the count. The
    log keeps the diagnostic detail and the summary keeps the counts idiom.
  adr_refs:
  - adr-upstream-rename-remedy
  contract_refs:
  - contract-contention-user-signal
- decision_input_ref: decision-input-diagnostics-seam-pr94
  disposition: Not depended on. Logger.enabled and src/sync/sync-cycle-diagnostics.ts
    are not on main (50c02c2 is not an ancestor of HEAD 60e85b0; src/logging/logger.ts
    has no enabled member and the module does not exist), and the diagnostics module
    would live under src/sync/ where src/fs/** does not import it. NFR-ADDR-005 pins
    the absence so no implementer reaches for a symbol that is not there.
  contract_refs:
  - contract-contention-user-signal
- decision_input_ref: decision-input-rename-target-selection
  disposition: 'Closed as: the claimant that does not hold a committed SyncRecord
    at the contended path keeps the suffixed name, and if neither holds one it is
    the claimant the arbiter did not admit. At most one claimant can hold that record
    because records are path-keyed, so the choice is a function of the unordered claim
    set plus committed state and is identical under COLD, WARM and HOT. Renaming whichever
    claimant the cache withheld was rejected: it can rename a file the user has been
    syncing for months to make room for a newly appeared duplicate.'
  adr_refs:
  - adr-rename-target-and-discriminator
  contract_refs:
  - contract-no-loss-remediation
- decision_input_ref: decision-input-rename-discriminator
  disposition: Closed as "id-" plus the renamed claimant's stable id, passed to the
    existing insertConflictSuffix (conflict.ts:60-67), which already accepts a string.
    It is the object's own identity, so the target is a function of the unordered
    claim set and stable across retries, making the rename idempotent; it needs no
    content fetch and is meaningful for a folder; and it can never match directConflictCandidateHint's
    [0-9a-f]{64} preservation form, so a disambiguated object is never acquired as
    a preserved version. A sequence number was rejected because assignment among several
    losers depends on iteration order, which RB-CHK-003 forbids; the content SHA-256
    was rejected because it requires fetching content the cycle has not read and a
    folder has no content.
  adr_refs:
  - adr-rename-target-and-discriminator
  contract_refs:
  - contract-no-loss-remediation
milestones:
- id: arbitration-owner
- id: cache-single-owner
- id: drain-settlement
- id: absence-authority
- id: provider-rename
- id: contention-remediation
- id: user-signal
- id: conformance
reference_algorithms: []
---

<!-- lifecycle is owned by change.md -->

# Implementation

## Content

### Shape of the change

Five moves. Each is a separate unit and the order below is the dependency order.

1. **A single arbitration owner for derived addresses** — a new pure module.
2. **Assignment computed over the evidence unit's whole claim set** in `AbstractMetadataCache`,
   with every displacement returned rather than performed silently.
3. **Drain accumulation and unit-end settlement** in the shared id-delta applier.
4. **One attribution rule at all three producers of `deleted`** in `CachingRemoteFs`.
5. **Upstream repair** — an identity-addressed provider rename, authorized by a new Admission
   stage, with the cycle checkpoint-blocked until the repair lands; plus the user signal.

### unit-1 — the arbitration owner

New: `src/fs/caching/address-arbitration.ts`, `src/fs/caching/address-arbitration.test.ts`.

One exported pure function over `(contended path, incumbent claim, arriving claim)` where a claim
is `(stable id, PathAuthority)`. Rules, in order: equal ids yield `no_contest`; `actual_resolved`
is admitted over `requested_echo`; otherwise the lexicographically smallest stable id is admitted.
The outcome additionally carries whether the losing claim is eligible for a provider remediation —
a `requested_echo` claim is not, because it addresses an object whose parent chain does not reach
the bound sync root.

Holds no state, no client, no logger and no `TFile` type parameter, and imports no backend type
and no sync-state type. That is what makes "one owner, a pure function of the claim set" checkable
from its imports, and it lets permutation invariance be tested without constructing a cache.

**Why the tie-break's arbitrariness is acceptable:** under this remedy both objects survive and
both sync, so the arbiter decides only which address each ends up at. Oldest creation timestamp
would be better motivated but needs a new per-backend seam that does not exist uniformly across
the three families.

**Inputs that are not available to it:** arrival order (`RB-CHK-003`), checkpoint incumbency,
database version, record count, prior errors (`AGENTS.md`'s COLD/WARM/HOT sameness rule), `mtime`
(sentinel 0 on folders), local sync state (the cache holds none and must not acquire any — the
committed `SyncRecord` is an Admission-level input and is read there), and a provider probe
(`RB-INV-001`).

### unit-2 — claim-set assignment in `AbstractMetadataCache`

Touches: `src/fs/caching/metadata-cache.ts`, new `src/fs/caching/metadata-cache.test.ts`,
`src/fs/googledrive/metadata-cache.test.ts`.

- `setFile` (`:99`) returns the displacement when its occupant branch (`:110-116`) evicts a
  different id, instead of returning `void`. Its behaviour is otherwise unchanged, so the
  `requested_echo` re-key guard at `:104-109` and the Dropbox path are untouched. Collect
  descendants before `removeTree`, the pattern `id-delta.ts` already uses.
- `buildFromFiles` (`:246-272`) gains a grouping pass between resolution and `bulkLoad`: group the
  resolved claims by path, arbitrate every path with more than one claimant, propagate the loss
  down the **resolved parent-id ancestry** (not by string prefix, and not by what happens to be
  indexed), and bulk-load only the survivors. Return the accumulated facts.
- `bulkLoad` (`:155-173`) returns the facts `setFile` produced. Its duplicate-stable-id throw keeps
  exactly its current message and breadth; no path-duplication throw is added.
- `applyFileChange` (`:390-416`) arbitrates before `setFile` when the resolved path is held by a
  different live id, and returns enough for its caller to record a withheld claimant.

`resolveFilePathCached`'s bare-name fallback (`:310-328`) is **kept**. Making it decline would
leave the entry with no cache record while it is still in the pre-scan snapshot, so `diffById`'s
sweep at `remote-fs.ts:429-431` would convert it into `checkpoint_deleted` and `delete_local` — a
new instance of the harm this change removes — and would break what
`googledrive/metadata-cache.test.ts:410-421` pins. The guess already carries `requested_echo`, so
the arbiter's authority tier demotes it in every listing order without either resolver changing.

`googledrive/metadata-cache.test.ts:704-717`, which currently pins the silent displacing behaviour,
is updated to assert the announced outcome.

**Public-contract impact.** `setFile`, `bulkLoad` and `buildFromFiles` are public methods of
`AbstractMetadataCache`. `DropboxMetadataCache.buildFromFiles` (`dropbox/metadata-cache.ts:147-154`)
overrides the base and is a second implementer; `CachingRemoteFs.fullScan` (`:198`) and
`loadFromCache` (`:235-236`) are the two production callers of `bulkLoad`. Widening a `void` return
is source-compatible, so a caller that ignores the value still compiles — which is what Dropbox
does deliberately.

**Dropbox is deliberately untouched.** Its address *is* the provider key (`extractId` is
`entry.id ?? entry.path_lower`, `dropbox/metadata-cache.ts:51`), so a second id at one address is
provider topology, not a contention, and `setEntry`'s path-keyed last-write-wins eviction is the
correct reading. Folding it into the shared arbiter reverses what
`dropbox/metadata-cache.test.ts:92-98` and `:100-116` pin and leaves the cache permanently stale
after a genuine delete-then-recreate, with no drain-end settlement to recover, because Dropbox
never runs `applyIdDeltaPage`. The separation is enforced by **placement** — arbitration is invoked
where derived addresses are composed, which Dropbox overrides or never reaches — not by a
per-backend predicate, which is PR #83's closed shape.

**`rewriteChildPaths` is left alone.** It propagates an address already decided rather than
assigning one, and all five callers compensate for its missing occupant check today
(`googledrive/index.ts:258-270`, `onedrive/index.ts:227-236`, `dropbox/index.ts:255-270`,
`dropbox/incremental-sync.ts:210-220`, and `setFile`'s own occupant branch before `:128`). Any new
caller inherits that obligation.

### unit-3 — drain accumulation and unit-end settlement

Touches: `src/fs/caching/id-delta.ts`, new `src/fs/caching/id-delta.test.ts`.

`IdDeltaResult` gains two per-call collections alongside `changedPaths`, `renamedPaths`, `count`
and `enteredFolderIds`: displacements, and withheld claimants held for the unit. Both are
bookkeeping in exactly the sense `enteredFolderIds` already documents (`83fd2aa`) — discarded with
the call, never persisted, never read by the cache.

`applyEntry` accumulates displacements and **separates the two causes of `applyFileChange`
returning null**: the old path is reported deleted for a genuine out-of-root move (its comment is
explicit, and suppressing it strands a local orphan with a live `SyncRecord`), and displaced only
when the entry's resolved parent id is in this unit's displacement set. The discriminator is a
current fact of the cycle, never a stored marker.

Settlement runs after the last page and **before** the caller's `relistTargets` walk
(`googledrive/incremental-sync.ts:76-78`), so a folder admitted at settlement enters
`enteredFolderIds` and gets its subtree re-listed. A tombstone for the admitted id later in the
same drain withdraws the contention before publication — which is also the answer to
`unknown-single-upsert-distinguishability`: a single upsert need not distinguish a genuine second
object from a re-key, because the unit's close does.

### unit-4 — one attribution rule at all three producers of `deleted`

Touches: `src/fs/caching/remote-fs.ts`, `src/fs/interface.ts`,
`src/fs/caching/remote-fs.contract.test.ts`.

The three producers, enumerated completely:

1. `remote-fs.ts:374-387` — `_applyIncrementalChanges`' `hasFile` split over `changedPaths`.
2. `remote-fs.ts:429-431` — `diffById`'s vanished-id sweep, the cursor-expiry route, and the one
   measured to reach `delete_local`.
3. `id-delta.ts`'s `oldPath && !newPath` branch, which feeds `changedPaths` and therefore
   producer 1.

A path whose absence is attributable to a displacement decided in this unit is excluded at all
three. For producer 2 the carrier is declared: `buildFromFiles` returns the facts and `fullScan`
(`:186-202`) passes them to `fullScanWithDelta` → `diffById`. `RemoteDelta` (`:17-21`),
`IncrementalChangesResult` (`:24-26`) and `IncrementalCheckpoint.getChangedPaths`
(`interface.ts:127-137`) widen to carry them. Everything stays inside `cacheMutex.run`;
`abortWorkingView` (`:317-325`) and `commitCheckpoint` (`:266-273`) are unchanged.

### unit-5 — the identity-addressed rename seam

Touches: `src/fs/interface.ts`, `src/fs/googledrive/index.ts`, `src/sync/types.ts`,
`src/sync/plan-executor.ts`.

`IFileSystem.rename(oldPath, newPath)` (`interface.ts:94`) is path-addressed, and the object to
rename is precisely the one with no cache path — that is what being withheld means. Renaming the
addressable claimant instead would leave the withheld one with nothing to re-announce it. So:

- `IFileSystem` gains an **optional capability** for renaming a provider object by stable id, in
  the shape `checkpoint` already uses (`remoteFs.checkpoint` is consulted for presence at
  `remote-change-source.ts:28`). Google Drive implements it; no other backend does. This is not a
  predicate on backend identity and adds no branch to the backend-agnostic base.
- `RenameAction` gains an optional provider-identity input. No `SyncActionType` is added.
- `plan-executor.ts:383-384` currently throws for a `rename_remote` that omits its admitted
  execution inputs; it gains the branch for a remote-only namespace repair, which has no local
  counterpart and no baseline. `RecordPublication` already excludes `rename_remote`
  (`types.ts:222-224`), so no record publication is owed. Descendants of a renamed folder are not
  remapped locally, because none are synced; they arrive through the next cycle's relist.
- The cache is updated only from the rename's successful endpoint, with provider authority —
  `AGENTS.md`: *"Only provider-resolved metadata, or the successful endpoint of an explicit
  provider rename, may change cached topology."* The addressing itself is sanctioned by *"Exact
  source/destination CAS is storage mechanism, not identity policy."*

There is **no** silent path-addressed fallback for this action shape: it would rename the keeper.

### unit-6 — the remediation stage and the commit gate

New: `src/sync/plan-admission-address-contention.ts` and its test. Also touches
`src/sync/orchestrator.ts`.

A sibling of `plan-admission-case-alias.ts`, which is the existing precedent for Admission
originating a `rename_remote` from complete current-cycle facts rather than from a local rename
(`:105`, `:157`).

- **Remediable** only when both claims are provider-resolved *and* the rename capability is
  present. A contention involving a `requested_echo` claim is not remediable: the guessed claimant
  is outside the bound sync root, Air Sync's working area does not reach it, and nothing there is
  at risk.
- **The keeper** is the claimant holding a committed `SyncRecord` at the contended path; if neither
  holds one, the claimant the arbiter admitted. At most one claimant can hold that record because
  records are path-keyed, so the choice is a function of the unordered claim set plus committed
  state and is identical under COLD, WARM and HOT. `AGENTS.md` permits a decision to depend on a
  component's current endpoints and its committed `SyncRecord`; it forbids prior errors, Admission
  failures, database version, record count and recovery markers. That is why this input is
  legitimate here and refused inside the cache — and it is what keeps a user's established file
  from being renamed to make room for a newly appeared duplicate.
- **The target address** is `insertConflictSuffix(contendedPath, "id-" + <the renamed claimant's
  stable id>)`. `insertConflictSuffix` (`conflict.ts:60-67`) already accepts a string. The
  discriminator is the object's own identity, so the target is a function of the unordered claim
  set, is stable across retries (the rename is idempotent), needs no content fetch, and is
  meaningful for a **folder** — which the SHA-256 form is not. It can never match
  `directConflictCandidateHint`'s `[0-9a-f]{64}` (`:72-84`) because `i` is not a hex digit, so a
  disambiguated object is never acquired as a preserved conflict version. A sequence number was
  rejected: assignment among several losers depends on iteration order, which `RB-CHK-003` forbids.
- **The commit gate.** When a remediation is owed the cycle is checkpoint-blocked.
  `sync-cycle-finalization.ts:47` already takes `checkpointBlocked` as an input to cleanliness,
  `:74` commits only when clean, and `:81-84` abort otherwise. No new completion kind and no new
  lifecycle is introduced. A non-remediable contention owes nothing and does **not** block.

### unit-7 — the user signal

Touches: `src/sync/remote-change-source.ts`, `src/sync/change-detector.ts`,
`src/sync/orchestrator.ts`, `src/sync/sync-notification.ts`, `src/main.ts`.

The contention facts travel by the pattern already used for exactly this shape: `getRemoteChanges`
(`remote-change-source.ts:24-42`) already takes an `onIdentityEvidence` callback and calls it. A
sibling optional callback carries the contentions to the orchestrator without adding a field to
`RemoteChanges`, `ChangeSet` or `sync-cycle-planning.ts`, which does not carry arbitrary extras
through today. The orchestrator hands them to Admission, puts the count on `SyncCycleOutcome` for
`buildNotificationMessage`, and passes it to `onStatusChange` for the status bar.

Three levels: a bounded `logger.warn` at the arbitration seam naming the path, both stable ids and
the disposition (one line per contended address, never per descendant); a non-error clause in the
cycle summary following `buildNotificationMessage`'s counts-only idiom (`sync-notification.ts:34-45`);
and the status-bar count, which is the only surface a user who changed no settings sees.

### unit-8 — shared contract conformance

Touches: `tests/fs/contracts/caching-remote-fs.contract.ts`,
`tests/fs/remote-backend-contracts.test.ts`, and the three `caching-remote-fs.contract-harness.ts`
files. See the verification member for the case list and the per-family obligation.

### Test seams

- **`address-arbitration.ts`** is a pure function: no seam needed, driven directly.
- **`AbstractMetadataCache`** is abstract; fixtures are built through a minimal in-test subclass.
  `src/fs/caching/metadata-cache.test.ts` and `src/fs/caching/id-delta.test.ts` do not exist today —
  the shared cache and the shared applier have no unit tests at all
  (`docs/issue/issue-20260916-no-shared-contract-pins-enumeration.md`). These are the first.
- **`CachingRemoteFs`** is already exercised by `src/fs/caching/remote-fs.contract.test.ts`.
- **The rename capability** is optional on `IFileSystem`, so a test double supplies or omits it —
  which is also how "a backend without the capability receives no such action" is asserted.
- **The Admission stage** is a pure function of `(contentions, committed records, capability
  presence)`; the keeper rule is driven from a seeded `SyncStateStore` rather than from arrival
  order.
- **Per-family collision staging** goes on `CachingRemoteFsHarness`
  (`caching-remote-fs.contract.ts:10-44`) alongside the existing `seedFolderWithChild`,
  `stageRemoteDelete`, `failNextDeltaAfterFirstPage` and `stageMoveIntoRoot` seams — test
  infrastructure under `tests/fs/`, not a production capability hook.

### Implementation order

`unit-1` → `unit-2` → `unit-3` → `unit-4` → (`unit-5`, then `unit-6` which depends on both `unit-4`
and `unit-5`) → `unit-7` → `unit-8`.

### Delegated implementation choices

Three, all private, local, reversible and mechanically verifiable; each preserves its owning
contract and escalates if it would cross a boundary.

| choice | scope | escalate when |
|---|---|---|
| How the arbitration outcome is spelled as a type | `src/fs/caching/address-arbitration.ts` | it needs a backend-specific fact or `TFile`; it cannot express `no_contest` / `admit_incumbent` / `admit_claimant` plus remediation-eligibility without a default branch; it forces a caller outside `src/fs/caching/` to change |
| How the displacement accumulator threads through `setFile`'s private index helpers | `src/fs/caching/metadata-cache.ts` | it needs a new instance field; any displacement survives its call; a public signature other than `setFile`/`bulkLoad`/`buildFromFiles` must change |
| How withheld claimants and displacements are held inside `IdDeltaResult` for one drain | `src/fs/caching/id-delta.ts` | the shape must outlive the drain; settlement order changes which claimant is admitted at a still-contended address; it needs a field on the cache or the filesystem |
| The exact noun and phrasing for the contended clause | `src/sync/sync-notification.ts` | the wording implies data was deleted; conveying it needs a `Notice`, a modal or a new setting; the count must come from anything but the cycle's own report |
