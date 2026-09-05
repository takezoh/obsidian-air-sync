const assert = process.getBuiltinModule("node:assert/strict");
const { readdirSync, readFileSync } = process.getBuiltinModule("node:fs");
const { dirname, join, normalize, relative } = process.getBuiltinModule("node:path");
const test = process.getBuiltinModule("node:test");
const ts = await import("typescript");

const ROOT = process.cwd();
const SOURCE_ROOT = join(ROOT, "src");
const DECISION_FILE = "src/sync/identity-component-decision.ts";
const REPORT_FAMILY_FILE = "src/sync/identity-component-report-family.ts";
const VALUE_IMPORT_OWNERS = new Map([
	["src/sync/decision-engine.ts", new Map([["*", new Set([DECISION_FILE])]])],
	[DECISION_FILE, new Map([["*", new Set(["src/sync/plan-admission.ts"])]])],
	["src/sync/plan-admission-graph.ts", new Map([["*", new Set(["src/sync/plan-admission.ts"])]])],
	["src/sync/identity-component-topology.ts", new Map([["*", new Set()]])],
	["src/sync/identity-component-report-family.ts", new Map([["*", new Set([DECISION_FILE])]])],
	["src/sync/local-rename-admission.ts", new Map([["*", new Set()]])],
	["src/sync/optimize-local-renames.ts", new Map([["*", new Set()]])],
	["src/sync/optimize-remote-renames.ts", new Map([["*", new Set()]])],
	["src/sync/plan-admission-case-alias.ts", new Map([["*", new Set()]])],
]);

function productionTypeScriptFiles(root = SOURCE_ROOT) {
	return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
		const path = join(root, entry.name);
		if (entry.isDirectory()) return productionTypeScriptFiles(path);
		if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) return [];
		return [path];
	});
}

function parseSource(text, fileName) {
	return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function valueImports(sourceFile) {
	const result = [];
	for (const statement of sourceFile.statements) {
		if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
			const moduleName = statement.moduleSpecifier.text;
			const clause = statement.importClause;
			if (!clause) {
				result.push({ moduleName, importedName: "*" });
				continue;
			}
			if (clause.isTypeOnly) continue;
			if (clause.name) result.push({ moduleName, importedName: "default" });
			const bindings = clause.namedBindings;
			if (bindings && ts.isNamespaceImport(bindings)) {
				result.push({ moduleName, importedName: "*" });
			} else if (bindings && ts.isNamedImports(bindings)) {
				for (const element of bindings.elements) {
					if (!element.isTypeOnly) {
						result.push({
							moduleName,
							importedName: element.propertyName?.text ?? element.name.text,
						});
					}
				}
			}
		} else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly &&
			ts.isStringLiteral(statement.moduleSpecifier)) {
			const moduleName = statement.moduleSpecifier.text;
			if (!statement.exportClause) {
				result.push({ moduleName, importedName: "*" });
			} else if (ts.isNamespaceExport(statement.exportClause)) {
				result.push({ moduleName, importedName: "*" });
			} else if (ts.isNamedExports(statement.exportClause)) {
				if (statement.exportClause.elements.length === 0) {
					result.push({ moduleName, importedName: "*" });
				}
				for (const element of statement.exportClause.elements) {
					if (!element.isTypeOnly) {
						result.push({
							moduleName,
							importedName: element.propertyName?.text ?? element.name.text,
						});
					}
				}
			}
		}
	}
	const visitDynamicImports = (node) => {
		if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
			node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])) {
			result.push({ moduleName: node.arguments[0].text, importedName: "*" });
		}
		node.forEachChild(visitDynamicImports);
	};
	sourceFile.forEachChild(visitDynamicImports);
	return result;
}

function assertClosedValueImports(files = productionTypeScriptFiles()) {
	for (const path of files) {
		const file = relative(ROOT, path);
		const source = parseSource(readFileSync(path, "utf8"), path);
		assertAllowedValueImports(file, source);
	}
}

function assertAllowedValueImports(file, sourceFile) {
	for (const item of valueImports(sourceFile)) {
		const target = resolveTypeScriptModule(file, item.moduleName);
		const moduleOwners = target ? VALUE_IMPORT_OWNERS.get(target) : undefined;
		if (!moduleOwners) continue;
		const owners = moduleOwners.get(item.importedName) ?? moduleOwners.get("*");
		assert.ok(owners?.has(file), `${file} must not value-import ${item.importedName} from ${item.moduleName}`);
	}
}

function resolveTypeScriptModule(importer, moduleName) {
	if (!moduleName.startsWith(".")) return undefined;
	const resolved = normalize(join(dirname(importer), moduleName)).replaceAll("\\", "/")
		.replace(/\.(?:c|m)?js$/u, ".ts");
	return resolved.endsWith(".ts") ? resolved : `${resolved}.ts`;
}

function isPrimitiveConstant(initializer) {
	return ts.isStringLiteral(initializer) || ts.isNumericLiteral(initializer) ||
		initializer.kind === ts.SyntaxKind.TrueKeyword ||
		initializer.kind === ts.SyntaxKind.FalseKeyword ||
		initializer.kind === ts.SyntaxKind.NullKeyword;
}

function assertNoModuleState(sourceFile) {
	for (const statement of sourceFile.statements) {
		assert.ok(!ts.isClassDeclaration(statement), "module-scope class can retain correctness state");
		assert.ok(!ts.isEnumDeclaration(statement), "module-scope enum emits a mutable runtime object");
		if (ts.isVariableStatement(statement)) {
			assert.ok((statement.declarationList.flags & ts.NodeFlags.Const) !== 0,
				"module-scope let/var can retain correctness state");
			for (const declaration of statement.declarationList.declarations) {
				assert.ok(!declaration.initializer || isPrimitiveConstant(declaration.initializer),
					"module-scope object, collection, or computed value can retain correctness state");
			}
			continue;
		}
		if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement) ||
			ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) ||
			ts.isFunctionDeclaration(statement) || ts.isEmptyStatement(statement)) continue;
		assert.fail(containsMutation(statement)
			? "module initialization must not assign, update, or call mutable correctness state"
			: "unsupported module-scope runtime declaration can retain correctness state");
	}
}

function containsMutation(node) {
	if (ts.isCallExpression(node) || ts.isNewExpression(node) ||
		ts.isDeleteExpression(node) || ts.isPostfixUnaryExpression(node) ||
		(ts.isPrefixUnaryExpression(node) &&
			(node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) ||
		(ts.isBinaryExpression(node) &&
			node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
			node.operatorToken.kind <= ts.SyntaxKind.LastAssignment)) return true;
	return node.getChildren().some(containsMutation);
}

test("Admission helper value imports have one closed owner", () => {
	assertClosedValueImports();
});

function assertFactOnlyBoundary(file, source) {
	const forbidden = new Set(["planSync", "admitDestructivePlan", "bindAdmissionPlan", "captureCycleAdmissionSnapshot",
		"FreshRenameState", "FreshRenameAction", "normalizedRenameState", "renameOptimizerView",
		"resolveWithStrategy", "resolveLegacyConflict", "prepareOnly", "requiresPreparation"]);
	const visit = (node) => {
		if (ts.isIdentifier(node)) assert.ok(!forbidden.has(node.text), `${file}: obsolete action-first contract ${node.text}`);
		if (ts.isInterfaceDeclaration(node) && ["BatchObservation", "IdentityComponent"].includes(node.name.text)) {
			assert.deepEqual(node.members.map((member) => member.name?.getText(source)).sort(),
				(node.name.text === "BatchObservation"
					? ["entries", "evidence", "baselinePaths", "observations", "scope", "namespace"]
					: ["paths", "entries", "evidence", "observations"]).sort(),
				`${node.name.text} must contain only observed facts`);
		}
		node.forEachChild(visit);
	};
	visit(source);
}

test("production has only the fact-first Admission contract", () => {
	for (const file of productionTypeScriptFiles()) assertFactOnlyBoundary(file, parseSource(readFileSync(file, "utf8"), file));
});

test("guard rejects action-first API and action-bearing observation", () => {
	for (const text of ["export function planSync() {}", "interface BatchObservation { actions: unknown[]; }",
		"interface IdentityComponent { paths: Set<string>; actions: unknown[]; }",
		"function resolveLegacyConflict() {}", "interface ResolverContext { prepareOnly?: boolean; }"]) {
		assert.throws(() => assertFactOnlyBoundary("fixture.ts", parseSource(text, "fixture.ts")));
	}
});

test("content comparison and fact binding cannot become independent policy stages", () => {
	for (const module of ["decision-engine", "identity-component-decision", "plan-admission-graph"]) {
		const file = "src/sync/orchestrator.ts";
		assert.throws(() => assertAllowedValueImports(file, parseSource(`import * as policy from "./${module}";`, file)));
	}
});

test("identity decision and subordinate proofs retain no module-scope state", () => {
	for (const file of [DECISION_FILE, REPORT_FAMILY_FILE]) {
		assertNoModuleState(parseSource(readFileSync(join(ROOT, file), "utf8"), file));
	}
});

test("guard rejects a module-scope proof cache", () => {
	const source = parseSource("const proofByComponent = new Map<string, unknown>();", "synthetic-proof-cache.ts");
	assert.throws(() => assertNoModuleState(source));
});

test("guard rejects a foreign candidate-helper importer", () => {
	const path = join(SOURCE_ROOT, "sync", "foreign.ts");
	const source = parseSource(
		'import { optimizeRemoteFileRenames } from "./optimize-remote-renames";', path,
	);
	assert.throws(() => assertAllowedValueImports("src/sync/foreign.ts", source));
});

test("guard resolves candidate-helper imports across the production tree", () => {
	const main = parseSource(
		'import { deriveTopologyCoverage } from "./sync/identity-component-topology";',
		"src/main.ts",
	);
	const nested = parseSource(
		'import { deriveTopologyCoverage } from "../identity-component-topology";',
		"src/sync/nested/foreign.ts",
	);
	assert.throws(() => assertAllowedValueImports("src/main.ts", main));
	assert.throws(() => assertAllowedValueImports("src/sync/nested/foreign.ts", nested));
	assert.ok(productionTypeScriptFiles().some((path) => relative(ROOT, path) === "src/main.ts"));
	assert.ok(productionTypeScriptFiles().some((path) =>
		relative(ROOT, path) === "src/fs/local/index.ts"));
	const explicitJs = parseSource(
		'import { deriveTopologyCoverage } from "./sync/identity-component-topology.js";',
		"src/main.ts",
	);
	assert.throws(() => assertAllowedValueImports("src/main.ts", explicitJs));
	const reexport = parseSource(
		'export { deriveTopologyCoverage } from "./sync/identity-component-topology";',
		"src/main.ts",
	);
	const dynamicImport = parseSource(
		'export async function load() { return import("./sync/identity-component-topology"); }',
		"src/main.ts",
	);
	assert.throws(() => assertAllowedValueImports("src/main.ts", reexport));
	assert.throws(() => assertAllowedValueImports("src/main.ts", dynamicImport));
	const namespaceReexport = parseSource(
		'export * as topology from "./sync/identity-component-topology";',
		"src/main.ts",
	);
	assert.throws(() => assertAllowedValueImports("src/main.ts", namespaceReexport));
	const templateDynamicImport = parseSource(
		"export async function load() { return import(`./sync/identity-component-topology`); }",
		"src/main.ts",
	);
	assert.throws(() => assertAllowedValueImports("src/main.ts", templateDynamicImport));
	const sideEffectImport = parseSource(
		'import "./sync/identity-component-topology";',
		"src/main.ts",
	);
	const emptyReexport = parseSource(
		'export {} from "./sync/identity-component-topology";',
		"src/main.ts",
	);
	assert.throws(() => assertAllowedValueImports("src/main.ts", sideEffectImport));
	assert.throws(() => assertAllowedValueImports("src/main.ts", emptyReexport));
});

test("guard rejects module-scope assignment and update mutations", () => {
	for (const text of [
		"export function prove() {}\nprove.cache = new Map();",
		"if (true) { globalThis.proofCount++; }",
		"if (true) { globalThis.proofCache.set('key', true); }",
		"if (true) { globalThis.proofCache = undefined; }",
		"export namespace Proof { export const cache = []; }",
	]) {
		assert.throws(() => assertNoModuleState(parseSource(text, "synthetic-mutation.ts")));
	}
});

test("guard accepts a pure call-local proof", () => {
	const source = parseSource(
		"export function prove() { const pairs = new Map<string, string>(); return pairs.size; }",
		"synthetic-call-local.ts",
	);
	assert.doesNotThrow(() => assertNoModuleState(source));
});
