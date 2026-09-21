const assert = process.getBuiltinModule("node:assert/strict");
const { readdirSync, readFileSync } = process.getBuiltinModule("node:fs");
const { join, relative, resolve } = process.getBuiltinModule("node:path");
const test = process.getBuiltinModule("node:test");

const ROOT = process.cwd();
const API_ROOT = join(ROOT, "src", "backend-api");
const ENTRY = join(API_ROOT, "index.ts");

/**
 * The Backend Module API is the public extension boundary (API v2). Its
 * transitive imports must stay free of core internals, Obsidian, stores, and
 * Node/Electron so a static fake module can be built from types alone and a
 * future dynamic loader can bundle it. This guard scans the production source
 * text and fails on any import that leaves `src/backend-api/` or names a
 * forbidden runtime.
 */

function apiFiles(directory = API_ROOT) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return apiFiles(path);
		return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
	});
}

function importSpecifiers(source) {
	const specifiers = [];
	const patterns = [
		/from\s+["']([^"']+)["']/g,
		/import\s*\(\s*["']([^"']+)["']/g,
		/^\s*import\s+["']([^"']+)["']/gm,
	];
	for (const pattern of patterns) {
		let match = pattern.exec(source);
		while (match !== null) {
			specifiers.push(match[1]);
			match = pattern.exec(source);
		}
	}
	return specifiers;
}

function boundaryViolations(source, fileDirectory) {
	return importSpecifiers(source).filter((specifier) => {
		if (specifier === "obsidian" || specifier === "electron" || specifier.startsWith("node:")) {
			return true;
		}
		if (!specifier.startsWith(".")) return true;
		const resolved = resolve(fileDirectory, specifier);
		const escaped = relative(API_ROOT, resolved);
		return escaped.startsWith("..") || escaped.includes("\\..");
	});
}

test("the backend-api entry point exists", () => {
	assert.ok(readFileSync(ENTRY, "utf8").length > 0);
});

test("every backend-api import stays inside the public boundary", () => {
	for (const file of apiFiles()) {
		const source = readFileSync(file, "utf8");
		const violations = boundaryViolations(source, join(file, ".."));
		assert.deepEqual(
			violations,
			[],
			`${relative(ROOT, file)} imports outside the boundary: ${violations.join(", ")}`,
		);
	}
});

test("the guard rejects a forbidden runtime import", () => {
	const source = 'import { App } from "obsidian";';
	assert.deepEqual(boundaryViolations(source, API_ROOT), ["obsidian"]);
	assert.deepEqual(boundaryViolations('import { join } from "node:path";', API_ROOT), ["node:path"]);
});

test("the guard rejects an import that escapes the boundary", () => {
	const source = 'import type { IFileSystem } from "../fs/interface";';
	const violations = boundaryViolations(source, API_ROOT);
	assert.equal(violations.length, 1);
});

/**
 * The other half of the boundary: a backend module IMPLEMENTATION reports provider
 * facts and performs provider mutations; it does not own the filesystem, the
 * metadata cache, the delta cursor, scope, checkpoint, or stores. The files the
 * three built-ins use to cross the boundary (`module.ts`, `adapter.ts`,
 * `normalize-object.ts`) must not reach into a core store, the sync engine, a core
 * filesystem class, the Obsidian host, or Node/Electron.
 */
const MODULE_FILES = [
	"src/fs/googledrive/module.ts",
	"src/fs/googledrive/adapter.ts",
	"src/fs/googledrive/normalize-object.ts",
	"src/fs/onedrive/module.ts",
	"src/fs/onedrive/adapter.ts",
	"src/fs/onedrive/normalize-object.ts",
	"src/fs/dropbox/module.ts",
	"src/fs/dropbox/adapter.ts",
	"src/fs/dropbox/normalize-object.ts",
];

const FORBIDDEN_MODULE_PREFIXES = [
	join(ROOT, "src", "store"),
	join(ROOT, "src", "sync"),
	join(ROOT, "src", "fs", "caching"),
	join(ROOT, "src", "fs", "managed"),
	join(ROOT, "src", "fs", "local"),
	join(ROOT, "src", "platform"),
	join(ROOT, "src", "logging"),
];
const FORBIDDEN_MODULE_FILES = [
	join(ROOT, "src", "fs", "interface"),
	join(ROOT, "src", "fs", "backend"),
	join(ROOT, "src", "fs", "backend-manager"),
];

function moduleImportViolations(source, fileDirectory) {
	return importSpecifiers(source).filter((specifier) => {
		if (specifier === "obsidian" || specifier === "electron" || specifier.startsWith("node:")) return true;
		if (!specifier.startsWith(".")) return false;
		const resolved = resolve(fileDirectory, specifier);
		return (
			FORBIDDEN_MODULE_PREFIXES.some((prefix) => resolved === prefix || resolved.startsWith(prefix + "/")) ||
			FORBIDDEN_MODULE_FILES.some((file) => resolved === file || resolved === file + ".ts")
		);
	});
}

test("a backend module implementation imports no core store, sync engine, or host runtime", () => {
	for (const relative of MODULE_FILES) {
		const source = readFileSync(join(ROOT, relative), "utf8");
		const violations = moduleImportViolations(source, join(ROOT, relative, ".."));
		assert.deepEqual(violations, [], `${relative} imports outside the module boundary: ${violations.join(", ")}`);
	}
});

test("the module guard rejects an import of the metadata store", () => {
	const source = 'import { MetadataStore } from "../../store/metadata-store";';
	assert.deepEqual(moduleImportViolations(source, join(ROOT, "src/fs/googledrive")), ["../../store/metadata-store"]);
});

test("the module guard rejects IFileSystem or the Obsidian App", () => {
	assert.equal(moduleImportViolations('import type { IFileSystem } from "../interface";', join(ROOT, "src/fs/googledrive")).length, 1);
	assert.equal(moduleImportViolations('import { App } from "obsidian";', join(ROOT, "src/fs/googledrive")).length, 1);
});

/**
 * The module implementation family is everything reachable from `module.ts`: the
 * typed REST clients, auth helpers, remote-vault resolvers, and folder-path
 * helpers are all part of the bundle an author ships, and item 7 holds that none
 * of them may import Obsidian, the internal logger, or a core store. The scan
 * therefore covers ALL non-test `*.ts` under each built-in directory — not only
 * the historical `module|adapter|client|auth*` filename patterns — so a new
 * helper that reaches for the internal `Logger` type (rather than the narrow
 * `BackendLogger`) fails this guard.
 */
function collectTsFiles(directory, files) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			collectTsFiles(path, files);
			continue;
		}
		if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(path);
	}
	return files;
}

function moduleImplFiles() {
	const files = [];
	for (const backend of ["googledrive", "onedrive", "dropbox"]) {
		collectTsFiles(join(ROOT, "src", "fs", backend), files);
	}
	return files;
}

test("module implementation files import no Obsidian host, logging, or core store", () => {
	for (const file of moduleImplFiles()) {
		const relativePath = relative(ROOT, file);
		const source = readFileSync(file, "utf8");
		const violations = moduleImportViolations(source, join(file, ".."));
		assert.deepEqual(
			violations,
			[],
			`${relativePath} imports outside the module boundary: ${violations.join(", ")}`,
		);
	}
});

test("a module implementation's internal platform import is rejected (mutation witness)", () => {
	const directory = join(ROOT, "src/fs/googledrive");
	// The exact import shape the clients/auth used before the transport seam.
	assert.deepEqual(
		moduleImportViolations('import { requestUrl } from "../../platform/obsidian";', directory),
		["../../platform/obsidian"],
	);
	// A shipped client that reaches for the host again must fail, not be listed.
	assert.deepEqual(
		moduleImportViolations('import type { RequestUrlParam } from "../../platform/obsidian";', directory),
		["../../platform/obsidian"],
	);
});

test("the module guard detects a platform and a logging import in a client file", () => {
	const directory = join(ROOT, "src/fs/googledrive");
	assert.deepEqual(
		moduleImportViolations('import { requestUrl } from "../../platform/obsidian";', directory),
		["../../platform/obsidian"],
	);
	assert.deepEqual(
		moduleImportViolations('import type { Logger } from "../../logging/logger";', directory),
		["../../logging/logger"],
	);
});

test("the module guard detects a logging type import in a reachable helper (mutation witness)", () => {
	// `remote-vault.ts`, `folder-path.ts`, and `onedrive/remote-vault.ts` import a
	// logging type but are not `module|adapter|client|auth*`; the helper-file scan
	// must still flag the exact shape they used before the narrow `BackendLogger`.
	for (const backend of ["googledrive", "onedrive"]) {
		const directory = join(ROOT, "src", "fs", backend);
		assert.deepEqual(
			moduleImportViolations('import type { Logger } from "../../logging/logger";', directory),
			["../../logging/logger"],
		);
	}
	// A module-reachable helper that only opens the public API is allowed.
	assert.deepEqual(moduleImportViolations('import type { BackendLogger } from "../../backend-api";', join(ROOT, "src/fs/googledrive")), []);
});
