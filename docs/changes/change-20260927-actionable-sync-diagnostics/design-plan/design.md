# Actionable sync diagnostics — final design

Revision: `design-1`

<!-- anchor: goal -->
## Goal and architecture

A failed sync explains itself in the product's own words: every user-visible sync failure notice names the failing operation/phase, the HTTP status when the provider supplied one, and the backend-neutral cause classification the retry policy actually applied, as at most one bounded breakdown per cycle. The plugin reports the error and never assigns the user work, and no notice echoes a raw provider message, a file path, a file name, or a provider code string. The retained opt-in log keeps its whole-body provider evidence with no lossy projection, and no new durable sync state, Settings surface, command, or export control is added.

One core owner projects the cycle's in-memory failures into a bounded, ordered fact list (operation label, HTTP status, neutral ErrorKind carried from the site where the applied retry policy classified the failure); one pure formatter turns those facts into a single bounded sentence-case clause with a closed privacy rule; and every user-visible failure notice site routes through that clause without changing which notices are emitted, their gating, or the abort/retry policy. The opt-in log and its whole-body provider evidence are left byte-identical.

<!-- anchor: scope -->
## Scope

In scope:
  - src/sync/failure-facts.ts: the single bounded failure-fact projection consumed by the notice; the classification it reads is recorded upstream where the retry policy classified the failure
  - src/sync/plan-executor.ts (and its test): record on the failed action the neutral classification the provider-aware retry policy computed, the only site that can reproduce a provider re-tag such as the Google Drive 403 rate-limit
  - src/sync/execution-result.ts: the `FailedAction` observational classification field the projection reads
  - src/sync/failure-notice.ts: the pure failure-clause formatter (operation/status/classification wording and the notice privacy rule)
  - src/sync/sync-notification.ts: append the coalesced failure clause to the existing counts summary without changing the counts
  - src/sync/orchestrator.ts: route the gated completion notice and each ungated cycle-abort notice through the shared clause; preserve gating and abort/retry policy
  - src/main.ts: replace the unhandled-error raw message with the structured clause; keep the notice ungated
  - docs/error-handling.md: point classification and decideRetry at src/backend-api/error-classification.ts instead of the removed fs/errors.ts
  - tests for the above, including deliberate updates to the pinned sync-notification, logger and backend-error-log suites and the boundary/ownership guards

Out of scope:
  - Any change to the opt-in log's whole-body provider evidence, any allowlisted provider-code projection, or any path/name stripping of retained evidence
  - Any new setting, command, Settings section, copy/export control, persisted field, or migration
  - Any change to retry/abort policy, decideRetry, or AuthError cycle-abort semantics
  - Re-gating the cycle-abort notice on showSyncNotifications

<!-- anchor: requirements -->
## Requirements

<!-- anchor: req-failure-fact-single-owner -->
### req-failure-fact-single-owner (ubiquitous, must)

The cycle's user-visible failure facts (operation/phase, HTTP status when present, and neutral classification) SHALL be derived by exactly one core owner from in-memory current-cycle facts, without reading the log file and without introducing a second error taxonomy.

Rationale: stop_basis requires a single owner and value set covering every user-visible failure path.

<!-- anchor: req-classification-matches-applied-policy -->
### req-classification-matches-applied-policy (ubiquitous, must)

The classification shown for a failure SHALL be the neutral ErrorKind that the engine's retry policy applied to that failure, including a provider re-tag, and SHALL never be a provider code string.

Rationale: The displayed category must agree with decideRetry, e.g. the Google Drive 403-rate-limit re-tag.

<!-- anchor: req-representative-selection -->
### req-representative-selection (state_driven, must)

When a cycle contains more than one failure, the notice SHALL reduce them to one representative failure (the most severe by the neutral classification, else the first observed) together with the total error count.

Rationale: DP-MULTI-FAILURE-REDUCTION keeps the notice glanceable and mobile-safe.

<!-- anchor: req-unclassified-marker -->
### req-unclassified-marker (state_driven, must)

When a failure has no HTTP status or no recognized neutral classification, the notice SHALL state the operation and an explicit unclassified marker instead of guessing a category, a retryability, or a next step.

Rationale: DP-UNKNOWN-CLASSIFICATION forbids a fabricated category.

<!-- anchor: req-notice-one-breakdown-per-cycle -->
### req-notice-one-breakdown-per-cycle (event_driven, must)

When a sync burst with one or more failures completes and showSyncNotifications is enabled, the plugin SHALL emit at most one completion notice, retaining the existing counts summary and appending one bounded failure clause; it SHALL NOT emit a per-file notice.

Rationale: DP-NOTICE-SCOPE: keep the counts and the single coalesced notice.

<!-- anchor: req-notice-no-user-instructions -->
### req-notice-no-user-instructions (ubiquitous, must)

No user-visible sync failure notice SHALL assign work to the user: it SHALL contain no retryable-versus-user-action split, no suggested next step, no raw provider message text. The single exception is an authentication failure, which SHALL name the one recovery action the user alone can take (reconnect in settings).

Rationale: constraint-no-instructions and the recorded owner directive, with an authentication failure carved out because the cycle cannot recover credentials by retrying.

<!-- anchor: req-notice-privacy -->
### req-notice-privacy (ubiquitous, must)

No notice string produced by this change SHALL contain a file path, a file name, a provider code, raw provider text, or credential material; only the closed operation vocabulary, the closed ErrorKind vocabulary, and a numeric HTTP status may be emitted.

Rationale: DP-PATHS and cc-no-credentials.

<!-- anchor: req-abort-notice-covered -->
### req-abort-notice-covered (event_driven, must)

Every user-visible sync failure path, including each ungated cycle-abort notice, SHALL carry the same structured failure clause instead of a raw error message, and each such notice SHALL remain ungated so an aborted sync is never silently hidden.

Rationale: stop_basis item 1 plus constraint-abort-notice-gate.

<!-- anchor: req-log-evidence-preserved -->
### req-log-evidence-preserved (ubiquitous, must)

The opt-in diagnostic log SHALL retain the whole provider error body (nested provider codes included) and headers minus set-cookie with truncation announced, and SHALL NOT replace it with an allowlisted projection or strip paths from retained evidence.

Rationale: cc-preserve-body and DP-PROVIDER-BODY.

<!-- anchor: req-log-optin-unchanged -->
### req-log-optin-unchanged (ubiquitous, must)

Logging SHALL remain opt-in under the existing 'Enable logging' setting, this change SHALL add no setting, command, or persisted field, and the notice breakdown SHALL be produced with logging disabled.

Rationale: cc-opt-in-logging, cc-state-ownership and ctx-module-only-redaction.

<!-- anchor: req-error-doc-pointer -->
### req-error-doc-pointer (ubiquitous, should)

docs/error-handling.md SHALL point error classification and decideRetry at src/backend-api/error-classification.ts and SHALL reference no removed fs/errors path.

Rationale: handoff-stale-error-doc found the doc pointer stale after the Backend Module API consolidation.

<!-- anchor: contracts -->
## Contracts

<!-- anchor: contract-failure-fact-projection -->
### contract-failure-fact-projection

Dimension: `integration_contract`. Owner: `component-failure-facts`. Subject: Project a cycle's user-visible failures into a bounded, ordered list of failure facts carrying an operation label, the HTTP status when present, and the neutral classification the applied retry policy used, held in memory for the current cycle only.

Requirements: req-failure-fact-single-owner, req-classification-matches-applied-policy, req-representative-selection, req-unclassified-marker

Decision rules:
- **decision-operation-label** (total/determinate). IF A cycle outcome contains at least one failed action, Admission failure component, or captured cycle-abort error. THEN Each failure yields an operation label drawn from the closed vocabulary (push, pull, delete, rename, match, conflict, admission, cycle abort); an unnameable outcome yields the coarse phase with an explicit unclassified-operation marker.
- **decision-status** (total/determinate). IF A projected failure carries a thrown error or an abort error. THEN The HTTP status is the finite numeric status from getErrorInfo(error).status when present, otherwise null.
- **decision-classification** (total/determinate). IF A projected failure carries the neutral classification computed where the applied retry policy classified it. THEN The carried ErrorKind is used as-is, including a provider re-tag; when no classification was carried the neutral classifyHttpError(error) is used; no second taxonomy is introduced.
- **decision-representative** (total/determinate). IF The projection contains more than one failure. THEN Select one representative by classification severity (auth, permission, rateLimit, notFound, permanent, transient) then first-observed order, and retain the total error count.

Observable effects: observable-operation-label (single): The operation label of a failure, drawn only from the closed operation vocabulary and never a path or message.; observable-http-status (single): The HTTP status of a failure when the provider supplied one, otherwise null.; observable-classification (single): The neutral ErrorKind of a failure, identical to the kind the applied retry policy used.; observable-representative-failure (local): The single selected representative failure plus the total error count for a multi-failure cycle.

Operational inputs: input-cycle-outcome (information, single_value, producer component-cycle-execution): The closed cycle's in-memory SyncCycleOutcome (failed actions, Admission failure components, completion) plus the caught cycle-abort error.

Invariants:
  - The projection is derived only from in-memory current-cycle facts; it reads no log file and persists nothing.
  - The classification shown is the one the applied retry policy used, including a provider re-tag, and no second taxonomy is introduced.
  - The projection contains no file path, file name, provider code, or raw provider message text.
  - The projection is bounded to one representative failure plus a total count.

Failure semantics:
  - failure-outcome-unavailable (environmental, preserves/none): A cycle that produces no outcome yields no failure facts; the counts notice is unchanged.
  - failure-classification-absent (unsupported_input, preserves/none): The failure is projected with a null classification and is rendered with the explicit unclassified marker.

Verification: verify-fact-projection [T1]: Unit test over fabricated SyncCycleOutcome values asserting the projected operation, status, kind, and the representative selection order.; verify-classification-carrier [T1]: Unit test over plan-executor's executeAction asserting that a provider re-tagged 403 failure records the FailedAction carrying the applied rateLimit kind, and that the projection uses that carried kind instead of the neutral 403 permission default.

Witnesses:
- **witness-fact-normal** (normal). Given A cycle completed with one failed pull whose error classifies as notFound (404) and no Admission failure., when Project the cycle outcome into failure facts., expect The projection has one entry for operation pull with status 404 and kind notFound.; No path, message, or provider code appears in the projection.; forbidden: The classification is recomputed with a taxonomy other than the applied one.; A file path or provider message appears in the projection..
- **witness-fact-adversarial** (adversarial risks boundary). Given A provider re-tags a 403 as rateLimit (Google Drive) and the same cycle also has an actionless Admission failure with no thrown error., when Project the cycle outcome into failure facts., expect The rate-limit failure is projected with kind rateLimit and status 403.; The actionless Admission failure is projected with an operation label and the unclassified marker.; The representative is selected by severity and the total error count is retained.; The FailedAction recorded by plan-executor carries the applied rateLimit kind for the re-tagged 403, so the projection never falls back to the neutral 403 default.; forbidden: The displayed kind disagrees with the applied retry policy.; A provider code string or file path appears in the projection..

<!-- anchor: contract-notice-breakdown-format -->
### contract-notice-breakdown-format

Dimension: `security_boundary`. Owner: `component-notice-formatter`. Subject: Render one bounded sentence-case failure clause from projected failure facts under a single notice privacy rule: emit only the closed operation vocabulary, the closed ErrorKind vocabulary, and a numeric HTTP status.

Requirements: req-notice-no-user-instructions, req-notice-privacy, req-unclassified-marker, req-representative-selection, req-notice-one-breakdown-per-cycle

Decision rules:
- **decision-clause-shape** (total/determinate). IF Bounded failure facts are supplied. THEN Return one clause naming the operation with the status segment when a status exists; when no HTTP status exists or the classification is unrecognized, render the explicit unclassified marker instead of naming a category, and never return a sentence of instruction except the authentication reconnect action.
- **decision-unclassified** (total/determinate). IF No HTTP status is present, or the classification is null or is not a member of ErrorKind. THEN Render the explicit unclassified marker for the classification segment and keep the operation label.
- **decision-privacy** (total/determinate). IF Any fact field could carry provider text, a path, or credential material. THEN Emit only the closed vocabulary members and a numeric status; drop any other input value rather than rendering or sanitizing it into the clause.

Observable effects: observable-clause-text (single): A bounded sentence-case clause naming the failed operation and the neutral classification.; observable-unclassified-marker (single): The explicit unclassified marker rendered when no HTTP status exists or when the classification is unrecognized.; observable-privacy-projection (single): The returned string contains no file path, file name, provider code, raw provider text, or credential.

Operational inputs: input-failure-facts (information, single_value, producer component-failure-facts): The bounded failure-fact projection for the current cycle.

Invariants:
  - The formatter is pure: no I/O, no settings read, no clock, no randomness.
  - The returned string contains only the closed operation and classification vocabularies and a numeric status.
  - The clause never claims retryability or a generic next step; the sole exception is an authentication failure, which names the reconnect action.
  - The clause never contains a credential, path, file name, or provider code.

Failure semantics:
  - failure-facts-absent (unsupported_input, preserves/none): No clause is appended; the counts summary is unchanged.
  - failure-unexpected-fact-value (internal_violation, preserves/none): The unexpected value is dropped from the clause rather than stringified into it, keeping the privacy rule intact.

Verification: verify-format-clause [T1]: Unit test asserting the exact clause for a 401, 403, 404, 429, 5xx and a provider-translated failure, and for a null classification.; verify-format-privacy [T1]: Unit test feeding hostile fact values (path-like, token-like, provider-message-like strings) and asserting none appears in the output and no instruction verb is present.

Witnesses:
- **witness-format-normal** (normal). Given Failure facts for a push that failed with HTTP 429 and kind rateLimit., when Format the failure clause., expect The clause names push and rateLimit with status 429 in sentence case.; No instruction and no path appear.; forbidden: A retry, reconnect, or user-action instruction appears.; A file path or provider code appears..
- **witness-format-adversarial** (adversarial risks boundary). Given A fact field carries a string resembling a provider message with an embedded file path and a token, one failure has a null classification, and one transport failure has no HTTP status., when Format the failure clause., expect The provider-like string, the path, and the token are absent from the output.; The null-classification failure yields the explicit unclassified marker.; The statusless transport failure and the null-classification failure both yield the explicit unclassified marker rather than a named category.; forbidden: Provider text, a path, a file name, or a credential appears in the clause.; A retryability or next-step claim appears..

<!-- anchor: contract-notice-routing -->
### contract-notice-routing

Dimension: `control_flow`. Owner: `component-notice-routing`. Subject: Route every user-visible sync failure notice through the shared failure clause: the gated completion notice carries one coalesced clause, and each ungated cycle-abort notice carries the same structured clause instead of a raw error message, without changing which notices are emitted or the abort/retry policy.

Requirements: req-notice-one-breakdown-per-cycle, req-abort-notice-covered, req-notice-no-user-instructions, req-log-optin-unchanged

Decision rules:
- **decision-completion-notice** (total/determinate). IF The sync burst completes and showSyncNotifications is enabled. THEN Emit exactly one completion notice whose counts summary is unchanged and which appends the coalesced failure clause when the burst had failures.
- **decision-abort-notice** (total/determinate). IF An AuthError or non-rate-limit 403 aborts the cycle, or an error escapes the per-action try/catch. THEN Emit the abort notice carrying the structured clause for the aborting operation and no raw error message; the notice stays ungated.
- **decision-no-notice-change** (total/determinate). IF Any failure occurs in a burst. THEN The set of emitted notices, their count, and their gating are unchanged from today; only their text changes.

Observable effects: observable-completion-notice (single): The gated completion notice retains its counts summary and appends one coalesced failure clause.; observable-abort-notice (single): Each ungated cycle-abort notice carries the structured clause and no raw error message.; observable-notice-count (local): At most one completion notice per burst and no per-file notice, with the existing gating preserved.

Operational inputs: input-burst-outcome (information, full, producer component-notice-routing): The coalesced burst summary (CycleSummary) plus the caught cycle-abort error, both in memory.

Invariants:
  - No notice site is added, removed, or re-gated by this change.
  - The abort notice remains ungated and the completion notice remains gated on showSyncNotifications.
  - No failure notice carries a generic user instruction or a raw provider message; an authentication failure alone names the reconnect action.
  - The breakdown reads no log file and persists nothing.
  - The abort/retry policy and the Sync error status transition are unchanged.

Failure semantics:
  - failure-notice-build-throws (internal_violation, preserves/none): The notice falls back to the counts summary text; the sync status change and the abort are unaffected.

Verification: verify-routing-sites [T1]: Orchestrator tests injecting a notifier, plus the `formatSyncAbortNotice` unit test covering the unhandled-error catch composition, asserting the emitted notices carry the clause and no raw message on each failure path.; verify-routing-gating [T1]: Tests asserting one notice per burst with showSyncNotifications on and off, no per-file notice for a many-failure partial cycle, and the abort notice present with notifications off.

Witnesses:
- **witness-routing-normal** (normal). Given A burst with one failed push completes and showSyncNotifications is enabled., when Run the burst to completion., expect Exactly one completion notice is emitted with the counts summary and one appended clause.; No raw error message text appears.; forbidden: More than one notice is emitted for the burst.; A per-file notice is emitted.; A raw error message appears in the notice..
- **witness-routing-adversarial** (adversarial risks recovery). Given A cycle-level abort occurs with showSyncNotifications disabled, and a separate burst has many mixed-class failures., when Run the burst and the aborting cycle., expect The abort notice still appears (ungated) and carries the structured clause with no raw message.; The many-failure burst yields one completion notice and no per-file notice.; forbidden: The abort notice is suppressed because notifications are off.; The raw error message appears.; A per-file notice is emitted..

<!-- anchor: contract-log-evidence-invariance -->
### contract-log-evidence-invariance

Dimension: `security_boundary`. Owner: `component-log-evidence`. Subject: Keep the opt-in diagnostic log's whole-body provider evidence and its opt-in boundary invariant: no allowlisted projection, no stripping of retained evidence, no new setting, and no new emitting call site that could carry note contents.

Requirements: req-log-evidence-preserved, req-log-optin-unchanged, req-error-doc-pointer

Decision rules:
- **decision-whole-body** (total/determinate). IF A backend writes an irregular response to the log. THEN Write the entire body (nested provider codes included) and response headers minus set-cookie, with truncation announced; this change alters nothing here.
- **decision-no-projection** (total/determinate). IF A candidate replaces the body with an allowlisted provider-code projection or strips paths from retained evidence. THEN Reject it; no projection and no path stripping are implemented.
- **decision-optin** (total/determinate). IF Logging is disabled by the existing setting. THEN No line is written and no backup record is persisted anywhere; the notice breakdown is still produced.
- **decision-no-note-content** (total/determinate). IF A new diagnostic call site would log a value that may carry note contents. THEN Do not add the call site; the notice carries no note content and the log gains no new payload.

Observable effects: observable-log-body (single): The log line retains the whole provider body including nested provider codes, with set-cookie skipped and truncation announced.; observable-log-optin (single): With logging disabled no line is written and no durable record is created; logging stays opt-in under the existing setting.

Operational inputs: input-log-response (information, single_value, producer backend module assertOk response): A backend module's irregular (non-2xx) response captured before assertOk throws.

Invariants:
  - No setting, command, or persisted field is added by this change.
  - The log keeps nested provider codes; no allowlisted projection or path stripping is introduced.
  - Logging stays opt-in under the existing 'Enable logging' setting.
  - The retained log is never read to build the notice.

Failure semantics:
  - failure-body-unserializable (unsupported_input, preserves/none): An empty-body marker is logged and the call is never dropped silently.
  - failure-note-content-present (unsupported_input, preserves/none): A targeted note-content exclusion is added at the sink without dropping provider codes and without an allowlist.

Verification: verify-log-preservation [T1]: Backend-error-log tests asserting a nested provider code survives in the logged body and that no projection or path stripping is applied.; verify-log-optin [T1]: Logger tests asserting no line is written with logging disabled, the settings shape is unchanged, and the notice breakdown is produced independently of the log.; verify-doc-pointer [T0]: Documentation check over docs/error-handling.md only, asserting it references src/backend-api/error-classification.ts and contains no removed fs/errors pointer; historical change records under docs/changes are deliberately out of scope.

Witnesses:
- **witness-log-normal** (normal). Given A OneDrive 403 whose inner code is serviceReadOnly, with logging enabled., when Log the irregular response., expect The logged body contains the inner serviceReadOnly code.; No allowlisted projection or path stripping replaces the body.; forbidden: The inner provider code is dropped.; A path-free projection replaces the body..
- **witness-log-adversarial** (adversarial risks boundary). Given A provider error body echoes request content and a failing token-endpoint response is also available to a call site., when Log the irregular response and exercise the token path with logging enabled., expect No credential material appears in the log.; The whole body still carries its provider codes, and no new note-bearing call site exists.; With logging disabled nothing is written.; forbidden: An access token, refresh token, OAuth code, or client secret appears.; Note contents are written by a newly added call site.; An allowlist replaces the body..

<!-- anchor: adrs -->
## Architecture decisions

<!-- anchor: adr-20260927-classification-carried-from-retry-site -->
### adr-20260927-classification-carried-from-retry-site — Carry the neutral classification from the retry site onto the failure fact (accepted)

Context: Two error-kind vocabularies coexist (core ErrorKind and module BackendErrorKind), and a failure's displayed category must agree with the retry policy the engine actually applied, including a provider re-tag such as Google Drive's 403-means-rate-limit. Recomputing the category at notice-build time with a separate classifier could disagree with decideRetry.

Decision: The neutral ErrorKind is computed once, where the applied retry policy classifies the failure (plan-executor's per-action classify for failed actions; the orchestrator's provider-aware classify at the cycle-abort sites), and is carried as an observational field on the failure fact. The notice projection uses the carried kind and only falls back to the neutral classifyHttpError when none was carried. No second taxonomy or user-facing label mapping is introduced; the vocabulary source of truth stays the core ErrorKind.

Consequences:
  - The displayed category cannot drift from the policy that was applied.
  - FailedAction gains an observational classification field and execution-result.ts changes; no durable state is added.
  - BackendErrorKind remains the module boundary vocabulary and is not projected into the notice.

Alternatives rejected:
  - Recompute the category at notice-build time with classifyHttpError only — It would report permission for a Google Drive 403 that the applied policy retried as rateLimit, so the notice would contradict the engine's own decision.
  - Add a new user-facing label mapping over both vocabularies — It introduces a second taxonomy that can disagree with decideRetry and is not needed to name the neutral kind.

<!-- anchor: adr-20260927-notice-breakdown-without-instructions -->
### adr-20260927-notice-breakdown-without-instructions — One shared failure clause across every notice, with no user instructions (accepted)

Context: The completion notice is counts-only and gated on showSyncNotifications; the cycle-abort notices (auth/permission abort, retries-exhausted, and the unhandled-error catch) are ungated and some echo raw error messages or assign work ('Please reconnect in settings'). The owner directive is that errors report the error and the plugin does not assign work, and stop_basis requires the failing operation on every user-visible failure path.

Decision: One pure formatter owns the failure clause and every user-visible failure notice routes through it. The completion notice keeps its counts and appends one coalesced clause. Each ungated cycle-abort notice carries the structured clause for its aborting operation instead of the raw error message. Except for an authentication failure, the reconnect/permission instruction is removed as an owner-rejected next step; an authentication failure names the one recovery action the user alone can take (`Please reconnect in settings.`), because the cycle cannot recover credentials by retrying. Emission count and gating are unchanged: the abort notices stay ungated and the completion notice stays gated.

Consequences:
  - All failure surfaces share one vocabulary and one privacy rule.
  - The abort notice no longer leaks a raw provider message that may contain a path.
  - The permission abort message no longer tells the user to check permissions; the auth abort message does name the reconnect action. This is an observable content change on an existing surface and is deliberate.
  - No notice site is added or removed and no new command or setting is introduced.

Alternatives rejected:
  - Append the breakdown only to the completed-cycle notice and leave the abort notices raw — It fails stop_basis item 1, which names every user-visible failure path including the cycle-level abort notice.
  - Keep the reconnect/permission instruction on every failure — It assigns work to the user for failures the plugin can retry, contrary to the recorded owner directive.

<!-- anchor: adr-20260927-preserve-whole-body-evidence -->
### adr-20260927-preserve-whole-body-evidence — Preserve whole-body provider evidence and reject the allowlisted projection (accepted)

Context: The reference draft PR proposed replacing the whole provider body with an allowlisted provider-code projection. The owner recorded that the allowlist is lossy: it drops unknown codes, new fields, and non-JSON bodies, reintroducing the OneDrive serviceReadOnly blindness the current logging exists to prevent.

Decision: The opt-in log keeps the whole-body provider evidence and headers (minus set-cookie, truncation announced) with no lossy projection and no stripping of retained evidence. The only exclusions are the existing token-endpoint rule and any future targeted note-content exclusion, which is added only when a captured body is observed to carry note contents.

Consequences:
  - A reader can still distinguish a nested provider cause.
  - No new privacy setting and no path opt-in setting are added.
  - The note-content exclusion remains an unresolved premise until a captured body confirms or denies it.

Alternatives rejected:
  - Allowlisted provider-code projection — Lossy: drops unknown codes, new fields, and non-JSON bodies, and was rejected by the repository owner.
  - Strip paths and names from every retained log record — Contradicts the recorded directive to keep the log evidence intact; the path constraint applies to the notice.

<!-- anchor: units -->
## Implementation units

<!-- anchor: unit-project-the-bounded-failure-facts -->
### Project the bounded failure facts

Contracts: contract-failure-fact-projection. Files: src/sync/failure-facts.ts, src/sync/failure-facts.test.ts, src/sync/plan-executor.ts, src/sync/plan-executor.test.ts, src/sync/execution-result.ts

Acceptance:
  - A fabricated cycle outcome projects operation, status and neutral kind; no path, message or provider code appears.
  - A provider re-tagged 403 records the applied rateLimit kind on the FailedAction and the projection uses it, not the neutral 403 default.
  - A multi-failure cycle selects one representative by severity plus the total error count; a failure with no status or no recognized kind carries the unclassified marker.

<!-- anchor: unit-render-the-bounded-failure-notice-breakdown -->
### Render the bounded failure notice breakdown

Contracts: contract-notice-breakdown-format. Files: src/sync/failure-notice.ts, src/sync/failure-notice.test.ts, src/sync/sync-notification.ts, src/sync/sync-notification.test.ts

Acceptance:
  - The exact clause is asserted for 401, 403, 404, 429, 5xx and a provider-translated failure.
  - A transport failure with no HTTP status and a null classification both render the explicit unclassified marker rather than a named category.
  - Hostile path-like, token-like and provider-message-like fact values never appear in the output, and no instruction verb is present.

<!-- anchor: unit-route-every-failure-notice-through-the-breakdown -->
### Route every failure notice through the breakdown

Contracts: contract-notice-routing. Files: src/sync/orchestrator.ts, src/main.ts, src/sync/orchestrator.test.ts, src/sync/failure-notice.test.ts

Acceptance:
  - Each failure path emits the structured clause and no raw error message.
  - One completion notice per burst with showSyncNotifications on and off; no per-file notice for a many-failure partial cycle.
  - The cycle-abort notice still appears with notifications off, carries the clause, and the Sync error status transition is unchanged.

<!-- anchor: unit-pin-the-preserved-log-evidence-and-correct-the-error-handling-pointer -->
### Pin the preserved log evidence and correct the error-handling pointer

Contracts: contract-log-evidence-invariance. Files: docs/error-handling.md, src/backend-api/backend-error-log.test.ts, src/logging/logger.test.ts

Acceptance:
  - A nested provider code survives in the logged body; no projection or path stripping is applied.
  - No line is written with logging disabled, the settings shape is unchanged, and the notice breakdown works independently of the log.
  - docs/error-handling.md references src/backend-api/error-classification.ts and contains no removed fs/errors pointer.

<!-- anchor: acceptance -->
## Acceptance

- **UAC-001** (req-failure-fact-single-owner, req-classification-matches-applied-policy, req-representative-selection, req-unclassified-marker): By verify-fact-projection: Unit test over fabricated SyncCycleOutcome values asserting the projected operation, status, kind, and the representative selection order. (tier T1, command npm test)
- **UAC-002** (req-classification-matches-applied-policy): By verify-classification-carrier: Unit test over plan-executor's executeAction asserting that a provider re-tagged 403 failure records the FailedAction carrying the applied rateLimit kind, and that the projection uses that carried kind instead of the neutral 403 permission default. (tier T1, command npm test)
- **UAC-003** (req-notice-no-user-instructions, req-notice-privacy, req-unclassified-marker, req-representative-selection, req-notice-one-breakdown-per-cycle): By verify-format-clause: Unit test asserting the exact clause for a 401, 403, 404, 429, 5xx and a provider-translated failure, and for a null classification. (tier T1, command npm test)
- **UAC-004** (req-notice-privacy, req-notice-no-user-instructions): By verify-format-privacy: Unit test feeding hostile fact values (path-like, token-like, provider-message-like strings) and asserting none appears in the output and no instruction verb is present. (tier T1, command npm test)
- **UAC-005** (req-notice-one-breakdown-per-cycle, req-abort-notice-covered, req-notice-no-user-instructions, req-log-optin-unchanged): By verify-routing-sites: Orchestrator tests injecting a notifier, plus the `formatSyncAbortNotice` unit test covering the unhandled-error catch composition, asserting the emitted notices carry the clause and no raw message on each failure path. (tier T1, command npm test)
- **UAC-006** (req-notice-one-breakdown-per-cycle, req-abort-notice-covered): By verify-routing-gating: Tests asserting one notice per burst with showSyncNotifications on and off, no per-file notice for a many-failure partial cycle, and the abort notice present with notifications off. (tier T1, command npm test)
- **UAC-007** (req-log-evidence-preserved): By verify-log-preservation: Backend-error-log tests asserting a nested provider code survives in the logged body and that no projection or path stripping is applied. (tier T1, command npm test)
- **UAC-008** (req-log-optin-unchanged): By verify-log-optin: Logger tests asserting no line is written with logging disabled, the settings shape is unchanged, and the notice breakdown is produced independently of the log. (tier T1, command npm test)
- **UAC-009** (req-error-doc-pointer): By verify-doc-pointer: Documentation check over docs/error-handling.md only, asserting it references src/backend-api/error-classification.ts and contains no removed fs/errors pointer; historical change records under docs/changes are deliberately out of scope. (tier T0, command rg -n "src/backend-api/error-classification" docs/error-handling.md)

<!-- anchor: dispositions -->
## Decision dispositions

- `decision-input-dp-breakdown-content`: adopted (contracts: contract-failure-fact-projection; ADRs: none)
- `decision-input-dp-failure-surfaces`: adopted (contracts: contract-notice-routing; ADRs: adr-20260927-notice-breakdown-without-instructions)
- `decision-input-dp-multi-failure-reduction`: adopted (contracts: contract-notice-breakdown-format; ADRs: none)
- `decision-input-dp-unknown-classification`: adopted (contracts: contract-notice-breakdown-format; ADRs: none)
- `decision-input-dp-provider-body`: adopted (contracts: contract-log-evidence-invariance; ADRs: adr-20260927-preserve-whole-body-evidence)
- `decision-input-dp-classification-vocabulary`: adopted (contracts: contract-failure-fact-projection; ADRs: adr-20260927-classification-carried-from-retry-site)
- `decision-input-dp-record-emitter`: rejected (contracts: contract-log-evidence-invariance; ADRs: none)

<!-- anchor: limitations -->
## Open premises and limitations

  - Whether a provider error body can carry note contents is unobserved; if a captured body does, a targeted note-content exclusion must be added at the sink without dropping provider codes and without an allowlist (cc-no-note-contents).
  - Whether a failing token-endpoint response carries credential material is unobserved; the existing token-endpoint exclusion rule is retained unchanged and its assumption remains explicit.

- Independent review recorded minor precision gaps that do not change an accepted observable outcome: the doc-pointer check cannot falsify the absence half of its requirement; decision-abort-notice conflates an action-level permission failure with a cycle abort; scope.in_scope under-declares src/sync/execution-result.ts; the representative-selection severity rank leaves a null (Admission) classification unranked; the projection owner's integration points omit src/main.ts; and cc-no-note-contents is carried as an explicit premise rather than an owned obligation.

