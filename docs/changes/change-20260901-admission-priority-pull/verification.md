---
change: change-20260901-admission-priority-pull
role: verification
---

<!-- lifecycle is owned by change.md -->

# Verification

## Focused acceptance

- provider contract: detached observe/read が identity、occupant、ancestry、version-bound read を検証し、global batch state を変更しない。
- coordinator: planning、active normal effect+commit、finalization と priority が重ならない。
- Admission: exact singleton regular-file pullだけが positive witnessとなり、multi-path/structural/conflict/deleteは fail closedとなる。
- Executor: CAS成功済み exact reference は I/O 0回で superseded、invalidated action は blocked、foreign reference は terminal にならない。
- Finalization: succeeded または Admission-marked superseded exact actionだけで checkpoint/debt releaseを許可する。
- Orchestrator race: priority read中の Local edit、write後CAS loss、queued file-open、finalizer競合を決定的 promise seam で検証する。
- call count: normal batch の `priority.observe/read` は component 数にかかわらず0回。
- observability: `hashEnrichmentCandidates`、`hashEnrichmentMatches`、matched count が維持される。

## Commands

```bash
npm test -- --run src/fs/caching/remote-fs.contract.test.ts src/fs/remote-backend-contracts.test.ts src/fs/registry.test.ts
npm test -- --run src/sync/priority-coordinator.test.ts src/sync/local-mutation-barrier.test.ts src/sync/state.test.ts src/sync/state-committer.test.ts
npm test -- --run src/sync/plan-admission.test.ts src/sync/plan-executor.test.ts src/sync/sync-cycle-finalization.test.ts
npm test -- --run src/sync/orchestrator.test.ts src/sync/rename-debt.test.ts
npm run lint
npm run lint:bot-repro
npm run build
npm run test:coverage
npm run test:e2e
```

E2E は credential-gated。各 backend の実行結果を個別に報告し、未実行を unit/contract test の代用にしない。

## 2026-09-01 results

- repository gate: `npm run lint`、`npm run lint:bot-repro`、`npm run build`、`npm run test:coverage` は成功。全 unit は 90 files / 1,651 tests passed、coverage threshold も満たした。
- contract wiring: `src/fs/contracts/` は公開意味論、backend の `ifilesystem.contract-harness.ts` は faithful fake と provider route、`remote-backend-contracts.test.ts` は唯一の remote unit composition root。3 implementation families × 4 contracts の12cellを中央登録し、任意のcell削除で TypeScript required-property error になることを確認した。registry guard は全6 providerが既知の3 FS implementation familyへ収束することを検証する。coverage ownership は全 harness を単一の `src/**/*contract-harness.ts` glob で除外する。
- shared priority capability contract: Google Drive、Dropbox、OneDrive が同一 runner で current/read、read 中の version 変化、missing/replacement、不完全 evidence を満たす。version-token 比較を除去する mutation では3 backendとも判別 test が失敗した。checkpoint 非干渉は Priority contract ではなく generic `CachingRemoteFs` integration contract が所有する。
- integrated priority tests: detached provider I/O、local-edit race、whole-record CAS loss、exact pending pull supersession、normal batch call exclusionを含め成功。
- live E2E: Google Drive、Dropbox、OneDrive の Priority fidelity 4 cases は各 backend で成功。aggregate は Google Drive / Dropbox が全件成功、OneDrive は既存 CRUD case 1件で Graph `patchMtime` が一時的に504となり 162/163、同一caseの直後の単独再実行は成功した。認証・transport・isolationを通った live semantic evidence と、provider transient を区別して記録する。
- live Google finding: Drive の metadata `version` は write 直後の観測間で変化し、無変更の read を false `target_changed` にした。content-read tokenを `md5Checksum + size` に変更し、path/identity は独立 occupant observation が引き続き保護する。修正後の Google Priority live 4 cases は4/4成功。
- cold hash observability:既存の `hashEnrichmentCandidates` / `hashEnrichmentMatches` と matched notification assertions を含む全 unit suite が成功。
- independent review remediation: actionless non-exact dispositionのdefer、detached contradiction/CAS lossのcheckpoint block、fatal terminal publish-before-release、finalizer途中のpriority排他、通常batch priority call-count 0、public file-open→detached read→local writeを追加検証。
