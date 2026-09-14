---
change: change-20260914-in-flight-local-edit-review-convergence
role: implementation
---

<!-- lifecycle is owned by change.md -->

# Implementation

## Test changes

- Record `Change detection completed.temperature` across the two-cycle burst and assert
  `hot, hot`; also observe the dirty path at each detection and prove a third cycle performs
  no remote write.
- Complete the reproduction matrix with the SHA-256/same-size case.
- Add executor and orchestrator adversarial identity-replacement tests. The executor owns
  terminal proof and SyncRecord non-publication; the orchestrator owns abort and checkpoint
  non-publication.
- Add an executor pull adversary that preserves endpoint existence and size while replacing
  remote bytes after the local write, directly exercising the non-push terminal branch.

No production file is changed by this follow-up.
