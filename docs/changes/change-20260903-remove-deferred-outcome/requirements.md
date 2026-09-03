---
change: change-20260903-remove-deferred-outcome
role: requirements
---

<!-- lifecycle is owned by change.md -->

# Requirements

## Content

- `REQ-REMOVE-DEFERRED` — Production sync contracts shall expose no `deferred`
  disposition, result collection, status count, or user-facing retryability claim.
- `REQ-FAIL-CLOSED` — A component that Admission cannot authorize shall execute no
  action, shall make the cycle non-clean, and shall retain safety evidence needed for
  later fresh observation.
- `REQ-BOUNDARY` — `ExecutionResult` shall describe executor outcomes only. Admission
  failures belong to the sync-cycle outcome owned by orchestration.
- `REQ-OBSERVABILITY` — Admission failures shall contribute to the existing error count
  and `partial_error` status without implying that repeated observation must converge.
- `REQ-NO-NEW-STATE` — No pending state, journal, retry scheduler, provider capability,
  schema migration, or replay authority shall be introduced.
