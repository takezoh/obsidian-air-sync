---
change: change-20260903-scheduler-scope-boundary
role: requirements
---

<!-- lifecycle is owned by change.md -->

# Requirements

## Content

- When both file rename endpoints are included, the scheduler shall retain the
  rename pair.
- When exactly one file rename endpoint is included, the scheduler shall mark only
  that endpoint dirty and shall not retain a rename pair.
- When both endpoints are excluded, the scheduler shall record and trigger nothing.
- When a folder rename root crosses scope, the scheduler shall not retain the folder
  edge and shall recursively retain only included child-file effects.
- No durable state or new intermediate status shall be introduced.
