---
change: change-20260922-backend-layer-namespace-reconciliation
role: verification
---

<!-- lifecycle is owned by change.md -->

# Verification

## Content

### Success conditions

This change is done when every acceptance criterion in the requirements member has evidence, the
gate (`npm run lint && npm run lint:bot-repro && npm run build && npm run test:coverage`) is green,
the removed machinery is gone from the production import graph, and `AGENTS.md` / the governing
design documents reflect the new mutation boundary.

### Tier map

| tier | meaning here |
|---|---|
| T0 | unit tests over the arbiter, the drain and the filesystem reconciliation; the existing `remote-fs.contract.test.ts` |
| T1 | cross-module behaviour through the shared contract composition root, plus lint / build / coverage |
| T2 | opt-in live e2e against the real provider (`npm run test:e2e:google`), not in the gate |

### Where the load-bearing evidence goes

| verification | file | asserts |
|---|---|---|
| verify-public-delta-has-no-contention | `src/fs/caching/remote-fs.contract.test.ts` | `RemoteDelta` carries no contention; both ids are reachable after reconciliation |
| verify-deletion-attribution-internal | `src/fs/caching/remote-fs.contract.test.ts` | displaced addresses excluded from `deleted`; genuine deletion and out-of-root move still deleted |
| verify-rename-non-keeper-by-identity | `src/fs/caching/remote-fs.contract.test.ts` / managed harness | the non-keeper is renamed on the backend; the keeper is untouched |
| verify-keeper-policy-per-call | `src/fs/managed/managed-remote-fs.test.ts` | the policy is consulted per contention and the filesystem stores no state |
| verify-capability-absent-no-mutation | `src/fs/caching/remote-fs.contract.test.ts` | no capability ⇒ no provider mutation |
| verify-reconciled-cycle-not-committed | `src/sync/orchestrator.test.ts` | `changed` ⇒ `abortWorkingView`, no `commitCheckpoint`, cursor unchanged |
| verify-next-cycle-settled | `src/sync/orchestrator.test.ts` | the retry cycle observes settled facts and is clean |
| verify-refused-rename-nonclean-retried | `src/sync/orchestrator.test.ts` | `failed` ⇒ non-clean cycle, retried, no collision record |
| verify-no-admission-contention-stage | `npm run build` + `src/sync/plan-admission.test.ts` | no contention stage / `withheldAddresses` / `checkpointBlocked` symbol survives |
| verify-guards-green-no-fixture-edits | `npm run lint:bot-repro` | both AST guards pass with unmodified fixtures |

### Regression witness (RED-first)

The production-path RED from the debug investigation (`managed-collision.test.ts` against a faithful
in-repro adapter) is the starting witness: it drives the real `ManagedRemoteFs` over two cycles and
asserts that a settled provider derives no contention after the repair. Under this change the same
shape must hold with no `contended` field at all, and the retry must converge. The former
`plan-admission-address-contention.test.ts` cases are re-homed as filesystem reconciliation cases.

### Live evidence

`npm run test:e2e:google` exercises the real Drive same-named-sibling and same-named-folder shapes;
under this change the assertion moves from "a contention is planned and blocked" to "the filesystem
renames the non-keeper, the retry converges, and both objects sync". Creds-gated, not in the gate.

## Content

### Known gaps

- No live assertion of a permanently refused rename against a real Drive account
  (`provider-refusal-completion`).
- The extra provider read cost of a contended cycle (`reconciliation-read-cost`) is reasoned, not
  measured.
- OneDrive duplicate-name producibility remains the unsettled unknown inherited from
  change-20260916; its shared-contract cell stays a cited non-producibility.
