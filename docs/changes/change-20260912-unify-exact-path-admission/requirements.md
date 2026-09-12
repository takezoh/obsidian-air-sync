---
change: change-20260912-unify-exact-path-admission
role: requirements
---

<!-- lifecycle is owned by change.md -->

# Requirements

## Requirements

- **FR-EPA-001:** Admission shall construct every non-relational same-address file
  decision and every relation-abandonment fallback through one private,
  outcome-discriminated exact-path capability.
- **FR-EPA-002:** That constructor shall derive current endpoints, the exact-key
  committed record, comparison baseline, and identical source/destination publication
  expectation.
- **FR-EPA-003:** The preservation capability shall omit a record only from a
  one-sided content comparison, producing push/pull while retaining publication CAS;
  it shall not emit delete, cleanup, or a synthetic conflict.
- **FR-EPA-004:** The deletion-propagation capability shall retain existing genuine
  deletion and conflict behavior, including the remote `checkpoint_deleted` witness
  for `delete_local`.

## Acceptance

- Two-sided exact paths keep their committed comparison baseline in ordinary and
  relation-abandonment routes.
- One-sided abandoned paths with a record push/pull and retain the exact publication
  expectation.
- Unknown or unresolved current facts fail Admission.
- After an incomplete cycle, a newly created local file is pushed without a synthetic
  conflict copy and the following cycle reaches a fixed point.
