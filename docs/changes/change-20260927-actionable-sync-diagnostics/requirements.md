---
change: change-20260927-actionable-sync-diagnostics
functional_requirements:
- id: req-failure-fact-single-owner
  priority: must
  statement: The cycle's user-visible failure facts (operation/phase, HTTP status
    when present, and neutral classification) SHALL be derived by exactly one core
    owner from in-memory current-cycle facts, without reading the log file and without
    introducing a second error taxonomy.
- id: req-classification-matches-applied-policy
  priority: must
  statement: The classification shown for a failure SHALL be the neutral ErrorKind
    that the engine's retry policy applied to that failure, including a provider re-tag,
    and SHALL never be a provider code string.
- id: req-representative-selection
  priority: must
  statement: When a cycle contains more than one failure, the notice SHALL reduce
    them to one representative failure (the most severe by the neutral classification,
    else the first observed) together with the total error count.
- id: req-unclassified-marker
  priority: must
  statement: When a failure has no HTTP status or no recognized neutral classification,
    the notice SHALL state the operation and an explicit unclassified marker instead
    of guessing a category, a retryability, or a next step.
- id: req-notice-one-breakdown-per-cycle
  priority: must
  statement: When a sync burst with one or more failures completes and showSyncNotifications
    is enabled, the plugin SHALL emit at most one completion notice, retaining the
    existing counts summary and appending one bounded failure clause; it SHALL NOT
    emit a per-file notice.
- id: req-notice-no-user-instructions
  priority: must
  statement: 'No user-visible sync failure notice SHALL assign work to the user: it
    SHALL contain no retryable-versus-user-action split, no suggested next step, and no
    raw provider message text. The single exception is an authentication failure, which
    SHALL name the one recovery action the user alone can take (reconnect in settings).'
- id: req-notice-privacy
  priority: must
  statement: No notice string produced by this change SHALL contain a file path, a
    file name, a provider code, raw provider text, or credential material; only the
    closed operation vocabulary, the closed ErrorKind vocabulary, and a numeric HTTP
    status may be emitted.
- id: req-abort-notice-covered
  priority: must
  statement: Every user-visible sync failure path, including each ungated cycle-abort
    notice, SHALL carry the same structured failure clause instead of a raw error
    message, and each such notice SHALL remain ungated so an aborted sync is never
    silently hidden.
- id: req-log-evidence-preserved
  priority: must
  statement: The opt-in diagnostic log SHALL retain the whole provider error body
    (nested provider codes included) and headers minus set-cookie with truncation
    announced, and SHALL NOT replace it with an allowlisted projection or strip paths
    from retained evidence.
- id: req-log-optin-unchanged
  priority: must
  statement: Logging SHALL remain opt-in under the existing 'Enable logging' setting,
    this change SHALL add no setting, command, or persisted field, and the notice
    breakdown SHALL be produced with logging disabled.
- id: req-error-doc-pointer
  priority: should
  statement: docs/error-handling.md SHALL point error classification and decideRetry
    at src/backend-api/error-classification.ts and SHALL reference no removed fs/errors
    path.
role: requirements
---
# Requirements — actionable sync diagnostics

Derived from the approved design plan; the statement and priority of every functional requirement are preserved verbatim.

## req-failure-fact-single-owner (ubiquitous, must)

The cycle's user-visible failure facts (operation/phase, HTTP status when present, and neutral classification) SHALL be derived by exactly one core owner from in-memory current-cycle facts, without reading the log file and without introducing a second error taxonomy.

Rationale: stop_basis requires a single owner and value set covering every user-visible failure path.

## req-classification-matches-applied-policy (ubiquitous, must)

The classification shown for a failure SHALL be the neutral ErrorKind that the engine's retry policy applied to that failure, including a provider re-tag, and SHALL never be a provider code string.

Rationale: The displayed category must agree with decideRetry, e.g. the Google Drive 403-rate-limit re-tag.

## req-representative-selection (state_driven, must)

When a cycle contains more than one failure, the notice SHALL reduce them to one representative failure (the most severe by the neutral classification, else the first observed) together with the total error count.

Rationale: DP-MULTI-FAILURE-REDUCTION keeps the notice glanceable and mobile-safe.

## req-unclassified-marker (state_driven, must)

When a failure has no HTTP status or no recognized neutral classification, the notice SHALL state the operation and an explicit unclassified marker instead of guessing a category, a retryability, or a next step.

Rationale: DP-UNKNOWN-CLASSIFICATION forbids a fabricated category.

## req-notice-one-breakdown-per-cycle (event_driven, must)

When a sync burst with one or more failures completes and showSyncNotifications is enabled, the plugin SHALL emit at most one completion notice, retaining the existing counts summary and appending one bounded failure clause; it SHALL NOT emit a per-file notice.

Rationale: DP-NOTICE-SCOPE: keep the counts and the single coalesced notice.

## req-notice-no-user-instructions (ubiquitous, must)

No user-visible sync failure notice SHALL assign work to the user: it SHALL contain no retryable-versus-user-action split, no suggested next step, and no raw provider message text. The single exception is an authentication failure, which SHALL name the one recovery action the user alone can take (reconnect in settings).

Rationale: constraint-no-instructions and the recorded owner directive, with an authentication failure carved out because the cycle cannot recover credentials by retrying.

## req-notice-privacy (ubiquitous, must)

No notice string produced by this change SHALL contain a file path, a file name, a provider code, raw provider text, or credential material; only the closed operation vocabulary, the closed ErrorKind vocabulary, and a numeric HTTP status may be emitted.

Rationale: DP-PATHS and cc-no-credentials.

## req-abort-notice-covered (event_driven, must)

Every user-visible sync failure path, including each ungated cycle-abort notice, SHALL carry the same structured failure clause instead of a raw error message, and each such notice SHALL remain ungated so an aborted sync is never silently hidden.

Rationale: stop_basis item 1 plus constraint-abort-notice-gate.

## req-log-evidence-preserved (ubiquitous, must)

The opt-in diagnostic log SHALL retain the whole provider error body (nested provider codes included) and headers minus set-cookie with truncation announced, and SHALL NOT replace it with an allowlisted projection or strip paths from retained evidence.

Rationale: cc-preserve-body and DP-PROVIDER-BODY.

## req-log-optin-unchanged (ubiquitous, must)

Logging SHALL remain opt-in under the existing 'Enable logging' setting, this change SHALL add no setting, command, or persisted field, and the notice breakdown SHALL be produced with logging disabled.

Rationale: cc-opt-in-logging, cc-state-ownership and ctx-module-only-redaction.

## req-error-doc-pointer (ubiquitous, should)

docs/error-handling.md SHALL point error classification and decideRetry at src/backend-api/error-classification.ts and SHALL reference no removed fs/errors path.

Rationale: handoff-stale-error-doc found the doc pointer stale after the Backend Module API consolidation.
