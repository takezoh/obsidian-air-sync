---
change: change-20260903-remove-deferred-outcome
role: implementation
---

<!-- lifecycle is owned by change.md -->

# Implementation

## Content

1. Replace the Admission partition with `authorized | resolved_no_action | failed` and
   one `AdmissionFailure` union covering ordinary safety rejection and fresh evidence
   unknown/contradiction.
2. Remove Admission data from `ExecutionResult`; introduce a cycle-level outcome that
   pairs executor results with Admission failures.
3. Make finalization derive checkpoint safety from Admission dispositions and mechanical
   execution completion. Make orchestration request COLD re-observation after an
   Admission failure without scheduling a tight retry.
4. Aggregate action failures and Admission failures as ordinary errors in status,
   logging, and notification. Remove `retryableErrors`, `evidenceIssues`, and deferred
   presentation.
5. Update focused tests and active sync documentation. Historical done change packages
   and ADR history remain untouched.
