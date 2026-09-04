---
id: change-20260904-remote-rename-alias-arbitration
kind: change
title: Centralize rename candidate authority and descendant coverage
status: done
created: '2026-09-04'
profile: sdd@1
intent: Make one identity-component Admission decision the sole semantic authority
  for remote rename versus alias arbitration, with exact call-local folder topology
  proof and no new state or downstream behavior.
outcomes:
- Coherent authoritative reported claims win before alias-only candidates; incompatible
  normative claims fail closed without fallback.
- Each identity component is selected once from immutable raw facts, shaped once,
  evaluated once, and disposed once by Admission.
- Folder-root authority covers only exact, complete, unique, in-scope descendants
  proven by an immutable call-local subordinate proof.
- Existing failure vocabulary has deterministic predicate and reason precedence across
  input permutations.
- Static enforcement rejects foreign helper importers and module-scope mutable correctness
  proof while the existing state-owner/checkpoint guard stays unchanged.
- Current documentation no longer presents rename debt as current behavior; a new
  ADR clarifies clause-level supersession without rewriting accepted history.
evidence_refs:
- type: test
  ref: 'RED focused Admission recurrence: 1 expected failure with rename_mismatch
    and alias_target_mutation'
- type: test
  ref: 'GREEN src/sync/plan-admission.test.ts: 95/95, including conflict, precedence,
    nested full-scan, exact-root, synthetic-authority, and affine witnesses'
- type: test
  ref: 'GREEN sync-admission-authority-guard.test.mjs: 7/7 discriminating architecture
    checks'
- type: command
  ref: 'npm run lint: green'
- type: command
  ref: 'npm run lint:bot-repro: green, 42/42 guard tests'
- type: command
  ref: 'npm run build: green'
- type: command
  ref: 'npm run test:coverage: 91 files, 1787 tests, all green; 86.82% statements,
    82.64% branches, 87.07% functions, 87.94% lines'
- type: command
  ref: 'design minimality reconciliation: green, no scope expansion signals'
- type: source
  ref: 'Independent correctness cross-task review r2: approved, zero blocker/major/minor'
- type: source
  ref: 'Independent test cross-task review r3: approved, all prior false-green findings
    resolved'
- type: command
  ref: 'dev-evidence declared scope: all 20 Git-visible changes covered; sole reported
    outside path .claude/settings.local.json is globally gitignored personal configuration
    and absent from git status'
scope:
- src/sync/identity-component-decision.ts — sole private component decision producer.
- src/sync/identity-component-report-family.ts — pure decision-only report classifier.
- src/sync/identity-component-topology.ts — planned pure subordinate topology helper.
- src/sync/plan-admission-case-alias.ts — selected alias-family candidate mechanism.
- src/sync/local-rename-admission.ts — selected local-family candidate mechanism.
- src/sync/optimize-local-renames.ts — selected local rename shaping mechanism.
- src/sync/optimize-remote-renames.ts — selected remote rename shaping mechanism.
- src/sync/plan-admission.test.ts — RED recurrence, negative matrix, permutations,
  and affine-read bound.
- src/sync/orchestrator.test.ts — common lifecycle and acquisition-temperature proof.
- tests/fs/remote-backend-contracts.test.ts — shared three-backend rename contract.
- eslint.config.mts — Admission helper import and pure-transform restrictions.
- sync-admission-authority-guard.test.mjs — planned closed AST architecture guard.
- package.json — lint:bot-repro registration for the new guard.
- AGENTS.md — current agent boundary guidance.
- ARCHITECTURE.md — current module and pipeline boundary guidance.
- docs/sync-pipeline.md — current sync-stage guidance.
- docs/code-enforcement.md — current static guard guidance.
- docs/design/design-four-stage-sync-pipeline.md — promotion target for new invariants.
- docs/adr/adr-20260904-remote-rename-alias-arbitration.md — proposed decision and
  clause-level supersession record.
- src/sync/plan-admission.ts — public facade of component-identity-component-authority
  and one component-result mapping.
non_goals:
- New persisted evidence, rename debt, recovery instruction, pending work, schema,
  migration, intermediate checkpoint, or orchestrator correctness field.
- Provider-specific Admission branches, provider API/payload changes, or live-provider
  feature work.
- Changes to executor ordering, action/status/disposition/failure vocabulary, conflict
  policy, retry policy, commit timing, or checkpoint ownership.
- Public action, evidence, or schema provenance for the private topology proof.
- Editing historical accepted ADRs or completed change packages.
change_classes:
- behavior
- responsibility
- boundary
- invariant
- internal_design
governance:
  gate: hard
  reasons:
  - Clarifies accepted Admission ownership and changes precedence among existing rename-candidate
    mechanisms.
  - Supersedes stale present-tense rename-debt clauses in accepted ADRs while retaining
    their historical text.
  approval_evidence: Project owner approved authoritative reported rename precedence,
    exact complete selected-root descendant coverage, structural Admission repair,
    and the no-new-state boundary on 2026-09-04.
members:
- role: requirements
  path: changes/change-20260904-remote-rename-alias-arbitration/requirements.md
  required: true
- role: implementation
  path: changes/change-20260904-remote-rename-alias-arbitration/implementation.md
  required: true
- role: verification
  path: changes/change-20260904-remote-rename-alias-arbitration/verification.md
  required: true
promotion:
- target: design-four-stage-sync-pipeline
  section: invariants
  action: upsert
  item:
    id: INV-007
    statement: Admission selects one authority family from immutable raw component
      facts, materializes it once, evaluates it once, and disposes the component once;
      coherent reports precede aliases and normative conflict has no fallback.
    enforcement: contract
- target: design-four-stage-sync-pipeline
  section: invariants
  action: upsert
  item:
    id: INV-008
    statement: A selected folder-root claim governs only exact, complete, unique,
      suffix-preserving, included descendants proven by immutable call-local data
      that is discarded with the component decision.
    enforcement: test
- target: design-four-stage-sync-pipeline
  section: boundaries.forbidden
  action: upsert
  item:
    id: BOUNDARY-007
    statement: Production modules other than the identity-component decision importing
      rename candidate/topology helpers, or Admission retaining mutable correctness
      proof at module scope or across calls.
unresolved_decisions: []
tags: []
owners: []
relations:
- {type: introduces, target: adr-20260904-remote-rename-alias-arbitration}
- {type: modifies, target: design-four-stage-sync-pipeline}
- {type: conformsTo, target: adr-20260831-admission-owns-identity-component-decisi}
- {type: conformsTo, target: adr-20260903-four-stage-sync-pipeline}
- {type: conformsTo, target: adr-20260903-stateless-current-state-recovery}
source_paths:
- src/sync/plan-admission.ts
- src/sync/identity-component-decision.ts
- src/sync/identity-component-report-family.ts
- src/sync/identity-component-topology.ts
- src/sync/plan-admission-case-alias.ts
- src/sync/local-rename-admission.ts
- src/sync/optimize-local-renames.ts
- src/sync/optimize-remote-renames.ts
- src/sync/plan-admission.test.ts
- eslint.config.mts
- sync-state-ownership-guard.test.mjs
- docs/sync-pipeline.md
- docs/code-enforcement.md
- docs/design/design-four-stage-sync-pipeline.md
summary: Make reported rename authority and folder descendant coverage explicit without
  adding sync state or recovery paths.
updated: '2026-09-05'
promotion_applied_at: '2026-09-04T16:05:03.500492+00:00'
closure:
  closed_at: '2026-09-04T17:03:19.006873+00:00'
  content_hash: sha256:625ca47d4eba94d1cf49c4f8a023911aa0350bee5770c25b0559628a123e406e
---

## Summary

Admission currently sequences alias/local normalizers before reported rename shaping,
so a plausible lower-authority rewrite can obscure the component's normative reported
postcondition. A second weakness derives folder coverage from proposed actions, allowing
the action under evaluation to manufacture apparent authority. This package replaces the
ordered normalizer split with the stable component-identity-component-authority
decision over immutable raw facts. That component is the sole semantic owner: its
public Admission facade maps one result, while its private producer chooses one coherent
family, calls one materializer, consumes one subordinate selected-root proof, applies a
fixed failure precedence, and returns a closed result for the facade to dispose exactly
once.

The selected-family shapers and proof function are subordinate producers, and the proof
is private call-local data, not a component or lifecycle owner. COLD, WARM, and HOT
acquisition and Google Drive, OneDrive, and Dropbox supply operational inputs through
the same provider-neutral contract rather than owning arbitration. Static guards enforce
that authority contract; they are not a runtime semantic component. Execution, per-file
commit, finalization, checkpoint ownership, and action/reason vocabulary do not change.

Earlier accepted documents contain stale present-tense descriptions of RenameDebt after
the accepted stateless-current-state decision removed that mechanism. The new proposed
ADR records clause-level supersession; implementation updates current guides and the
active design but leaves historical ADRs and completed packages intact.

## Closure Notes

Open until the dependency-ordered implementation units, promotion, conformance checks,
and full repository gate in verification.md are complete.
