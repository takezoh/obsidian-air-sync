# OAuth authentication publication — integrated design

Revision `oauth-authentication-publication-r1`. This plan adopts draft B as the structural winner and grafts draft A's explicit provisional-manager disposal rule. It is grounded in the seven accepted roots in `investigation-2.json`, the eight reviewed critique issues in `critique.json`, and the two user-approved boundaries in `approved-decisions.md`. Plugin source is `/workspace/obsidian-air-sync`; relay evidence was read from the same-revision mirror `/tmp/obsidian-air-sync-auth`, while implementation targets `/workspace/obsidian-air-sync-auth` at verified revision `68bf84510a7ee81738355a14ea66e5e1faca69d3` or its descendant. Source and repository-owned tests are in scope. Worker/Pages deployment, CI workflow changes, Google transport-exception behavior, and claims of OS/process-restart durability are outside scope.

## Requirements

<!-- anchor: req-completion-publication -->
`req-completion-publication` (FR, must): Google built-in/custom, Dropbox built-in/custom, and OneDrive built-in/custom completion resolves only after a required refresh credential is immediately readable under its existing SecretStorage key. A returned nonempty refresh token is the required candidate; only an equal readback proves it. If the response omits refresh_token, a previously readable nonempty refresh token remains sufficient for reauthorization. Fresh authorization with neither fails.

<!-- anchor: req-rotation-publication -->
`req-rotation-publication` (FR, must): every changed refresh token from shared or detached managers is published and read back before access, expiry, or refresh state from that response becomes reusable. Sync closeout success or failure cannot decide credential publication.

<!-- anchor: req-attempt-identity -->
`req-attempt-identity` (FR, must): each custom Dropbox/OneDrive attempt snapshots its client ID and, for OneDrive, authority at start. Authorization and exchange use that exact snapshot despite later settings edits; missing or inconsistent snapshot data rejects before exchange.

<!-- anchor: req-google-wire -->
`req-google-wire` (FR, must): Google callback and refresh handlers validate every HTTP-success JSON response as a non-null, non-array object with nonempty string `access_token`, finite positive numeric `expires_in`, and optional string `refresh_token` before projection. Transport exceptions retain current behavior.

<!-- anchor: req-authorization-denial -->
`req-authorization-denial` (FR, must): Google worker, pCloud worker, static callback, and plugin protocol ingress detect authorization denial before success-only gates. `access_denied` projects to `Authorization was denied.`; every other nonempty error code projects to `Authorization failed (<code>).`; `error_description`, `error_uri`, and other parameters never contribute text. Channel wrappers may differ, semantic code/message may not.

<!-- anchor: req-static-state -->
`req-static-state` (FR, must): static callback accepts state only when decoding/parsing yields a non-null, non-array object with string `app` and `nonce`, and `app` is an own allowlisted key. Base64url and legacy base64 remain supported and successful forwarding preserves the exact raw state.

<!-- anchor: req-pcloud-wire -->
`req-pcloud-wire` (FR, must): pCloud HTTP success requires a non-null, non-array object with numeric `result === 0` and nonempty string long-lived `access_token`; no refresh or expiry is required. Region host allowlist and existing upstream/logical-error behavior remain.

<!-- anchor: req-compatibility-security -->
`req-compatibility-security` (NFR, must): preserve all six secret namespaces, pending verifier/state reload, Picker `picked_file_ids`, detached-manager isolation, current token-endpoint diagnostic channels, mobile compatibility, and secrets-outside-settings. Never put credentials or provider descriptions in settings, sync state, notices, logs, HTML, or new errors.

<!-- anchor: req-source-verification -->
`req-source-verification` (NFR, must): both repositories own executable tests over production boundaries and pass source gates. Immediate SecretStorage equality is testable locally; restart durability is a separately recorded native checklist. Deployment and CI workflow adoption are not performed or claimed.

## Grounded components

<!-- anchor: component-secret-publication -->
`component-secret-publication` is the existing plugin `src/fs/token-store.ts` boundary over injected `ISecretStore`. It owns key construction and the required candidate-equal operation; no new credential owner is added.

<!-- anchor: component-auth-providers -->
`component-auth-providers` is the existing Google and shared PKCE auth-provider bases plus completion callers. It owns provisional completion-manager lifetime, candidate selection, attempt snapshot capture/validation, and the success boundary before save/reset/filesystem/folder selection.

<!-- anchor: component-token-manager -->
`component-token-manager` is `BaseOAuthTokenManager` and the Google/shared-PKCE factories. It owns response installation ordering and the shared/detached rotation hook. The two cycle `readBackendState` paths cease being refresh-token writers and retain only optional access/expiry projection.

<!-- anchor: component-denial-policy -->
`component-denial-policy` is the semantic owner for the exact two-case denial projection. The plugin keeps a small pure helper; relay/static implementations reproduce the same contract locally because no cross-repository runtime package is warranted. Google relay, pCloud relay, static callback, and plugin protocol handler are enforcement producers, not independent policy owners.

<!-- anchor: component-google-relay -->
`component-google-relay` is relay `worker/src/oauth.ts` and its router seam. It owns Google HTTP-success response validation and worker denial enforcement; outbound fetch is replaceable in tests.

<!-- anchor: component-pcloud-relay -->
`component-pcloud-relay` is relay `worker/src/pcloud.ts` and its router seam. It owns the access-only response boundary, regional host restriction, and worker denial enforcement.

<!-- anchor: component-static-callback -->
`component-static-callback` is relay `docs/callback/index.html`. It owns decode/schema/own-key/redirect ordering and local denial rendering; tests execute its actual inline script.

<!-- anchor: component-relay-harness -->
`component-relay-harness` is a planned repository-owned Node test/typecheck surface under relay `worker/`; it runs production handlers/static script without credentials, deployment, global packages, or `/tmp` harness dependency.

## Invariants

<!-- anchor: invariant-secrets-outside-settings -->
`invariant-secrets-outside-settings`: refresh/access credentials remain exclusively in SecretStorage or ephemeral manager/call memory. Settings may contain nonsecret expiry, pending state/verifier, and custom attempt identity snapshot; sync checkpoint/state and diagnostics contain no credential copy. This traces to `req-compatibility-security`.

<!-- anchor: invariant-candidate-equality -->
`invariant-candidate-equality`: required publication succeeds only when the exact nonempty candidate is synchronously returned by `getSecret` immediately after `setSecret`. Old presence cannot prove a different candidate; a thrown, missing, or unequal readback fails closed. This traces to `req-completion-publication`, `req-rotation-publication`, and the approved SecretStorage boundary.

## Implementation contracts

<!-- anchor: contract-secret-publication -->
`contract-secret-publication` owns the common mechanism. Input `input-required-candidate` is produced by a validated provider response, is opaque and stack-bounded, and is needed before completion/rotation success. Input `input-secret-readback` is produced synchronously by the injected store at the existing key and is needed immediately. Rule `rule-candidate-equal` writes the exact candidate then compares exact readback. Determinate equal yields `observable-publication-success`; missing/unequal (`conflicting`) or read/write exception (`unknown`) yields `failure-secret-publication`, a fixed secret-free authentication error. No retry, rollback, settings copy, async adapter, or physical-durability assertion is introduced. The existing optional secret setter/clear behavior and namespaces remain compatible. Normal witness: a fresh candidate reads back identically. Adversarial witnesses: dropped write over empty or old storage, stale read, throwing adapter, and a sentinel-bearing thrown cause all reject without exposing the sentinel. `verify-secret-publication` is T0.

<!-- anchor: contract-completion-publication -->
`contract-completion-publication` is owned by `component-auth-providers`. After state/PKCE and token-response validation, exchange occurs on a provisional manager that is not installed as the provider's reusable manager. Completion selects a fresh returned refresh candidate, otherwise the existing readable refresh; it proves `contract-secret-publication` before returning nonsecret updates or installing/reusing the manager. Fresh candidate has precedence: old presence never masks a dropped replacement. Missing both gives `failure-refresh-missing`; publication uncertainty gives `failure-secret-publication`. On any post-exchange publication failure, discard the provisional manager and all newly acquired in-memory access/refresh/expiry state; a later call must start a fresh explicit attempt and cannot use a fast path. No resolved updates, save, reset, filesystem construction, Picker selection, or success Notice occurs. Existing pending fields/snapshot remain until a new explicit attempt; reuse of a consumed code is not promised. Normal/retained witnesses span all six variants. Adversarial witnesses include missing initial refresh, dropped replacement over old secret, throwing store, and a second access/completion attempt proving no unpublished response reuse. Verification is `verify-six-completions` and `verify-completion-side-effects`.

<!-- anchor: contract-rotation-publication -->
`contract-rotation-publication` is owned by `component-token-manager`. Input is one validated refresh response and the manager's previous refresh identity. An absent/unchanged refresh keeps current behavior. For a changed nonempty refresh, the async rotation hook must complete candidate-equal publication before any access/expiry/refresh field from the response is installed and before the refresh promise resolves. A hook failure installs none of that response and propagates the safe publication failure; a second `getAccessToken` cannot return its access token. All shared and detached factories wire the hook. Required refresh writes are removed from both late `readBackendState` paths so checkpoint flush cannot suppress publication and a stale shared snapshot cannot overwrite a detached rotation. Existing refresh dedup/cooldown and sync commit/abort ordering remain; no cross-manager serialization, rollback, recovery state, or extra network call is promised. One write/read occurs only on actual rotation. Verification covers four shared/detached paths, failed-publication second calls, unchanged hook counts, and rotation followed by checkpoint failure.

<!-- anchor: contract-attempt-identity -->
`contract-attempt-identity` is owned by `component-auth-providers`. `startAuth` captures a nonsecret immutable `pendingAuthIdentity` snapshot from the same effective identity used to build the URL: provider kind, custom client ID, and OneDrive authority where applicable. It returns/persists that snapshot with pending state/verifier and constructs a provisional attempt manager from it. At callback, pending state, verifier, and snapshot are read once from active `backendData`. Missing fields, wrong provider/kind, empty custom client ID/authority, or mismatch between an existing attempt manager's recorded identity and the snapshot yields `failure-attempt-identity` before any token request. Current editable settings are not the exchange authority; the exact snapshot constructs/reconstructs the provisional manager after reload, so intervening settings edits do not change exchange identity. A new `startAuth` replaces the prior attempt snapshot/manager/state. Built-in fixed identities follow the same representation with their fixed values; connected-manager lifetime remains unchanged. Tests capture both next authorize URL and exchange request after prior exchange failure/settings edits, plus reload and mismatch/no-network controls.

<!-- anchor: contract-google-wire -->
`contract-google-wire` is owned by `component-google-relay`. An HTTP-success body is parsed as unknown and accepted only by `req-google-wire`; absent refresh remains valid and empty refresh is omitted. Valid callback preserves raw state and Picker IDs; valid refresh emits only accepted fields. Invalid JSON/shape yields `failure-google-token-shape`: fixed callback HTML or `{error:"invalid_token_response"}` JSON with HTTP 502 and no upstream value. Existing non-2xx mapping and transport-exception behavior are unchanged. Normal witness includes missing/rotated refresh; adversarial tests include null, array, bad JSON, missing/empty/nonstring access, nonfinite/nonpositive expiry, wrong refresh type, and sentinels absent from output.

<!-- anchor: contract-authorization-denial -->
`contract-authorization-denial` is owned by `component-denial-policy` and enforced at all four ingresses. Input is only the current untrusted `error` query value; `error_description`, `error_uri`, code/token/state dumps and provider text are ignored. A nonempty `access_denied` maps exactly to code `access_denied` and message `Authorization was denied.`; any other nonempty code maps to its same text-safe code and `Authorization failed (<code>).`. HTML escapes it and static/plugin paths use text-only presentation. Error presence wins over code/access token/Picker fields and causes zero exchange/completion/folder-selection/mutation.

For plugin ingress, `input-active-pending-state` is acquired once at protocol-handler invocation from the normalized active settings bag `this.settings.backendData.pendingAuthState`; that active bag is the sole producer/authority. Only a nonempty string exactly equal to raw `params.state` permits the denial Notice. Missing, nonstring, unequal, or backend-switched state has no Notice and no manager dispatch or other side effect. Worker/static may render their bounded denial only after their own state shape and own allowlisted app target checks; they do not claim CSRF authority. Matching semantic inputs must yield identical code/message across Worker, static, and plugin aside from channel wrappers. Tests cover mixed error+success, malicious descriptions, markup/oversized text safety, matching/mismatching/missing plugin state, and zero effect counts.

<!-- anchor: contract-static-state -->
`contract-static-state` is owned by `component-static-callback`. Decode base64url or legacy base64, parse, require a non-null non-array object with string app/nonce, then check own allowlist membership before lookup or redirect. Decode/schema failures produce fixed invalid-state text; valid unknown app produces fixed unknown-app text. Neither redirects nor throws. Valid input forwards the exact original state and allows extra existing fields. Prototype-like app names must fail. Verification executes the production inline script for both encodings and malformed shapes.

<!-- anchor: contract-pcloud-wire -->
`contract-pcloud-wire` is owned by `component-pcloud-relay`. The already allowlisted/defaulted US/EU host produces the upstream body. JSON must be a non-null, non-array object with numeric result. Nonzero result remains HTTP 400 logical failure; zero requires a nonempty string access token. Invalid JSON/shape/zero-without-token yields fixed secret-free HTTP 502. Existing network/upstream status behavior, raw state handoff, hostname output, default US and EU selection remain. No refresh/expiry or universal schema is introduced. Tests prove invalid host makes no request and valid access-only responses succeed.

<!-- anchor: contract-repository-verification -->
`contract-repository-verification` is owned by `component-relay-harness`. Plugin gate is `npm run lint && npm run lint:bot-repro && npm run build && npm run test:coverage`. Relay owns `npm test` and `npm run typecheck` scripts exercising production handlers and static source after a clean install. No CI workflow edit is required. Contract evolution is additive validation/fail-closed handling only: keys, endpoints, valid callbacks, state encodings, pCloud valid shape, and cross-version valid flows remain compatible; rollback needs no data migration. Real-device checklist records completion, restart continuity, observed rotation without token capture, and second restart on representative desktop/mobile; unexecuted cases remain unverified. Worker/Pages deployment remains separately authorized.

## ADR decisions

<!-- anchor: adr-sync-state-separation -->
`adr-sync-state-separation` applies accepted ADR 0001: auth credentials never become sync checkpoint/cache/record state, and moving rotation publication earlier must not change sync lifecycle ownership.

<!-- anchor: adr-shared-behaviour-tests -->
`adr-shared-behaviour-tests` applies accepted ADR 0002 to production-boundary fixtures and discriminating controls; no filesystem family is added.

<!-- anchor: adr-live-e2e-boundary -->
`adr-live-e2e-boundary` applies accepted ADR 0003: fakes/source tests do not establish native restart durability or deployed relay parity.

<!-- anchor: adr-auth-publication-boundary -->
`adr-auth-publication-boundary` fixes required refresh publication at completion/token-acquisition rather than late sync snapshots. This is accepted for this change by the user's immediate-readback approval. It preserves SecretStorage ownership, shared/detached isolation, and candidate equality; it rejects async adapters, journals, checkpoint ownership, blind writes, and old-secret fallback for a different candidate.

<!-- anchor: adr-callback-trust-boundaries -->
`adr-callback-trust-boundaries` fixes provider-local runtime validators and one semantic denial policy owner with local enforcement copies. It accepts an attempt-scoped nonsecret identity snapshot because authorize/exchange identity must survive settings edits/reload; it rejects a universal OAuth schema/package, provider-description reflection, current-settings exchange identity, and deployment coupling.

## Units

`unit-auth-publication` (chunk 1) implements required publication, provisional completion-manager disposal, async rotation ordering, all shared/detached factory hooks, late refresh-writer removal, focused token/provider/caller/orchestrator tests, and ownership docs. It changes no sync authority/order, key namespace, migration, rollback, recovery state, or physical durability claim.

`unit-attempt-identity` (chunk 2, after unit-auth-publication because `pkce-auth-provider.ts` overlaps) adds the typed pending identity snapshot, start/callback/reload validation, provisional manager construction, and Dropbox/OneDrive request-capture mismatch tests. No secret or general identity cache is added.

`unit-relay-validation` (chunk 2, independent) adds Google/pCloud local validators, worker denial enforcement, repository-owned tests/scripts, and relay README correction. It makes no deployment, transport-exception, CI workflow, new endpoint, or pCloud refresh change.

`unit-callback-ingress` (chunk 3, after denial policy foundations) adds the pure plugin projection/correlation seam, protocol tests, static state/denial handling, and production-script tests. No new deep-link error protocol or arbitrary provider text is added.

`unit-final-verification` (chunk 4) runs both source gates, updates plugin architecture/auth docs and relay README, records the native checklist as executed or unverified, and reports deployment as not performed.

## Acceptance

`acceptance-seven-roots`: all seven causal roots have discriminating green repository-owned tests and compatibility controls, with failures observed at their owning boundary and no downstream success effect.

`acceptance-publication-before-reuse`: dropped/unequal/throwing writes reject completion/rotation, discard provisional or uninstalled response state, and cannot be reused by a later fast path; checkpoint outcome is irrelevant.

`acceptance-attempt-snapshot`: settings edits between start and callback do not alter exchange identity; missing/inconsistent snapshot makes zero token requests and no auth success effects.

`acceptance-denial-parity`: matching denial produces exact cross-runtime semantics; plugin shows it only for an exact current active pending-state match, otherwise has no side effect; provider descriptions and sentinels never appear.

`acceptance-owned-gates`: plugin and relay gates run without `/tmp` harnesses, credentials, deployment, global package dependence, or CI workflow changes.

`acceptance-native-boundary`: only immediate equality is claimed by automated tests; restart durability is supported by recorded device evidence or explicitly remains unverified.

## Decision closure and critique resolution

All recovered decision inputs are closed in `spine.yaml`; no consequential design choice or open question remains. Private helper/test-fixture naming alone is delegated, and must preserve the two named invariants and owning contract verification.

`resolved_issues[]` trace (all `verdict:Y` findings):

- `issue_ref: issue-completion-manager-retention` — provisional manager non-installation/disposal plus second-call witness.
- `issue_ref: issue-attempt-config-drift-open` — start-time persisted nonsecret identity snapshot and pre-exchange rejection.
- `issue_ref: issue-denial-owner-split` — one `component-denial-policy` owner with four enforcement producers.
- `issue_ref: issue-denial-projection-open` — the exact two-case message contract.
- `issue_ref: issue-denial-state-source-gap` — one active-backend pending-state read at handler entry and silent no-effect mismatch.
- `issue_ref: issue-dangling-invariant-refs` — two anchored, requirement-backed invariant definitions.
- `issue_ref: issue-google-network-scope-broadening` — transport exceptions explicitly preserved.
- `issue_ref: issue-ci-gate-unowned` — workflow obligations removed.

Every reviewed issue is substantively closed rather than renamed or deferred.

The retained scope expansions are only the shared rotation boundary, nonsecret pending identity snapshot, pCloud malformed-success classification, repository-owned relay tests, native checklist, and the critic-induced denial-policy owner. Each traces directly to an accepted root or user-approved evidence boundary. No deployment or production mutation is authorized.
