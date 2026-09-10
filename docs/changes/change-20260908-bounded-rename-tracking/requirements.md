---
change: change-20260908-bounded-rename-tracking
role: requirements
---

<!-- lifecycle is owned by change.md -->

# Requirements

## Scope and vocabulary

A **current occurrence** is an included file version that the existing observation surface can independently enumerate, resolve to an exact/provider path, stat, and read. A **distinct exact byte version** is an equivalence class proven by `SHA-256 + size` from current bytes; timestamps, spelling similarity, provider identity, and unlike checksums do not establish equality. An **observed collision group** exists only when current alias resolution positively joins current paths; provider normalization is never inferred. Its anchor `P` is the lexicographic minimum UTF-8 byte sequence among those current alias-resolved paths. A version has exactly one **content-addressed sibling**, `insertConflictSuffix(P, fullSha256)`. A **preservation cover** is clean when every distinct exact byte version has that verified sibling on both sides and eligible abandoned records have been removed by exact CAS. Original paths need not become symmetric.

## Functional requirements

### FR-BRT-001 — Unique proof retains native rename

When complete current facts prove one unique exhaustive identity relation and the existing content decision authorizes it, the system shall use the existing native rename or rename-plus-write protocol and shall not create a preservation cover.

### FR-BRT-002 — Readable ambiguity abandons relation

If all required current occurrences are observable, readable, byte-comparable, scoped, and revalidatable but relation evidence is contradictory, partial, non-unique, or non-exhaustive, the system shall abandon that relation instead of returning a permanent rename or folder-mapping error solely for the relation defect.

### FR-BRT-003 — Positively distinct paths remain ordinary

When current exact/provider-resolved facts positively identify separate occurrences and do not expose an alias collision, the system shall preserve each exact path through existing push, pull, match, and same-exact-path conflict behavior. Equal bytes at distinct exact paths shall not collapse path obligations or prove a rename.

### FR-BRT-004 — Observed collision selects one cover

When current alias resolution positively exposes a collision between two or more otherwise readable occurrences, Admission shall emit exactly one typed `preservation_cover` conflict for the closed component. It shall not select a winner, overwrite an original, infer provider normalization, or reuse prior alias evidence.

### FR-BRT-005 — Exact bytes define cover obligations

Within one observed collision group, the system shall create one cover obligation for each distinct exact byte version. Equal bytes may share one cover child inside that group; equal bytes at positively distinct paths remain separate ordinary path obligations.

### FR-BRT-006 — No timestamp or weak-equality fallback

The system shall not use mtime, size alone, path similarity, casing, Unicode normalization, prior failures, or unlike provider checksums to select, merge, or discard a version. Unknown exact-byte equality shall be incomplete observation.

### FR-BRT-007 — Content-addressed candidate allocation

In one Admission build, the system shall derive `P` as the minimum UTF-8 bytes of the current alias-resolved paths and derive exactly one candidate per exact byte version as `insertConflictSuffix(P, fullSha256)`. There is no ordinal, family, frontier, timestamp, truncated digest, or alternate candidate. Candidate enrichment freezes facts only. A same-byte candidate shall be absorbed and its endpoint facts unioned with the version obligation. A candidate containing different bytes shall remain an independent ordinary component and provide only a read-only occupancy witness that makes the cover fail `preservation_destination_unavailable`.

### FR-BRT-008 — Fixed child protocol and immediate preflight

Each cover child shall fix its source witness, exact-byte witness, candidate path, expected endpoints, ordered missing-side writes, two-sided terminal proof, and publication contract. Immediately before every ordinary or cover write, Execution shall authoritatively stat the destination and require the admitted expected vacancy or exact candidate. It shall not reroute to another suffix.

Candidate identity shall keep the deterministic requested address distinct from each side's actual resolved endpoint and from the `SyncRecord` baseline keyed by the requested address. Terminal proof requires actual-resolved endpoint authority and exact bytes on both sides; a requested-path echo is not publishable proof.

### FR-BRT-009 — Partial progress preserves a verified prefix

When a child effect, precondition, terminal proof, or publication fails, the system shall retain already verified and published children, block the remaining component suffix, keep the cycle non-clean, and leave the remote checkpoint unchanged. Once that cycle has a terminal partial result, orchestration shall abandon exactly its captured file/folder rename reports because those relations are cycle evidence rather than retry state, while retaining captured dirty paths so failed same-metadata content changes remain eligible for HOT retry. Retry shall re-observe current endpoints against the unchanged durable checkpoint and perform only missing work. Relation reports recorded after the captured snapshot shall survive generation-aware abandonment.

A child whose two candidate endpoints are already byte-exact but whose `SyncRecord` publication did not complete shall retry that publication against the authoritatively observed absent baseline; it shall not become a permanent destination-unavailable error.

### FR-BRT-010 — Current facts recognize the cover fixed point

When every required exact byte version has its single verified two-sided content-addressed sibling and no other work remains, Admission shall return `resolved_no_action` even if original path spellings remain asymmetric. Repeated unchanged sync shall create no additional sibling.

### FR-BRT-011 — Exact stale-record cleanup

Cleanup may delete a record only when all current-fact predicates hold: its captured baseline key/value is exact; it lies in the abandoned original footprint of the current closed collision group; it is not the selected single-version candidate; it is not a current same-exact-path terminal pair; and no current ordinary exact-path action retains it as its baseline. A foreign different-byte candidate remains an independent ordinary component and its record is never cleanup input. Cleanup shall use exact `compareAndDelete`. Resulting absence shall never authorize a file deletion.

### FR-BRT-012 — Existing conflict route remains authoritative

`preservation_cover` shall travel through the existing conflict capture, executor, terminal-proof, per-child `StateCommitter`, finalization, notification, and audit-history route. The resolver shall capture only and shall not mutate originals or choose policy.

The terminal result and audit record shall expose every preserved candidate in child order. The existing singular duplicate path remains the first item for backward compatibility; audit output is never recovery authority.

### FR-BRT-013 — Admission owns complete component closure

`plan-admission-graph` shall build once from frozen current exact facts, current alias resolution, baselines, relation edges, action/publication footprints, exact-byte partitions, and single candidate facts. It shall add an edge to a candidate only when that candidate proves the same exact bytes; different-byte occupancy is a read-only witness and remains an independent ordinary component. Unrelated conflict-looking files remain ordinary. Every current path shall belong to exactly one component before actions exist; no iterative frontier or alternate build exists.

### FR-BRT-014 — Acquisition temperature is irrelevant

COLD, WARM, and HOT acquisition shall produce the same Admission result for the same frozen component facts. Prior error, recovery markers, database version, and global record count shall not influence the decision.

HOT shall not classify an identity component that has a current file occurrence but no committed baseline from its partial view. It also shall not treat a locally dirty, unbaselined address that is absent at both address-local stats as complete, because that address may be an abandoned folder-relation root whose descendants require breadth. It shall reuse the already acquired remote delta and promote the attempt to WARM acquisition. Promotion shall compose the exact dirty-path observations already acquired by HOT with WARM breadth; it shall neither fetch the delta twice nor replace stronger exact/hash facts with listing metadata. Conflicting observations make the attempt non-clean. Folder rename capture shall mark both root endpoints dirty without enumerating descendants.

### FR-BRT-015 — Actual observation or effect failure stays non-clean

If a required occurrence cannot be independently enumerated, resolved, statted, read, byte-compared, scoped, or revalidated with existing capabilities, Admission shall not claim preservation. Multiple provider objects at the same path that cannot each be enumerated and addressed are an actual observation failure. Authentication, I/O, mutation-precondition, terminal-proof, and publication failures remain non-clean.

### FR-BRT-016 — Observation freezes facts only

Observation may perform targeted list/stat/read/hash enrichment through existing APIs and shall freeze current exact/alias facts, exact-byte evidence, scope, and the single candidate occupancy for each potential current alias anchor and digest. Candidate enrichment is fact-only: it shall not connect candidates to components, select `P`, classify an action, or carry proposed work. Admission consumes that immutable snapshot once without filesystem I/O. If inclusion/exclusion of a required candidate cannot be established, the cover fails `preservation_destination_unavailable`.

Each frozen candidate fact shall carry one requested candidate address, authoritative per-side observations including actual resolved paths, and the current baseline lookup result for that requested key. Candidate records and digest-shaped names may seed bounded re-observation of their base, but do not authorize a cover; fresh alias resolution and current exact bytes remain required.

### FR-BRT-017 — Latent collisions converge in two cycles

If immediate pre-write authoritative stat reveals an occupant or alias not present in the admitted snapshot, Execution shall stop before that write effect, preserve the successful component prefix, block its suffix, and leave the checkpoint unchanged. It shall not convert policy in the same cycle. The next ordinary sync shall freshly observe current facts. For an ordinary exact-path write, a foreign-byte occupant at that exact path enters existing same-path conflict, while only a different path joined by current-cycle alias resolution enters `preservation_cover`. For an observed-absent cover candidate, newly observed same bytes are absorbed and newly observed different bytes remain ordinary while the group fails `preservation_destination_unavailable`. Continued inability to expose each occurrence independently remains FR-BRT-015.

### INV-BRT-001 — Durable authority remains closed

Only a successful action's `SyncRecord` and a wholly clean cycle's remote checkpoint plus derived cache/scope snapshot are durable correctness publications. Evidence, dispositions, pending work, failure reasons, and history shall not become authority.

## Non-functional requirements

- **NFR-BRT-001 — Reliability:** collision classification shall rely only on affirmative existing exact, alias, provider-resolved, stat, read, and exact-byte facts. No generic casing/Unicode/provider-normalization heuristic or new filesystem semantics contract may substitute for missing facts.
- **NFR-BRT-002 — Boundedness:** one frozen observation feeds one Admission build with one candidate per exact byte version. No ordinal, family scan, frontier, alternate candidate, iterative build, DAG, or recovery queue is allowed.
- **NFR-BRT-003 — Responsibility:** Observation alone performs list/stat/read/hash enrichment. Admission and `plan-admission-graph` shall neither receive filesystem capabilities nor invoke filesystem operations. Execution alone owns immediate pre-effect destination stat and may only validate, stop, or execute the admitted path.
- **NFR-BRT-004 — Compatibility:** no `IFileSystem` method, backend implementation, shared backend contract, setting, schema, or migration shall change.
- **NFR-BRT-005 — Audit only:** notification and conflict history may describe one cover conflict and child outcomes but shall never be read by Observation, Admission, Execution, or publication.

## Acceptance criteria

- **AC-BRT-001:** ambiguous relation between positively distinct `Old.md:R` and `New.md:L` becomes ordinary exact-path actions and reaches a clean fixed point.
- **AC-BRT-002:** one observed alias collision containing exact bytes A, B, and C computes `P` by minimum UTF-8 bytes and creates three `insertConflictSuffix(P, fullSha256)` children, verifies all on both sides, and repeats with no new output.
- **AC-BRT-003:** A/A/A inside one observed collision creates or reuses one full-digest A sibling, while equal bytes at positively distinct exact paths remain distinct ordinary files.
- **AC-BRT-004:** a same-byte single candidate is absorbed and unions endpoint facts. Foreign different bytes at that exact candidate remain an independent ordinary component and make the cover `preservation_destination_unavailable`; no alternate is selected. Unrelated conflict-looking files remain ordinary.
- **AC-BRT-005:** interruption after child B publication retains A/B, leaves checkpoint unchanged, abandons the terminal cycle's captured relation reports while retaining dirty paths, and retry creates only missing C from fresh current facts. A relation event arriving after capture remains pending, and a failed equal-mtime/equal-size content edit is retried rather than silently accepted.
- **AC-BRT-006:** unknown exact bytes or unaddressable same-path provider duplicates produce a non-clean observation error with no original mutation.
- **AC-BRT-007:** a complete cover with asymmetric originals is clean only after exact eligible stale-record cleanup; repeated sync produces no delete or new sibling. COLD, WARM, and a HOT wake-up containing any subset of original paths plus unrelated changes reconstruct the same no-action cover component; the remote delta is acquired once and exact dirty facts survive HOT-to-WARM promotion.
- **AC-BRT-008:** unique rename, same-exact-path conflict, and exclusion behavior remain unchanged; only a same-byte single candidate edge joins the collision component, and unavailable candidate scope is `preservation_destination_unavailable`.
- **AC-BRT-009:** cleanup retains current terminal-pair records, the selected candidate, every foreign independent ordinary record, and a one-sided ordinary action's retained baseline; report loss does not change the current-fact predicate, and cleanup absence creates no delete authority.
- **AC-BRT-010:** cycle 1 plans an ordinary write but pre-write stat exposes a latent occupant; it performs no write at that destination, preserves its prior successful prefix, and leaves checkpoint unchanged. On cycle 2, fresh current-cycle alias resolution joining a different path creates or reuses the required cover, while a foreign-byte occupant at the same exact path uses the existing same-path conflict flow and creates no preservation cover. An independently unobservable duplicate remains FR-BRT-015. After the selected flow completes, the next unchanged sync is `up_to_date`.
