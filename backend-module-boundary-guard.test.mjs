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
 * metadata cache, the delta cursor, scope, checkpoint, or stores.
 *
 * The consolidated implementation family lives under `src/backends/` — one
 * directory per canonical module (`googledrive`/`onedrive`/`dropbox`) plus
 * provider-neutral helpers in `shared/`. A provider keeps the one-module-one-backend
 * rule: it may import only the public `src/backend-api/`, `shared/`, and its own
 * directory — never another provider. `shared/` may import only the public API and
 * itself — never a provider. Any other relative import (the internal backend-module
 * API `src/fs/modules/`, a core store, the sync engine, a core filesystem class, the
 * Obsidian host, a plain `src/fs/` helper) is outside the boundary, and bare Node
 * builtins are rejected alongside `node:` specifiers.
 */
const BACKENDS_ROOT = join(ROOT, "src", "backends");
const SHARED_ROOT = join(BACKENDS_ROOT, "shared");
const PROVIDER_ROOTS = ["googledrive", "onedrive", "dropbox"].map((id) => join(BACKENDS_ROOT, id));

const { builtinModules } = process.getBuiltinModule("node:module");
const NODE_BUILTINS = new Set(builtinModules.flatMap((name) => [name, name.replace(/^node:/, "")]));

function isNodeBuiltin(specifier) {
	return specifier.startsWith("node:") || NODE_BUILTINS.has(specifier);
}

function isWithin(root, resolved) {
	return resolved === root || resolved.startsWith(root + "/");
}

/** The roots a file may reach, from its own location inside `src/backends/`. */
function allowedRootsFor(fileDirectory) {
	for (const provider of PROVIDER_ROOTS) {
		if (isWithin(provider, fileDirectory)) return [API_ROOT, SHARED_ROOT, provider];
	}
	if (isWithin(SHARED_ROOT, fileDirectory)) return [API_ROOT, SHARED_ROOT];
	return [API_ROOT, BACKENDS_ROOT];
}

function moduleImportViolations(source, fileDirectory) {
	const allowed = allowedRootsFor(fileDirectory);
	return importSpecifiers(source).filter((specifier) => {
		if (specifier === "obsidian" || specifier === "electron" || isNodeBuiltin(specifier)) return true;
		if (!specifier.startsWith(".")) return false;
		const resolved = resolve(fileDirectory, specifier);
		return !allowed.some((root) => isWithin(root, resolved));
	});
}

/**
 * Every shipped `*.ts` under `src/backends/` — not only the historical
 * `module|adapter|client|auth*` filename patterns — so a new helper that reaches
 * for the internal `Logger` type (rather than the narrow `BackendLogger`) fails
 * this guard. Test doubles (`*.test.ts`) and `test-helpers.ts` are test
 * infrastructure, not shipped implementation, and are excluded (matching the
 * coverage and max-lines exemptions).
 */
function collectTsFiles(directory, files) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			collectTsFiles(path, files);
			continue;
		}
		if (
			entry.name.endsWith(".ts") &&
			!entry.name.endsWith(".test.ts") &&
			!entry.name.endsWith("test-helpers.ts")
		) {
			files.push(path);
		}
	}
	return files;
}

function moduleImplFiles() {
	return collectTsFiles(BACKENDS_ROOT, []);
}

test("a backend implementation imports no internal module API, core store, sync engine, or host runtime", () => {
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

test("the module guard rejects the internal backend-module API", () => {
	const directory = join(ROOT, "src/backends/googledrive");
	// The exact import shapes the built-ins used before the helpers moved into the
	// public API and src/backends/shared.
	assert.deepEqual(
		moduleImportViolations('import { asString } from "../../fs/modules/module-utils";', directory),
		["../../fs/modules/module-utils"],
	);
	assert.deepEqual(
		moduleImportViolations('import { withAdapterState } from "../../fs/modules/adapter-state";', directory),
		["../../fs/modules/adapter-state"],
	);
});

test("the module guard rejects a former shared fs helper now that it is public", () => {
	const directory = join(ROOT, "src/backends/googledrive");
	for (const source of [
		'import { AuthError } from "../../fs/errors";',
		'import { getHeader } from "../../fs/headers";',
		'import { AdaptivePool } from "../../queue/async-queue";',
	]) {
		assert.deepEqual(moduleImportViolations(source, directory), [source.match(/from "([^"]+)"/)[1]]);
	}
});

test("the module guard rejects an import of the metadata store", () => {
	const source = 'import { MetadataStore } from "../../store/metadata-store";';
	assert.deepEqual(moduleImportViolations(source, join(ROOT, "src/backends/googledrive")), ["../../store/metadata-store"]);
});

test("the module guard rejects IFileSystem or the Obsidian App", () => {
	assert.equal(moduleImportViolations('import type { IFileSystem } from "../../fs/interface";', join(ROOT, "src/backends/googledrive")).length, 1);
	assert.equal(moduleImportViolations('import { App } from "obsidian";', join(ROOT, "src/backends/googledrive")).length, 1);
});

test("a module implementation's internal platform import is rejected (mutation witness)", () => {
	const directory = join(ROOT, "src/backends/googledrive");
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
	const directory = join(ROOT, "src/backends/googledrive");
	assert.deepEqual(
		moduleImportViolations('import { requestUrl } from "../../platform/obsidian";', directory),
		["../../platform/obsidian"],
	);
	assert.deepEqual(
		moduleImportViolations('import type { Logger } from "../../logging/logger";', directory),
		["../../logging/logger"],
	);
});

test("only the public API, shared, and the provider's own tree are allowed", () => {
	const directory = join(ROOT, "src/backends/googledrive");
	for (const source of [
		'import type { BackendLogger } from "../../backend-api";',
		'import { AuthError } from "../../backend-api/error-classification";',
		'import { withAdapterState } from "../shared/adapter-state";',
		'import { FOLDER_MIME } from "./types";',
	]) {
		assert.deepEqual(moduleImportViolations(source, directory), []);
	}
	// `shared/` may not reach into a provider.
	assert.deepEqual(
		moduleImportViolations(
			'import { dropboxModule } from "../dropbox/module";',
			join(ROOT, "src/backends/shared"),
		),
		["../dropbox/module"],
	);
});

test("the module guard rejects a cross-provider import (one module = one backend)", () => {
	const directory = join(ROOT, "src/backends/googledrive");
	assert.deepEqual(
		moduleImportViolations('import { dropboxModule } from "../dropbox/module";', directory),
		["../dropbox/module"],
	);
	assert.deepEqual(
		moduleImportViolations('import { OneDriveClient } from "../onedrive/client";', directory),
		["../onedrive/client"],
	);
	// A provider may still reach its own files.
	assert.deepEqual(moduleImportViolations('import { googleDriveModule } from "./module";', directory), []);
});

test("the module guard rejects bare Node builtins, not only node: specifiers", () => {
	const directory = join(ROOT, "src/backends/googledrive");
	assert.deepEqual(
		moduleImportViolations('import { readFileSync } from "fs";', directory),
		["fs"],
	);
	assert.deepEqual(
		moduleImportViolations('import { join } from "path";', directory),
		["path"],
	);
	assert.deepEqual(
		moduleImportViolations('import { createHash } from "node:crypto";', directory),
		["node:crypto"],
	);
});
