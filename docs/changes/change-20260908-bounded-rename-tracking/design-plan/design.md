# Conservative preservation cover for relational ambiguity

This adopted design changes no code by itself. Requirements live in [requirements](../requirements.md), observable flows in [UX](../ux.md), implementation contracts in [implementation](../implementation.md), and exact traceability in [spine](spine.yaml).

## Decision

Rename identity is an optimization, not a prerequisite for convergence. Admission keeps native rename only for one unique complete relation. Otherwise it uses the existing observation surface:

- positively separate exact/provider-resolved occurrences use existing ordinary exact-path actions;
- an affirmative current-cycle alias collision uses one typed `preservation_cover`;
- unavailable required occurrences or exact bytes remain actual observation failures.

There is no new `IFileSystem` or backend contract and no attempt to predict a provider's casing, Unicode, or normalization rules. A collision not exposed in the admitted facts is handled as an ordinary write until Execution's immediate authoritative destination stat proves its precondition false.

## Alternatives

| Alternative | Decision |
|---|---|
| Fail every unproved relation | Rejected: complete readable ambiguity repeats a permanent error. |
| Add provider-root normalization/address APIs | Rejected: providers cannot necessarily expose operation-complete equivalence, and the extra contract would claim knowledge the implementation does not have. |
| Guess collision keys by lowercasing/Unicode normalization | Rejected: false merges and backend divergence. |
| Select newest content or a canonical spelling | Rejected: neither establishes ownership and either can lose readable data. |
| Convert a failed write to another path in the same cycle | Rejected: mutates admitted policy and makes retries grow output. |
| Stop before effect, then re-observe | Adopted: preserves the successful prefix and lets fresh facts select same-path conflict, a different-path alias cover, or observation failure without new durable recovery state. |

## Responsibility flow

```text
existing exact/alias/provider-resolved + stat/read facts
                         |
Observation: frozen current aliases, SHA-256 + size, scope, one candidate occupancy
                         |
Admission: finite closure and one protocol per component
                         |
Execution: authoritative pre-write stat and fixed child effects
                         |
StateCommitter: per-child exact publication
                         |
Finalization: wholly clean checkpoint last
```

Observation owns all targeted filesystem enrichment but no decision. Admission owns one graph build, exactly-one component membership, current-alias collision authority, deterministic anchor `P`, byte-version partition, same-byte candidate union, foreign occupancy failure, and action selection. Execution owns the final absent-candidate precondition check. The resolver captures only. State publication remains per successful child; history remains audit-only.

`CandidateFact` keeps a requested candidate address separate from per-side actual resolved endpoints and from the baseline keyed by the requested address. Managed candidate records and digest-shaped names may seed bounded base acquisition, but only fresh alias resolution plus current exact bytes can authorize a cover. They are not recovery markers.

HOT does not decide an identity component containing current occurrences and no committed baseline from its partial view. Nor does it treat a locally dirty, unbaselined address that is absent at both address-local stats as complete: folder rename capture marks both roots dirty, and after a partial cycle abandons the relation those roots trigger WARM breadth to rediscover descendants. Promotion reuses the already acquired remote delta and composes exact dirty-path facts. This makes acquisition temperature and unrelated dirty paths irrelevant without adding full remote tracking.

## Decision partition

| Frozen component facts | Admission result |
|---|---|
| One unique complete relation | Existing native rename protocol |
| Ambiguous relation; separate exact/provider occurrences | Existing ordinary exact-path actions |
| Ambiguous relation; affirmative current-cycle alias collision | One typed `preservation_cover` |
| Required occurrence/read/hash/scope unavailable | Non-clean observation failure |

No collision fact is inferred from mere spelling similarity. Conversely, once affirmative facts expose a collision, original paths are not treated as independent write destinations.

## Finite component closure

`plan-admission-graph` builds once from frozen current occurrences, current alias edges, captured baselines, action/publication footprints, byte partitions, and direct candidate facts. It selects `P` as the minimum UTF-8 bytes among current alias-resolved paths. For each full digest it considers only `insertConflictSuffix(P, fullSha256)`: matching bytes add one edge and union endpoint facts; different bytes add no edge, remain an ordinary component, and provide a read-only occupancy witness that fails the group with `preservation_destination_unavailable`. Each path belongs to exactly one component. There is no family closure, ordinal, frontier, alternate, or second build.

Folder ambiguity includes only observed in-scope file occurrences. It does not invent empty directories or unobserved descendants.

## Exact-byte preservation cover

Within one observed collision, immutable `SHA-256 + size` partitions exact byte versions. `unknown` never equals a known version. Equal bytes may share a child inside that collision; equal bytes at positively distinct exact paths retain separate ordinary path obligations.

The action is a discriminated conflict protocol containing current collision witnesses, fixed ordered `PreservationCoverChild` values, and exact cleanup entries. Each child fixes source bytes, candidate path, expected local/remote endpoints, missing-side write order, terminal proof, and publication. It contains no address-normalization key and grants no reroute authority.

The only candidate is `insertConflictSuffix(P, fullSha256)`. Same-byte terminals are absorbed and reused. Foreign bytes remain independent and make the destination unavailable; an unavailable destination scope has the same result. An observed-absent candidate is not trusted for mutation until executor stat immediately before the write again proves absence. A race stops before effect and the next fresh cycle classifies the now-current facts. No alternate path exists.

## Latent collision: two-stage convergence

Immediately before every ordinary or cover write, Execution authoritatively stats the admitted destination using the existing filesystem API.

1. If the admitted vacancy/exact endpoint still holds, the fixed effect may run.
2. If an unexpected occupant or alias appears, Execution records whether it is the same exact destination or a resolved alias/cross-path occurrence, stops before that write, retains the successful component prefix, blocks the suffix, returns a typed precondition failure, and does not advance the checkpoint.
3. It does not overwrite, reroute, allocate another suffix, or convert policy in that cycle.
4. The next normal cycle observes from scratch. For an ordinary-write race, a foreign-byte occupant at the same exact path uses existing same-path conflict; only a different path joined by fresh current-cycle alias resolution creates a cover.
5. For an absent-candidate race, newly observed matching bytes are absorbed; different bytes stay ordinary and make the group `preservation_destination_unavailable`. No alternate is selected.
6. If the provider cannot independently enumerate/address/read each occurrence, preservation is unprovable and remains an FR-BRT-015 observation failure.

This design guarantees conservative progress, not a clean first cycle for a previously latent collision.

## Publication, cleanup, and fixed point

Each child is terminal only after exact bytes are verified on both sides. `StateCommitter` publishes that child immediately against its captured baseline. Failure preserves the ordered successful prefix and blocks its suffix; the checkpoint commits only after a wholly clean cycle. Checkpoint publication, dirty-path retention, and relation-report abandonment are separate lifecycle decisions. Clean completion acknowledges the whole captured tracker snapshot. Terminal partial completion abandons only its captured, generation-checked file/folder rename reports and retains dirty paths. Thus a failed reported relation cannot become cross-cycle retry state, while a failed equal-mtime/equal-size content edit stays on HOT. The next invocation reconstructs relational work from current endpoints, retained successful `SyncRecord`s, and the unchanged checkpoint. Relation reports recorded after capture survive.

Terminal verification requires `actual_resolved` authority at the admitted endpoints; requested-path echo cannot be published. If both terminals were written but publication failed, a later attempt retries only the absent-baseline publication. The terminal conflict result records every candidate in child order while retaining the first path as the legacy singular projection.

Cleanup follows cover proof. A record is eligible only when its exact captured baseline remains current, its key is in the abandoned original footprint of the current closed collision, and it is not:

- the selected same-byte candidate;
- a current same-exact-path terminal pair; or
- retained as the baseline of a current ordinary exact-path action.

Deletion is exact `compareAndDelete`; absence never becomes file-delete authority. The current-fact predicate is identical when relation reports disappear on retry.

Once all byte versions have two-sided terminal covers and eligible stale records are gone, Admission returns `resolved_no_action` even if originals remain asymmetric. An unchanged run creates no new sibling.

The normative executable contract is C01–C09 in [implementation](../implementation.md); the spine maps every C-contract to its unit and test.

## Invariants

- Only a successful file action's `SyncRecord` and a wholly clean checkpoint are durable correctness publications.
- A terminal partial result withholds the checkpoint, abandons captured relation reports, and retains dirty paths; neither relation reports nor prior failures become retry authority.
- COLD, WARM, and HOT yield the same decision from the same frozen facts.
- No timestamp fallback, weak equality, winner selection, original mutation, or history-driven recovery.
- Cover proof precedes cleanup; immediate stat precedes every write effect.
- No code or backend contract is changed by this design package.

## Delivery order

1. Freeze existing observation facts and exact-byte evidence.
2. Implement Admission closure, decision partition, and typed cover protocol.
3. Implement cover execution and immediate pre-write stat for ordinary/cover writes.
4. Implement per-child publication, fixed-point recognition, and exact cleanup.
5. Update projections, guards, persistent design, and acceptance tests.
