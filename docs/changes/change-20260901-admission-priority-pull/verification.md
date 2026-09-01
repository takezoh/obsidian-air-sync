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
npm test -- --run src/fs/caching/remote-fs.contract.test.ts src/fs/googledrive/targeted-observation.test.ts src/fs/dropbox/targeted-observation.test.ts src/fs/onedrive/targeted-observation.test.ts
npm test -- --run src/sync/priority-coordinator.test.ts src/sync/local-mutation-barrier.test.ts src/sync/state.test.ts src/sync/state-committer.test.ts
npm test -- --run src/sync/plan-admission.test.ts src/sync/plan-executor.test.ts src/sync/sync-cycle-finalization.test.ts
npm test -- --run src/sync/orchestrator.test.ts src/sync/rename-debt.test.ts
npm run lint
npm run lint:bot-repro
npm run build
npm test
npm run test:e2e
```

E2E は credential-gated。各 backend の実行結果を個別に報告し、未実行を unit/contract test の代用にしない。

## 2026-09-01 results

- repository gate: `npm run lint`、`npm run lint:bot-repro`、`npm run build`、`npm test` は成功。全 unit は 101 files / 1,637 tests passed。
- integrated priority tests: detached provider I/O、local-edit race、whole-record CAS loss、exact pending pull supersession、normal batch call exclusionを含め成功。
- live Dropbox / OneDrive E2E: 2 suites、101 tests passed。
- live Google Drive E2E: OAuth refresh が HTTP 400 で失敗し、suite setup後の50 testsは未実行。credential refresh failureとして未検証であり、greenとは扱わない。
- cold hash observability:既存の `hashEnrichmentCandidates` / `hashEnrichmentMatches` と matched notification assertions を含む全 unit suite が成功。
- independent review remediation: actionless non-exact dispositionのdefer、detached contradiction/CAS lossのcheckpoint block、fatal terminal publish-before-release、finalizer途中のpriority排他、通常batch priority call-count 0、public file-open→detached read→local writeを追加検証。
