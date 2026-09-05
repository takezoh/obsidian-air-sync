import { describe, expect, it, vi } from "vitest";
import { addFile, confirmMockPath, createMockLocalFs, createMockRemoteFs, createMockStateStore, readText } from "../__mocks__/sync-test-helpers";
import { admitBatchObservation } from "./plan-admission";
import { captureBatchObservation } from "./sync-cycle-planning";
import { executePlan, type ExecutionContext } from "./plan-executor";
import { buildSyncRecord } from "./state-committer";
import { digest } from "../utils/hash";
import type { MixedEntity, PathObservation } from "./types";

/** Observe through filesystem/store interfaces; no caller-supplied action fixture. */
async function renamedFixture(side: "local" | "remote" = "remote") {
	const localFs = createMockLocalFs();
	const remoteFs = createMockRemoteFs();
	const stateStore = createMockStateStore();
	if (side === "remote") {
		addFile(localFs, "A.md", "original", 1000);
		addFile(remoteFs, "B.md", "remote edit", 2000).identityKey = "R";
	} else {
		addFile(localFs, "B.md", "local edit", 2000);
		addFile(remoteFs, "A.md", "original", 1000).identityKey = "R";
	}
	const original = (await (side === "remote" ? localFs : remoteFs).stat("A.md"))!;
	const baseline = buildSyncRecord(original, { ...original, identityKey: "R" }, "A.md");
	await stateStore.put(baseline);
	const observe = async () => {
		const entries: MixedEntity[] = [];
		const observations: PathObservation[] = [];
		for (const path of ["A.md", "B.md"]) {
			const local = await localFs.stat(path) ?? undefined;
			const remote = await remoteFs.stat(path) ?? undefined;
			entries.push({ path, local, remote, prevSync: await stateStore.get(path) });
			for (const [side, entity] of [["local", local], ["remote", remote]] as const) {
				observations.push(entity
					? { kind: "exact", side, requestedPath: path, entity }
					: { kind: "absent", side, requestedPath: path, authority: "stat" });
			}
		}
		return admitBatchObservation(captureBatchObservation(entries, [{
			kind: "rename", side, oldPath: "A.md", newPath: "B.md",
			isFolder: false, identityKey: "R", authority: "reported",
		}], observations, {
			byEndpoint: new Map([["A.md", "included"], ["B.md", "included"]]),
			isConfiguredScopeCompatible: () => true,
		}, "test:root"));
	};
	const execute = async (overrides: Partial<ExecutionContext> = {}) => {
		const admission = await observe();
		expect(admission.failures).toEqual([]);
		return executePlan(admission.executable, {
			localFs, remoteFs, committer: { stateStore }, conflictStrategy: "duplicate",
			...overrides,
		});
	};
	return { localFs, remoteFs, stateStore, baseline, observe, execute };
}

describe("fact-first Admission through terminal publication", () => {
	it("does not delete a remote destination that appears during conflict preservation", async () => {
		const fixture = await renamedFixture("local");
		addFile(fixture.remoteFs, "A.md", "remote edit", 3000).identityKey = "R";
		confirmMockPath(fixture.remoteFs, "A.md");
		const write = fixture.remoteFs.write.bind(fixture.remoteFs);
		fixture.remoteFs.write = async (path, content, mtime) => {
			const written = await write(path, content, mtime);
			confirmMockPath(fixture.remoteFs, path);
			if (path.includes(".conflict")) addFile(fixture.remoteFs, "B.md", "arrived", 4000).identityKey = "Y";
			return written;
		};
		const remove = vi.spyOn(fixture.remoteFs, "delete");
		const result = await fixture.execute();
		expect(result.succeeded).toEqual([]);
		expect(result.blocked).toHaveLength(1);
		expect(remove).not.toHaveBeenCalled();
		expect(readText(fixture.remoteFs, "B.md")).toBe("arrived");
		expect(readText(fixture.remoteFs, "A.md")).toBe("remote edit");
		expect(await fixture.stateStore.get("B.md")).toBeUndefined();
	});

	it.each(["source_during_preservation", "copy_during_target_write"] as const)("does not publish an ordinary conflict after %s", async (cut) => {
		const localFs = createMockLocalFs();
		const remoteFs = createMockRemoteFs("actual_resolved");
		const stateStore = createMockStateStore();
		addFile(localFs, "f.md", "local", 1000);
		addFile(remoteFs, "f.md", "remote", 1000).identityKey = "X";
		const admission = admitBatchObservation(captureBatchObservation([{
			path: "f.md", local: (await localFs.stat("f.md"))!, remote: (await remoteFs.stat("f.md"))!,
		}], [], [], { byEndpoint: new Map([["f.md", "included"]]), isConfiguredScopeCompatible: () => true }, "test:root"));
		const write = remoteFs.write.bind(remoteFs);
		remoteFs.write = async (path, content, mtime) => {
			const result = await write(path, content, mtime);
			if (cut === "source_during_preservation" && path.includes(".conflict")) addFile(remoteFs, "f.md", "new edit", 2000).identityKey = "X";
			if (cut === "copy_during_target_write" && path === "f.md") addFile(remoteFs, "f.conflict.md", "broken", 1000);
			return result;
		};
		const result = await executePlan(admission.executable, { localFs, remoteFs, committer: { stateStore }, conflictStrategy: "duplicate" });
		expect(result.succeeded).toEqual([]);
		expect(result.blocked).toHaveLength(1);
		expect(stateStore.records.size).toBe(0);
		if (cut === "source_during_preservation") {
			expect(readText(remoteFs, "f.md")).toBe("new edit");
			expect(readText(localFs, "f.md")).toBe("local");
		}
	});

	it.each(["duplicate", "auto_merge"] as const)("re-observes an interrupted ordinary %s without rollback or recovery state", async (conflictStrategy) => {
		const localFs = createMockLocalFs();
		const remoteFs = createMockRemoteFs("actual_resolved");
		const stateStore = createMockStateStore();
		const base = "one\ntwo\nthree\nfour\nfive\n";
		addFile(localFs, "f.md", base, 1000);
		addFile(remoteFs, "f.md", base, 1000).identityKey = "X";
		const baseline = buildSyncRecord((await localFs.stat("f.md"))!, (await remoteFs.stat("f.md"))!, "f.md");
		await stateStore.put(baseline);
		stateStore.contents.set("f.md", new TextEncoder().encode(base).buffer);
		addFile(localFs, "f.md", "one\nLOCAL\nthree\nfour\nfive\n", 2000);
		addFile(remoteFs, "f.md", "one\ntwo\nthree\nfour\nREMOTE\n", 2000).identityKey = "X";
		const observe = async () => admitBatchObservation(captureBatchObservation([{
			path: "f.md", local: (await localFs.stat("f.md"))!, remote: (await remoteFs.stat("f.md"))!, prevSync: await stateStore.get("f.md"),
		}], [], [], { byEndpoint: new Map([["f.md", "included"]]), isConfiguredScopeCompatible: () => true }, "test:root"));
		const write = remoteFs.write.bind(remoteFs);
		remoteFs.write = async (path, content, mtime) => {
			if (path === "f.md") throw new Error("target write interrupted");
			return write(path, content, mtime);
		};
		const context = { localFs, remoteFs, committer: { stateStore }, conflictStrategy };
		const first = await executePlan((await observe()).executable, context);
		expect(first.failed).toHaveLength(1);
		expect(first.succeeded).toEqual([]);
		expect(await stateStore.get("f.md")).toEqual(baseline);
		if (conflictStrategy === "auto_merge") {
			expect(readText(localFs, "f.md")).toContain("REMOTE");
			expect(readText(localFs, "f.md")).toContain("LOCAL");
			expect(await remoteFs.stat("f.conflict.md")).toBeNull();
		}
		remoteFs.write = write;
		const replay = await executePlan((await observe()).executable, context);
		expect(replay.failed).toEqual([]);
		expect(replay.blocked).toEqual([]);
		expect(readText(remoteFs, "f.md")).toBe(readText(localFs, "f.md"));
		expect((await observe()).executable.actions).toEqual([]);
		if (conflictStrategy === "duplicate") expect(readText(remoteFs, "f.conflict.md")).toContain("REMOTE");
	});

	it("does not settle a local rename from an unrelated destination record", async () => {
		const localFs = createMockLocalFs();
		const remoteFs = createMockRemoteFs("actual_resolved");
		const stateStore = createMockStateStore();
		addFile(localFs, "B.md", "x", 1000);
		addFile(remoteFs, "B.md", "x", 1000).identityKey = "Y";
		addFile(remoteFs, "A.md", "x", 1000).identityKey = "X";
		const local = (await localFs.stat("B.md"))!;
		const remote = (await remoteFs.stat("B.md"))!;
		const prevSync = buildSyncRecord(local, remote, "B.md");
		await stateStore.put(prevSync);
		const admission = admitBatchObservation(captureBatchObservation([
			{ path: "A.md", remote: (await remoteFs.stat("A.md"))! }, { path: "B.md", local, remote, prevSync },
		], [{ kind: "rename", side: "local", oldPath: "A.md", newPath: "B.md", isFolder: false, authority: "reported" }],
		[{ kind: "absent", side: "local", requestedPath: "A.md", authority: "stat" }],
		{ byEndpoint: new Map([["A.md", "included"], ["B.md", "included"]]), isConfiguredScopeCompatible: () => true }, "test:root"));
		expect(admission.failures).toEqual([]);
		expect(admission.executable.actions.map(({ path, action }) => [path, action])).toEqual([["B.md", "conflict"]]);
		const result = await executePlan(admission.executable, { localFs, remoteFs, committer: { stateStore }, conflictStrategy: "duplicate" });
		expect(result.failed).toEqual([]);
		expect(result.blocked).toEqual([]);
		expect((await remoteFs.stat("B.md"))?.identityKey).toBe("X");
		expect(await localFs.stat("A.md")).toBeNull();
		expect(await remoteFs.stat("A.md")).toBeNull();
	});

	it("blocks ordinary conflict before overwriting originals when a preservation write lies", async () => {
		const localFs = createMockLocalFs();
		const remoteFs = createMockRemoteFs("actual_resolved");
		const stateStore = createMockStateStore();
		addFile(localFs, "f.md", "local", 1000);
		addFile(remoteFs, "f.md", "remote", 1000).identityKey = "X";
		const local = (await localFs.stat("f.md"))!;
		const remote = (await remoteFs.stat("f.md"))!;
		const write = remoteFs.write.bind(remoteFs);
		remoteFs.write = async (path, content, mtime) => write(path,
			path.includes(".conflict") ? new TextEncoder().encode("broken").buffer : content, mtime);
		const admission = admitBatchObservation(captureBatchObservation([{ path: "f.md", local, remote }], [], [],
			{ byEndpoint: new Map([["f.md", "included"]]), isConfiguredScopeCompatible: () => true }, "test:root"));
		const result = await executePlan(admission.executable, { localFs, remoteFs, committer: { stateStore }, conflictStrategy: "duplicate" });
		expect(result.succeeded).toEqual([]);
		expect(result.blocked).toHaveLength(1);
		expect(readText(localFs, "f.md")).toBe("local");
		expect(readText(remoteFs, "f.md")).toBe("remote");
		expect(stateStore.records.size).toBe(0);
	});

	it("rejects a checksum-less source whose available version changes during capture", async () => {
		const localFs = createMockLocalFs();
		const remoteFs = createMockRemoteFs("actual_resolved");
		const stateStore = createMockStateStore();
		addFile(remoteFs, "f.md", "x", 1000).identityKey = "X";
		const stat = remoteFs.stat.bind(remoteFs);
		remoteFs.stat = async (path) => {
			const entity = await stat(path);
			return entity ? { ...entity, hash: "", remoteChecksum: undefined } : null;
		};
		const remote = (await remoteFs.stat("f.md"))!;
		const read = remoteFs.read.bind(remoteFs);
		vi.spyOn(remoteFs, "read").mockImplementation(async (path) => {
			addFile(remoteFs, "f.md", "y", 2000).identityKey = "X";
			return read(path);
		});
		const write = vi.spyOn(localFs, "write");
		const admission = admitBatchObservation(captureBatchObservation([{ path: "f.md", remote }], [], [
			{ kind: "absent", side: "local", requestedPath: "f.md", authority: "stat" },
		], { byEndpoint: new Map([["f.md", "included"]]), isConfiguredScopeCompatible: () => true }, "test:root"));
		const result = await executePlan(admission.executable, { localFs, remoteFs, committer: { stateStore }, conflictStrategy: "duplicate" });
		expect(result.succeeded).toEqual([]);
		expect(result.blocked).toHaveLength(1);
		expect(write).not.toHaveBeenCalled();
		expect(stateStore.records.size).toBe(0);
	});

	it("reuses conflict snapshots when authoritative stored checksums prove all outputs", async () => {
		const fixture = await renamedFixture("remote");
		addFile(fixture.localFs, "A.md", "local edit", 2000);
		confirmMockPath(fixture.remoteFs, "B.md");
		const write = fixture.remoteFs.write.bind(fixture.remoteFs);
		fixture.remoteFs.write = async (path, content, mtime) => {
			const written = await write(path, content, mtime);
			confirmMockPath(fixture.remoteFs, path);
			return written;
		};
		const localRead = vi.spyOn(fixture.localFs, "read");
		const remoteRead = vi.spyOn(fixture.remoteFs, "read");
		const result = await fixture.execute();
		expect(result.failed).toEqual([]);
		expect(result.blocked).toEqual([]);
		expect(result.succeeded).toHaveLength(1);
		expect(result.succeeded[0]?.action.action).toBe("conflict");
		expect(localRead.mock.calls).toEqual([["A.md"]]);
		expect(remoteRead.mock.calls).toEqual([["B.md"]]);
		expect(readText(fixture.remoteFs, "B.md")).toBe("local edit");
		expect(readText(fixture.remoteFs, "B.conflict.md")).toBe("remote edit");
	});

	it.each([
		[true, "equal", "none"], [true, "equal", "publication"], [true, "equal", "suffix"],
		[true, "conflict", "none"], [true, "conflict", "publication"], [true, "conflict", "suffix"],
		[false, "equal", "none"], [false, "equal", "suffix"],
		[false, "conflict", "none"], [false, "conflict", "suffix"],
	] as const)("converges a local renamed/recreated source (baseline=%s, target=%s, cut=%s)", async (withBaseline, target, cut) => {
		const localFs = createMockLocalFs();
		const remoteFs = createMockRemoteFs("actual_resolved");
		const stateStore = createMockStateStore();
		addFile(localFs, "B.md", "old", 1000);
		addFile(remoteFs, "A.md", "old", 1000).identityKey = "X";
		if (withBaseline) await stateStore.put(buildSyncRecord((await localFs.stat("B.md"))!, (await remoteFs.stat("A.md"))!, "A.md"));
		if (target === "conflict") {
			addFile(localFs, "B.md", "local edit", 2000);
			addFile(remoteFs, "A.md", "remote edit", 3000).identityKey = "X";
		}
		addFile(localFs, "A.md", "recreated", 4000);
		const observe = async () => {
			const entries: MixedEntity[] = [];
			const observations: PathObservation[] = [];
			for (const path of ["A.md", "B.md"]) {
				const local = await localFs.stat(path) ?? undefined;
				const remote = await remoteFs.stat(path) ?? undefined;
				entries.push({ path, local, remote, prevSync: await stateStore.get(path) });
				for (const [side, entity] of [["local", local], ["remote", remote]] as const) observations.push(entity
					? { kind: "exact", side, requestedPath: path, entity }
					: { kind: "absent", side, requestedPath: path, authority: "stat" });
			}
			return admitBatchObservation(captureBatchObservation(entries, [{ kind: "rename", side: "local",
				oldPath: "A.md", newPath: "B.md", isFolder: false, authority: "reported" }], observations,
			{ byEndpoint: new Map([["A.md", "included"], ["B.md", "included"]]), isConfiguredScopeCompatible: () => true }, "test:root"));
		};
		const admission = await observe();
		expect(admission.failures).toEqual([]);
		expect(admission.executable.actions.map(({ path, action }) => [path, action])).toEqual([
			["B.md", target === "equal" ? "rename_remote" : "conflict"], ["A.md", "push"],
		]);
		const context = { localFs, remoteFs, committer: { stateStore }, conflictStrategy: "duplicate" as const };
		const publish = vi.spyOn(stateStore, "compareAndMove");
		if (cut === "publication") publish.mockResolvedValueOnce(false);
		const write = remoteFs.write.bind(remoteFs);
		remoteFs.write = async (path, content, mtime) => {
			if (path === "A.md") {
				expect(await stateStore.get("B.md")).toMatchObject({ remoteIdentityKey: "X" });
				expect(await stateStore.get("A.md")).toBeUndefined();
				if (cut === "suffix") throw new Error("source upload interrupted");
			}
			return write(path, content, mtime);
		};
		const first = await executePlan(admission.executable, context);
		expect(first.failed).toHaveLength(cut === "none" ? 0 : 1);
		expect(first.blocked).toHaveLength(cut === "publication" ? 1 : 0);
		remoteFs.write = write;
		publish.mockRestore();
		const next = await observe();
		expect(next.failures).toEqual([]);
		const replay = await executePlan(next.executable, context);
		expect(replay.failed).toEqual([]);
		expect(replay.blocked).toEqual([]);
		expect(readText(remoteFs, "A.md")).toBe("recreated");
		expect(readText(remoteFs, "B.md")).toBe(target === "equal" ? "old" : "local edit");
		expect((await remoteFs.stat("B.md"))?.identityKey).toBe("X");
		if (target === "conflict") expect(readText(remoteFs, "B.conflict.md")).toBe("remote edit");
		expect((await observe()).failures).toEqual([]);
		expect((await observe()).executable.actions).toEqual([]);
	});

	it.each([
		["missing", 1000], ["missing", 0], ["opaque", 1000], ["opaque", 0],
	] as const)("pulls stable %s-checksum content with mtime %s", async (checksum, mtime) => {
		const localFs = createMockLocalFs();
		const remoteFs = createMockRemoteFs("actual_resolved");
		const stateStore = createMockStateStore();
		addFile(remoteFs, "f.md", "x", mtime).identityKey = "X";
		const stat = remoteFs.stat.bind(remoteFs);
		remoteFs.stat = async (path) => {
			const entity = await stat(path);
			return entity ? { ...entity, hash: "", remoteChecksum: checksum === "opaque"
				? { algo: "opaque", value: "stable" } : undefined } : null;
		};
		const remote = (await remoteFs.stat("f.md"))!;
		const read = vi.spyOn(remoteFs, "read");
		const admission = admitBatchObservation(captureBatchObservation([{ path: "f.md", remote }], [], [
			{ kind: "absent", side: "local", requestedPath: "f.md", authority: "stat" },
			{ kind: "exact", side: "remote", requestedPath: "f.md", entity: remote },
		], { byEndpoint: new Map([["f.md", "included"]]), isConfiguredScopeCompatible: () => true }, "test:root"));
		expect(admission.failures).toEqual([]);
		expect(admission.executable.actions.map(({ action }) => action)).toEqual(["pull"]);
		const result = await executePlan(admission.executable, { localFs, remoteFs, committer: { stateStore }, conflictStrategy: "duplicate" });
		expect(result.failed).toEqual([]);
		expect(result.blocked).toEqual([]);
		expect(result.succeeded).toHaveLength(1);
		expect(readText(localFs, "f.md")).toBe("x");
		expect(await stateStore.get("f.md")).toMatchObject({ remoteIdentityKey: "X", localSize: 1, remoteSize: 1 });
		// One stable capture, or two when both comparable key and mtime are absent;
		// plus one affected-source terminal read because no checksum proves bytes.
		expect(read).toHaveBeenCalledTimes(checksum === "missing" && mtime === 0 ? 3 : 2);
	});

	it.each(["local", "remote"] as const)("does not publish a same-path conflict after the %s terminal endpoint disappears", async (side) => {
		const localFs = createMockLocalFs();
		const remoteFs = createMockRemoteFs("actual_resolved");
		const stateStore = createMockStateStore();
		addFile(localFs, "f.md", "local", 1000);
		addFile(remoteFs, "f.md", "remote", 2000).identityKey = "R";
		const local = (await localFs.stat("f.md"))!;
		const remote = (await remoteFs.stat("f.md"))!;
		const admission = admitBatchObservation(captureBatchObservation([{ path: "f.md", local, remote }], [], [],
			{ byEndpoint: new Map([["f.md", "included"]]), isConfiguredScopeCompatible: () => true }, "test:root"));
		expect(admission.failures).toEqual([]);
		expect(admission.executable.actions.map(({ action }) => action)).toEqual(["conflict"]);
		const write = remoteFs.write.bind(remoteFs);
		remoteFs.write = async (path, content, mtime) => {
			const result = await write(path, content, mtime);
			if (path === "f.md") await (side === "local" ? localFs : remoteFs).delete(path);
			return result;
		};
		const result = await executePlan(admission.executable, { localFs, remoteFs, committer: { stateStore }, conflictStrategy: "duplicate" });
		expect(result.succeeded).toEqual([]);
		expect(result.blocked).toHaveLength(1);
		expect(await stateStore.get("f.md")).toBeUndefined();
		expect(readText(localFs, "f.conflict.md")).toBe("remote");
		expect(readText(remoteFs, "f.conflict.md")).toBe("remote");
	});

	it.each(["none", "move", "publication"] as const)("converges across local adapter boundaries after %s interruption", async (cut) => {
		const localFs = createMockLocalFs();
		const remoteFs = createMockRemoteFs("actual_resolved");
		const stateStore = createMockStateStore();
		for (const name of ["x", "y"]) {
			addFile(localFs, `.A/${name}.md`, name, 1000);
			addFile(remoteFs, `B/${name}.md`, name, 1000).identityKey = name;
			await stateStore.put(buildSyncRecord((await localFs.stat(`.A/${name}.md`))!,
				(await remoteFs.stat(`B/${name}.md`))!, `.A/${name}.md`));
		}
		const paths = [".A", "B", ".A/x.md", ".A/y.md", "B/x.md", "B/y.md"];
		const observe = async () => {
			const entries: MixedEntity[] = [];
			const observations: PathObservation[] = [];
			for (const path of paths) {
				const local = await localFs.stat(path) ?? undefined;
				const remote = await remoteFs.stat(path) ?? undefined;
				entries.push({ path, local, remote, prevSync: await stateStore.get(path) });
				for (const [side, entity] of [["local", local], ["remote", remote]] as const) observations.push(entity
					? { kind: "exact", side, requestedPath: path, entity }
					: { kind: "absent", side, requestedPath: path, authority: "stat" });
			}
			return admitBatchObservation(captureBatchObservation(entries, [{ kind: "rename", side: "remote",
				oldPath: ".A", newPath: "B", isFolder: true, authority: "reported" }], observations,
			{ byEndpoint: new Map(paths.map((path) => [path, "included"])), isConfiguredScopeCompatible: () => true }, "test:root"));
		};
		const rename = localFs.rename.bind(localFs);
		const moves = vi.spyOn(localFs, "rename").mockImplementation(async (from, to) => {
			// LocalFs cannot rename a directory across its vault/raw-adapter boundary.
			if ((await localFs.stat(from))?.isDirectory) throw new Error("unsupported directory move");
			if (cut === "move" && from === ".A/y.md") throw new Error("interrupted move");
			await rename(from, to);
		});
		const compareAndMove = stateStore.compareAndMove.bind(stateStore);
		const publication = vi.spyOn(stateStore, "compareAndMove");
		if (cut === "publication") publication.mockImplementationOnce(compareAndMove).mockResolvedValueOnce(false);
		const first = await observe();
		expect(first.failures).toEqual([]);
		expect(first.executable.actions.map(({ action, path }) => [action, path])).toEqual([
			["rename_local", "B/x.md"], ["rename_local", "B/y.md"],
		]);
		const context = { localFs, remoteFs, committer: { stateStore }, conflictStrategy: "duplicate" as const };
		const result = await executePlan(first.executable, context);
		expect(result.blocked).toEqual([]);
		expect(result.failed).toHaveLength(cut === "none" ? 0 : 1);
		expect(await stateStore.get(".A/x.md")).toBeUndefined();
		expect(await stateStore.get("B/x.md")).toMatchObject({ remoteIdentityKey: "x" });
		moves.mockImplementation(rename);
		publication.mockImplementation(compareAndMove);
		const next = await observe();
		expect(next.failures).toEqual([]);
		expect(next.executable.actions.map(({ action }) => action)).toEqual(
			cut === "none" ? [] : [cut === "move" ? "rename_local" : "match"]);
		const replay = await executePlan(next.executable, context);
		expect(replay.failed).toEqual([]);
		expect(replay.blocked).toEqual([]);
		for (const name of ["x", "y"]) {
			expect(readText(localFs, `B/${name}.md`)).toBe(name);
			expect(await stateStore.get(`.A/${name}.md`)).toBeUndefined();
			expect(await stateStore.get(`B/${name}.md`)).toMatchObject({ remoteIdentityKey: name });
		}
		expect((await observe()).executable.actions).toEqual([]);
	});

	it.each([
		["local", "A/x.md"], ["local", "B/x.md"],
		["remote", "A/x.md"], ["remote", "B/x.md"],
	] as const)("deletes the current %s-move child before its parent with baseline at %s", async (side, recordPath) => {
		const localFs = createMockLocalFs();
		const remoteFs = createMockRemoteFs("actual_resolved");
		const stateStore = createMockStateStore();
		await localFs.mkdir(side === "local" ? "B" : "A");
		await remoteFs.mkdir(side === "local" ? "A" : "B");
		const surviving = side === "local" ? remoteFs : localFs;
		addFile(surviving, "A/x.md", "original", 1000).identityKey = side === "local" ? "R" : undefined;
		const original = (await surviving.stat("A/x.md"))!;
		await stateStore.put(buildSyncRecord(original, { ...original, identityKey: "R" }, recordPath));
		const paths = ["A", "B", "A/x.md", "B/x.md"];
		const entries: MixedEntity[] = [];
		const observations: PathObservation[] = [];
		for (const path of paths) {
			const local = await localFs.stat(path) ?? undefined;
			const remote = await remoteFs.stat(path) ?? undefined;
			entries.push({ path, local, remote, prevSync: await stateStore.get(path) });
			for (const [endpointSide, entity] of [["local", local], ["remote", remote]] as const) observations.push(entity
				? { kind: "exact", side: endpointSide, requestedPath: path, entity }
				: { kind: "absent", side: endpointSide, requestedPath: path,
					authority: endpointSide === "remote" && path === "B/x.md" ? "checkpoint_deleted" : "stat" });
		}
		const admission = admitBatchObservation(captureBatchObservation(entries, [{
			kind: "rename", side, oldPath: "A", newPath: "B", isFolder: true, authority: "reported",
		}], observations, { byEndpoint: new Map(paths.map((path) => [path, "included"])),
			isConfiguredScopeCompatible: () => true }, "test:root"));
		expect(admission.failures).toEqual([]);
		expect(admission.executable.actions.map(({ action }) => action)).toEqual([
			side === "local" ? "delete_remote" : "delete_local", side === "local" ? "rename_remote" : "rename_local",
		]);
		const result = await executePlan(admission.executable, { localFs, remoteFs, committer: { stateStore }, conflictStrategy: "duplicate" });
		expect(result.failed).toEqual([]);
		expect(result.blocked).toEqual([]);
		expect(result.succeeded).toHaveLength(2);
		expect(await surviving.stat("A/x.md")).toBeNull();
		expect(await surviving.stat("B/x.md")).toBeNull();
		expect(stateStore.records.size).toBe(0);
	});

	it.each(["unchanged", "content", "identity", "deleted", "preserved"] as const)("checks %s descendants before parent publication", async (race) => {
		const localFs = createMockLocalFs();
		const remoteFs = createMockRemoteFs();
		const stateStore = createMockStateStore();
		addFile(localFs, "B/x.md", "original", 1000);
		addFile(remoteFs, "A/x.md", "original", 1000).identityKey = "R";
		const baseline = buildSyncRecord((await localFs.stat("B/x.md"))!, (await remoteFs.stat("A/x.md"))!, "A/x.md");
		await stateStore.put(baseline);
		if (race === "deleted") await localFs.delete("B/x.md");
		if (race === "preserved") {
			addFile(localFs, "B/x.md", "local edit", 2000);
			addFile(remoteFs, "A/x.md", "remote edit", 2000).identityKey = "R";
			const write = remoteFs.write.bind(remoteFs);
			remoteFs.write = async (path, content, mtime) => {
				const result = await write(path, content, mtime);
				confirmMockPath(remoteFs, result.path);
				return result;
			};
		}
		const paths = ["A", "B", "A/x.md", "B/x.md"];
		const observe = async () => {
			const entries: MixedEntity[] = [];
			const observations: PathObservation[] = [];
			for (const path of paths) {
				const local = await localFs.stat(path) ?? undefined;
				const remote = await remoteFs.stat(path) ?? undefined;
				entries.push({ path, local, remote, prevSync: await stateStore.get(path) });
				for (const [side, entity] of [["local", local], ["remote", remote]] as const) {
					observations.push(entity ? { kind: "exact", side, requestedPath: path, entity }
						: { kind: "absent", side, requestedPath: path, authority: "stat" });
				}
			}
			return admitBatchObservation(captureBatchObservation(entries, [{
				kind: "rename", side: "local", oldPath: "A", newPath: "B", isFolder: true, authority: "reported",
			}], observations, { byEndpoint: new Map(paths.map((path) => [path, "included"])),
				isConfiguredScopeCompatible: () => true }, "test:root"));
		};
		const admission = await observe();
		expect(admission.failures).toEqual([]);
		expect(admission.executable.actions.map((action) => action.action)).toEqual([
			...(race === "deleted" ? ["delete_remote"] : race === "preserved" ? ["conflict"] : []), "rename_remote",
		]);
		const localStat = vi.spyOn(localFs, "stat");
		const remoteStat = vi.spyOn(remoteFs, "stat");
		const localRead = vi.spyOn(localFs, "read");
		const remoteRead = vi.spyOn(remoteFs, "read");
		const rename = remoteFs.rename.bind(remoteFs);
		let beforeParentRecord = await stateStore.get("A/x.md");
		remoteFs.rename = async (from, to) => {
			beforeParentRecord = await stateStore.get("A/x.md");
			await rename(from, to);
			if (race === "content") addFile(remoteFs, "B/x.md", "modified", 1000).identityKey = "R";
			if (race === "identity") remoteFs.files.get("B/x.md")!.entity.identityKey = "foreign";
			if (race === "deleted") addFile(remoteFs, "B/x.md", "recreated", 3000).identityKey = "Y";
			if (race === "preserved") {
				expect(remoteFs.files.has("B/x.conflict.md")).toBe(true);
				addFile(remoteFs, "B/x.conflict.md", "tampered", 3000);
			}
		};
		const result = await executePlan(admission.executable, { localFs, remoteFs, committer: { stateStore }, conflictStrategy: "duplicate" });
		expect(result.failed).toEqual([]);
		if (race === "unchanged") {
			expect(result.blocked).toEqual([]);
			expect(localStat.mock.calls.filter(([path]) => path === "B/x.md")).toHaveLength(1);
			expect(remoteStat.mock.calls.filter(([path]) => path === "B/x.md")).toHaveLength(1);
			expect(localRead).not.toHaveBeenCalled();
			expect(remoteRead).not.toHaveBeenCalled();
			expect(await stateStore.get("A/x.md")).toBeUndefined();
			expect(await stateStore.get("B/x.md")).toMatchObject({ remoteIdentityKey: "R" });
		} else {
			expect(result.blocked).toHaveLength(1);
			expect(result.succeeded.some(({ action }) => action.action === "rename_remote")).toBe(false);
			expect(await stateStore.get("A/x.md")).toEqual(beforeParentRecord);
			expect(await stateStore.get("B/x.md")).toBeUndefined();
			if (race === "content") {
				const next = await observe();
				expect(next.failures).toEqual([]);
				expect(next.executable.actions.map((action) => action.action)).toEqual(["pull"]);
				const replay = await executePlan(next.executable, { localFs, remoteFs, committer: { stateStore }, conflictStrategy: "duplicate" });
				expect(replay.failed).toEqual([]);
				expect(replay.blocked).toEqual([]);
				expect(await stateStore.get("A/x.md")).toBeUndefined();
				expect(await stateStore.get("B/x.md")).toMatchObject({ remoteIdentityKey: "R" });
				expect(readText(localFs, "B/x.md")).toBe("modified");
				expect((await observe()).executable.actions).toEqual([]);
			}
		}
	});
	it("proves an unchanged rename through the committed cross-algorithm fingerprints without downloads", async () => {
		const fixture = await renamedFixture();
		addFile(fixture.remoteFs, "B.md", "original", 1000).identityKey = "R";
		const checksum = { algo: "md5" as const, value: await digest(new TextEncoder().encode("original").buffer, "md5") };
		await fixture.stateStore.put({ ...fixture.baseline, remoteChecksum: checksum });
		const stat = fixture.remoteFs.stat.bind(fixture.remoteFs);
		fixture.remoteFs.stat = async (path) => {
			const entity = await stat(path);
			return entity ? { ...entity, hash: "", remoteChecksum: checksum } : null;
		};
		const localRead = vi.spyOn(fixture.localFs, "read");
		const remoteRead = vi.spyOn(fixture.remoteFs, "read");
		const result = await fixture.execute();
		expect(result.failed).toEqual([]);
		expect(result.blocked).toEqual([]);
		expect(result.succeeded).toHaveLength(1);
		expect(result.succeeded[0]?.action).toMatchObject({ action: "rename_local", content: { mode: "equal" } });
		expect(localRead).not.toHaveBeenCalled();
		expect(remoteRead).not.toHaveBeenCalled();
	});
	it("preserves a foreign local destination when auto-merge selects the tracked remote version", async () => {
		const fixture = await renamedFixture();
		addFile(fixture.remoteFs, "B.md", "original", 1000).identityKey = "R";
		addFile(fixture.remoteFs, "A.md", "foreign A", 2000).identityKey = "Y";
		addFile(fixture.localFs, "B.md", "foreign B", 500);
		const write = fixture.remoteFs.write.bind(fixture.remoteFs);
		fixture.remoteFs.write = async (path, content, mtime) => {
			const result = await write(path, content, mtime);
			confirmMockPath(fixture.remoteFs, result.path);
			return result;
		};
		const result = await fixture.execute({ conflictStrategy: "auto_merge" });
		expect(result.failed).toEqual([]);
		expect(result.blocked).toEqual([]);
		expect(readText(fixture.localFs, "B.md")).toBe("original");
		expect(readText(fixture.localFs, "B.conflict-2.md")).toBe("foreign B");
		expect(readText(fixture.remoteFs, "B.conflict-2.md")).toBe("foreign B");
	});
	it.each([
		["pull", "match"], ["pull", "conflict"],
		["match", "match"], ["match", "conflict"],
		["conflict", "match"], ["conflict", "conflict"],
	] as const)("keeps the same %s B → %s A order without an old baseline", async (atB, atA) => {
		const fixture = await renamedFixture();
		await fixture.stateStore.delete("A.md");
		addFile(fixture.remoteFs, "B.md", "original", 1000).identityKey = "R";
		addFile(fixture.remoteFs, "A.md", atA === "match" ? "original" : "foreign A", 2000).identityKey = "Y";
		if (atB !== "pull") addFile(fixture.localFs, "B.md", atB === "match" ? "original" : "foreign B", 2000);
		const admitted = await fixture.observe();
		expect(admitted.failures).toEqual([]);
		expect(admitted.executable.components).toHaveLength(1);
		expect(admitted.executable.actions.map(({ path, action }) => ({ path, action }))).toEqual([
			{ path: "B.md", action: atB }, { path: "A.md", action: atA },
		]);
		for (const action of admitted.executable.actions) {
			expect(action.publication).toEqual({ source: undefined, destination: undefined });
		}
	});
	it.each([
		["pull", "match"], ["pull", "conflict"],
		["match", "match"], ["match", "conflict"],
		["conflict", "match"], ["conflict", "conflict"],
	] as const)("orders recreated-source %s B before %s A", async (atB, atA) => {
		const fixture = await renamedFixture();
		addFile(fixture.remoteFs, "B.md", "original", 1000).identityKey = "R";
		addFile(fixture.remoteFs, "A.md", atA === "match" ? "original" : "foreign A", 2000).identityKey = "Y";
		if (atB !== "pull") addFile(fixture.localFs, "B.md", atB === "match" ? "original" : "foreign B", 2000);
		const admitted = await fixture.observe();
		expect(admitted.failures).toEqual([]);
		expect(admitted.executable.components).toHaveLength(1);
		expect(admitted.executable.actions.map(({ path, action }) => ({ path, action }))).toEqual([
			{ path: "B.md", action: atB }, { path: "A.md", action: atA },
		]);
		expect(admitted.executable.actions[0]?.publication).toEqual({ source: fixture.baseline, destination: undefined });
		expect(admitted.executable.actions[1]?.publication).toEqual({ source: undefined, destination: undefined });
		// This positive case supplies provider confirmation, unlike the echo-only
		// case below. All normal write/readback and publication logic still runs.
		const write = fixture.remoteFs.write.bind(fixture.remoteFs);
		fixture.remoteFs.write = async (path, content, mtime) => {
			const result = await write(path, content, mtime);
			confirmMockPath(fixture.remoteFs, result.path);
			return result;
		};
		const localRename = vi.spyOn(fixture.localFs, "rename");
		const remoteDelete = vi.spyOn(fixture.remoteFs, "delete");
		const result = await fixture.execute();
		expect(result.failed).toEqual([]);
		expect(result.blocked).toEqual([]);
		expect(result.succeeded.map(({ action }) => action.path)).toEqual(["B.md", "A.md"]);
		expect(await fixture.stateStore.get("B.md")).toMatchObject({ remoteIdentityKey: "R" });
		expect(await fixture.stateStore.get("A.md")).toMatchObject({ remoteIdentityKey: "Y" });
		expect(readText(fixture.remoteFs, "B.md")).toBe(atB === "conflict" ? "foreign B" : "original");
		expect(readText(fixture.localFs, "A.md")).toBe("original");
		expect(localRename).not.toHaveBeenCalled();
		expect(remoteDelete).not.toHaveBeenCalled();
	});

	it.each(["pull", "match", "conflict"] as const)("blocks A after %s B loses publication, then converges from current facts", async (atB) => {
		const fixture = await renamedFixture();
		addFile(fixture.remoteFs, "B.md", "original", 1000).identityKey = "R";
		addFile(fixture.remoteFs, "A.md", "foreign A", 2000).identityKey = "Y";
		if (atB !== "pull") addFile(fixture.localFs, "B.md", atB === "match" ? "original" : "foreign B", 2000);
		const write = fixture.remoteFs.write.bind(fixture.remoteFs);
		fixture.remoteFs.write = async (path, content, mtime) => {
			const result = await write(path, content, mtime);
			confirmMockPath(fixture.remoteFs, result.path);
			return result;
		};
		vi.spyOn(fixture.stateStore, "compareAndMove").mockResolvedValueOnce(false);
		const started: string[] = [];
		const first = await fixture.execute({ beginAction: (action) => { started.push(action.path); return "run"; } });
		expect(first.failed).toHaveLength(1);
		expect(first.blocked).toHaveLength(1);
		expect(first.blocked[0]).toMatchObject({ action: { path: "A.md" }, reason: "component prefix did not publish" });
		expect(started).toEqual(["B.md"]);
		expect(readText(fixture.remoteFs, "A.md")).toBe("foreign A");
		expect(await fixture.stateStore.get("A.md")).toEqual(fixture.baseline);
		expect(await fixture.stateStore.get("B.md")).toBeUndefined();
		const second = await fixture.execute();
		expect(second.failed).toEqual([]);
		expect(second.blocked).toEqual([]);
		expect(second.succeeded.map(({ action }) => action.path)).toEqual(["B.md", "A.md"]);
		expect(await fixture.stateStore.get("A.md")).toMatchObject({ remoteIdentityKey: "Y" });
		expect(await fixture.stateStore.get("B.md")).toMatchObject({ remoteIdentityKey: "R" });
	});

	it("reuses the captured rename-copy bytes across different checksum algorithms", async () => {
		const fixture = await renamedFixture();
		const checksum = { algo: "md5" as const, value: await digest(new TextEncoder().encode("remote edit").buffer, "md5") };
		const stat = fixture.remoteFs.stat.bind(fixture.remoteFs);
		fixture.remoteFs.stat = async (path) => {
			const entity = await stat(path);
			return entity ? { ...entity, hash: "", remoteChecksum: checksum } : null;
		};
		const localRead = vi.spyOn(fixture.localFs, "read");
		const remoteRead = vi.spyOn(fixture.remoteFs, "read");
		const result = await fixture.execute();
		expect(result.failed).toEqual([]);
		expect(result.blocked).toEqual([]);
		expect(result.succeeded).toHaveLength(1);
		expect(remoteRead).toHaveBeenCalledExactlyOnceWith("B.md");
		expect(localRead).not.toHaveBeenCalled();
	});
	it("copies the remote edit after the local rename and reaches a fixed point", async () => {
		const fixture = await renamedFixture();
		const rename = vi.spyOn(fixture.localFs, "rename");
		const remoteWrite = vi.spyOn(fixture.remoteFs, "write");
		const result = await fixture.execute();
		expect(result.failed).toEqual([]);
		expect(result.blocked).toEqual([]);
		expect(result.succeeded).toHaveLength(1);
		expect(result.succeeded[0]?.terminalProof?.action).toBe(result.succeeded[0]?.action);
		expect(rename).toHaveBeenCalledExactlyOnceWith("A.md", "B.md");
		expect(readText(fixture.localFs, "B.md")).toBe("remote edit");
		expect(await fixture.stateStore.get("A.md")).toBeUndefined();
		expect(await fixture.stateStore.get("B.md")).toMatchObject({ remoteIdentityKey: "R" });
		expect(remoteWrite).not.toHaveBeenCalled();
		const next = await fixture.observe();
		expect(next.failures).toEqual([]);
		expect(next.executable.actions).toEqual([]);
	});

	it("re-observes a successful move with failed record publication without recovery state", async () => {
		const fixture = await renamedFixture();
		const compareAndMove = vi.spyOn(fixture.stateStore, "compareAndMove").mockResolvedValueOnce(false);
		const rename = vi.spyOn(fixture.localFs, "rename");
		const first = await fixture.execute();
		expect(first.succeeded).toEqual([]);
		expect(first.failed).toHaveLength(1);
		expect(await fixture.stateStore.get("A.md")).toEqual(fixture.baseline);
		expect(await fixture.stateStore.get("B.md")).toBeUndefined();
		expect(readText(fixture.localFs, "B.md")).toBe("remote edit");
		const next = await fixture.observe();
		expect(next.failures).toEqual([]);
		expect(next.executable.actions).toEqual([expect.objectContaining({ action: "match", path: "B.md" })]);
		const second = await fixture.execute();
		expect(second.failed).toEqual([]);
		expect(second.blocked).toEqual([]);
		expect(second.succeeded).toHaveLength(1);
		expect(compareAndMove).toHaveBeenCalledTimes(2);
		expect(rename).toHaveBeenCalledOnce();
		expect(await fixture.stateStore.get("A.md")).toBeUndefined();
		expect((await fixture.observe()).executable.actions).toEqual([]);
	});

	it("withholds publication for a request echo and converges after provider confirmation", async () => {
		const fixture = await renamedFixture("local");
		const rename = vi.spyOn(fixture.remoteFs, "rename");
		const write = vi.spyOn(fixture.remoteFs, "write");
		const first = await fixture.execute();
		expect(readText(fixture.remoteFs, "B.md")).toBe("local edit");
		expect(first.succeeded).toEqual([]);
		expect(first.blocked).toHaveLength(1);
		expect(await fixture.stateStore.get("A.md")).toEqual(fixture.baseline);
		expect(await fixture.stateStore.get("B.md")).toBeUndefined();
		// A later provider observation is new authority, not a remembered failure.
		confirmMockPath(fixture.remoteFs, "B.md");
		const next = await fixture.observe();
		expect(next.failures).toEqual([]);
		expect(next.executable.actions).toEqual([expect.objectContaining({ action: "match", path: "B.md" })]);
		const second = await fixture.execute();
		expect(second.failed).toEqual([]);
		expect(second.blocked).toEqual([]);
		expect(second.succeeded).toHaveLength(1);
		expect(rename).toHaveBeenCalledOnce();
		expect(write).toHaveBeenCalledOnce();
		expect(await fixture.stateStore.get("A.md")).toBeUndefined();
		expect((await fixture.observe()).executable.actions).toEqual([]);
	});
});
