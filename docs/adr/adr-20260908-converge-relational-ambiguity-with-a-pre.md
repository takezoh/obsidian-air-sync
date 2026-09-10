---
id: adr-20260908-converge-relational-ambiguity-with-a-pre
kind: adr
title: Converge relational ambiguity with a preservation cover
status: accepted
created: '2026-09-08'
decision_makers:
- project owner
consequences:
  positive:
  - Completely readable versions can converge without a proven rename or recovery
    workflow.
  - Collision handling preserves exact byte versions without a timestamp, content
    winner, or provider-normalization guess.
  - No filesystem/backend contract expansion is required.
  negative:
  - An occupant first visible at pre-write stat requires a non-clean cycle before
    fresh observation can select same-path conflict or a different-path alias cover.
  - Original local and remote topology may remain asymmetric after a clean cycle.
  - Provider duplicates that cannot each be independently observed remain errors.
  neutral:
  - Existing same-path conflicts, two durable authorities, configured scope, and checkpoint-last
    lifecycle remain.
confirmation: Admission partition and closure tests; exact-byte cover tests; immediate
  pre-write stat and two-cycle convergence tests; child-prefix/CAS and asymmetric
  fixed-point tests; ownership guards; and the full repository gate. Implementation
  evidence remains pending.
tags:
- sync
- convergence
- conflict
owners: []
relations:
- {type: originatedFrom, target: change-20260908-bounded-rename-tracking}
- {type: modifies, target: adr-20260902-fresh-state-reconciliation-for-rename-edits}
- {type: modifies, target: adr-20260903-stateless-current-state-recovery}
- {type: modifies, target: adr-20260904-remote-rename-alias-arbitration}
- {type: modifies, target: adr-20260905-fact-first-component-admission}
source_paths:
- src/sync/sync-cycle-planning.ts
- src/sync/path-observation.ts
- src/sync/change-hash-enrichment.ts
- src/sync/identity-component-decision.ts
- src/sync/identity-component-report-family.ts
- src/sync/plan-admission-graph.ts
- src/sync/plan-admission.ts
- src/sync/types.ts
- src/sync/conflict.ts
- src/sync/conflict-resolver.ts
- src/sync/plan-executor.ts
- src/sync/execution-result.ts
- src/sync/state-committer.ts
- src/sync/sync-cycle-finalization.ts
- src/sync/orchestrator.ts
- src/sync/local-tracker.ts
- src/sync/sync-notification.ts
- src/sync/conflict-history.ts
- docs/design/design-four-stage-sync-pipeline.md
- sync-admission-authority-guard.test.mjs
- sync-state-ownership-guard.test.mjs
- src/sync/scope-projection.ts
summary: Use current-cycle alias authority and exact bytes to preserve readable ambiguity
  at one direct candidate per version; pre-effect stat races re-enter fresh observation
  without alternates.
---

# Converge relational ambiguity with a preservation cover

## Context

Rename and folder reports may be contradictory, partial, or non-unique while all current file versions remain readable. Treating every relation defect as an error cannot converge because a retry sees the same complete contradiction. Conversely, asking every filesystem to expose an exact provider-normalization/address key is not a sound premise: a backend may not provide operation-complete equivalence, and multiple provider objects at one apparent path may not be independently addressable.

The existing system already observes exact paths, current aliases, authoritative stat results, bytes, and scope. From potential current-alias anchors and full digests, those same capabilities can obtain facts for one direct candidate. Only current-cycle alias resolution authorizes a cover; cached alias or provider-normalization inference does not. A collision can still be latent until a write targets the provider.

## Decision

### Relation proof is optional; preservation proof is not

Admission uses native rename only when current facts prove one unique exhaustive relation. A complete but ambiguous relation is abandoned:

- positively distinct exact/provider-resolved occurrences use existing ordinary exact-path behavior;
- an affirmative current-cycle alias collision selects one typed `preservation_cover`;
- unavailable required occurrences, bytes, scope, or revalidation remain observation failures.

No casing, Unicode, or provider-normalization heuristic fills an evidence gap. No `IFileSystem` method, backend implementation, or shared backend contract is added.

### Observation freezes; Admission closes

Observation alone performs targeted existing list/stat/read/hash enrichment and freezes current facts for potential direct candidates, but selects no anchor, edge, or action. `plan-admission-graph` builds once, selects `P` as the minimum UTF-8 bytes among current alias-resolved paths, partitions exact byte versions, and considers only `insertConflictSuffix(P, fullSha256)` for each version. Matching bytes add an edge and union endpoints. Different bytes remain an independent ordinary component and provide a read-only occupancy witness that fails the group with `preservation_destination_unavailable`. Admission performs no filesystem I/O, iterative frontier, or second build.

Candidate observation uses one attempt-local fact that separates the requested candidate address, each side's actual resolved endpoint, and the requested-key baseline. Existing candidate records may seed bounded re-observation of the base but never authorize a collision. When HOT sees a current component with no committed baseline, it reuses its remote delta and promotes to WARM, composing rather than discarding exact dirty-path facts.

### Exact bytes are the preservation unit

Within one observed collision, each distinct `SHA-256 + size` version requires one cover child at exactly `insertConflictSuffix(P, fullSha256)`. Same bytes may share that child inside the collision; equal bytes at positively distinct exact paths remain separate path obligations. Foreign occupancy or unavailable candidate scope yields `preservation_destination_unavailable`. There is no alternate, ordinal, family, frontier, timestamp, or digest truncation.

The discriminated protocol fixes each child's source witness, bytes, candidate, expected endpoints, missing-side effects, terminal proof, and publication. The resolver captures only and never mutates originals or chooses a winner.

### Latent collisions converge in two stages

Immediately before every ordinary or cover write, Execution authoritatively stats the destination using the existing filesystem API. An unexpected exact-path occupant or alias/cross-path occupant is a precondition failure before effect. Execution retains the successful component prefix, blocks the suffix, does not overwrite/reroute/convert policy, and leaves the checkpoint unchanged.

The next ordinary cycle starts from fresh observation. After an ordinary-write race, a foreign-byte exact-path occupant uses existing same-path conflict and only a different path joined by current-cycle alias resolution selects a cover. After an absent-candidate race, matching bytes are absorbed; different bytes remain ordinary and make the group `preservation_destination_unavailable`. No alternate is selected. Independently unobservable occurrences remain FR-BRT-015.

### Publication and cleanup remain exact

Every child proves exact bytes on both sides before its `SyncRecord` publication. Publication occurs per child; only a wholly clean cycle commits the checkpoint. Cleanup occurs only after cover proof and only for an exact captured baseline in the abandoned original footprint that is neither the selected same-byte candidate, a current same-exact-path terminal pair, nor retained by a current ordinary exact-path action. A foreign candidate occupant is an independent ordinary component and never cleanup input. Cleanup uses exact `compareAndDelete`; absence is never delete authority.

Two-sided terminal proof requires actual-resolved authority and admitted endpoint continuity; requested-path echo remains incomplete. A publication-only failure retries against the observed absent baseline without rewriting files. Audit projection retains every successful child path in order and is never read for recovery.

A complete two-sided cover plus exact cleanup is `resolved_no_action` even with asymmetric originals. History is audit-only and does not participate in later decisions.

Checkpoint publication, dirty-path retention, and relation-report abandonment are intentionally separate. A wholly clean cycle commits the remote checkpoint and acknowledges its full captured tracker snapshot. A terminal partial cycle withholds the checkpoint, retains dirty paths, and abandons only captured file/folder rename reports. Endpoint-generation checks preserve relation reports recreated after capture. Failed rename reports therefore leave with their cycle rather than becoming retry authority, while a failed same-metadata content write remains on HOT; the unchanged checkpoint and current endpoints re-surface unfinished relational work on the next invocation.

## Consequences

- Readable relation contradictions converge without another durable owner or recovery mode.
- A terminal partial cycle cannot replay stale local rename evidence indefinitely; retry may require WARM acquisition but is derived from current facts.
- A previously latent occupant may require one failed/precondition cycle before fresh facts select same-path conflict or a different-path alias cover; first-cycle cleanliness is not promised.
- Truly unobservable provider duplicates remain conservatively non-clean.
- Existing provider APIs and backend contracts stay unchanged.

## Rejected alternatives

- **Fail all relation defects:** repeats a permanent error despite preservable bytes.
- **Mandatory provider address equivalence:** claims semantics some providers cannot expose and broadens every backend contract.
- **Lowercase/Unicode collision keys:** creates false merges and inconsistent backend behavior.
- **Winner/newest selection:** can discard readable data.
- **Same-cycle reroute or cover conversion:** changes the admitted action and makes retry behavior non-deterministic.
- **Persist pending cover work:** creates a third durable authority and stopped-state recovery branch.

## Confirmation

The change spine traces every requirement to this ADR or an exact protocol, implementation unit, and acceptance verification. Required tests include Admission purity, finite closure, exact-byte partition, typed cover execution, immediate pre-write stat, no same-cycle reroute, next-cycle cover, unaddressable duplicate failure, child-prefix publication, stale-record negative predicates, asymmetric fixed point, audit-only history, and unchanged unique-rename/same-path controls.
