# Air Sync — Obsidian Plugin

An Obsidian community plugin for bidirectional sync between vaults and cloud storage.

## Commands

```bash
npm install        # Install dependencies
npm run dev        # Development (watch)
npm run build      # Production build (tsc -noEmit && esbuild)
npm test           # vitest
npm run test:watch # vitest watch
npm run lint       # eslint ./src/
```

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for details.

## Coding conventions

- TypeScript strict mode
- `main.ts` handles lifecycle only; delegate logic to separate modules
- Split files at ~200-300 lines
- Register listeners via `this.register*` (prevent leaks)
- The in-memory vault index can under-report before layout-ready: read it only via `LocalFs.list()` (lint-enforced — `getAllLoadedFiles()` is restricted outside `src/fs/local/`), and never derive a deletion from listing-absence alone — confirm against the authoritative `LocalFs.stat()` (falls back to the adapter)
- Dot-prefixed/hidden paths (`.airsync`, `.obsidian`, nested `foo/.bar`) are excluded from the vault index: `vault.createBinary()` returns `null` or throws `File already exists` for them. `LocalFs` routes any `isDotPrefixed()` path through the raw adapter (`DotPathAdapter`) — this is mechanism, not policy. Whether a hidden path *syncs* is separate policy (`syncDotPaths` + `ignorePatterns`, both must pass), enforced in `SyncOrchestrator.isExcluded()`
- Prefer `async/await`
- Mobile compatible (`isDesktopOnly: false`) — no Node/Electron APIs
- Minimize network calls; require explicit disclosure
- Command IDs are immutable once published
- No migration code — on IndexedDB schema changes, cold-start (drop all stores and recreate). Settings schema changes should use sensible defaults for missing fields via `Object.assign({}, DEFAULT_SETTINGS, stored)`

## Type safety & lint rules

Always pass `npm run lint && npm run build && npm test` after making changes.

### No `any`
- Never use `as any`. Use `as unknown as TargetType` when a cast is unavoidable
- Never use `any` in type definitions. Use `unknown` instead (e.g. `(...args: unknown[]) => void`)
- Never disable `@typescript-eslint/no-explicit-any` — the obsidianmd plugin forbids it
- Type external API responses (`response.json`, etc.) as `const x: unknown = ...` and narrow with a runtime validator (assert function)
- Annotate `JSON.parse()` return values explicitly (`as { key: Type }`)

### Type-safe mocks in tests
- Do not cast `vi.spyOn` targets with `as any`. Use typed helpers instead
  - `spyRequestUrl()` — type-safe spy on obsidian's `requestUrl`
  - `mockSettings()` — returns a complete `AirSyncSettings` default
- Access private fields via `as unknown as { field: Type }` pattern
- Pass `createMockStateStore()` directly (its intersection type satisfies `SyncStateStore`)

### No `async` without `await`
- Enforced by `@typescript-eslint/require-await` (error). Never write `async` functions or arrow functions that contain no `await` expression — fix the code, do not disable the lint rule
- Mock functions that only throw: use `() => { throw err; }` (synchronous, no `async`)
- Mock functions with mixed throw/return: ensure at least one `await` (e.g. `return await Promise.resolve(...)`)
- Mock functions that return a value synchronously but must return a Promise: use `() => Promise.resolve(value)` (no `async`)
- Assigning a mock function to a property: same rules apply (e.g. `obj.fn = () => Promise.resolve(value)`, not `async () => value`)

### obsidianmd ESLint plugin
- `eslint-plugin-obsidianmd` is installed and included in `eslint.config.mts` (`obsidianmd.configs.recommended`)
- The community plugin submission bot runs the same plugin to validate PRs — always run `npm run lint` before pushing
- Never hardcode `.obsidian` — use `Vault#configDir`. In tests, assign to a variable and add `// eslint-disable-line obsidianmd/hardcoded-config-path`
- UI text (`.setName()` / `.setDesc()`) must use sentence case. Avoid all-caps abbreviations (e.g. `PDFs`, `MB`)
- `eslint-disable` directives must include a description explaining why (e.g. `// eslint-disable-next-line rule-name -- reason here`)
- Do not disable rules that the obsidianmd plugin disallows (`obsidianmd/no-tfile-tfolder-cast`, `obsidianmd/ui/sentence-case`, `@typescript-eslint/no-explicit-any`, etc.) — fix the code instead
- Do not write unnecessary type assertions. If `.buffer` is already `ArrayBuffer`, do not cast `as ArrayBuffer`

### Design-principle guards (lint-enforced)

Several ARCHITECTURE.md design principles are enforced as lint rules in `eslint.config.mts` (each error message names its principle). Fix the code rather than disabling these:

- **Principle #2 (swappable backends)** — `sync/`, `main.ts`, `store/`, `queue/`, `utils/` must not import backend-specific modules (`**/fs/googledrive/**`). Wire backends only through `fs/registry.ts`; `ui/` may render backend-specific settings.
- **Principle #4 (pipeline as data)** — the pure transform stages (`decision-engine`, `change-compare`, `merge`, `rename-optimizer`, `optimize-local-renames`, `optimize-remote-renames`) must not import `fs/interface` (IFileSystem) or call `Date.now()` / `Math.random()`. Keep them deterministic `data → data` functions; pass timestamps in as data. To add a new pure transform, list it in `PURE_TRANSFORMS` in `eslint.config.mts`.
- **Principle #7 (single responsibility per module)** — `max-lines` caps production modules at 300 code lines (comments/blanks excluded). Three modules are grandfathered at their current size in `eslint.config.mts` and pinned so they cannot grow — split them to ratchet down; do not raise a cap. Tests/mocks are exempt.
- **Mobile compatibility** — no Node/Electron API imports (`fs`, `path`, `os`, `child_process`, `crypto`, `electron`, `node:*`) anywhere in `src/`.
- **Vault index** — read it via `LocalFs.list()`; `getAllLoadedFiles()` is allowed only in `src/fs/local/` (see Coding conventions above).
- **Coverage floors** — `vitest.config.ts` sets ratchet thresholds enforced by CI (`npm run test:coverage`). Raise them as coverage improves; never lower them to make CI pass.

Principles that can't be expressed as a static rule are pinned by tests instead — keep these green when touching the pipeline:

- **#3 delta-first** — `sync/delta-first.test.ts`: the hot path stats only dirty paths and never calls `list()` (full scans are cold-start only).
- **#5 crash-safe** — `sync/crash-safety.test.ts` (interrupted action commits no baseline, re-syncs to convergence) and `sync/convergence.test.ts` (fixed point).
- **Command-ID immutability** — `main-commands.test.ts` snapshots the registered command IDs; update it only for a genuinely new command, never to rename a shipped ID.

## Build artifacts

`main.js`, `manifest.json`, `styles.css` → placed in vault's `.obsidian/plugins/obsidian-air-sync/`. Never commit `node_modules/` or `main.js`.

## Releases

Update `version` in `manifest.json` (SemVer, no `v` prefix) and `versions.json`. GitHub release tag must match the version exactly.
