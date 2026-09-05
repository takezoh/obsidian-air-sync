---
change: change-20260904-case-alias-parent-transition
role: verification
---

<!-- lifecycle is owned by change.md -->

# Verification

## Content

### Unit 0 fresh evidence and regression lock

| Check | Tier | Pass criterion |
|---|---|---|
| Current dev-evidence dependency/change-surface preflight | T0 | The declared Admission caller, owner, producer, consumer, and test files are current; unknown, stale, conflicting, or expanded ownership stops before production edits. |
| `npm test -- --run src/sync/plan-admission.test.ts` before repair | T0 | The target-record recurrence is RED only after normalized content plus complete parent rename is shaped, and the new terminal-owner fixture exposes the current early authorization path. |

The terminal-owner fixture is discriminating only when all of these are asserted together: `normalizeLocalMove` has a determinate candidate; a second opaque identity key occupies the same remote-current slot; the final result has exactly one disposition; that disposition is `failed` with existing reason `conflicting_identity`; and the executable action list is empty. Any authorized/resolved result, second disposition, or action fails.

### Exact coverage and complexity

| Check | Required observations |
|---|---|
| Exact positive pair | The same opaque identity has exactly one current occurrence and one committed baseline occurrence; the complete validated parent descendants contain exactly `current -> baseline`. |
| Intended-only control | Preserve the action destination but remove or replace that identity's baseline occurrence; expect `identity_postcondition_unproven` and no action. |
| Negative matrix | Unrelated, absent, incomplete, crossed, duplicate, reversed, covered-plus-uncovered, unresolved, and conflicting edges retain their existing applicable reasons and no partial action. |
| Structural complexity review plus `npm run lint` | One coverage relation is derived once and reused by alias/stable checks in `O(A + D + E + S)` time and `O(D)` auxiliary space; repeated per-edge rescans and a second relation are absent. |

The private Set-versus-Map choice does not alter these checks. There is no provider I/O or persisted state in coverage derivation.

### Admission, convergence, and execution compatibility

| Command | Required observations |
|---|---|
| `npm test -- --run src/sync/plan-admission.test.ts` | Exactly one final evaluator-owned disposition per component; exact current-to-unique-baseline coverage; intended-only rejection; pre-evaluator conflict rejection; negative/native/single-file/delete compatibility. |
| `npm test -- --run src/sync/orchestrator.test.ts` | Equal complete COLD/WARM/HOT facts produce equal actions, dispositions, and reasons; target-record retry is ordinary current-fact Admission with no prior-error input. |
| `npm test -- --run src/sync/plan-executor.test.ts` | Transfer and serial-conflict terminal events precede the structural parent rename; no undeclared ancestor effect or late re-admission occurs. |
| `npm test -- --run src/sync/state-committer.test.ts src/sync/sync-cycle-finalization.test.ts src/sync/orchestrator.test.ts` | Successful per-file records remain post-I/O; cursor/cache/scope publish only after all actions succeed; incomplete/exceptional attempts use the existing abort boundary. |

### Adversarial matrix

| Counterexample | Must observe | Must not observe |
|---|---|---|
| Determinate local-move candidate plus second current-slot identity key | One failed `conflicting_identity` disposition, no action | Pre-evaluator authorization or settlement |
| Intended target without same-identity baseline occurrence | `identity_postcondition_unproven`, no action | Destination substituted for baseline evidence |
| Covered edge plus uncovered sibling | Whole component failed with existing reason | Partial executable subset |
| Incomplete/crossed/duplicate/reversed mapping | Existing mapping/postcondition failure | Prefix or heuristic coverage |
| Child content failure | Non-clean result and no cursor/cache publication | Structural success treated as clean |
| Parent rename failure after content success | Successful per-file records may remain; live view aborts | Cursor advancement, recovery marker, or compensation state |
| Identical facts under COLD/WARM/HOT | Identical admitted plan or identical fail-closed result | Acquisition-mode-specific decision/status |
| Added marker/action/status/state owner | Ownership guard failure | New recovery authority accepted as implementation detail |

### Ownership and full gate

Run the real repository-root guard:

```bash
npm test -- --run sync-state-ownership-guard.test.mjs
```

It must reject any new durable writer, persistent Admission evidence, correctness-critical orchestrator field, recovery status, or additional state owner.

Then run the mandatory repository gate:

```bash
npm run lint && npm run lint:bot-repro && npm run build && npm run test:coverage
```

All commands must pass before push. No live-provider E2E is required because provider behavior is unchanged. Documentation verification must also confirm that the active four-stage design records candidate-only normalization plus one final evaluator, that stale deferred/debt wording is explicitly subordinate to the accepted stateless ADR, and that no new ADR was created.
