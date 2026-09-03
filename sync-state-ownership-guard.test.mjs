const assert = process.getBuiltinModule("node:assert/strict");
const { readdirSync, readFileSync } = process.getBuiltinModule("node:fs");
const { join, relative } = process.getBuiltinModule("node:path");
const test = process.getBuiltinModule("node:test");

const ROOT = process.cwd();
const SOURCE_ROOT = join(ROOT, "src");

const ORCHESTRATOR_PRIVATE_FIELDS = [
	"syncMutex",
	"stateStore",
	"syncPending",
	"recoverViaColdScan",
	"priorityCoordinator",
	"localMutationBarrier",
	"activeBatch",
	"sessionId",
	"deps",
];

const CHECKPOINT_CALLERS = [
	"src/sync/sync-cycle-finalization.ts",
];

const SYNC_STATE_MUTATION_CALLERS = [
	"src/sync/opened-file-priority.ts",
	"src/sync/orchestrator.ts",
	"src/sync/state-committer.ts",
];

function productionTypeScriptFiles(directory = SOURCE_ROOT) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return productionTypeScriptFiles(path);
		return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
	});
}

function relativeSourcePaths(pattern) {
	return productionTypeScriptFiles()
		.filter((path) => pattern.test(readFileSync(path, "utf8")))
		.map((path) => relative(ROOT, path))
		.sort();
}

test("two-authority ownership fixture stays closed", () => {
	const orchestrator = readFileSync(join(SOURCE_ROOT, "sync/orchestrator.ts"), "utf8");
	const privateFields = [...orchestrator.matchAll(/^\tprivate (?:readonly )?(\w+)\b(?=\s*[!?:=])/gm)]
		.map((match) => match[1]);
	assert.deepEqual(privateFields, ORCHESTRATOR_PRIVATE_FIELDS);

	assert.deepEqual(relativeSourcePaths(/\.commitCheckpoint\(/), CHECKPOINT_CALLERS);
	assert.deepEqual(
		relativeSourcePaths(/\b(?:this\.)?stateStore\.(?:put(?:Content)?|delete|clear|rewritePaths|compareAndPut|compareAndMove)\(/),
		SYNC_STATE_MUTATION_CALLERS,
	);
});
