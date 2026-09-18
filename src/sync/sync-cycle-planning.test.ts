import { describe, expect, it, vi } from "vitest";
import {
	captureBatchObservation,
	prepareSyncCycleSnapshot,
	prepareSyncCycleSnapshotForExecution,
	type BatchObservation,
} from "./sync-cycle-planning";
import { logChangeDetection } from "./sync-cycle-diagnostics";
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
		localSize: 4, remoteSize: 4, remoteIdentityKey: `id:${path}`, syncedAt: 1,
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
			action: "conflict", protocol: { kind: "same_path" }, conflictPolicy: { mode: "local_win", strategy: "prefer_local" },
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
			action: "conflict", protocol: { kind: "same_path" }, conflictPolicy: { mode: "local_win", strategy: "prefer_local" },
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
			action: "conflict", protocol: { kind: "same_path" }, conflictPolicy: { mode: "preserve", strategy: "prefer_local" },
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

	it("does not read a Prefer-local candidate whose remote identity replaced the baseline", async () => {
		const localFs = createMockLocalFs();
		const remoteFs = createMockRemoteFs("actual_resolved");
		const local = addFile(localFs, "note.md", "local", 2000);
		const remote = addFile(remoteFs, "note.md", "remote", 3000);
		local.hash = "";
		remote.hash = "";
		remote.remoteChecksum = undefined;
		remote.identityKey = "current-remote";
		const changeSet: ChangeSet = {
			entries: [{
				path: "note.md", local, remote,
				prevSync: { ...baseline("note.md"), remoteIdentityKey: "baseline-remote" },
			}],
			observations: [], identityEvidence: [], temperature: "warm", candidateFacts: [],
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

	it("retains scoped baseline paths when a large entry is deferred on mobile", () => {
		const smallRecord = baseline("small.md");
		const largeRecord = baseline("large.md");
		const changeSet: ChangeSet = {
			entries: [
				{
					path: "small.md", prevSync: smallRecord,
					local: { path: "small.md", size: 4, mtime: 2, hash: "small", isDirectory: false },
				},
				{
					path: "large.md", prevSync: largeRecord,
					local: { path: "large.md", size: 20, mtime: 2, hash: "large", isDirectory: false },
				},
			],
			observations: [], identityEvidence: [], temperature: "warm", candidateFacts: [],
		};

		const { snapshot } = prepareSyncCycleSnapshot(
			changeSet, "backend\0root", { ignorePatterns: [], mobileMaxBytes: 10 },
		);

		expect(snapshot.entries.map((entry) => entry.path)).toEqual(["small.md"]);
		expect([...snapshot.baselinePaths]).toEqual(["small.md", "large.md"]);
	});

	it("logs each excluded path with why it was dropped, distinguishing applyScope's own exclusion from an unresolved scope disposition", () => {
		const logger = { enabled: () => true, debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), flush: vi.fn() };
		const largeRecord = baseline("large.md");
		const changeSet: ChangeSet = {
			entries: [
				{
					path: "large.md", prevSync: largeRecord,
					local: { path: "large.md", size: 20, mtime: 2, hash: "large", isDirectory: false },
				},
				{
					path: "ignored.md",
					local: { path: "ignored.md", size: 4, mtime: 2, hash: "ignored", isDirectory: false },
				},
			],
			observations: [], identityEvidence: [], temperature: "warm", candidateFacts: [],
		};

		prepareSyncCycleSnapshot(
			changeSet, "backend\0root",
			{ ignorePatterns: ["ignored.md"], mobileMaxBytes: 10 },
			logger as never,
		);

		const call = logger.debug.mock.calls.find((call) => call[0] === "Excluded paths");
		expect(call?.[1]).toEqual({
			paths: [
				{ path: "large.md", reason: "disposition:mobile_deferred" },
				{ path: "ignored.md", reason: "excluded_from_scope" },
			],
		});
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

describe("logChangeDetection — unresolved observations", () => {
	function makeChangeSet(observations: ChangeSet["observations"]): ChangeSet {
		return { entries: [], observations, identityEvidence: [], temperature: "cold", candidateFacts: [] };
	}

	it("logs an alias/present_unresolved remote observation -- the object the provider returned but that never became a fact", () => {
		const logger = { enabled: () => true, debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), flush: vi.fn() };
		const changeSet = makeChangeSet([
			{
				kind: "present_unresolved", side: "remote", requestedPath: "orphan.md",
				returnedPath: "orphan.md", source: "list",
				entity: { path: "orphan.md", size: 1, mtime: 0, hash: "", isDirectory: false, pathAuthority: "requested_echo" },
			},
			{
				kind: "alias", side: "remote", requestedPath: "Case.md", resolvedPath: "case.md",
				entity: { path: "case.md", size: 1, mtime: 0, hash: "", isDirectory: false, pathAuthority: "actual_resolved" },
			},
		]);

		logChangeDetection(changeSet, new Map(), logger as never);

		const call = logger.debug.mock.calls.find((call) => call[0] === "Unresolved observations");
		expect(call?.[1]).toEqual({
			items: [
				{
					side: "remote", kind: "present_unresolved", requestedPath: "orphan.md",
					returnedPath: "orphan.md", source: "list", pathAuthority: "requested_echo",
				},
				{ side: "remote", kind: "alias", requestedPath: "Case.md", resolvedPath: "case.md" },
			],
		});
	});

	it("does not log when every observation resolved exactly", () => {
		const logger = { enabled: () => true, debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), flush: vi.fn() };
		const changeSet = makeChangeSet([
			{
				kind: "exact", side: "remote", requestedPath: "note.md",
				entity: { path: "note.md", size: 1, mtime: 0, hash: "", isDirectory: false, pathAuthority: "actual_resolved" },
			},
			{ kind: "absent", side: "local", requestedPath: "gone.md", authority: "stat" },
		]);

		logChangeDetection(changeSet, new Map(), logger as never);

		expect(logger.debug.mock.calls.some((call) => call[0] === "Unresolved observations")).toBe(false);
	});

	it("does not touch the observations when debug is off, so the payload costs nothing", () => {
		const logger = { enabled: () => false, debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), flush: vi.fn() };
		const changeSet = makeChangeSet([
			{
				kind: "alias", side: "remote", requestedPath: "Case.md", resolvedPath: "case.md",
				entity: { path: "case.md", size: 1, mtime: 0, hash: "", isDirectory: false, pathAuthority: "actual_resolved" },
			},
		]);
		// The point of the guard is that the work is skipped, not just the write —
		// so watch the collection itself rather than asserting on the logger. A
		// diagnostic that still filters and maps every observation on a cold
		// reconcile is what this is meant to prevent.
		const filter = vi.spyOn(changeSet.observations, "filter");

		logChangeDetection(changeSet, new Map(), logger as never);

		expect(filter).not.toHaveBeenCalled();
		expect(logger.debug).not.toHaveBeenCalled();
	});
});
