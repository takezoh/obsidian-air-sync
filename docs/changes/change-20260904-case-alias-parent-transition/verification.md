---
change: change-20260904-case-alias-parent-transition
role: verification
---

<!-- lifecycle is owned by change.md -->

# Verification

## Content

### Unit 0 production-change gate

| Check | Tier | Pass criterion |
|---|---|---|
| `npm test -- --run src/sync/orchestrator.test.ts src/sync/plan-admission.test.ts` | T1 | Real COLD acquisition exposes the complete parent/descendant component and exact child content/topology subtypes; a remote-only delta cannot disappear behind a clean result. |
| `npm test -- --run src/fs/googledrive/index.test.ts src/fs/onedrive/index.test.ts src/fs/dropbox/index.test.ts` | T1 | Every adapter distinguishes alias lookup (`Templates`, no re-key) from explicit rename (`TemplateS`, re-key). |

If either check cannot establish the required production carrier or paired control, no production change proceeds; return to design. This is not a runtime fallback.

### Provider topology and request bounds

| Command | Required observations |
|---|---|
| `npm test -- --run src/fs/googledrive/index.test.ts src/fs/googledrive/metadata-cache.test.ts` | Provider-resolved target, explicit-rename-only re-key, zero/one/multiple uniqueness, cache hit, first unresolved path, repeated siblings. |
| `npm test -- --run src/fs/onedrive/index.test.ts src/fs/onedrive/metadata-cache.test.ts` | Same contract and request counters for OneDrive. |
| `npm test -- --run src/fs/dropbox/index.test.ts src/fs/dropbox/metadata-cache.test.ts` | Same contract and request counters for Dropbox. |
| `npm test -- --run tests/fs/remote-backend-contracts.test.ts` | All three caching implementations remain registered against the common behavior. |

Required request-count assertions: cached parent uses zero provider parent lookups; a first unresolved path uses at most one lookup for each unresolved segment; each mutation uses at most one existing-child lookup; later siblings below the resolved parent add zero parent lookups. Speculative prefetch and a second resolver cache must be absent.

### Admission and execution

| Command | Required observations |
|---|---|
| `npm test -- --run src/sync/plan-admission.test.ts` | Exact admitted content identity set equals the proposed push/pull/conflict identity set; only topology-only descendant renames disappear; exactly one existing parent folder rename appears; incomplete/foreign/recreated cases fail closed. |
| `npm test -- --run src/sync/orchestrator.test.ts` | Equal complete COLD/WARM/HOT facts produce equal decisions; a remote-only child remains executable before cursor publication; ordinary re-entry uses no prior-error input. |
| `npm test -- --run src/sync/plan-executor.test.ts` | Transfer and serial-conflict terminal events precede the structural parent rename; no undeclared ancestor effect or late re-admission occurs. |
| `npm test -- --run src/sync/sync-cycle-finalization.test.ts src/sync/orchestrator.test.ts` | Cursor plus complete cache commit only after every content and structural action succeeds; all incomplete/exceptional attempts use the existing abort boundary. |

### Adversarial matrix

| Counterexample | Must observe | Must not observe |
|---|---|---|
| Remote-only child plus parent case transition | Pull/content action, parent rename, cursor in that order | Parent-only clean checkpoint or lost delta |
| Alias request returns provider `Templates` | Existing child identity targeted; cache remains `Templates` | Requested-echo re-key or duplicate create |
| Explicit rename returns provider `TemplateS` | Same folder identity and descendants re-key | Re-key before provider response |
| Multiple same-name Google results | Ambiguous failure with one cardinality-capable lookup | `pageSize=1` accepted as uniqueness or create fallback |
| Foreign/recreated destination identity | Fail-closed Admission or mutation precondition failure | Implicit merge, overwrite, or parent transition |
| Child content failure | Non-clean result and no cursor/cache publication | Structural success treated as clean |
| Parent rename failure after content success | Successful per-file records may remain; live view aborts | Cursor advancement, recovery marker, or compensation state |
| Identical facts under COLD/WARM/HOT | Identical admitted plan or identical fail-closed result | Acquisition-mode-specific decision/status |

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

All commands must pass before push. With existing credentials, `npm run test:e2e` is optional T2 evidence across Google Drive, Dropbox, and OneDrive; live provider differences may only cause fail-closed adaptation, never promotion of requested echo to topology authority.
