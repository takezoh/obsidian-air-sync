const assert = process.getBuiltinModule("node:assert/strict");
const { readdirSync, readFileSync } = process.getBuiltinModule("node:fs");
const { join, relative } = process.getBuiltinModule("node:path");
const test = process.getBuiltinModule("node:test");
const ts = await import("typescript");

const ROOT = process.cwd();
const SOURCE_ROOT = join(ROOT, "src");
const MUTATING_SYNC_STATE_METHODS = new Set([
	"put", "putContent", "delete", "clear", "rewritePaths", "compareAndPut", "compareAndMove",
]);

const ORCHESTRATOR_INSTANCE_FIELDS = [
	"syncMutex", "stateStore", "syncPending", "recoverViaColdScan", "priorityCoordinator",
	"localMutationBarrier", "activeBatch", "sessionId", "deps",
];
const CHECKPOINT_CALLERS = ["src/sync/sync-cycle-finalization.ts"];
const SYNC_STATE_STORE = {
	imports: [
		"src/sync/change-detector.ts", "src/sync/conflict-resolver.ts", "src/sync/conflict.ts",
		"src/sync/opened-file-priority.ts", "src/sync/orchestrator.ts", "src/sync/state-committer.ts",
	],
	references: [
		"src/sync/change-detector.ts", "src/sync/conflict-resolver.ts", "src/sync/conflict.ts",
		"src/sync/opened-file-priority.ts", "src/sync/orchestrator.ts", "src/sync/state-committer.ts",
	],
	constructors: ["src/sync/orchestrator.ts"],
	mutationCallers: [
		"src/sync/opened-file-priority.ts", "src/sync/orchestrator.ts", "src/sync/state-committer.ts",
	],
};
const IDB_HELPER = {
	imports: ["src/store/metadata-store.ts", "src/sync/state.ts"],
	references: ["src/store/metadata-store.ts", "src/sync/state.ts"],
	constructors: ["src/store/metadata-store.ts", "src/sync/state.ts"],
};

function productionTypeScriptFiles(directory = SOURCE_ROOT) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return entry.name === "__mocks__" ? [] : productionTypeScriptFiles(path);
		return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
	});
}

function parseSource(text, fileName) {
	return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function hasModifier(node, kind) {
	return node.modifiers?.some((modifier) => modifier.kind === kind) ?? false;
}

function propertyNameText(name, sourceFile) {
	if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
		return name.text;
	}
	if (ts.isComputedPropertyName(name)) {
		const expression = name.expression;
		if (ts.isStringLiteral(expression) || ts.isNumericLiteral(expression)) return expression.text;
		return `[${expression.getText(sourceFile)}]`;
	}
	return name.getText(sourceFile);
}

function bindingNames(name, sourceFile) {
	if (ts.isIdentifier(name)) return [name.text];
	if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
		return name.elements.flatMap((element) => ts.isBindingElement(element)
			? bindingNames(element.name, sourceFile)
			: []);
	}
	return [name.getText(sourceFile)];
}

function typeMentions(type, symbolName) {
	if (!type) return false;
	let found = false;
	const visit = (node) => {
		if (ts.isTypeReferenceNode(node) && node.typeName.getText() === symbolName) found = true;
		ts.forEachChild(node, visit);
	};
	visit(type);
	return found;
}

function syncOrchestratorInstanceFields(sourceFile) {
	const fields = [];
	const visit = (node) => {
		if (ts.isClassDeclaration(node) && node.name?.text === "SyncOrchestrator") {
			for (const member of node.members) {
				if (ts.isPropertyDeclaration(member) && !hasModifier(member, ts.SyntaxKind.StaticKeyword)) {
					fields.push(propertyNameText(member.name, sourceFile));
				}
				if (ts.isConstructorDeclaration(member)) {
					for (const parameter of member.parameters) {
						const isParameterProperty = [
							ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ProtectedKeyword,
							ts.SyntaxKind.PublicKeyword, ts.SyntaxKind.ReadonlyKeyword,
						].some((kind) => hasModifier(parameter, kind));
						if (isParameterProperty) fields.push(...bindingNames(parameter.name, sourceFile));
					}
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return fields;
}

function importedLocalNames(sourceFile, symbolName) {
	const localNames = new Set();
	for (const statement of sourceFile.statements) {
		if (!ts.isImportDeclaration(statement) || !statement.importClause?.namedBindings ||
			!ts.isNamedImports(statement.importClause.namedBindings)) continue;
		for (const specifier of statement.importClause.namedBindings.elements) {
			if ((specifier.propertyName?.text ?? specifier.name.text) === symbolName) localNames.add(specifier.name.text);
		}
	}
	return localNames;
}

function identifierIsImportBinding(node) {
	return ts.isImportSpecifier(node.parent) && node.parent.name === node;
}

function callName(expression) {
	if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
	if (ts.isElementAccessExpression(expression) && expression.argumentExpression &&
		(ts.isStringLiteral(expression.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(expression.argumentExpression))) {
		return expression.argumentExpression.text;
	}
	return undefined;
}

function callReceiver(expression) {
	if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) return expression.expression;
	return undefined;
}

function syncStateMutationCalls(sourceFile, localNames) {
	const aliases = new Set();
	const syncStateProperties = new Set();
	const addTypedBinding = (name, type) => {
		if (typeMentions(type, "SyncStateStore")) {
			for (const binding of bindingNames(name, sourceFile)) aliases.add(binding);
		}
	};
	const isReceiver = (expression) => {
		while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
		if (ts.isIdentifier(expression)) return aliases.has(expression.text) || localNames.has(expression.text);
		if (ts.isNewExpression(expression) && ts.isIdentifier(expression.expression)) return localNames.has(expression.expression.text);
		if (ts.isPropertyAccessExpression(expression)) return syncStateProperties.has(expression.name.text);
		if (ts.isElementAccessExpression(expression) && expression.argumentExpression &&
			(ts.isStringLiteral(expression.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(expression.argumentExpression))) {
			return syncStateProperties.has(expression.argumentExpression.text);
		}
		return false;
	};
	const mutations = [];
	const visit = (node) => {
		if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) {
			if (typeMentions(node.type, "SyncStateStore")) syncStateProperties.add(propertyNameText(node.name, sourceFile));
		}
		if (ts.isParameter(node)) addTypedBinding(node.name, node.type);
		if (ts.isVariableDeclaration(node)) {
			addTypedBinding(node.name, node.type);
			if (node.initializer && isReceiver(node.initializer)) {
				for (const binding of bindingNames(node.name, sourceFile)) aliases.add(binding);
			}
		}
		if (ts.isCallExpression(node)) {
			const name = callName(node.expression);
			const receiver = callReceiver(node.expression);
			if (name && receiver && MUTATING_SYNC_STATE_METHODS.has(name) && isReceiver(receiver)) mutations.push(node);
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return mutations;
}

function sourceInventory(sourceFile) {
	const result = Object.fromEntries(["SyncStateStore", "IDBHelper"].map((symbol) => [symbol, {
		imports: false, references: false, constructors: false, mutations: false,
	}]));
	for (const symbol of ["SyncStateStore", "IDBHelper"]) {
		const localNames = importedLocalNames(sourceFile, symbol);
		result[symbol].imports = localNames.size > 0;
		if (symbol === "SyncStateStore") result[symbol].mutations = syncStateMutationCalls(sourceFile, localNames).length > 0;
		const visit = (node) => {
			if (ts.isIdentifier(node) && localNames.has(node.text) && !identifierIsImportBinding(node)) result[symbol].references = true;
			if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && localNames.has(node.expression.text)) {
				result[symbol].constructors = true;
			}
			ts.forEachChild(node, visit);
		};
		visit(sourceFile);
	}
	return result;
}

function inventoryProductionSources(files = productionTypeScriptFiles()) {
	const inventory = {
		orchestratorFields: [], checkpointCallers: [],
		syncStateStore: { imports: [], references: [], constructors: [], mutationCallers: [] },
		idbHelper: { imports: [], references: [], constructors: [] },
	};
	for (const path of files) {
		const sourceFile = parseSource(readFileSync(path, "utf8"), path);
		const file = relative(ROOT, path);
		if (file === "src/sync/orchestrator.ts") inventory.orchestratorFields = syncOrchestratorInstanceFields(sourceFile);
		const source = sourceInventory(sourceFile);
		for (const [symbol, target] of [["SyncStateStore", inventory.syncStateStore], ["IDBHelper", inventory.idbHelper]]) {
			const current = source[symbol];
			if (current.imports) target.imports.push(file);
			if (current.references) target.references.push(file);
			if (current.constructors) target.constructors.push(file);
			if (symbol === "SyncStateStore" && current.mutations) target.mutationCallers.push(file);
		}
		let hasCheckpointCall = false;
		const visit = (node) => {
			if (ts.isCallExpression(node) && callName(node.expression) === "commitCheckpoint") hasCheckpointCall = true;
			ts.forEachChild(node, visit);
		};
		visit(sourceFile);
		if (hasCheckpointCall) inventory.checkpointCallers.push(file);
	}
	for (const value of [inventory.checkpointCallers, ...Object.values(inventory.syncStateStore), ...Object.values(inventory.idbHelper)]) {
		if (Array.isArray(value)) value.sort();
	}
	return inventory;
}

function assertClosedInventory(inventory) {
	assert.deepEqual(inventory.orchestratorFields, ORCHESTRATOR_INSTANCE_FIELDS);
	assert.deepEqual(inventory.checkpointCallers, CHECKPOINT_CALLERS);
	assert.deepEqual(inventory.syncStateStore, SYNC_STATE_STORE);
	assert.deepEqual(inventory.idbHelper, IDB_HELPER);
}

test("two-authority ownership fixture stays closed", () => {
	assertClosedInventory(inventoryProductionSources());
});

test("guard rejects a new SyncOrchestrator recovery field in any property form", () => {
	const source = parseSource(`class SyncOrchestrator {
		protected ["recoverViaNetwork"] = false;
		constructor(private readonly session: string) {}
	}`, "synthetic-orchestrator.ts");
	assert.throws(() => assert.deepEqual(syncOrchestratorInstanceFields(source), ["session"]));
});

test("guard rejects aliased and bracketed SyncStateStore mutations", () => {
	const source = parseSource(`import { SyncStateStore } from "./state";
		async function save(stateStore: SyncStateStore) {
			const records = stateStore;
			await records["put"]({} as never);
		}`, "synthetic-state-mutation.ts");
	const sourceState = sourceInventory(source);
	assert.equal(sourceState.SyncStateStore.mutations, true);
	assert.throws(() => assert.deepEqual(sourceState.SyncStateStore.mutations, false));
});

test("guard rejects a third IDBHelper owner", () => {
	const source = parseSource(`import { IDBHelper } from "./idb-helper";
		class ExtraPersistentStore {
			helper = new IDBHelper({} as never);
		}`, "synthetic-idb-owner.ts");
	const sourceState = sourceInventory(source);
	assert.equal(sourceState.IDBHelper.constructors, true);
	assert.throws(() => assert.deepEqual(sourceState.IDBHelper.constructors, false));
});
