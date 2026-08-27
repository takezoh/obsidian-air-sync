---
id: change-20260827-fast-pass-remote-freshness
kind: change
title: Prioritize opened-file sync while preserving the later batch
status: done
created: '2026-08-27'
profile: sdd@1
intent: Synchronize an opened file ahead of unstarted normal actions while leaving
  the global batch and checkpoint lifecycle correct.
outcomes:
- A remotely changed, locally unchanged synced file becomes current when opened.
- The opened path's SyncRecord makes later global-delta processing a no-op.
- Sibling and structural changes remain owned by the normal checkpoint lifecycle.
- Google Drive, Dropbox, and OneDrive share one targeted-freshness behavior.
evidence_refs:
- type: test
  ref: src/sync/priority-coordinator.test.ts
- type: test
  ref: src/sync/plan-executor.test.ts
- type: test
  ref: src/sync/orchestrator.test.ts
- type: contract
  ref: src/fs/caching/remote-fs.contract.test.ts
- type: test
  ref: src/fs/googledrive/targeted-observation.test.ts
- type: test
  ref: src/fs/dropbox/targeted-observation.test.ts
- type: test
  ref: src/fs/onedrive/targeted-observation.test.ts
- type: command
  ref: npm run lint
- type: command
  ref: npm run lint:bot-repro
- type: command
  ref: npm run build
- type: command
  ref: npm test
scope:
- src/fs/ — detached identity/ancestry observation and provider point-read seams.
- src/sync/ — cooperative priority admission, per-path mutation stamps, replan, and
  failure handoff.
- docs/changes/change-20260827-fast-pass-remote-freshness/ — requirements, design
  plan, implementation, and verification.
- docs/adr/adr-20260827-file-open-fast-pass-preserves-remote-change-batches.md — governing
  decision.
- ARCHITECTURE.md — priority coordinator and detached observation boundary.
- docs/sync-pipeline.md — priority ordering and later-batch lifecycle.
- docs/code-enforcement.md — enforced provider/cache boundary if lint rules change.
- eslint.config.mts — structural enforcement for detached observation if required.
- src/__mocks__/ — shared priority and provider contract fixtures.
- docs/adr/adr-20260827-file-open-fast-pass-uses-targeted-freshness.md — rejected
  predecessor decision retained for history.
non_goals:
- Consuming or retaining a global delta batch from file-open.
- Priority remote rename or deletion execution.
- Preempting or cancelling an already-started indivisible normal action.
- Durable priority queues, global-delta handoff state, TTL, latency SLO, or mandatory
  live E2E.
change_classes:
- behavior
- boundary
- invariant
- internal_design
governance:
  gate: auto
  reasons: []
members:
- role: requirements
  path: changes/change-20260827-fast-pass-remote-freshness/requirements.md
  required: true
- role: implementation
  path: changes/change-20260827-fast-pass-remote-freshness/implementation.md
  required: true
- role: verification
  path: changes/change-20260827-fast-pass-remote-freshness/verification.md
  required: true
promotion:
- target: none
  section: none
  action: none
  item: {}
  reason: The durable decision is recorded by the originated ADR and sync-pipeline
    docs.
unresolved_decisions: []
tags:
- sync
- file-open
- remote-freshness
owners: []
relations:
- {type: references, target: adr-20260827-file-open-fast-pass-preserves-remote-change-batches}
source_paths:
- src/fs/interface.ts
- src/fs/caching/remote-fs.ts
- src/fs/googledrive/index.ts
- src/fs/dropbox/index.ts
- src/fs/onedrive/index.ts
- src/sync/scheduler.ts
- src/fs/caching/remote-fs.contract.test.ts
- src/sync/scheduler.test.ts
- docs/sync-pipeline.md
- docs/adr/0001-metadata-cache-is-subordinate-to-commit-last.md
summary: Use detached provider observation, cooperative priority safe points, and
  action-time revalidation so the opened file runs first and the later batch safely
  becomes no-op or replans.
updated: '2026-08-27'
closure:
  closed_at: '2026-08-27T13:38:37.541419+00:00'
  content_hash: sha256:1cfa7331c4b464a1ec2804467efef0fc2ad4363893fd85f5a2753e77e15691cb
---

## Summary

File-open now delegates directly to the orchestrator-owned priority coordinator. The
remote capability observes the stable identity from `SyncRecord`, proves ancestry and path
with request-local provider metadata, and re-observes its provider token after content read;
it does not consume delta state or mutate shared metadata/root anchors. Normal executor
actions acquire cooperative permits and revalidate at admission. A priority-applied older
frozen action becomes a no-op, while incomparable evidence blocks checkpoint cleanliness.
The path-local mutation lease, record compare-and-put, tracker generation, and normal
same-content recovery cover local edits and post-write record persistence failure.

## Closure Notes

The accepted ADR is implemented without global handoff, cursor lifecycle changes, or a
durable recovery schema. Mandatory repository gates and focused concurrency/provider
discriminators are recorded in `verification.md`; optional credential-gated live E2E was
not required for acceptance.


{% transition from="draft" to="ready" date="2026-08-27" %}
Requirements, ADR, implementation contracts, and verification plan are closed; implementation remains pending.
{% /transition %}


{% transition from="ready" to="active" date="2026-08-27" %}
implementation-started
{% /transition %}


{% transition from="active" to="closing" date="2026-08-27" %}
implementation-and-repository-gate-complete
{% /transition %}
