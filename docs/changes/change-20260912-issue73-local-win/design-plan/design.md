# Prefer local — integrated technical design

This change adds one peer conflict strategy without changing ordinary bidirectional sync. The design applies the repository's accepted Admission ownership, attempt-only evidence, single conflict route, and two-publication invariants; it creates no new persistent ADR or correctness owner.

<!-- anchor: fr-pl-001 -->
## FR-PL-001 — selectable and understandable

When the conflict setting is shown, Air Sync shall offer **Prefer local** beside Auto merge and Duplicate and associate its label with copy stating: conflict-only; proven two-sided edits use local content; uncertain collisions preserve both without prompting. The association must work for pointer, keyboard, touch, and screen-reader use.

<!-- anchor: fr-pl-002 -->
## FR-PL-002 — ordinary sync remains bidirectional

While Prefer local is configured, one-sided local/remote edits and creations shall retain the existing push/pull result. The new policy is consulted only after scope projection and existing conflict candidacy.

<!-- anchor: fr-pl-003 -->
## FR-PL-003 — exact local-win proof

For a simple same-path two-sided edit/edit candidate, local-win is authorized only when a non-empty successful `SyncRecord.hash` supplies the common SHA-256 baseline and current local and remote `FileEntity.hash` SHA-256 facts prove all three inequalities: `local.hash != baseline`, `remote.hash != baseline`, and `local.hash != remote.hash`. No record existence, identity, mtime, size, empty hash, or differently-algorithmic checksum proves any relation.

<!-- anchor: fr-pl-004 -->
## FR-PL-004 — closed safe outcomes

No baseline, empty baseline hash, unavailable or unstable read, mutation between capture and use, edit/delete, compound identity/rename conflict, or any unproved comparison shall never authorize local-win. Same current bytes remain a match; edit/delete keeps the sole survivor; simple uncertain same-path collisions use the existing Duplicate preservation placement; compound conflicts use their existing complete preservation obligations; evidence acquisition/stability failure is non-clean and performs no destructive suffix.

<!-- anchor: fr-pl-005 -->
## FR-PL-005 — one decision and execution route

Observations carry only current metadata and fingerprint facts. Admission alone attaches one of the two closed dispositions `local_win_allowed | preservation_required` to a Prefer-local conflict action. Same-content remains the existing match path; edit/delete remains the existing one-sided conflict and resolver survivor behavior; compound cases remain governed by existing action/topology and preservation obligations. Resolver and executor consume the disposition without re-deriving eligibility, and all conflicts retain the existing apply-time exact snapshot capture and revalidation, preservation-before-destruction, original-path effects, terminal proof, ordered receipts, and publication route.

<!-- anchor: fr-pl-006 -->
## FR-PL-006 — attempt lifecycle and retry

Proof fingerprints and disposition are attempt-bounded, non-logged, and non-persistent. Exact snapshots exist only within the existing resolver/executor apply-and-revalidate interval. A file `SyncRecord` is published only after admitted I/O and terminal proof; cursor/derived cache/scope checkpoint only after a wholly clean cycle. Failure aborts the attempt view after sibling effects settle and the next attempt re-observes current facts; no recovery marker or stopped-state branch is added.

<!-- anchor: fr-pl-007 -->
## FR-PL-007 — compatibility and cost

`auto_merge` and `duplicate` shall incur exactly zero additional local or remote body reads from Prefer-local proof enrichment and retain existing classification and read-failure surfaces. Saved `ask` remains normalized to Duplicate, unknown values to Auto merge, default remains Auto merge, and saved `prefer_local` round-trips. COLD/WARM/HOT with the same complete current facts produce the same Admission disposition.

<!-- anchor: nfr-pl-001 -->
## NFR-PL-001 — bounded work and confidentiality

If a cycle has N scoped files and K post-scope, baseline-backed, two-sided conflict candidates under `strategy === prefer_local`, enrichment performs body reads only as needed to complete current SHA-256 `FileEntity.hash` facts for those K candidates. BatchObservation and Admission retain no `ArrayBuffer` or other exact content snapshot. Logs and durable state contain no bodies or proof directives.

This change requires no new ADR. The contracts below apply the repository's accepted ADRs and AGENTS.md rules directly: Admission remains the sole policy owner, observations remain fact-only and attempt-bounded, every conflict uses the existing execution route, preservation precedes destruction, and the two commit-last publication points remain exclusive.

<!-- anchor: component-pl-fact-acquisition -->
<!-- anchor: contract-pl-proof-acquisition -->
## Contract — candidate-bounded SHA-256 fact completion

Owner: existing `change-hash-enrichment` path within the sync-cycle planning/change detection boundary; policy output owner remains Admission. Inputs are the normalized current-attempt strategy, post-scope candidate shape, successful `SyncRecord`, and current local/remote `FileEntity` facts. The invariant predicate is:

`strategy === prefer_local && afterScope && simpleSamePath && bothPresent && baselineRecord.hash !== "" && temporalCandidate`.

Only when it holds may the existing enrichment path read an endpoint whose current common-algorithm fact is missing and populate its current SHA-256 `FileEntity.hash`. A provider checksum may avoid a remote body read only when its declared algorithm is SHA-256; opaque, missing, differently-algorithmic, identity, mtime, and size values are never proof. If the fact cannot be completed, return unavailable/stale facts, not an action. `BatchObservation` and Admission receive fingerprint facts only, never the read `ArrayBuffer`; resolver/executor continue to acquire and revalidate exact snapshots at application time. Auto merge and Duplicate take the unchanged path with zero enrichment body reads.

Outcome partition is exclusive: complete facts; unavailable facts; stale/mutated facts; not-applicable. Only complete facts reach the proof predicate. Unavailable/stale becomes non-clean before destructive work when capture was required. Not-applicable preserves the existing strategy path. This component never emits an action, winner, directive, recovery instruction, or durable field.

Normal witness: under Prefer local, one qualified candidate completes only the missing current SHA-256 facts through the existing enrichment path. Adversarial witness: injected remote read failure under Duplicate is never observed because read count is zero; the same failure under required Prefer-local fact completion produces a non-clean result and no mutation/publication. A captured enrichment buffer is discarded after hashing and cannot be observed in BatchObservation or Admission.

<!-- anchor: component-pl-admission -->
<!-- anchor: contract-pl-admission -->
## Contract — closed Admission disposition

Owner: `identity-component-decision.ts`, the sole Admission owner. The pure decision table, after same-content matching and topology binding, is:

| Current component | Proof state | Disposition |
|---|---|---|
| simple same-path, both present | baseline non-empty; local, remote, and baseline all common SHA-256; all three inequalities true | `local_win_allowed` |
| simple same-path, both present | same current SHA-256 | existing match, no conflict copy |
| simple same-path, both present | no/empty baseline, incomplete comparison, unavailable proof | `preservation_required` using Duplicate placement |
| edit/delete | changed survivor exists | existing one-sided conflict action and resolver survivor behavior; no Prefer-local disposition |
| rename/identity/compound | any | existing action/topology and preservation obligations; never simple local-win |
| capture mutation or stability loss | any | typed non-clean failure; no destructive suffix |

Record existence, `remoteIdentityKey`, mtime, size, and optional merge-base bytes cannot promote a row. The disposition is attempt-local on the existing authorized conflict action. Missing or invalid disposition with `prefer_local` fails fast as an internal contract violation; resolver may not infer one from the strategy name or action kind.

The Prefer-local conflict disposition is exactly `local_win_allowed | preservation_required`. Outcome coverage also includes the pre-existing match, edit/delete survivor, and compound topology paths, unknown facts, conflicting apply-time revalidation, and failure. Precedence is match, existing survivor/compound topology obligations, simple proof, preservation fallback, then typed failure. A Prefer-local conflict action with a missing or invalid disposition is a fatal internal contract violation; there is no permissive default.

<!-- anchor: component-pl-execution -->
<!-- anchor: contract-pl-execution -->
## Contract — unified conflict effects and publication

Owner: existing conflict resolver plus plan executor. At application time the resolver/executor acquire and revalidate exact endpoint snapshots. `local_win_allowed` selects that exact local snapshot for both originals and requires no ordinary conflict copy. `preservation_required` uses existing Duplicate capture and verified output placement. Edit/delete selects the sole edited survivor through existing behavior; compound obligations preserve and read back every policy-required observed version before any rotation, deletion, or replacement. Resolver captures/selects but never mutates original paths; executor alone applies original effects, verifies exact terminal bytes/identity/output coverage, and publishes successful receipts in admitted component order. Any read/write/readback/CAS/stability failure blocks the destructive suffix and publication. Retry reclassifies current facts.

<!-- anchor: component-pl-settings -->
<!-- anchor: contract-pl-settings -->
## Contract — settings and evolution

Owner: settings type, normalizer, and UI. The closed strategy union becomes `auto_merge | duplicate | prefer_local`; default stays `auto_merge`; `ask -> duplicate`; unknown -> `auto_merge`; `prefer_local -> prefer_local`. Consumers, execution audit projection, UI value and docs use the same union. This is additive for current consumers; no data migration or prompt is introduced.

<!-- anchor: component-pl-verification -->
<!-- anchor: contract-pl-verification -->
## Contract — verification and guards

T0 table tests prove the SHA-256 predicate, empty hash, absent record, checksum absence/algorithm mismatch, remote-read fallback, equal-current bytes, edit/delete, and compound partitions. T1 tests prove strategy-gated read counts and injected failures, COLD/WARM/HOT equivalence, resolver/executor effects, preservation-before-destruction, interruption and current-facts retry, and UAC-001..018. AST/state guards prove no second policy owner, action-bearing observation, new durable owner, or publication route. T2 is the repository gate: `npm run lint && npm run lint:bot-repro && npm run build && npm run test:coverage`.

<a id="unit-pl-01"></a>
## Chunk 1 — strategy wire and setting

Targets: `src/sync/types.ts`, `src/settings-normalize.ts`, its tests, `src/ui/settings.ts`, execution audit consumers. Add the strategy and attempt-only closed disposition, normalization and accessible explanatory copy. Verify round-trip/default/ask/unknown and UI association. Failure semantics: invalid wire fails tests/typecheck; no behavior is enabled before later chunks. No rollback branch is added.

<a id="unit-pl-02"></a>
## Chunk 2 — strategy-gated SHA-256 fact completion

Targets: primarily `src/sync/change-hash-enrichment.ts`, with the smallest necessary call-site changes in `src/sync/change-detector.ts` or `src/sync/sync-cycle-planning.ts`, plus focused tests. After scope projection, apply the exact gate in the acquisition contract and complete only missing current SHA-256 `FileEntity.hash` facts. Do not add exact-content fields to `BatchObservation` or Admission. Verify per-strategy read counts, injected local/remote failures, mutation, provider-checksum fast path, and COLD/WARM/HOT equality. Failure is non-clean with no action or publication; next attempt starts fresh.

<a id="unit-pl-03"></a>
## Chunk 3 — Admission proof partition

Targets: `src/sync/identity-component-decision.ts`, existing content helpers only if a local private placement is useful, `src/sync/plan-admission.test.ts`, `src/sync/decision-engine.test.ts`, Admission authority guard. Implement the closed table and attach the binary disposition only to Prefer-local conflict actions. Verify all SHA-256 relations, empty/missing/mismatched algorithms, same content, edit/delete both directions, and compound cases. Incomplete input fails closed to preservation/non-clean as specified; no recovery state and no new helper is required.

<a id="unit-pl-04"></a>
## Chunk 4 — single-route consumption

Targets: `src/sync/conflict-resolver.ts`, `src/sync/plan-executor.ts` and focused execution tests. Consume the Admission disposition without recomputation; retain exact capture, preservation ordering, source revalidation, terminal proof and receipts. Verify proven local-win/no copy, uncertain Duplicate placement, survivor, compound preserve-all, and missing/invalid directive rejection. Partial effects publish no record and do not authorize compensating rollback.

<a id="unit-pl-05"></a>
## Chunk 5 — cycle/lifecycle acceptance

Targets: convergence, crash-safety, finalization, read-count/failure-injection, and ownership guard tests. Exercise UAC-002..018 in complete cycles across COLD/WARM/HOT and interruption points. Verify file record only after successful terminal proof, no checkpoint on incomplete cycle, abort of attempt view, sibling settlement, and fresh-facts retry. Existing Auto merge/Duplicate injected read failures remain unchanged because enrichment reads are zero.

<a id="unit-pl-06"></a>
## Chunk 6 — public contract and full gate

Targets: README, ARCHITECTURE, conflict/sync/enforcement docs only where claims change; no new ADR. Document the three strategies and exact proof/safety boundary, run the full gate, and retain all existing contract and ownership guards. Failure leaves the change unclosable; no production fallback or test disabling is permitted.

<a id="discretion-pl-private-names"></a>
## Implementation discretion — private names and placement

Unit: Chunks 2 and 3. The default is a localized extension of existing `change-hash-enrichment` plus a private Admission comparison at the existing decision site; no new helper is required. The implementer may choose concise private names and placement within the owning existing modules. It must preserve all contracts above and their tests. Escalate if this would widen a public/persisted wire, add I/O to Admission, put strategy/policy into observation, create another policy owner, or change any outcome/read count.

<a id="resolved-issue-strategy-gate"></a>
## Resolved critique — strategy-gated enrichment

`issue-prefer-local-enrichment-not-strategy-gated` is resolved by the identical predicate in the acquisition contract and Chunk 2 plus exact zero-read and injected-failure regressions for Auto merge/Duplicate. The pass-2 patch is adopted.

<a id="resolved-issue-common-hash"></a>
## Resolved critique — common fingerprint authority

`issue-common-record-proof-comparison-open` is resolved by making non-empty `SyncRecord.hash` the common SHA-256 baseline and completing current local/remote SHA-256 `FileEntity.hash` facts through candidate-bounded enrichment. A provider checksum is usable only as the same-algorithm value; all other metadata is explicitly non-proof. The user-required stricter common-authority form supersedes the pass-2 alternative that could compare side-specific historical checksums.

<a id="scope-signal-pl-shared-enrichment"></a>
## Audited scope signal — shared acquisition boundary

Kind `shared_boundary`, audited `necessary`: the existing `change-hash-enrichment` path receives only Prefer-local post-scope, baseline-backed candidate SHA-256 fact completion. Without it, hash-less WARM/COLD observations cannot prove the same three content inequalities as HOT observations; the exact strategy gate preserves zero added reads and unchanged failure surfaces for Auto merge and Duplicate. Exact snapshot transport, a new helper, and a third disposition are not part of this signal.
