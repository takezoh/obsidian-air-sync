---
change: change-20260902-rename-identity-evidence-model
role: requirements
functional_requirements:
- id: REQ-IMMUTABLE-CYCLE-EVIDENCE
  statement: The system shall derive each local rename candidate exactly once during
    planning and carry the source observations and candidate in one deeply immutable
    cycle evidence value.
  priority: must
- id: REQ-LEGAL-NORMALIZED-STATE
  statement: The system shall expose only one normalized discriminated union of legal
    fresh rename states, including explicit evidence_unknown and evidence_contradicted
    variants.
  priority: must
- id: REQ-TOTAL-ADMISSION-DECISION
  statement: When a normalized fresh rename state is admitted, the system shall derive
    exactly one total disposition and its exact RenameDebt persist/release membership
    without I/O.
  priority: must
- id: REQ-BOUNDED-VERSION-SNAPSHOT
  statement: If comparable checksum and known mtime proof are unavailable, then the
    system shall use bounded stat-read-stat/read byte snapshots and shall terminate
    explicitly when a stable snapshot cannot be obtained.
  priority: must
- id: REQ-PRESERVE-ALL-REMOTE-VERSIONS
  statement: When tracked identity R is at one included third path and foreign identity
    Y occupies the destination, the system shall create and verify user-visible exact-byte
    conflict outputs for both observed remote versions before any destructive effect.
  priority: must
- id: REQ-RESOLVER-ONCE
  statement: The system shall use the existing configured auto_merge or duplicate
    resolver exactly once per authorized component as the only owner of conflict output
    naming, writing, and verification, applying the configured strategy to primary
    tracked R only.
  priority: must
- id: REQ-EXECUTOR-TERMINAL-PROOF
  statement: If resolver completion, delete, rename, write, or terminal observation
    is incomplete or mismatched, then the system shall commit no new-path record or
    checkpoint and shall not retry a raw mutation or roll it back.
  priority: must
- id: REQ-PER-FILE-CAS
  statement: The system shall allow the state committer to perform a per-file exact-baseline
    CAS only from the executor's branded terminal proof.
  priority: must
- id: REQ-CLEAN-FINALIZATION
  statement: While a cycle is clean and every admitted component has a terminal successful
    result, the system shall commit the checkpoint before exact RenameDebt release;
    otherwise it shall perform neither global operation.
  priority: must
- id: NFR-NO-NEW-RECOVERY-SURFACE
  statement: The system shall add no durable deferred/pending/journal state, provider
    API, conflict strategy, workflow engine, rollback mode, or cross-invocation artifact
    deduplication claim.
  priority: must
- id: NFR-UNIQUE-OWNERS
  statement: Planning, normalization/admission, read-only preparation, conflict output,
    effects and terminal proof, per-file CAS, and global finalization shall each have
    one named owner.
  priority: must
---

<!-- lifecycle is owned by change.md -->

# Requirements

## Intended outcome

Fresh rename reconciliation preserves identity and every observed remote byte version without
allowing ambiguous evidence to authorize destructive I/O. Stable checksum-less backends make
bounded progress, partial effects return to ordinary fresh classification, and persistence remains
commit-last.

## Observable requirements

- `REQ-IMMUTABLE-CYCLE-EVIDENCE` — The system shall derive a local rename candidate once during
  planning and shall prevent downstream mutation of every nested authority-bearing collection.
- `REQ-LEGAL-NORMALIZED-STATE` — The system shall represent each permitted fresh state with one
  legal variant and shall represent missing/contradictory evidence as explicit zero-action variants.
- `REQ-TOTAL-ADMISSION-DECISION` — When Admission receives a legal variant, it shall emit exactly
  one disposition and one exact debt persist/release membership result without filesystem I/O.
- `REQ-BOUNDED-VERSION-SNAPSHOT` — If checksum/mtime cannot prove stability, the system shall use
  bounded stat/read snapshots; stable bytes proceed, unreadable input fails, and changing input is
  blocked during that invocation.
- `REQ-PRESERVE-ALL-REMOTE-VERSIONS` — When tracked R is at a third path and foreign Y occupies the
  destination, both exact versions shall have locally and remotely visible, readback-verified
  conflict outputs before deletion, rename, or overwrite.
- `REQ-RESOLVER-ONCE` — The configured existing resolver shall run once, apply `auto_merge |
  duplicate` to primary R, preserve additional Y without merging it, and own all naming/writes.
- `REQ-EXECUTOR-TERMINAL-PROOF` — If any resolver/effect/proof cut fails, the system shall not commit
  a record/checkpoint, retry raw mutations, or roll back; the next invocation shall classify fresh.
- `REQ-PER-FILE-CAS` — The state committer shall accept only executor-branded proof of source
  absence, target R identity, intended bytes, and completed preservation obligations.
- `REQ-CLEAN-FINALIZATION` — While every component is terminal-successful, checkpoint shall commit
  before exact debt release; otherwise neither global operation shall occur.

## Failure modes

| Failure | Observable outcome | Recovery |
|---|---|---|
| evidence missing | `evidence_unknown`, zero action | next ordinary sync reacquires evidence |
| evidence contradictory | `evidence_contradicted`, zero action | next ordinary sync reacquires evidence |
| read/write/stat transport failure | action `failed`, no global commit | existing error reporting; later fresh sync |
| authentication/authorization failure | action `blocked`, existing auth signal, no global commit | operator restores access; later fresh sync |
| re-read or terminal proof mismatch | action `blocked`, no retry/rollback/commit | later fresh sync observes the external winner |
| branded internal invariant violation | fail fast | implementation defect; never masked as external failure |

## Multi-remote user-visible policy

Primary is always tracked identity R. In `R@third + Y@new`, Y is one additional foreign version.
The existing allocator creates primary then additional `.conflict[-N]` paths, and the resolver
writes/verifies each on local and remote. `duplicate` reuses the primary preservation path as its
ordinary duplicate; `auto_merge` retains it as an exact backup. A later fresh retry can create new
numbered files because no cross-invocation deduplication promise exists.

## Acceptance criteria

- `AC-CYCLE-01` through `AC-ADMISSION-03`: one immutable candidate/evidence value, only legal union
  values, exhaustive total decision, and one debt membership derivation.
- `AC-SNAPSHOT-04`: at most two byte reads per metadata-insufficient source, with stable/failed/blocked
  terminal outcomes.
- `AC-PRESERVE-05` and `AC-RESOLVER-06`: exact R and Y outputs are visible and verified before
  destructive effects; resolver call count is one and retry-numbering is explicit.
- `AC-FAILURE-07` through `AC-CAS-09`: the failure union is discriminated, partial cuts reclassify
  fresh, and only branded proof reaches CAS.
- `AC-FINALIZE-10` and `AC-BOUNDARY-11`: checkpoint precedes exact release on clean cycles and no
  prohibited durable/provider/workflow surface appears.

## Non-goals

No folder/rename-chain extension, new conflict strategy, exact-once conflict artifact ownership,
external-writer linearizability, provider conditional mutation, migration, or durable recovery state.
