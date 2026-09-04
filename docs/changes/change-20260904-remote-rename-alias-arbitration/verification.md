---
change: change-20260904-remote-rename-alias-arbitration
role: verification
---

<!-- lifecycle is owned by change.md -->

# Verification

## Content

## Verification strategy

Verification is dependency ordered: first pin the current recurrence and every
discriminating negative as RED, then make Admission green, then prove downstream and
provider convergence, and finally run architecture/documentation guards plus the full
repository gate. Every rejected identity component asserts both the exact existing
reason array and zero executable actions.

## T0 — Admission contract tests

Target: src/sync/plan-admission.test.ts.

| Case | Required observation |
|---|---|
| Production-shaped remote folder recurrence | Three local aliases, report TemplateS to Templates, and two stable remote identities produce only rename_local TemplateS to Templates, one authorized disposition, and no reason |
| Former alias-first opportunity present/absent | Both variants produce the same reported-authority result |
| Coherent reported family plus inverse-looking alias | Report family wins; alias cannot choose direction |
| Conflicting normative reports plus complete alias candidate | Exactly rename_mismatch, one failed disposition, zero actions |
| No effective report with complete local case-only current facts | Existing child content work plus exactly one parent rename_remote |
| Selected report but plausible action-derived synthetic authority only | Rejected; the action cannot create RenameEvidence |
| Input permutations | Equal fact multisets produce identical action projection, disposition, and ordered reasons |

The RED checkpoint is recorded before production edits. It must fail on the current
alias-first/action-derived behavior for the expected contract reason, not because of a
malformed fixture.

## T0 — exact root-proof and failure matrix

| Facts | Exact result | Executable actions |
|---|---|---:|
| Exact correctly directed root action and complete suffix-aligned, included, unique, exhaustive descendants | Authorized selected-family result | Selected family only |
| Conflicting report plus complete alias | rename_mismatch | 0 |
| Wrong root or direction plus partial descendants | rename_mismatch | 0 |
| Correctly bound folder with empty mapping | incomplete_folder_mapping | 0 |
| Correctly bound folder with missing, extra, crossed, duplicate, suffix-mismatched, or ambiguous pair | incomplete_folder_mapping | 0 |
| Correctly bound folder with deferred or unknown-scope descendant plus alias | incomplete_folder_mapping | 0 |
| Correctly bound non-folder report with deferred/unknown scope | unknown_scope | 0 |
| Complete root proof plus unrelated alias | alias_target_mutation | 0 |
| Existing present_unresolved/unknown observation/conflicting identity/opposing deletes overlap | All true orthogonal existing reasons, deduplicated and lexical | 0 |
| Existing selected alias/local evidence unknown or contradiction | Its exact singleton reason; no later family | 0 |

Repeat representative rows with reversed evidence, observation, action, and alias order.
The result must be stable. Assert that no new reason string is introduced.

## T0 — affine work bound

Wrap action, descendant, evidence, observation, and relevant-scope collections with
test-only element-read counters. Run connected balanced fixtures at sizes 64 and 512.
For each fixture require:

    reads <= 32 * (A + D + E + O + S) + 128

The fixture must exercise report classification, materialization, proof indexing, alias
membership, and final evaluation. Confirm the larger fixture fails for a deliberately
all-pairs test implementation. No counter or performance telemetry enters production.

Focused command:

    npm test -- src/sync/plan-admission.test.ts

## T1 — static architecture guard

Target: sync-admission-authority-guard.test.mjs, registered in lint:bot-repro.

This guard verifies the contract owned by component-identity-component-authority. The
guard, lint configuration, and documentation are enforcement surfaces, not another
runtime component or semantic owner.

The guard shall use the TypeScript AST and a closed production-source inventory to
verify:

- identity-component-decision.ts is the sole production value importer of the candidate
  and topology helpers;
- plan-admission.ts imports only the component-decision runtime entry;
- type-only compatibility imports are classified separately;
- the component-decision and topology modules contain no module-scope mutable
  correctness data or top-level mutations;
- additions to the production inventory fail until explicitly classified.

Discriminating fixtures:

| Fixture | Expected |
|---|---|
| Top-level const proofCache = new Map() | Guard failure |
| Top-level mutable object or array proof carrier | Guard failure |
| Top-level let/var, class/enum, assignment, or update | Guard failure |
| Candidate/topology value import from a foreign production module | Guard failure |
| Pure functions, exported types/interfaces, imports, primitive-literal consts, and call-local immutable proof | Pass |

Run the new guard and then run the existing sync-state-ownership-guard.test.mjs without
changing its source or fixture. Passing one guard cannot waive the other.

## T1 — acquisition, backend, execution, and state integration

Verify the same complete component under constructed COLD, WARM, and HOT acquisition
labels yields byte-equivalent actions, disposition, and reasons. Treat those acquisition
and backend paths as operational-input producers for the single authority component.
Run the central remote backend contract composition so Google Drive, OneDrive, and
Dropbox all prove the same provider-neutral folder RenamePair behavior; do not add
provider-specific Admission assertions.

The orchestrator sequence is:

1. A clean local case-only parent transition completes and commits through existing
   child-before-parent execution.
2. A later current-cycle provider report describes the opposite folder transition while
   aliases remain unchanged.
3. Common Admission emits the authoritative rename_local and the clean attempt publishes
   its checkpoint.
4. A child or parent failure withholds the checkpoint, aborts the existing live working
   view after siblings settle, preserves successful post-I/O records, and a retry
   re-observes ordinary current facts without retained family/proof/reason/recovery data.

Required evidence:

- existing executor ordering tests remain green;
- existing state-committer/finalization/working-view tests remain green;
- no production diff appears in provider, executor, committer, finalizer, checkpoint,
  state schema, or orchestrator field ownership;
- the central registered-family matrix remains green for all three backends.

Focused commands are selected from existing test names after implementation, including:

    npm test -- src/sync/orchestrator.test.ts
    npm test -- tests/fs/remote-backend-contracts.test.ts
    node sync-state-ownership-guard.test.mjs

Live Google Drive, OneDrive, and Dropbox E2E is optional credential-gated fidelity
evidence and is reported as unverified when credentials are absent. It is not a closure
substitute for the always-on shared contracts.

## T1 — documentation and promotion

Verify all of the following:

- docs/adr/adr-20260904-remote-rename-alias-arbitration.md exists with proposed status,
  alternatives, consequences, explicit clause-level supersession, and no claim that
  historical ADR files were rewritten;
- active design promotions INV-007, INV-008, and BOUNDARY-007 are present;
- AGENTS.md, ARCHITECTURE.md, docs/sync-pipeline.md, and docs/code-enforcement.md describe
  component-identity-component-authority as the one stateless Admission semantic owner
  and do not present RenameDebt, retained evidence, a planning/debt gate, or
  checkpoint-debt release as current behavior;
- accepted ADRs and completed change packages remain unchanged;
- implementation targets and enforcement text name the new static guard and retain the
  existing state-owner/checkpoint guard independently.

Run dev-docs lint and conformance through the repository's dev-skills wrapper.

## Final gate

Completion requires every required focused test, both architecture guards,
documentation conformance, and the project gate to be green:

    npm run lint
    npm run lint:bot-repro
    npm run build
    npm run test:coverage

Any failure implying a new provider branch, public proof carrier, persisted or
cross-attempt owner, recovery path, intermediate checkpoint, observable vocabulary,
executor order, or commit/checkpoint rule stops delivery and returns the package to
design. Closure evidence must record exact commands and results; optional live E2E must
be labelled verified or unverified separately.
