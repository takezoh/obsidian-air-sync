---
id: adr-20260903-preserve-all-observed-remote-versions
kind: adr
title: Preserve all observed remote versions before resolving tracked identity
status: accepted
created: '2026-09-03'
decision_makers:
- user
tags:
- sync
- convergence
- rename
owners: []
relations:
- {type: modifies, target: adr-20260902-fresh-state-reconciliation-for-rename-edits}
- {type: modifies, target: adr-20260831-admission-owns-identity-component-decisi}
source_paths: []
summary: Preserve tracked R and foreign Y before applying the configured resolver
  once.
consequences:
  positive:
  - Neither tracked R nor foreign Y can be silently discarded in the multi-remote
    case.
  - Naming, writes, verification, and configured strategy remain under one resolver
    owner.
  negative:
  - Multi-remote handling performs bounded O(bytes of R plus bytes of Y) preservation
    I/O.
  - A fresh retry after partial output can create additional numbered conflict files.
  neutral:
  - Provider/checkpoint interfaces, ConflictStrategy, SyncState v6, and RenameDebt
    meaning do not change.
confirmation: Verify exact R/Y preservation before destructive effects, one configured
  resolver invocation, bounded snapshots, and no new durable recovery or provider
  surface.
updated: '2026-09-03'
---

# Preserve all observed remote versions before resolving tracked identity

## Context

Fresh rename reconciliation can observe tracked remote identity R at an included third path while a
different remote identity Y occupies the intended destination. Treating only one as resolver input
can destroy the other. Calling the binary resolver twice would duplicate conflict policy ownership,
while preserving files in preparation would make preparation a second artifact writer. The user
explicitly approved preserve-all-then-resolve-tracked-identity on 2026-09-03.

## Decision

The existing configured resolver remains the single invocation and sole conflict-output owner.
Preparation supplies an ordered set: primary tracked R and additional foreign Y. Inside that one
invocation, the resolver uses the existing allocator to create primary then additional conflict
paths, writes exact bytes to the same relative paths on local and remote, and verifies every copy by
readback before destructive effects.

Configured `auto_merge | duplicate` applies only to local/base/primary R. Additional Y is never a
merge/newer-wins participant and always remains an exact visible preservation output. Under
`duplicate`, the primary preservation output is reused as the ordinary duplicate result. Under
`auto_merge`, it is an exact backup and the ordinary merged/selected result occupies the target.
The result enumerates the primary action and all verified outputs; incomplete coverage is failure.

There is no cross-invocation artifact identity or deduplication. If a partial attempt leaves outputs,
a later fresh invocation may allocate higher-numbered conflict paths and create additional visible
copies.

## Consequences

{% consequence kind="positive" %} Neither R nor Y can be silently discarded, and conflict output naming, writes, and verification retain one owner. {% /consequence %}

{% consequence kind="negative" %} The operation performs bounded preservation I/O for R and Y, and a fresh retry may create more numbered conflict files. {% /consequence %}

{% consequence kind="neutral" %} Provider/checkpoint interfaces, conflict strategy values, SyncState v6, and RenameDebt meaning remain unchanged. {% /consequence %}

## Alternatives

- Stop indefinitely when R and Y coexist: rejected because stable evidence would have no progress bound.
- Resolve only Y or only R: rejected because one observed remote version could be overwritten.
- Let preparation create preservation siblings: rejected because it creates a second output owner.
- Invoke the configured resolver twice: rejected because policy and artifact behavior become duplicated.
- Add a multi-remote strategy, durable receipt, or dedup index: rejected as unnecessary state surface.

## Consultation provenance

The user explicitly selected preserve-all-then-resolve-tracked-identity on 2026-09-03. The decision
is accepted only for the observed `R@third + Y@new` case and does not infer broader provider guarantees.

## Confirmation

Verify exact R/Y preservation on both filesystems before destructive effects, one configured resolver
invocation, bounded source snapshots, and absence of new durable recovery/provider surfaces.


{% transition from="proposed" to="accepted" date="2026-09-03" %}
User explicitly selected preserve-all-then-resolve-tracked-identity on 2026-09-03.
{% /transition %}
