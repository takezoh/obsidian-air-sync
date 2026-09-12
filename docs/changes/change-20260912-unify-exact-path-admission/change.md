---
id: change-20260912-unify-exact-path-admission
kind: change
title: Unify exact-path Admission binding
status: done
created: '2026-09-12'
profile: sdd@1
intent: Unify exact-path Admission decisions so preservation and deletion authority
  cannot drift by route.
outcomes:
- One canonical exact-path materializer preserves comparison and publication semantics
  across ordinary and relation-abandonment routes.
scope:
- src/sync/identity-component-decision.ts
- src/sync/plan-admission.test.ts
- src/sync/convergence.test.ts
- sync-admission-authority-guard.test.mjs
- docs/design/design-four-stage-sync-pipeline.md
- docs/sync-pipeline.md
- docs/changes/change-20260910-terminal-publication-exclusivity/change.md
- docs/changes/change-20260912-unify-exact-path-admission/**
non_goals:
- Do not alter native rename, preservation-cover, execution, publication-store, checkpoint,
  provider, schema, or settings behavior.
change_classes:
- responsibility
- invariant
governance:
  gate: auto
  reasons: []
members:
- role: requirements
  path: changes/change-20260912-unify-exact-path-admission/requirements.md
  required: true
- role: implementation
  path: changes/change-20260912-unify-exact-path-admission/implementation.md
  required: true
- role: verification
  path: changes/change-20260912-unify-exact-path-admission/verification.md
  required: true
promotion:
- target: design-four-stage-sync-pipeline
  section: invariants
  action: upsert
  item:
    id: INV-006
    statement: Admission's single exact-path constructor binds current component identity,
      endpoints, committed comparison baseline, and source/destination publication
      expectation before subordinate content comparison. Relation abandonment may
      omit a one-sided record only from comparison to preserve the present side, never
      from its publication CAS; ordinary deletion propagation retains the record and
      its existing authority checks. Actions and intended effects never serve as identity
      or completeness evidence.
    enforcement: contract
unresolved_decisions: []
tags: []
owners: []
relations:
- {type: modifies, target: design-four-stage-sync-pipeline}
- {type: dependsOn, target: change-20260910-terminal-publication-exclusivity}
- {type: conformsTo, target: adr-20260905-fact-first-component-admission}
- {type: conformsTo, target: adr-20260908-converge-relational-ambiguity-with-a-pre}
source_paths:
- src/sync/identity-component-decision.ts
- src/sync/convergence.test.ts
evidence_refs:
- type: test
  ref: npm run test:coverage (96 files, 2011 tests)
- type: test
  ref: fake_green_guard.py PASS
- type: command
  ref: npm run lint
- type: command
  ref: npm run lint:bot-repro (56 guard tests)
- type: command
  ref: npm run build
- type: command
  ref: docs lint --conformance PASS
- type: command
  ref: dev-evidence inspected 13 changed paths; only pre-existing user-owned .claude/settings.local.json
    and src/fs/oauth-disconnect-isolation.test.ts remain outside declared scope
summary: One exact-path Admission owner now binds comparison and publication across
  ordinary and abandoned relation routes.
updated: '2026-09-12'
promotion_applied_at: '2026-09-12T04:00:25.260233+00:00'
closure:
  closed_at: '2026-09-12T04:05:07.861564+00:00'
  content_hash: sha256:61a9a6629139edc373eaa78bd5d84d0ddeba72081d65649d32ceb81ccc775875
---

## Summary

## Closure Notes


{% transition from="active" to="closing" date="2026-09-12" %}
Implementation, full repository gate, architecture guard, convergence regression, and scope review are complete.
{% /transition %}
