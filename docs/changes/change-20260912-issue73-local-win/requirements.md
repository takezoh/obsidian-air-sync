---
change: change-20260912-issue73-local-win
role: requirements
functional_requirements:
- id: FR-PL-001
  statement: Prefer local is selectable beside existing strategies with an accessibly
    associated three-part safety explanation.
  priority: must
- id: FR-PL-002
  statement: Prefer local changes only admitted conflicts and preserves ordinary bidirectional
    edits and creations.
  priority: must
- id: FR-PL-003
  statement: Only a simple same-path edit/edit with a non-empty SyncRecord SHA-256
    baseline and three proven SHA-256 inequalities may local-win.
  priority: must
- id: FR-PL-004
  statement: Unproved simple collisions preserve both; edit/delete preserves the survivor;
    compound conflicts preserve required versions; unstable capture is non-clean.
  priority: must
- id: FR-PL-005
  statement: Facts carry no action; Admission alone decides and the existing resolver/executor
    route consumes without re-decision.
  priority: must
- id: FR-PL-006
  statement: Evidence is attempt-only and the two existing commit-last publication
    points and current-facts retry remain exclusive.
  priority: must
- id: FR-PL-007
  statement: Existing strategies have zero added proof reads and unchanged outcomes;
    saved ask/default/unknown and temperature equivalence remain compatible.
  priority: must
- id: NFR-PL-001
  statement: Proof I/O converges on K qualified Prefer-local candidates and bodies/directives
    are neither logged nor persisted.
  priority: must
---

<!-- lifecycle is owned by change.md -->

# Requirements

## Functional requirements

- **FR-PL-001 / UAC-001:** The settings UI shall offer Prefer local beside Auto merge and Duplicate and accessibly associate an explanation of conflict-only scope, proven-edit local win, and uncertain preserve-both behavior.
- **FR-PL-002 / UAC-002..005:** Prefer local shall not change ordinary bidirectional one-sided edits or creations.
- **FR-PL-003 / UAC-006:** A simple same-path edit/edit may local-win only when non-empty `SyncRecord.hash` is the common SHA-256 baseline and current local and remote SHA-256 `FileEntity.hash` facts prove local != base, remote != base, and local != remote.
- **FR-PL-004 / UAC-007..010,014..016:** No/empty baseline, unavailable or unstable proof, and uncertain simple collisions preserve both using existing Duplicate placement; equal bytes match; edit/delete preserves the edited survivor; compound conflicts preserve every required version before destructive work. Preservation failure is non-clean and non-destructive.
- **FR-PL-005:** Observations contain metadata/fingerprint facts only; Admission alone authorizes `local_win_allowed | preservation_required` for Prefer-local conflict actions. Same-content, edit/delete survivor, and compound obligations retain their existing match/action/topology routes. Resolver/executor consume the disposition through the existing every-conflict route without re-decision and acquire/revalidate exact snapshots only at application time.
- **FR-PL-006:** Proof is attempt-only. File records publish only after admitted I/O and terminal proof; checkpoints only after a wholly clean cycle. Retry re-observes current facts.
- **FR-PL-007 / UAC-011..013,017..018:** Auto merge and Duplicate outcomes and failure surfaces remain unchanged, saved `ask` remains Duplicate, default/unknown remain Auto merge, and saved Prefer local round-trips.

## Non-functional requirements

- **NFR-PL-001:** Additional body reads occur only when `strategy === prefer_local` for post-scope, baseline-backed, two-sided conflict candidates and only to complete missing current SHA-256 `FileEntity.hash` facts. Auto merge and Duplicate incur exactly zero additional reads. Work is bounded by candidate count K rather than scoped file count N; no exact content buffer is carried by BatchObservation or Admission.
- Bodies, proof fingerprints, directives, failures, and recovery instructions shall not become logged content or durable correctness state.
- COLD, WARM, and HOT shall return the same Admission result for the same complete current facts.

## Closed outcome partition

Same current bytes match. A proven simple bilateral edit/edit uses local bytes for both originals without an ordinary conflict copy. An uncertain simple collision uses Duplicate placement. Edit/delete uses its survivor. Compound conflict retains its existing preservation obligations. Required capture/read/stability failure is non-clean and cannot start the destructive suffix. Identity, mtime, size, record existence, empty hash, or a non-SHA-256/differently-algorithmic checksum is never content proof.

## Non-goals

No one-way sync mode, prompt, new preservation namespace, persisted proof/recovery state, new action kind, separate resolver/executor route, storage migration, exact snapshot transport through observation/Admission, required new helper, or new ADR is introduced.
