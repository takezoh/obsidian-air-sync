---
change: change-20260827-late-bound-sync-execution
role: verification
---

<!-- lifecycle is owned by change.md -->

# Verification

## T0 — pure and deterministic contracts

- Admission emits no direction, preserves complete component evidence and exact stable
  member-obligation IDs, revokes old epochs, and rejects incomplete/ambiguous scope.
- Decision tests prove current paired identity/path evidence selects an effect for every
  admitted member obligation or leaves the component failed/nonterminal.
- Effect×scheduler-state tests cover transfer→conflict/structural and backward-natural
  conflict→transfer, structural→conflict, and structural→transfer without forbidden
  overlap, duplicate receipt, or ownership leak, while retaining conflict/rename ordering
  and disjoint-path concurrency.
- Churn tests prove bounded calls per quantum, nonterminal yield, finite completion after
  quiescence, continuous-churn diagnostics, and checkpoint blocking.
- Commit tests prove existing two-argument whole-record
  `compareAndPut(expectedRecord, nextRecord)` only for single-record content, with path
  read from the records and no third argument or new API; current
  component-owned structural write ordering, no success/checkpoint on partial failure,
  replay convergence when an earlier write remains, unchanged shared state APIs and
  `SyncRecord`/IndexedDB schema, and exact tracker ack.
- Finalization rejects missing, duplicate, unknown, failed, blocked, nonterminal,
  obsolete-epoch, member-set-inexact, member-incomplete, and freshness-invalid evidence.
  Multi-member partial success followed by failure emits no component receipt/checkpoint.

## T1 — integration and replay

- File-open completes before all unstarted normal components; later same-path normal
  work observes the admitted identity plus independent current path occupant/absence and
  becomes no-action/current merge without stale policy.
- Google Drive client/targeted-observation tests prove complete pagination of every same-
  parent/name candidate and the 0/1/>1 absence/current/conflicting partition; they prove
  `findChildByName(pageSize=1)` is not used as absence authority. Dropbox/OneDrive tests
  prove the same absence/current/conflicting/unverifiable output partition through their
  path-metadata seams. Identity-missing/path-occupied, replacement/structural,
  conflicting, and unverifiable cases emit no I/O/no-action and do not mutate global
  delta/cache/checkpoint state.
- Point evidence outside the frozen component performs no structural I/O or successful
  receipt. Complete expanded authoritative delta evidence re-admits the same ID at a new
  epoch, acquires the full union, and re-observes before I/O.
- No-action is invalidated by Local/SyncRecord change or stale/unverifiable identity-plus-
  path evidence. A remote mutation after the frozen cut, together with a sibling, remains
  available to the next delta.
- With a usable committed cursor, after one component commits and another remains
  incomplete, next incremental work returns target plus sibling without
  `list()`, COLD, or a recovery-only provider call. The earlier SyncRecord remains and
  converges. The test asserts the outcome, not a particular private restoration procedure.
- Provider cursor rejection/expiry enters the existing typed COLD policy. The same test
  proves ordinary drift/failure with a usable cursor cannot enter COLD.
- Replace ADR 0001 Decision 2's ordinary same-session forced-COLD witness with a usable-
  cursor target-plus-sibling replay witness, while retaining crash, cursor-expiry/reset,
  rescan, scope-widening, and missing-checkpoint COLD coverage.
- Failure to establish last-committed replay is a typed checkpoint failure and never clean
  success.
- Google Drive, Dropbox, and OneDrive preserve opaque token equality and detached
  no-global-mutation behavior; no provider ordering or enumeration is introduced.

Focused commands:

```bash
npm test -- src/sync/plan-admission.test.ts src/sync/plan-executor.test.ts src/sync/priority-coordinator.test.ts src/sync/sync-cycle-finalization.test.ts
npm test -- src/sync/orchestrator.test.ts src/sync/state.test.ts src/sync/local-tracker.test.ts
npm test -- src/fs/caching/remote-fs.contract.test.ts src/fs/googledrive/targeted-observation.test.ts src/fs/dropbox/targeted-observation.test.ts src/fs/onedrive/targeted-observation.test.ts
```

## T2 — optional provider fidelity

Credentialed `npm run test:e2e:{google,dropbox,onedrive}` may supplement provider
fidelity. It is not part of the repository gate and does not create runtime capability
or release state.

## Mechanical gate

Run exactly:

```bash
npm run lint
npm run lint:bot-repro
npm run build
npm test
```

All four commands must pass. Tests may be strengthened but not skipped, disabled, or
weakened.

## Implementation evidence — 2026-08-28

- RED witness: disabling the private same-session replay branch made
  `src/fs/caching/remote-fs.contract.test.ts` lose both the target and sibling delta;
  restoring the branch returned the contract to green without a provider call or list.
- Direction-free Admission preserves a stable component ID while authoritative expansion
  replaces the in-memory epoch. Exact component receipts reject duplicates, obsolete epochs,
  incomplete member sets, and incomplete no-action freshness witnesses.
- Late routing tests prove push↔pull may execute within the transfer barrier and cross-phase
  transfer→conflict, conflict→transfer, and structural→transfer work re-enters a bounded
  same-cycle quantum without performing I/O in the wrong scheduler state. Repeated
  incomparable evidence consumes exactly three attempts, emits diagnostics, and remains
  nonterminal/checkpoint-blocking.
- The file-open integration witness proves strict priority over an unstarted sixth batch
  member and proves that member late-plans after the fast pass rather than reading the
  remote through its frozen pull.
- Existing two-argument `compareAndPut(expectedRecord, nextRecord)` is called for
  baseline-bearing content effects; mismatch preserves the winning record. No persisted
  schema or `DB_VERSION` changed.
- Google Drive complete same-name pagination and Google Drive/Dropbox/OneDrive paired
  identity/path replacement-conflict tests pass.
- Normal pull/conflict content is read through the identity/token-bound observation rather
  than a later unbound path read. No-action completion carries Local generation, whole-record,
  paired occupant, frozen-delta, component/member, and latest-epoch witnesses revalidated
  under the complete component path lease.
- Multi-member partial success followed by failure emits no component receipt; the retained
  effect remains recoverable through the uncommitted incremental delta.
- A local edit arriving while a bound push write is in flight invalidates the pre-commit
  generation/record/entity guard; the same admitted member replans and uploads the newer
  bytes without committing the stale baseline. An edit arriving during an identity-bound
  pull read is likewise preserved and merged from current state.
- A push revalidates the exact Remote observation after binding Local content and before
  every I/O attempt, including retries after backoff. A concurrent same-identity revision
  therefore reroutes to conflict in the same cycle and preserves the newer Remote bytes
  instead of overwriting them.
- Conflict execution rechecks generation, the whole SyncRecord, and the original Local
  entity plus the bound Remote identity/token/occupant after asynchronous merge preparation
  and before its first mutation. Before baseline commit it also verifies the resolver-produced
  Local entity and current record; Local edits, Remote revision changes, or recreation of
  an authoritatively absent Remote path in these windows keep the member nonterminal and
  replan it in the same cycle.
- Final no-action occupant, Local generation/entity, or whole-record invalidation resumes
  only the affected member under the same Admission while retaining terminal siblings;
  an exact absent-record witness may commit cleanly. Structural extra endpoints reject a
  replacement whose current identity differs from the frozen component identity.
- Dropbox, Google Drive, and OneDrive each distinguish authoritative path absence from
  replacement; Dropbox and Google Drive now also prove token change across an identity-bound
  read returns `target_changed`.
- Required gate passed exactly: `npm run lint`, `npm run lint:bot-repro`, `npm run build`,
  and `npm test` (101 files, 1,674 tests).

## Closure criteria

Closure requires every FR-LATE requirement to have a discriminating normal and
adversarial witness, all resolved critique issues to remain resolved in implementation,
provider identity/path parity contracts and exact component/member completion tests to
pass, usable-cursor replay to occur without `list()`/COLD, cursor-expiry partition tests
to pass, persisted schemas to remain unchanged, and the full gate to be green.
