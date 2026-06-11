# Contributing to Air Sync

Thanks for your interest in improving Air Sync! This guide covers how to report
issues, set up a development environment, and submit changes.

## Reporting issues

- Search [existing issues](https://github.com/takezoh/obsidian-air-sync/issues) first.
- For bugs, include your Obsidian version, platform (desktop/mobile + OS), the Air
  Sync version, clear steps to reproduce, and what you expected vs. what happened.
- For sync problems, enable logging (**Settings → Air Sync → Advanced → Enable
  logging**) and attach the relevant lines from `.airsync/` in your vault.
- For security vulnerabilities, please **do not** open a public issue — see
  [Security](#security).

## Development setup

Prerequisites: Node.js 20 or 22 and npm. (CI runs both Node 20.x and 22.x with npm 11.)

```bash
git clone https://github.com/takezoh/obsidian-air-sync
cd obsidian-air-sync
npm install
npm run dev      # esbuild watch — rebuilds main.js on change
```

> CI installs with **npm 11** via `npm ci`. If your npm major differs, `npm install`
> may rewrite `package-lock.json` — don't commit that churn; prefer `npm ci` for a
> clean, lockfile-faithful install.

To try your build in Obsidian, use a **throwaway test vault**, not your real one:

1. Create the plugin folder `<vault>/.obsidian/plugins/air-sync/`.
2. Copy (or symlink) the build output into it: `main.js`, `manifest.json`, `styles.css`.
3. Enable **Air Sync** under Settings → Community plugins, and reload after rebuilds.

`npm run dev` produces a watch build with inline sourcemaps; `npm run build` produces
a minified production `main.js`. No environment variables are required to build.

## Before you submit

Every change must pass the same gate CI enforces:

```bash
npm run lint && npm run build && npm test
```

- `npm run lint` — ESLint (`--max-warnings 0`), including the `eslint-plugin-obsidianmd`
  ruleset the community submission bot runs.
- `npm run build` — `tsc -noEmit` (strict) + esbuild bundle.
- `npm test` — Vitest. `npm run test:coverage` enforces ratchet coverage floors; raise
  them as coverage improves, never lower them.

There is also an **opt-in** `npm run test:e2e` that runs the same `IFileSystem` contract
against the **real** Google Drive / Dropbox APIs to catch drift in the in-memory fakes. It is
credentials-gated (warns and skips without them) and is **not** part of the gate or CI — see
[docs/e2e-testing.md](docs/e2e-testing.md).

## Coding conventions

The conventions, and the lint/test rules that enforce them, are documented in:

- **[docs/code-enforcement.md](docs/code-enforcement.md)** — every enforced rule: what
  it prevents, where it's defined, how it's enforced, and how to declare an exception.
- **[ARCHITECTURE.md](ARCHITECTURE.md)** — the design principles those rules protect.

Highlights:

- **TypeScript strict.** No `any` — use `unknown` and narrow. Prefer `async`/`await`.
- **Mobile compatible** (`isDesktopOnly: false`) — no Node/Electron APIs. Use Obsidian's
  `requestUrl` for network requests, never `fetch`.
- **`main.ts` is lifecycle only** — delegate logic to modules, ~200–300 lines each.
- **Register listeners via `this.register*`** to prevent leaks.
- **UI text uses sentence case.**

Most of these are rejected at lint, build, or test time — fix the code rather than
disabling a rule.

## Commits & pull requests

- Branch off `main` and open PRs against `main`.
- Keep PRs focused, and describe the user-facing change and the reasoning behind it.
- Ensure the check gate above passes locally — CI runs lint, build, and coverage on
  Node 20 and 22 for every push and PR.
- Command IDs are immutable once shipped (`main-commands.test.ts` snapshots them); add
  a new ID for new commands rather than renaming an existing one.

## Releases

Releases are maintainer-only and tag-driven: pushing a version tag triggers
`.github/workflows/release.yml`, which builds and publishes the GitHub release with
build provenance. The full procedure is documented in the Releases section of
[CLAUDE.md](CLAUDE.md).

## Security

Air Sync stores OAuth tokens in Obsidian's secret storage. If you discover a security
vulnerability, please report it privately — **do not** open a public issue. Use the
**Report a vulnerability** button on the repository's
[Security tab](https://github.com/takezoh/obsidian-air-sync/security); if private
reporting isn't available there, reach the maintainer via their GitHub profile
([@takezoh](https://github.com/takezoh)).

## License

By contributing, you agree that your contributions are licensed under the project's
[MIT License](LICENSE).
