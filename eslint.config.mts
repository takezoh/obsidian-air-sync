import tseslint from 'typescript-eslint';
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores } from "eslint/config";

// ---------------------------------------------------------------------------
// Design-principle guards (see ARCHITECTURE.md "Design principles").
//
// These encode the architecture as lint rules so violations fail CI instead of
// relying on review. Each restriction names the principle it enforces.
//
// flat-config note: rule options REPLACE (not merge) across config blocks, so
// the more-specific blocks below re-declare the shared restrictions (AXIOS,
// NODE_API, …) rather than expecting them to accumulate.
// ---------------------------------------------------------------------------

/** Bundled-only: axios is not bundled — use Obsidian's requestUrl(). */
const AXIOS_IMPORT = {
	name: "axios",
	message: "Use Obsidian's requestUrl() — axios is not bundled into main.js.",
};

// `patterns[].regex` is tested against the literal import specifier, anchored as
// written — unlike `group`, which uses gitignore semantics and would mis-match a
// relative path like "../fs/types" on its "fs" segment.

/** Mobile compatibility (isDesktopOnly: false): no Node/Electron APIs. */
const NODE_API_IMPORTS = {
	regex: "^(node:)?(fs|path|os|child_process|crypto|util|stream|electron)(/.*)?$",
	message:
		"Node/Electron APIs break mobile compatibility (isDesktopOnly: false). Use the Obsidian Vault API or browser globals instead.",
};

/** Principle #2 (swappable backends): backend-specific code stays inside fs/. */
const BACKEND_SPECIFIC_IMPORTS = {
	regex: "(^|/)googledrive(/|$)",
	message:
		"Design principle #2 (swappable backends): import backend-specific modules only via fs/registry.ts. Keep sync/, main.ts, store/, queue/, utils/ backend-agnostic.",
};

/** Principle #4 (pipeline as data): pure transforms must not touch I/O. */
const FS_INTERFACE_IMPORT = {
	regex: "(^|/)fs/interface$",
	message:
		"Design principle #4 (pipeline as data): pure transform modules must not depend on IFileSystem. Operate on the FileEntity/SyncRecord data passed in.",
};

/**
 * The pure transform stages of the sync pipeline. Each is a deterministic
 * `data → data` function (principle #4): no I/O, no clock, no randomness.
 */
const PURE_TRANSFORMS = [
	"src/sync/decision-engine.ts",
	"src/sync/change-compare.ts",
	"src/sync/merge.ts",
	"src/sync/rename-optimizer.ts",
	"src/sync/optimize-local-renames.ts",
	"src/sync/optimize-remote-renames.ts",
];

// no-restricted-syntax selectors -------------------------------------------

/**
 * Keep the vault index read centralized in LocalFs.list() so there is a single
 * entry point. getAllLoadedFiles() is an in-memory snapshot that can under-report
 * before the vault finishes loading; the layout-ready GATE that makes it safe lives
 * in the orchestrator (runSync/shouldSync early-return until isLayoutReady), NOT in
 * list() itself — see LocalFs.list()'s contract. This rule centralizes the read so
 * that gate has a single thing to protect.
 */
const NO_GET_ALL_LOADED_FILES = {
	selector: "CallExpression[callee.property.name='getAllLoadedFiles']",
	message: "Read the vault index via LocalFs.list() — getAllLoadedFiles() is only allowed in src/fs/local/.",
};

/** Principle #4: a pure transform must be deterministic — no wall clock. */
const NO_DATE_NOW = {
	selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
	message:
		"Design principle #4 (pipeline as data): pure transforms must be deterministic. Pass timestamps in as data; do not read Date.now() here.",
};

/** Principle #4: a pure transform must be deterministic — no randomness. */
const NO_MATH_RANDOM = {
	selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
	message:
		"Design principle #4 (pipeline as data): pure transforms must be deterministic. No Math.random() — derive variation from the input.",
};

/**
 * Submission-validator guard for manifest.json: the Obsidian Community Hub
 * rejects the words "obsidian"/"plugin" in the name/description/id (redundant —
 * implied by context). Matched on the typescript-eslint JSON AST: a Property
 * whose key is one of those fields and whose string value contains the word.
 */
const NO_FORBIDDEN_MANIFEST_WORDS = {
	selector:
		"Property[key.value=/^(name|description|id)$/][value.value=/\\b(obsidian|plugin)\\b/i]",
	message:
		"The Obsidian submission validator rejects 'obsidian'/'plugin' in the manifest name, description, or id — it's implied by context. Remove the word.",
};

/**
 * Cross-backend Electron-net guard: NEVER hand-set a `Content-Length` header on a
 * requestUrl call. Obsidian's requestUrl (Electron `net`) derives Content-Length from
 * the body; a manual one makes net throw `net::ERR_INVALID_ARGUMENT` at request time —
 * a failure NO test layer reproduces (unit mocks requestUrl; the e2e shim is fetch,
 * which silently drops the header). This already bit Google Drive (see the comment in
 * googledrive/resumable-upload.ts) and then OneDrive's upload session. The header name
 * contains a hyphen, so it is always a string-literal property key. Enforced repo-wide
 * so the lesson can't be re-learned per backend.
 */
const NO_MANUAL_CONTENT_LENGTH = {
	selector: "Property[key.value=/^content-length$/i]",
	message:
		"Do not set Content-Length manually — Obsidian's requestUrl (Electron net) computes it and throws net::ERR_INVALID_ARGUMENT when it is hand-set. Remove the header.",
};

export default tseslint.config(
	{
		languageOptions: {
			globals: {
				...globals.browser,
				process: "readonly",
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						'eslint.config.js',
						'manifest.json',
						'vitest.config.ts'
					]
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json']
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		// Project-wide guards: documented conventions, now enforced.
		files: ["src/**/*.ts"],
		rules: {
			// CLAUDE.md "No async without await" — was documented but unset upstream.
			"@typescript-eslint/require-await": "error",
			"no-restricted-imports": [
				"error",
				{ paths: [AXIOS_IMPORT], patterns: [NODE_API_IMPORTS] },
			],
		},
	},
	{
		// Vault-index read centralization (CLAUDE.md). LocalFs owns getAllLoadedFiles;
		// __mocks__ provides the test double.
		files: ["src/**/*.ts"],
		ignores: ["src/fs/local/**", "src/__mocks__/**"],
		rules: {
			// NO_MANUAL_CONTENT_LENGTH is appended HERE (not a separate src/** block):
			// flat-config rule options REPLACE rather than merge, so an overlapping
			// later block setting no-restricted-syntax would silently drop these.
			"no-restricted-syntax": ["error", NO_GET_ALL_LOADED_FILES, NO_MANUAL_CONTENT_LENGTH],
		},
	},
	{
		// Principle #2 (swappable backends): the backend-agnostic core must not
		// import backend-specific modules. fs/registry.ts is the single wiring
		// point; ui/ legitimately renders backend-specific settings.
		files: [
			"src/sync/**/*.ts",
			"src/main.ts",
			"src/store/**/*.ts",
			"src/queue/**/*.ts",
			"src/utils/**/*.ts",
		],
		rules: {
			"no-restricted-imports": [
				"error",
				{ paths: [AXIOS_IMPORT], patterns: [NODE_API_IMPORTS, BACKEND_SPECIFIC_IMPORTS] },
			],
		},
	},
	{
		// Principle #4 (pipeline as data): pure transforms — no I/O interface,
		// no clock, no randomness. (Re-declares the broader bans because rule
		// options replace rather than merge.)
		files: PURE_TRANSFORMS,
		rules: {
			"no-restricted-imports": [
				"error",
				{
					paths: [AXIOS_IMPORT],
					patterns: [NODE_API_IMPORTS, BACKEND_SPECIFIC_IMPORTS, FS_INTERFACE_IMPORT],
				},
			],
			"no-restricted-syntax": [
				"error",
				NO_GET_ALL_LOADED_FILES,
				NO_DATE_NOW,
				NO_MATH_RANDOM,
				NO_MANUAL_CONTENT_LENGTH,
			],
		},
	},
	{
		// Principle #7 (single responsibility per module). This cap is a PROMPT to
		// consider a responsibility split, not a line-count target to minimize
		// against — counting code lines only (comments/blanks excluded). When a file
		// trips it: split a concept out if that's natural; if not (cohesive lines, or
		// the split is its own task), add a files-scoped override below pinned at the
		// file's size with a justifying comment. Do NOT contort code to shave lines.
		// Tests/mocks/test-helpers are exempt — naturally longer, and not shipped.
		files: ["src/**/*.ts"],
		ignores: ["src/**/*.test.ts", "src/__mocks__/**", "src/**/test-helpers.ts"],
		rules: {
			"max-lines": ["error", { max: 300, skipBlankLines: true, skipComments: true }],
		},
	},
	{
		// Per-file overrides above the 300 cap (known debt), each pinned at its
		// current size so it cannot grow SILENTLY — the pin is a ratchet, not a
		// reduction mandate. Ratchet down when a natural split presents itself;
		// raise (re-pin) when a cohesive change needs it rather than forcing the
		// count down with churn (see docs/code-enforcement.md §6).
		// (googledrive/index.ts was here at 397; A1 lifted its cache/checkpoint
		// machinery into fs/caching/, dropping it back under the standard 300 cap.)
		files: ["src/fs/googledrive/auth.ts"],
		rules: { "max-lines": ["error", { max: 337, skipBlankLines: true, skipComments: true }] },
	},
	{
		// Re-pinned from 367 for the config-sync feature (configDir/pluginId deps +
		// effective dot-path/ignore-pattern lookups, plus the unconditional
		// isOwnPluginDataPath guard, in isExcluded()) — cohesive addition to the
		// existing exclusion gate, not a natural split point.
		files: ["src/sync/orchestrator.ts"],
		rules: { "max-lines": ["error", { max: 374, skipBlankLines: true, skipComments: true }] },
	},
	{
		// Lint manifest.json for the words the Obsidian submission validator
		// HARD-rejects in name/description/id ("obsidian"/"plugin" — redundant,
		// implied by context). The typescript-eslint parser turns .json into an
		// ObjectExpression AST (hence the extraFileExtensions: ['.json'] /
		// allowDefaultProject above), so no-restricted-syntax can match the
		// offending property literal.
		//
		// We deliberately do NOT use obsidianmd/validate-manifest here: its
		// descriptionFormat sub-check forbids parentheses (regex
		// ^[A-Za-z0-9\s.,!?'"-]+$, same on master), which the actual dashboard
		// ACCEPTS — our shipped "… (Google Drive, Dropbox)." passes the bot but
		// would false-positive on that rule, and the rule has no options to
		// disable just that sub-check. Matching the forbidden words directly
		// keeps the local gate aligned with what the bot really blocks.
		files: ["manifest.json"],
		languageOptions: { parser: tseslint.parser },
		rules: {
			"no-restricted-syntax": ["error", NO_FORBIDDEN_MANIFEST_WORDS],
		},
	},
	globalIgnores([
		"node_modules",
		"dist",
		"coverage",
		"esbuild.config.mjs",
		"eslint.config.js",
		"version-bump.mjs",
		"versions.json",
		"main.js",
		".roost", // local agent/tooling git worktrees (not part of the plugin)
		".agent-reactor", // ditto — agent-reactor's worktrees live here
		// Opt-in real-cloud e2e harness (ADR 0003): local/manual only, never
		// bundled. It deliberately uses Node APIs (fetch, fs, readline) and real
		// network — forbidden in shipped src/ by the mobile-compat / restricted-
		// globals rules — so it is exempt from the plugin lint here.
		"e2e",
	]),
);
