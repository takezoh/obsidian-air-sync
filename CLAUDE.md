# Smart Sync — Obsidian Plugin

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
- Prefer `async/await`
- Mobile compatible (`isDesktopOnly: false`) — no Node/Electron APIs
- Minimize network calls; require explicit disclosure
- Command IDs are immutable once published

## Type safety & lint rules

Always pass `npm run lint && npm run build && npm test` after making changes.

### No `any`
- Never use `as any`. Use `as unknown as TargetType` when a cast is unavoidable
- Type external API responses (`response.json`, etc.) as `const x: unknown = ...` and narrow with a runtime validator (assert function)
- Annotate `JSON.parse()` return values explicitly (`as { key: Type }`)

### Type-safe mocks in tests
- Do not cast `vi.spyOn` targets with `as any`. Use typed helpers instead
  - `spyRequestUrl()` — type-safe spy on obsidian's `requestUrl`
  - `mockSettings()` — returns a complete `SmartSyncSettings` default
- Access private fields via `as unknown as { field: Type }` pattern
- Pass `createMockStateStore()` directly (its intersection type satisfies `SyncStateStore`)

### obsidianmd ESLint plugin
- `eslint-plugin-obsidianmd` is installed and included in `eslint.config.mts` (`obsidianmd.configs.recommended`)
- The community plugin submission bot runs the same plugin to validate PRs — always run `npm run lint` before pushing
- Never hardcode `.obsidian` — use `Vault#configDir`. In tests, assign to a variable and add `// eslint-disable-line obsidianmd/hardcoded-config-path`
- UI text (`.setName()` / `.setDesc()`) must use sentence case. Avoid all-caps abbreviations (e.g. `PDFs`, `MB`)
- `eslint-disable` directives must include a description explaining why (e.g. `// eslint-disable-next-line rule-name -- reason here`)
- Do not disable rules that the obsidianmd plugin disallows (`obsidianmd/no-tfile-tfolder-cast`, `obsidianmd/ui/sentence-case`, etc.) — fix the code instead

## Build artifacts

`main.js`, `manifest.json`, `styles.css` → placed in vault's `.obsidian/plugins/obsidian-smart-sync/`. Never commit `node_modules/` or `main.js`.

## Releases

Update `version` in `manifest.json` (SemVer, no `v` prefix) and `versions.json`. GitHub release tag must match the version exactly.
