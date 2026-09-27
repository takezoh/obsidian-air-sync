---
adrs:
- adr-20260927-classification-carried-from-retry-site
- adr-20260927-notice-breakdown-without-instructions
- adr-20260927-preserve-whole-body-evidence
change: change-20260927-actionable-sync-diagnostics
contract_projections:
- discretion: []
  id: contract-failure-fact-projection
  verifications:
  - verify-fact-projection
  - verify-classification-carrier
- discretion: []
  id: contract-notice-breakdown-format
  verifications:
  - verify-format-clause
  - verify-format-privacy
- discretion: []
  id: contract-notice-routing
  verifications:
  - verify-routing-sites
  - verify-routing-gating
- discretion: []
  id: contract-log-evidence-invariance
  verifications:
  - verify-log-preservation
  - verify-log-optin
  - verify-doc-pointer
contracts:
- contract-failure-fact-projection
- contract-notice-breakdown-format
- contract-notice-routing
- contract-log-evidence-invariance
decision_dispositions:
- adr_refs: []
  contract_refs:
  - contract-failure-fact-projection
  decision_input_ref: decision-input-dp-breakdown-content
  disposition: adopted — The breakdown names the operation, the neutral classification,
    and the HTTP status when present, as the selected OPT-PHASE-CLASS-STATUS requires.
- adr_refs:
  - adr-20260927-notice-breakdown-without-instructions
  contract_refs:
  - contract-notice-routing
  decision_input_ref: decision-input-dp-failure-surfaces
  disposition: adopted — Both the completion notice and every cycle-abort notice carry
    the same structured clause, per OPT-BOTH.
- adr_refs: []
  contract_refs:
  - contract-notice-breakdown-format
  decision_input_ref: decision-input-dp-multi-failure-reduction
  disposition: adopted — The formatter reduces a multi-failure cycle to one representative
    failure plus the total count, per OPT-REPRESENTATIVE.
- adr_refs: []
  contract_refs:
  - contract-notice-breakdown-format
  decision_input_ref: decision-input-dp-unknown-classification
  disposition: adopted — An explicit unclassified marker is rendered instead of guessing,
    per OPT-SHOW-UNCLASSIFIED.
- adr_refs:
  - adr-20260927-preserve-whole-body-evidence
  contract_refs:
  - contract-log-evidence-invariance
  decision_input_ref: decision-input-dp-provider-body
  disposition: adopted — The whole-body evidence is preserved and no projection is
    introduced, per OPT-KEEP-WHOLE-BODY.
- adr_refs:
  - adr-20260927-classification-carried-from-retry-site
  contract_refs:
  - contract-failure-fact-projection
  decision_input_ref: decision-input-dp-classification-vocabulary
  disposition: adopted — The core ErrorKind is the vocabulary the notice names, carried
    from the retry site; BackendErrorKind stays the module boundary vocabulary.
- adr_refs: []
  contract_refs:
  - contract-log-evidence-invariance
  decision_input_ref: decision-input-dp-record-emitter
  disposition: 'rejected — No separate per-failure diagnostic record is emitted: the
    notice is the only per-failure surface, so the core-versus-module emitter question
    is closed by not adding a record and leaving the opt-in log unchanged.'
milestones:
- id: Failure facts and notice clause
- id: Failure notice routing and log invariance
reference_algorithms: []
role: implementation
---
# Implementation — actionable sync diagnostics

## Components

- **component-failure-facts** (planned): Own the single bounded projection from a cycle's in-memory failures (failed actions, Admission failure components, caught cycle-abort error) to failure facts carrying an operation label, the HTTP status when present, and the neutral classification the applied retry policy used. Holds no durable state and reads no log.
  - Paths: src/sync/failure-facts.ts
  - Contracts: contract-failure-fact-projection
- **component-notice-formatter** (planned): Own the single user-facing wording and privacy rule for a failure clause: read bounded failure facts and return one sentence-case clause naming the operation and classification with the status when present, emitting nothing outside the closed vocabularies.
  - Paths: src/sync/failure-notice.ts
  - Contracts: contract-notice-breakdown-format
- **component-notice-routing** (existing): Own which notices are emitted and how the breakdown reaches them: the gated completion notice appends the coalesced clause; each ungated cycle-abort notice carries the structured clause for its aborting operation; no site is added, removed, or re-gated.
  - Paths: src/sync/orchestrator.ts, src/main.ts
  - Contracts: contract-notice-routing
- **component-log-evidence** (existing): Own the opt-in log boundary and the whole-body provider evidence it retains; this change adds no sink projection, no path or note stripping, no new emitting call site that carries note contents, and no setting.
  - Paths: src/logging/logger.ts, src/backend-api/backend-error-log.ts
  - Contracts: contract-log-evidence-invariance
- **component-cycle-execution** (existing): Own executing admitted actions and recording each failed action, including the neutral classification the applied retry policy used, so the failure fact consumed downstream carries the policy's own kind instead of a re-derivation.
  - Paths: src/sync/plan-executor.ts, src/sync/execution-result.ts
  - Contracts: none (produces the fact consumed by contract-failure-fact-projection)

## Contracts

### contract-failure-fact-projection

Dimension `integration_contract`, owner `component-failure-facts`, units Project the bounded failure facts, ADRs adr-20260927-classification-carried-from-retry-site.

Project a cycle's user-visible failures into a bounded, ordered list of failure facts carrying an operation label, the HTTP status when present, and the neutral classification the applied retry policy used, held in memory for the current cycle only.

Rules: decision-operation-label → Each failure yields an operation label drawn from the closed vocabulary (push, pull, delete, rename, match, conflict, admission, cycle abort); an unnameable outcome yields the coarse phase with an explicit unclassified-operation marker.; decision-status → The HTTP status is the finite numeric status from getErrorInfo(error).status when present, otherwise null.; decision-classification → The carried ErrorKind is used as-is, including a provider re-tag; when no classification was carried the neutral classifyHttpError(error) is used; no second taxonomy is introduced.; decision-representative → Select one representative by classification severity (auth, permission, rateLimit, notFound, permanent, transient) then first-observed order, and retain the total error count.

Invariants: The projection is derived only from in-memory current-cycle facts; it reads no log file and persists nothing.; The classification shown is the one the applied retry policy used, including a provider re-tag, and no second taxonomy is introduced.; The projection contains no file path, file name, provider code, or raw provider message text.; The projection is bounded to one representative failure plus a total count.

### contract-notice-breakdown-format

Dimension `security_boundary`, owner `component-notice-formatter`, units Render the bounded failure notice breakdown, ADRs adr-20260927-notice-breakdown-without-instructions.

Render one bounded sentence-case failure clause from projected failure facts under a single notice privacy rule: emit only the closed operation vocabulary, the closed ErrorKind vocabulary, and a numeric HTTP status.

Rules: decision-clause-shape → Return one clause naming the operation with the status segment when a status exists; when no HTTP status exists or the classification is unrecognized, render the explicit unclassified marker instead of naming a category, and never return a sentence of instruction.; decision-unclassified → Render the explicit unclassified marker for the classification segment and keep the operation label.; decision-privacy → Emit only the closed vocabulary members and a numeric status; drop any other input value rather than rendering or sanitizing it into the clause.

Invariants: The formatter is pure: no I/O, no settings read, no clock, no randomness.; The returned string contains only the closed operation and classification vocabularies and a numeric status.; The clause never claims retryability, user action, or a next step.; The clause never contains a credential, path, file name, or provider code.

### contract-notice-routing

Dimension `control_flow`, owner `component-notice-routing`, units Route every failure notice through the breakdown, ADRs adr-20260927-notice-breakdown-without-instructions.

Route every user-visible sync failure notice through the shared failure clause: the gated completion notice carries one coalesced clause, and each ungated cycle-abort notice carries the same structured clause instead of a raw error message, without changing which notices are emitted or the abort/retry policy.

Rules: decision-completion-notice → Emit exactly one completion notice whose counts summary is unchanged and which appends the coalesced failure clause when the burst had failures.; decision-abort-notice → Emit the abort notice carrying the structured clause for the aborting operation and no raw error message; the notice stays ungated.; decision-no-notice-change → The set of emitted notices, their count, and their gating are unchanged from today; only their text changes.

Invariants: No notice site is added, removed, or re-gated by this change.; The abort notice remains ungated and the completion notice remains gated on showSyncNotifications.; No failure notice carries a user instruction or a raw provider message.; The breakdown reads no log file and persists nothing.; The abort/retry policy and the Sync error status transition are unchanged.

### contract-log-evidence-invariance

Dimension `security_boundary`, owner `component-log-evidence`, units Pin the preserved log evidence and correct the error-handling pointer, ADRs adr-20260927-preserve-whole-body-evidence.

Keep the opt-in diagnostic log's whole-body provider evidence and its opt-in boundary invariant: no allowlisted projection, no stripping of retained evidence, no new setting, and no new emitting call site that could carry note contents.

Rules: decision-whole-body → Write the entire body (nested provider codes included) and response headers minus set-cookie, with truncation announced; this change alters nothing here.; decision-no-projection → Reject it; no projection and no path stripping are implemented.; decision-optin → No line is written and no backup record is persisted anywhere; the notice breakdown is still produced.; decision-no-note-content → Do not add the call site; the notice carries no note content and the log gains no new payload.

Invariants: No setting, command, or persisted field is added by this change.; The log keeps nested provider codes; no allowlisted projection or path stripping is introduced.; Logging stays opt-in under the existing 'Enable logging' setting.; The retained log is never read to build the notice.

## Units

- **Project the bounded failure facts** (chunk ``): contracts contract-failure-fact-projection; files src/sync/failure-facts.ts, src/sync/failure-facts.test.ts, src/sync/plan-executor.ts, src/sync/plan-executor.test.ts, src/sync/execution-result.ts.
  - Objective: Project a cycle's user-visible failures into a bounded, ordered list of failure facts carrying an operation label, the HTTP status when present, and the neutral classification the applied retry policy used, held in memory for the current cycle only.
- **Render the bounded failure notice breakdown** (chunk ``): contracts contract-notice-breakdown-format; files src/sync/failure-notice.ts, src/sync/failure-notice.test.ts, src/sync/sync-notification.ts, src/sync/sync-notification.test.ts.
  - Objective: Render one bounded sentence-case failure clause from projected failure facts under a single notice privacy rule: emit only the closed operation vocabulary, the closed ErrorKind vocabulary, and a numeric HTTP status.
- **Route every failure notice through the breakdown** (chunk ``): contracts contract-notice-routing; files src/sync/orchestrator.ts, src/main.ts, src/sync/orchestrator.test.ts, src/sync/failure-notice.test.ts.
  - Objective: Route every user-visible sync failure notice through the shared failure clause: the gated completion notice carries one coalesced clause, and each ungated cycle-abort notice carries the same structured clause instead of a raw error message, without changing which notices are emitted or the abort/retry policy.
- **Pin the preserved log evidence and correct the error-handling pointer** (chunk ``): contracts contract-log-evidence-invariance; files docs/error-handling.md, src/backend-api/backend-error-log.test.ts, src/logging/logger.test.ts.
  - Objective: Keep the opt-in diagnostic log's whole-body provider evidence and its opt-in boundary invariant: no allowlisted projection, no stripping of retained evidence, no new setting, and no new emitting call site that could carry note contents.

## ADRs

- **adr-20260927-classification-carried-from-retry-site** (accepted): The neutral ErrorKind is computed once, where the applied retry policy classifies the failure (plan-executor's per-action classify for failed actions; the orchestrator's provider-aware classify at the cycle-abort sites), and is carried as an observational field on the failure fact. The notice projection uses the carried kind and only falls back to the neutral classifyHttpError when none was carried. No second taxonomy or user-facing label mapping is introduced; the vocabulary source of truth stays the core ErrorKind.
- **adr-20260927-notice-breakdown-without-instructions** (accepted): One pure formatter owns the failure clause and every user-visible failure notice routes through it. The completion notice keeps its counts and appends one coalesced clause. Each ungated cycle-abort notice carries the structured clause for its aborting operation instead of the raw error message, and the existing reconnect/permission instruction is removed as an owner-rejected next step. Emission count and gating are unchanged: the abort notices stay ungated and the completion notice stays gated.
- **adr-20260927-preserve-whole-body-evidence** (accepted): The opt-in log keeps the whole-body provider evidence and headers (minus set-cookie, truncation announced) with no lossy projection and no stripping of retained evidence. The only exclusions are the existing token-endpoint rule and any future targeted note-content exclusion, which is added only when a captured body is observed to carry note contents.

## Decision dispositions

- `decision-input-dp-breakdown-content`: adopted
  - Rationale: The breakdown names the operation, the neutral classification, and the HTTP status when present, as the selected OPT-PHASE-CLASS-STATUS requires.
- `decision-input-dp-failure-surfaces`: adopted
  - Rationale: Both the completion notice and every cycle-abort notice carry the same structured clause, per OPT-BOTH.
- `decision-input-dp-multi-failure-reduction`: adopted
  - Rationale: The formatter reduces a multi-failure cycle to one representative failure plus the total count, per OPT-REPRESENTATIVE.
- `decision-input-dp-unknown-classification`: adopted
  - Rationale: An explicit unclassified marker is rendered instead of guessing, per OPT-SHOW-UNCLASSIFIED.
- `decision-input-dp-provider-body`: adopted
  - Rationale: The whole-body evidence is preserved and no projection is introduced, per OPT-KEEP-WHOLE-BODY.
- `decision-input-dp-classification-vocabulary`: adopted
  - Rationale: The core ErrorKind is the vocabulary the notice names, carried from the retry site; BackendErrorKind stays the module boundary vocabulary.
- `decision-input-dp-record-emitter`: rejected
  - Rationale: No separate per-failure diagnostic record is emitted: the notice is the only per-failure surface, so the core-versus-module emitter question is closed by not adding a record and leaving the opt-in log unchanged.

## Open premises

  - Whether a provider error body can carry note contents is unobserved; if a captured body does, a targeted note-content exclusion must be added at the sink without dropping provider codes and without an allowlist (cc-no-note-contents).
  - Whether a failing token-endpoint response carries credential material is unobserved; the existing token-endpoint exclusion rule is retained unchanged and its assumption remains explicit.
