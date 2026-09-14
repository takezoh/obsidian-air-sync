---
change: change-20260914-in-flight-local-edit-review-convergence
role: requirements
---

<!-- lifecycle is owned by change.md -->

# Requirements

## Requirements

- `FR-RC-001`: Given an edit dirtied again during its push, the clean acknowledgment must
  retain the advanced generation so the immediately queued cycle observes HOT acquisition.
- `FR-RC-002`: After the queued HOT push converges, one further cycle must perform no
  additional remote write or conflict action.
- `FR-RC-003`: The in-flight edit matrix must cover same-size and different-size later
  revisions under both SHA-256 and MD5-only remote checksum metadata.
- `FR-RC-004`: Replacing remote identity after the captured bytes arrive, even with the same
  bytes, must block executor publication, preserve the prior SyncRecord, abort the working
  view, and prevent checkpoint commit.
- `FR-RC-005`: These tests must not require any production or design-contract change.
- `FR-RC-006`: If a pull's remote source changes to same-size different bytes after the
  captured bytes are written locally, terminal proof must block SyncRecord publication.
