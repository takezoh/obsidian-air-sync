import { describe, expect, it } from "vitest";
import {
	captureBatchObservation,
	prepareSyncCycleSnapshot,
	type BatchObservation,
} from "./sync-cycle-planning";
import type { ChangeSet } from "./change-detector";
import type { MixedEntity, ScopeDisposition, ScopeProjection, SyncRecord } from "./types";

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
			changeSet, "backend\0root", { classifyPath: () => "included" },
		);

		expect(snapshot.entries).toEqual(changeSet.entries);
		expect(snapshot.observations).toEqual(changeSet.observations);
		expect(snapshot.evidence.map((item) => item.evidence)).toEqual(changeSet.identityEvidence);
		expect([...snapshot.baselinePaths]).toEqual(["renamed.md"]);
		expect(snapshot.namespace).toBe("backend\0root");
		expect(snapshot.scope.byEndpoint.get("renamed.md")).toBe("included");
		expect("plan" in snapshot).toBe(false);
	});

});
