---
id: change-20260908-bounded-rename-tracking
kind: change
title: Converge relational ambiguity with a conservative preservation cover
status: closing
created: '2026-09-08'
profile: sdd@1
intent: Make bidirectional sync converge without data loss when every current content
  version is independently observable but rename identity or mapping cannot be proved,
  while retaining strict errors only where preservation cannot be proved or completed.
outcomes:
- A uniquely and completely proven current-attempt relation keeps the existing native
  rename behavior.
- A relationally ambiguous but completely observed component abandons the relation
  and converges without deleting, overwriting, merging, or selecting an original version.
- Paths positively observed as distinct exact/provider-resolved occurrences use ordinary
  exact-path synchronization; a current-cycle alias collision uses one typed conflict
  preservation cover for every distinct exact byte version.
- A latent occupant first revealed by authoritative stat immediately before an ordinary
  write stops before effect. Fresh observation routes a same-exact-path foreign version
  to existing conflict handling and only a different-path alias collision to a cover.
- A partial cover publishes each verified child independently and later retries only
  missing versions at the single `insertConflictSuffix(P, fullSha256)` destination;
  a foreign occupant blocks preservation and never causes an alternate name.
- Incomplete observation, I/O/authentication, mutation-precondition and publication
  failures remain non-clean; retries re-observe current facts and perform only missing
  work.
- A terminal partial cycle withholds the durable checkpoint, abandons exactly its
  captured file/folder rename reports, and retains dirty paths. This prevents stale
  relations from becoming retry authority without losing failed same-metadata edits.
- Folder rename capture keeps both root addresses dirty; after relation abandonment,
  an unbaselined absent root forces WARM breadth so descendants are rediscovered even
  when unrelated dirty work would otherwise keep acquisition HOT.
evidence_refs:
- type: test
  ref: npm run test:coverage (95 files, 1982 tests passed in integrated worktree)
- type: command
  ref: npm run lint
- type: command
  ref: npm run lint:bot-repro (55 guard tests and source scan passed)
- type: command
  ref: npm run build
- type: command
  ref: dev-docs lint --conformance (47 documents, 0 warnings)
- type: contract
  ref: independent correctness and test-critic reviews approved the integrated worktree
    on 2026-09-10
scope:
- docs/code-enforcement.md
- src/sync/change-detector.ts
- src/sync/change-detector.test.ts
- src/sync/collision-content-observation.ts
- src/sync/hot-acquisition-completeness.ts
- src/sync/hot-warm-promotion.ts
- src/sync/convergence.test.ts
- src/sync/orchestrator.test.ts
- src/sync/orchestrator.ts
- src/sync/local-tracker.ts
- src/sync/local-tracker.test.ts
- src/sync/sync-cycle-planning.ts
- src/sync/sync-cycle-planning.test.ts
- src/sync/path-observation.ts
- src/sync/path-observation.test.ts
- src/sync/change-hash-enrichment.ts
- src/sync/scope-projection.ts
- src/sync/scope-projection.test.ts
- src/sync/plan-admission-graph.ts
- src/sync/identity-component-decision.ts
- src/sync/identity-component-report-family.ts
- src/sync/plan-admission.ts
- src/sync/plan-admission.test.ts
- src/sync/types.ts
- src/sync/conflict.ts
- src/sync/conflict.test.ts
- src/sync/conflict-resolver.ts
- src/sync/conflict-resolver.test.ts
- src/sync/plan-executor.ts
- src/sync/plan-executor.test.ts
- src/sync/execution-result.ts
- src/sync/state-committer.ts
- src/sync/state-committer.test.ts
- src/sync/sync-cycle-finalization.ts
- src/sync/sync-cycle-finalization.test.ts
- src/sync/sync-notification.ts
- src/sync/sync-notification.test.ts
- src/sync/conflict-history.ts
- src/sync/conflict-history.test.ts
- sync-admission-authority-guard.test.mjs
- sync-state-ownership-guard.test.mjs
- docs/adr/adr-20260908-converge-relational-ambiguity-with-a-pre.md
- docs/design/design-four-stage-sync-pipeline.md
- ARCHITECTURE.md
- docs/sync-pipeline.md
- docs/error-handling.md
non_goals:
- No new setting, prompt, status, conflict strategy, recovery command, or user workflow.
- No durable operation intent, pending work, rename evidence, identity graph, failure
  marker, additional in-memory correctness owner, or schema migration.
- No rename/identity inference from equal bytes, casing, Unicode similarity, path
  similarity, acquisition temperature, prior error, or global record count. Exact
  byte equality may only consolidate cover obligations inside one observed collision
  group.
- No empty-folder topology preservation or invention of unobserved descendants.
- No provider API rewrite, mutation probe, timestamp-based candidate, or weakening
  of exact precondition, terminal proof, publication CAS, exclusion, or checkpoint-last.
- No `IFileSystem` method, backend implementation, shared backend contract, or provider
  normalization API change.
- No topology-equality requirement after an observed collision; original paths may
  remain asymmetric once every distinct exact byte version has a two-sided cover.
change_classes:
- behavior
- responsibility
- boundary
- invariant
governance:
  gate: hard
  reasons:
  - Changes the failure boundary for identity/report ambiguity and the pre-effect
    handling of a newly observed ordinary-write destination.
  - Defines a clean fixed point whose original local and remote path topology may
    remain asymmetric after every distinct byte version is preserved.
  approval_evidence: Project owner explicitly directed that unresolvable tracking
    errors converge conservatively rather than stop when current versions can be preserved,
    on 2026-09-08.
members:
- role: requirements
  path: changes/change-20260908-bounded-rename-tracking/requirements.md
  required: true
- role: implementation
  path: changes/change-20260908-bounded-rename-tracking/implementation.md
  required: true
- role: verification
  path: changes/change-20260908-bounded-rename-tracking/verification.md
  required: true
- role: ux
  path: changes/change-20260908-bounded-rename-tracking/ux.md
  required: false
promotion:
- target: design-four-stage-sync-pipeline
  section: invariants
  action: upsert
  item:
    id: INV-003
    statement: A cycle is clean only after every exact admitted obligation has successful
      terminal publication and the working view closes once. Sibling effects settle
      before commit or abort; incomplete attempts abort before classification or retry.
      Clean completion acknowledges the captured tracker snapshot. Terminal partial
      completion abandons only captured file/folder rename reports and retains dirty
      paths; later relation generations survive. Only clean completion advances the
      durable checkpoint.
    enforcement: test
- target: design-four-stage-sync-pipeline
  section: invariants
  action: upsert
  item:
    id: INV-007
    statement: Admission selects native rename only from one unique complete current-fact
      relation. Complete readable relation ambiguity abandons the relation and selects
      exact-path synchronization or one preservation cover; it is not an Admission
      error and has no weaker identity inference.
    enforcement: contract
- target: design-four-stage-sync-pipeline
  section: invariants
  action: upsert
  item:
    id: INV-008
    statement: Before actions exist, Admission closes each finite component over current
      exact endpoints, current alias facts, baselines, relations, and effect footprints,
      assigning each current path to exactly one component in one build. A same-byte
      direct candidate joins and unions endpoint facts; a different-byte candidate
      remains ordinary and contributes only a read-only blocking occupancy witness.
    enforcement: test
- target: design-four-stage-sync-pipeline
  section: invariants
  action: upsert
  item:
    id: INV-012
    statement: In a current-cycle alias collision group, the preservation unit is
      each distinct exact byte version, not source-path cardinality. A clean cover
      proves every such version at its anchor-plus-full-SHA-256 sibling on both sides;
      original path topology may remain asymmetric.
    enforcement: test
- target: design-four-stage-sync-pipeline
  section: invariants
  action: upsert
  item:
    id: INV-013
    statement: Cleanup is admitted only for an exact captured baseline key/value inside
      an abandoned original relation footprint and outside the selected same-byte
      candidate, current same-exact-path terminal pairs, and retaining ordinary actions.
      A foreign candidate occupant stays an independent ordinary component and is
      never cleanup input. Cleanup uses exact compareAndDelete; absence is never delete
      authority.
    enforcement: test
- target: design-four-stage-sync-pipeline
  section: boundaries.forbidden
  action: upsert
  item:
    id: BOUNDARY-008
    statement: Conflict resolution cannot mutate originals or choose a content winner
      for a preservation cover. The discriminated preservation_cover protocol fixes
      ordered capture, revalidation, missing-side writes, two-sided proof, per-child
      publication, and cover-before-cleanup; execution cannot reroute its admitted
      candidate. Every ordinary or cover write performs the admitted authoritative
      destination stat immediately before effect; an unexpected occupant blocks without
      overwrite or same-cycle policy conversion. Fresh same-exact-path foreign bytes
      use existing conflict handling; only a resolved alias/cross-path collision uses
      preservation_cover. The protocol carries immutable candidate order, currently
      proven published candidates, and only the remaining executable children so terminal
      partial results are complete without replaying completed work.
- target: design-four-stage-sync-pipeline
  section: boundaries.forbidden
  action: upsert
  item:
    id: BOUNDARY-010
    statement: Admission and plan-admission-graph cannot receive a filesystem capability
      or invoke read, stat, or list. Observation alone freezes existing exact, alias,
      current alias, scope, SHA-256-and-size, and direct-candidate facts; candidate
      enrichment remains fact-only and Admission is a pure consumer. Execution alone
      performs the admitted immediate pre-effect destination stat.
- target: design-four-stage-sync-pipeline
  section: invariants
  action: upsert
  item:
    id: INV-014
    statement: For current alias-resolved paths, P is the minimum UTF-8 bytes and
      each preservation version has exactly insertConflictSuffix(P, full SHA-256).
      Matching bytes join and union endpoint facts; foreign bytes remain ordinary
      and cause preservation_destination_unavailable. No alternate, ordinal, family,
      or frontier exists.
    enforcement: test
- target: design-four-stage-sync-pipeline
  section: failure_responsibilities
  action: upsert
  item:
    id: FAILURE-002
    statement: Readable complete relation contradictions select preservation. Admission
      fails only when a required occurrence cannot be completely enumerated, independently
      addressed through existing facts, read, byte-compared, scoped, or revalidated.
      A latent occupant discovered by the executor's immediate destination stat stops
      before effect and is re-observed. A fresh same-exact-path foreign version uses
      existing conflict handling, a fresh resolved alias/cross-path collision uses
      the cover, and an independently unobservable occurrence remains non-clean.
- target: design-four-stage-sync-pipeline
  section: relations
  action: upsert
  item:
    type: references
    target: adr-20260908-converge-relational-ambiguity-with-a-pre
unresolved_decisions: []
tags: []
owners: []
relations:
- {type: modifies, target: design-four-stage-sync-pipeline}
- {type: introduces, target: adr-20260908-converge-relational-ambiguity-with-a-pre}
- {type: conformsTo, target: adr-20260903-stateless-current-state-recovery}
- {type: conformsTo, target: adr-20260905-fact-first-component-admission}
source_paths:
- src/sync/identity-component-decision.ts
- src/sync/identity-component-report-family.ts
- src/sync/plan-admission.ts
- src/sync/plan-admission-graph.ts
- src/sync/plan-executor.ts
- src/sync/types.ts
- src/sync/conflict.ts
- src/sync/conflict-resolver.ts
- src/sync/execution-result.ts
- src/sync/state-committer.ts
- src/sync/sync-cycle-planning.ts
- src/sync/path-observation.ts
- src/sync/change-hash-enrichment.ts
- src/sync/scope-projection.ts
- src/sync/sync-cycle-finalization.ts
- src/sync/sync-notification.ts
- src/sync/conflict-history.ts
- docs/adr/0008-logical-identity-admission-fails-closed.md
- docs/adr/adr-20260902-fresh-state-reconciliation-for-rename-edits.md
- docs/adr/adr-20260903-stateless-current-state-recovery.md
- docs/adr/adr-20260905-fact-first-component-admission.md
- docs/design/design-four-stage-sync-pipeline.md
- sync-admission-authority-guard.test.mjs
summary: Bound rename inference to unique current-attempt proof; use positive distinct-path
  facts for ordinary sync and current-cycle alias authority for a one-candidate-per-version
  cover, with pre-effect stop and fresh-cycle reclassification.
updated: '2026-09-10'
promotion_applied_at: '2026-09-10T01:15:17.340544+00:00'
---

## Summary

Rename correlation is an optimization, not a prerequisite for convergence. Complete,
independently readable current occurrences with an ambiguous relation produce ordinary
exact-path synchronization when facts prove distinct occurrences, or a deterministic
cover when current-cycle alias resolution exposes a collision. An occupant first exposed by immediate
pre-write stat stops without effect and is freshly classified as same-path conflict,
different-path alias cover, or observation failure. Unknown or
unaddressable facts and failed effects remain errors. Existing Admission ownership, per-child exact
publication, exclusion, conflict routing, and clean checkpoint-last remain in force.

## Closure Notes


{% transition from="draft" to="ready" date="2026-09-09" %}
Requirements, design, implementation, verification evidence, and independent review are complete.
{% /transition %}


{% transition from="ready" to="active" date="2026-09-09" %}
Implementation integrated into the main worktree for final closure checks.
{% /transition %}


{% transition from="active" to="closing" date="2026-09-09" %}
Independent review approved and the full repository gate passed after integration.
{% /transition %}


{% transition from="closing" to="active" date="2026-09-10" %}
Independent review found contract gaps; implementation and verification reopened.
{% /transition %}


{% transition from="active" to="closing" date="2026-09-10" %}
Contract fixes, cross-cycle tests, full gate, and independent re-review completed.
{% /transition %}
