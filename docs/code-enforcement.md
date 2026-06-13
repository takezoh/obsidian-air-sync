# Code & architecture enforcement

The mechanisms that keep the codebase true to its intended architecture. Most are
rejected mechanically at **lint, compile, or test time** rather than relying on
review. For each: what it prevents, where it is defined, how it is enforced, and how
to declare an exception.

The design principles themselves are owned by [ARCHITECTURE.md](../ARCHITECTURE.md);
this document covers their *enforcement*. The full gate is:

```bash
npm run lint && npm run build && npm test
```

CI (`.github/workflows/lint.yml`) runs `npm run build`, `npm run lint`, and
`npm run test:coverage` on Node 20 and 22 for every push and PR.

## 1. Type safety — no `any`

Casting away types defeats `strict` mode and is forbidden by the obsidianmd ruleset.

| | |
|---|---|
| **Prevents** | `as any`, `any` in type definitions, unnecessary assertions |
| **Where** | `obsidianmd.configs.recommended` + `typescript-eslint` (`eslint.config.mts`) |
| **How** | `@typescript-eslint/no-explicit-any` (error); `tsc -noEmit` in `npm run build` |
| **Exception** | None. Use `unknown` and narrow; `as unknown as T` only when a cast is truly unavoidable |

Practical patterns:

- Type external API responses (`response.json`, etc.) as `const x: unknown = …` and
  narrow with a runtime validator (assert function).
- Annotate `JSON.parse()` return values explicitly (`as { key: Type }`).
- Access private fields in tests via the `as unknown as { field: Type }` pattern.
- Do not write unnecessary assertions — if `.buffer` is already `ArrayBuffer`, don't
  cast `as ArrayBuffer`.

### Type-safe test doubles

`as any` is forbidden in tests too — use the project's typed helpers instead of casting
`vi.spyOn` targets or hand-rolling partial objects:

- `spyRequestUrl()` (`src/fs/googledrive/test-helpers.ts`) — type-safe spy on obsidian's `requestUrl`.
- `mockSettings()` (`src/__mocks__/sync-test-helpers.ts`) — returns a complete `AirSyncSettings` default.
- `createMockStateStore()` (`src/__mocks__/sync-test-helpers.ts`) — pass it directly; its intersection type satisfies `SyncStateStore`.

## 2. No `async` without `await`

An `async` function with no `await` is almost always a mistake (a forgotten `await`,
or needless Promise wrapping).

| | |
|---|---|
| **Prevents** | `async` functions/arrows containing no `await` |
| **Where** | `eslint.config.mts` (project-wide guards block) |
| **How** | `@typescript-eslint/require-await` (error) |
| **Exception** | None — fix the code, don't disable the rule |

Test-mock patterns that satisfy it:

- Throw only: `() => { throw err; }` (synchronous, no `async`).
- Return a value as a Promise: `() => Promise.resolve(value)` (no `async`).
- Mixed throw/return: ensure at least one `await` (e.g. `return await Promise.resolve(…)`).
- Assigning to a property follows the same rules (`obj.fn = () => Promise.resolve(v)`).

## 3. Mobile compatibility — no Node/Electron APIs

The plugin ships with `isDesktopOnly: false`, so it must run on mobile, where
Node/Electron APIs do not exist.

| | |
|---|---|
| **Prevents** | importing `fs`, `path`, `os`, `child_process`, `crypto`, `util`, `stream`, `electron` (and `node:` forms); importing `axios` (not bundled) |
| **Where** | `NODE_API_IMPORTS` / `AXIOS_IMPORT` in `eslint.config.mts` |
| **How** | `no-restricted-imports` (error) across `src/**/*.ts` |
| **Exception** | None. Use the Obsidian Vault API, browser globals, or `requestUrl()` for network |

## 4. Swappable backends (Principle #2)

The backend-agnostic core must not depend on a specific backend, so adding a backend
requires no changes outside `fs/`.

| | |
|---|---|
| **Prevents** | `sync/`, `main.ts`, `store/`, `queue/`, `utils/` importing backend-specific modules (e.g. `**/googledrive/**`) |
| **Where** | `BACKEND_SPECIFIC_IMPORTS` in `eslint.config.mts` |
| **How** | `no-restricted-imports` (error), scoped to those directories |
| **Exception** | Wire backends only through `fs/registry.ts`. `ui/` may render backend-specific settings |

## 5. Pipeline as data (Principle #4)

The pure transform stages of the sync pipeline are deterministic `data → data`
functions — no I/O, no clock, no randomness — so every intermediate state is testable.

| | |
|---|---|
| **Prevents** | the pure transforms importing `fs/interface` (IFileSystem), or calling `Date.now()` / `Math.random()` |
| **Where** | `PURE_TRANSFORMS` list in `eslint.config.mts` (`decision-engine`, `change-compare`, `merge`, `rename-optimizer`, `optimize-local-renames`, `optimize-remote-renames`) |
| **How** | `no-restricted-imports` + `no-restricted-syntax` (error), scoped to those files |
| **Exception** | Pass timestamps/variation in as data. To add a new pure transform, list its file in `PURE_TRANSFORMS` |

## 6. Single responsibility per module (Principle #7)

Each file owns one concept; oversized files signal a missing split.

| | |
|---|---|
| **Prevents** | production modules over 300 code lines (comments/blanks excluded) |
| **Where** | `max-lines` in `eslint.config.mts` |
| **How** | `max-lines` (error) on `src/**/*.ts`; tests, mocks, and `test-helpers.ts` are exempt |
| **Exception** | Split the module. Do **not** raise the cap |

Two modules are grandfathered above the cap as known debt, each **pinned at its
current size** so it cannot grow: `fs/googledrive/auth.ts` (337) and
`sync/orchestrator.ts` (332). Ratchet these down by splitting; never raise them.
(`fs/googledrive/index.ts` was grandfathered here at 397; ADR 0001 lifted its
cache/checkpoint machinery into `fs/caching/`, dropping it back under the 300 cap,
so it is no longer grandfathered.)

## 7. Vault-index read centralization

The in-memory vault index can under-report before layout-ready, so reads go through a
single gated entry point in `LocalFs`.

| | |
|---|---|
| **Prevents** | calling `getAllLoadedFiles()` outside `src/fs/local/` |
| **Where** | `NO_GET_ALL_LOADED_FILES` in `eslint.config.mts` |
| **How** | `no-restricted-syntax` (error); allowed only in `src/fs/local/**` and `src/__mocks__/**` |
| **Exception** | Read the index via `LocalFs.list()` |

Companion behavioral rule (not statically enforceable): **never derive a deletion from
listing-absence alone** — confirm against the authoritative `LocalFs.stat()`, which
falls back to the adapter so a not-yet-indexed file on disk is never reported absent.
See the IFileSystem notes in [ARCHITECTURE.md](../ARCHITECTURE.md).

## 8. obsidianmd plugin rules

`eslint-plugin-obsidianmd` (`obsidianmd.configs.recommended`) is the same ruleset the
community submission bot runs against PRs, so `npm run lint` must pass before pushing.
Notable rules:

- **Sentence case** for UI text (`.setName()` / `.setDesc()`); acronyms outside the
  rule's dictionary (e.g. `URI`, `MB`) must be lowercased or rephrased.
- **No hardcoded `.obsidian`** — use `Vault#configDir`.
- **No `TFile`/`TFolder` cast** (`obsidianmd/no-tfile-tfolder-cast`).
- **Restricted globals** (`no-restricted-globals`, error): `fetch` (use `requestUrl()`),
  `localStorage` (use `App#saveLocalStorage` / `loadLocalStorage`), and the global `app`
  (use your plugin's own reference). So "use `requestUrl()`, never `fetch`" is enforced —
  not merely a convention.

Do not disable rules the obsidianmd plugin forbids — fix the code instead. The one
sanctioned escape hatch is the hardcoded-config-path rule in **tests**: assign
`configDir` to a variable and add `// eslint-disable-line obsidianmd/hardcoded-config-path`.
Every `eslint-disable` directive must carry a `-- reason` describing why.

## Test-pinned principles

Principles that can't be expressed as a static rule are pinned by tests instead. Keep
these green when touching the pipeline:

| Principle | Pinned by |
|---|---|
| **#3 delta-first** — the hot path stats only dirty paths and never calls `list()` (full scans are cold-start only) | `sync/delta-first.test.ts` |
| **#5 crash-safe** — an interrupted action commits no baseline and re-syncs to convergence | `sync/crash-safety.test.ts`, `sync/convergence.test.ts` |
| **Command-ID immutability** — registered command IDs are a stable, published API | `main-commands.test.ts` (snapshot — update only for a genuinely new command, never to rename a shipped ID) |
| **Coverage floors** — ratchet thresholds (lines 76 / statements 75 / functions 70 / branches 65) | `vitest.config.ts`, enforced by `npm run test:coverage` in CI. Raise as coverage improves; never lower to make CI pass |

## Declaring an exception

In order of preference:

1. **Restructure the code** so the rule passes — this is almost always the right move.
2. **By path in `eslint.config.mts`** for legitimate, durable carve-outs (e.g. adding a
   file to `PURE_TRANSFORMS`, or the per-file `max-lines` overrides). These are reviewed
   as code.
3. **`// eslint-disable-line <rule> -- <reason>`** for a one-off, with a mandatory
   reason. Never use this for rules the obsidianmd plugin forbids
   (`@typescript-eslint/no-explicit-any`, `obsidianmd/no-tfile-tfolder-cast`,
   `obsidianmd/ui/sentence-case`, …).

## Related

- Canonical design principles: [ARCHITECTURE.md](../ARCHITECTURE.md)
- The rules themselves: [`eslint.config.mts`](../eslint.config.mts)
- Contributor workflow: [CONTRIBUTING.md](../CONTRIBUTING.md)
- Agent operating notes: [CLAUDE.md](../CLAUDE.md)
