---
id: change-20260906-oauth-authentication-publication
kind: change
title: Make OAuth authentication publication fail closed
status: active
created: '2026-09-06'
profile: sdd@1
intent: Make OAuth completion, refresh rotation, callback ingress, and relay response
  validation fail closed without creating another credential owner.
outcomes:
- All six refresh-based OAuth completion paths report success only after the required
  refresh credential is immediately readable from SecretStorage.
- Shared and detached refresh-token rotations publish before any response state is
  reusable, independently of sync-cycle closeout.
- Callback denial, static state, Google relay, and pCloud relay inputs are validated
  at their production trust boundaries with bounded secret-free failures.
- Custom Dropbox and OneDrive exchanges retain the authorization attempt's original
  client identity across settings edits and plugin reload.
scope:
- src/fs/
- src/main.ts
- ARCHITECTURE.md
- docs/dropbox-backend.md
- docs/onedrive-backend.md
- docs/google-drive-backend.md
- docs/e2e-testing.md
- docs/bugs/dropbox-built-in-user-limit.md
- docs/changes/change-20260906-oauth-authentication-publication/
non_goals:
- Deploying the Worker or Pages callback
- Changing CI workflows or Google transport-exception behavior
- Adding a plugin-owned credential store, journal, migration, or recovery queue
- Claiming OS-level physical secret durability from synchronous API readback
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
  path: changes/change-20260906-oauth-authentication-publication/requirements.md
  required: true
- role: implementation
  path: changes/change-20260906-oauth-authentication-publication/implementation.md
  required: true
- role: verification
  path: changes/change-20260906-oauth-authentication-publication/verification.md
  required: true
promotion:
- action: none
  reason: This change repairs existing OAuth and callback trust boundaries without
    changing the plugin's durable sync-state authority or introducing a new public
    capability; current invariants remain documented in the change package and existing
    architecture/authentication guidance.
unresolved_decisions: []
tags: []
owners: []
relations: []
source_paths:
- src/fs/token-store.ts
- src/fs/oauth-pkce.ts
- src/fs/pkce-auth-provider.ts
- src/fs/googledrive/auth-provider-base.ts
- src/main.ts
- docs/changes/change-20260906-oauth-authentication-publication/
summary: Fail closed across OAuth credential publication, attempt identity, and callback/relay
  trust boundaries in the plugin and companion auth repository.
updated: '2026-09-06'
---

## Summary

Repair seven independently reproduced OAuth/authentication roots across the plugin
and relay repositories. Required credentials use exact synchronous SecretStorage
readback as the automated publication boundary; native restart durability remains a
separate manual observation.

## Closure Notes

Source implementation and automated repository gates are complete. Relay deployment is
explicitly excluded. Native restart continuity and Dropbox's provider-console/new-account
acceptance remain unverified external evidence, so this change stays active rather than
claiming full closure.


{% transition from="draft" to="ready" date="2026-09-06" %}
Integrated design approved; implementation contract has no open decisions.
{% /transition %}


{% transition from="ready" to="active" date="2026-09-06" %}
Source fixes and automated verification are in progress; native restart and provider-console evidence remain separate.
{% /transition %}
