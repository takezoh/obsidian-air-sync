import { describe, expect, it } from "vitest";
import {
	captureBatchObservation,
	prepareSyncCycleSnapshot,
	type BatchObservation,
} from "./sync-cycle-planning";
import type { ChangeSet } from "./change-detector";
import type { MixedEntity, ScopeDisposition, ScopeProjection, SyncRecord } from "./types";
import { admitBatchObservation } from "./plan-admission";

function cannotMutateObservation(observation: BatchObservation): void {
	// @ts-expect-error -- the Observation boundary is deeply readonly at compile time.
	observation.entries[0]!.path = "other.md";
	// @ts-expect-error -- nested filesystem facts are deeply readonly too.
	observation.entries[0]!.local!.hash = "other-hash";
}

void cannotMutateObservation;

function baseline(path: string): SyncRecord {
	return {
		path, hash: "base", localMtime: 1, remoteMtime: 1,
		localSize: 4, remoteSize: 4, syncedAt: 1,
	};
}

describe("batch observation boundary", () => {
	it("captures immutable facts without constructing an action plan", () => {
		const entries: MixedEntity[] = [{
			path: "renamed.md",
			local: {
				path: "renamed.md", size: 7, mtime: 2, hash: "new-hash", isDirectory: false,
			},
		}];
		const scope: ScopeProjection = {
			byEndpoint: new Map([["renamed.md", "included"]]),
		};

		const observation = captureBatchObservation(
			entries,
			[],
			[],
			scope,
			"backend\0root",
			["renamed.md"],
		);

		entries[0]!.path = "mutated.md";
		(scope.byEndpoint as Map<string, ScopeDisposition>).set("mutated.md", "included");

		expect(observation.entries).toEqual([expect.objectContaining({ path: "renamed.md" })]);
		expect([...observation.baselinePaths]).toEqual(["renamed.md"]);
		expect(observation.scope.byEndpoint.has("mutated.md")).toBe(false);
		expect("plan" in observation).toBe(false);
		expect(() => (observation.entries as MixedEntity[]).push({ path: "extra.md" })).toThrow();
	});

	it("assembles the production boundary from current-cycle facts", () => {
		const previous = baseline("renamed.md");
		const changeSet: ChangeSet = {
			entries: [{
				path: "renamed.md", prevSync: previous,
				local: {
					path: "renamed.md", size: 7, mtime: 2,
					hash: "new-hash", isDirectory: false,
				},
			}],
			observations: [{
				kind: "exact", side: "local", requestedPath: "renamed.md",
				entity: {
					path: "renamed.md", size: 7, mtime: 2,
					hash: "new-hash", isDirectory: false,
				},
			}],
			identityEvidence: [{
				kind: "alias", side: "remote", requestedPath: "alias.md", resolvedPath: "renamed.md",
			}],
			temperature: "cold",
		};
		const { snapshot } = prepareSyncCycleSnapshot(
			changeSet, "backend\0root", { isExcluded: () => false },
		);

		expect(snapshot.entries).toEqual(changeSet.entries);
		expect(snapshot.observations).toEqual(changeSet.observations);
		expect(snapshot.evidence.map((item) => item.evidence)).toEqual(changeSet.identityEvidence);
		expect([...snapshot.baselinePaths]).toEqual(["renamed.md"]);
		expect(snapshot.namespace).toBe("backend\0root");
		expect(snapshot.scope.byEndpoint.get("renamed.md")).toBe("included");
		expect("plan" in snapshot).toBe(false);
	});

	it("removes excluded paths and cross-scope identity before the engine boundary", () => {
		const oldRecord = baseline("old.md");
		const excludedRecord = baseline("desktop.ini");
		const changeSet: ChangeSet = {
			entries: [
				{ path: "old.md", prevSync: oldRecord },
				{
					path: "new.md",
					local: { path: "new.md", size: 4, mtime: 2, hash: "new", isDirectory: false },
				},
				{ path: "desktop.ini", prevSync: excludedRecord },
			],
			observations: [
				{ kind: "absent", side: "local", requestedPath: "old.md", authority: "stat" },
				{
					kind: "exact", side: "local", requestedPath: "new.md",
					entity: { path: "new.md", size: 4, mtime: 2, hash: "new", isDirectory: false },
				},
				{
					kind: "absent", side: "local", requestedPath: "desktop.ini", authority: "stat",
				},
			],
			identityEvidence: [{
				kind: "rename", side: "local", oldPath: "old.md", newPath: "new.md",
				isFolder: false, authority: "reported",
			}],
			temperature: "hot",
		};

		const { snapshot } = prepareSyncCycleSnapshot(changeSet, "backend\0root", {
			isExcluded: (path) => path !== "old.md",
		});

		expect(snapshot.entries.map((entry) => entry.path)).toEqual(["old.md"]);
		expect(snapshot.observations.map((item) => item.requestedPath)).toEqual(["old.md"]);
		expect(snapshot.evidence).toEqual([]);
		expect([...snapshot.scope.byEndpoint.keys()]).toEqual(["old.md"]);
		expect([...snapshot.baselinePaths]).toEqual(["old.md"]);
	});

	it.each([
		{
			name: "included to excluded as a deletion",
			excludedPath: "new.md",
			entries: [
				{
					path: "old.md", prevSync: baseline("old.md"),
					remote: { path: "old.md", size: 4, mtime: 1, hash: "base", isDirectory: false },
				},
				{
					path: "new.md",
					local: { path: "new.md", size: 4, mtime: 2, hash: "new", isDirectory: false },
				},
			],
			observations: [
				{ kind: "absent", side: "local", requestedPath: "old.md", authority: "stat" },
				{
					kind: "exact", side: "remote", requestedPath: "old.md",
					entity: { path: "old.md", size: 4, mtime: 1, hash: "base", isDirectory: false },
				},
				{
					kind: "exact", side: "local", requestedPath: "new.md",
					entity: { path: "new.md", size: 4, mtime: 2, hash: "new", isDirectory: false },
				},
			] as ChangeSet["observations"],
			expectedAction: { action: "delete_remote", path: "old.md" },
		},
		{
			name: "excluded to included as a creation",
			excludedPath: "old.md",
			entries: [
				{
					path: "old.md", prevSync: baseline("old.md"),
					remote: { path: "old.md", size: 4, mtime: 1, hash: "base", isDirectory: false },
				},
				{
					path: "new.md",
					local: { path: "new.md", size: 4, mtime: 2, hash: "new", isDirectory: false },
				},
			],
			observations: [
				{
					kind: "exact", side: "remote", requestedPath: "old.md",
					entity: { path: "old.md", size: 4, mtime: 1, hash: "base", isDirectory: false },
				},
				{
					kind: "exact", side: "local", requestedPath: "new.md",
					entity: { path: "new.md", size: 4, mtime: 2, hash: "new", isDirectory: false },
				},
				{ kind: "absent", side: "remote", requestedPath: "new.md", authority: "stat" },
			] as ChangeSet["observations"],
			expectedAction: { action: "push", path: "new.md" },
		},
	] as const)("plans a cross-scope local rename $name", ({ excludedPath, entries, observations, expectedAction }) => {
		const changeSet: ChangeSet = {
			entries: [...entries],
			observations: [...observations],
			identityEvidence: [{
				kind: "rename", side: "local", oldPath: "old.md", newPath: "new.md",
				isFolder: false, authority: "reported",
			}],
			temperature: "hot",
		};
		const { snapshot } = prepareSyncCycleSnapshot(changeSet, "backend\0root", {
			isExcluded: (path) => path === excludedPath,
		});

		const admission = admitBatchObservation(snapshot);

		expect(snapshot.evidence).toEqual([]);
		expect(admission.failures).toEqual([]);
		expect(admission.executable.actions).toEqual([
			expect.objectContaining(expectedAction),
		]);
	});

});
