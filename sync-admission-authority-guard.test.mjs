const assert = process.getBuiltinModule("node:assert/strict");
const { readdirSync, readFileSync } = process.getBuiltinModule("node:fs");
const { dirname, join, normalize, relative } = process.getBuiltinModule("node:path");
const test = process.getBuiltinModule("node:test");
const ts = await import("typescript");

const ROOT = process.cwd();
const SOURCE_ROOT = join(ROOT, "src");
const DECISION_FILE = "src/sync/identity-component-decision.ts";
const REPORT_FAMILY_FILE = "src/sync/identity-component-report-family.ts";
const POLICY_COMPILER_FILE = "src/sync/conflict-policy-admission.ts";
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
	[POLICY_COMPILER_FILE, new Map([["*", new Set([DECISION_FILE])]])],
	["src/sync/plan-admission.ts", new Map([
		["admitBatchObservation", new Set(["src/sync/orchestrator.ts"])],
	])],
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
				result.push({ kind: "import", moduleName, importedName: "*" });
				continue;
			}
			if (clause.isTypeOnly) continue;
			if (clause.name) result.push({ kind: "import", moduleName, importedName: "default" });
			const bindings = clause.namedBindings;
			if (bindings && ts.isNamespaceImport(bindings)) {
				result.push({ kind: "import", moduleName, importedName: "*" });
			} else if (bindings && ts.isNamedImports(bindings)) {
				for (const element of bindings.elements) {
					if (!element.isTypeOnly) {
						result.push({
							kind: "import",
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
				result.push({ kind: "export", moduleName, importedName: "*" });
			} else if (ts.isNamespaceExport(statement.exportClause)) {
				result.push({ kind: "export", moduleName, importedName: "*" });
			} else if (ts.isNamedExports(statement.exportClause)) {
				if (statement.exportClause.elements.length === 0) {
					result.push({ kind: "export", moduleName, importedName: "*" });
				}
				for (const element of statement.exportClause.elements) {
					if (!element.isTypeOnly) {
					result.push({
						kind: "export",
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
			result.push({ kind: "dynamic", moduleName: node.arguments[0].text, importedName: "*" });
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
	const compilerBindings = new Set();
	for (const statement of sourceFile.statements) {
		if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) ||
			resolveTypeScriptModule(file, statement.moduleSpecifier.text) !== POLICY_COMPILER_FILE) continue;
		const bindings = statement.importClause?.namedBindings;
		if (!bindings || !ts.isNamedImports(bindings)) continue;
		for (const element of bindings.elements) {
			if (!element.isTypeOnly && (element.propertyName?.text ?? element.name.text) ===
				"compileSamePathConflictContract") compilerBindings.add(element.name.text);
		}
	}
	for (const statement of sourceFile.statements) {
		if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier ||
			!statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
		for (const element of statement.exportClause.elements) {
			const localName = element.propertyName?.text ?? element.name.text;
			assert.ok(!compilerBindings.has(localName),
				`${file} must not locally re-export the Admission conflict-policy compiler`);
		}
	}
	for (const item of valueImports(sourceFile)) {
		const target = resolveTypeScriptModule(file, item.moduleName);
		const moduleOwners = target ? VALUE_IMPORT_OWNERS.get(target) : undefined;
		if (!moduleOwners) continue;
		assert.notEqual(item.kind === "export" ? target : undefined, POLICY_COMPILER_FILE,
			`${file} must not re-export the Admission conflict-policy compiler`);
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
					? ["entries", "evidence", "baselinePaths", "observations", "candidateFacts", "scope", "namespace"]
					: ["paths", "entries", "evidence", "observations", "candidateFacts"]).sort(),
				`${node.name.text} must contain only observed facts`);
		}
		node.forEachChild(visit);
	};
	visit(source);
}

const RAW_STRATEGY_CARRIER_FILES = new Set([
	"src/__mocks__/sync-test-helpers.ts",
	"src/settings-normalize.ts",
	"src/settings.ts",
	"src/ui/settings.ts",
	"src/sync/types.ts",
	"src/sync/orchestrator.ts",
	"src/sync/sync-cycle-planning.ts",
	"src/sync/plan-admission.ts",
	DECISION_FILE,
	POLICY_COMPILER_FILE,
	"src/sync/conflict-action-contract.ts",
]);

const RAW_STRATEGY_SEMANTIC_FILES = new Set([
	"src/__mocks__/sync-test-helpers.ts",
	"src/settings-normalize.ts",
	"src/settings.ts",
	"src/ui/settings.ts",
	"src/sync/types.ts",
	DECISION_FILE,
	POLICY_COMPILER_FILE,
]);

const RAW_STRATEGY_SEMANTIC_FUNCTIONS = new Map([
	["src/sync/sync-cycle-planning.ts", new Set(["requiresConflictHashEnrichment"])],
	["src/sync/plan-admission.ts", new Set(["admitBatchObservation"])],
	["src/sync/conflict-action-contract.ts", new Set(["conflictContractViolation", "isConflictExecutionPolicy"])],
]);

function isAllowedRawStrategySite(node, file) {
	if (RAW_STRATEGY_SEMANTIC_FILES.has(file)) return true;
	const functions = RAW_STRATEGY_SEMANTIC_FUNCTIONS.get(file);
	if (!functions) return false;
	for (let current = node; current; current = current.parent) {
		if (ts.isFunctionDeclaration(current) && current.name && functions.has(current.name.text)) return true;
	}
	return false;
}

function isAuditStrategyProjection(node, file) {
	if (file !== "src/sync/execution-result.ts" || !ts.isPropertyAccessExpression(node) ||
		node.name.text !== "strategy") return false;
	const assignment = node.parent;
	return ts.isPropertyAssignment(assignment) && assignment.initializer === node &&
		assignment.name.getText() === "strategy" && node.expression.getText().endsWith(".action.conflictPolicy");
}

function isStrategyPropertyReference(node) {
	if (ts.isPropertyAccessExpression(node)) return node.name.text === "strategy";
	if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
		return node.argumentExpression.text === "strategy";
	}
	if (!ts.isBindingElement(node)) return false;
	const property = node.propertyName ?? node.name;
	return (ts.isIdentifier(property) || ts.isStringLiteralLike(property)) && property.text === "strategy";
}

function assertConflictPolicyBoundary(file, source) {
	let conflictActionSeen = false;
	const visit = (node) => {
		if (ts.isIdentifier(node)) {
			assert.notEqual(node.text, "preferLocalDisposition",
				`${file}: retired optional Prefer-local policy must not return`);
			if (!RAW_STRATEGY_CARRIER_FILES.has(file)) {
				assert.notEqual(node.text, "conflictStrategy",
					`${file}: non-owner must not receive raw conflict strategy`);
				assert.notEqual(node.text, "ConflictStrategy",
					`${file}: non-owner must not type or branch on raw conflict strategy`);
			}
		}
		if (ts.isStringLiteralLike(node) && ["auto_merge", "prefer_local", "duplicate"].includes(node.text) &&
			!isAllowedRawStrategySite(node, file)) {
			assert.fail(`${file}: non-owner must not reinterpret a raw conflict strategy literal`);
		}
		if (isStrategyPropertyReference(node) &&
			!isAllowedRawStrategySite(node, file) && !isAuditStrategyProjection(node, file)) {
			assert.fail(`${file}: action strategy provenance may only be projected into audit output`);
		}
		if (ts.isInterfaceDeclaration(node) && node.name.text === "ConflictAction") {
			conflictActionSeen = true;
			const members = new Map(node.members.map((member) => [member.name?.getText(source), member]));
			for (const name of ["action", "protocol", "conflictPolicy"]) {
				const member = members.get(name);
				assert.ok(member && !member.questionToken, `ConflictAction.${name} must be required`);
			}
		}
		node.forEachChild(visit);
	};
	visit(source);
	if (file === "src/sync/types.ts") assert.ok(conflictActionSeen, "ConflictAction contract is required");
}

test("production has only the fact-first Admission contract", () => {
	for (const path of productionTypeScriptFiles()) {
		const file = relative(ROOT, path);
		const source = parseSource(readFileSync(path, "utf8"), file);
		assertFactOnlyBoundary(file, source);
		assertConflictPolicyBoundary(file, source);
	}
});

test("guard rejects optional or downstream raw conflict policy", () => {
	assert.throws(() => assertConflictPolicyBoundary("src/sync/types.ts", parseSource(
		"interface ConflictAction { action: 'conflict'; protocol?: unknown; conflictPolicy?: unknown }",
		"src/sync/types.ts",
	)));
	assert.throws(() => assertConflictPolicyBoundary("src/sync/plan-executor.ts", parseSource(
		"interface ExecutionContext { conflictStrategy: string }",
		"src/sync/plan-executor.ts",
	)));
	assert.throws(() => assertConflictPolicyBoundary("src/sync/conflict-resolver.ts", parseSource(
		"function use(preferLocalDisposition: string) {}",
		"src/sync/conflict-resolver.ts",
	)));
	assert.throws(() => assertConflictPolicyBoundary("src/sync/conflict-resolver.ts", parseSource(
		"function resolve(strategy: ConflictStrategy) { return strategy === 'auto_merge'; }",
		"src/sync/conflict-resolver.ts",
	)));
	assert.throws(() => assertAllowedValueImports("src/sync/plan-executor.ts", parseSource(
		'import { compileSamePathConflictContract } from "./conflict-policy-admission";',
		"src/sync/plan-executor.ts",
	)));
	assert.throws(() => assertConflictPolicyBoundary("src/sync/conflict-resolver.ts", parseSource(
		"const selected = action.conflictPolicy.strategy; if (selected === 'duplicate') usePreservation();",
		"src/sync/conflict-resolver.ts",
	)));
	assert.throws(() => assertConflictPolicyBoundary("src/sync/conflict-resolver.ts", parseSource(
		"const { strategy } = action.conflictPolicy; if (strategy.startsWith('prefer')) useLocal();",
		"src/sync/conflict-resolver.ts",
	)));
	assert.throws(() => assertConflictPolicyBoundary("src/sync/conflict-resolver.ts", parseSource(
		"const selected = action.conflictPolicy['strategy']; if (selected) usePolicy();",
		"src/sync/conflict-resolver.ts",
	)));
	assert.throws(() => assertConflictPolicyBoundary("src/sync/sync-cycle-finalization.ts", parseSource(
		"function close(selected: ConflictStrategy) { return selected === 'prefer_local'; }",
		"src/sync/sync-cycle-finalization.ts",
	)));
	assert.throws(() => assertAllowedValueImports(DECISION_FILE, parseSource(
		'export { compileSamePathConflictContract } from "./conflict-policy-admission";',
		DECISION_FILE,
	)));
	assert.throws(() => assertAllowedValueImports(DECISION_FILE, parseSource(
		'import { compileSamePathConflictContract } from "./conflict-policy-admission";\n' +
		'export { compileSamePathConflictContract };',
		DECISION_FILE,
	)));
	assert.throws(() => assertAllowedValueImports("src/sync/plan-executor.ts", parseSource(
		'import { reexportedCompiler } from "./plan-admission";',
		"src/sync/plan-executor.ts",
	)));
	assert.throws(() => assertConflictPolicyBoundary("src/sync/conflict-action-contract.ts", parseSource(
		'export function compileAgain(strategy) { return strategy === "prefer_local"\n' +
		' ? { mode: "local_win", strategy } : { mode: "preserve", strategy }; }',
		"src/sync/conflict-action-contract.ts",
	)));
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
	for (const file of [DECISION_FILE, REPORT_FAMILY_FILE, POLICY_COMPILER_FILE]) {
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

function callsNamed(node, name) {
	let found = false;
	const visit = (current) => {
		if (ts.isCallExpression(current) && ts.isIdentifier(current.expression) && current.expression.text === name) found = true;
		current.forEachChild(visit);
	};
	node.forEachChild(visit);
	return found;
}

function namedFunction(source, name) {
	return source.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
}

function assertNoDirectExactMaterialization(source) {
	for (const name of ["ordinaryActionsAfterRelationAbandonment", "bindFiles"]) {
		const functionDeclaration = namedFunction(source, name);
		assert.ok(!functionDeclaration?.body || !callsNamed(functionDeclaration.body, "materializeFile"),
			`${name} must not hand-build an exact materialization`);
	}
}

function assertExactBindingDispatch(source) {
	const binder = namedFunction(source, "bindFiles");
	assert.ok(binder?.body, "bindFiles must remain the exact-binding dispatcher");
	const exactBindingPaths = [];
	const visit = (node) => {
		if (ts.isObjectLiteralExpression(node)) {
			const kind = node.properties.find((property) => ts.isPropertyAssignment(property) &&
				property.name.getText(source) === "kind");
			const path = node.properties.find((property) =>
				(ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
				property.name.getText(source) === "path");
			const capability = node.properties.find((property) => ts.isPropertyAssignment(property) &&
				property.name.getText(source) === "capability");
			if (kind && ts.isPropertyAssignment(kind) && ts.isStringLiteral(kind.initializer) &&
				kind.initializer.text === "exact" && path &&
				capability && ts.isPropertyAssignment(capability) && ts.isObjectLiteralExpression(capability.initializer) &&
				capability.initializer.properties.some((property) => ts.isPropertyAssignment(property) &&
					property.name.getText(source) === "kind" && ts.isStringLiteral(property.initializer) &&
					property.initializer.text === "propagate_confirmed_deletion")) {
				exactBindingPaths.push(ts.isPropertyAssignment(path)
					? path.initializer.getText(source) : path.name.getText(source));
			}
		}
		node.forEachChild(visit);
	};
	visit(binder.body);
	assert.deepEqual(exactBindingPaths.sort(), ["baseline.path", "path"],
		"bindFiles must dispatch baseline and unmatched-current paths through deletion-capable exact bindings");
}

test("one outcome-capability helper owns exact-path comparison and publication materialization", () => {
	const source = parseSource(readFileSync(join(ROOT, DECISION_FILE), "utf8"), DECISION_FILE);
	const capability = source.statements.find((statement) => ts.isTypeAliasDeclaration(statement) &&
		statement.type.getText(source).includes('"propagate_confirmed_deletion"') &&
		statement.type.getText(source).includes('"preserve_present_side"'));
	assert.ok(capability, "the exact-path capability must discriminate outcomes, not caller origin");
	const helper = source.statements.find((statement) => ts.isFunctionDeclaration(statement) &&
		statement.parameters.some((parameter) => parameter.type?.getText(source) === capability.name.text) &&
		statement.body && callsNamed(statement.body, "materializeFile"));
	assert.ok(helper && helper.name, "an outcome-capability exact-path helper must materialize the sole comparison/publication binding");
	const ordinary = namedFunction(source, "ordinaryActionsAfterRelationAbandonment");
	const binder = namedFunction(source, "bindFiles");
	const decision = namedFunction(source, "decideIdentityComponent");
	assert.ok(ordinary?.body && callsNamed(ordinary.body, helper.name.text), "relation abandonment must dispatch through the canonical helper");
	assert.ok(decision?.body && callsNamed(decision.body, helper.name.text), "exact bindings must dispatch through the canonical helper");
	assert.ok(binder?.body, "bindFiles must remain the exact-binding dispatcher");
	assertNoDirectExactMaterialization(source);
	assertExactBindingDispatch(source);
	const bypass = parseSource(`function ordinaryActionsAfterRelationAbandonment() { return materializeFile({ path: "a.md" }); }`, "fixture.ts");
	assert.throws(() => assertNoDirectExactMaterialization(bypass));
	const structuralTail = parseSource(`
		function bindFiles() {
			bound.push({ kind: "exact", path, capability: { kind: "propagate_confirmed_deletion" } });
			bound.push({ kind: "structural", binding: { path, publication: {} } });
		}
	`, "fixture.ts");
	assert.throws(() => assertExactBindingDispatch(structuralTail));
});
