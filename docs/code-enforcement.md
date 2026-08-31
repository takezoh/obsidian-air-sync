# Code & architecture enforcement

The mechanisms that keep the codebase true to its intended architecture. Most are
rejected mechanically at **lint, compile, or test time** rather than relying on
review. For each: what it prevents, where it is defined, how it is enforced, and how
to declare an exception.

The design principles themselves are owned by [ARCHITECTURE.md](../ARCHITECTURE.md);
this document covers their *enforcement*. The local code gate is:

```bash
npm run lint && npm run lint:bot-repro && npm run build && npm test
```

CI (`.github/workflows/lint.yml`) runs `npm run build`, `npm run lint`,
`npm run lint:bot-repro`, and `npm run test:coverage` on Node 20 and 22 for every push
and PR.

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
| **Where** | `PURE_TRANSFORMS` list in `eslint.config.mts` (`decision-engine`, `change-compare`, `merge`, PlanAdmission + its component graph/decision/lifecycle helpers, and the private local/remote shaping helpers) |
| **How** | `no-restricted-imports` + `no-restricted-syntax` (error), scoped to those files |
| **Exception** | Pass timestamps/variation in as data. To add a new pure transform, list its file in `PURE_TRANSFORMS` |

The identity-component implementation has a second structural guard:
`ADMISSION_INTERNAL_IMPORTS` prevents any other production sync module from importing
the component graph, decision, lifecycle, shaping helpers, or a revived
`rename-optimizer` stage. Only `plan-admission.ts` and its private helper modules may
use those imports; the rest of production consumes the public Admission result or
`AuthorizedSyncPlan`. This keeps path-local proposal and identity-component authority
from becoming two whole-plan policy owners again.

### Producer-qualified mock path evidence

Sync tests must not choose path authority independently from the filesystem role.
The canonical role factories keep mutation-backed local observations resolved and
remote observations as request echoes until a test explicitly models provider confirmation.

| | |
|---|---|
| **Prevents** | `src/sync/**/*.test.ts` importing the raw authority-parameterized `createMockFs`, which could give remote mutations invented `actual_resolved` evidence |
| **Where** | `RAW_SYNC_MOCK_FS_IMPORT` in `eslint.config.mts` |
| **How** | `no-restricted-imports` (error), scoped to sync tests |
| **Exception** | Raw construction is reserved for dedicated mock contract tests under `src/__mocks__/`; sync tests use `createMockLocalFs()` or `createMockRemoteFs()` |

## 6. Single responsibility per module (Principle #7)

Each file owns one concept. The `max-lines` cap is a **prompt to consider a
responsibility split — not a line-count target to minimize against.** When a file
trips it, the question is "does a concept want to move to its own module?", not
"how do I shave lines off this one?".

| | |
|---|---|
| **Prevents** | a module growing past ~300 code lines (comments/blanks excluded) *silently*, without anyone asking whether it should split |
| **Where** | `max-lines` in `eslint.config.mts` |
| **How** | `max-lines` (error) on `src/**/*.ts`; tests, mocks, and `test-helpers.ts` are exempt |
| **Exception** | If a clean responsibility split is natural, split. If it is not — the lines are one cohesive concern, or the split is its own task — **raise this file's threshold** with a `files`-scoped override and a justifying comment. Do **not** force the count down with churn |

**Reducing the number is never the goal; keeping each module honestly sized is.**
So do not inline single-use locals, merge imports, or otherwise contort code purely
to fit under the cap — that trades readability for a number, which is exactly what
the rule is *not* asking for. When a cohesive change pushes a file over and a clean
split isn't natural (or is its own task), add or raise a per-file override pinned at
the new size, with a comment saying why the split was deferred. The pin is a
ratchet: it stops *silent* growth and flags the file as split-when-convenient — it
is not a mandate to shrink the file by force.

Four modules currently carry such overrides as known debt: `fs/googledrive/auth.ts`
(337), `sync/orchestrator.ts` (408), `fs/caching/remote-fs.ts` (326), and
`fs/backend-manager.ts` (341). Ratchet them down
when a natural responsibility split presents itself.
(`fs/googledrive/index.ts` was here at 397; ADR 0001 lifted its cache/checkpoint
machinery into `fs/caching/`, dropping it back under 300, so it is no longer
overridden.)

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

## 9. Offline community-bot unsafe-warning diagnostic

`npm run lint:bot-repro` distinguishes a source type-safety defect from the mass
`@typescript-eslint/no-unsafe-*` cascade caused when external declaration boundaries
are unavailable. It is a deterministic CI contract, not a replacement for
`npm run lint`.

This command exists because there are two different lint environments:

- `npm run lint` runs after `npm ci`, so TypeScript can read declarations from
  `node_modules`.
- The Obsidian community Dashboard may scan submitted source without those
  declarations. An unresolved import then becomes TypeScript's `error` type and can
  generate hundreds of secondary unsafe-call/assignment/member/argument/return
  findings in otherwise typed application code.

The Dashboard result for the exact submitted commit remains authoritative. The local
reproduction prevents the known dependency-resolution mismatch from returning; it
does not substitute a previous release's score or claim that an unscanned commit has
already passed the remote service.

| | |
|---|---|
| **Prevents** | Shipping hundreds of `error`/`any` diagnostics when the community scanner does not install dependency declarations; weakening the five unsafe rules while normal lint happens to stay green |
| **Where** | `package-lock.json`, `tsconfig.json`, `lint-bot-repro.mjs`, its pure classifier and `node:test` contract, and `test-fixtures/lint-bot-repro/untyped-dependencies.d.ts` |
| **How** | Lints production source twice with identical source and ESLint configuration: once through clean-install declarations and once with the five direct dependency paths replaced by an untyped declaration. Both candidates must exit 0 with zero findings from all five unsafe rule families. |
| **Exception** | None. Do not cast, disable rules, or update the contract to hide a source or declaration failure. |

Do not copy dependency declarations into the repository. The community scanner lints
committed `.d.ts` files as source, so vendoring official declarations merely replaces
resolution warnings with warnings inside third-party code. Dependency versions and
their declaration files are owned by `package-lock.json` and restored with `npm ci`.

The injected process models the community scanner's dependency-less source pass. The
wrapper exits **0** only after its negative classifier tests pass, both candidates exit
0 with zero unsafe findings, TypeScript proves that all five injected imports resolve
to the untyped fixture, and the effective configs match. A lint exit of 1, a tool exit
of 2, or no exit status is a failure.

This path never runs `npm install`, `npx`, a download, or a network request. It uses
only `node_modules/.bin/eslint` and the ESLint API already installed from the lockfile,
copies `src` into disposable workspaces (never symlinks it), and removes those
workspaces on success and failure. If it reports that project-local ESLint is missing,
restore dependencies with the normal project setup (`npm ci`) outside the repro, then
run the command again; the repro deliberately has no download fallback.

The same command runs an esbuild metafile probe for fflate, ignore, js-md5, and
node-diff3. It fails if the bundle no longer contains each package's JavaScript
implementation.

Production modules reach those five packages only through `src/platform/`. Each
boundary receives an unresolved runtime import as `unknown`, validates the small shape
the plugin uses, and exposes first-party types to the rest of `src`. This keeps the
runtime bundle unchanged while preventing a missing third-party declaration from
poisoning application types. If either candidate reports unsafe findings, the fix is
incomplete. If the wrapper reports config, resolution, spawn, JSON, or exit-status
failure, fix the runner/toolchain path before drawing a conclusion.

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
