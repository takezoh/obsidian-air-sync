import { describe, expect, it, vi } from "vitest";
import {
	captureBatchObservation,
	prepareSyncCycleSnapshot,
	prepareSyncCycleSnapshotForExecution,
	type BatchObservation,
} from "./sync-cycle-planning";
import type { ChangeSet } from "./change-detector";
import type { MixedEntity, ScopeDisposition, ScopeProjection, SyncRecord } from "./types";
import { admitBatchObservation } from "./plan-admission";
import { addFile, createMockLocalFs, createMockRemoteFs, deferred, flush } from "../__mocks__/sync-test-helpers";
import { sha256 } from "../utils/hash";

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
	it.each(["cold", "warm", "hot"] as const)(
		"completes Prefer-local SHA-256 facts after %s acquisition and authorizes only proven bilateral edits",
		async (temperature) => {
		const localFs = createMockLocalFs();
		const remoteFs = createMockRemoteFs("actual_resolved");
		const local = addFile(localFs, "note.md", "local", 2000);
		const remote = addFile(remoteFs, "note.md", "remote", 3000);
		local.hash = "";
		remote.hash = "";
		remote.remoteChecksum = undefined;
		const previous = {
			...baseline("note.md"), hash: await sha256(new TextEncoder().encode("base").buffer),
		};
		const changeSet: ChangeSet = {
			entries: [{ path: "note.md", local, remote, prevSync: previous }],
			observations: [
				{ kind: "exact", side: "local", requestedPath: "note.md", entity: local },
				{ kind: "exact", side: "remote", requestedPath: "note.md", entity: remote },
			],
			identityEvidence: [], temperature, candidateFacts: [],
		};

		const { snapshot } = await prepareSyncCycleSnapshotForExecution(
			changeSet, "backend\0root", { ignorePatterns: [] }, "prefer_local", localFs, remoteFs,
		);
		const admission = admitBatchObservation(snapshot, "prefer_local");

		expect(snapshot.entries[0]!.local?.hash).toBe(await sha256(new TextEncoder().encode("local").buffer));
		expect(snapshot.entries[0]!.remote?.hash).toBe(await sha256(new TextEncoder().encode("remote").buffer));
		expect(admission.executable.actions).toMatchObject([{
			action: "conflict", preferLocalDisposition: "local_win_allowed",
		}]);
	});

	it("uses a declared remote SHA-256 checksum without reading the remote body", async () => {
		const localFs = createMockLocalFs();
		const remoteFs = createMockRemoteFs("actual_resolved");
		const local = addFile(localFs, "note.md", "local", 2000);
		const remote = addFile(remoteFs, "note.md", "remote", 3000);
		local.hash = "";
		remote.hash = "";
		remote.remoteChecksum = {
			algo: "sha256", value: await sha256(new TextEncoder().encode("remote").buffer),
		};
		const previous = {
			...baseline("note.md"), hash: await sha256(new TextEncoder().encode("base").buffer),
		};
		const changeSet: ChangeSet = {
			entries: [{ path: "note.md", local, remote, prevSync: previous }],
			observations: [
				{ kind: "exact", side: "local", requestedPath: "note.md", entity: local },
				{ kind: "exact", side: "remote", requestedPath: "note.md", entity: remote },
			],
			identityEvidence: [], temperature: "warm", candidateFacts: [],
		};
		const remoteRead = vi.spyOn(remoteFs, "read");

		const { snapshot } = await prepareSyncCycleSnapshotForExecution(
			changeSet, "backend\0root", { ignorePatterns: [] }, "prefer_local", localFs, remoteFs,
		);

		expect(remoteRead).not.toHaveBeenCalled();
		expect(snapshot.entries[0]!.remote?.hash).toBe(remote.remoteChecksum.value);
		expect(admitBatchObservation(snapshot, "prefer_local").executable.actions).toMatchObject([{
			action: "conflict", preferLocalDisposition: "local_win_allowed",
		}]);
	});

	it("aborts preparation when required Prefer-local proof capture fails", async () => {
		const localFs = createMockLocalFs();
		const remoteFs = createMockRemoteFs("actual_resolved");
		const local = addFile(localFs, "note.md", "local", 2000);
		const remote = addFile(remoteFs, "note.md", "remote", 3000);
		local.hash = "";
		remote.hash = "";
		remote.remoteChecksum = undefined;
		const changeSet: ChangeSet = {
			entries: [{ path: "note.md", local, remote, prevSync: baseline("note.md") }],
			observations: [], identityEvidence: [], temperature: "hot", candidateFacts: [],
		};
		vi.spyOn(localFs, "read").mockRejectedValue(new Error("proof read failed"));

		await expect(prepareSyncCycleSnapshotForExecution(
			changeSet, "backend\0root", { ignorePatterns: [] }, "prefer_local", localFs, remoteFs,
		)).rejects.toThrow("Content source unreadable: note.md");
	});

	it("drains scheduled Prefer-local proof siblings before reporting a failure", async () => {
		const localFs = createMockLocalFs();
		const remoteFs = createMockRemoteFs("actual_resolved");
		const entries = ["a.md", "b.md"].map((path, index) => {
			const local = addFile(localFs, path, `local-${path}`, 2000 + index);
			const remote = addFile(remoteFs, path, `remote-${path}`, 3000 + index);
			local.hash = "";
			remote.hash = "";
			remote.remoteChecksum = undefined;
			return { path, local, remote, prevSync: baseline(path) };
		});
		const changeSet: ChangeSet = {
			entries,
			observations: [], identityEvidence: [], temperature: "hot", candidateFacts: [],
		};
		const sibling = deferred();
		const originalRead = localFs.read.bind(localFs);
		vi.spyOn(localFs, "read").mockImplementation(async (path) => {
			if (path === "a.md") throw new Error("first proof failed");
			await sibling.promise;
			return originalRead(path);
		});
		let settled = false;
		const attempt = prepareSyncCycleSnapshotForExecution(
			changeSet, "backend\0root", { ignorePatterns: [] }, "prefer_local", localFs, remoteFs,
		);
		const observed = attempt.then(
			() => { settled = true; },
			() => { settled = true; },
		);

		await flush();
		expect(settled).toBe(false);
		sibling.resolve();
		await observed;
		await expect(attempt).rejects.toThrow("Content source unreadable: a.md");
	});

	it("does not infer local priority on a baseline-free cold start", async () => {
		const localFs = createMockLocalFs();
		const remoteFs = createMockRemoteFs("actual_resolved");
		const local = addFile(localFs, "note.md", "local", 2000);
		const remote = addFile(remoteFs, "note.md", "remote", 3000);
		const changeSet: ChangeSet = {
			entries: [{ path: "note.md", local, remote }],
			observations: [
				{ kind: "exact", side: "local", requestedPath: "note.md", entity: local },
				{ kind: "exact", side: "remote", requestedPath: "note.md", entity: remote },
			],
			identityEvidence: [], temperature: "cold", candidateFacts: [],
		};
		const localRead = vi.spyOn(localFs, "read");
		const remoteRead = vi.spyOn(remoteFs, "read");

		const { snapshot } = await prepareSyncCycleSnapshotForExecution(
			changeSet, "backend\0root", { ignorePatterns: [] }, "prefer_local", localFs, remoteFs,
		);

		expect(localRead).not.toHaveBeenCalled();
		expect(remoteRead).not.toHaveBeenCalled();
		expect(admitBatchObservation(snapshot, "prefer_local").executable.actions).toMatchObject([{
			action: "conflict", preferLocalDisposition: "preservation_required",
		}]);
	});

	it.each(["auto_merge", "duplicate"] as const)("adds no proof reads for %s", async (strategy) => {
		const localFs = createMockLocalFs();
		const remoteFs = createMockRemoteFs("actual_resolved");
		const local = addFile(localFs, "note.md", "local", 2000);
		const remote = addFile(remoteFs, "note.md", "remote", 3000);
		local.hash = "";
		remote.hash = "";
		remote.remoteChecksum = undefined;
		const changeSet: ChangeSet = {
			entries: [{ path: "note.md", local, remote, prevSync: baseline("note.md") }],
			observations: [], identityEvidence: [], temperature: "cold", candidateFacts: [],
		};
		const localRead = vi.spyOn(localFs, "read");
		const remoteRead = vi.spyOn(remoteFs, "read");

		await prepareSyncCycleSnapshotForExecution(
			changeSet, "backend\0root", { ignorePatterns: [] }, strategy, localFs, remoteFs,
		);

		expect(localRead).not.toHaveBeenCalled();
		expect(remoteRead).not.toHaveBeenCalled();
	});

	it("does not read excluded Prefer-local candidates", async () => {
		const localFs = createMockLocalFs();
		const remoteFs = createMockRemoteFs("actual_resolved");
		const local = addFile(localFs, "private.md", "local", 2000);
		const remote = addFile(remoteFs, "private.md", "remote", 3000);
		local.hash = "";
		remote.hash = "";
		remote.remoteChecksum = undefined;
		const changeSet: ChangeSet = {
			entries: [{ path: "private.md", local, remote, prevSync: baseline("private.md") }],
			observations: [], identityEvidence: [], temperature: "cold", candidateFacts: [],
		};
		const localRead = vi.spyOn(localFs, "read");
		const remoteRead = vi.spyOn(remoteFs, "read");

		const { snapshot } = await prepareSyncCycleSnapshotForExecution(
			changeSet, "backend\0root", { reservedPaths: ["private.md"] },
			"prefer_local", localFs, remoteFs,
		);

		expect(snapshot.entries).toEqual([]);
		expect(localRead).not.toHaveBeenCalled();
		expect(remoteRead).not.toHaveBeenCalled();
	});

	it("does not read a Prefer-local candidate connected to rename topology", async () => {
		const localFs = createMockLocalFs();
		const remoteFs = createMockRemoteFs("actual_resolved");
		const local = addFile(localFs, "B.md", "local", 2000);
		const remote = addFile(remoteFs, "B.md", "remote", 3000);
		local.hash = "";
		remote.hash = "";
		remote.remoteChecksum = undefined;
		const changeSet: ChangeSet = {
			entries: [{ path: "B.md", local, remote, prevSync: baseline("B.md") }],
			observations: [],
			identityEvidence: [{
				kind: "rename", side: "remote", oldPath: "A.md", newPath: "B.md",
				isFolder: false, authority: "reported", identityKey: "R",
			}],
			temperature: "warm", candidateFacts: [],
		};
		const localRead = vi.spyOn(localFs, "read");
		const remoteRead = vi.spyOn(remoteFs, "read");

		await prepareSyncCycleSnapshotForExecution(
			changeSet, "backend\0root", { ignorePatterns: [] }, "prefer_local", localFs, remoteFs,
		);

		expect(localRead).not.toHaveBeenCalled();
		expect(remoteRead).not.toHaveBeenCalled();
	});

	it.each([
		{
			name: "an alias",
			previous: baseline("B.md"),
			identityEvidence: [{
				kind: "alias" as const, side: "remote" as const,
				requestedPath: "B.md", resolvedPath: "b.md",
			}],
		},
		{
			name: "a baseline path mismatch",
			previous: baseline("A.md"),
			identityEvidence: [],
		},
	])("does not read a Prefer-local candidate with $name", async ({ previous, identityEvidence }) => {
		const localFs = createMockLocalFs();
		const remoteFs = createMockRemoteFs("actual_resolved");
		const local = addFile(localFs, "B.md", "local", 2000);
		const remote = addFile(remoteFs, "B.md", "remote", 3000);
		local.hash = "";
		remote.hash = "";
		remote.remoteChecksum = undefined;
		const changeSet: ChangeSet = {
			entries: [{ path: "B.md", local, remote, prevSync: previous }],
			observations: [], identityEvidence, temperature: "warm", candidateFacts: [],
		};
		const localRead = vi.spyOn(localFs, "read");
		const remoteRead = vi.spyOn(remoteFs, "read");

		await prepareSyncCycleSnapshotForExecution(
			changeSet, "backend\0root", { ignorePatterns: [] }, "prefer_local", localFs, remoteFs,
		);

		expect(localRead).not.toHaveBeenCalled();
		expect(remoteRead).not.toHaveBeenCalled();
	});

	it("does not read Prefer-local candidates sharing one remote identity", async () => {
		const localFs = createMockLocalFs();
		const remoteFs = createMockRemoteFs("actual_resolved");
		const entries = ["B.md", "C.md"].map((path, index) => {
			const local = addFile(localFs, path, `local-${path}`, 2000 + index);
			const remote = addFile(remoteFs, path, `remote-${path}`, 3000 + index);
			local.hash = "";
			remote.hash = "";
			remote.remoteChecksum = undefined;
			remote.identityKey = "shared-remote-identity";
			return { path, local, remote, prevSync: baseline(path) };
		});
		const changeSet: ChangeSet = {
			entries, observations: [], identityEvidence: [], temperature: "warm", candidateFacts: [],
		};
		const localRead = vi.spyOn(localFs, "read");
		const remoteRead = vi.spyOn(remoteFs, "read");

		await prepareSyncCycleSnapshotForExecution(
			changeSet, "backend\0root", { ignorePatterns: [] }, "prefer_local", localFs, remoteFs,
		);

		expect(localRead).not.toHaveBeenCalled();
		expect(remoteRead).not.toHaveBeenCalled();
	});

	it("reads each isolated Prefer-local proof candidate exactly once per side", async () => {
		const localFs = createMockLocalFs();
		const remoteFs = createMockRemoteFs("actual_resolved");
		const entries = ["a.md", "b.md"].map((path, index) => {
			const local = addFile(localFs, path, `local-${path}`, 2000 + index);
			const remote = addFile(remoteFs, path, `remote-${path}`, 3000 + index);
			local.hash = "";
			remote.hash = "";
			remote.remoteChecksum = undefined;
			return { path, local, remote, prevSync: baseline(path) };
		});
		const changeSet: ChangeSet = {
			entries, observations: [], identityEvidence: [], temperature: "warm", candidateFacts: [],
		};
		const localRead = vi.spyOn(localFs, "read");
		const remoteRead = vi.spyOn(remoteFs, "read");

		await prepareSyncCycleSnapshotForExecution(
			changeSet, "backend\0root", { ignorePatterns: [] }, "prefer_local", localFs, remoteFs,
		);

		expect(localRead).toHaveBeenCalledTimes(entries.length);
		expect(remoteRead).toHaveBeenCalledTimes(entries.length);
	});

	it("captures immutable facts without constructing an action plan", () => {
		const entries: MixedEntity[] = [{
			path: "renamed.md",
			local: {
				path: "renamed.md", size: 7, mtime: 2, hash: "new-hash", isDirectory: false,
			},
		}];
		const scope: ScopeProjection = {
			isConfiguredScopeCompatible: () => true, byEndpoint: new Map([["renamed.md", "included"]]),
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
			temperature: "cold", candidateFacts: [],
		};
		const { snapshot } = prepareSyncCycleSnapshot(
			changeSet, "backend\0root", { ignorePatterns: [] },
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
					local: { path: "new.md", size: 4, mtime: 2, hash: "new", isDirectory: false, pathAuthority: "actual_resolved" },
				},
				{ path: "desktop.ini", prevSync: excludedRecord },
			],
			observations: [
				{ kind: "absent", side: "local", requestedPath: "old.md", authority: "stat" },
				{
					kind: "exact", side: "local", requestedPath: "new.md",
					entity: { path: "new.md", size: 4, mtime: 2, hash: "new", isDirectory: false, pathAuthority: "actual_resolved" },
				},
				{
					kind: "absent", side: "local", requestedPath: "desktop.ini", authority: "stat",
				},
			],
			identityEvidence: [{
				kind: "rename", side: "local", oldPath: "old.md", newPath: "new.md",
				isFolder: false, authority: "reported",
			}],
			temperature: "hot", candidateFacts: [],
		};

		const { snapshot } = prepareSyncCycleSnapshot(changeSet, "backend\0root", {
			ignorePatterns: ["**", "!old.md"],
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
					remote: { path: "old.md", size: 4, mtime: 1, hash: "base", isDirectory: false, pathAuthority: "actual_resolved" },
				},
				{
					path: "new.md",
					local: { path: "new.md", size: 4, mtime: 2, hash: "new", isDirectory: false, pathAuthority: "actual_resolved" },
				},
			],
			observations: [
				{ kind: "absent", side: "local", requestedPath: "old.md", authority: "stat" },
				{
					kind: "exact", side: "remote", requestedPath: "old.md",
					entity: { path: "old.md", size: 4, mtime: 1, hash: "base", isDirectory: false, pathAuthority: "actual_resolved" },
				},
				{
					kind: "exact", side: "local", requestedPath: "new.md",
					entity: { path: "new.md", size: 4, mtime: 2, hash: "new", isDirectory: false, pathAuthority: "actual_resolved" },
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
					remote: { path: "old.md", size: 4, mtime: 1, hash: "base", isDirectory: false, pathAuthority: "actual_resolved" },
				},
				{
					path: "new.md",
					local: { path: "new.md", size: 4, mtime: 2, hash: "new", isDirectory: false, pathAuthority: "actual_resolved" },
				},
			],
			observations: [
				{
					kind: "exact", side: "remote", requestedPath: "old.md",
					entity: { path: "old.md", size: 4, mtime: 1, hash: "base", isDirectory: false, pathAuthority: "actual_resolved" },
				},
				{
					kind: "exact", side: "local", requestedPath: "new.md",
					entity: { path: "new.md", size: 4, mtime: 2, hash: "new", isDirectory: false, pathAuthority: "actual_resolved" },
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
			temperature: "hot", candidateFacts: [],
		};
		const { snapshot } = prepareSyncCycleSnapshot(changeSet, "backend\0root", {
			reservedPaths: [excludedPath],
		});

		const admission = admitBatchObservation(snapshot);

		expect(snapshot.evidence).toEqual([]);
		expect(admission.failures).toEqual([]);
		expect(admission.executable.actions).toEqual([
			expect.objectContaining(expectedAction),
		]);
	});

});
