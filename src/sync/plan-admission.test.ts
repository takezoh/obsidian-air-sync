import { describe, expect, it } from "vitest";
import type { FileEntity } from "../fs/types";
import {
	admitBatchObservation,
	type AuthorizedSyncPlan,
} from "./plan-admission";
import { captureBatchObservation } from "./sync-cycle-planning";
import { decideIdentityComponent } from "./identity-component-decision";
import type { IdentityComponent } from "./plan-admission-graph";
import type {
	IdentityEvidence,
	PathObservation,
	ScopeDisposition,
	ScopeProjection,
	SyncAction,
	SyncRecord,
	MixedEntity,
} from "./types";

function entity(path: string, identityKey?: string): FileEntity {
	return { path, identityKey, pathAuthority: "actual_resolved", isDirectory: false, size: 1, mtime: 1, hash: "h" };
}

function freshEntity(path: string, hash: string, identityKey?: string): FileEntity {
	return { path, hash, identityKey, pathAuthority: "actual_resolved", isDirectory: false, size: 1, mtime: 1 };
}

function recordFor(current: FileEntity): SyncRecord {
	return {
		path: current.path, hash: current.hash, localMtime: current.mtime,
		remoteMtime: current.mtime, localSize: current.size, remoteSize: current.size,
		remoteIdentityKey: current.identityKey, syncedAt: 1,
	};
}

function projection(entries: Record<string, ScopeDisposition>): ScopeProjection {
	return { isConfiguredScopeCompatible: () => true, byEndpoint: new Map(Object.entries(entries)) };
}

/** Legacy case fixtures contribute endpoint/record data only. Action kinds and
 * execution payloads are deliberately absent from the public Admission input.
 */
function captureFixtureFacts(
	fixtures: { actions: SyncAction[] }, evidence: readonly IdentityEvidence[],
	observations: readonly PathObservation[], scope: ScopeProjection, namespace: string,
	baselinePaths?: readonly string[], entries: readonly MixedEntity[] = [],
) {
	return captureBatchObservation([
		...entries,
		...fixtures.actions.map(({ path, local, remote, baseline }) => ({ path, local, remote, prevSync: baseline })),
	], evidence, observations, scope, namespace, baselinePaths);
}

function admit(
	actions: SyncAction[],
	evidence: IdentityEvidence[] = [],
	observations: PathObservation[] = [],
	scope?: ScopeProjection,
	entries: MixedEntity[] = [],
) {
	return admitBatchObservation(captureFixtureFacts(
		{ actions }, evidence, observations, scope ?? projection(Object.fromEntries([
			...actions.map(({ path }) => path), ...entries.map(({ path }) => path),
			...observations.map(({ requestedPath }) => requestedPath),
			...evidence.flatMap((item) => item.kind === "rename" ? [item.oldPath, item.newPath]
				: item.kind === "alias" ? [item.requestedPath, item.resolvedPath] : item.occurrences.map(({ path }) => path)),
		].map((path) => [path, "included"]))), "backend\0root", undefined, entries,
	));
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
	const actions: SyncAction[] = [
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
			localSize: 1, remoteSize: 1, syncedAt: 1,
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
		const actions: SyncAction[] = [
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
		const actions: SyncAction[] = [
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
		const actions: SyncAction[] = [
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
		const actions: SyncAction[] = [
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
		const baseline = (path: string, remoteIdentityKey?: string) => ({
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

	it("rejects a case-alias component whose contents are not proven equal", () => {
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
			],
			projection({ "Case.md": "included", "case.md": "included" }),
			[
				{ path: "Case.md", remote },
				{ path: "case.md", local },
			],
		);

		expect(result.executable.actions).toEqual([]);
		expect(result.failures[0]?.reasons).toEqual(["case_alias_content_mismatch"]);
	});

	it("keeps the case-alias decision unchanged when unrelated terminal state exists", () => {
		const local = entity("case.md");
		const remote = entity("Case.md", "R");
		const unrelated: SyncRecord = {
			path: "unrelated.md", hash: "h", localMtime: 1, remoteMtime: 1,
			localSize: 1, remoteSize: 1, syncedAt: 1,
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

	it("rejects unproven or size-mismatched unbaselined case aliases", () => {
		const unhashed = caseAliasFixture(
			freshEntity("case.md", ""), freshEntity("Case.md", "", "R"),
		);
		const unproven = admit(
			unhashed.actions, unhashed.evidence, unhashed.observations, unhashed.scope, unhashed.entries,
		);
		const mismatched = caseAliasFixture(
			entity("case.md"), { ...entity("Case.md", "R"), size: 2 },
		);
		const differentSize = admit(
			mismatched.actions, mismatched.evidence, mismatched.observations,
			mismatched.scope, mismatched.entries,
		);

		expect(unproven.failures[0]?.reasons).toEqual(["case_alias_content_mismatch"]);
		expect(differentSize.failures[0]?.reasons).toEqual(["case_alias_content_mismatch"]);
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
			publication: { source: baseline, destination: undefined },
		}]);
	});

	it("rejects missing endpoint observations regardless of fixture action labels", () => {
		const actions: SyncAction[] = [
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
		const actions: SyncAction[] = [
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
		const actions: SyncAction[] = [
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
		const actions: SyncAction[] = [
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
		const actions: SyncAction[] = [
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

	it("defers a folder rename whose descendant relative paths are crossed", () => {
		const fixture = folderFacts(["x.md", "y.md"]);
		fixture.evidence.push(
			remoteRename({ oldPath: "A/x.md", newPath: "B/y.md", identityKey: "file:y.md" }),
			remoteRename({ oldPath: "A/y.md", newPath: "B/x.md", identityKey: "file:x.md" }),
		);
		const result = admit([], fixture.evidence, fixture.observations, fixture.scope, fixture.entries);

		expect(result.executable.actions).toEqual([]);
		expect(result.failures[0]!.reasons).toEqual(["rename_mismatch"]);
	});

	it("rejects conflicting reports before selecting any candidate family", () => {
		const actions: SyncAction[] = [
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
				kind: "failed", reasons: ["rename_mismatch"], actions: [],
			});
		}
	});

	it("does not fall back to a complete alias candidate when reports conflict", () => {
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
			expect(result.failures[0]!.reasons).toEqual(["rename_mismatch"]);
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
		const actions: SyncAction[] = [
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
		expect(result.failures[0]!.reasons).toEqual(["incomplete_folder_mapping"]);
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

	it("rejects a file endpoint as the binding for a reported folder root", () => {
		const fixture = folderFacts([]);
		fixture.entries[0]!.local = entity("A");
		fixture.observations[0] = { kind: "exact", side: "local", requestedPath: "A", entity: entity("A") };
		const action: SyncAction = {
			path: "B", oldPath: "A", action: "rename_local",
		};
		const result = admit([action], fixture.evidence, fixture.observations, fixture.scope, fixture.entries);

		expect(result.executable.actions).toEqual([]);
		expect(result.failures[0]!.reasons).toEqual(["incomplete_folder_mapping"]);
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
		const actions: SyncAction[] = [
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
	])("rejects folder report identity conflict: $name", ({ children }) => {
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
		expect(result.failures[0]!.reasons).toEqual(["rename_mismatch"]);
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
		const previous = (path: string): SyncRecord => ({
			path, hash: "h", localMtime: 1, remoteMtime: 1,
			localSize: 1, remoteSize: 1, syncedAt: 1,
		});
		const actions: SyncAction[] = [
			{
				path: "Templates/a.md", action: "delete_remote",
				remote: entity("Templates/a.md"), baseline: previous("Templates/a.md"),
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
		const actions: SyncAction[] = [
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
			localSize: 1, remoteSize: 1, syncedAt: 1,
		};
		const actions: SyncAction[] = [
			{
				path: "Templates/a.md", action: "delete_remote",
				remote: entity("Templates/a.md"), baseline: previous,
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
		const oldAction: SyncAction = remoteOld && remoteOld !== "unknown"
			? { path: "A.md", action: remoteOld.hash === "H0" ? "delete_remote" : "conflict", remote: remoteOld, baseline }
			: { path: "A.md", action: "cleanup", baseline };
		const newAction: SyncAction = remoteNew
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
			localSize: 1, remoteSize: 1, syncedAt: 1,
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
			action: "conflict", path: "B.md", local, baseline,
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
