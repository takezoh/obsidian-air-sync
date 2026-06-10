# Air Sync — Obsidian Plugin

An Obsidian community plugin for bidirectional sync between vaults and cloud storage.

This file is the **agent operating guide** for this repo. Where to look:

| You need… | Read |
|---|---|
| What the plugin does, setup, settings (end users) | [README.md](README.md) |
| How to contribute (human developers) | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Design principles, module map, data models, interfaces | [ARCHITECTURE.md](ARCHITECTURE.md) |
| The enforced rules (lint / type / design guards) and how to declare an exception | [docs/code-enforcement.md](docs/code-enforcement.md) |
| Subsystem deep dives (sync pipeline, conflicts, Drive, errors) | [docs/](docs/) |
| Running the opt-in e2e against the real Drive/Dropbox APIs | [docs/e2e-testing.md](docs/e2e-testing.md) |
| Architecture Decision Records (why a design is the way it is — read before "optimizing" it) | [docs/adr/](docs/adr/) |
| Generic Obsidian-plugin conventions (cross-tool baseline) | [AGENTS.md](AGENTS.md) |

## Commands

```bash
npm install        # Install dependencies
npm run dev        # Development (watch)
npm run build      # Production build (tsc -noEmit && esbuild)
npm test           # vitest
npm run test:watch # vitest watch
npm run lint       # eslint --max-warnings 0
npm run test:e2e   # opt-in e2e vs real Drive/Dropbox (creds-gated; NOT in the gate/CI — see docs/e2e-testing.md)
```

## The gate

Always pass `npm run lint && npm run build && npm test` after making changes. The lint
step includes `eslint-plugin-obsidianmd` — the same ruleset the community submission
bot runs — so it must be green before pushing. The full set of enforced rules, the
test-pinned principles, and how to declare an exception live in
[docs/code-enforcement.md](docs/code-enforcement.md). **Fix the code rather than
disabling a rule.**

## Coding conventions

- TypeScript strict mode; prefer `async/await`.
- `main.ts` handles lifecycle only; delegate logic to separate modules; split files at
  ~200-300 lines (capped by lint — see [code-enforcement.md](docs/code-enforcement.md)).
- Register listeners via `this.register*` (prevent leaks).
- Mobile compatible (`isDesktopOnly: false`) — no Node/Electron APIs (lint-enforced).
- Minimize network calls; require explicit disclosure. Use `requestUrl()`, never `fetch`.
- Command IDs are immutable once published.
- No migration code — on IndexedDB schema changes, cold-start (drop all stores and
  recreate). Settings schema changes use sensible defaults for missing fields via
  `Object.assign({}, DEFAULT_SETTINGS, stored)`.

### Project-specific gotchas

- **The vault index can under-report before layout-ready.** Read it only via
  `LocalFs.list()` (lint-enforced — `getAllLoadedFiles()` is restricted outside
  `src/fs/local/`). `LocalFs.list()` does NOT gate on layout-ready itself — it's a
  pure low-level read; the **gate is the orchestrator** (`runSync`/`shouldSync`
  early-return until `isLayoutReady`), and the only path to `list()` runs through it.
  Any new caller of `list()` must likewise be in a layout-ready-gated context. Also
  never derive a deletion from listing-absence alone — confirm against the
  authoritative `LocalFs.stat()` (falls back to the adapter).
- **Dot-prefixed/hidden paths** (`.airsync`, `.obsidian`, nested `foo/.bar`) are
  excluded from the vault index: `vault.createBinary()` returns `null` or throws
  `File already exists` for them. `LocalFs` routes any `isDotPrefixed()` path through
  the raw adapter (`DotPathAdapter`) — this is mechanism, not policy. Whether a hidden
  path *syncs* is separate policy (`syncDotPaths` + `ignorePatterns`, both must pass),
  enforced in `SyncOrchestrator.isExcluded()`.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the rationale behind these.

## Build artifacts

`main.js`, `manifest.json`, `styles.css` → placed in the vault's
`.obsidian/plugins/air-sync/` (the folder name matches the manifest `id`). Never commit
`node_modules/` or `main.js`.

## Releases

Releases are tag-driven: pushing a tag that matches the version triggers
`.github/workflows/release.yml`, which builds and publishes a GitHub release with
`main.js`, `manifest.json`, `styles.css` attached (with build provenance). The workflow
creates the release with an **empty body** — release notes are added afterward.

Steps:

1. Bump the version (SemVer, no `v` prefix) in every file that carries it:
   - `manifest.json` → `version`
   - `package.json` → `version`
   - `package-lock.json` → both `version` fields (root and `packages.""`)
   - `versions.json` → add a `"x.y.z": "<minAppVersion>"` entry by hand (the `npm version` / `version-bump.mjs` script only adds it when `minAppVersion` changes, so it won't for a same-minAppVersion bump)
2. Gate: `npm run lint && npm run build && npm test` must all pass before tagging.
3. Commit as `Bump version to x.y.z`, push to `main`.
4. Tag `x.y.z` (must match the version exactly, no `v` prefix) and push the tag — this fires the release workflow.
5. After the run finishes (`gh run watch <id>`), attach notes: `gh release edit x.y.z --notes-file <file>`.

Release notes are public and user-facing (English): lead with what changed for the user, group under Fixed / Added, keep mechanism detail brief.
