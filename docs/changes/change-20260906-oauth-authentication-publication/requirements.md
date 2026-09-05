---
change: change-20260906-oauth-authentication-publication
role: requirements
functional_requirements:
- id: req-completion-publication
  statement: All six refresh-based OAuth completions require immediate candidate-equal
    SecretStorage readback; an existing readable refresh satisfies an omitted replacement
    only.
  priority: must
- id: req-rotation-publication
  statement: Changed refresh candidates from shared and detached managers publish
    before any state from that response is reusable, independently of sync closeout.
  priority: must
- id: req-attempt-identity
  statement: Custom PKCE authorize and exchange use one start-time identity snapshot;
    missing or inconsistent snapshot data rejects before exchange.
  priority: must
- id: req-google-wire
  statement: Both Google relay HTTP-success handlers validate the provider-local token
    shape before projection while preserving transport-exception behavior.
  priority: must
- id: req-authorization-denial
  statement: Four callback ingresses detect denial before success gates and apply
    the same exact error-code projection without provider descriptions.
  priority: must
- id: req-static-state
  statement: Static callback validates object/string state and own app membership
    while preserving both encodings and exact raw forwarding.
  priority: must
- id: req-pcloud-wire
  statement: Legacy pCloud validates its distinct access-only success shape while
    retaining host, region, logical-error and refresh-free behavior.
  priority: must
- id: req-compatibility-security
  statement: Preserve secret namespaces, reload, Picker, detached-manager, diagnostics
    and mobile contracts; keep credentials and provider descriptions out of durable
    nonsecret state and output.
  priority: must
- id: req-source-verification
  statement: Both repositories own executable source tests and gates; deployment,
    CI workflow changes and physical restart durability remain separately authorized
    or evidenced.
  priority: must
- id: invariant-secrets-outside-settings
  statement: Credentials remain only in SecretStorage or ephemeral manager memory
    and never in settings, sync state, or diagnostic output.
  priority: must
- id: invariant-candidate-equality
  statement: Required publication succeeds only when synchronous immediate readback
    equals the exact nonempty candidate.
  priority: must
---

<!-- lifecycle is owned by change.md -->

# Requirements

## Functional requirements

### FR-1 — Completion publication

- When any registered Google/Dropbox/OneDrive built-in or custom OAuth completion receives a nonempty refresh candidate, the plugin shall write it to the existing backend SecretStorage key and require an immediate exact readback before reporting completion.
- When a valid reauthorization response omits a refresh token, the plugin shall accept the already readable nonempty refresh credential for that backend.
- If neither exists, or fresh-candidate readback is missing, unequal, or throws, completion shall fail before settings save, sync reset, filesystem construction, folder selection, or success notice.
- A manager that has exchanged the code but has not completed publication shall remain provisional and shall be discarded on failure; its access/refresh/expiry state shall never be reused.

### FR-2 — Rotation publication

- When a validated refresh response contains a changed nonempty refresh token, every shared or detached manager shall complete the same candidate-equal publication before installing or exposing any state from that response.
- If publication fails, the refresh call shall fail and a subsequent access call shall not return the unpublished response's access token.
- Required refresh publication shall not depend on sync closeout or `readBackendState`; late cycle refresh writers shall be removed without changing checkpoint ordering.

### FR-3 — Attempt identity

- When custom Dropbox or OneDrive authorization starts, the plugin shall snapshot the effective client ID and OneDrive authority used for the authorize URL and persist that nonsecret snapshot with pending state/verifier.
- When callback exchange begins, it shall use exactly that snapshot even if editable settings changed or the plugin reloaded.
- Missing, incomplete, wrong-provider, or manager-inconsistent snapshot data shall reject before any token request. A new explicit start supersedes the old snapshot and provisional attempt manager.

### FR-4 — Google relay token shape

- On an HTTP-success token response, both Google callback and refresh handlers shall require a non-null, non-array object, nonempty string `access_token`, finite positive numeric `expires_in`, and optional string `refresh_token` before projecting fields.
- Invalid JSON or shape shall produce the route-specific fixed HTTP 502 result without provider values. Existing upstream non-2xx and transport-exception behavior shall remain unchanged.

### FR-5 — Authorization denial

- At Google worker, pCloud worker, static callback, and plugin protocol ingress, a nonempty authorization `error` shall take precedence over success parameters and cause no exchange/completion/folder-selection mutation.
- `access_denied` shall project to `Authorization was denied.`; every other nonempty code shall project to `Authorization failed (<code>).` using text-safe channel rendering.
- `error_description`, `error_uri`, and all other provider-controlled text shall be ignored.
- The plugin shall acquire `settings.backendData.pendingAuthState` once from the active normalized backend bag when the protocol callback arrives. It shall show a denial Notice only when that value is a nonempty string exactly equal to raw callback state; otherwise it shall have no side effect.

### FR-6 — Static callback state

- The static callback shall accept only decoded JSON that is a non-null, non-array object with string `app` and `nonce`, and whose app is an own allowlisted key.
- It shall continue to accept base64url and legacy base64 and shall forward the exact original state on success.
- Malformed, null, primitive, array, prototype-name, or unknown-app input shall not throw or redirect and shall show bounded fixed text.

### FR-7 — pCloud response shape

- pCloud HTTP success shall require an object with numeric `result`; nonzero remains the existing HTTP 400 logical failure, while zero additionally requires a nonempty string long-lived `access_token`.
- Invalid JSON/shape shall return a fixed HTTP 502. The US/EU host allowlist, missing-host default, upstream-status behavior, raw state, and refresh-free contract shall remain.

## Non-functional requirements

- NFR-1: credentials remain in SecretStorage or ephemeral manager memory, never settings, sync state, logs, notices, HTML, or error text. Existing six key namespaces, explicit clearing, Picker fields, state encodings/reload, detached manager isolation, channel-specific diagnostics, and mobile compatibility remain.
- NFR-2: immediate `getSecret` equality is the automated publication boundary. OS/process-restart durability is verified only by a recorded real-device checklist and is not inferred from mocks or the API signature.
- NFR-3: plugin and relay repositories own executable production-boundary tests and pass their source gates. Worker/Pages deployment and CI workflow changes are outside this change.

## Acceptance

- `acceptance-seven-roots`: every verified root has a discriminating green owned test plus compatibility controls.
- `acceptance-publication-before-reuse`: dropped, stale, unequal, or throwing publication cannot resolve completion or leave reusable response state; checkpoint failure cannot suppress a successful rotation write.
- `acceptance-attempt-snapshot`: settings drift cannot alter an in-flight exchange identity, and missing/inconsistent snapshot produces zero network calls.
- `acceptance-denial-parity`: all runtimes produce the exact semantic messages; mismatched/absent plugin state produces no Notice or dispatch; provider descriptions and sentinel secrets are absent.
- `acceptance-owned-gates`: both source gates run without external harnesses, credentials, deployment, global packages, or CI changes.
- `acceptance-native-boundary`: restart evidence is recorded per checked platform or explicitly marked unverified.
