---
change: change-20260901-admission-priority-pull
role: requirements
---

<!-- lifecycle is owned by change.md -->

# Requirements

## Functional requirements

- **FR-1:** file-open が tracked regular file を対象にした場合、system は global delta/cache/checkpoint を変更しない detached Remote observation を実行しなければならない。
- **FR-2:** active batch の Admission が exact pending singleton `pull` を priority-substitutable と証明し、Local precondition と whole-record CAS が成功した場合、system はその exact action object だけを supersede しなければならない。
- **FR-3:** rename、folder/subtree、alias、conflict、delete、multi-action、unknown observation、closed phase の path は effect 前に normal batch へ defer しなければならない。
- **FR-4:** normal action permit は filesystem effect、`commitAction()`、terminal result publication の完了まで保持されなければならない。
- **FR-5:** finalization lease は completion proof、checkpoint commit、rename debt deletion の完了まで priority mutation を排除しなければならない。
- **FR-6:** priority local write 後の whole-record CAS failure は supersession を発生させず、dirty evidence を残し、該当 pending pull の stale effect と clean checkpoint を禁止しなければならない。
- **FR-7 (invariant):** normal batch は `snapshot -> AdmissionResult -> AuthorizedSyncPlan -> executePlan -> finalizeSyncCycle` の一方向を維持し、component ごとの targeted Remote call、execution-time re-Admission、runtime reroute を行ってはならない。
- **FR-8:** cold hash enrichment の candidate 数、match 数、user-visible matched count は priority integration 前後で同じ batch observability を維持しなければならない。

## Non-functional requirements

- provider 差異は optional `IFileSystem.priority` capability に収束させる。
- cycle coordination は exact object reference の process-local stateだけを使い、schema migrationや durable markerを追加しない。
- existing global phase barriers と Admission-owned rename lifecycle を維持する。
