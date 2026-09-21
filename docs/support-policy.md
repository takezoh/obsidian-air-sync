---
id: support-policy
kind: design
title: Support policy
status: active
created: '2026-09-15'
updated: '2026-09-15'
relations:
- {type: references, target: design-remote-backend-implementation-contract}
- {type: references, target: note-20260915-cloud-backend-qualification}
summary: Target users, project boundaries, maintained services, and selection criteria
  for Air Sync support and feature additions.
---

# Support policy

This document owns the product decision about which users and storage workflows Air Sync
serves. The [implementation contract](design/design-remote-backend-implementation-contract.md)
owns technical prerequisites and verification. The
[provider investigation](note/note-20260915-cloud-backend-qualification.md) records service
findings and decisions against these two documents.

## Target users and project boundary

Air Sync is for people who want a sophisticated synchronization experience without having
to think about how synchronization works. It should connect to familiar personal cloud
storage without requiring users to configure or manage synchronization as an ongoing task,
so they can focus on creating and using their notes.

Air Sync aims to provide a capable synchronization experience while keeping its complexity
out of the user's attention. Power-user-oriented synchronization products may instead
prioritize detailed control, configuration, and customization.

New features should support this experience rather than make synchronization itself
something the user needs to manage.

## Feature additions and customization

This criterion applies to feature additions across the project, not only new backends.
Evaluate each addition by its contribution to a sophisticated synchronization experience
that does not demand the user's attention. Advanced technology and features are welcome
when they support that experience; expanding the feature count or customizability is
not a goal in itself.

Features whose primary purpose is to expose fine-grained control over storage
configuration or synchronization behaviour belong to power-user-oriented projects,
even when they use an already supported backend. Configuration that helps the target
user obtain this experience may still be appropriate. Evaluate the user benefit together
with the configuration and maintenance burden it introduces.

## Supported service selection

Air Sync is a non-commercial OSS project with finite maintenance capacity. Supported
backends MUST be limited to major cloud storage services with broad personal adoption
that also satisfy the [implementation contract](design/design-remote-backend-implementation-contract.md). Current support is limited to **Google
Drive, OneDrive, and Dropbox**. iCloud Drive belongs to the major personal-service group,
but is not supported because it does not meet the current integration requirements.

Product selection and technical qualification are separate gates. Technical feasibility,
an available SDK, a contribution, or a large registered-account count does not alone
justify adding a maintained backend. Personal adoption is a qualitative product selection
criterion, not a claimed numerical market-share ranking; registration counts, paid seats,
active users, and ecosystem-wide accounts are not interchangeable measurements.

The [consolidated investigation](note/note-20260915-cloud-backend-qualification.md)
records supported services, known technical failures, unresolved qualification evidence,
and exclusions based on maintenance scope. An unverified candidate MUST NOT be described
as technically impossible, and a policy exclusion MUST NOT be described as a failed
contract test. Investigated candidates are not a roadmap commitment.

### Built-in vs external backends

The three services above ship as **static built-in modules** maintained with Air Sync. The
Backend Module API exists at v1 ([design-backend-module-api.md](design/design-backend-module-api.md)),
but this release implements **no external backend loader**: there is no artifact
discovery, dynamic import/eval, install/enable/disable UI, integrity manifest, or hot
reload. Do not describe external JavaScript backends as a supported or delivered feature.
Loading external artifacts is a future milestone and its requirements must not be used to
widen or defer the built-in module boundary's completion criteria.

## Adding or reconsidering support

Adding support requires an explicit target-user and maintenance-scope decision, concrete
evidence for every service prerequisite, and the implementation contract's
[Conformance evidence](design/design-remote-backend-implementation-contract.md#conformance). Reconsider a
candidate when its relevant API/access model changes and the maintenance/adoption case
justifies it; do not weaken checksum, delta, permission, or mobile requirements to expand
the provider list.
