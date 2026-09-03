# Rename identity evidence model

<!-- anchor: goal -->
## Goal

Normalize the existing one-way fresh-sync pipeline so that authority, evidence, user-visible
conflict outputs, mutation, proof, and persistence each have one owner. The design specifically
closes the unsafe `R@third + Y@new` case without adding durable recovery state or a second conflict
policy: all observed remote versions are preserved, then the configured existing strategy is
applied once to tracked identity R.

<!-- anchor: approach -->
## Approach

The dependency direction is fixed:

`planning → normalization → Admission → read-only preparation → configured resolver → executor → state committer → cycle finalizer`

No downstream stage reconstructs an upstream decision. Planning derives a local rename candidate
once. A private normalizer is the sole producer of the legal state union. Admission is a pure total
function over that union and derives the action plus `RenameDebt` membership once. Preparation only
reads and snapshots. The existing resolver alone names, writes, and verifies conflict artifacts.
The executor alone owns delete/rename/write ordering and the private terminal proof seam. The state
committer and finalizer remain separate durable owners.

<!-- anchor: scope -->
## Scope and non-goals

The change is backend-agnostic and uses existing `IFileSystem` operations. It does not add a durable
deferred/pending/journal row, pinned payload, replay authority, new provider/checkpoint API, new
conflict strategy, workflow engine, rollback rename, raw mutation retry, or cross-invocation
artifact-deduplication guarantee. It does not claim linearizability against external writers after
observation.

## Minimality reconciliation

The final inventory adds no conflict subsystem, proof subsystem, or composite persistence owner.
`component-conflict-resolver` and `component-plan-executor` are normalized names for existing
`conflict-resolver.ts` and `plan-executor.ts` responsibilities already present in the drafts. Their
contract separation is critic-induced: preparation remains read-only under the resolver component,
output policy stays with the configured resolver, and terminal observation/proof returns to an
executor-private seam instead of draft 2's proposed terminal-proof component.

`component-state-committer` and `component-cycle-finalizer` are the two existing owners obscured by
draft 1's composite component and draft 2's contract-owner mismatch. The split introduces no
wrapper: the former owns per-file CAS only, and the latter owns clean checkpoint then exact debt
release only. `adr-0001-metadata-cache-is-subordinate-to-commit-last` is retained solely as existing
authority for the commit-last invariant shared by those contracts. Each retained target has one
sparse `scope_expansion_signals` trace in `spine.yaml`.

## Requirements

<!-- anchor: req-immutable-cycle-evidence -->
### REQ-IMMUTABLE-CYCLE-EVIDENCE

Planning derives the local rename candidate exactly once from source observations and returns it in
the same deeply immutable cycle value. Nested arrays and tuples are defensive copies and readonly;
mutable `Map`/`Set` values and a second derived candidate view do not cross the boundary.

<!-- anchor: req-legal-normalized-state -->
### REQ-LEGAL-NORMALIZED-STATE

Raw location, occupancy, identity, content/version, scope, and authority observations never flow as
an independently combinable Cartesian product. The normalizer alone produces `NormalizedRenameState`:

```ts
type NormalizedRenameState =
  | { kind: "baseline_at_old_vacant_target"; source: ExactRemote; relation: VersionRelation }
  | { kind: "baseline_at_new"; target: ExactRemote; relation: VersionRelation; localRelation: ContentRelation }
  | { kind: "baseline_at_third_vacant_target"; source: ExactRemote; relation: VersionRelation }
  | { kind: "baseline_at_third_foreign_target"; primary: ExactRemote; additional: ForeignRemote; relation: VersionRelation }
  | { kind: "baseline_absent_foreign_target"; additional: ForeignRemote }
  | { kind: "baseline_absent_vacant_target" }
  | { kind: "evidence_unknown"; reason: EvidenceUnknownReason }
  | { kind: "evidence_contradicted"; reason: EvidenceContradictionReason };
```

Each determinate variant contains the exact entities and version relation legal for that variant.
Examples such as “baseline at new plus foreign occupant” or “baseline absent but proved unchanged”
have no constructor. Multiple occurrences of R, unresolved aliases, missing identity authority, or
mutually inconsistent endpoint facts normalize to the explicit zero-authority variants.

<!-- anchor: req-total-admission-decision -->
### REQ-TOTAL-ADMISSION-DECISION

Admission exhaustively maps one normalized state to one of `authorized`, `resolved_no_action`,
`evidence_unknown`, or `evidence_contradicted`. It also derives exact candidate debt `persist` and
`release` membership in the same pass. Admission performs no I/O. Unknown or contradicted evidence
has no executable action and no release membership.

<!-- anchor: req-bounded-version-snapshot -->
### REQ-BOUNDED-VERSION-SNAPSHOT

Same-algorithm content keys remain the cheapest stability proof. If comparable keys are absent and
known non-zero mtime cannot prove the version, preparation performs bounded `stat → read → stat`.
When metadata still cannot discriminate stability, it performs one second read and requires exact
byte equality with the first snapshot. Thus each source uses at most two reads and the bracketing
stats required to bind identity/path/size. Stable bytes proceed; an unreadable source is an external
I/O/auth terminal failure, and a changed identity/stat/read is `proof_mismatch` blocked. There is no
same-input permanent unknown loop.

<!-- anchor: req-preserve-all-remote-versions -->
### REQ-PRESERVE-ALL-REMOTE-VERSIONS

For `R@third + Y@new`, preparation returns immutable exact snapshots and obligations for both R and
Y. Before an original can be deleted, renamed, or overwritten, the configured resolver creates an
exact-byte preservation output for each observed remote version and verifies it by readback on both
local and remote filesystems.

<!-- anchor: req-resolver-once -->
### REQ-RESOLVER-ONCE

The existing configured resolver is invoked exactly once for the component. Inputs are ordered:
`primary = tracked R`; `additional = [foreign Y]` for the multi-remote case and `[]` otherwise. The
configured `auto_merge | duplicate` behavior applies only to local/base/primary R. Additional Y does
not participate in the merge or newer-wins choice; it is preserved as an exact duplicate output.

The resolver uses the existing `generateConflictPath` allocator in ordered primary-then-additional
sequence. Every preservation output is visible at the same relative `.conflict[-N]` path on local
and remote. Under `duplicate`, the primary preservation output is the ordinary duplicate result and
is reused rather than duplicated again. Under `auto_merge`, the primary output is an exact backup
while the ordinary strategy result applies at the target. The returned result enumerates the
primary result and every verified output; incomplete output is failure, never partial success.

A failed invocation may leave verified numbered outputs. A later invocation starts from fresh legal
evidence and may allocate further numbered outputs. The design deliberately does not infer ownership
from bytes or deduplicate across invocations, so duplicate retry can create additional visible files.

<!-- anchor: req-executor-terminal-proof -->
### REQ-EXECUTOR-TERMINAL-PROOF

After resolver success, the executor alone orders any target delete, source rename, target write,
and terminal re-observation. Its private helper proves: old/third source absence when rotation was
required, target identity equals tracked R, target bytes equal intended current local bytes, and
the resolver result covers every preservation obligation. No new terminal-proof component or file
is introduced.

<!-- anchor: req-per-file-cas -->
### REQ-PER-FILE-CAS

Only the executor can construct the private branded `TerminalFreshProof`. `state-committer.ts`
accepts that proof plus the exact admitted baseline and owns only the per-file compare-and-move/put
CAS. Raw observations, resolver results, and mutation return values cannot construct a target record.

<!-- anchor: req-clean-finalization -->
### REQ-CLEAN-FINALIZATION

`sync-cycle-finalization.ts` owns global finalization separately. A clean set of terminal component
results permits checkpoint commit and then exact release of the corresponding candidate debts.
Unknown, contradicted, failed, or blocked components withhold both. Disconnected proof-backed
per-file records may remain committed; they are not rolled back.

<!-- anchor: nfr-no-new-recovery-surface -->
### NFR-NO-NEW-RECOVERY-SURFACE

Recovery is an ordinary fresh sync. `RenameDebt` remains endpoint acquisition evidence, never an
operation carrier. No durable phase, pending action, journal, receipt, payload, provider primitive,
strategy, or cross-invocation output ownership is introduced.

<!-- anchor: nfr-unique-owners -->
### NFR-UNIQUE-OWNERS

Every authority-changing or effecting step has exactly one owner, reflected in the components and
contracts below. Private pure helpers do not become components or alternative entry points.

## Components

<!-- anchor: component-cycle-planning -->
### component-cycle-planning

Existing `sync-cycle-planning.ts` owns source capture, one-time local candidate derivation, and deep
immutability. The shallow `cycle-admission-snapshot.ts` carrier is folded/deleted rather than
replaced by another boundary.

<!-- anchor: component-rename-admission -->
### component-rename-admission

Existing Admission files own the sole private normalizer, identity-component partition, total
decision, destructive authorization, and debt persist/release derivation. They import no filesystem
handle and export no second classifier.

<!-- anchor: component-conflict-resolver -->
### component-conflict-resolver

Existing conflict modules expose two sequential seams under one component: read-only preparation,
then the configured resolver invocation. Preparation has no artifact policy. Resolver code is the
only naming/write/readback owner for all user-visible conflict outputs.

<!-- anchor: component-plan-executor -->
### component-plan-executor

Existing executor owns all post-Admission external mutation, configured resolver sequencing, result
mapping, and terminal endpoint/identity/byte proof. The proof predicate and terminal observation
helper are private seams inside `plan-executor.ts`.

<!-- anchor: component-state-committer -->
### component-state-committer

Existing state committer owns only proof-gated per-file exact-baseline CAS.

<!-- anchor: component-cycle-finalizer -->
### component-cycle-finalizer

Existing cycle finalization owns only clean checkpoint commit followed by exact debt release.

## Implementation contracts

<!-- anchor: contract-cycle-evidence -->
### contract-cycle-evidence

Producer: planning. Input: change observations, committed baseline, scope, and candidate debts.
Output: one deeply immutable cycle value containing one derived local rename candidate. Observable:
mutation attempts cannot change downstream classification, and candidate derivation is called once.
Failure: authoritative acquisition failure remains external failure rather than absence.
`open_design_choices = []`.

<!-- anchor: contract-legal-normalization -->
### contract-legal-normalization

Producer: the private normalizer in Admission. Input: immutable cycle evidence. Output: exactly one
legal union variant. Precedence is identity occurrence/authority, location, foreign occupancy, then
content/version relation; byte equality never turns foreign Y into tracked R. Unknown and
contradicted are explicit, zero-authority values. `open_design_choices = []`.

<!-- anchor: contract-total-admission -->
### contract-total-admission

Owner: Admission. It is a total pure switch over the legal union and produces a disposition, action
authority when allowed, and exact debt membership once. `baseline_at_third_foreign_target` authorizes
one multi-remote conflict with R primary and Y additional. `baseline_absent_foreign_target` preserves
Y through the ordinary destination-conflict shape but cannot invent tracked identity authority.
`open_design_choices = []`.

<!-- anchor: contract-conflict-preparation -->
### contract-conflict-preparation

Owner: conflict resolver component's read-only preparation entry. It returns a closed union:

```ts
type PreparedConflict =
  | { kind: "prepared_no_rotation"; primary: ExactSnapshot; additional: readonly [] | readonly [ExactSnapshot]; obligations: PreservationObligations }
  | { kind: "prepared_rotation_required"; source: ExactIdentitySource; sourceWitness: StableVersionWitness; primary: ExactSnapshot; additional: readonly [] | readonly [ExactSnapshot]; obligations: PreservationObligations };
```

Rotation-required without source/witness/snapshots cannot be constructed. Preparation does no write,
delete, rename, artifact allocation, or resolver invocation. `open_design_choices = []`.

<!-- anchor: contract-resolver-preservation -->
### contract-resolver-preservation

Owner: the existing configured resolver. Operational input is the prepared ordered snapshot set and
current configured strategy. It allocates primary then additional paths, writes exact snapshots to
both sides, verifies each output, and only then applies the configured strategy to primary R. The
observable result contains primary action and all output paths/versions. Each input has invocation
scope and is invalidated by any readback mismatch. Complexity is O(total prepared bytes), at most
two remote versions and two visible outputs for the multi-remote row, plus ordinary strategy I/O.
`open_design_choices = []`.

<!-- anchor: contract-executor-effects-proof -->
### contract-executor-effects-proof

Owner: executor. Decision order is resolver, required delete/rename/write, then terminal read/stat
proof. Failure union is closed:

- `evidence_unknown | evidence_contradicted`: Admission-owned, zero action.
- `external_io_failure`: executor `failed`; no commit/checkpoint.
- `external_auth_failure`: executor `blocked` and existing auth abort/status path; no commit/checkpoint.
- `proof_mismatch`: executor `blocked`; no retry/rollback/commit.
- branded internal invariant violation: fail fast; never converted to a recoverable external result.

Every stopped cut returns on the next invocation to planning and the fresh legal union. Resolver
outputs may survive and are ordinary observed files; no cut is relabeled atomic. `open_design_choices = []`.

<!-- anchor: contract-per-file-cas -->
### contract-per-file-cas

Owner: state committer. It consumes only branded terminal proof and exact admitted baseline. CAS
failure leaves the external filesystem outcome visible but creates no false baseline. It neither
finalizes a checkpoint nor releases debt. `open_design_choices = []`.

<!-- anchor: contract-clean-finalization -->
### contract-clean-finalization

Owner: cycle finalizer. It consumes terminal execution/commit results. Clean means every admitted
component is successful and no evidence unknown/contradicted, failed, or blocked result exists.
Checkpoint succeeds before the exact release set is removed. It does not consume raw proof or own
per-file CAS. `open_design_choices = []`.

## Partial-cut normalization

| Last durable/external cut | Next fresh normalized family | Required behavior |
|---|---|---|
| Before resolver/output | Same or newer legal state | No artifact/effect from preparation |
| Some verified preservation outputs | Fresh state including those visible files | Resolver may allocate new numbered outputs; no dedup claim |
| Target deleted, source still present | R at old/third with vacant or newly occupied target | Fresh total Admission; no raw retry |
| Source renamed, target not written | R at new with current observed bytes | `baseline_at_new`; decide from fresh relation |
| Target written, proof not issued | R at new with current observed bytes | Fresh relation; no record from old result |
| Terminal proof issued, CAS absent | Usually R at new; CAS still absent | Fresh state or exact CAS attempt only through current proof lifetime |
| Per-file CAS committed, checkpoint absent | New-path record plus old checkpoint/debt | No rollback; later clean cycle finalizes |
| Checkpoint committed, exact release absent | Current checkpoint plus residual evidence debt | Existing exact release semantics; debt cannot replay I/O |

All rows re-enter the same legal union. There is no separate recovery state machine.

## ADRs

<!-- anchor: adr-0001-metadata-cache-is-subordinate-to-commit-last -->
### adr-0001-metadata-cache-is-subordinate-to-commit-last

Remains accepted: observations and caches are subordinate to terminal external proof and commit-last.

<!-- anchor: adr-20260831-admission-owns-identity-component-decisi -->
### adr-20260831-admission-owns-identity-component-decisi

Remains accepted: Admission is the unique owner of identity-component authorization and lifecycle.

<!-- anchor: adr-20260902-fresh-state-reconciliation-for-rename-edits -->
### adr-20260902-fresh-state-reconciliation-for-rename-edits

Remains accepted: uncertain/partial work returns through fresh observation, not stored replay phases.

<!-- anchor: adr-20260903-preserve-all-observed-remote-versions -->
### adr-20260903-preserve-all-observed-remote-versions

Accepted by explicit user decision. The full decision, visibility, naming, primary/additional
semantics, and retry consequence are materialized in the companion ADR.

## Dependency-ordered units

1. `unit-cycle-evidence` folds the shallow snapshot carrier into planning and pins deep immutability.
2. `unit-normalization-admission` introduces the sole legal union and total pure Admission mapping.
3. `unit-conflict-resolution` adds bounded read-only snapshots and extends the single resolver result.
4. `unit-executor-terminal-proof` moves/keeps all mutations and private terminal proof in executor.
5. `unit-commit-finalization` pins branded-proof CAS and the separate clean finalization owner.

For every unit, `implementation_decisions_remaining = []`; naming, policy, ownership, error mapping,
resource bound, visibility, and durable behavior are fixed by contracts.

## Resolved critic issues

| issue_ref | resolution |
|---|---|
| `issue-operator-direction-is-not-decision-approval` | The general direction is not treated as product approval; `operator-decision-20260903.json` explicitly accepts preserve-all and is traced to an accepted ADR. |
| `issue-d1-permanent-unknown-has-no-progress-bound` | Metadata insufficiency now uses bounded stat/read snapshots and terminates stable, failed, or blocked within one invocation. |
| `issue-d1-third-r-y-loses-one-remote-version` | R and Y are mandatory exact snapshots/obligations and both receive verified resolver-owned outputs before destructive effects. |
| `issue-d1-prepared-conflict-represents-illegal-state` | Prepared conflict is a no-rotation/rotation-required union; rotation fields are jointly mandatory. |
| `issue-d1-post-admission-unknown-has-no-result-owner` | Post-Admission preparation/execution failures map only to executor failed/blocked; Admission unknown remains the sole epistemic zero-action state. |
| `issue-d1-commit-owner-is-not-unique-in-spine` | Per-file CAS and global finalization are separate contracts owned by state committer and cycle finalizer. |
| `issue-d2-preparation-becomes-second-conflict-output-owner` | Preparation is read-only; the existing resolver alone allocates, writes, and verifies all outputs. |
| `issue-d2-multi-remote-policy-is-hidden-strategy` | Accepted ADR fixes primary R, additional Y, strategy scope, naming, dual visibility, verification, and retry consequences. |
| `issue-d2-error-triage-collapses-epistemic-and-effect-failure` | Failure semantics split unknown/contradicted, I/O, auth, proof mismatch, and internal invariant violation with total mappings. |
| `issue-d2-cartesian-evidence-remains-constructible` | The private normalizer produces one legal discriminated union; independent location/occupancy/version products do not cross the boundary. |
| `issue-d2-commit-finalization-owner-mismatch` | Spine and prose assign per-file CAS to state committer and checkpoint/debt release to finalizer. |
| `issue-d2-terminal-proof-module-is-speculative-boundary` | The proposed component/file is removed; proof remains an executor-private predicate and observation seam. |

There are no unresolved critique blockers, no open design choices, and no implementation-level
design choices remaining.
