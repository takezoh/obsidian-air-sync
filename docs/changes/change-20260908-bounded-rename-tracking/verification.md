---
change: change-20260908-bounded-rename-tracking
role: verification
---

<!-- lifecycle is owned by change.md -->

# Verification

Implementation evidence was collected against implementation HEAD `8439d48eb37b5c6cf5bbc7ba02d622900312547a`. The independent cross-task review returned `approved` with no findings after production-pipeline counterexample testing.

## T0 — Observation, Admission, and protocol

- Unique complete relations retain native rename; contradictory complete relations abandon only the relation.
- Positively distinct exact/provider occurrences emit ordinary actions; equal bytes do not collapse those paths.
- Affirmative current-cycle alias resolution emits one typed `preservation_cover`; exact/provider facts without a current alias edge do not.
- Three exact versions A/B/C produce three children; A/A/A inside one collision produces one child.
- Unknown bytes and same-path provider duplicates that cannot each be enumerated/resolved/read are non-executable observation failures.
- Observation alone performs targeted reads/hash enrichment for the one potential direct candidate per current-alias anchor/version; candidate facts carry no component edge, selected `P`, action, or disposition.
- `plan-admission-graph` builds once, selects `P` by minimum UTF-8 bytes, partitions exact versions, unions only same-byte candidates, and leaves foreign candidates in independent ordinary components.
- Admission receives no filesystem capability and cannot invoke `list`, `stat`, or `read`.
- Candidate allocation is exactly `insertConflictSuffix(P, fullSha256)`, is permutation-stable, and has no alternate, ordinal, family, frontier, timestamp, or truncated digest.
- Unrelated generic conflict names and other-digest siblings remain ordinary actions rather than being absorbed by the cover component.
- Foreign occupancy or unavailable/excluded-status-unknown candidate scope returns `preservation_destination_unavailable` before any cover effect.
- The discriminated cover protocol contains fixed children and no provider-normalization key or same-cycle reroute permission.

## T1 — Execution and convergence

- Before every ordinary and cover write, executor authoritative stat accepts only the admitted vacancy/exact endpoint.
- A latent occupant discovered by this stat causes zero destination write effect, retains a prior successful component prefix, blocks the suffix, and leaves checkpoint unchanged.
- A rename-plus-write re-stats the moved destination after rename and before its write; a newly arrived occupant is not overwritten or published.
- The failed cycle does not convert its ordinary action into a cover or allocate another suffix.
- A fresh next cycle admits a cover only when a different path is positively joined by current-cycle alias resolution; after cover completion an unchanged cycle is `up_to_date`.
- As the negative control for `verify-next-cycle-cover`, a foreign-byte occupant at the same exact path enters the existing same-path conflict flow and emits no `preservation_cover`.
- A provider that still cannot expose independently addressable same-path duplicates remains an observation failure with zero original mutation.
- Cover capture never mutates originals or chooses a content winner.
- Each child proves exact bytes on both sides before its `SyncRecord` publication.
- Failure after child B publication retains A/B in both durable per-child records and the terminal conflict projection; retry performs only missing C while projecting A/B/C in admitted order, and the following cycle is `up_to_date`.
- A terminal partial cycle clears the captured file/folder rename report while leaving the checkpoint unchanged; the next cycle converges from current paths, and events recorded after capture remain pending.
- Folder rename capture marks both roots dirty. After relation abandonment, even with an unrelated retained dirty file, absent unbaselined roots promote HOT to WARM and rediscover descendants instead of committing a false no-action checkpoint.
- A complete cover is `resolved_no_action` despite asymmetric originals and does not grow on retry.
- COLD, WARM, and HOT reconstruct that fixed point for one or three versions, including a single dirty original, unrelated dirty files, and candidate casing aliases.
- A HOT component with current occurrences and no baseline promotes to WARM using the already fetched remote delta; exact dirty facts survive composition and conflicting list/stat facts abort.
- A publication-only retry performs no file write and publishes against the observed absent baseline.
- Candidate terminal proof rejects `requested_echo` and publishes only actual-resolved admitted endpoints.
- Conflict history exposes all candidate paths in child order while preserving the legacy first duplicate path.
- Cleanup is cover-before-delete and exact-CAS only.

## Prior implementation failure regressions

- `verify-direct-candidate-full-digest`: rejects any path other than `insertConflictSuffix(P, fullSha256)` and rejects digest truncation.
- `verify-no-alternate-candidate`: rejects every ordinal, family, frontier, or retry-selected alternate.
- `verify-foreign-candidate-independent`: rejects absorption or cleanup of a different-byte candidate and requires its read-only witness to produce `preservation_destination_unavailable`.
- `verify-same-byte-candidate-union`: requires a matching candidate edge and union of its local/remote endpoint facts.
- `verify-unrelated-conflict-files-ordinary`: rejects absorption of unrelated conflict-looking files.
- `verify-direct-candidate-fact-only`: rejects candidate-to-component edges or proposed actions in Observation carriers.
- `verify-one-build-candidate-partition`: rejects iterative Admission rebuild/frontier and checks same-bytes, foreign-bytes, absent, and unavailable partitions.
- `verify-candidate-destination-scope-unavailable`: rejects cover execution when the generated destination's scope is unknown or excluded.
- `verify-direct-candidate-fixed-point`: rejects additional siblings after all direct full-digest versions are terminal.
- `verify-hot-warm-fixed-point`: rejects acquisition-temperature or unrelated-dirty-path changes to a completed one- or three-version cover and requires one remote-delta acquisition.
- `verify-hot-warm-fact-composition`: rejects loss of exact dirty-path hashes during promotion and rejects contradictory HOT/list facts.
- `verify-terminal-path-authority`: rejects publication from `requested_echo` or a changed actual endpoint.
- `verify-ordered-cover-projection`: requires every successful child candidate in audit order.

Contract-to-test coverage is exact: C01 `verify-current-alias-authority`; C02 `verify-min-utf8-anchor`; C03 `verify-direct-candidate-full-digest` plus `verify-no-alternate-candidate`; C04 `verify-direct-candidate-fact-only`; C05 `verify-one-build-candidate-partition`; C06 `verify-same-byte-candidate-union`; C07 `verify-foreign-candidate-independent`; C08 `verify-absent-candidate-preflight` plus `verify-no-same-cycle-reroute`; C09 `verify-direct-candidate-fixed-point` plus child-publication and cleanup tests; and C10 `verify-terminal-partial-tracker-consumption` including same-metadata edit retry and abandoned-folder breadth recovery.

## Cleanup negative tests

- A current same-exact-path terminal pair retains its record.
- The selected same-byte candidate retains its record; a foreign candidate remains an ordinary component and never enters cleanup.
- A one-sided ordinary exact-path action retains the baseline it will publish against.
- Report disappearance on retry yields the same current-fact cleanup predicate.
- Cleanup completion cannot regenerate delete authority from record absence.

## T2 — Structural guards

- `sync-admission-authority-guard.test.mjs` rejects filesystem imports/capabilities or `list`/`stat`/`read` calls from Admission and rejects actions in fact carriers.
- `sync-state-ownership-guard.test.mjs` rejects any third durable authority or history read by correctness code.
- No `IFileSystem`, LocalFs, remote backend, or shared filesystem contract file changes in this change.
- Exact trace links every FR to an ADR/contract, implementation unit, and acceptance or verification reference.

## Executed commands

```bash
npm test -- --run src/sync/sync-cycle-planning.test.ts src/sync/path-observation.test.ts src/sync/plan-admission.test.ts
npm test -- --run src/sync/conflict.test.ts src/sync/conflict-resolver.test.ts src/sync/plan-executor.test.ts src/sync/state-committer.test.ts
npm test -- --run src/sync/convergence.test.ts src/sync/delete-safety.test.ts src/sync/crash-safety.test.ts
npm test -- --run src/sync/orchestrator.test.ts
node --test sync-admission-authority-guard.test.mjs sync-state-ownership-guard.test.mjs
npm run lint
npm run lint:bot-repro
npm run build
npm run test:coverage
```

Final gate result: lint passed; bot reproduction passed (55 guard tests plus source scan); build passed; coverage passed with 95 files and 1,982 tests. Independent review additionally exercised HOT/WARM composition, three-version fixed points, candidate aliases and foreign occupants, publication retry, requested-echo rejection, rename controls, and single remote-delta acquisition through the production pipeline. The Personal-vault regression added partial-cycle relation-abandonment, equal-mtime/equal-size failed-edit retry, abandoned-folder breadth recovery, rename-write latent-occupant rejection, ordered partial-cover projection, missing-only three-version retry, next-cycle latent-alias convergence, and unaddressable provider-duplicate coverage, then reran the full gate.
