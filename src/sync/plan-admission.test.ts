import { describe, expect, it } from "vitest";
import type { FileEntity } from "../fs/types";
import {
	admitBatchObservation,
	type AdmissionDisposition,
	type AuthorizedSyncPlan,
} from "./plan-admission";
import { captureBatchObservation } from "./sync-cycle-planning";
import { completeIdentityEvidence } from "./identity-evidence";
import { decideIdentityComponent } from "./identity-component-decision";
import { compileSamePathConflictContract } from "./conflict-policy-admission";
import { insertConflictSuffix } from "./conflict";
import type { IdentityComponent } from "./plan-admission-graph";
import type {
	IdentityEvidence,
	PathObservation,
	ScopeDisposition,
	ScopeProjection,
	SyncAction,
	SyncActionType,
	SyncRecord,
	MixedEntity,
	CandidateFact,
	ConflictStrategy,
} from "./types";

interface FixtureAction {
	readonly path: string;
	readonly action: SyncActionType;
	readonly oldPath?: string;
	readonly local?: FileEntity;
	readonly remote?: FileEntity;
	readonly baseline?: SyncRecord;
}

function entity(path: string, identityKey?: string): FileEntity {
	return { path, identityKey, pathAuthority: "actual_resolved", isDirectory: false, size: 1, mtime: 1, hash: "h" };
}

function freshEntity(path: string, hash: string, identityKey?: string): FileEntity {
	return { path, hash, identityKey, pathAuthority: "actual_resolved", isDirectory: false, size: 1, mtime: 1 };
}

// The record layer's floor requires a non-empty identity, so a fixture entity that
// deliberately carries none still yields a baseline keyed by an identity no current
// entity holds. Nothing here folds an absent identity to the empty string.
function recordFor(current: FileEntity, remoteIdentityKey = current.identityKey ?? `id:${current.path}`): SyncRecord {
	return {
		path: current.path, hash: current.hash, localMtime: current.mtime,
		remoteMtime: current.mtime, localSize: current.size, remoteSize: current.size,
		remoteIdentityKey, syncedAt: 1,
	};
}

function projection(entries: Record<string, ScopeDisposition>): ScopeProjection {
	return { isConfiguredScopeCompatible: () => true, byEndpoint: new Map(Object.entries(entries)) };
}

function vacantCandidates(base: string, hashes: readonly string[]): PathObservation[] {
	return hashes.flatMap((hash) => {
		const path = insertConflictSuffix(base, hash);
		return (["local", "remote"] as const).map((side) => ({
			kind: "absent" as const, side, requestedPath: path, authority: "stat" as const,
		}));
	});
}

/** Legacy case fixtures contribute endpoint/record data only. Action kinds and
 * execution payloads are deliberately absent from the public Admission input.
 */
function captureFixtureFacts(
	fixtures: { actions: FixtureAction[] }, evidence: readonly IdentityEvidence[],
	observations: readonly PathObservation[], scope: ScopeProjection, namespace: string,
	baselinePaths?: readonly string[], entries: readonly MixedEntity[] = [],
	candidateFacts: readonly CandidateFact[] = [],
) {
	return captureBatchObservation([
		...entries,
		...fixtures.actions.map(({ path, local, remote, baseline }) => ({ path, local, remote, prevSync: baseline })),
	], evidence, observations, scope, namespace, baselinePaths, candidateFacts);
}

function fixtureCandidateFacts(
	actions: readonly FixtureAction[], entries: readonly MixedEntity[], evidence: readonly IdentityEvidence[],
	observations: readonly PathObservation[], extra: readonly PathObservation[],
): CandidateFact[] {
	const allEntries = [
		...entries,
		...actions.map(({ path, local, remote, baseline }) => ({ path, local, remote, prevSync: baseline })),
	];
	const anchors = new Set(evidence.flatMap((item) => item.kind === "alias"
		? [item.requestedPath, item.resolvedPath] : []));
	const hashes = new Set(allEntries.flatMap((entry) => [entry.local?.hash, entry.remote?.hash]
		.filter((hash): hash is string => !!hash)));
	const requested = new Set([...anchors].flatMap((anchor) =>
		[...hashes].map((hash) => insertConflictSuffix(anchor, hash))));
	const allObservations = [...observations, ...extra];
	return [...requested].flatMap((requestedPath) => {
		const local = allObservations.find((item) => item.side === "local" && item.requestedPath === requestedPath);
		const remote = allObservations.find((item) => item.side === "remote" && item.requestedPath === requestedPath);
		if (!local || !remote) return [];
		return [{
			requestedPath, local, remote,
			baseline: allEntries.find((entry) => entry.prevSync?.path === requestedPath)?.prevSync ?? null,
		}];
	});
}

function admit(
	actions: FixtureAction[],
	evidence: IdentityEvidence[] = [],
	observations: PathObservation[] = [],
	scope?: ScopeProjection,
	entries: MixedEntity[] = [],
	candidateObservations: PathObservation[] = [],
	conflictStrategy: ConflictStrategy = "auto_merge",
) {
	const candidateFacts = fixtureCandidateFacts(actions, entries, evidence, observations, candidateObservations);
	return admitBatchObservation(captureFixtureFacts(
		{ actions }, evidence, observations, scope ?? projection(Object.fromEntries([
			...actions.map(({ path }) => path), ...entries.map(({ path }) => path),
			...observations.map(({ requestedPath }) => requestedPath),
			...evidence.flatMap((item) => item.kind === "rename" ? [item.oldPath, item.newPath]
				: item.kind === "alias" ? [item.requestedPath, item.resolvedPath] : item.occurrences.map(({ path }) => path)),
		].map((path) => [path, "included"]))), "backend\0root", undefined, entries, candidateFacts,
	), conflictStrategy);
}

function remoteRename(
	overrides: Partial<Extract<IdentityEvidence, { kind: "rename" }>> = {},
): Extract<IdentityEvidence, { kind: "rename" }> {
	return {
		kind: "rename", side: "remote", oldPath: "A.md", newPath: "B.md",
		isFolder: false, authority: "reported", identityKey: "X", ...overrides,
	};
}

function countedArray<T>(values: readonly T[], counter: { reads: number }): T[] {
	return new Proxy([...values], {
		get(target, property, receiver) {
			if (property === Symbol.iterator) {
				return function* iterator() {
					for (let index = 0; index < target.length; index++) {
						counter.reads++;
						yield target[index]!;
					}
				};
			}
			if (typeof property === "string" && /^\d+$/.test(property)) counter.reads++;
			return Reflect.get(target, property, receiver) as unknown;
		},
	});
}

function countedMap<K, V>(
	entries: readonly (readonly [K, V])[],
	counter: { reads: number },
): ReadonlyMap<K, V> {
	const map = new Map(entries);
	const count = function* <T>(values: Iterable<T>): IterableIterator<T> {
		for (const value of values) {
			counter.reads++;
			yield value;
		}
	};
	return {
		get size() { return map.size; },
		get(key) { counter.reads++; return map.get(key); },
		has(key) { counter.reads++; return map.has(key); },
		entries() { return count(map.entries()); },
		keys() { return count(map.keys()); },
		values() { return count(map.values()); },
		forEach(callback, thisArg) {
			for (const [key, value] of count(map.entries())) callback.call(thisArg, value, key, this);
		},
		[Symbol.iterator]() { return count(map.entries()); },
	};
}

function caseAliasFixture(
	local: FileEntity = entity("case.md"),
	remote: FileEntity = entity("Case.md", "R"),
) {
	const actions: FixtureAction[] = [
		{ path: "Case.md", action: "pull", remote },
		{ path: "case.md", action: "push", local },
	];
	const evidence: IdentityEvidence[] = [
		{ kind: "alias", side: "local", requestedPath: "Case.md", resolvedPath: "case.md" },
	];
	const observations: PathObservation[] = [
		{ kind: "alias", side: "local", requestedPath: "Case.md", resolvedPath: "case.md", entity: local },
		{ kind: "exact", side: "local", requestedPath: "case.md", entity: local },
		{ kind: "exact", side: "remote", requestedPath: "Case.md", entity: remote },
		{ kind: "absent", side: "remote", requestedPath: "case.md", authority: "stat" },
	];
	const entries: MixedEntity[] = [
		{ path: "Case.md", remote },
		{ path: "case.md", local },
	];
	return {
		local, remote, actions, evidence, observations,
		scope: projection({ "Case.md": "included", "case.md": "included" }),
		entries,
	};
}

/** Complete current folder endpoints, independent of any proposed action. */
function folderFacts(suffixes: readonly string[] = ["x.md"]) {
	const entries: MixedEntity[] = [
		{ path: "A", local: { ...entity("A"), isDirectory: true } },
		{ path: "B", remote: { ...entity("B", "root"), isDirectory: true } },
	];
	const directories = new Set<string>();
	for (const suffix of suffixes) {
		const segments = suffix.split("/");
		for (let length = 1; length < segments.length; length++) directories.add(segments.slice(0, length).join("/"));
		entries.push({ path: `A/${suffix}`, local: entity(`A/${suffix}`),
			prevSync: { ...recordFor(entity(`B/${suffix}`, `file:${suffix}`)), path: `A/${suffix}` } },
			{ path: `B/${suffix}`, remote: entity(`B/${suffix}`, `file:${suffix}`) });
	}
	for (const suffix of directories) entries.push(
		{ path: `A/${suffix}`, local: { ...entity(`A/${suffix}`), isDirectory: true } },
		{ path: `B/${suffix}`, remote: { ...entity(`B/${suffix}`, `folder:${suffix}`), isDirectory: true } },
	);
	const observations: PathObservation[] = entries.flatMap(({ path, local, remote }) => [
		local ? { kind: "exact" as const, side: "local" as const, requestedPath: path, entity: local }
			: { kind: "absent" as const, side: "local" as const, requestedPath: path, authority: "stat" as const },
		remote ? { kind: "exact" as const, side: "remote" as const, requestedPath: path, entity: remote }
			: { kind: "absent" as const, side: "remote" as const, requestedPath: path, authority: "stat" as const },
	]);
	return {
		entries, observations,
		evidence: [remoteRename({ oldPath: "A", newPath: "B", isFolder: true, identityKey: "root" })] as IdentityEvidence[],
		scope: projection(Object.fromEntries(entries.map(({ path }) => [path, "included"]))),
	};
}

describe("admitBatchObservation", () => {
	it("keeps Prefer-local local-win behind every compiler proof predicate", () => {
		type SamePathConflictFacts = Parameters<typeof compileSamePathConflictContract>[0];
		const baseline = recordFor(freshEntity("note.md", "base", "R"));
		const local = freshEntity("note.md", "local");
		const remote = freshEntity("note.md", "remote", "R");
		const facts: SamePathConflictFacts = {
			path: "note.md", local, remote, baseline,
			hasMove: false, replacement: false,
			hasAdditionalRemote: false, hasAdditionalLocal: false,
			hasLocalPathOverride: false, hasRemotePathOverride: false,
		};
		expect(compileSamePathConflictContract(facts, "prefer_local", true).conflictPolicy)
			.toEqual({ mode: "local_win", strategy: "prefer_local" });

		const fallbacks: Array<[string, SamePathConflictFacts, boolean?]> = [
			["disabled", facts, false],
			["missing local", { ...facts, local: undefined }],
			["missing remote", { ...facts, remote: undefined }],
			["missing baseline", { ...facts, baseline: undefined }],
			["missing baseline hash", { ...facts, baseline: { ...baseline, hash: "" } }],
			["baseline path mismatch", { ...facts, baseline: { ...baseline, path: "old.md" } }],
			["local path mismatch", { ...facts, local: { ...local, path: "local.md" } }],
			["remote path mismatch", { ...facts, remote: { ...remote, path: "remote.md" } }],
			["move", { ...facts, hasMove: true }],
			["replacement", { ...facts, replacement: true }],
			["additional remote", { ...facts, hasAdditionalRemote: true }],
			["additional local", { ...facts, hasAdditionalLocal: true }],
			["local path override", { ...facts, hasLocalPathOverride: true }],
			["remote path override", { ...facts, hasRemotePathOverride: true }],
			["missing local hash", { ...facts, local: { ...local, hash: "" } }],
			["missing remote hash", { ...facts, remote: { ...remote, hash: "" } }],
			["unchanged local", { ...facts, local: { ...local, hash: baseline.hash } }],
			["unchanged remote", { ...facts, remote: { ...remote, hash: baseline.hash } }],
			["equal sides", { ...facts, remote: { ...remote, hash: local.hash } }],
		];
		for (const [name, candidate, allowLocalWin = true] of fallbacks) {
			expect(compileSamePathConflictContract(candidate, "prefer_local", allowLocalWin).conflictPolicy,
				name).toEqual({ mode: "preserve", strategy: "prefer_local" });
		}
	});

	it("compiles every conflict strategy into one closed action policy", () => {
		const baseline = recordFor(freshEntity("note.md", "base", "R"));
		const local = freshEntity("note.md", "local");
		const remote = freshEntity("note.md", "remote", "R");
		const observations: PathObservation[] = [
			{ kind: "exact", side: "local", requestedPath: "note.md", entity: local },
			{ kind: "exact", side: "remote", requestedPath: "note.md", entity: remote },
		];
		const component: IdentityComponent = {
			paths: new Set(["note.md"]),
			entries: [{ path: "note.md", local, remote, prevSync: baseline }],
			evidence: [], observations,
		};

		const proven = decideIdentityComponent(
			component, projection({ "note.md": "included" }), undefined, "prefer_local",
		);
		const unprovenLocal = { ...local, hash: "", mtime: 2 };
		const uncertain = decideIdentityComponent({
			...component,
			entries: [{ path: "note.md", local: unprovenLocal, remote, prevSync: baseline }],
			observations: [
				{ kind: "exact", side: "local", requestedPath: "note.md", entity: unprovenLocal },
				{ kind: "exact", side: "remote", requestedPath: "note.md", entity: remote },
			],
		}, projection({ "note.md": "included" }), undefined, "prefer_local");
		const autoMerge = decideIdentityComponent(
			component, projection({ "note.md": "included" }), undefined, "auto_merge",
		);
		const duplicate = decideIdentityComponent(
			component, projection({ "note.md": "included" }), undefined, "duplicate",
		);

		expect(proven.component.actions).toMatchObject([{
			action: "conflict", conflictPolicy: { mode: "local_win", strategy: "prefer_local" },
		}]);
		expect(uncertain.component.actions).toMatchObject([{
			action: "conflict", conflictPolicy: { mode: "preserve", strategy: "prefer_local" },
		}]);
		expect(autoMerge.component.actions).toMatchObject([{
			action: "conflict", conflictPolicy: { mode: "auto_merge", strategy: "auto_merge" },
		}]);
		expect(duplicate.component.actions).toMatchObject([{
			action: "conflict", conflictPolicy: { mode: "preserve", strategy: "duplicate" },
		}]);
	});

	it("keeps edit-delete on the existing survivor route under Prefer local", () => {
		const baseline = recordFor(freshEntity("note.md", "base", "R"));
		const remote = freshEntity("note.md", "remote", "R");
		const component: IdentityComponent = {
			paths: new Set(["note.md"]),
			entries: [{ path: "note.md", remote, prevSync: baseline }],
			evidence: [],
			observations: [
				{ kind: "absent", side: "local", requestedPath: "note.md", authority: "stat" },
				{ kind: "exact", side: "remote", requestedPath: "note.md", entity: remote },
			],
		};

		const decision = decideIdentityComponent(
			component, projection({ "note.md": "included" }), undefined, "prefer_local",
		);

		expect(decision.component.actions).toMatchObject([{
			action: "conflict", local: undefined, remote,
			protocol: { kind: "same_path" }, conflictPolicy: { mode: "preserve", strategy: "prefer_local" },
		}]);
	});

	it("preserves both sides on a Prefer-local cold start without a common baseline", () => {
		const local = freshEntity("note.md", "local");
		const remote = freshEntity("note.md", "remote", "R");
		const component: IdentityComponent = {
			paths: new Set(["note.md"]),
			entries: [{ path: "note.md", local, remote }],
			evidence: [],
			observations: [
				{ kind: "exact", side: "local", requestedPath: "note.md", entity: local },
				{ kind: "exact", side: "remote", requestedPath: "note.md", entity: remote },
			],
		};

		const decision = decideIdentityComponent(
			component, projection({ "note.md": "included" }), undefined, "prefer_local",
		);

		expect(decision.component.actions).toMatchObject([{
			action: "conflict", protocol: { kind: "same_path" }, conflictPolicy: { mode: "preserve", strategy: "prefer_local" },
		}]);
	});

	it.each(["local", "remote"] as const)("rejects a %s directory colliding with a file at the same current address", (directorySide) => {
		const local = { ...entity("same"), isDirectory: directorySide === "local" };
		const remote = { ...entity("same", "R"), isDirectory: directorySide === "remote" };
		const result = admitBatchObservation(captureBatchObservation([{ path: "same", local, remote }], [], [
			{ kind: "exact", side: "local", requestedPath: "same", entity: local },
			{ kind: "exact", side: "remote", requestedPath: "same", entity: remote },
		], projection({ same: "included" }), "backend\0root"));
		expect(result.executable.actions).toEqual([]);
		expect(result.dispositions.map(({ kind }) => kind)).toEqual(["failed"]);
		expect(result.failures[0]?.reasons).toContain("conflicting_identity");
	});
	it("constructs and authorizes exact actions from a fact-only batch observation", () => {
		const previous: SyncRecord = {
			path: "conflict.md", hash: "base", localMtime: 1, remoteMtime: 1,
			localSize: 1, remoteSize: 1, remoteIdentityKey: "id:conflict.md", syncedAt: 1,
		};
		const localOnly = entity("local.md");
		const localChanged = freshEntity("conflict.md", "local");
		const remoteChanged = freshEntity("conflict.md", "remote", "R");
		const result = admitBatchObservation(captureBatchObservation(
			[
				{ path: "local.md", local: localOnly },
				{
					path: "conflict.md", local: localChanged,
					remote: remoteChanged, prevSync: previous,
				},
			],
			[],
			[
				{ kind: "exact", side: "local", requestedPath: "local.md", entity: localOnly },
				{ kind: "absent", side: "remote", requestedPath: "local.md", authority: "stat" },
				{ kind: "exact", side: "local", requestedPath: "conflict.md", entity: localChanged },
				{ kind: "exact", side: "remote", requestedPath: "conflict.md", entity: remoteChanged },
			],
			projection({ "local.md": "included", "conflict.md": "included" }),
			"backend\0root",
		));

		expect(result.executable.actions.map(({ path, action }) => ({ path, action }))).toEqual([
			{ path: "conflict.md", action: "conflict" },
			{ path: "local.md", action: "push" },
		]);
		expect(result.dispositions.map(({ kind }) => kind)).toEqual(["authorized", "authorized"]);
		expect(result.failures).toEqual([]);
	});

	it("admits a genuine exact-path remote deletion without identity evidence", () => {
		const action: SyncAction = { path: "gone.md", action: "delete_local", local: entity("gone.md"), baseline: recordFor(entity("gone.md")) };

		const result = admit([action], [], [{
			kind: "absent", side: "remote", requestedPath: "gone.md", authority: "checkpoint_deleted",
		}]);

		expect(result.executable.actions).toEqual([expect.objectContaining({ ...action,
			publication: { source: action.baseline, destination: action.baseline } })]);
		expect(result.failures).toEqual([]);
	});

	it("retains a local rename when the additive proof has unknown current scope", () => {
		const action: SyncAction = { path: "B.md", action: "push", local: entity("B.md") };
		const evidence = [remoteRename({ side: "local", identityKey: undefined })];
		const observations: PathObservation[] = [
			{ kind: "unknown", side: "local", requestedPath: "A.md", reason: "not_observed" },
			{ kind: "absent", side: "remote", requestedPath: "A.md", authority: "stat" },
			{ kind: "exact", side: "local", requestedPath: "B.md", entity: entity("B.md") },
			{ kind: "absent", side: "remote", requestedPath: "B.md", authority: "stat" },
		];

		const result = admit([action], evidence, observations, projection({
			"A.md": "unknown", "B.md": "included",
		}));

		expect(result.executable.actions).toEqual([]);
		expect(result.failures[0]?.reasons).toContain("unknown_observation");
	});

	it("publishes equal already-aligned endpoints instead of replaying an earlier local rename", () => {
		const action: SyncAction = { path: "B.md", action: "push", local: entity("B.md") };
		const evidence = [remoteRename({ side: "local", identityKey: undefined })];
		const observations: PathObservation[] = [
			{ kind: "absent", side: "local", requestedPath: "A.md", authority: "stat" },
			{ kind: "absent", side: "remote", requestedPath: "A.md", authority: "stat" },
			{ kind: "exact", side: "local", requestedPath: "B.md", entity: entity("B.md") },
			{ kind: "exact", side: "remote", requestedPath: "B.md", entity: entity("B.md", "remote") },
		];

		const result = admit([action], evidence, observations, projection({
			"A.md": "included", "B.md": "included",
		}));

		expect(result.failures).toEqual([]);
		expect(result.executable.actions).toEqual([expect.objectContaining({ action: "match", path: "B.md",
			publication: { source: undefined, destination: undefined } })]);
	});

	it("retains a local rename when the source has baseline membership", () => {
		const action: SyncAction = { path: "B.md", action: "push", local: entity("B.md") };
		const evidence = [remoteRename({ side: "local", identityKey: undefined })];
		const observations: PathObservation[] = [
			{ kind: "absent", side: "local", requestedPath: "A.md", authority: "stat" },
			{ kind: "absent", side: "remote", requestedPath: "A.md", authority: "stat" },
			{ kind: "exact", side: "local", requestedPath: "B.md", entity: entity("B.md") },
			{ kind: "absent", side: "remote", requestedPath: "B.md", authority: "stat" },
		];
		const snapshot = captureFixtureFacts(
			{ actions: [action] }, evidence, observations,
			projection({ "A.md": "included", "B.md": "included" }), "backend\0root", ["A.md"],
		);

		const result = admitBatchObservation(snapshot);

		expect(result.executable.actions).toEqual([]);
	});

	it("admits only the terminal push for an unbaselined local rename chain", () => {
		const action: SyncAction = { path: "C.md", action: "push", local: entity("C.md") };
		const evidence = [
			remoteRename({ side: "local", identityKey: undefined, oldPath: "A.md", newPath: "B.md" }),
			remoteRename({ side: "local", identityKey: undefined, oldPath: "B.md", newPath: "C.md" }),
		];
		const observations: PathObservation[] = [
			...(["A.md", "B.md"] as const).flatMap((path) => [
				{ kind: "absent" as const, side: "local" as const, requestedPath: path, authority: "stat" as const },
				{ kind: "absent" as const, side: "remote" as const, requestedPath: path, authority: "stat" as const },
			]),
			{ kind: "exact", side: "local", requestedPath: "C.md", entity: entity("C.md") },
			{ kind: "absent", side: "remote", requestedPath: "C.md", authority: "stat" },
		];

		const result = admit([action], evidence, observations, projection({
			"A.md": "included", "B.md": "included", "C.md": "included",
		}));

		expect(result.failures).toEqual([]);
		expect(result.executable.actions).toEqual([{
			...action, publication: { source: undefined, destination: undefined },
		}]);
	});

	it("defers unobserved case-distinct deletions independently", () => {
		const actions: FixtureAction[] = [
			{ path: "A.md", action: "delete_local", local: entity("A.md") },
			{ path: "a.md", action: "delete_remote", remote: entity("a.md") },
		];

		const result = admit(actions);

		expect(result.executable.actions).toEqual([]);
		expect(result.failures).toHaveLength(2);
		expect(result.failures.map((item) => item.reasons)).toEqual([
			["unknown_observation"], ["unknown_observation"],
		]);
	});

	it("defers both opposing deletes joined by stable identity", () => {
		const actions: FixtureAction[] = [
			{ path: "A.md", action: "delete_local", local: entity("A.md") },
			{ path: "a.md", action: "delete_remote", remote: entity("a.md", "X") },
		];
		const evidence: IdentityEvidence[] = [{
			kind: "stable_identity", side: "remote", identityKey: "X", occurrences: [
				{ side: "remote", phase: "baseline", path: "A.md", identityKey: "X" },
				{ side: "remote", phase: "current", path: "a.md", identityKey: "X" },
			],
		}];

		const result = admit(actions, evidence);

		expect(result.executable.actions).toEqual([]);
		expect(result.failures[0]).toMatchObject({
			paths: ["A.md", "a.md"], reasons: ["unknown_observation"], actions: [],
		});
	});

	it("defers a stable-identity component without a permitted postcondition", () => {
		const action: SyncAction = { path: "A.md", action: "delete_local", local: entity("A.md") };
		const evidence: IdentityEvidence[] = [{
			kind: "stable_identity", side: "remote", identityKey: "X", occurrences: [
				{ side: "remote", phase: "baseline", path: "A.md", identityKey: "X" },
				{ side: "remote", phase: "current", path: "B.md", identityKey: "X" },
			],
		}];

		const result = admit([action], evidence);

		expect(result.executable.actions).toEqual([]);
		expect(result.failures[0]!.reasons).toEqual(["conflicting_identity"]);
	});

	it("does not let unrelated stable identity replace authoritative delete absence", () => {
		const action: SyncAction = { path: "A.md", action: "delete_local", local: entity("A.md") };
		const evidence: IdentityEvidence[] = [{
			kind: "stable_identity", side: "remote", identityKey: "X", occurrences: [
				{ side: "remote", phase: "baseline", path: "A.md", identityKey: "X" },
			],
		}];

		const result = admit([action], evidence);

		expect(result.executable.actions).toEqual([]);
		expect(result.failures[0]?.reasons).toEqual(["unknown_observation"]);
	});

	it("defers every action touching a requested-echo observation", () => {
		const actions: FixtureAction[] = [
			{ path: "A.md", action: "delete_local", local: entity("A.md") },
			{ path: "B.md", action: "match", remote: entity("B.md") },
			{ path: "safe.md", action: "push", local: entity("safe.md") },
		];
		const observations: PathObservation[] = [{
			kind: "present_unresolved", side: "remote", requestedPath: "A.md", returnedPath: "B.md",
			entity: { ...entity("B.md"), pathAuthority: "requested_echo" }, source: "stat",
		}, { kind: "absent", side: "remote", requestedPath: "safe.md", authority: "stat" }];

		const result = admit(actions, [], observations);

		expect(result.executable.actions).toEqual([expect.objectContaining({ ...actions[2],
			publication: { source: undefined, destination: undefined } })]);
		expect(result.failures[0]).toMatchObject({
			paths: ["A.md", "B.md"], reasons: ["present_unresolved"], actions: [],
		});
	});

	it("retains and defers an unresolved evidence component with no actions", () => {
		const observations: PathObservation[] = [{
			kind: "present_unresolved", side: "remote", requestedPath: "A.md", returnedPath: "B.md",
			entity: { ...entity("B.md"), pathAuthority: "requested_echo" }, source: "stat",
		}];

		const result = admit([], [remoteRename()], observations);

		expect(result.executable.actions).toEqual([]);
		expect(result.failures).toHaveLength(1);
		expect(result.failures[0]).toMatchObject({
			paths: ["A.md", "B.md"], reasons: ["present_unresolved"], actions: [],
		});
	});

	it("resolves an actionless rename after authoritative two-sided convergence", () => {
		const observations: PathObservation[] = (["local", "remote"] as const).flatMap((side) => [
			{ kind: "absent" as const, side, requestedPath: "A.md", authority: "stat" as const },
			{ kind: "exact" as const, side, requestedPath: "B.md", entity: entity("B.md", "X") },
		]);

		const result = admit([], [remoteRename()], observations, projection({
			"A.md": "included", "B.md": "included",
		}), [{ path: "B.md", prevSync: recordFor(entity("B.md", "X")) }]);

		expect(result.executable.actions).toEqual([]);
		expect(result.failures).toEqual([]);
		expect(result.dispositions).toEqual([expect.objectContaining({
			kind: "resolved_no_action", paths: ["A.md", "B.md"], actions: [],
		})]);
	});

	it("resolves an actionless reported folder rename with aligned case aliases", () => {
		const oldRoot = "TemplateS";
		const newRoot = "Templates";
		const children = ["Zettelkasten CTO.md", "Zettelkasten.md"];
		const evidence: IdentityEvidence[] = [
			remoteRename({
				side: "local", oldPath: oldRoot, newPath: newRoot,
				isFolder: true, identityKey: undefined,
			}),
			...children.map((name): IdentityEvidence => remoteRename({
				side: "local", oldPath: `${oldRoot}/${name}`, newPath: `${newRoot}/${name}`,
				identityKey: undefined,
			})),
			{ kind: "alias", side: "local", requestedPath: oldRoot, resolvedPath: newRoot },
			...children.map((name): IdentityEvidence => ({
				kind: "alias", side: "local",
				requestedPath: `${oldRoot}/${name}`, resolvedPath: `${newRoot}/${name}`,
			})),
		];
		const rootEntity = {
			...entity(newRoot), isDirectory: true,
		};
		const observations: PathObservation[] = [
			{ kind: "alias", side: "local", requestedPath: oldRoot, resolvedPath: newRoot, entity: rootEntity },
			{ kind: "exact", side: "local", requestedPath: newRoot, entity: rootEntity },
			{ kind: "absent", side: "remote", requestedPath: oldRoot, authority: "stat" },
			{ kind: "exact", side: "remote", requestedPath: newRoot, entity: rootEntity },
			...children.flatMap((name): PathObservation[] => {
				const newPath = `${newRoot}/${name}`;
				const oldPath = `${oldRoot}/${name}`;
				const childEntity = entity(newPath, `id-${name}`);
				return [
					{ kind: "alias", side: "local", requestedPath: oldPath, resolvedPath: newPath, entity: childEntity },
					{ kind: "exact", side: "local", requestedPath: newPath, entity: childEntity },
					{ kind: "absent", side: "remote", requestedPath: oldPath, authority: "stat" },
					{ kind: "exact", side: "remote", requestedPath: newPath, entity: childEntity },
				];
			}),
		];
		const scope = projection(Object.fromEntries(
			[oldRoot, newRoot, ...children.flatMap((name) => [
				`${oldRoot}/${name}`, `${newRoot}/${name}`,
			])].map((path) => [path, "included"]),
		));

		const entries = children.map((name): MixedEntity => {
			const current = entity(`${newRoot}/${name}`, `id-${name}`);
			return { path: current.path, local: current, remote: current, prevSync: recordFor(current) };
		});
		const result = admitBatchObservation(captureBatchObservation(
			entries, evidence, observations, scope, "backend\0root",
		));

		expect(result.executable.actions).toEqual([]);
		expect(result.failures).toEqual([]);
		expect(result.dispositions).toEqual([expect.objectContaining({
			kind: "resolved_no_action", actions: [],
		})]);
	});

	it("resolves an actionless remote report whose local alias is the settled endpoint", () => {
		const oldPath = "BALLAS.md";
		const newPath = "BALLAs.md";
		const current = entity(newPath, "R");
		const result = admitBatchObservation(captureBatchObservation([
			{ path: newPath, local: current, remote: current, prevSync: recordFor(current) },
		], [
			remoteRename({ oldPath, newPath, identityKey: "R" }),
			{ kind: "alias", side: "local", requestedPath: oldPath, resolvedPath: newPath },
		], [
			{ kind: "alias", side: "local", requestedPath: oldPath, resolvedPath: newPath, entity: current },
			{ kind: "exact", side: "local", requestedPath: newPath, entity: current },
			{ kind: "absent", side: "remote", requestedPath: oldPath, authority: "stat" },
			{ kind: "exact", side: "remote", requestedPath: newPath, entity: current },
		], projection({ [oldPath]: "included", [newPath]: "included" }), "backend\0root"));

		expect(result.executable.actions).toEqual([]);
		expect(result.failures).toEqual([]);
		expect(result.dispositions).toEqual([expect.objectContaining({
			kind: "resolved_no_action", actions: [],
		})]);
	});

	it("publishes an absent baseline before resolving a settled alias without actions", () => {
		const current = entity("B.md", "X");
		const observations: PathObservation[] = [
			{ kind: "alias", side: "local", requestedPath: "A.md", resolvedPath: "B.md", entity: current },
			{ kind: "exact", side: "local", requestedPath: "B.md", entity: current },
			{ kind: "absent", side: "remote", requestedPath: "A.md", authority: "stat" },
			{ kind: "exact", side: "remote", requestedPath: "B.md", entity: current },
		];
		const evidence: IdentityEvidence[] = [remoteRename(), {
			kind: "alias", side: "local", requestedPath: "A.md", resolvedPath: "B.md",
		}];
		const decide = (prevSync?: SyncRecord) => admitBatchObservation(captureBatchObservation(
			[{ path: "B.md", local: current, remote: current, prevSync }], evidence,
			observations, projection({ "A.md": "included", "B.md": "included" }), "backend\0root",
		));
		const first = decide();
		expect(first.failures).toEqual([]);
		expect(first.executable.actions).toEqual([expect.objectContaining({ action: "match", path: "B.md" })]);
		const next = decide(recordFor(current));
		expect(next.failures).toEqual([]);
		expect(next.executable.actions).toEqual([]);
		expect(next.dispositions[0]?.kind).toBe("resolved_no_action");
	});

	it("binds a remote rename before selecting its changed content transfer", () => {
		const local = entity("A.md");
		const baseline = recordFor({ ...local, identityKey: "X" });
		const remote = freshEntity("B.md", "edited", "X");
		const result = admitBatchObservation(captureBatchObservation([
			{ path: "A.md", local, prevSync: baseline }, { path: "B.md", remote },
		], [remoteRename()], [
			{ kind: "exact", side: "local", requestedPath: "A.md", entity: local },
			{ kind: "absent", side: "local", requestedPath: "B.md", authority: "stat" },
			{ kind: "absent", side: "remote", requestedPath: "A.md", authority: "checkpoint_deleted" },
			{ kind: "exact", side: "remote", requestedPath: "B.md", entity: remote },
		], projection({ "A.md": "included", "B.md": "included" }), "backend\0root"));
		expect(result.failures).toEqual([]);
		expect(result.executable.actions).toEqual([expect.objectContaining({
			action: "rename_local", oldPath: "A.md", path: "B.md",
			content: { mode: "copy", read: { side: "remote", entity: remote }, write: { side: "local", path: "B.md" } },
		})]);
	});

	it("admits an additive push when a local rename has no synchronized anchor", () => {
		const action: SyncAction = { path: "B.md", action: "push", local: entity("B.md") };
		const evidence = [remoteRename({ side: "local", identityKey: undefined })];
		const observations: PathObservation[] = [
			{ kind: "absent", side: "local", requestedPath: "A.md", authority: "stat" },
			{ kind: "absent", side: "remote", requestedPath: "A.md", authority: "stat" },
			{ kind: "exact", side: "local", requestedPath: "B.md", entity: entity("B.md") },
			{ kind: "absent", side: "remote", requestedPath: "B.md", authority: "stat" },
		];

		const result = admit([action], evidence, observations, projection({
			"A.md": "included", "B.md": "included",
		}));

		expect(result.executable.actions).toEqual([expect.objectContaining({ ...action,
			publication: { source: undefined, destination: undefined } })]);
		expect(result.failures).toEqual([]);
	});

	it("keeps captured inputs stable when caller-owned containers change", () => {
		const action: SyncAction = { path: "gone.md", action: "delete_local", local: entity("gone.md"), baseline: recordFor(entity("gone.md")) };
		const plan = { actions: [action] };
		const evidence: IdentityEvidence[] = [];
		const observations: PathObservation[] = [{
			kind: "absent", side: "remote", requestedPath: "gone.md", authority: "checkpoint_deleted",
		}];
		const scope = projection({ "gone.md": "included" });
		const snapshot = captureFixtureFacts(plan, evidence, observations, scope, "backend\0root");

		plan.actions.length = 0;
		observations.length = 0;
		(scope.byEndpoint as Map<string, ScopeDisposition>).set("gone.md", "unknown");

		const result = admitBatchObservation(snapshot);
		expect(result.executable.actions).toEqual([expect.objectContaining({ ...action,
			publication: { source: action.baseline, destination: action.baseline } })]);
		expect(result.snapshot.namespace).toBe("backend\0root");
	});

	it("keeps plain proposals outside the executor contract", () => {
		const proposal = { actions: [] };
		// @ts-expect-error A plain proposal is not an Admission-issued plan.
		const unauthorized: AuthorizedSyncPlan = proposal;
		expect(unauthorized.actions).toEqual([]);
	});

	it("defers match and delete together when an alias links them", () => {
		const actions: FixtureAction[] = [
			{ path: "A.md", action: "delete_local", local: entity("A.md") },
			{ path: "a.md", action: "match", remote: entity("a.md") },
		];
		const evidence: IdentityEvidence[] = [{
			kind: "alias", side: "local", requestedPath: "A.md", resolvedPath: "a.md",
		}];

		const result = admit(actions, evidence);

		expect(result.executable.actions).toEqual([]);
		expect(result.failures[0]).toMatchObject({ reasons: ["unknown_observation"], actions: [] });
	});

	it("defers an opposite-side delete that treats an alias request as independently absent", () => {
		const action: SyncAction = { path: "A.md", action: "delete_remote", remote: entity("A.md", "X") };
		const evidence: IdentityEvidence[] = [{
			kind: "alias", side: "local", requestedPath: "A.md", resolvedPath: "a.md",
		}];

		const result = admit([action], evidence);

		expect(result.executable.actions).toEqual([]);
		expect(result.failures[0]!.reasons).toEqual(["unknown_observation"]);
	});

	it("admits an exact native rename matching reported movement", () => {
		const baseline = recordFor(entity("A.md", "X"));
		const action: SyncAction = {
			path: "B.md", oldPath: "A.md", action: "rename_local",
			local: entity("A.md"), remote: entity("B.md", "X"), baseline,
		};
		const scope = projection({ "A.md": "included", "B.md": "included" });

		const result = admit([action], [remoteRename()], [
			{ kind: "absent", side: "remote", requestedPath: "A.md", authority: "stat" },
			{ kind: "absent", side: "local", requestedPath: "B.md", authority: "stat" },
		], scope);

		expect(result.executable.actions).toEqual([{
			...action, content: { mode: "equal" }, publication: { source: baseline, destination: undefined },
		}]);
		expect(result.failures).toEqual([]);
	});

	it("shapes a proved local rename and its lifecycle from the base component", () => {
		const baseline = {
			path: "A.md", hash: "h", localMtime: 1, remoteMtime: 1,
			localSize: 1, remoteSize: 1, syncedAt: 1, remoteIdentityKey: "X",
		};
		const deletion: SyncAction = {
			path: "A.md", action: "delete_remote",
			remote: entity("A.md", "X"),
			baseline,
		};
		const push: SyncAction = { path: "B.md", action: "push", local: entity("B.md") };
		const evidence = [remoteRename({ side: "local", identityKey: undefined })];
		const result = admit([deletion, push], evidence, [
			{ kind: "absent", side: "local", requestedPath: "A.md", authority: "stat" },
			{ kind: "absent", side: "remote", requestedPath: "B.md", authority: "stat" },
		], projection({
			"A.md": "included", "B.md": "included",
		}));

		expect(result.executable.actions).toEqual([{
			path: "B.md", oldPath: "A.md", action: "rename_remote",
			local: push.local, remote: deletion.remote, baseline: deletion.baseline,
			content: { mode: "equal" }, publication: { source: baseline, destination: undefined },
		}]);
		expect(result.failures).toEqual([]);
	});

	it("shapes a backend-reported remote rename from the base component", () => {
		const baseline = {
			path: "A.md", hash: "h", localMtime: 1, remoteMtime: 1,
			localSize: 1, remoteSize: 1, syncedAt: 1, remoteIdentityKey: "X",
		};
		const deletion: SyncAction = {
			path: "A.md", action: "delete_local", local: entity("A.md"), baseline,
		};
		const pull: SyncAction = { path: "B.md", action: "pull", remote: entity("B.md", "X") };

		const result = admit([deletion, pull], [remoteRename()], [
			{ kind: "absent", side: "remote", requestedPath: "A.md", authority: "stat" },
			{ kind: "absent", side: "local", requestedPath: "B.md", authority: "stat" },
		], projection({
			"A.md": "included", "B.md": "included",
		}));

		expect(result.executable.actions).toEqual([{
			path: "B.md", oldPath: "A.md", action: "rename_local",
			local: deletion.local, remote: pull.remote, baseline,
			content: { mode: "equal" }, publication: { source: baseline, destination: undefined },
		}]);
		expect(result.failures).toEqual([]);
	});

	it("shapes disconnected local and remote renames without disturbing ordinary order", () => {
		const baseline = (path: string, remoteIdentityKey: string) => ({
			path, hash: "h", localMtime: 1, remoteMtime: 1,
			localSize: 1, remoteSize: 1, syncedAt: 1, remoteIdentityKey,
		});
		const ordinary: SyncAction = { path: "middle.md", action: "push", local: entity("middle.md") };
		const proposal: SyncAction[] = [
			{
				path: "local-old.md", action: "delete_remote",
				remote: entity("local-old.md", "L"), baseline: baseline("local-old.md", "L"),
			},
			{ path: "local-new.md", action: "push", local: entity("local-new.md") },
			ordinary,
			{
				path: "remote-old.md", action: "delete_local",
				local: entity("remote-old.md"), baseline: baseline("remote-old.md", "R"),
			},
			{ path: "remote-new.md", action: "pull", remote: entity("remote-new.md", "R") },
		];
		const evidence: IdentityEvidence[] = [
			remoteRename({
				side: "local", oldPath: "local-old.md", newPath: "local-new.md",
				identityKey: undefined,
			}),
			remoteRename({ oldPath: "remote-old.md", newPath: "remote-new.md", identityKey: "R" }),
		];
		const scope = projection(Object.fromEntries([
			"local-old.md", "local-new.md", "middle.md", "remote-old.md", "remote-new.md",
		].map((path) => [path, "included" as const])));

		const result = admit(proposal, evidence, [
			{ kind: "absent", side: "local", requestedPath: "local-old.md", authority: "stat" },
			{ kind: "absent", side: "remote", requestedPath: "local-new.md", authority: "stat" },
			{ kind: "absent", side: "remote", requestedPath: "middle.md", authority: "stat" },
			{ kind: "absent", side: "remote", requestedPath: "remote-old.md", authority: "stat" },
			{ kind: "absent", side: "local", requestedPath: "remote-new.md", authority: "stat" },
		], scope);

		expect(result.executable.actions.map((action) => action.action)).toEqual([
			"rename_remote", "push", "rename_local",
		]);
		expect(result.executable.actions[1]).toStrictEqual({
			...ordinary, baseline: undefined, remote: undefined,
			publication: { source: undefined, destination: undefined },
		});
		expect(result.failures).toEqual([]);
		const targets = result.executable.actions.map((action) => action.path);
		expect(new Set(targets).size).toBe(targets.length);
	});

	it("admits a remote case-only rename when the local destination aliases its source", () => {
		const baseline = recordFor(entity("A.md", "X"));
		const action: SyncAction = {
			path: "a.md", oldPath: "A.md", action: "rename_local",
			local: entity("A.md"), remote: entity("a.md", "X"), baseline,
		};
		const evidence: IdentityEvidence[] = [
			remoteRename({ oldPath: "A.md", newPath: "a.md" }),
			{ kind: "alias", side: "local", requestedPath: "a.md", resolvedPath: "A.md" },
		];

		const result = admit([action], evidence, [
			{ kind: "alias", side: "local", requestedPath: "a.md", resolvedPath: "A.md", entity: action.local! },
			{ kind: "absent", side: "remote", requestedPath: "A.md", authority: "stat" },
		], projection({
			"A.md": "included", "a.md": "included",
		}));

		expect(result.executable.actions).toEqual([{
			...action, content: { mode: "equal" }, publication: { source: baseline, destination: undefined },
		}]);
		expect(result.failures).toEqual([]);
	});

	it("admits a local case-only rename when the remote destination aliases its source", () => {
		const baseline = recordFor(entity("A.md", "X"));
		const action: SyncAction = {
			path: "a.md", oldPath: "A.md", action: "rename_remote",
			local: entity("a.md"), remote: entity("A.md", "X"), baseline,
		};
		const evidence: IdentityEvidence[] = [
			{
				kind: "rename", side: "local", oldPath: "A.md", newPath: "a.md",
				isFolder: false, authority: "reported",
			},
			{ kind: "alias", side: "remote", requestedPath: "a.md", resolvedPath: "A.md" },
		];

		const result = admit([action], evidence, [
			{ kind: "alias", side: "remote", requestedPath: "a.md", resolvedPath: "A.md", entity: action.remote! },
			{ kind: "absent", side: "local", requestedPath: "A.md", authority: "stat" },
		], projection({
			"A.md": "included", "a.md": "included",
		}));

		expect(result.executable.actions).toEqual([{
			...action, content: { mode: "equal" }, publication: { source: baseline, destination: undefined },
		}]);
		expect(result.failures).toEqual([]);
	});

	it("canonicalizes an unbaselined case alias only from complete current facts", () => {
		const local = entity("case.md");
		const remote = entity("Case.md", "R");
		const result = admit(
			[
				{ path: "Case.md", action: "pull", remote },
				{ path: "case.md", action: "push", local },
			],
			[{ kind: "alias", side: "local", requestedPath: "Case.md", resolvedPath: "case.md" }],
			[
				{ kind: "alias", side: "local", requestedPath: "Case.md", resolvedPath: "case.md", entity: local },
				{ kind: "exact", side: "local", requestedPath: "case.md", entity: local },
				{ kind: "exact", side: "remote", requestedPath: "Case.md", entity: remote },
				{ kind: "absent", side: "remote", requestedPath: "case.md", authority: "stat" },
			],
			projection({ "Case.md": "included", "case.md": "included" }),
			[
				{ path: "Case.md", remote },
				{ path: "case.md", local },
			],
		);

		expect(result.executable.actions).toEqual([{
			action: "rename_remote", content: { mode: "equal" },
			oldPath: "Case.md", path: "case.md", local, remote,
			publication: { source: undefined, destination: undefined },
		}]);
		expect(result.failures).toEqual([]);
	});

	it("does not rebind an exact-owned occurrence through a later local alias", () => {
		const baseline = recordFor(freshEntity("case.md", "base"));
		const local = freshEntity("case.md", "new");
		const remote = freshEntity("Case.md", "new", "R");
		const decision = decideIdentityComponent({
			paths: new Set(["Case.md", "case.md"]),
			entries: [
				{ path: "case.md", local, prevSync: baseline },
				{ path: "Case.md", remote },
			],
			evidence: [{ kind: "alias", side: "local", requestedPath: "Case.md", resolvedPath: "case.md" }],
			observations: [
				{ kind: "alias", side: "local", requestedPath: "Case.md", resolvedPath: "case.md", entity: local },
				{ kind: "exact", side: "local", requestedPath: "case.md", entity: local },
				{ kind: "exact", side: "remote", requestedPath: "Case.md", entity: remote },
				{ kind: "absent", side: "remote", requestedPath: "case.md", authority: "stat" },
			],
		}, projection({ "Case.md": "included", "case.md": "included" }));

		expect(decision.component.actions).toEqual([]);
		expect(decision.reasons).toEqual(["unknown_observation"]);
	});

	// A remote endpoint that carries no provider identity cannot be proven to be the
	// object the local alias points at, and no address may stand in for that proof.
	it("refuses a local case alias whose remote endpoint carries no provider identity", () => {
		const local = freshEntity("case.md", "new");
		const remote = freshEntity("Case.md", "new");
		expect(remote.identityKey).toBeUndefined();
		const decision = decideIdentityComponent({
			paths: new Set(["Case.md", "case.md"]),
			entries: [
				{ path: "case.md", local },
				{ path: "Case.md", remote },
			],
			evidence: [{ kind: "alias", side: "local", requestedPath: "Case.md", resolvedPath: "case.md" }],
			observations: [
				{ kind: "alias", side: "local", requestedPath: "Case.md", resolvedPath: "case.md", entity: local },
				{ kind: "exact", side: "local", requestedPath: "case.md", entity: local },
				{ kind: "exact", side: "remote", requestedPath: "Case.md", entity: remote },
				{ kind: "absent", side: "remote", requestedPath: "case.md", authority: "stat" },
			],
		}, projection({ "Case.md": "included", "case.md": "included" }));

		expect(decision.component.actions).toEqual([]);
		expect(decision.reasons).toEqual(["remote_identity_missing"]);
	});

	it("does not let a later exact baseline rebind an alias-owned occurrence", () => {
		const aliasBaseline = recordFor(freshEntity("Case.md", "new", "R"));
		const exactBaseline = recordFor(freshEntity("case.md", "base"));
		const local = freshEntity("case.md", "new");
		const remote = freshEntity("Case.md", "new", "R");
		const decision = decideIdentityComponent({
			paths: new Set(["Case.md", "case.md"]),
			entries: [
				{ path: "Case.md", remote, prevSync: aliasBaseline },
				{ path: "case.md", local, prevSync: exactBaseline },
			],
			evidence: [{ kind: "alias", side: "local", requestedPath: "Case.md", resolvedPath: "case.md" }],
			observations: [
				{ kind: "alias", side: "local", requestedPath: "Case.md", resolvedPath: "case.md", entity: local },
				{ kind: "exact", side: "local", requestedPath: "case.md", entity: local },
				{ kind: "exact", side: "remote", requestedPath: "Case.md", entity: remote },
				{ kind: "absent", side: "remote", requestedPath: "case.md", authority: "stat" },
			],
		}, projection({ "Case.md": "included", "case.md": "included" }));

		expect(decision.reasons).toEqual([]);
		expect(decision.component.actions).toHaveLength(1);
		expect(decision.component.actions[0]).toMatchObject({
			action: "rename_remote", oldPath: "Case.md", path: "case.md",
		});
	});

	it("does not exact-bind a historical identity record over another tracked identity", () => {
		const replacedBaseline = recordFor(freshEntity("Case.md", "old-X", "X"));
		const trackedBaseline = recordFor(freshEntity("case.md", "same-Y", "Y"));
		const remote = freshEntity("Case.md", "same-Y", "Y");
		const decision = decideIdentityComponent({
			paths: new Set(["Case.md", "case.md"]),
			entries: [
				{ path: "Case.md", remote, prevSync: replacedBaseline },
				{ path: "case.md", prevSync: trackedBaseline },
			],
			evidence: [],
			observations: [
				{ kind: "exact", side: "remote", requestedPath: "Case.md", entity: remote },
				{ kind: "absent", side: "local", requestedPath: "Case.md", authority: "stat" },
				{ kind: "absent", side: "local", requestedPath: "case.md", authority: "stat" },
				{ kind: "absent", side: "remote", requestedPath: "case.md", authority: "stat" },
			],
		}, projection({ "Case.md": "included", "case.md": "included" }));

		expect(decision.reasons).toEqual([]);
		expect(decision.component.actions).toHaveLength(1);
		expect(decision.component.actions[0]).toMatchObject({
			action: "delete_remote", path: "case.md", remotePath: "Case.md",
		});
	});

	it("claims the exact remote occurrence when its stable identity is unavailable", () => {
		const baseline = recordFor(freshEntity("a.md", "old", "OLD"));
		const remote = freshEntity("a.md", "new");
		const decision = decideIdentityComponent({
			paths: new Set(["a.md"]),
			entries: [{ path: "a.md", remote, prevSync: baseline }],
			evidence: [],
			observations: [
				{ kind: "absent", side: "local", requestedPath: "a.md", authority: "stat" },
				{ kind: "exact", side: "remote", requestedPath: "a.md", entity: remote },
			],
		}, projection({ "a.md": "included" }));

		expect(decision.reasons).toEqual([]);
		expect(decision.component.actions).toHaveLength(1);
		expect(decision.component.actions[0]).toMatchObject({ action: "conflict", path: "a.md" });
	});

	it.each(["auto_merge", "prefer_local", "duplicate"] as const)(
		"preserves both readable versions with %s provenance when a case alias cannot prove one rename",
		(conflictStrategy) => {
		const local = freshEntity("case.md", "local");
		const remote = freshEntity("Case.md", "remote", "R");
		const result = admit(
			[
				{ path: "Case.md", action: "pull", remote },
				{ path: "case.md", action: "push", local },
			],
			[{ kind: "alias", side: "local", requestedPath: "Case.md", resolvedPath: "case.md" }],
			[
				{ kind: "alias", side: "local", requestedPath: "Case.md", resolvedPath: "case.md", entity: local },
				{ kind: "exact", side: "local", requestedPath: "case.md", entity: local },
				{ kind: "exact", side: "remote", requestedPath: "Case.md", entity: remote },
				{ kind: "absent", side: "remote", requestedPath: "case.md", authority: "stat" },
				...vacantCandidates("Case.md", ["local", "remote"]),
			],
			projection({
				"Case.md": "included", "case.md": "included",
				"Case.conflict-local.md": "included", "Case.conflict-remote.md": "included",
			}),
			[
				{ path: "Case.md", remote },
				{ path: "case.md", local },
			],
			[],
			conflictStrategy,
		);

		expect(result.failures).toEqual([]);
		expect(result.executable.actions).toHaveLength(1);
		expect(result.executable.actions[0]).toMatchObject({
			action: "conflict",
			path: "Case.md",
			conflictPolicy: { mode: "preserve", strategy: conflictStrategy },
			protocol: {
				kind: "preservation_cover",
				children: [
					{ source: { side: "local", entity: local }, content: { sha256: "local", size: 1 }, candidatePath: "Case.conflict-local.md" },
					{ source: { side: "remote", entity: remote }, content: { sha256: "remote", size: 1 }, candidatePath: "Case.conflict-remote.md" },
				],
			},
		});
	});

	it("recognizes a two-sided published cover without allocating another suffix", () => {
		const local = freshEntity("case.md", "local");
		const remote = freshEntity("Case.md", "remote", "R");
		const firstLocal = freshEntity("Case.conflict-remote.md", "remote");
		const firstRemote = freshEntity("Case.conflict-remote.md", "remote", "C1");
		const secondLocal = freshEntity("Case.conflict-local.md", "local");
		const secondRemote = freshEntity("Case.conflict-local.md", "local", "C2");
		const firstRecord = recordFor(firstRemote);
		const secondRecord = recordFor(secondRemote);
		const result = admit([], [
			{ kind: "alias", side: "local", requestedPath: "Case.md", resolvedPath: "case.md" },
		], [
			{ kind: "alias", side: "local", requestedPath: "Case.md", resolvedPath: "case.md", entity: local },
			{ kind: "exact", side: "local", requestedPath: "case.md", entity: local },
			{ kind: "exact", side: "remote", requestedPath: "Case.md", entity: remote },
			{ kind: "absent", side: "remote", requestedPath: "case.md", authority: "stat" },
			{ kind: "exact", side: "local", requestedPath: firstLocal.path, entity: firstLocal },
			{ kind: "exact", side: "remote", requestedPath: firstRemote.path, entity: firstRemote },
			{ kind: "exact", side: "local", requestedPath: secondLocal.path, entity: secondLocal },
			{ kind: "exact", side: "remote", requestedPath: secondRemote.path, entity: secondRemote },
		], projection(Object.fromEntries(["Case.md", "case.md", firstLocal.path, secondLocal.path]
			.map((path) => [path, "included" as const]))), [
			{ path: "Case.md", remote }, { path: "case.md", local },
			{ path: firstLocal.path, local: firstLocal, remote: firstRemote, prevSync: firstRecord },
			{ path: secondLocal.path, local: secondLocal, remote: secondRemote, prevSync: secondRecord },
		]);

		expect(result.failures).toEqual([]);
		expect(result.executable.actions).toEqual([]);
		expect(result.dispositions).toMatchObject([{ kind: "resolved_no_action" }]);
	});

	it("admits publication-only children when both candidate sides exist but the record is absent", () => {
		const fixture = caseAliasFixture(freshEntity("case.md", "local"), freshEntity("Case.md", "remote", "R"));
		const localCandidate = freshEntity("Case.conflict-local.md", "local");
		const localCandidateRemote = freshEntity("Case.conflict-local.md", "local", "CL");
		const remoteCandidate = freshEntity("Case.conflict-remote.md", "remote");
		const remoteCandidateRemote = freshEntity("Case.conflict-remote.md", "remote", "CR");
		const result = admit([], fixture.evidence, [
			...fixture.observations,
			{ kind: "exact", side: "local", requestedPath: localCandidate.path, entity: localCandidate },
			{ kind: "exact", side: "remote", requestedPath: localCandidateRemote.path, entity: localCandidateRemote },
			{ kind: "exact", side: "local", requestedPath: remoteCandidate.path, entity: remoteCandidate },
			{ kind: "exact", side: "remote", requestedPath: remoteCandidateRemote.path, entity: remoteCandidateRemote },
		], projection({
			"Case.md": "included", "case.md": "included",
			"Case.conflict-local.md": "included", "Case.conflict-remote.md": "included",
		}), [
			...fixture.entries,
			{ path: localCandidate.path, local: localCandidate, remote: localCandidateRemote },
			{ path: remoteCandidate.path, local: remoteCandidate, remote: remoteCandidateRemote },
		]);

		expect(result.failures).toEqual([]);
		expect(result.executable.actions[0]?.protocol).toMatchObject({
			kind: "preservation_cover",
			children: [{ missingSides: [] }, { missingSides: [] }],
		});
	});

	it("reconstructs cleanup-only cover from completed candidates after reports disappear", () => {
		const local = freshEntity("case.md", "local");
		const remote = freshEntity("Case.md", "remote", "R");
		const localCandidatePath = "Case.conflict-local.md";
		const remoteCandidatePath = "Case.conflict-remote.md";
		const localCandidate = freshEntity("case.conflict-local.md", "local");
		const localCandidateRemote = freshEntity("case.conflict-local.md", "local", "CL");
		const remoteCandidate = freshEntity("case.conflict-remote.md", "remote");
		const remoteCandidateRemote = freshEntity("case.conflict-remote.md", "remote", "CR");
		const oldRecord = recordFor(remote);
		const result = admit([], [
			{ kind: "alias", side: "local", requestedPath: "Case.md", resolvedPath: "case.md" },
		], [
			{ kind: "alias", side: "local", requestedPath: "Case.md", resolvedPath: "case.md", entity: local },
			{ kind: "exact", side: "local", requestedPath: "case.md", entity: local },
			{ kind: "exact", side: "remote", requestedPath: "Case.md", entity: remote },
			{ kind: "absent", side: "remote", requestedPath: "case.md", authority: "stat" },
			{ kind: "alias", side: "local", requestedPath: localCandidatePath,
				resolvedPath: localCandidate.path, entity: localCandidate },
			{ kind: "alias", side: "remote", requestedPath: localCandidatePath,
				resolvedPath: localCandidateRemote.path, entity: localCandidateRemote },
			{ kind: "alias", side: "local", requestedPath: remoteCandidatePath,
				resolvedPath: remoteCandidate.path, entity: remoteCandidate },
			{ kind: "alias", side: "remote", requestedPath: remoteCandidatePath,
				resolvedPath: remoteCandidateRemote.path, entity: remoteCandidateRemote },
		], projection({
			"Case.md": "included", "case.md": "included",
			"Case.conflict-local.md": "included", "Case.conflict-remote.md": "included",
			"case.conflict-local.md": "included", "case.conflict-remote.md": "included",
		}), [
			{ path: "Case.md", remote, prevSync: oldRecord }, { path: "case.md", local },
			{ path: localCandidatePath, local: localCandidate, remote: localCandidateRemote,
				prevSync: { ...recordFor(localCandidateRemote), path: localCandidatePath } },
			{ path: remoteCandidatePath, local: remoteCandidate, remote: remoteCandidateRemote,
				prevSync: { ...recordFor(remoteCandidateRemote), path: remoteCandidatePath } },
		]);

		expect(result.failures).toEqual([]);
		expect(result.executable.actions).toMatchObject([{
			action: "conflict", protocol: {
				kind: "preservation_cover",
				candidatePaths: ["Case.conflict-local.md", "Case.conflict-remote.md"],
				preservedPaths: ["Case.conflict-local.md", "Case.conflict-remote.md"],
				children: [], cleanup: [{ path: "Case.md", expected: oldRecord }],
			},
		}]);
	});

	it("reconstructs only the missing child after a published cover prefix", () => {
		const local = freshEntity("case.md", "local");
		const remote = freshEntity("Case.md", "remote", "R");
		const candidateLocal = freshEntity("Case.conflict-local.md", "local");
		const candidateRemote = freshEntity("Case.conflict-local.md", "local", "CL");
		const candidateRecord = recordFor(candidateRemote);
		const oldRecord = recordFor(remote);
		const result = admit([], [{
			kind: "alias", side: "local", requestedPath: "Case.md", resolvedPath: "case.md",
		}], [
			{ kind: "alias", side: "local", requestedPath: "Case.md", resolvedPath: "case.md", entity: local },
			{ kind: "exact", side: "local", requestedPath: "case.md", entity: local },
			{ kind: "exact", side: "remote", requestedPath: "Case.md", entity: remote },
			{ kind: "absent", side: "remote", requestedPath: "case.md", authority: "stat" },
			{ kind: "exact", side: "local", requestedPath: candidateLocal.path, entity: candidateLocal },
			{ kind: "exact", side: "remote", requestedPath: candidateRemote.path, entity: candidateRemote },
			...vacantCandidates("Case.md", ["remote"]),
		], projection({
			"Case.md": "included", "case.md": "included",
			"Case.conflict-local.md": "included", "Case.conflict-remote.md": "included",
		}), [
			{ path: "Case.md", remote, prevSync: oldRecord }, { path: "case.md", local },
			{ path: candidateLocal.path, local: candidateLocal, remote: candidateRemote, prevSync: candidateRecord },
		]);

		expect(result.failures).toEqual([]);
		expect(result.executable.actions[0]?.protocol).toMatchObject({
			kind: "preservation_cover",
			candidatePaths: ["Case.conflict-local.md", "Case.conflict-remote.md"],
			preservedPaths: ["Case.conflict-local.md"],
			children: [{ content: { sha256: "remote" }, candidatePath: "Case.conflict-remote.md" }],
			cleanup: [{ path: "Case.md", expected: oldRecord }],
		});
	});

	it("keeps a foreign direct-candidate occupant ordinary and fails without an alternate", () => {
		const fixture = caseAliasFixture(freshEntity("case.md", "local"), freshEntity("Case.md", "remote", "R"));
		const occupiedPath = insertConflictSuffix("Case.md", "local");
		const foreign = freshEntity(occupiedPath, "foreign");
		const remoteCandidate = insertConflictSuffix("Case.md", "remote");
		const result = admit(fixture.actions, fixture.evidence, [
			...fixture.observations,
			{ kind: "exact", side: "local", requestedPath: occupiedPath, entity: foreign },
			{ kind: "absent", side: "remote", requestedPath: occupiedPath, authority: "stat" },
			...vacantCandidates("Case.md", ["remote"]),
		], projection({
			"Case.md": "included", "case.md": "included",
			[occupiedPath]: "included", [remoteCandidate]: "included",
		}), [...fixture.entries, { path: occupiedPath, local: foreign }]);

		expect(result.failures.map((failure) => failure.reasons))
			.toContainEqual(["preservation_destination_unavailable"]);
		expect(result.executable.actions).toContainEqual(expect.objectContaining({
			action: "push", path: occupiedPath,
		}));
		expect(result.executable.actions.some((action) => action.protocol?.kind === "preservation_cover")).toBe(false);
	});

	it("absorbs a same-byte direct candidate and writes only its missing side", () => {
		const fixture = caseAliasFixture(freshEntity("case.md", "local"), freshEntity("Case.md", "remote", "R"));
		const candidatePath = insertConflictSuffix("Case.md", "local");
		const existing = freshEntity(candidatePath, "local");
		const result = admit(fixture.actions, fixture.evidence, [
			...fixture.observations,
			{ kind: "exact", side: "local", requestedPath: candidatePath, entity: existing },
			{ kind: "absent", side: "remote", requestedPath: candidatePath, authority: "stat" },
			...vacantCandidates("Case.md", ["remote"]),
		], projection({
			"Case.md": "included", "case.md": "included",
			[candidatePath]: "included", "Case.conflict-remote.md": "included",
		}), [...fixture.entries, { path: candidatePath, local: existing }]);

		expect(result.failures).toEqual([]);
		const cover = result.executable.actions.find((action) => action.protocol?.kind === "preservation_cover");
		expect(cover?.protocol).toMatchObject({ kind: "preservation_cover", children: [
			{ candidatePath, expectedLocal: existing, expectedRemote: null, missingSides: ["remote"] },
			{ candidatePath: "Case.conflict-remote.md", missingSides: ["local", "remote"] },
		] });
	});

	it("does not absorb a mixed same-path candidate with one foreign endpoint", () => {
		const fixture = caseAliasFixture(freshEntity("case.md", "local"), freshEntity("Case.md", "remote", "R"));
		const candidatePath = insertConflictSuffix("Case.md", "local");
		const candidateLocal = freshEntity(candidatePath, "local");
		const candidateRemote = freshEntity(candidatePath, "foreign", "F");
		const result = admit(fixture.actions, fixture.evidence, [
			...fixture.observations,
			{ kind: "exact", side: "local", requestedPath: candidatePath, entity: candidateLocal },
			{ kind: "exact", side: "remote", requestedPath: candidatePath, entity: candidateRemote },
			...vacantCandidates("Case.md", ["remote"]),
		], projection({
			"Case.md": "included", "case.md": "included", [candidatePath]: "included",
			"Case.conflict-remote.md": "included",
		}), [...fixture.entries, { path: candidatePath, local: candidateLocal, remote: candidateRemote }]);

		expect(result.failures.map((failure) => failure.reasons))
			.toContainEqual(["preservation_destination_unavailable"]);
		expect(result.executable.actions).toContainEqual(expect.objectContaining({
			action: "conflict", path: candidatePath,
		}));
		expect(result.executable.actions.some((action) => action.protocol?.kind === "preservation_cover")).toBe(false);
	});

	it("keeps a foreign resolved candidate endpoint outside the original cover", () => {
		const fixture = caseAliasFixture(freshEntity("case.md", "local"), freshEntity("Case.md", "remote", "R"));
		const candidatePath = insertConflictSuffix("Case.md", "local");
		const resolvedPath = candidatePath.toLowerCase();
		const candidateLocal = freshEntity(candidatePath, "local");
		const foreignRemote = freshEntity(resolvedPath, "foreign", "F");
		const result = admit(fixture.actions, fixture.evidence, [
			...fixture.observations,
			{ kind: "exact", side: "local", requestedPath: candidatePath, entity: candidateLocal },
			{ kind: "absent", side: "local", requestedPath: resolvedPath, authority: "stat" },
			{ kind: "exact", side: "remote", requestedPath: resolvedPath, entity: foreignRemote },
			...vacantCandidates("Case.md", ["remote"]),
		], projection({
			"Case.md": "included", "case.md": "included", [candidatePath]: "included",
			[resolvedPath]: "included", "Case.conflict-remote.md": "included",
		}), [...fixture.entries,
			{ path: candidatePath, local: candidateLocal },
			{ path: resolvedPath, remote: foreignRemote },
		], [
			{ kind: "exact", side: "local", requestedPath: candidatePath, entity: candidateLocal },
			{ kind: "alias", side: "remote", requestedPath: candidatePath,
				resolvedPath, entity: foreignRemote },
		]);

		expect(result.failures.map((failure) => failure.reasons))
			.toContainEqual(["preservation_destination_unavailable"]);
		expect(result.executable.actions).toContainEqual(expect.objectContaining({
			action: "pull", path: resolvedPath,
		}));
		expect(result.executable.actions.some((action) =>
			action.protocol?.kind === "preservation_cover")).toBe(false);
	});

	it("keeps unrelated conflict-looking files in their ordinary component", () => {
		const fixture = caseAliasFixture(freshEntity("case.md", "local"), freshEntity("Case.md", "remote", "R"));
		const unrelated = freshEntity("Case.conflict-manual.md", "manual");
		const result = admit(fixture.actions, fixture.evidence, [
			...fixture.observations, ...vacantCandidates("Case.md", ["local", "remote"]),
			{ kind: "exact", side: "local", requestedPath: unrelated.path, entity: unrelated },
			{ kind: "absent", side: "remote", requestedPath: unrelated.path, authority: "stat" },
		], projection({
			"Case.md": "included", "case.md": "included",
			"Case.conflict-local.md": "included", "Case.conflict-remote.md": "included",
			[unrelated.path]: "included",
		}), [...fixture.entries, { path: unrelated.path, local: unrelated }]);

		expect(result.failures).toEqual([]);
		expect(result.executable.actions).toContainEqual(expect.objectContaining({
			action: "push", path: unrelated.path,
		}));
		expect(result.executable.actions.some((action) =>
			action.action === "conflict" && action.protocol?.kind === "preservation_cover")).toBe(true);
	});

	it("selects the collision anchor by UTF-8 bytes and uses only full-digest candidates", () => {
		const utf16Earlier = freshEntity("😀.md", "remote", "R");
		const utf8Earlier = freshEntity(".md", "local");
		const paths = [insertConflictSuffix(".md", "local"), insertConflictSuffix(".md", "remote")];
		const result = admit([], [{
			kind: "alias", side: "local", requestedPath: "😀.md", resolvedPath: ".md",
		}], [
			{ kind: "alias", side: "local", requestedPath: "😀.md", resolvedPath: ".md", entity: utf8Earlier },
			{ kind: "exact", side: "local", requestedPath: ".md", entity: utf8Earlier },
			{ kind: "exact", side: "remote", requestedPath: "😀.md", entity: utf16Earlier },
			{ kind: "absent", side: "remote", requestedPath: ".md", authority: "stat" },
			...vacantCandidates(".md", ["local", "remote"]),
		], projection(Object.fromEntries(["😀.md", ".md", ...paths]
			.map((path) => [path, "included" as const]))), [
			{ path: "😀.md", remote: utf16Earlier }, { path: ".md", local: utf8Earlier },
		]);

		expect(result.failures).toEqual([]);
		expect(result.executable.actions[0]).toMatchObject({
			path: ".md", protocol: { kind: "preservation_cover", children: [
				{ candidatePath: paths[0] }, { candidatePath: paths[1] },
			] },
		});
	});

	it("covers a third readable version in the same closed collision component", () => {
		const local = freshEntity("case.md", "local");
		const remote = freshEntity("Case.md", "remote", "R");
		const third = freshEntity("third.md", "third");
		const candidates = ["Case.conflict-local.md", "Case.conflict-third.md", "Case.conflict-remote.md"];
		const result = admit([], [
			{ kind: "alias", side: "local", requestedPath: "Case.md", resolvedPath: "case.md" },
			{ kind: "rename", side: "local", oldPath: "Case.md", newPath: "third.md",
				isFolder: false, authority: "reported" },
			{ kind: "rename", side: "remote", oldPath: "case.md", newPath: "third.md",
				isFolder: false, authority: "reported" },
		], [
			{ kind: "alias", side: "local", requestedPath: "Case.md", resolvedPath: "case.md", entity: local },
			{ kind: "exact", side: "local", requestedPath: "case.md", entity: local },
			{ kind: "exact", side: "remote", requestedPath: "Case.md", entity: remote },
			{ kind: "exact", side: "local", requestedPath: "third.md", entity: third },
			{ kind: "absent", side: "remote", requestedPath: "case.md", authority: "stat" },
			{ kind: "absent", side: "remote", requestedPath: "third.md", authority: "stat" },
			...vacantCandidates("Case.md", ["local", "third", "remote"]),
		], projection(Object.fromEntries(["Case.md", "case.md", "third.md", ...candidates]
			.map((path) => [path, "included" as const]))), [
			{ path: "Case.md", remote }, { path: "case.md", local }, { path: "third.md", local: third },
		]);

		expect(result.failures).toEqual([]);
		expect(result.executable.actions[0]?.protocol).toMatchObject({
			kind: "preservation_cover",
			children: [
				{ content: { sha256: "local" }, candidatePath: candidates[0] },
				{ content: { sha256: "third" }, candidatePath: candidates[1] },
				{ content: { sha256: "remote" }, candidatePath: candidates[2] },
			],
		});
	});

	it("creates one child for three equal occurrences under contradictory reports", () => {
		const local = freshEntity("case.md", "same");
		const remote = freshEntity("Case.md", "same", "R");
		const third = freshEntity("third.md", "same");
		const candidate = insertConflictSuffix("Case.md", "same");
		const result = admit([], [
			{ kind: "alias", side: "local", requestedPath: "Case.md", resolvedPath: "case.md" },
			{ kind: "rename", side: "local", oldPath: "Case.md", newPath: "third.md", isFolder: false, authority: "reported" },
			{ kind: "rename", side: "remote", oldPath: "case.md", newPath: "third.md", isFolder: false, authority: "reported" },
		], [
			{ kind: "alias", side: "local", requestedPath: "Case.md", resolvedPath: "case.md", entity: local },
			{ kind: "exact", side: "local", requestedPath: "case.md", entity: local },
			{ kind: "exact", side: "remote", requestedPath: "Case.md", entity: remote },
			{ kind: "exact", side: "local", requestedPath: "third.md", entity: third },
			{ kind: "absent", side: "remote", requestedPath: "case.md", authority: "stat" },
			{ kind: "absent", side: "remote", requestedPath: "third.md", authority: "stat" },
			...vacantCandidates("Case.md", ["same"]),
		], projection(Object.fromEntries(["Case.md", "case.md", "third.md", candidate]
			.map((path) => [path, "included" as const]))), [
			{ path: "Case.md", remote }, { path: "case.md", local }, { path: "third.md", local: third },
		]);

		expect(result.failures).toEqual([]);
		expect(result.executable.actions[0]?.protocol).toMatchObject({
			kind: "preservation_cover", children: [{ candidatePath: candidate }],
		});
	});

	it("never allocates an excluded preservation candidate", () => {
		const fixture = caseAliasFixture(freshEntity("case.md", "local"), freshEntity("Case.md", "remote", "R"));
		const observations = [...fixture.observations, ...vacantCandidates("Case.md", ["local", "remote"])];
		const result = admit(fixture.actions, fixture.evidence, observations, projection({
			"Case.md": "included", "case.md": "included",
			"Case.conflict-remote.md": "included",
		}), fixture.entries);

		expect(result.executable.actions).toEqual([]);
		expect(result.failures).toMatchObject([{ reasons: ["preservation_destination_unavailable"] }]);
	});

	it("does not trust a baseline hash when existing candidate bytes are unproved", () => {
		const fixture = caseAliasFixture(freshEntity("case.md", "local"), freshEntity("Case.md", "remote", "R"));
		const unproved = freshEntity("Case.conflict-local.md", "");
		const baseline = { ...recordFor(unproved), hash: "local" };
		const result = admit(fixture.actions, fixture.evidence, [
			...fixture.observations,
			{ kind: "exact", side: "local", requestedPath: unproved.path, entity: unproved },
			{ kind: "absent", side: "remote", requestedPath: unproved.path, authority: "stat" },
			...vacantCandidates("Case.md", ["local", "remote"]).filter((item) => item.requestedPath !== unproved.path),
		], projection({
			"Case.md": "included", "case.md": "included",
			"Case.conflict-local.md": "included", "Case.conflict-remote.md": "included",
		}), [...fixture.entries, { path: unproved.path, local: unproved, prevSync: baseline }]);

		expect(result.executable.actions).toEqual([]);
		expect(result.failures.map((failure) => failure.reasons)).toContainEqual(["unknown_observation"]);
	});

	it("keeps the case-alias decision unchanged when unrelated terminal state exists", () => {
		const local = entity("case.md");
		const remote = entity("Case.md", "R");
		const unrelated: SyncRecord = {
			path: "unrelated.md", hash: "h", localMtime: 1, remoteMtime: 1,
			localSize: 1, remoteSize: 1, remoteIdentityKey: "id:unrelated.md", syncedAt: 1,
		};
		const result = admit(
			[
				{ path: "Case.md", action: "pull", remote },
				{ path: "case.md", action: "push", local },
			],
			[{ kind: "alias", side: "local", requestedPath: "Case.md", resolvedPath: "case.md" }],
			[
				{ kind: "alias", side: "local", requestedPath: "Case.md", resolvedPath: "case.md", entity: local },
				{ kind: "exact", side: "local", requestedPath: "case.md", entity: local },
				{ kind: "exact", side: "remote", requestedPath: "Case.md", entity: remote },
				{ kind: "absent", side: "remote", requestedPath: "case.md", authority: "stat" },
			],
			projection({
				"Case.md": "included", "case.md": "included", "unrelated.md": "included",
			}),
			[
				{ path: "Case.md", remote },
				{ path: "case.md", local },
				{ path: "unrelated.md", local: entity("unrelated.md"), remote: entity("unrelated.md"), prevSync: unrelated },
			],
		);

		expect(result.executable.actions).toEqual([{
			action: "rename_remote", content: { mode: "equal" },
			oldPath: "Case.md", path: "case.md", local, remote,
			publication: { source: undefined, destination: undefined },
		}]);
		expect(result.failures).toEqual([]);
	});

	it("rejects a case alias whose remote source is present but unresolved", () => {
		const fixture = caseAliasFixture();
		fixture.observations[2] = {
			kind: "present_unresolved", side: "remote", requestedPath: "Case.md",
			returnedPath: "Case.md", entity: {
				...fixture.remote, pathAuthority: "requested_echo",
			}, source: "stat",
		};

		const result = admit(
			fixture.actions, fixture.evidence, fixture.observations, fixture.scope, fixture.entries,
		);

		expect(result.executable.actions).toEqual([]);
		expect(result.failures[0]?.reasons).toEqual(["present_unresolved"]);
	});

	it("requires each alias endpoint fact and stat-authoritative target absence", () => {
		const missingAliasObservation = caseAliasFixture();
		missingAliasObservation.observations.splice(0, 1);

		const unresolvedLocalTarget = caseAliasFixture();
		unresolvedLocalTarget.observations[1] = {
			kind: "present_unresolved", side: "local", requestedPath: "case.md",
			returnedPath: "case.md", entity: {
				...unresolvedLocalTarget.local, pathAuthority: "requested_echo",
			}, source: "stat",
		};

		const nonStatRemoteAbsence = caseAliasFixture();
		nonStatRemoteAbsence.observations[3] = {
			kind: "absent", side: "remote", requestedPath: "case.md",
			authority: "checkpoint_deleted",
		};

		for (const [fixture, reason] of [
			[missingAliasObservation, "unknown_observation"],
			[unresolvedLocalTarget, "present_unresolved"],
			[nonStatRemoteAbsence, "unknown_observation"],
		] as const) {
			const result = admit(
				fixture.actions, fixture.evidence, fixture.observations,
				fixture.scope, fixture.entries,
			);
			expect(result.executable.actions).toEqual([]);
			expect(result.failures[0]?.reasons).toEqual([reason]);
		}
	});

	it("rejects a case alias when the remote identity has another current occurrence", () => {
		const fixture = caseAliasFixture();
		const duplicate = entity("other.md", "R");
		fixture.evidence.push({
			kind: "stable_identity", side: "remote", identityKey: "R", occurrences: [
				{ side: "remote", phase: "current", path: "Case.md", identityKey: "R" },
				{ side: "remote", phase: "current", path: "other.md", identityKey: "R" },
			],
		});
		fixture.observations.push({
			kind: "exact", side: "remote", requestedPath: "other.md", entity: duplicate,
		});
		fixture.entries.push({ path: "other.md", remote: duplicate });
		fixture.scope = projection({ "Case.md": "included", "case.md": "included", "other.md": "included" });

		const result = admit(
			fixture.actions, fixture.evidence, fixture.observations, fixture.scope, fixture.entries,
		);

		expect(result.executable.actions).toEqual([]);
		expect(result.failures[0]?.reasons).toEqual(["tracked_identity_multiple_occurrences"]);
	});

	it("rejects a case alias whose remote target is occupied by a foreign identity", () => {
		const fixture = caseAliasFixture();
		const foreign = entity("case.md", "F");
		fixture.entries[1]!.remote = foreign;
		fixture.observations[3] = {
			kind: "exact", side: "remote", requestedPath: "case.md", entity: foreign,
		};

		const result = admit(
			fixture.actions, fixture.evidence, fixture.observations, fixture.scope, fixture.entries,
		);

		expect(result.executable.actions).toEqual([]);
		expect(result.failures[0]?.reasons).toEqual(["conflicting_identity"]);
	});

	it("rejects unknown bytes but preserves independently proven size variants", () => {
		const unhashed = caseAliasFixture(
			freshEntity("case.md", ""), freshEntity("Case.md", "", "R"),
		);
		const unproven = admit(
			unhashed.actions, unhashed.evidence, unhashed.observations, unhashed.scope, unhashed.entries,
		);
		const mismatched = caseAliasFixture(
			entity("case.md"), { ...freshEntity("Case.md", "h2", "R"), size: 2 },
		);
		const differentSize = admit(
			mismatched.actions, mismatched.evidence,
			[...mismatched.observations, ...vacantCandidates("Case.md", ["h", "h2"])],
			projection({
				"Case.md": "included", "case.md": "included",
				"Case.conflict-h.md": "included", "Case.conflict-h2.md": "included",
			}), mismatched.entries,
		);

		expect(unproven.failures[0]?.reasons).toEqual(["unknown_observation"]);
		expect(differentSize.failures).toEqual([]);
		expect(differentSize.executable.actions[0]).toMatchObject({
			action: "conflict", protocol: { kind: "preservation_cover", children: [{}, {}] },
		});
	});

	it("does not authorize a case alias with unknown scope", () => {
		const fixture = caseAliasFixture();
		const unknownScope = projection({ "Case.md": "included", "case.md": "unknown" });

		const result = admit(
			fixture.actions, fixture.evidence, fixture.observations, unknownScope, fixture.entries,
		);

		expect(result.executable.actions).toEqual([]);
		expect(result.failures[0]?.reasons).toContain("unknown_scope");
	});

	it("uses ordinary baseline-backed fresh reconciliation for a changed case alias", () => {
		const fixture = caseAliasFixture(
			freshEntity("case.md", "local"), freshEntity("Case.md", "h", "R"),
		);
		fixture.entries[0]!.prevSync = {
			path: "Case.md", hash: "h", localMtime: 1, remoteMtime: 1,
			localSize: 1, remoteSize: 1, syncedAt: 1, remoteIdentityKey: "R",
		};

		const result = admit(
			fixture.actions, fixture.evidence, fixture.observations, fixture.scope, fixture.entries,
		);

		expect(result.executable.actions).toMatchObject([{
			action: "rename_remote", content: { mode: "copy",
				read: { side: "local", entity: fixture.local }, write: { side: "remote", path: "case.md" } },
			oldPath: "Case.md", path: "case.md",
		}]);
		expect(result.executable.actions[0]).not.toHaveProperty("protocol");
	});

	it("routes a determinate local-move candidate through the final identity verdict", () => {
		const fixture = caseAliasFixture(
			freshEntity("case.md", "local"), freshEntity("Case.md", "h", "R"),
		);
		fixture.entries[0]!.prevSync = {
			path: "Case.md", hash: "h", localMtime: 1, remoteMtime: 1,
			localSize: 1, remoteSize: 1, syncedAt: 1, remoteIdentityKey: "R",
		};
		fixture.evidence.push({
			kind: "stable_identity", side: "remote", identityKey: "foreign", occurrences: [{
				side: "remote", phase: "current", path: "Case.md", identityKey: "foreign",
			}],
		});

		const result = admit(
			fixture.actions, fixture.evidence, fixture.observations, fixture.scope, fixture.entries,
		);

		expect(result.executable.actions).toEqual([]);
		expect(result.dispositions).toHaveLength(1);
		expect(result.dispositions[0]).toMatchObject({
			kind: "failed", reasons: ["conflicting_identity"],
		});
	});

	it("defers a native rename whose current destination identity contradicts the report", () => {
		const action: SyncAction = {
			path: "B.md", oldPath: "A.md", action: "rename_local",
			local: entity("A.md"), remote: entity("B.md", "Y"),
		};
		const scope = projection({ "A.md": "included", "B.md": "included" });

		const result = admit([action], [remoteRename()], [], scope);

		expect(result.executable.actions).toEqual([]);
		expect(result.failures[0]!.reasons).toEqual(["conflicting_identity"]);
	});

	it("defers a reported rename that contradicts stable baseline identity", () => {
		const action: SyncAction = {
			path: "B.md", oldPath: "A.md", action: "rename_local",
			local: entity("A.md"), remote: entity("B.md", "X"),
		};
		const evidence: IdentityEvidence[] = [remoteRename(), {
			kind: "stable_identity", side: "remote", identityKey: "Y", occurrences: [
				{ side: "remote", phase: "baseline", path: "A.md", identityKey: "Y" },
				{ side: "remote", phase: "current", path: "C.md", identityKey: "Y" },
			],
		}];
		const scope = projection({ "A.md": "included", "B.md": "included", "C.md": "included" });

		const result = admit([action], evidence, [], scope);

		expect(result.executable.actions).toEqual([]);
		expect(result.failures[0]!.reasons).toEqual(["conflicting_identity"]);
	});

	it("admits a native rename when alias evidence is on the source side", () => {
		const baseline = recordFor(entity("A.md", "X"));
		const action: SyncAction = {
			path: "a.md", oldPath: "A.md", action: "rename_remote",
			local: entity("a.md"), remote: entity("A.md", "X"), baseline,
		};
		const evidence: IdentityEvidence[] = [
			remoteRename({ side: "local", oldPath: "A.md", newPath: "a.md", identityKey: undefined }),
			{ kind: "alias", side: "local", requestedPath: "A.md", resolvedPath: "a.md" },
		];
		const scope = projection({ "A.md": "included", "a.md": "included" });

		const result = admit([action], evidence, [
			{ kind: "alias", side: "local", requestedPath: "A.md", resolvedPath: "a.md", entity: action.local! },
			{ kind: "absent", side: "remote", requestedPath: "a.md", authority: "stat" },
		], scope);

		expect(result.executable.actions).toEqual([{
			...action, content: { mode: "equal" }, publication: { source: baseline, destination: undefined },
		}]);
		expect(result.failures).toEqual([]);
	});

	it("preserves a foreign rename destination through a fixed conflict action", () => {
		const baseline = recordFor(entity("A.md", "X"));
		const action: SyncAction = {
			path: "B.md", oldPath: "A.md", action: "rename_remote",
			local: entity("B.md"), remote: entity("A.md", "X"), baseline,
		};
		const evidence = [remoteRename({ side: "local", identityKey: undefined })];
		const observations: PathObservation[] = [{
			kind: "exact", side: "remote", requestedPath: "B.md", entity: entity("B.md", "Y"),
		}, { kind: "absent", side: "local", requestedPath: "A.md", authority: "stat" }];
		const scope = projection({ "A.md": "included", "B.md": "included" });

		const result = admit([action], evidence, observations, scope);

		expect(result.failures).toEqual([]);
		expect(result.executable.actions).toEqual([{
			action: "conflict", path: "B.md", local: action.local, remote: action.remote, baseline,
			remoteIdentitySource: action.remote, additionalRemote: entity("B.md", "Y"),
			additionalLocal: undefined, protocol: { kind: "same_path" },
			conflictPolicy: { mode: "auto_merge", strategy: "auto_merge" },
			publication: { source: baseline, destination: undefined },
		}]);
	});

	it("rejects missing endpoint observations regardless of fixture action labels", () => {
		const actions: FixtureAction[] = [
			{ path: "A.md", action: "delete_local", local: entity("A.md") },
			{ path: "B.md", action: "delete_remote", remote: entity("B.md", "X") },
		];
		const scope = projection({ "A.md": "included", "B.md": "included" });

		const result = admit(actions, [remoteRename()], [], scope);

		expect(result.executable.actions).toEqual([]);
		expect(result.failures[0]!.reasons).toEqual(["unknown_observation"]);
	});

	it("defers a rename crossing an unknown scope endpoint", () => {
		const action: SyncAction = { path: "A.md", action: "delete_local", local: entity("A.md") };
		const scope = projection({ "A.md": "included", "B.md": "unknown" });

		const result = admit([action], [remoteRename()], [], scope);

		expect(result.executable.actions).toEqual([]);
		expect(result.failures[0]!.reasons).toEqual(["unknown_scope"]);
	});

	it("admits source recreation when unequal remote identities prove both resources", () => {
		const actions: FixtureAction[] = [
			{ path: "A.md", action: "pull", remote: entity("A.md", "Y") },
			{ path: "B.md", action: "pull", remote: entity("B.md", "X") },
		];
		const observations: PathObservation[] = [
			{ kind: "exact", side: "remote", requestedPath: "A.md", entity: entity("A.md", "Y") },
			{ kind: "exact", side: "remote", requestedPath: "B.md", entity: entity("B.md", "X") },
			{ kind: "absent", side: "local", requestedPath: "A.md", authority: "stat" },
			{ kind: "absent", side: "local", requestedPath: "B.md", authority: "stat" },
		];
		const scope = projection({ "A.md": "included", "B.md": "included" });

		const result = admit(actions, [remoteRename()], observations, scope);

		expect(result.executable.actions).toEqual([actions[1], actions[0]].map((action) => ({
			...action, publication: { source: undefined, destination: undefined },
		})));
		expect(result.failures).toEqual([]);
	});

	it("does not import an extra proposed rename into a current-fact source-recreation decision", () => {
		const actions: FixtureAction[] = [
			{ path: "B.md", action: "pull", remote: entity("B.md", "X") },
			{ path: "B.md", oldPath: "A.md", action: "rename_remote" },
		];
		const observations: PathObservation[] = [
			{ kind: "exact", side: "remote", requestedPath: "A.md", entity: entity("A.md", "Y") },
			{ kind: "exact", side: "remote", requestedPath: "B.md", entity: entity("B.md", "X") },
			{ kind: "absent", side: "local", requestedPath: "A.md", authority: "stat" },
			{ kind: "absent", side: "local", requestedPath: "B.md", authority: "stat" },
		];
		const scope = projection({ "A.md": "included", "B.md": "included" });

		const result = admit(actions, [remoteRename()], observations, scope);

		expect(result.failures).toEqual([]);
		expect(result.executable.actions).toEqual([
			{ action: "pull", path: "B.md", remote: entity("B.md", "X"), publication: { source: undefined, destination: undefined } },
			{ action: "pull", path: "A.md", remote: entity("A.md", "Y"), publication: { source: undefined, destination: undefined } },
		]);
	});

	it("does not join a disjoint resource through an obsolete action oldPath", () => {
		const actions: FixtureAction[] = [
			{ path: "B.md", action: "pull", remote: entity("B.md", "X") },
			{ path: "C.md", oldPath: "A.md", action: "rename_remote", remote: entity("C.md", "Z") },
		];
		const observations: PathObservation[] = [
			{ kind: "exact", side: "remote", requestedPath: "A.md", entity: entity("A.md", "Y") },
			{ kind: "exact", side: "remote", requestedPath: "B.md", entity: entity("B.md", "X") },
			{ kind: "exact", side: "remote", requestedPath: "C.md", entity: entity("C.md", "Z") },
			{ kind: "absent", side: "local", requestedPath: "A.md", authority: "stat" },
			{ kind: "absent", side: "local", requestedPath: "B.md", authority: "stat" },
			{ kind: "absent", side: "local", requestedPath: "C.md", authority: "stat" },
		];
		const scope = projection({ "A.md": "included", "B.md": "included", "C.md": "included" });

		const result = admit(actions, [remoteRename()], observations, scope);

		expect(result.failures).toEqual([]);
		expect(result.executable.components.map(({ actions }) => actions.map(({ path, action }) => ({ path, action })))).toEqual([
			[{ path: "B.md", action: "pull" }, { path: "A.md", action: "pull" }],
			[{ path: "C.md", action: "pull" }],
		]);
	});

	it("replaces a proposed conflict with match when current destination bytes agree", () => {
		const actions: FixtureAction[] = [
			{ path: "A.md", action: "pull", remote: entity("A.md", "Y") },
			{ path: "B.md", action: "conflict", local: entity("B.md"), remote: entity("B.md", "X") },
		];
		const observations: PathObservation[] = [
			{ kind: "exact", side: "remote", requestedPath: "A.md", entity: entity("A.md", "Y") },
			{ kind: "exact", side: "remote", requestedPath: "B.md", entity: entity("B.md", "X") },
			{ kind: "absent", side: "local", requestedPath: "A.md", authority: "stat" },
		];
		const scope = projection({ "A.md": "included", "B.md": "included" });

		const result = admit(actions, [remoteRename()], observations, scope);

		expect(result.failures).toEqual([]);
		expect(result.executable.actions).toEqual([
			{ action: "match", path: "B.md", local: entity("B.md"), remote: entity("B.md", "X"),
				publication: { source: undefined, destination: undefined } },
			{ action: "pull", path: "A.md", remote: entity("A.md", "Y"),
				publication: { source: undefined, destination: undefined } },
		]);
	});

	it("retains the exact-path comparison baseline after abandoning a relation", () => {
		const baselineEntity = freshEntity("B.md", "base", "X");
		const baseline = recordFor(baselineEntity);
		const local = freshEntity("B.md", "local");
		const actions: FixtureAction[] = [
			{ path: "A.md", action: "pull", remote: entity("A.md", "Y") },
			{ path: "B.md", action: "conflict", local, remote: baselineEntity, baseline },
		];
		const observations: PathObservation[] = [
			{ kind: "exact", side: "remote", requestedPath: "A.md", entity: entity("A.md", "Y") },
			{ kind: "exact", side: "remote", requestedPath: "B.md", entity: baselineEntity },
			{ kind: "exact", side: "local", requestedPath: "B.md", entity: local },
			{ kind: "absent", side: "local", requestedPath: "A.md", authority: "stat" },
		];
		const scope = projection({ "A.md": "included", "B.md": "included" });

		const result = admit(actions, [remoteRename()], observations, scope);

		expect(result.failures).toEqual([]);
		expect(result.executable.actions).toEqual([
			{ action: "pull", path: "A.md", remote: entity("A.md", "Y"),
				publication: { source: undefined, destination: undefined } },
			{ action: "push", path: "B.md", local, remote: baselineEntity, baseline,
				publication: { source: baseline, destination: baseline } },
		]);
	});

	it("abandons relations by preserving a present side while retaining its exact publication CAS", () => {
		const baseline = recordFor(freshEntity("B.md", "base", "X"));
		const local = freshEntity("B.md", "local");
		const component: IdentityComponent = {
			paths: new Set(["A.md", "B.md", "C.md"]),
			entries: [{ path: "B.md", local, prevSync: baseline }],
			evidence: [remoteRename(), remoteRename({ newPath: "C.md" })],
			observations: [
				...(["A.md", "C.md"] as const).flatMap((path) => ([
					{ kind: "absent" as const, side: "local" as const, requestedPath: path, authority: "stat" as const },
					{ kind: "absent" as const, side: "remote" as const, requestedPath: path, authority: "stat" as const },
				])),
				{ kind: "exact", side: "local", requestedPath: "B.md", entity: local },
				{ kind: "absent", side: "remote", requestedPath: "B.md", authority: "stat" },
			],
		};

		const decision = decideIdentityComponent(component, projection({
			"A.md": "included", "B.md": "included", "C.md": "included",
		}));

		expect(decision.reasons).toEqual([]);
		expect(decision.component.actions).toEqual([{
			action: "push", path: "B.md", local, remote: undefined, baseline: undefined,
			publication: { source: baseline, destination: baseline },
		}]);
	});

	it("preserves a remote-only side after abandoning a relation", () => {
		const baseline = recordFor(freshEntity("B.md", "base", "X"));
		const remote = freshEntity("B.md", "remote", "X");
		const component: IdentityComponent = {
			paths: new Set(["A.md", "B.md", "C.md"]),
			entries: [{ path: "B.md", remote, prevSync: baseline }],
			evidence: [remoteRename(), remoteRename({ newPath: "C.md" })],
			observations: [
				...(["A.md", "C.md"] as const).flatMap((path) => ([
					{ kind: "absent" as const, side: "local" as const, requestedPath: path, authority: "stat" as const },
					{ kind: "absent" as const, side: "remote" as const, requestedPath: path, authority: "stat" as const },
				])),
				{ kind: "absent", side: "local", requestedPath: "B.md", authority: "stat" },
				{ kind: "exact", side: "remote", requestedPath: "B.md", entity: remote },
			],
		};

		const decision = decideIdentityComponent(component, projection({
			"A.md": "included", "B.md": "included", "C.md": "included",
		}));

		expect(decision.reasons).toEqual([]);
		expect(decision.component.actions).toEqual([{
			action: "pull", path: "B.md", local: undefined, remote, baseline: undefined,
			publication: { source: baseline, destination: baseline },
		}]);
	});

	it("retains exact cleanup when a committed path is authoritatively absent on both sides", () => {
		const baseline = recordFor(freshEntity("gone.md", "base", "X"));
		const decision = decideIdentityComponent({
			paths: new Set(["gone.md"]), entries: [{ path: "gone.md", prevSync: baseline }], evidence: [],
			observations: [
				{ kind: "absent", side: "local", requestedPath: "gone.md", authority: "stat" },
				{ kind: "absent", side: "remote", requestedPath: "gone.md", authority: "stat" },
			],
		}, projection({ "gone.md": "included" }));

		expect(decision.reasons).toEqual([]);
		expect(decision.component.actions).toEqual([{
			action: "cleanup", path: "gone.md", local: undefined, remote: undefined, baseline,
			publication: { source: baseline, destination: baseline },
		}]);
	});

	it.each([
		{ name: "local-only change", localHash: "local", remoteHash: "base", action: "push" },
		{ name: "remote-only change", localHash: "base", remoteHash: "remote", action: "pull" },
		{ name: "divergent changes", localHash: "local", remoteHash: "remote", action: "conflict" },
		{ name: "same new bytes", localHash: "new", remoteHash: "new", action: "match" },
		{ name: "unchanged bytes", localHash: "base", remoteHash: "base", action: undefined },
	])("keeps two-sided exact comparison and publication identical after relation abandonment: $name", ({ localHash, remoteHash, action }) => {
		const baseline = recordFor(freshEntity("B.md", "base", "X"));
		const local = freshEntity("B.md", localHash);
		const remote = freshEntity("B.md", remoteHash, "X");
		const observations: PathObservation[] = [
			{ kind: "exact", side: "local", requestedPath: "B.md", entity: local },
			{ kind: "exact", side: "remote", requestedPath: "B.md", entity: remote },
		];
		const direct: IdentityComponent = {
			paths: new Set(["B.md"]), entries: [{ path: "B.md", local, remote, prevSync: baseline }],
			evidence: [], observations,
		};
		const abandoned: IdentityComponent = {
			paths: new Set(["A.md", "B.md", "C.md"]),
			entries: [{ path: "B.md", local, remote, prevSync: baseline }],
			evidence: [remoteRename(), remoteRename({ newPath: "C.md" })],
			observations: [
				...observations,
				...(["A.md", "C.md"] as const).flatMap((path) => ([
					{ kind: "absent" as const, side: "local" as const, requestedPath: path, authority: "stat" as const },
					{ kind: "absent" as const, side: "remote" as const, requestedPath: path, authority: "stat" as const },
				])),
			],
		};
		const directDecision = decideIdentityComponent(direct, projection({ "B.md": "included" }));
		const abandonedDecision = decideIdentityComponent(abandoned, projection({
			"A.md": "included", "B.md": "included", "C.md": "included",
		}));

		expect(directDecision.reasons).toEqual([]);
		expect(abandonedDecision.reasons).toEqual([]);
		expect(abandonedDecision.component.actions).toEqual(directDecision.component.actions);
		expect(directDecision.component.actions.map((item) => item.action)).toEqual(action ? [action] : []);
		for (const item of directDecision.component.actions) {
			expect(item.publication).toEqual({ source: baseline, destination: baseline });
		}
	});

	it("requires preservation for a Prefer-local conflict after abandoning a rename relation", () => {
		const baseline = recordFor(freshEntity("B.md", "base", "X"));
		const local = freshEntity("B.md", "local");
		const remote = freshEntity("B.md", "remote", "X");
		const observations: PathObservation[] = [
			{ kind: "exact", side: "local", requestedPath: "B.md", entity: local },
			{ kind: "exact", side: "remote", requestedPath: "B.md", entity: remote },
			...(["A.md", "C.md"] as const).flatMap((path) => ([
				{ kind: "absent" as const, side: "local" as const, requestedPath: path, authority: "stat" as const },
				{ kind: "absent" as const, side: "remote" as const, requestedPath: path, authority: "stat" as const },
			])),
		];
		const decision = decideIdentityComponent({
			paths: new Set(["A.md", "B.md", "C.md"]),
			entries: [{ path: "B.md", local, remote, prevSync: baseline }],
			evidence: [remoteRename(), remoteRename({ newPath: "C.md" })],
			observations,
		}, projection({ "A.md": "included", "B.md": "included", "C.md": "included" }), undefined, "prefer_local");

		expect(decision.reasons).toEqual([]);
		expect(decision.component.actions).toMatchObject([{
			action: "conflict", protocol: { kind: "same_path" }, conflictPolicy: { mode: "preserve", strategy: "prefer_local" },
		}]);
	});

	it("defers a folder rename when a projected descendant is not mapped", () => {
		const fixture = folderFacts(["known.md", "missing.md"]);
		fixture.entries = fixture.entries.filter(({ path }) => path !== "B/missing.md");
		fixture.observations = fixture.observations.filter((item) =>
			!(item.side === "remote" && item.requestedPath === "B/missing.md"));
		const result = admit([], fixture.evidence, fixture.observations, fixture.scope, fixture.entries);

		expect(result.executable.actions).toEqual([]);
		expect(result.failures[0]!.actions).toEqual([]);
		expect(result.failures[0]!.reasons).toEqual(["unknown_observation"]);
	});

	it("defers a folder rename containing a descendant absent from scope projection", () => {
		const fixture = folderFacts(["hidden.md"]);
		const scope = projection({ A: "included", B: "included" });
		const result = admit([], fixture.evidence, fixture.observations, scope, fixture.entries);

		expect(result.executable.actions).toEqual([]);
		expect(result.failures[0]!.reasons).toEqual(["unknown_scope"]);
	});

	it("abandons a crossed folder relation and preserves each exact descendant path", () => {
		const fixture = folderFacts(["x.md", "y.md"]);
		fixture.evidence.push(
			remoteRename({ oldPath: "A/x.md", newPath: "B/y.md", identityKey: "file:y.md" }),
			remoteRename({ oldPath: "A/y.md", newPath: "B/x.md", identityKey: "file:x.md" }),
		);
		const result = admit([], fixture.evidence, fixture.observations, fixture.scope, fixture.entries);

		expect(result.failures).toEqual([]);
		expect(result.executable.actions.map(({ action, path }) => ({ action, path }))).toEqual([
			{ action: "push", path: "A/x.md" }, { action: "push", path: "A/y.md" },
			{ action: "pull", path: "B/x.md" }, { action: "pull", path: "B/y.md" },
		]);
	});

	it("classifies conflicting reports with missing counterpart facts as observation failure", () => {
		const actions: FixtureAction[] = [
			{ path: "A.md", action: "delete_local", local: entity("A.md") },
			{ path: "B.md", action: "pull", remote: entity("B.md", "X") },
			{ path: "C.md", action: "pull", remote: entity("C.md", "Y") },
		];
		const reports = [
			remoteRename({ oldPath: "A.md", newPath: "B.md" }),
			remoteRename({ oldPath: "A.md", newPath: "C.md" }),
		];

		for (const evidence of [reports, [...reports].reverse()]) {
			const result = admit(actions, evidence, [], projection({
				"A.md": "included", "B.md": "included", "C.md": "included",
			}));

			expect(result.executable.actions).toEqual([]);
			expect(result.dispositions).toHaveLength(1);
				expect(result.dispositions[0]).toMatchObject({
					kind: "failed", reasons: ["unknown_observation"], actions: [],
				});
		}
	});

	it("does not use an alias when conflicting report endpoints remain unobserved", () => {
		const fixture = caseAliasFixture();
		const reports: IdentityEvidence[] = [
			remoteRename({ oldPath: "Case.md", newPath: "X.md" }),
			remoteRename({ oldPath: "Case.md", newPath: "Y.md" }),
		];
		const scope = projection({
			"Case.md": "included", "case.md": "included",
			"X.md": "included", "Y.md": "included",
		});
		const permutations = [
			{ actions: fixture.actions, evidence: [...fixture.evidence, ...reports], observations: fixture.observations },
			{ actions: [...fixture.actions].reverse(), evidence: [...reports, ...fixture.evidence], observations: [...fixture.observations].reverse() },
		];

		const control = admit(
			fixture.actions, fixture.evidence, fixture.observations, fixture.scope, fixture.entries,
		);
		expect(control.dispositions).toMatchObject([{ kind: "authorized" }]);
		for (const variant of permutations) {
			const result = admit(
				variant.actions, variant.evidence, variant.observations, scope, fixture.entries,
			);
			expect(result.executable.actions).toEqual([]);
			expect(result.dispositions).toHaveLength(1);
			expect(result.failures[0]!.reasons).toEqual(["unknown_observation"]);
		}
	});

	it("reports orthogonal observation failure before report-family conflict", () => {
		const result = admit([
			{ path: "A.md", action: "delete_local", local: entity("A.md") },
		], [
			remoteRename({ oldPath: "A.md", newPath: "B.md" }),
			remoteRename({ oldPath: "A.md", newPath: "C.md" }),
		], [{
			kind: "present_unresolved", side: "remote", requestedPath: "A.md",
			returnedPath: "A.md", entity: entity("A.md", "X"), source: "stat",
		}], projection({
			"A.md": "included", "B.md": "included", "C.md": "included",
		}));

		expect(result.executable.actions).toEqual([]);
		expect(result.failures[0]!.reasons).toEqual(["present_unresolved"]);
	});

	it("rejects distinct same-side file roots joined into one identity component", () => {
		const baseline = (path: string, remoteIdentityKey: string): SyncRecord => ({
			path, hash: "h", localMtime: 1, remoteMtime: 1,
			localSize: 1, remoteSize: 1, remoteIdentityKey, syncedAt: 1,
		});
		const result = admit([
			{
				path: "A.md", action: "delete_remote", remote: entity("A.md", "L"),
				baseline: baseline("A.md", "L"),
			},
			{ path: "B.md", action: "push", local: entity("B.md") },
			{
				path: "C.md", action: "delete_remote", remote: entity("C.md", "R"),
				baseline: baseline("C.md", "R"),
			},
			{ path: "D.md", action: "push", local: entity("D.md") },
		], [
			remoteRename({ side: "local", oldPath: "A.md", newPath: "B.md", identityKey: undefined }),
			remoteRename({ side: "local", oldPath: "C.md", newPath: "D.md", identityKey: undefined }),
			{
				kind: "stable_identity", side: "remote", identityKey: "R", occurrences: [
					{ side: "remote", phase: "current", path: "B.md", identityKey: "R" },
					{ side: "remote", phase: "baseline", path: "C.md", identityKey: "R" },
				],
			},
		], [], projection({
			"A.md": "included", "B.md": "included", "C.md": "included", "D.md": "included",
		}));

		expect(result.executable.actions).toEqual([]);
		expect(result.failures[0]!.reasons).toEqual(["conflicting_identity"]);
	});

	it("rejects two report families joined into one identity component", () => {
		const baseline = (path: string, remoteIdentityKey: string): SyncRecord => ({
			path, hash: "h", localMtime: 1, remoteMtime: 1,
			localSize: 1, remoteSize: 1, remoteIdentityKey, syncedAt: 1,
		});
		const actions: FixtureAction[] = [
			{
				path: "A.md", action: "delete_remote", remote: entity("A.md", "L"),
				baseline: baseline("A.md", "L"),
			},
			{ path: "B.md", action: "push", local: entity("B.md") },
			{
				path: "C.md", action: "delete_local", local: entity("C.md"),
				baseline: baseline("C.md", "R"),
			},
			{ path: "D.md", action: "pull", remote: entity("D.md", "R") },
		];
		const evidence: IdentityEvidence[] = [
			remoteRename({
				side: "local", oldPath: "A.md", newPath: "B.md", identityKey: undefined,
			}),
			remoteRename({ oldPath: "C.md", newPath: "D.md", identityKey: "R" }),
			{
				kind: "stable_identity", side: "remote", identityKey: "R", occurrences: [
					{ side: "remote", phase: "current", path: "B.md", identityKey: "R" },
					{ side: "remote", phase: "baseline", path: "C.md", identityKey: "R" },
				],
			},
		];

		const result = admit(actions, evidence, [], projection({
			"A.md": "included", "B.md": "included", "C.md": "included", "D.md": "included",
		}));

		expect(result.executable.actions).toEqual([]);
		expect(result.dispositions).toHaveLength(1);
		expect(result.failures[0]!.reasons).toEqual(["conflicting_identity"]);
	});

	it("rejects an unobserved descendant alias before constructing a folder action", () => {
		const fixture = folderFacts(["x.md", "y.md"]);
		fixture.evidence.push({ kind: "alias", side: "local", requestedPath: "B/y.md", resolvedPath: "A/y.md" });
		const result = admit([], fixture.evidence, fixture.observations, fixture.scope, fixture.entries);

		expect(result.executable.actions).toEqual([]);
		expect(result.failures).toHaveLength(1);
		expect(result.failures[0]!.reasons).toEqual(["unknown_observation"]);
	});

	it("rejects an alias outside a complete selected folder mapping", () => {
		const fixture = folderFacts(["x.md", "y.md"]);
		fixture.evidence.push({ kind: "alias", side: "local", requestedPath: "B/x.md", resolvedPath: "A/y.md" });
		fixture.observations = fixture.observations.filter((item) => !(item.side === "local" && item.requestedPath === "B/x.md"));
		fixture.observations.push({ kind: "alias", side: "local", requestedPath: "B/x.md", resolvedPath: "A/y.md", entity: entity("A/y.md") });
		const result = admit([], fixture.evidence, fixture.observations, fixture.scope, fixture.entries);

		expect(result.executable.actions).toEqual([]);
		expect(result.failures[0]!.reasons).toEqual(["unknown_observation"]);
	});

	it("rejects two current identities claiming the same folder descendant endpoint", () => {
		const fixture = folderFacts();
		fixture.observations.push({ kind: "exact", side: "remote", requestedPath: "B/x.md", entity: entity("B/x.md", "foreign") });
		const result = admit([], fixture.evidence, fixture.observations, fixture.scope, fixture.entries);

		expect(result.executable.actions).toEqual([]);
		expect(result.failures[0]!.reasons).toEqual(["conflicting_identity"]);
	});

	it("does not derive rename authority from an action-shaped folder mapping", () => {
		const localAlias = entity("A/x.md");
		const remoteFolder = { ...entity("A", "folder"), isDirectory: true };
		const action: SyncAction = {
			path: "B", oldPath: "A", action: "rename_remote", isFolder: true,
			descendants: [{ oldPath: "A/x.md", newPath: "B/x.md" }],
		};
		const result = admit([action], [
			{ kind: "alias", side: "local", requestedPath: "B/x.md", resolvedPath: "A/x.md" },
		], [
			{ kind: "alias", side: "local", requestedPath: "B/x.md", resolvedPath: "A/x.md", entity: localAlias },
			{ kind: "exact", side: "remote", requestedPath: "A", entity: remoteFolder },
			{ kind: "absent", side: "remote", requestedPath: "B", authority: "stat" },
		], projection({
			A: "included", B: "included", "A/x.md": "included", "B/x.md": "included",
		}));

		expect(result.executable.actions).toEqual([]);
		expect(result.failures[0]!.reasons).toEqual(["unknown_observation"]);
	});

	it("constructs exactly one folder root action despite duplicate obsolete proposals", () => {
		const fixture = folderFacts();
		const action: SyncAction = {
			path: "B", oldPath: "A", action: "rename_local", isFolder: true,
			descendants: [{ oldPath: "A/x.md", newPath: "B/x.md" }],
		};
		const result = admit([action, { ...action }], fixture.evidence, fixture.observations, fixture.scope, fixture.entries);

		expect(result.failures).toEqual([]);
		expect(result.executable.actions).toMatchObject([action]);
	});

	it("preserves an observed file when an invalid folder relation is abandoned", () => {
		const fixture = folderFacts([]);
		fixture.entries[0]!.local = entity("A");
		fixture.observations[0] = { kind: "exact", side: "local", requestedPath: "A", entity: entity("A") };
		const action: SyncAction = {
			path: "B", oldPath: "A", action: "rename_local",
		};
		const result = admit([action], fixture.evidence, fixture.observations, fixture.scope, fixture.entries);

		expect(result.failures).toEqual([]);
		expect(result.executable.actions).toMatchObject([{ action: "push", path: "A" }]);
	});

	it("uses the shallowest aligned folder report as the governing root", () => {
		const fixture = folderFacts(["sub/x.md"]);
		const action: SyncAction = {
			path: "B", oldPath: "A", action: "rename_local", isFolder: true,
			descendants: [
				{ oldPath: "A/sub/x.md", newPath: "B/sub/x.md" },
			],
		};
		const reports = [
			remoteRename({ oldPath: "A", newPath: "B", isFolder: true, identityKey: "root" }),
			remoteRename({
				oldPath: "A/sub", newPath: "B/sub", isFolder: true, identityKey: "folder:sub",
			}),
			remoteRename({
				oldPath: "A/sub/x.md", newPath: "B/sub/x.md", identityKey: "file:sub/x.md",
			}),
		];
		const scope = projection({
			A: "included", B: "included", "A/sub": "included", "B/sub": "included",
			"A/sub/x.md": "included", "B/sub/x.md": "included",
		});

		for (const evidence of [reports, [...reports].reverse()]) {
			const result = admit([action], evidence, fixture.observations, scope, fixture.entries);
			expect(result.failures).toEqual([]);
			expect(result.executable.actions).toMatchObject([action]);
		}
	});

	it("materializes full-scan nested folder reports as one governing root action", () => {
		const fixture = folderFacts(["sub/x.md"]);
		const actions: FixtureAction[] = [
			{ path: "A/sub/x.md", action: "delete_local", local: entity("A/sub/x.md") },
			{ path: "B/sub/x.md", action: "pull", remote: entity("B/sub/x.md", "file:sub/x.md") },
		];
		const reports = [
			remoteRename({ oldPath: "A", newPath: "B", isFolder: true, identityKey: "root" }),
			remoteRename({
				oldPath: "A/sub", newPath: "B/sub", isFolder: true, identityKey: "folder:sub",
			}),
			remoteRename({
				oldPath: "A/sub/x.md", newPath: "B/sub/x.md", identityKey: "file:sub/x.md",
			}),
		];
		const result = admit(actions, reports, fixture.observations, projection({
			A: "included", B: "included", "A/sub": "included", "B/sub": "included",
			"A/sub/x.md": "included", "B/sub/x.md": "included",
		}), fixture.entries);

		expect(result.failures).toEqual([]);
		expect(result.executable.actions).toMatchObject([{
			action: "rename_local", oldPath: "A", path: "B", isFolder: true,
			descendants: [{ oldPath: "A/sub/x.md", newPath: "B/sub/x.md" }],
		}]);
	});

	it("uses file-level local moves when a directory crosses the hidden-path adapter boundary", () => {
		const fixture = folderFacts();
		const remap = (path: string) => path === "A" || path.startsWith("A/") ? `.${path}` : path;
		const entries = fixture.entries.map((entry) => ({
			...entry, path: remap(entry.path),
			local: entry.local && { ...entry.local, path: remap(entry.local.path) },
			remote: entry.remote && { ...entry.remote, path: remap(entry.remote.path) },
			prevSync: entry.prevSync && { ...entry.prevSync, path: remap(entry.prevSync.path) },
		}));
		const observations = fixture.observations.map((item): PathObservation => ({
			...item, requestedPath: remap(item.requestedPath),
			...("entity" in item ? { entity: { ...item.entity, path: remap(item.entity.path) } } : {}),
		}));
		const result = admit([], [remoteRename({ oldPath: ".A", newPath: "B", isFolder: true, identityKey: "root" })],
			observations, projection({ ".A": "included", B: "included", ".A/x.md": "included", "B/x.md": "included" }), entries);
		expect(result.failures).toEqual([]);
		expect(result.executable.actions).toMatchObject([{
			action: "rename_local", oldPath: ".A/x.md", path: "B/x.md", content: { mode: "equal" },
			publication: { source: { path: ".A/x.md" }, destination: undefined },
		}]);
	});

	it("accepts an alias matching a reported nested folder under the governing root", () => {
		const fixture = folderFacts(["sub/x.md"]);
		fixture.observations = fixture.observations.filter((item) => !(item.side === "local" && item.requestedPath === "B/sub"));
		fixture.observations.push({ kind: "alias", side: "local", requestedPath: "B/sub", resolvedPath: "A/sub",
			entity: { ...entity("A/sub"), isDirectory: true } });
		const action: SyncAction = {
			path: "B", oldPath: "A", action: "rename_local", isFolder: true,
			descendants: [{ oldPath: "A/sub/x.md", newPath: "B/sub/x.md" }],
		};
		const result = admit([action], [
			remoteRename({ oldPath: "A", newPath: "B", isFolder: true, identityKey: "root" }),
			remoteRename({
				oldPath: "A/sub", newPath: "B/sub", isFolder: true, identityKey: "folder:sub",
			}),
			{ kind: "alias", side: "local", requestedPath: "B/sub", resolvedPath: "A/sub" },
		], fixture.observations, projection({
			A: "included", B: "included", "A/sub": "included", "B/sub": "included",
			"A/sub/x.md": "included", "B/sub/x.md": "included",
		}), fixture.entries);

		expect(result.failures).toEqual([]);
		expect(result.executable.actions).toMatchObject([action]);
	});

	it.each([
		{
			name: "one identity across two edges",
			children: [remoteRename({
				oldPath: "A/x.md", newPath: "B/x.md", identityKey: "root",
			})],
		},
		{
			name: "two identities on one edge",
			children: [
				remoteRename({ oldPath: "A/x.md", newPath: "B/x.md", identityKey: "X" }),
				remoteRename({ oldPath: "A/x.md", newPath: "B/x.md", identityKey: "Y" }),
			],
		},
	])("keeps an unobserved folder report identity conflict non-clean: $name", ({ children }) => {
		const action: SyncAction = {
			path: "B", oldPath: "A", action: "rename_local", isFolder: true,
			descendants: [{ oldPath: "A/x.md", newPath: "B/x.md" }],
		};
		const result = admit([action], [
			remoteRename({ oldPath: "A", newPath: "B", isFolder: true, identityKey: "root" }),
			...children,
		], [], projection({
			A: "included", B: "included", "A/x.md": "included", "B/x.md": "included",
		}));

		expect(result.executable.actions).toEqual([]);
		expect(result.failures[0]!.reasons).toEqual(["unknown_observation"]);
	});

	it("constructs complete folder coverage independently of incomplete proposed mappings and their order", () => {
		const fixture = folderFacts(["x.md", "y.md"]);
		const partial: SyncAction = {
			path: "B", oldPath: "A", action: "rename_local", isFolder: true,
			descendants: [{ oldPath: "A/x.md", newPath: "B/x.md" }],
		};
		const complete: SyncAction = {
			path: "B", oldPath: "A", action: "rename_local", isFolder: true,
			descendants: [
				{ oldPath: "A/x.md", newPath: "B/x.md" },
				{ oldPath: "A/y.md", newPath: "B/y.md" },
			],
		};
		const evidence = fixture.evidence;
		const scope = projection({
			A: "included", B: "included", "A/x.md": "included", "B/x.md": "included",
			"A/y.md": "included", "B/y.md": "included",
		});

		for (const actions of [[partial, complete], [complete, partial]]) {
			const result = admit(actions, evidence, fixture.observations, scope, fixture.entries);
			expect(result.failures).toEqual([]);
			expect(result.executable.actions).toMatchObject([complete]);
		}
	});

	it.each([64, 512])("keeps selected-root proof collection reads affine at size %i", (size) => {
		const counter = { reads: 0 };
		const fixture = folderFacts(Array.from({ length: size }, (_, index) => `${index}.md`));
		const descendants = Array.from({ length: size }, (_, index) => ({
			oldPath: `A/${index}.md`, newPath: `B/${index}.md`,
		}));
		const evidence: IdentityEvidence[] = [
			...fixture.evidence,
			...Array.from({ length: size }, (_, index): IdentityEvidence => ({
				kind: "alias", side: "local",
				requestedPath: `B/${index}.md`, resolvedPath: `A/${index}.md`,
			})),
		];
		fixture.observations = fixture.observations.filter((item) => !(item.side === "local" && item.kind === "absent" && item.requestedPath.startsWith("B/")));
		fixture.observations.push(...descendants.map(({ oldPath, newPath }): PathObservation => ({
			kind: "alias", side: "local", requestedPath: newPath, resolvedPath: oldPath, entity: entity(oldPath),
		})));
		const scopeEntries: Record<string, ScopeDisposition> = { A: "included", B: "included" };
		for (let index = 0; index < size; index++) {
			scopeEntries[`A/${index}.md`] = "included";
			scopeEntries[`B/${index}.md`] = "included";
		}
		const scopeCounter = { reads: 0 };
		const component: IdentityComponent = {
			paths: new Set(Object.keys(scopeEntries)),
			entries: countedArray(fixture.entries, counter),
			evidence: countedArray(evidence, counter),
			observations: countedArray(fixture.observations, counter),
		};

		const scope: ScopeProjection = {
			isConfiguredScopeCompatible: () => true, byEndpoint: countedMap(Object.entries(scopeEntries), scopeCounter),
		};
		const decision = decideIdentityComponent(component, scope, new Set());
		const collectionSize = fixture.entries.length + fixture.observations.length + evidence.length + Object.keys(scopeEntries).length;
		const bound = 32 * collectionSize + 128;

		expect(decision.reasons).toEqual([]);
		expect(counter.reads + scopeCounter.reads).toBeLessThanOrEqual(bound);
		if (size === 512) {
			const oracleCounter = { reads: 0 };
			const oraclePairs = countedArray(descendants, oracleCounter);
			for (const alias of evidence.slice(1)) {
				if (alias.kind !== "alias") continue;
				for (const pair of oraclePairs) {
					void (pair.oldPath === alias.resolvedPath && pair.newPath === alias.requestedPath);
				}
			}
			expect(oracleCounter.reads).toBeGreaterThan(bound);
		}
	});

	it("admits a local folder rename from its managed descendants", () => {
		const localFolder = { ...entity("TemplateS"), isDirectory: true };
		const remoteFolder = { ...entity("Templates", "folder-R"), isDirectory: true };
		const previous = (path: string, remoteIdentityKey: string): SyncRecord => ({
			path, hash: "h", localMtime: 1, remoteMtime: 1,
			localSize: 1, remoteSize: 1, remoteIdentityKey, syncedAt: 1,
		});
		const actions: FixtureAction[] = [
			{
				path: "Templates/a.md", action: "delete_remote",
				remote: entity("Templates/a.md", "remote-a"), baseline: previous("Templates/a.md", "remote-a"),
			},
			{ path: "TemplateS/a.md", action: "push", local: entity("TemplateS/a.md") },
		];
		const folderEvidence = remoteRename({
			side: "local", identityKey: undefined, oldPath: "Templates",
			newPath: "TemplateS", isFolder: true,
		});
		const evidence: IdentityEvidence[] = [
			{
				kind: "alias", side: "local",
				requestedPath: "Templates", resolvedPath: "TemplateS",
			},
			folderEvidence,
			remoteRename({
				side: "local", identityKey: undefined, oldPath: "Templates/a.md",
				newPath: "TemplateS/a.md",
			}),
		];

		const result = admit(actions, evidence, [
			{ kind: "alias", side: "local", requestedPath: "Templates", resolvedPath: "TemplateS", entity: localFolder },
			{ kind: "exact", side: "local", requestedPath: "TemplateS", entity: localFolder },
			{ kind: "exact", side: "remote", requestedPath: "Templates", entity: remoteFolder },
			{ kind: "absent", side: "remote", requestedPath: "TemplateS", authority: "stat" },
		], projection({
			Templates: "included", TemplateS: "included",
			"Templates/a.md": "included", "TemplateS/a.md": "included",
		}));

		expect(result.failures).toEqual([]);
		expect(result.executable.actions).toMatchObject([{
			action: "rename_remote", oldPath: "Templates", path: "TemplateS", isFolder: true,
		}]);
	});

	it("admits a remote folder rename from its managed descendants", () => {
		const actions: FixtureAction[] = [
			{ path: "Templates/a.md", action: "delete_local", local: entity("Templates/a.md") },
			{ path: "TemplateS/a.md", action: "pull", remote: entity("TemplateS/a.md", "child-X") },
		];
		const evidence: IdentityEvidence[] = [
			remoteRename({ oldPath: "Templates", newPath: "TemplateS", isFolder: true }),
			remoteRename({
				oldPath: "Templates/a.md", newPath: "TemplateS/a.md", identityKey: "child-X",
			}),
		];

		const result = admit(actions, evidence, [
			{ kind: "exact", side: "local", requestedPath: "Templates", entity: { ...entity("Templates"), isDirectory: true } },
			{ kind: "exact", side: "remote", requestedPath: "TemplateS", entity: { ...entity("TemplateS", "X"), isDirectory: true } },
			{ kind: "absent", side: "local", requestedPath: "TemplateS", authority: "stat" },
		], projection({
			Templates: "included", TemplateS: "included",
			"Templates/a.md": "included", "TemplateS/a.md": "included",
		}));

		expect(result.failures).toEqual([]);
		expect(result.executable.actions).toMatchObject([{
			action: "match", path: "TemplateS/a.md", localPath: "Templates/a.md", remotePath: "TemplateS/a.md",
		}, {
			action: "rename_local", oldPath: "Templates", path: "TemplateS", isFolder: true,
		}]);
	});

	it("deduplicates replayed folder and child evidence before deciding actions", () => {
		const previous: SyncRecord = {
			path: "Templates/a.md", hash: "h", localMtime: 1, remoteMtime: 1,
			localSize: 1, remoteSize: 1, remoteIdentityKey: "remote-a", syncedAt: 1,
		};
		const actions: FixtureAction[] = [
			{
				path: "Templates/a.md", action: "delete_remote",
				remote: entity("Templates/a.md", "remote-a"), baseline: previous,
			},
			{ path: "TemplateS/a.md", action: "push", local: entity("TemplateS/a.md") },
		];
		const folder = remoteRename({
			side: "local", identityKey: undefined, oldPath: "Templates",
			newPath: "TemplateS", isFolder: true,
		});
		const child = remoteRename({
			side: "local", identityKey: undefined, oldPath: "Templates/a.md",
			newPath: "TemplateS/a.md",
		});

		const result = admit(actions, [folder, child, { ...folder }, { ...child }], [
			{ kind: "exact", side: "local", requestedPath: "TemplateS", entity: { ...entity("TemplateS"), isDirectory: true } },
			{ kind: "exact", side: "remote", requestedPath: "Templates", entity: { ...entity("Templates", "folder-R"), isDirectory: true } },
			{ kind: "absent", side: "remote", requestedPath: "TemplateS", authority: "stat" },
		], projection({
			Templates: "included", TemplateS: "included",
			"Templates/a.md": "included", "TemplateS/a.md": "included",
		}));

		expect(result.failures).toEqual([]);
		expect(result.executable.actions).toHaveLength(1);
		expect(result.executable.actions[0]).toMatchObject({
			action: "rename_remote", oldPath: "Templates", path: "TemplateS", isFolder: true,
		});
	});

	it("authorizes one parent rename from current cold case aliases without manufacturing child renames", () => {
		const previous: SyncRecord = {
			path: "Templates/a.md", hash: "h", localMtime: 1, remoteMtime: 1,
			localSize: 1, remoteSize: 1, remoteIdentityKey: "remote-a", syncedAt: 1,
		};
		const local = entity("TemplateS/a.md");
		const localFolder = { ...entity("TemplateS"), isDirectory: true };
		const remoteFolder = { ...entity("Templates", "folder-R"), isDirectory: true };
		const remote = entity("Templates/a.md", "remote-a");
		const folder = remoteRename({
			side: "local", identityKey: undefined, oldPath: "Templates",
			newPath: "TemplateS", isFolder: true,
		});
		const child = remoteRename({
			side: "local", identityKey: undefined, oldPath: "Templates/a.md",
			newPath: "TemplateS/a.md",
		});
		const result = admitBatchObservation(captureBatchObservation(
			[{ path: "Templates/a.md", local, remote, prevSync: previous }],
			[
				{ kind: "alias", side: "local", requestedPath: "Templates", resolvedPath: "TemplateS" },
				{ kind: "alias", side: "local", requestedPath: "Templates/a.md", resolvedPath: "TemplateS/a.md" },
				folder, child, { ...folder }, { ...child },
			],
			[
				{ kind: "alias", side: "local", requestedPath: "Templates", resolvedPath: "TemplateS", entity: localFolder },
				{ kind: "exact", side: "local", requestedPath: "TemplateS", entity: localFolder },
				{ kind: "exact", side: "remote", requestedPath: "Templates", entity: remoteFolder },
				{ kind: "absent", side: "remote", requestedPath: "TemplateS", authority: "stat" },
				{ kind: "exact", side: "local", requestedPath: "TemplateS/a.md", entity: local },
				{
					kind: "alias", side: "local", requestedPath: "Templates/a.md",
					resolvedPath: "TemplateS/a.md", entity: local,
				},
				{ kind: "exact", side: "remote", requestedPath: "Templates/a.md", entity: remote },
				{ kind: "absent", side: "remote", requestedPath: "TemplateS/a.md", authority: "stat" },
			],
			projection({
				Templates: "included", TemplateS: "included",
				"Templates/a.md": "included", "TemplateS/a.md": "included",
			}),
			"backend\0root",
			["Templates/a.md"],
		));

		expect(result.failures).toEqual([]);
		expect(result.executable.actions).toHaveLength(1);
		expect(result.executable.actions[0]).toMatchObject({
			action: "rename_remote", oldPath: "Templates", path: "TemplateS", isFolder: true,
		});
	});

	it("admits a COLD parent case alias after a child record committed at the target", () => {
		const oldFolder: FileEntity = {
			...entity("Templates", "folder-R"), isDirectory: true, size: 0,
		};
		const newFolder: FileEntity = {
			...entity("TemplateS"), isDirectory: true, size: 0,
		};
		const localA = freshEntity("TemplateS/a.md", "local-A");
		const localB = freshEntity("TemplateS/b.md", "B");
		const remoteA = freshEntity("Templates/a.md", "A", "remote-A");
		const remoteB = freshEntity("Templates/b.md", "B", "remote-B");
		const previousA: SyncRecord = {
			path: "Templates/a.md", hash: "A", localMtime: 1, remoteMtime: 1,
			localSize: 1, remoteSize: 1, remoteIdentityKey: "remote-A", syncedAt: 1,
		};
		const previousB: SyncRecord = {
			path: "TemplateS/b.md", hash: "B", localMtime: 1, remoteMtime: 1,
			localSize: 1, remoteSize: 1, remoteIdentityKey: "remote-B", syncedAt: 1,
		};
		const entries: MixedEntity[] = [
			{ path: "Templates/a.md", remote: remoteA, prevSync: previousA },
			{ path: "TemplateS/a.md", local: localA },
			{ path: "Templates/b.md", remote: remoteB },
			{ path: "TemplateS/b.md", local: localB, prevSync: previousB },
		];
		const observations: PathObservation[] = [
			{ kind: "alias", side: "local", requestedPath: "Templates", resolvedPath: "TemplateS", entity: newFolder },
			{ kind: "exact", side: "local", requestedPath: "TemplateS", entity: newFolder },
			{ kind: "exact", side: "remote", requestedPath: "Templates", entity: oldFolder },
			{ kind: "absent", side: "remote", requestedPath: "TemplateS", authority: "stat" },
			...[
				["Templates/a.md", "TemplateS/a.md", localA, remoteA],
				["Templates/b.md", "TemplateS/b.md", localB, remoteB],
			].flatMap(([oldPath, newPath, local, remote]) => [
				{ kind: "alias" as const, side: "local" as const, requestedPath: oldPath as string,
					resolvedPath: newPath as string, entity: local as FileEntity },
				{ kind: "exact" as const, side: "local" as const, requestedPath: newPath as string,
					entity: local as FileEntity },
				{ kind: "exact" as const, side: "remote" as const, requestedPath: oldPath as string,
					entity: remote as FileEntity },
				{ kind: "absent" as const, side: "remote" as const, requestedPath: newPath as string,
					authority: "stat" as const },
			]),
		];
		const evidence: IdentityEvidence[] = [
			{ kind: "alias", side: "local", requestedPath: "Templates", resolvedPath: "TemplateS" },
			{ kind: "alias", side: "local", requestedPath: "Templates/a.md", resolvedPath: "TemplateS/a.md" },
			{ kind: "alias", side: "local", requestedPath: "Templates/b.md", resolvedPath: "TemplateS/b.md" },
			{
				kind: "stable_identity", side: "remote", identityKey: "remote-B", occurrences: [
					{ side: "remote", phase: "baseline", path: "TemplateS/b.md", identityKey: "remote-B" },
					{ side: "remote", phase: "current", path: "Templates/b.md", identityKey: "remote-B" },
				],
			},
		];
		const scope = projection({
			Templates: "included", TemplateS: "included",
			"Templates/a.md": "included", "TemplateS/a.md": "included",
			"Templates/b.md": "included", "TemplateS/b.md": "included",
		});

		const result = admitBatchObservation(captureBatchObservation(
			entries, evidence, observations, scope, "backend\0root",
		));

		expect("plan" in result.snapshot).toBe(false);
		expect(result.failures).toEqual([]);
		expect(result.executable.actions).toEqual([
			expect.objectContaining({
				action: "push", path: "Templates/a.md", local: localA,
			}),
			expect.objectContaining({
				action: "rename_remote", oldPath: "Templates", path: "TemplateS", isFolder: true,
			}),
		]);

		const intendedOnlyEvidence = evidence.map((item): IdentityEvidence =>
			item.kind === "stable_identity" ? {
				...item,
				occurrences: item.occurrences.map((occurrence) =>
					occurrence.phase === "baseline"
						? { ...occurrence, path: "Elsewhere/b.md" }
						: occurrence),
			} : item);
		const intendedOnly = admitBatchObservation(captureBatchObservation(
			entries, intendedOnlyEvidence, observations, projection({
				...Object.fromEntries(scope.byEndpoint), "Elsewhere/b.md": "included",
			}), "backend\0root",
		));

		// Historical evidence is not another record authority. The committed
		// records and current endpoints above, rather than this old claim, govern.
		expect(intendedOnly.failures).toEqual([]);
		expect(intendedOnly.executable.actions).toEqual(result.executable.actions);
	});

	it("honors a reported remote parent rename after the prior local parent transition committed", () => {
		const localFolder: FileEntity = {
			...entity("TemplateS"), isDirectory: true, size: 0,
		};
		const remoteFolder: FileEntity = {
			...entity("Templates", "folder-R"), isDirectory: true, size: 0,
		};
		const localA = freshEntity("TemplateS/a.md", "A");
		const localB = freshEntity("TemplateS/b.md", "B");
		const remoteA = freshEntity("Templates/a.md", "A", "remote-A");
		const remoteB = freshEntity("Templates/b.md", "B", "remote-B");
		const previousA: SyncRecord = {
			path: "TemplateS/a.md", hash: "A", localMtime: 1, remoteMtime: 1,
			localSize: 1, remoteSize: 1, remoteIdentityKey: "remote-A", syncedAt: 1,
		};
		const previousB: SyncRecord = {
			path: "TemplateS/b.md", hash: "B", localMtime: 1, remoteMtime: 1,
			localSize: 1, remoteSize: 1, remoteIdentityKey: "remote-B", syncedAt: 1,
		};
		const entries: MixedEntity[] = [
			{ path: "TemplateS/a.md", local: localA, prevSync: previousA },
			{ path: "Templates/a.md", remote: remoteA },
			{ path: "TemplateS/b.md", local: localB, prevSync: previousB },
			{ path: "Templates/b.md", remote: remoteB },
		];
		const observations: PathObservation[] = [
			{
				kind: "alias", side: "local", requestedPath: "Templates",
				resolvedPath: "TemplateS", entity: localFolder,
			},
			{ kind: "exact", side: "local", requestedPath: "TemplateS", entity: localFolder },
			{ kind: "exact", side: "remote", requestedPath: "Templates", entity: remoteFolder },
			{ kind: "absent", side: "remote", requestedPath: "TemplateS", authority: "stat" },
			...["a.md", "b.md"].flatMap((name) => {
				const local = name === "a.md" ? localA : localB;
				const remote = name === "a.md" ? remoteA : remoteB;
				return [
					{
						kind: "alias" as const, side: "local" as const,
						requestedPath: `Templates/${name}`, resolvedPath: `TemplateS/${name}`,
						entity: local,
					},
					{
						kind: "exact" as const, side: "local" as const,
						requestedPath: `TemplateS/${name}`, entity: local,
					},
					{
						kind: "exact" as const, side: "remote" as const,
						requestedPath: `Templates/${name}`, entity: remote,
					},
					{
						kind: "absent" as const, side: "remote" as const,
						requestedPath: `TemplateS/${name}`, authority: "stat" as const,
					},
				];
			}),
		];
		const evidence: IdentityEvidence[] = [
			{ kind: "alias", side: "local", requestedPath: "Templates", resolvedPath: "TemplateS" },
			{ kind: "alias", side: "local", requestedPath: "Templates/a.md", resolvedPath: "TemplateS/a.md" },
			{ kind: "alias", side: "local", requestedPath: "Templates/b.md", resolvedPath: "TemplateS/b.md" },
			{
				kind: "rename", side: "remote", oldPath: "TemplateS", newPath: "Templates",
				isFolder: true, authority: "reported", identityKey: "folder-R",
			},
			...[
				["remote-A", "a.md"],
				["remote-B", "b.md"],
			].map(([identityKey, name]): IdentityEvidence => ({
				kind: "stable_identity", side: "remote", identityKey: identityKey!, occurrences: [
					{
						side: "remote", phase: "baseline", path: `TemplateS/${name}`,
						identityKey,
					},
					{
						side: "remote", phase: "current", path: `Templates/${name}`,
						identityKey,
					},
				],
			})),
		];
		const scope = projection({
			Templates: "included", TemplateS: "included",
			"Templates/a.md": "included", "TemplateS/a.md": "included",
			"Templates/b.md": "included", "TemplateS/b.md": "included",
		});

		const result = admitBatchObservation(captureBatchObservation(
			entries, evidence, observations, scope, "backend\0root",
		));
		const withoutParentAliasNormalization = admitBatchObservation(captureBatchObservation(
			entries,
			evidence,
			observations.filter((item) => !(item.kind === "alias" && item.side === "local" &&
				item.requestedPath === "Templates" && item.entity.isDirectory)),
			scope,
			"backend\0root",
		));

		expect("plan" in result.snapshot).toBe(false);
		const summarize = (admission: typeof result) => ({
			reasons: admission.failures.flatMap((failure) => failure.reasons),
			dispositions: admission.dispositions.map((disposition) => disposition.kind),
			executable: admission.executable.actions.map((action) => ({
				action: action.action,
				...((action.action === "rename_local" || action.action === "rename_remote")
					? { oldPath: action.oldPath, path: action.path }
					: {}),
			})),
			candidates: admission.dispositions.flatMap((disposition) => disposition.actions)
				.map((action) => ({
					action: action.action,
					...((action.action === "rename_local" || action.action === "rename_remote")
						? { oldPath: action.oldPath, path: action.path }
						: {}),
				})),
		});
		expect({
			productionFacts: summarize(result),
			withoutParentAliasNormalization: summarize(withoutParentAliasNormalization),
		}).toEqual({
			productionFacts: {
				reasons: [],
				dispositions: ["authorized"],
				executable: [{ action: "rename_local", oldPath: "TemplateS", path: "Templates" }],
				candidates: [{ action: "rename_local", oldPath: "TemplateS", path: "Templates" }],
			},
			withoutParentAliasNormalization: {
				reasons: ["unknown_observation"],
				dispositions: ["failed"],
				executable: [],
				candidates: [],
			},
		});
	});

	it("does not infer unobserved parent endpoints from an actionless child alias", () => {
		const previous: SyncRecord = {
			path: "A/a.md", hash: "h", localMtime: 1, remoteMtime: 1,
			localSize: 1, remoteSize: 1, remoteIdentityKey: "remote-a", syncedAt: 1,
		};
		const local = entity("A/a.md");
		const changedRemote = { ...entity("A/a.md", "remote-a"), mtime: 2 };
		const folder = remoteRename({
			side: "local", identityKey: undefined, oldPath: "A", newPath: "a", isFolder: true,
		});
		const child = remoteRename({
			side: "local", identityKey: undefined, oldPath: "A/a.md", newPath: "a/a.md",
		});
		const result = admitBatchObservation(captureBatchObservation(
			[{ path: "A/a.md", local, remote: changedRemote, prevSync: previous }],
			[folder, child],
			[
				{
					kind: "alias", side: "local", requestedPath: "a/a.md",
					resolvedPath: "A/a.md", entity: local,
				},
				{ kind: "exact", side: "remote", requestedPath: "A/a.md", entity: changedRemote },
				{ kind: "absent", side: "remote", requestedPath: "a/a.md", authority: "stat" },
			],
			projection({
				A: "included", a: "included", "A/a.md": "included", "a/a.md": "included",
			}),
			"backend\0root",
		));

		expect(result.executable.actions).toEqual([]);
		expect(result.failures[0]!.reasons).toEqual(["incomplete_folder_mapping"]);
	});

	it("marks only the exact singleton tracked pull as priority-substitutable", () => {
		const baseline = {
			path: "note.md", hash: "old", localMtime: 1, remoteMtime: 1,
			localSize: 1, remoteSize: 1, remoteIdentityKey: "remote-id", syncedAt: 1,
		};
		const local = freshEntity("note.md", "old");
		const remote = entity("note.md", "remote-id");
		const action: SyncAction = { path: "note.md", action: "pull", local, remote, baseline };
		const result = admit([action], [], [
			{ kind: "exact", side: "local", requestedPath: "note.md", entity: local },
			{ kind: "exact", side: "remote", requestedPath: "note.md", entity: remote },
		], projection({ "note.md": "included" }));

		const disposition = result.dispositions.find((item) => item.kind === "authorized");
		expect(disposition?.kind === "authorized" && disposition.priorityPullAction)
			.toBe(result.executable.actions[0]);
		expect(result.executable.actions[0]).toMatchObject({ ...action,
			publication: { source: baseline, destination: baseline } });
	});

	it("does not mark a pull connected to cross-path evidence", () => {
		const baseline = {
			path: "B.md", hash: "old", localMtime: 1, remoteMtime: 1,
			localSize: 1, remoteSize: 1, remoteIdentityKey: "X", syncedAt: 1,
		};
		const action: SyncAction = {
			path: "B.md", action: "pull", local: entity("B.md"), remote: entity("B.md", "X"), baseline,
		};
		const result = admit([action], [remoteRename()], [
			{ kind: "exact", side: "local", requestedPath: "B.md", entity: entity("B.md") },
			{ kind: "exact", side: "remote", requestedPath: "B.md", entity: entity("B.md", "X") },
		], projection({ "A.md": "included", "B.md": "included" }));

		expect(result.dispositions.some((item) =>
			item.kind === "authorized" && item.priorityPullAction !== undefined)).toBe(false);
	});

	it.each([
		["old_path_baseline", freshEntity("A.md", "H0", "R"), null, "rename_remote"],
		["post_rename_old_content", null, freshEntity("B.md", "H0", "R"), "push"],
		["converged", null, freshEntity("B.md", "H1", "R"), "match"],
		["remote_changed", freshEntity("A.md", "H2", "R"), null, "conflict"],
		["remote_changed", freshEntity("A.md", "H0", "R"), freshEntity("B.md", "other", "Y"), "conflict"],
		["unknown", "unknown", null, undefined],
	] as const)("selects one fixed action from current rename endpoints: %s", (
		expectedState, remoteOld, remoteNew, expectedAction,
	) => {
		const baseline = {
			path: "A.md", hash: "H0", localMtime: 1, remoteMtime: 1,
			localSize: 1, remoteSize: 1, remoteIdentityKey: "R", syncedAt: 1,
		};
		const local = freshEntity("B.md", "H1");
		const oldAction: FixtureAction = remoteOld && remoteOld !== "unknown"
			? { path: "A.md", action: remoteOld.hash === "H0" ? "delete_remote" : "conflict", remote: remoteOld, baseline }
			: { path: "A.md", action: "cleanup", baseline };
		const newAction: FixtureAction = remoteNew
			? { path: "B.md", action: remoteNew.hash === local.hash ? "match" : "conflict", local, remote: remoteNew }
			: { path: "B.md", action: "push", local };
		const observedRemoteNew = expectedState === "converged" && remoteNew
			? { ...remoteNew, hash: "" } : remoteNew;
		const evidence = remoteRename({ side: "local", identityKey: undefined });
		const observations: PathObservation[] = [
			{ kind: "absent", side: "local", requestedPath: "A.md", authority: "stat" },
			{ kind: "exact", side: "local", requestedPath: "B.md", entity: local },
			remoteOld === "unknown"
				? { kind: "unknown", side: "remote", requestedPath: "A.md", reason: "not_observed" }
				: remoteOld
					? { kind: "exact", side: "remote", requestedPath: "A.md", entity: remoteOld }
					: { kind: "absent", side: "remote", requestedPath: "A.md", authority: "stat" },
			observedRemoteNew
				? { kind: "exact", side: "remote", requestedPath: "B.md", entity: observedRemoteNew }
				: { kind: "absent", side: "remote", requestedPath: "B.md", authority: "stat" },
		];

		const result = admit([oldAction, newAction], [evidence], observations, projection({
			"A.md": "included", "B.md": "included",
		}));

		expect(result.executable.actions).toHaveLength(expectedAction ? 1 : 0);
		if (expectedAction) {
			expect(result.failures).toEqual([]);
			expect(result.executable.actions[0]).toMatchObject({ action: expectedAction, path: "B.md",
				publication: { source: baseline, destination: undefined } });
			expect(result.executable.actions[0]).not.toHaveProperty("freshRenameState");
			expect(result.executable.actions[0]).not.toHaveProperty("normalizedRenameState");
			if (expectedAction === "rename_remote") expect(result.executable.actions[0]).toMatchObject({
				content: { mode: "copy", read: { side: "local", entity: local }, write: { side: "remote", path: "B.md" } },
			});
		} else expect(result.failures[0]?.reasons).toContain("unknown_observation");
		if (remoteNew?.identityKey === "Y" && remoteOld && remoteOld !== "unknown") {
			expect(result.executable.actions[0]).toHaveProperty("remoteIdentitySource.path", "A.md");
			expect(result.executable.actions[0]).toHaveProperty("remoteIdentitySource.identityKey", "R");
			expect(result.executable.actions[0]).toHaveProperty("additionalRemote.identityKey", "Y");
		}
	});

	it("uses replayed debt only as endpoints while fresh remote change selects conflict", () => {
		const baseline = {
			path: "A.md", hash: "H0", localMtime: 1, remoteMtime: 1,
			localSize: 1, remoteSize: 1, remoteIdentityKey: "R", syncedAt: 1,
		};
		const local = freshEntity("B.md", "H1");
		const changedRemote = freshEntity("A.md", "H2", "R");
		const evidence = remoteRename({ side: "local", identityKey: undefined });
		const snapshot = captureFixtureFacts({ actions: [
			{ path: "A.md", action: "conflict", remote: changedRemote, baseline },
			{ path: "B.md", action: "push", local },
		] }, [evidence], [
			{ kind: "absent", side: "local", requestedPath: "A.md", authority: "stat" },
			{ kind: "exact", side: "local", requestedPath: "B.md", entity: local },
			{ kind: "exact", side: "remote", requestedPath: "A.md", entity: changedRemote },
			{ kind: "absent", side: "remote", requestedPath: "B.md", authority: "stat" },
		], projection({ "A.md": "included", "B.md": "included" }), "backend\0root",
		["A.md"]);

		const result = admitBatchObservation(snapshot);

		expect(result.executable.actions).toHaveLength(1);
		expect(result.executable.actions[0]).toMatchObject({
			action: "conflict", path: "B.md",
		});
	});

	it.each(["old", "new"] as const)(
		"treats a same-metadata remote checksum change at the %s path as conflict",
		(remoteLocation) => {
			const baseline = {
				path: "A.md", hash: "H0", localMtime: 1, remoteMtime: 1,
				localSize: 1, remoteSize: 1, remoteIdentityKey: "R", syncedAt: 1,
				remoteChecksum: { algo: "md5" as const, value: "Q0" },
			};
			const local = freshEntity("B.md", "H1");
			const changedRemote = {
				...freshEntity(remoteLocation === "old" ? "A.md" : "B.md", "", "R"),
				remoteChecksum: { algo: "md5" as const, value: "Q1" },
			};
			const remoteOld = remoteLocation === "old" ? changedRemote : undefined;
			const remoteNew = remoteLocation === "new" ? changedRemote : undefined;
			const result = admit([
				{ path: "A.md", action: remoteOld ? "conflict" : "cleanup", remote: remoteOld, baseline },
				{ path: "B.md", action: remoteNew ? "conflict" : "push", local, remote: remoteNew },
			], [remoteRename({ side: "local", identityKey: undefined })], [
				{ kind: "absent", side: "local", requestedPath: "A.md", authority: "stat" },
				{ kind: "exact", side: "local", requestedPath: "B.md", entity: local },
				remoteOld
					? { kind: "exact", side: "remote", requestedPath: "A.md", entity: remoteOld }
					: { kind: "absent", side: "remote", requestedPath: "A.md", authority: "stat" },
				remoteNew
					? { kind: "exact", side: "remote", requestedPath: "B.md", entity: remoteNew }
					: { kind: "absent", side: "remote", requestedPath: "B.md", authority: "stat" },
			], projection({ "A.md": "included", "B.md": "included" }));

			expect(result.executable.actions).toHaveLength(1);
			expect(result.executable.actions[0]).toMatchObject({
				action: "conflict",
			});
		},
	);

	it("publishes equal current destination content without inventing a foreign-identity conflict", () => {
		const baseline = {
			path: "A.md", hash: "H0", localMtime: 1, remoteMtime: 1,
			localSize: 1, remoteSize: 1, remoteIdentityKey: "R", syncedAt: 1,
		};
		const local = freshEntity("B.md", "H1");
		const resolvedRemote = freshEntity("B.md", "H1", "Y");
		const result = admit([
			{ path: "A.md", action: "cleanup", baseline },
			{ path: "B.md", action: "match", local, remote: resolvedRemote },
		], [remoteRename({ side: "local", identityKey: undefined })], [
			{ kind: "absent", side: "local", requestedPath: "A.md", authority: "stat" },
			{ kind: "exact", side: "local", requestedPath: "B.md", entity: local },
			{ kind: "absent", side: "remote", requestedPath: "A.md", authority: "stat" },
			{ kind: "exact", side: "remote", requestedPath: "B.md", entity: resolvedRemote },
		], projection({ "A.md": "included", "B.md": "included" }));

		expect(result.executable.actions).toHaveLength(1);
		expect(result.executable.actions[0]).toMatchObject({
			action: "match", path: "B.md", local, remote: resolvedRemote,
			publication: { source: baseline, destination: undefined },
		});
		expect(result.executable.actions[0]).not.toHaveProperty("remoteIdentitySource");
		expect(result.dispositions[0]).toMatchObject({
			kind: "authorized",
		});
		expect(result.dispositions[0]).not.toHaveProperty("normalizedRenameState");
	});

	it("routes the tracked remote identity moved to a third path through conflict", () => {
		const baseline = {
			path: "A.md", hash: "H0", localMtime: 1, remoteMtime: 1,
			localSize: 1, remoteSize: 1, remoteIdentityKey: "R", syncedAt: 1,
		};
		const local = freshEntity("B.md", "H1");
		const movedRemote = freshEntity("C.md", "H2", "R");
		const evidence = [
			remoteRename({ side: "local", identityKey: undefined }),
			remoteRename({ oldPath: "A.md", newPath: "C.md", identityKey: "R" }),
		];
		const result = admit([
			{ path: "A.md", action: "cleanup", baseline },
			{ path: "B.md", action: "push", local },
			{ path: "C.md", action: "pull", remote: movedRemote },
		], evidence, [
			{ kind: "absent", side: "local", requestedPath: "A.md", authority: "stat" },
			{ kind: "exact", side: "local", requestedPath: "B.md", entity: local },
			{ kind: "absent", side: "remote", requestedPath: "A.md", authority: "stat" },
			{ kind: "absent", side: "remote", requestedPath: "B.md", authority: "stat" },
			{ kind: "exact", side: "remote", requestedPath: "C.md", entity: movedRemote },
		], projection({ "A.md": "included", "B.md": "included", "C.md": "included" }));

		expect(result.executable.actions).toHaveLength(1);
		expect(result.executable.actions[0]).toMatchObject({
			action: "conflict", path: "B.md",
			remote: movedRemote, remoteIdentitySource: movedRemote,
			publication: { source: baseline, destination: undefined },
		});
	});

	it("rejects a mixed report family whose remote postcondition is unobserved", () => {
		const baseline: SyncRecord = {
			path: "A.md", hash: "H0", localMtime: 1, remoteMtime: 1,
			localSize: 1, remoteSize: 1, remoteIdentityKey: "R", syncedAt: 1,
		};
		const local = freshEntity("B.md", "H1");
		const result = admit([
			{ path: "A.md", action: "cleanup", baseline },
			{ path: "B.md", action: "push", local },
		], [
			remoteRename({ side: "local", identityKey: undefined }),
			remoteRename({ oldPath: "A.md", newPath: "C.md", identityKey: "R" }),
		], [
			{ kind: "absent", side: "local", requestedPath: "A.md", authority: "stat" },
			{ kind: "exact", side: "local", requestedPath: "B.md", entity: local },
			{ kind: "absent", side: "remote", requestedPath: "A.md", authority: "stat" },
			{ kind: "absent", side: "remote", requestedPath: "B.md", authority: "stat" },
			{ kind: "absent", side: "remote", requestedPath: "C.md", authority: "stat" },
		], projection({ "A.md": "included", "B.md": "included", "C.md": "included" }));

		expect(result.executable.actions).toEqual([]);
		expect(result.failures[0]!.reasons).toEqual(["conflicting_identity"]);
	});

	it("authorizes one primary/additional conflict when a third-path R and destination Y coexist", () => {
		const baseline = {
			path: "A.md", hash: "H0", localMtime: 1, remoteMtime: 1,
			localSize: 1, remoteSize: 1, remoteIdentityKey: "R", syncedAt: 1,
		};
		const local = freshEntity("B.md", "H1");
		const occupant = freshEntity("B.md", "HY", "Y");
		const movedRemote = freshEntity("C.md", "H2", "R");
		const result = admit([
			{ path: "A.md", action: "cleanup", baseline },
			{ path: "B.md", action: "conflict", local, remote: occupant },
			{ path: "C.md", action: "pull", remote: movedRemote },
		], [
			remoteRename({ side: "local", identityKey: undefined }),
			remoteRename({ oldPath: "A.md", newPath: "C.md", identityKey: "R" }),
		], [
			{ kind: "absent", side: "local", requestedPath: "A.md", authority: "stat" },
			{ kind: "exact", side: "local", requestedPath: "B.md", entity: local },
			{ kind: "absent", side: "remote", requestedPath: "A.md", authority: "stat" },
			{ kind: "exact", side: "remote", requestedPath: "B.md", entity: occupant },
			{ kind: "exact", side: "remote", requestedPath: "C.md", entity: movedRemote },
		], projection({ "A.md": "included", "B.md": "included", "C.md": "included" }));

		expect(result.executable.actions).toHaveLength(1);
		expect(result.executable.actions[0]).toMatchObject({
			action: "conflict", path: "B.md",
			remote: movedRemote, remoteIdentitySource: movedRemote,
			additionalRemote: occupant,
			publication: { source: baseline, destination: undefined },
		});
		expect(result.dispositions[0]).toMatchObject({
			kind: "authorized",
		});
		expect(result.failures).toEqual([]);
	});

	it("authorizes one primary/additional conflict when changed old R and destination Y coexist", () => {
		const baseline = {
			path: "A.md", hash: "H0", localMtime: 1, remoteMtime: 1,
			localSize: 1, remoteSize: 1, remoteIdentityKey: "R", syncedAt: 1,
		};
		const local = freshEntity("B.md", "H1");
		const changedOld = freshEntity("A.md", "H2", "R");
		const occupant = freshEntity("B.md", "HY", "Y");
		const result = admit([
			{ path: "A.md", action: "conflict", remote: changedOld, baseline },
			{ path: "B.md", action: "conflict", local, remote: occupant },
		], [remoteRename({ side: "local", identityKey: undefined })], [
			{ kind: "absent", side: "local", requestedPath: "A.md", authority: "stat" },
			{ kind: "exact", side: "local", requestedPath: "B.md", entity: local },
			{ kind: "exact", side: "remote", requestedPath: "A.md", entity: changedOld },
			{ kind: "exact", side: "remote", requestedPath: "B.md", entity: occupant },
		], projection({ "A.md": "included", "B.md": "included" }));

		expect(result.executable.actions).toHaveLength(1);
		expect(result.executable.actions[0]).toMatchObject({
			action: "conflict", path: "B.md",
			remote: changedOld, remoteIdentitySource: changedOld,
			additionalRemote: occupant,
			publication: { source: baseline, destination: undefined },
		});
		expect(result.dispositions[0]).toMatchObject({
			kind: "authorized",
		});
		expect(result.failures).toEqual([]);
	});

	it("uses ordinary edit-versus-deletion conflict when both remote addresses are authoritatively absent", () => {
		const baseline = {
			path: "A.md", hash: "H0", localMtime: 1, remoteMtime: 1,
			localSize: 1, remoteSize: 1, remoteIdentityKey: "id:A.md", syncedAt: 1,
		};
		const local = freshEntity("B.md", "H1");
		const candidate = remoteRename({ side: "local", identityKey: undefined });
		const result = admit([
			{ path: "A.md", action: "cleanup", baseline },
			{ path: "B.md", action: "push", local },
		], [candidate], [
			{ kind: "absent", side: "local", requestedPath: "A.md", authority: "stat" },
			{ kind: "exact", side: "local", requestedPath: "B.md", entity: local },
			{ kind: "absent", side: "remote", requestedPath: "A.md", authority: "stat" },
			{ kind: "absent", side: "remote", requestedPath: "B.md", authority: "stat" },
		], projection({ "A.md": "included", "B.md": "included" }));

		expect(result.failures).toEqual([]);
		expect(result.executable.actions).toEqual([{
			action: "conflict", path: "B.md", local, remote: undefined, baseline,
			remoteIdentitySource: undefined, additionalRemote: undefined, additionalLocal: undefined,
			protocol: { kind: "same_path" },
			conflictPolicy: { mode: "auto_merge", strategy: "auto_merge" },
			publication: { source: baseline, destination: undefined },
		}]);
	});

	it("rejects multiple current occurrences without exposing a normalized decision state", () => {
		const baseline = {
			path: "A.md", hash: "H0", localMtime: 1, remoteMtime: 1,
			localSize: 1, remoteSize: 1, remoteIdentityKey: "R", syncedAt: 1,
		};
		const local = freshEntity("B.md", "H1");
		const oldRemote = freshEntity("A.md", "H0", "R");
		const thirdRemote = freshEntity("C.md", "H2", "R");
		const candidate = remoteRename({ side: "local", identityKey: undefined });
		const result = admit([
			{ path: "A.md", action: "delete_remote", remote: oldRemote, baseline },
			{ path: "B.md", action: "push", local },
			{ path: "C.md", action: "pull", remote: thirdRemote },
		], [candidate, remoteRename({ oldPath: "A.md", newPath: "C.md", identityKey: "R" })], [
			{ kind: "absent", side: "local", requestedPath: "A.md", authority: "stat" },
			{ kind: "exact", side: "local", requestedPath: "B.md", entity: local },
			{ kind: "exact", side: "remote", requestedPath: "A.md", entity: oldRemote },
			{ kind: "absent", side: "remote", requestedPath: "B.md", authority: "stat" },
			{ kind: "exact", side: "remote", requestedPath: "C.md", entity: thirdRemote },
		], projection({ "A.md": "included", "B.md": "included", "C.md": "included" }));

		expect(result.executable.actions).toEqual([]);
		expect(result.failures).toMatchObject([{
			kind: "failed", reasons: ["tracked_identity_multiple_occurrences"],
		}]);
		expect(result.failures[0]).not.toHaveProperty("normalizedRenameState");
	});

	it("does not mutate the plan, observations, evidence, or projection", () => {
		const action: SyncAction = { path: "gone.md", action: "delete_local", local: entity("gone.md") };
		const evidence: IdentityEvidence[] = [];
		const observations: PathObservation[] = [];
		const scope = projection({ "gone.md": "included" });
		const plan = { actions: [action] };

		admitBatchObservation(captureFixtureFacts(
			plan, evidence, observations, scope, "backend\0root",
		));

		expect(plan).toEqual({ actions: [action] });
		expect(evidence).toEqual([]);
		expect(observations).toEqual([]);
		expect([...scope.byEndpoint]).toEqual([["gone.md", "included"]]);
	});

	it("captures authority-bearing cycle evidence as a runtime-immutable value", () => {
		const action: SyncAction = {
			path: "B.md", action: "push",
			local: { ...entity("B.md"), backendMeta: { revision: "local-1" } },
		};
		const candidate = remoteRename({ side: "local", identityKey: undefined });
		const observation: PathObservation = {
			kind: "exact", side: "local", requestedPath: "B.md",
			entity: { ...entity("B.md"), backendMeta: { revision: "observed-1" } },
		};
		const scope = projection({ "A.md": "included", "B.md": "included" });
		const snapshot = captureFixtureFacts(
			{ actions: [action] }, [candidate], [observation], scope, "backend\0root",
		);

		action.path = "mutated.md";
		(action.local!.backendMeta as { revision: string }).revision = "local-2";
		observation.requestedPath = "mutated.md";
		(observation.entity.backendMeta as { revision: string }).revision = "observed-2";
		(scope.byEndpoint as Map<string, "included">).set("C.md", "included");

		expect(snapshot.entries[0]).toMatchObject({ path: "B.md" });
		expect(snapshot.entries[0]?.local?.backendMeta).toEqual({ revision: "local-1" });
		expect(snapshot.observations[0]).toMatchObject({ requestedPath: "B.md" });
		expect(snapshot.observations[0]?.kind === "exact" &&
			snapshot.observations[0].entity.backendMeta).toEqual({ revision: "observed-1" });
		expect(snapshot.scope.byEndpoint.has("C.md")).toBe(false);
		expect(() => (snapshot.baselinePaths as Set<string>).add("foreign.md"))
			.toThrow(TypeError);
		expect(() => (snapshot.scope.byEndpoint as Map<string, "included">)
			.set("foreign.md", "included")).toThrow(TypeError);
	});

	it("partitions local rename candidates instead of exposing a second identity-evidence view", () => {
		const candidate = remoteRename({ side: "local", identityKey: undefined });
		const snapshot = captureFixtureFacts(
			{ actions: [] }, [candidate], [], projection({
				"A.md": "included", "B.md": "included",
			}), "backend\0root",
		);

		expect(snapshot.evidence).toEqual([
			{ role: "local_rename_candidate", evidence: candidate },
		]);
		expect(snapshot.evidence.filter((item) => item.role === "identity")).toEqual([]);
	});
});

/**
 * Measurement first, then the removal it authorized. The question was: can the
 * remote-rename identity guard at `identity-component-decision.ts:106-107` —
 * `current.remote.get(report.newPath)?.identityKey !== report.identityKey` — ever be
 * true, given that `report.identityKey` may have just been filled by
 * `completeIdentityEvidence` out of a map built from the same observations and entries
 * `indexFacts` builds `current.remote` from?
 *
 * The recorded answer was no: on every shape the Observation layer emitted, either the
 * `newPath` lookup hit and the filled key *was* the map it was compared against, or it
 * missed and line 106's own `report.identityKey` precondition short-circuited the
 * comparison. The only shapes that reached `conflicting_identity` were the probe's two
 * map-keying divergences, where the reason rested on a key no producer supplied.
 *
 * On that measurement the destination-address fill was removed. These fixtures now
 * record its absence: a rename claim whose producer carried no identity reaches
 * Admission carrying none, and the probe's two divergences — which the fill
 * manufactured — no longer reach the guard at all. Nothing else about them moved, which
 * is what "the removal is lossless" looks like when it is written down.
 *
 * Every shape is driven through the production entry only: `captureBatchObservation`
 * → `admitBatchObservation`. `completeIdentityEvidence` is called exactly where
 * `change-detector.ts:151` calls it — before capture — so the evidence Admission
 * sees is the evidence production hands it. The fill is then read back out of the
 * admission disposition (`AdmissionDisposition.evidence`), never off the helper.
 *
 * Instrument: `ScopeProjection.isConfiguredScopeCompatible` is a production input
 * that `immutableSnapshot` copies by reference, so recording its `(from, to)`
 * arguments in call order yields an ordered execution trace of
 * `decideIdentityComponent`: the entry-endpoint loop (98-102), the rename-report
 * loop (104-107), the alias-evidence loop (109-114), the alias-observation loop
 * (115-118), `bindFiles` (442) and `decideFolder` (648, 687). That trace is what
 * attributes an outcome to one observation site without calling any internal.
 */
describe("positional identity binding: end-to-end site measurement", () => {
	type ReportFamilyBranch = "none" | "reported" | "conflicting";
	type AliasFolderBranch =
		| "not_consulted_governing_folder_report"
		| "consulted_no_directory_alias_candidate"
		| "consulted_candidate_rejected"
		| "consulted_relation_selected";
	type EvidenceFillBranch =
		| "no_remote_rename_evidence"
		| "reported_identity_kept"
		| "reached_admission_with_no_identity"
		// No shape reaches this branch any more. It is kept named so that reinstating a
		// destination-address fill is observable as a branch change rather than silently
		// satisfying the "no identity" assertion of a fixture whose producer carried none.
		| "identity_attached_after_the_report";
	type IdentityGuardBranch =
		| "not_reached_family_not_reported"
		| "not_reached_evidence_carries_no_identity"
		| "passed_current_identity_equals_carried_key"
		| "failed_conflicting_identity";

	interface ObservedFacts {
		readonly entries: readonly MixedEntity[];
		readonly observations: readonly PathObservation[];
		/** Evidence as collection reports it, before `completeIdentityEvidence`. */
		readonly reported: readonly IdentityEvidence[];
		readonly scopePaths: readonly string[];
	}

	interface Measurement {
		readonly reportFamily: ReportFamilyBranch;
		readonly aliasFolder: AliasFolderBranch;
		readonly evidenceFill: EvidenceFillBranch;
		readonly identityGuard: IdentityGuardBranch;
		readonly trace: readonly string[];
		readonly kind: AdmissionDisposition["kind"];
		readonly reasons: readonly string[];
		readonly actions: readonly SyncActionType[];
		/** `identityKey` on every remote rename claim as Admission received it. */
		readonly admittedRemoteRenameKeys: readonly (string | undefined)[];
	}

	type RenameClaim = Extract<IdentityEvidence, { kind: "rename" }>;

	function renameClaims(evidence: readonly IdentityEvidence[]): RenameClaim[] {
		return evidence.filter((item): item is RenameClaim => item.kind === "rename");
	}

	function remoteRenameClaims(evidence: readonly IdentityEvidence[]): RenameClaim[] {
		return renameClaims(evidence).filter((item) => item.side === "remote");
	}

	function tracingScope(paths: readonly string[], trace: string[]): ScopeProjection {
		return {
			byEndpoint: new Map<string, ScopeDisposition>(paths.map((path) => [path, "included"])),
			isConfiguredScopeCompatible: (from, to) => {
				trace.push(`${from}=>${to}`);
				return true;
			},
		};
	}

	function classify(
		facts: ObservedFacts,
		disposition: AdmissionDisposition,
		trace: readonly string[],
	): Measurement {
		const admittedRenames = renameClaims(disposition.evidence);
		const admittedRemote = remoteRenameClaims(disposition.evidence);
		const reportedRemote = remoteRenameClaims(facts.reported);
		// One report per fixture keeps "the loop reached this pair" unambiguous.
		expect(admittedRenames.length).toBeLessThanOrEqual(1);

		const reportFamily: ReportFamilyBranch = admittedRenames.length === 0
			? "none"
			: admittedRenames.every((claim) => trace.includes(`${claim.oldPath}=>${claim.newPath}`))
				? "reported"
				: "conflicting";

		const evidenceFill: EvidenceFillBranch = reportedRemote.length === 0
			? "no_remote_rename_evidence"
			: reportedRemote.some((claim) => claim.identityKey)
				? "reported_identity_kept"
				: admittedRemote.some((claim) => claim.identityKey)
					? "identity_attached_after_the_report"
					: "reached_admission_with_no_identity";

		const keyed = admittedRemote.filter((claim) => claim.identityKey);
		// Only line 107 returns `conflicting_identity` from inside the report loop:
		// every later producer of that reason (bindFiles 451, decideFolder 693/696)
		// first records its own compatibility pair, and indexFacts fails before the
		// entry-endpoint loop records anything at all.
		const stoppedInReportLoop = trace.length > 0 && keyed.some((claim) =>
			trace[trace.length - 1] === `${claim.oldPath}=>${claim.newPath}`);
		const failedOnIdentity = disposition.kind === "failed" &&
			disposition.reasons.length === 1 &&
			disposition.reasons[0] === "conflicting_identity" && stoppedInReportLoop;
		const identityGuard: IdentityGuardBranch = reportFamily !== "reported"
			? "not_reached_family_not_reported"
			: keyed.length === 0
				? "not_reached_evidence_carries_no_identity"
				: failedOnIdentity
					? "failed_conflicting_identity"
					: "passed_current_identity_equals_carried_key";

		const directoryAliases = facts.observations.filter((item) =>
			item.kind === "alias" && item.entity.isDirectory);
		const folderRenameActions = disposition.actions.filter((action) =>
			(action.action === "rename_local" || action.action === "rename_remote") &&
			action.isFolder === true);
		const aliasFolder: AliasFolderBranch =
			admittedRenames.some((claim) => claim.isFolder) && reportFamily === "reported"
				? "not_consulted_governing_folder_report"
				: directoryAliases.length === 0
					? "consulted_no_directory_alias_candidate"
					: folderRenameActions.length > 0
						? "consulted_relation_selected"
						: "consulted_candidate_rejected";

		return {
			reportFamily, aliasFolder, evidenceFill, identityGuard, trace,
			kind: disposition.kind,
			reasons: disposition.kind === "failed" ? disposition.reasons : [],
			actions: disposition.actions.map((action) => action.action),
			admittedRemoteRenameKeys: admittedRemote.map((claim) => claim.identityKey),
		};
	}

	function measure(facts: ObservedFacts): Measurement {
		const trace: string[] = [];
		// change-detector.ts:151 — Observation completes identity evidence, then hands
		// entries, evidence and observations to the capture boundary unchanged.
		const completed = completeIdentityEvidence(
			facts.reported, facts.observations, facts.entries,
		);
		const admission = admitBatchObservation(captureBatchObservation(
			[...facts.entries], completed, [...facts.observations],
			tracingScope(facts.scopePaths, trace), "backend\0root",
		));
		expect(admission.dispositions).toHaveLength(1);
		return classify(facts, admission.dispositions[0]!, trace);
	}

	function remoteRenameReport(oldPath: string, newPath: string, isFolder = false): IdentityEvidence {
		// Exactly what `collectRemoteRenameEvidence` builds from a pair whose producer
		// carried no identity — the shape every fixture here uses, so that what these
		// cases measure is what happens to a claim that arrives with nothing to compare.
		// A pair that does carry an identity is the cross-source check's witness, not this
		// measurement's subject.
		return { kind: "rename", side: "remote", oldPath, newPath, isFolder, authority: "reported" };
	}

	it("fixture 1: remote rename under an unchanged local file, baseline carrying an identity", () => {
		const localA = entity("notes/a.md");
		const remoteB = entity("notes/b.md", "drive-1");
		const baseline = recordFor(entity("notes/a.md", "drive-1"));

		const measurement = measure({
			entries: [
				{ path: "notes/a.md", local: localA, prevSync: baseline },
				{ path: "notes/b.md", remote: remoteB },
			],
			observations: [
				{ kind: "exact", side: "local", requestedPath: "notes/a.md", entity: localA },
				{ kind: "absent", side: "local", requestedPath: "notes/b.md", authority: "stat" },
				{ kind: "absent", side: "remote", requestedPath: "notes/a.md", authority: "stat" },
				{ kind: "exact", side: "remote", requestedPath: "notes/b.md", entity: remoteB },
			],
			reported: [remoteRenameReport("notes/a.md", "notes/b.md")],
			scopePaths: ["notes/a.md", "notes/b.md"],
		});

		expect(measurement.reportFamily).toBe("reported");
		expect(measurement.aliasFolder).toBe("consulted_no_directory_alias_candidate");
		// The claim reaches Admission with no identity. `drive-1` is still the current
		// occupant of `notes/b.md` and is still what the guard would have been handed —
		// which is why handing it back was never a check. The relation is bound the same
		// way without it, positionally, and the action is unchanged.
		expect(measurement.evidenceFill).toBe("reached_admission_with_no_identity");
		expect(measurement.identityGuard).toBe("not_reached_evidence_carries_no_identity");
		expect(measurement.admittedRemoteRenameKeys).toEqual([undefined]);
		expect(measurement.trace).toEqual([
			"notes/a.md=>notes/a.md", "notes/b.md=>notes/b.md",
			"notes/a.md=>notes/b.md", "notes/a.md=>notes/b.md",
		]);
		expect(measurement.kind).toBe("authorized");
		expect(measurement.actions).toEqual(["rename_local"]);
	});

	// Fixture 2 — "baseline carrying no identity" — is deleted, not repaired. It
	// asserted `baseline.remoteIdentityKey` was undefined, and `SyncRecord` now
	// declares that field required while `buildSyncRecord` refuses an absent or empty
	// provider identity, so the fixture cannot be constructed at all. Its
	// disappearance is the observable form of the positional arm's retirement: the
	// arm existed only for this input, and nothing may fold the absence to "" to keep
	// the case alive.

	it("fixture 3: a remote object replaced at an address by a different id", () => {
		const localDoc = entity("doc.md");
		const remoteDoc = entity("doc.md", "drive-2");
		const baseline = recordFor(entity("doc.md", "drive-1"));

		const measurement = measure({
			entries: [{ path: "doc.md", local: localDoc, remote: remoteDoc, prevSync: baseline }],
			observations: [
				{ kind: "exact", side: "local", requestedPath: "doc.md", entity: localDoc },
				{ kind: "exact", side: "remote", requestedPath: "doc.md", entity: remoteDoc },
				{ kind: "absent", side: "local", requestedPath: "old.md", authority: "stat" },
				{ kind: "absent", side: "remote", requestedPath: "old.md", authority: "stat" },
			],
			reported: [remoteRenameReport("old.md", "doc.md")],
			scopePaths: ["doc.md", "old.md"],
		});

		// The fill used to supply the *current* occupant's id, so the guard compared
		// "drive-2" against "drive-2" and passed while the address held a different
		// remote object than the record binds. The claim now arrives with no identity and
		// the guard is not reached — and the outcome is the same one, because what
		// discriminates this shape is `indexFacts` and `bindFiles:420-421`, ahead of the
		// guard, which is why nothing was lost by dropping the fill.
		expect(measurement.evidenceFill).toBe("reached_admission_with_no_identity");
		expect(measurement.admittedRemoteRenameKeys).toEqual([undefined]);
		expect(baseline.remoteIdentityKey).toBe("drive-1");
		expect(measurement.reportFamily).toBe("reported");
		expect(measurement.aliasFolder).toBe("consulted_no_directory_alias_candidate");
		expect(measurement.identityGuard).toBe("not_reached_evidence_carries_no_identity");
		expect(measurement.trace).toEqual(["doc.md=>doc.md", "doc.md=>doc.md", "old.md=>doc.md"]);
		expect(measurement.kind).toBe("authorized");
		expect(measurement.actions).toEqual(["match"]);
	});

	it("fixture 4: a rename whose evidence carries no identity", () => {
		const localStale = entity("stale.md");
		const remoteFresh = entity("fresh.md");
		const baseline = recordFor(entity("stale.md"));
		expect(remoteFresh.identityKey).toBeUndefined();

		const measurement = measure({
			entries: [
				{ path: "stale.md", local: localStale, prevSync: baseline },
				{ path: "fresh.md", remote: remoteFresh },
			],
			observations: [
				{ kind: "exact", side: "local", requestedPath: "stale.md", entity: localStale },
				{ kind: "absent", side: "local", requestedPath: "fresh.md", authority: "stat" },
				{ kind: "absent", side: "remote", requestedPath: "stale.md", authority: "stat" },
				{ kind: "exact", side: "remote", requestedPath: "fresh.md", entity: remoteFresh },
			],
			reported: [remoteRenameReport("stale.md", "fresh.md")],
			scopePaths: ["stale.md", "fresh.md"],
		});

		// Nothing is looked up and nothing is attached, so the claim stays unkeyed and
		// line 106's `report.identityKey` precondition is never satisfied. This shape read
		// the same on the pre-removal measurement, where the lookup ran and missed: it is
		// the one fixture whose observable outcome the fill never touched.
		expect(measurement.evidenceFill).toBe("reached_admission_with_no_identity");
		expect(measurement.admittedRemoteRenameKeys).toEqual([undefined]);
		expect(measurement.reportFamily).toBe("reported");
		expect(measurement.aliasFolder).toBe("consulted_no_directory_alias_candidate");
		expect(measurement.identityGuard).toBe("not_reached_evidence_carries_no_identity");
		// The baseline now carries an identity (it must), and no current remote entity
		// carries it, so nothing binds the baseline to `fresh.md` — the report's address
		// no longer does. The component is not admitted rather than being relocated
		// positionally, which is the whole point of the retired arm.
		expect(measurement.trace).toEqual([
			"stale.md=>stale.md", "fresh.md=>fresh.md",
			"stale.md=>fresh.md", "stale.md=>stale.md",
		]);
		expect(measurement.kind).toBe("failed");
		expect(measurement.reasons).toEqual(["unknown_observation"]);
		expect(measurement.actions).toEqual([]);
	});

	it("fixture 5: a folder rename whose descendants are not re-emitted", () => {
		const localFolder = { ...entity("notes"), isDirectory: true, hash: "", size: 0, mtime: 0 };
		const remoteFolder = { ...entity("Notes", "folder-1"), isDirectory: true, hash: "", size: 0, mtime: 0 };
		const localChild = entity("notes/x.md");
		const remoteChild = entity("Notes/x.md", "child-1");
		const baseline = recordFor(entity("Notes/x.md", "child-1"));

		const measurement = measure({
			entries: [
				{ path: "notes/x.md", local: localChild },
				{ path: "Notes/x.md", remote: remoteChild, prevSync: baseline },
			],
			observations: [
				{ kind: "exact", side: "local", requestedPath: "notes", entity: localFolder },
				{
					kind: "alias", side: "local", requestedPath: "Notes",
					resolvedPath: "notes", entity: localFolder,
				},
				{ kind: "exact", side: "local", requestedPath: "notes/x.md", entity: localChild },
				{ kind: "absent", side: "local", requestedPath: "Notes/x.md", authority: "stat" },
				{ kind: "exact", side: "remote", requestedPath: "Notes", entity: remoteFolder },
				{ kind: "absent", side: "remote", requestedPath: "notes", authority: "stat" },
				{ kind: "exact", side: "remote", requestedPath: "Notes/x.md", entity: remoteChild },
				{ kind: "absent", side: "remote", requestedPath: "notes/x.md", authority: "stat" },
			],
			// The folder moved; only the folder itself is re-observed. No descendant
			// claim and no descendant alias is emitted for "x.md".
			reported: [],
			scopePaths: ["Notes", "notes", "Notes/x.md", "notes/x.md"],
		});

		expect(measurement.reportFamily).toBe("none");
		expect(measurement.aliasFolder).toBe("consulted_relation_selected");
		expect(measurement.evidenceFill).toBe("no_remote_rename_evidence");
		expect(measurement.identityGuard).toBe("not_reached_family_not_reported");
		expect(measurement.trace).toEqual([
			"notes/x.md=>notes/x.md", "Notes/x.md=>Notes/x.md",
			"Notes=>notes", "Notes=>notes", "Notes=>notes",
			"Notes/x.md=>notes/x.md",
		]);
		expect(measurement.kind).toBe("authorized");
		expect(measurement.actions).toEqual(["rename_remote"]);
	});

	it("probe: the two map-keying divergences no longer reach the guard at all", () => {
		const localDoc = entity("doc.md");
		const baseline = recordFor(entity("doc.md", "drive-1"));

		// The boundary this case pins is a claim about a population, not about
		// impossibility, so both divergences are constructed exactly as they were. Both
		// still exist in the code: the completion map and `current.remote` still key one
		// entity differently. Only the route from that difference to a failure is gone.
		//
		// Divergence A — an entry addressed at one path carrying a remote endpoint
		// resolved at another. `completeIdentityEvidence` keys the entry's identity by
		// `entry.path` (identity-evidence.ts:57); `indexFacts` keys it by
		// `entry.remote.path` (identity-component-decision.ts:349 via insert()).
		const elsewhere = entity("elsewhere.md", "drive-2");
		const byEntryAddress = measure({
			entries: [{ path: "doc.md", local: localDoc, remote: elsewhere, prevSync: baseline }],
			observations: [
				{ kind: "exact", side: "local", requestedPath: "doc.md", entity: localDoc },
				{ kind: "absent", side: "local", requestedPath: "old.md", authority: "stat" },
				{ kind: "absent", side: "remote", requestedPath: "old.md", authority: "stat" },
			],
			reported: [remoteRenameReport("old.md", "doc.md")],
			scopePaths: ["doc.md", "elsewhere.md", "old.md"],
		});

		expect(byEntryAddress.reportFamily).toBe("reported");
		expect(byEntryAddress.aliasFolder).toBe("consulted_no_directory_alias_candidate");
		// The divergence is still here — the completion map still keys this entry by
		// `entry.path` while `indexFacts` keys it by `entry.remote.path`. What is gone is
		// the claim that used to pick the difference up: nothing writes `drive-2` onto the
		// report, so the guard is not reached and the `conflicting_identity` it produced
		// was a failure the enrichment manufactured, not one any fact supported.
		expect(byEntryAddress.evidenceFill).toBe("reached_admission_with_no_identity");
		expect(byEntryAddress.admittedRemoteRenameKeys).toEqual([undefined]);
		expect(byEntryAddress.identityGuard).toBe("not_reached_evidence_carries_no_identity");
		// The component is still not admitted and still produces no action. It now runs
		// past the report loop — the trace's fourth entry is `bindFiles`' own compatibility
		// check — and stops on the facts instead: nothing observed accounts for the
		// baseline's remote endpoint, so materialization returns `unknown_observation`.
		expect(byEntryAddress.kind).toBe("failed");
		expect(byEntryAddress.reasons).toEqual(["unknown_observation"]);
		expect(byEntryAddress.actions).toEqual([]);
		expect(byEntryAddress.trace).toEqual([
			"doc.md=>doc.md", "doc.md=>elsewhere.md", "old.md=>doc.md", "doc.md=>doc.md",
		]);

		// Divergence B — two remote observations at one address: the keyed one carries
		// no hash, so insert() keeps the hashed, unkeyed prior
		// (identity-component-decision.ts:329) while the completion map takes the last
		// keyed writer (identity-evidence.ts:54). That map now feeds only the occurrence
		// index, so the disagreement has nowhere to surface as a rename identity.
		const hashedUnkeyed = entity("doc.md");
		const keyedUnhashed = { ...entity("doc.md", "drive-2"), hash: "" };
		const byInsertPreference = measure({
			entries: [{ path: "doc.md", local: localDoc, prevSync: baseline }],
			observations: [
				{ kind: "exact", side: "local", requestedPath: "doc.md", entity: localDoc },
				{ kind: "exact", side: "remote", requestedPath: "doc.md", entity: hashedUnkeyed },
				{ kind: "exact", side: "remote", requestedPath: "doc.md", entity: keyedUnhashed },
				{ kind: "absent", side: "local", requestedPath: "old.md", authority: "stat" },
				{ kind: "absent", side: "remote", requestedPath: "old.md", authority: "stat" },
			],
			reported: [remoteRenameReport("old.md", "doc.md")],
			scopePaths: ["doc.md", "old.md"],
		});

		expect(byInsertPreference.evidenceFill).toBe("reached_admission_with_no_identity");
		expect(byInsertPreference.admittedRemoteRenameKeys).toEqual([undefined]);
		expect(byInsertPreference.identityGuard).toBe("not_reached_evidence_carries_no_identity");
		// As in divergence A: still not admitted, still no action, but now carried past the
		// report loop into `bindFiles` (the third trace entry) and stopped on the facts —
		// the baseline's identity has no current remote occurrence and its address is not
		// observed absent — rather than by a guard comparing a key the report never carried.
		expect(byInsertPreference.kind).toBe("failed");
		expect(byInsertPreference.reasons).toEqual(["unknown_observation"]);
		expect(byInsertPreference.actions).toEqual([]);
		expect(byInsertPreference.trace).toEqual([
			"doc.md=>doc.md", "old.md=>doc.md", "doc.md=>doc.md",
		]);
	});
});
