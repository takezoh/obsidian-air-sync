---
change: change-20260927-actionable-sync-diagnostics
role: verification
---
# Verification — actionable sync diagnostics

Each contract carries at least one normal and one adversarial witness; the commands below are the executable checks.

## contract-failure-fact-projection

- **verify-fact-projection** [T1] — Unit test over fabricated SyncCycleOutcome values asserting the projected operation, status, kind, and the representative selection order. (command: `npm test`)
- **verify-classification-carrier** [T1] — Unit test over plan-executor's executeAction asserting that a provider re-tagged 403 failure records the FailedAction carrying the applied rateLimit kind, and that the projection uses that carried kind instead of the neutral 403 permission default. (command: `npm test`)
- Witness **witness-fact-normal** (normal): given A cycle completed with one failed pull whose error classifies as notFound (404) and no Admission failure., when Project the cycle outcome into failure facts., expect The projection has one entry for operation pull with status 404 and kind notFound.; No path, message, or provider code appears in the projection.; forbidden The classification is recomputed with a taxonomy other than the applied one.; A file path or provider message appears in the projection..
- Witness **witness-fact-adversarial** (adversarial): given A provider re-tags a 403 as rateLimit (Google Drive) and the same cycle also has an actionless Admission failure with no thrown error., when Project the cycle outcome into failure facts., expect The rate-limit failure is projected with kind rateLimit and status 403.; The actionless Admission failure is projected with an operation label and the unclassified marker.; The representative is selected by severity and the total error count is retained.; The FailedAction recorded by plan-executor carries the applied rateLimit kind for the re-tagged 403, so the projection never falls back to the neutral 403 default.; forbidden The displayed kind disagrees with the applied retry policy.; A provider code string or file path appears in the projection..

## contract-notice-breakdown-format

- **verify-format-clause** [T1] — Unit test asserting the exact clause for a 401, 403, 404, 429, 5xx and a provider-translated failure, and for a null classification. (command: `npm test`)
- **verify-format-privacy** [T1] — Unit test feeding hostile fact values (path-like, token-like, provider-message-like strings) and asserting none appears in the output and no instruction verb is present. (command: `npm test`)
- Witness **witness-format-normal** (normal): given Failure facts for a push that failed with HTTP 429 and kind rateLimit., when Format the failure clause., expect The clause names push and rateLimit with status 429 in sentence case.; No instruction and no path appear.; forbidden A retry, reconnect, or user-action instruction appears.; A file path or provider code appears..
- Witness **witness-format-adversarial** (adversarial): given A fact field carries a string resembling a provider message with an embedded file path and a token, one failure has a null classification, and one transport failure has no HTTP status., when Format the failure clause., expect The provider-like string, the path, and the token are absent from the output.; The null-classification failure yields the explicit unclassified marker.; The statusless transport failure and the null-classification failure both yield the explicit unclassified marker rather than a named category.; forbidden Provider text, a path, a file name, or a credential appears in the clause.; A retryability or next-step claim appears..

## contract-notice-routing

- **verify-routing-sites** [T1] — Orchestrator tests injecting a notifier asserting the emitted notices carry the clause and no raw message on each failure path, plus the `formatSyncAbortNotice` unit test covering the unhandled-error catch composition. (command: `npm test`)
- **verify-routing-gating** [T1] — Tests asserting one notice per burst with showSyncNotifications on and off, no per-file notice for a many-failure partial cycle, and the abort notice present with notifications off. (command: `npm test`)
- Witness **witness-routing-normal** (normal): given A burst with one failed push completes and showSyncNotifications is enabled., when Run the burst to completion., expect Exactly one completion notice is emitted with the counts summary and one appended clause.; No raw error message text appears.; forbidden More than one notice is emitted for the burst.; A per-file notice is emitted.; A raw error message appears in the notice..
- Witness **witness-routing-adversarial** (adversarial): given A cycle-level abort occurs with showSyncNotifications disabled, and a separate burst has many mixed-class failures., when Run the burst and the aborting cycle., expect The abort notice still appears (ungated) and carries the structured clause with no raw message.; The many-failure burst yields one completion notice and no per-file notice.; forbidden The abort notice is suppressed because notifications are off.; The raw error message appears.; A per-file notice is emitted..

## contract-log-evidence-invariance

- **verify-log-preservation** [T1] — Backend-error-log tests asserting a nested provider code survives in the logged body and that no projection or path stripping is applied. (command: `npm test`)
- **verify-log-optin** [T1] — Logger tests asserting no line is written with logging disabled, the settings shape is unchanged, and the notice breakdown is produced independently of the log. (command: `npm test`)
- **verify-doc-pointer** [T0] — Documentation check over docs/error-handling.md only, asserting it references src/backend-api/error-classification.ts and contains no removed fs/errors pointer; historical change records under docs/changes are deliberately out of scope. (command: `rg -n "src/backend-api/error-classification" docs/error-handling.md`)
- Witness **witness-log-normal** (normal): given A OneDrive 403 whose inner code is serviceReadOnly, with logging enabled., when Log the irregular response., expect The logged body contains the inner serviceReadOnly code.; No allowlisted projection or path stripping replaces the body.; forbidden The inner provider code is dropped.; A path-free projection replaces the body..
- Witness **witness-log-adversarial** (adversarial): given A provider error body echoes request content and a failing token-endpoint response is also available to a call site., when Log the irregular response and exercise the token path with logging enabled., expect No credential material appears in the log.; The whole body still carries its provider codes, and no new note-bearing call site exists.; With logging disabled nothing is written.; forbidden An access token, refresh token, OAuth code, or client secret appears.; Note contents are written by a newly added call site.; An allowlist replaces the body..

## Acceptance

- **UAC-001**: By verify-fact-projection: Unit test over fabricated SyncCycleOutcome values asserting the projected operation, status, kind, and the representative selection order. (tier T1, command npm test)
- **UAC-002**: By verify-classification-carrier: Unit test over plan-executor's executeAction asserting that a provider re-tagged 403 failure records the FailedAction carrying the applied rateLimit kind, and that the projection uses that carried kind instead of the neutral 403 permission default. (tier T1, command npm test)
- **UAC-003**: By verify-format-clause: Unit test asserting the exact clause for a 401, 403, 404, 429, 5xx and a provider-translated failure, and for a null classification. (tier T1, command npm test)
- **UAC-004**: By verify-format-privacy: Unit test feeding hostile fact values (path-like, token-like, provider-message-like strings) and asserting none appears in the output and no instruction verb is present. (tier T1, command npm test)
- **UAC-005**: By verify-routing-sites: Orchestrator tests injecting a notifier asserting the emitted notices carry the clause and no raw message on each failure path, plus the `formatSyncAbortNotice` unit test covering the unhandled-error catch composition. (tier T1, command npm test)
- **UAC-006**: By verify-routing-gating: Tests asserting one notice per burst with showSyncNotifications on and off, no per-file notice for a many-failure partial cycle, and the abort notice present with notifications off. (tier T1, command npm test)
- **UAC-007**: By verify-log-preservation: Backend-error-log tests asserting a nested provider code survives in the logged body and that no projection or path stripping is applied. (tier T1, command npm test)
- **UAC-008**: By verify-log-optin: Logger tests asserting no line is written with logging disabled, the settings shape is unchanged, and the notice breakdown is produced independently of the log. (tier T1, command npm test)
- **UAC-009**: By verify-doc-pointer: Documentation check over docs/error-handling.md only, asserting it references src/backend-api/error-classification.ts and contains no removed fs/errors pointer; historical change records under docs/changes are deliberately out of scope. (tier T0, command rg -n "src/backend-api/error-classification" docs/error-handling.md)

## Preservation obligations

- Keep the sync-state-ownership guard, the backend-module boundary guard, the main-commands snapshot and the existing logger/notification tests green, or move them deliberately with recorded authority.
- No durable sync state, setting, command or migration is introduced; the notice breakdown is produced with logging disabled.
