---
change: change-20260908-bounded-rename-tracking
role: implementation
---

<!-- lifecycle is owned by change.md -->

# Implementation

## Adopted responsibility boundary

```text
existing list/stat/read + exact/alias/provider-resolved facts
                         |
Observation: freeze current alias facts, SHA-256 + size, scope, one candidate occupancy
                         |
Admission: finite closure -> unique relation / ordinary paths / typed cover
                         |
Conflict capture: current bytes only
                         |
Execution: immediate destination stat -> fixed child effects -> terminal proof
                         |
StateCommitter: publish each successful child -> exact stale-record cleanup
                         |
Finalization: wholly clean checkpoint last
                         |
Orchestration: abandon partial-cycle relations; retain dirty retry addresses
```

This change adds no `IFileSystem` method and changes no backend or shared backend contract. Observation may enrich a targeted occurrence with existing `list`, `stat`, and `read` operations, then freezes only facts. Admission and `plan-admission-graph` receive no filesystem capability. Execution owns the authoritative stat immediately before a write and may only execute or stop the admitted path.

HOT is only an acquisition optimization. If a HOT identity component contains a current file occurrence but no committed baseline, `hot-acquisition-completeness` promotes the attempt to WARM using the already fetched remote delta. The same promotion applies to a locally dirty, unbaselined address that is absent at both address-local stats: it can be an abandoned folder-relation root whose descendants require breadth. Folder rename capture therefore marks both roots dirty without enumerating descendants. `hot-warm-promotion` composes the exact HOT dirty-path facts with WARM breadth and rejects contradictions; it never silently replaces a content hash with weaker listing metadata.

## Contract 1 — Existing observation surface

`PathObservation` and current `FileEntity` facts remain the path evidence: exact, current alias-resolved, `present_unresolved`, `absent`, or `unknown`. Only current-cycle alias resolution may authorize a cover; cached or inferred provider normalization may not. Targeted reads produce immutable `SHA-256 + size | unknown`. From potential current alias anchors and full digests, Observation mechanically derives and freezes the one candidate path `insertConflictSuffix(P, fullSha256)` for each combination. This fact enrichment neither selects the admitted `P` nor adds graph edges. There is no ordinal, family inventory, or frontier.

Observation does not close components, choose an anchor, absorb a candidate, classify coexistence, or propose an action. Multiple provider objects that cannot each be independently enumerated/resolved/read are `incomplete_observation`.

`CandidateFact` is the sole attempt-local candidate carrier. It keeps the deterministic requested address, each side's absent/exact/alias observation and actual resolved endpoint, and the baseline lookup for the requested key together. A matching persisted candidate name may trigger bounded base re-observation, but neither that name nor its record is collision authority.

## Contract 2 — Admission closure and decision

`plan-admission-graph` performs one build from current endpoint facts, exact baselines, current alias edges, action/publication footprints, exact-byte partitions, and single-candidate facts. It selects `P` as the lexicographic minimum UTF-8 bytes of current alias-resolved paths. It adds a candidate edge only when the candidate proves the same exact bytes and unions those endpoint facts with the version obligation. A different-byte occupant remains an independent ordinary component and contributes only a read-only occupancy witness. Unrelated conflict-looking files remain ordinary. There is no second build or frontier.

For a closed component Admission applies this partition:

1. unique complete relation: existing native rename protocol;
2. relational ambiguity plus positively separate exact/provider occurrences: existing ordinary exact-path actions;
3. relational ambiguity plus an affirmative current-cycle alias collision: one `preservation_cover`;
4. unavailable required occurrence or exact-byte evidence: non-executable observation failure.

Absence of collision evidence is not proof of provider normalization semantics; it permits only the ordinary action whose destination will be revalidated by Execution.

## Contract 3 — Exact byte partition and content-addressed siblings

Inside one observed collision, Admission partitions sources by immutable `SHA-256 + size`; `unknown` never equals anything. One class creates one cover child. Positively distinct exact paths are not collapsed by equal content.

Each version has exactly one candidate: `insertConflictSuffix(P, fullSha256)`. A verified same-byte terminal is absorbed and reused. A different-byte occupant remains an independent ordinary component; its read-only occupancy witness makes the collision group fail `preservation_destination_unavailable`. Unknown destination scope yields the same failure. There is no alternate path, ordinal, family, frontier, timestamp, or digest truncation.

## Contract 4 — Typed preservation protocol

The conflict action is discriminated from existing same-path conflict behavior and contains no provider-normalization key:

```ts
type ConflictProtocol =
  | ExistingSamePathConflictProtocol
  | {
      readonly kind: "preservation_cover";
      readonly collisionWitnesses: readonly CurrentPathWitness[];
      readonly candidatePaths: readonly string[];
      readonly preservedPaths: readonly string[];
      readonly children: readonly PreservationCoverChild[];
      readonly cleanup: readonly ExactRecordCleanup[];
    };

type PreservationCoverChild = {
  readonly source: CurrentByteWitness;
  readonly content: { readonly sha256: string; readonly size: number };
  readonly candidatePath: string;
  readonly expectedLocal: FileEntity | null;
  readonly expectedRemote: FileEntity | null;
  readonly missingSides: readonly ("local" | "remote")[];
  readonly publication: ExactChildPublication;
};
```

`candidatePaths` fixes the complete child order for terminal projection. `preservedPaths`
contains only candidates proven two-sided and already published by the same current
facts; `children` contains only the remaining executable obligations. Both path arrays
are immutable attempt-local Admission output, not recovery state. Execution projects
the ordered intersection of `candidatePaths` with `preservedPaths` plus children that
publish successfully in this attempt.

The resolver captures/revalidates the declared source only. It never mutates an original, chooses a winner, allocates a suffix, merges cross-path content, or publishes state.

## Contract 5 — Immediate pre-effect destination stat

Immediately before every ordinary or cover write, `plan-executor` performs authoritative `stat(candidatePath)` through the existing filesystem API and compares it with the admitted expected vacancy or exact endpoint.

- the candidate was observed absent and authoritative stat still proves absence: execute the admitted write;
- an unexpected occupant or alias is exposed: record whether it is the same exact destination or a resolved alias/cross-path occurrence, then fail the precondition before effect, retain the successful component prefix, block the suffix, and keep the checkpoint unchanged;
- never overwrite, reroute, allocate another suffix, or convert the action to a cover in that cycle.

After the effects, both terminal stats must have `actual_resolved` authority, remain at the admitted actual endpoints, and prove the exact bytes. A `requested_echo` result is unresolved and blocks publication and checkpoint commit.

The next normal cycle discards all execution bookkeeping and re-observes. After an ordinary-write race, a foreign-byte exact-path occupant enters existing same-path conflict and only a different path joined by current-cycle alias resolution creates a cover. After an absent-candidate race, matching bytes are absorbed; different bytes remain ordinary and make the group `preservation_destination_unavailable`. If occurrences remain impossible to observe, the result is an actual observation failure.

## Contract 6 — Child publication and fixed point

For each pending child, Execution captures the source, revalidates source and destination, writes missing sides in fixed order, and proves exact bytes at the candidate on both sides. `StateCommitter` then publishes that child's exact terminal pair immediately. A later child failure retains the published prefix and blocks its suffix. Current-fact `preservedPaths` are not re-executed; they participate only in terminal projection. Parent publication consumes ordered successful child receipts; no registry, recovery queue, or rollback is introduced.

If both byte-exact terminals exist but the requested-key baseline is authoritatively absent because an earlier publication failed, the child performs no file I/O and retries `compareAndPut` against absence.

Admission recognizes `resolved_no_action` from current two-sided candidate facts even when originals remain asymmetric. Only after all cover obligations are terminal may cleanup run.

Cleanup admits an exact captured baseline only when it is inside the abandoned original footprint and is not the selected same-byte candidate, a current same-exact-path terminal pair, or a baseline retained by a current ordinary action. A foreign candidate occupant is an independent ordinary component and never cleanup input. Cleanup uses exact `compareAndDelete`; absence is never file-delete authority.

## Contract 7 — Result projection

One closed collision projects one user-visible conflict with ordered child outcomes, including a terminal partial result. `duplicatePaths` contains current-fact `preservedPaths` plus every child published in this attempt, filtered through the admitted `candidatePaths` order; legacy `duplicatePath` remains its first element. Notification and history consume terminal results only. No planning path reads history.

## Contract 8 — Terminal tracker consumption

The remote checkpoint, dirty paths, and relation reports have different roles and therefore different closeout rules. Only wholly clean completion commits the checkpoint and acknowledges the complete captured tracker snapshot. A terminal partial result abandons only the captured file/folder rename reports using endpoint-generation checks; it retains dirty paths so a failed content write remains on HOT even when mtime and size did not change. A relation report recreated after capture survives. Unfinished relational work is reconstructed from current endpoints, successful per-file publications, and the unchanged checkpoint.

## C01–C10 executable contract text

- **C01 — Current-alias authority:** only complete current-cycle alias resolution may form a preservation collision; cached, prior, casing, Unicode, or provider-normalization guesses may not.
- **C02 — Deterministic anchor:** `P` is exactly the lexicographic minimum UTF-8 byte sequence of the collision's current alias-resolved paths.
- **C03 — One direct candidate:** each distinct exact byte version has exactly `insertConflictSuffix(P, fullSha256)`; no alternate, ordinal, family, or frontier exists.
- **C04 — Fact-only enrichment:** Observation freezes candidate exact/alias/stat/read/hash/scope facts but carries no edge, action, anchor selection, or occupancy disposition.
- **C05 — One-build partition:** one Admission build partitions candidate state into same bytes, foreign bytes, absent, or unavailable scope/observation; it does not rebuild after classification.
- **C06 — Same-byte union:** a candidate with the required exact bytes joins the collision component and unions its current local/remote endpoint facts with that version obligation.
- **C07 — Foreign independence:** a different-byte candidate remains an independent ordinary component; its immutable read-only occupancy witness makes the preservation group fail `preservation_destination_unavailable`.
- **C08 — Absent preflight:** an observed-absent candidate may be written only after executor authoritative stat proves absence immediately before effect. A race stops before effect and is handled by the next fresh cycle; no alternate is selected.
- **C09 — Fixed point and publication:** exactly one verified two-sided candidate per byte version, per-child exact publication, cover-before-cleanup, and exact cleanup yield `resolved_no_action`; unrelated ordinary files and history never become preservation authority.
- **C10 — Partial relation abandonment:** a terminal partial cycle withholds the checkpoint, abandons only its captured relation reports, and retains dirty paths; later relation generations survive, stale relations cannot loop, and failed same-metadata edits cannot be lost.

## Dependency-ordered units

1. Freeze current alias/byte/scope facts and the one direct candidate occupancy per potential anchor/version.
2. Close Admission components and emit ordinary/cover protocols.
3. Execute fixed cover children and ordinary writes with immediate stat preflight.
4. Publish child prefixes, consume terminal cycle evidence, recognize the asymmetric fixed point, and clean stale records.
5. Project results and promote design documentation.

The implementation is carried by the change scope and is accepted only with the verification evidence recorded in `verification.md`.
