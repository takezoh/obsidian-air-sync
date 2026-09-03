---
change: change-20260903-mixed-scope-folder-rename
role: requirements
---

<!-- lifecycle is owned by change.md -->

# Requirements

## Functional requirements

- **FR-1:** When a reported folder rename contains both included and policy-excluded
  descendants, the system shall converge each included descendant for which matching
  child rename evidence exists.
- **FR-2:** The system shall not move, delete, upload, or download a policy-excluded
  descendant as a consequence of the folder rename, regardless of which existing
  `isExcluded()` rule produced `policy_out`.
- **FR-3:** The system shall fail Admission without executable actions when any
  included descendant lacks matching child evidence or any descendant scope is
  unknown/mobile-deferred.
- **FR-4:** The behavior shall be symmetric for local-origin and remote-origin folder
  renames.
- **FR-5:** When a case-insensitive local filesystem reports the destination as an
  alias of the old spelling during COLD replay, Admission shall reconstruct a pure
  child `rename_remote` only if the baseline is complete, the remote source is
  unchanged, and the remote destination is authoritatively absent.

## Acceptance scenarios

- Given `Templates/a.md -> TemplateS/a.md` and any policy-excluded descendant, when
  Admission evaluates the local folder event, then it authorizes only
  `rename_remote(Templates/a.md, TemplateS/a.md)`.
- Given the symmetric remote evidence, then Admission authorizes only the child
  `rename_local`.
- Given an additional included descendant without child evidence, or an unknown
  descendant, then Admission authorizes nothing and reports
  `incomplete_folder_mapping`.
- Given a replayed case-only rename whose destination resolves as a local alias, then
  Admission reconstructs the child rename from the unchanged baseline; changed or
  incomplete evidence remains failed.
