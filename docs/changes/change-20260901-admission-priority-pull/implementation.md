---
change: change-20260901-admission-priority-pull
role: implementation
---

<!-- lifecycle is owned by change.md -->

# Implementation

## Unit 1 — Detached priority provider capability

`IFileSystem.priority.observe/read`、request-local identity/path occupant/ancestry/version witness、および Google Drive・Dropbox・OneDrive adapter を追加する。通常 delta/cache/checkpoint を変更しない contract test を先に固定する。

## Unit 2 — Scheduling and whole-record commit primitives

policy を持たない `PriorityCoordinator`、`LocalMutationBarrier`、`SyncStateStore.compareAndPut()`、tracker generation を追加する。priority は active normal commit を待ち、finalizer は priority と相互排他にする。

## Unit 3 — Admission and exact action execution

Admission disposition に exact singleton `priorityPullAction` reference を投影する。Executor は permit取得後に cycle-local action stateを確認し、`run | superseded | invalidated` のいずれかだけを実行する。別 action は生成しない。Finalization は Admission-marked exact supersessionだけを terminal と数える。

## Unit 4 — File-open orchestration

Orchestrator は planning/debt gate、active exact action set、priority operation、finalizer leaseを結線する。file-open は detached observe/read、Local revalidation/write、whole-record CASを1 operationとして実行する。unsafe topology と closed phase は Remote call前に deferする。

## Unit 5 — Documentation and verification

`ARCHITECTURE.md` と `docs/sync-pipeline.md` を Admission-centered structure に合わせる。四責務は説明上の観点に留め、旧 late-bound machinery を governing design にしない。

## Explicit exclusions

`admitCurrentAction`、plan authority/epoch、member obligation、component receipt、no-action freshness resume、dynamic route、`BoundExecution`、`EffectCommitResult` は追加しない。
