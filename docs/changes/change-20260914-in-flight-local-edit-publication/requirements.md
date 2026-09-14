---
change: change-20260914-in-flight-local-edit-publication
role: requirements
---

<!-- lifecycle is owned by change.md -->

# Requirements

## Outcome

An ordinary push publishes the exact local revision it captured and proved at the remote
terminal even when a later local edit arrives during the write. The later edit remains
current work and converges through the next ordinary push without a manufactured conflict.

## Functional requirements

### FR-ILP-001 — Captured push publication

When an ordinary push passes final pre-write validation and the remote terminal proves the
exact captured bytes and admitted identity, the system shall publish that captured revision
even if the local path is later changed, removed, or replaced.

### FR-ILP-002 — Exact publication binding

At all times, push publication shall bind the captured local entity and bytes to the current
proved remote terminal through the existing executor proof and exact record CAS; a newer
current local endpoint shall not be represented as synchronized.

### FR-ILP-003 — Later generation retention

When a local tracker generation advances after the cycle snapshot, clean acknowledgment
shall retain it, and the next ordinary cycle shall admit a push from the published captured
baseline without manufacturing a conflict.

### FR-ILP-004 — Strict negative protocols

At all times, remote corruption, remote identity drift, unproved targets, stale pre-write
inputs, and CAS failure shall remain non-clean, and pull, rename, conflict, preservation,
destination, and descendant proof shall remain strict.

### FR-ILP-005 — Narrow accepted supersession

The accepted decision and active documentation shall supersede the
still-present-changed-local-source rejection only for a post-capture ordinary push with
exact remote proof and shall retain every other prior safety boundary.

## Non-functional requirements

### NFR-ILP-001 — Authority bound

The correction shall use the existing snapshot, executor proof, commit owner, tracker
generation, and checkpoint lifecycle. It shall add no durable or retained correctness
owner, recovery branch, provider capability, exported evidence carrier, or publication
owner.

### NFR-ILP-002 — Cost and compatibility bound

The push shall retain only the existing whole-file snapshot plus bounded proof metadata,
make no additional provider call beyond existing verification, preserve tagged checksum
semantics, and pass the deterministic concurrency and negative-control matrix.

## Acceptance

- Same-size and different-size later edits converge in two ordinary pushes under SHA-256
  and MD5-only remote metadata; the first record and merge base name the captured bytes.
- A captured source without a locally computable key does not trigger a reread of the later
  local revision.
- Remote corruption or replacement, pull mutation, rename/conflict proof failure, CAS
  failure, and incomplete checkpoint controls remain non-clean.
- A real tracker-generation interleaving retains the later edit after clean first-cycle
  acknowledgment and drives the immediate next HOT push.
- No new receipt/export/state owner/provider method/recovery branch appears, and the full
  repository gate passes.
