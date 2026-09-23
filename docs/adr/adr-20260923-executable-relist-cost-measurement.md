---
id: adr-20260923-executable-relist-cost-measurement
kind: adr
title: Justify the Google Drive re-list scope by an executable cost measurement
status: accepted
created: '2026-09-23'
updated: '2026-09-23'
decision_makers:
- project owner
consulted:
- dev:design planner, critic, and integrator
consequences:
  positive:
  - The re-list scope is justified by observed invocation counts rather than the cited
    external logs, which are absent from this checkout.
  - The account-wide regression has a RED-first guard that fails against unmodified
    production code, independent of the live provider.
  - The deterministic managed delta test pins zero listings in steady state and one per
    topmost entered target after the fix.
  negative:
  - The declared-operation count cannot observe the account-wide walk on the unmodified
    module, which declares no such operation; that RED witness is a separate adapter unit
    that fails on the old delta path.
  - The opt-in live e2e reproduces the move-in completeness scenario but does not measure
    request counts, so it is not the count evidence.
  neutral:
  - No instrumentation is added to production code.
confirmation: >-
  The managed delta test records zero declared-operation requests for a steady-state delta
  and one per topmost target for an entering folder. The account-wide RED witness is the
  adapter unit that fails against unmodified code because the old delta path called the
  subtree list for every changed folder. npm run test:e2e:google reproduces the live move-in
  completeness scenario but measures no counts.
tags:
- sync
- googledrive
- verification
owners: []
relations:
- {type: originatedFrom, target: change-20260923-gdrive-delta-relist-scope}
- {type: references, target: adr-20260916-gdrive-delta-relists-entered-folders}
source_paths:
- tests/fs/managed/delta-completion.test.ts
- src/backends/googledrive/adapter.test.ts
- src/backends/googledrive/adapter.ts
- e2e/googledrive.e2e.ts
summary: The design justifies the re-list scope with an executable measurement rather than
  the cited logs; the managed delta test pins the steady-state / one-per-target count and an
  adapter unit carries the account-wide RED witness, while the opt-in live e2e only checks
  move-in completeness.
---

# Justify the Google Drive re-list scope by an executable cost measurement

## Context

The symptom report cited production logs and timing fields (`applyMs`, `acquisitionListMs`,
20-60 second deltas) that do not exist in this checkout, so the scope benefit cannot be
re-observed from them. The accepted ADR plus code reading explains the regression, but the
review required the design to prove its central claim — that a warm/hot cycle with no
entering folder issues no subtree listing — executably.

## Decision

The change ships an executable measurement in two parts. The deterministic managed delta test
(`tests/fs/managed/delta-completion.test.ts`) records the declared-operation request count for
(a) a steady-state delta, which must be zero, and (b) a delta that brings a folder into the
bound root, which must be one per topmost target, over a fake that records every invocation.
The account-wide RED witness is the adapter unit (`src/backends/googledrive/adapter.test.ts`):
run against the unmodified `getChanges`, it fails because that path called the subtree list
for every changed folder. The declared-operation count alone cannot observe that walk,
because the unmodified module declares no operation, so the RED witness is the adapter unit,
not the count. The opt-in live e2e covers the move-in, move-out and move-back-in completeness
scenario against the real provider; it measures no counts.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Proceed on the accepted ADR and code reading alone | The cited logs are absent here; the central claim would be unproven. |
| Rely on the live e2e for the count | The live run observes completeness, not request counts, and cannot re-observe the pre-fix count on the fixed build. |
| Use the declared-operation count as the RED witness | The unmodified module declares no operation, so the count cannot observe the old walk. |

## Consequences

Positive: the scope is justified by observed counts and the regression has a RED-first guard.
Negative: the count does not cover the old adapter walk, and the live e2e does not measure
counts. Neutral: no production instrumentation is added.

## Confirmation

The managed delta test records zero declared-operation requests for a steady-state delta and
one per topmost target for an entering folder. The adapter unit fails against unmodified code
because the old delta path walked changed folders, and passes after the fix. `npm run
test:e2e:google` reproduces the live move-in completeness scenario and measures no counts.
