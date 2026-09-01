---
id: adr-20260901-admission-priority-pull
kind: adr
title: Keep priority pull narrow within the Admission pipeline
status: accepted
created: '2026-09-01'
decision_makers:
- unknown
tags: []
owners: []
relations:
- {type: references, target: adr-20260831-admission-owns-identity-component-decisi}
- {type: references, target: adr-20260831-admission-owned-local-rename-constraint-lifecycle}
source_paths: []
summary: Preserve PR54 exact actions and add detached priority pull with exact singleton
  supersession.
consequences:
  positive:
  - File-open can preempt unstarted work without duplicating normal decision policy.
  - Normal batch Remote API call count and PR54 exact-action authority remain unchanged.
  negative:
  - Providers must implement detached identity/path/version observation for the fast
    pass.
  - Unsafe topology and closed phases defer to the normal batch instead of accelerating.
  neutral:
  - Existing global phase barriers and rename debt lifecycle remain authoritative.
confirmation: Focused provider, Admission, executor, finalization, race, and source-exclusion
  tests.
updated: '2026-09-01'
---

## Context

PR #54 は identity component の action shaping、destructive authorization、rename lifecycle を Admission に集約し、Executor は exact actions を global phase barrier に通し、Finalization は exact completionを checkpoint/debt releaseへ foldする。PR #49 の universal late-bound executionはこの境界を runtime re-Admission、epoch、member obligation、receipt、rerouteで複製していた。

file-open は batch 全体を待たずに tracked regular file を pullしたい。一方、shared cache の `stat/read` や凍結済み action の放置では、rename/replacementを誤認したり、priority pull後に同じ normal pullを再実行できる。

## Decision

PR #54 の pipeline を正本として維持する。provider 差異は optional `IFileSystem.priority.observe/read` に閉じ込め、file-open だけが detached identity/path occupant/ancestry/version witness を取得する。通常 batch はこの capabilityを呼ばない。

Admission は既に authorized となった componentから、安全な exact singleton regular-file `pull` の同一 object referenceだけを priority-substitutable として投影する。priority local write後の whole-record SyncRecord CASが成功し、その actionがまだ pendingの場合だけ supersedeする。CAS lossやLocal/identity/target不一致で stale effectが証明された場合は actionを invalidatedとしてI/Oとclean checkpointを止める。別 actionへのrerouteはしない。

`PriorityCoordinator` は planning/debt gate、normal actionのeffect+`commitAction()`、priority operation、completion proofからcheckpoint/debt deletionまでのfinalizationを線形化する。cycle-local pending/superseded/invalidated setsは exact object referenceだけを持ち永続化しない。global phase barriersとrename lifecycleは変更しない。

Observation / Admission / Effect / Finalization は説明と検査の観点として使用するが、4つの新しいowner、carrier、pipelineにはしない。file-openも独立4段pipelineを持たない。

## Rejected alternatives

- 全 normal action の execution-time re-Admission と targeted Remote calls
- epoch、member obligation、component receipt、no-action freshness resume
- dynamic route、`BoundExecution`、`EffectCommitResult`
- shared metadata cacheをfresh authorityとして使う fast pass
- priority成功後も同じ frozen normal pullを実行する設計

{% consequence kind="positive" %} File-open priorityを追加しても、通常 decision policyとRemote call complexityはPR #54のまま維持される。 {% /consequence %}

{% consequence kind="negative" %} detached authorityを証明できないbackend/path/topologyは高速化されず、通常batchへdeferされる。 {% /consequence %}

{% consequence kind="neutral" %} global phase barrier、checkpoint commit-last、rename debt release-after-checkpointは引き続き必要である。 {% /consequence %}

Confirmation is provided by provider contract、singleton Admission、permit-through-commit、CAS supersession、finalizer exactness、normal call-count、static exclusion tests。


{% transition from="proposed" to="accepted" date="2026-09-01" %}
Approved PR54-centered minimal responsibility design
{% /transition %}
