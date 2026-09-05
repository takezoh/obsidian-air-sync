---
change: change-20260906-oauth-authentication-publication
role: implementation
contracts:
- contract-secret-publication
- contract-completion-publication
- contract-rotation-publication
- contract-attempt-identity
- contract-google-wire
- contract-authorization-denial
- contract-static-state
- contract-pcloud-wire
- contract-repository-verification
contract_projections:
- id: contract-secret-publication
  verifications:
  - verify-secret-publication
  discretion:
  - discretion-publication-helper-factoring
- id: contract-completion-publication
  verifications:
  - verify-six-completions
  - verify-completion-side-effects
  discretion: []
- id: contract-rotation-publication
  verifications:
  - verify-rotation-manager-order
  - verify-rotation-closeout-independence
  discretion: []
- id: contract-attempt-identity
  verifications:
  - verify-custom-attempt-identity
  discretion: []
- id: contract-google-wire
  verifications:
  - verify-google-relay-source
  discretion: []
- id: contract-authorization-denial
  verifications:
  - verify-plugin-denial
  - verify-relay-denial
  discretion: []
- id: contract-static-state
  verifications:
  - verify-static-production-script
  discretion: []
- id: contract-pcloud-wire
  verifications:
  - verify-pcloud-relay-source
  discretion: []
- id: contract-repository-verification
  verifications:
  - verify-plugin-gate
  - verify-relay-gate
  discretion: []
adrs:
- adr-sync-state-separation
- adr-shared-behaviour-tests
- adr-live-e2e-boundary
- adr-auth-publication-boundary
- adr-callback-trust-boundaries
decision_dispositions:
- decision_input_ref: decision-input-secret-publication
  disposition: 'adopted: synchronous exact candidate readback; physical durability
    excluded'
  adr_refs:
  - adr-auth-publication-boundary
  contract_refs:
  - contract-secret-publication
- decision_input_ref: decision-input-secret-keys
  disposition: 'adopted: preserve all existing namespaces, skip-empty and explicit
    clear'
  contract_refs:
  - contract-secret-publication
- decision_input_ref: decision-input-secret-domain
  disposition: 'adopted: SecretStorage remains credential authority outside settings
    and sync state'
  adr_refs:
  - adr-sync-state-separation
  contract_refs:
  - contract-secret-publication
- decision_input_ref: decision-input-completion-callers
  disposition: 'adopted: reject before caller success effects and discard provisional
    manager'
  contract_refs:
  - contract-completion-publication
- decision_input_ref: decision-input-isolation
  disposition: 'adopted: preserve detached/shared instance isolation with the same
    publication contract'
  contract_refs:
  - contract-rotation-publication
- decision_input_ref: decision-input-writers
  disposition: 'adopted: publish at acquisition and remove late required-refresh writes'
  adr_refs:
  - adr-auth-publication-boundary
  contract_refs:
  - contract-rotation-publication
- decision_input_ref: decision-input-attempt-identity
  disposition: 'adopted: persist and use the start-time nonsecret identity snapshot;
    reject missing or inconsistent snapshot before exchange'
  adr_refs:
  - adr-callback-trust-boundaries
  contract_refs:
  - contract-attempt-identity
- decision_input_ref: decision-input-state
  disposition: 'adopted: preserve raw state, encodings, verifier correlation and reload
    with snapshot extension'
  contract_refs:
  - contract-attempt-identity
  - contract-static-state
  - contract-authorization-denial
- decision_input_ref: decision-input-picker
  disposition: 'adopted: preserve picked_file_ids and legacy hosted endpoint'
  contract_refs:
  - contract-google-wire
  - contract-completion-publication
- decision_input_ref: decision-input-pcloud
  disposition: 'adopted: retain access-only shape and regional/status semantics'
  contract_refs:
  - contract-pcloud-wire
- decision_input_ref: decision-input-error-channels
  disposition: 'adopted: change authorization denial/malformed success only; preserve
    other channels'
  contract_refs:
  - contract-authorization-denial
  - contract-google-wire
  - contract-pcloud-wire
- decision_input_ref: decision-input-runtime-schemas
  disposition: 'adopted: provider-local runtime predicates, no universal package'
  adr_refs:
  - adr-callback-trust-boundaries
  contract_refs:
  - contract-google-wire
  - contract-static-state
  - contract-pcloud-wire
- decision_input_ref: decision-input-static-docs
  disposition: 'adopted: correct current versus legacy description without endpoint
    removal'
  contract_refs:
  - contract-static-state
  - contract-repository-verification
- decision_input_ref: decision-input-denial-copy
  disposition: 'adopted: access_denied fixed sentence; all other nonempty codes fixed
    code-bearing sentence; descriptions ignored'
  adr_refs:
  - adr-callback-trust-boundaries
  contract_refs:
  - contract-authorization-denial
- decision_input_ref: decision-input-native-proof
  disposition: 'adopted evidence boundary: native restart checklist is separate and
    may remain unverified'
  contract_refs:
  - contract-secret-publication
  - contract-repository-verification
- decision_input_ref: decision-input-deployment
  disposition: 'rejected from scope: no Worker or Pages deployment or deployed-parity
    claim'
  contract_refs:
  - contract-repository-verification
- decision_input_ref: decision-input-issue52
  disposition: 'subsumed: test missing-candidate and failed-readback roots without
    claiming reporter attribution'
  contract_refs:
  - contract-completion-publication
- decision_input_ref: decision-input-adr
  disposition: 'adopted: accepted sync/test/e2e boundaries plus accepted user-approved
    auth ADRs'
  adr_refs:
  - adr-sync-state-separation
  - adr-shared-behaviour-tests
  - adr-live-e2e-boundary
  - adr-auth-publication-boundary
  - adr-callback-trust-boundaries
  contract_refs:
  - contract-rotation-publication
  - contract-repository-verification
milestones:
- id: '1'
- id: '2'
- id: '3'
- id: '4'
reference_algorithms: []
---

<!-- lifecycle is owned by change.md -->

# Implementation

## Decisions

- SecretStorage remains the only durable credential owner. Required publication is a synchronous exact candidate write/readback postcondition; no plugin-owned credential store, journal, rollback, or async adapter is added.
- Completion exchanges on a provisional manager. Only successful required publication permits the manager/result to become reusable; failure discards it.
- Rotation publication moves into the existing token-manager response-acceptance hook and completes before response fields are installed. The shared Google/PKCE `readBackendState` paths stop writing refresh tokens.
- Custom PKCE attempts persist a nonsecret identity snapshot at start. Callback/reload uses the snapshot, not current editable settings, and rejects incomplete/inconsistent identity before exchange.
- One semantic denial policy owns the exact projection. Plugin, Google worker, pCloud worker, and static callback enforce local copies tested for equality; no cross-repository runtime package is introduced.
- Provider-local runtime validators preserve Google and pCloud's distinct success contracts. Google transport exceptions, CI workflows, and deployment remain untouched.

## Contracts and seams

- `contract-secret-publication`: add a narrow required-refresh operation in `src/fs/token-store.ts`; test equal, missing, stale, throwing, and sentinel-bearing failures through `ISecretStore`.
- `contract-completion-publication`: update both auth bases and manager/folder-pick consumers so failure precedes all success effects and provisional state cannot escape.
- `contract-rotation-publication`: make the existing rotation hook awaitable, invoke it before token-response installation, wire all shared/detached factories, and remove late required-refresh writes.
- `contract-attempt-identity`: extend Dropbox/OneDrive backend data with the pending nonsecret identity snapshot, populate it at start, clear it with other pending fields on success, and reconstruct/validate from it on callback/reload.
- `contract-google-wire` and `contract-pcloud-wire`: validate parsed unknown values in each provider owner and exercise exported production handlers with mocked outbound fetch only.
- `contract-authorization-denial`: use a pure plugin helper for projection/correlation so `main.ts` stays lifecycle-only; worker/static use text-safe local implementations with parity fixtures.
- `contract-static-state`: execute the production inline script in a minimal DOM/location VM and assert redirects, visible text, and absence of exceptions.
- `contract-repository-verification`: add relay-owned `npm test` and `npm run typecheck`; do not edit workflows or deploy.

## Dependency-ordered units

1. `unit-auth-publication`: token-store postcondition, provisional completion manager, pre-install rotation hook, four factory paths, late writer removal, focused tests, and plugin ownership docs. This unit lands coherently so no intermediate final state has unwired hooks and removed writers.
2. In parallel after its prerequisites:
   - `unit-attempt-identity` follows unit 1 because it overlaps `pkce-auth-provider.ts`; add snapshot fields/defaults, start/callback/reload logic, and request-capture tests.
   - `unit-relay-validation` is independent; add Google/pCloud validators, denial handling, owned worker tests/scripts, and README correction in `/workspace/obsidian-air-sync-auth`.
3. `unit-callback-ingress`: after denial semantics are available, implement plugin state-correlated Notice behavior and static state/denial tests across both repositories.
4. `unit-final-verification`: update remaining architecture guidance, run both source gates, and record device/deployment evidence honestly.

## File boundary

Plugin production changes are limited to token storage, OAuth manager/auth-provider factories, Dropbox/OneDrive backend-data defaults/types, protocol ingress/helper, and relevant architecture/auth docs. Relay changes are limited to worker OAuth/pCloud handlers/router support as needed, static callback, worker package-owned tests/scripts, and README. Existing investigation test files are retained and promoted into maintainable coverage. No sync orchestrator behavior, provider endpoint, filesystem registry, migration code, deployment configuration, credential capture, or CI workflow is added.

## Implementation discretion

Private helper names and fixture factoring inside `src/fs/token-store.ts` and its test may vary only while preserving exact keys, synchronous equality, fixed safe failures, `invariant-candidate-equality`, and `invariant-secrets-outside-settings`. Any change to owner, API timing, wire fields, failure outcome, snapshot representation, or denial text requires returning to design; it is not implementer discretion.
