import { describe, expect, it } from "vitest";
import { addFile, createMockLocalFs, createMockRemoteFs, createMockStateStore, readText } from "../__mocks__/sync-test-helpers";
import { digest } from "../utils/hash";
import { admitBatchObservation } from "./plan-admission";
import { executePlan } from "./plan-executor";
import { buildSyncRecord } from "./state-committer";
import { captureBatchObservation } from "./sync-cycle-planning";

async function fixture(md5Only: boolean) {
	const localFs = createMockLocalFs();
	const remoteFs = createMockRemoteFs("actual_resolved");
	const stateStore = createMockStateStore();
	const path = "note.md";
	addFile(localFs, path, "original\n", 1000);
	addFile(remoteFs, path, "original\n", 1000).identityKey = "R";
	if (md5Only) {
		const stat = remoteFs.stat.bind(remoteFs);
		remoteFs.stat = async (requested) => {
			const entity = await stat(requested);
			return entity ? { ...entity, hash: "", remoteChecksum: {
				algo: "md5", value: await digest(await remoteFs.read(requested), "md5"),
			} } : null;
		};
	}
	await stateStore.put(buildSyncRecord((await localFs.stat(path))!, (await remoteFs.stat(path))!, path));
	stateStore.contents.set(path, new TextEncoder().encode("original\n").buffer);
	const observe = async () => admitBatchObservation(captureBatchObservation([{
		path, local: (await localFs.stat(path))!, remote: (await remoteFs.stat(path))!,
		prevSync: await stateStore.get(path),
	}], [], [], {
		byEndpoint: new Map([[path, "included"]]), isConfiguredScopeCompatible: () => true,
	}, "test:local-edit"), "auto_merge");
	const context = { localFs, remoteFs, committer: { stateStore, localFs, enableThreeWayMerge: true } };
	return { localFs, remoteFs, stateStore, path, observe, context };
}

describe("local-only edits while a captured push is in flight", () => {
	it.each([false, true])("ordinary local edits remain pushes (MD5-only remote=%s)", async (md5Only) => {
		const f = await fixture(md5Only);
		await f.localFs.write(f.path, new TextEncoder().encode("first local\n").buffer, 2000);
		const first = await f.observe();
		expect(first.executable.actions.map((action) => action.action)).toEqual(["push"]);
		expect((await executePlan(first.executable, f.context)).blocked).toEqual([]);
		await f.localFs.write(f.path, new TextEncoder().encode("second local\n").buffer, 3000);
		expect((await f.observe()).executable.actions.map((action) => action.action)).toEqual(["push"]);
	});

	it.each([
		{ md5Only: false, latest: "latest local revision\n" },
		{ md5Only: false, latest: "other local\n" },
		{ md5Only: true, latest: "latest local revision\n" },
		{ md5Only: true, latest: "other local\n" },
	])("does not manufacture conflict after upload when %j", async ({ md5Only, latest }) => {
		const f = await fixture(md5Only);
		const uploaded = "first local\n";
		await f.localFs.write(f.path, new TextEncoder().encode(uploaded).buffer, 2000);
		const capturedLocal = (await f.localFs.stat(f.path))!;
		const first = await f.observe();
		expect(first.executable.actions.map((action) => action.action)).toEqual(["push"]);
		const write = f.remoteFs.write.bind(f.remoteFs);
		f.remoteFs.write = async (path, content, mtime) => {
			const result = await write(path, content, mtime);
			// A user edit after captured bytes reach the provider, before terminal stat.
			await f.localFs.write(path, new TextEncoder().encode(latest).buffer, 3000);
			return result;
		};
		const result = await executePlan(first.executable, f.context);
		f.remoteFs.write = write;
		expect(readText(f.remoteFs, f.path)).toBe(uploaded);
		expect(readText(f.localFs, f.path)).toBe(latest);
		expect.soft(result.blocked.map((item) => item.reason)).toEqual([]);
		expect.soft((await f.stateStore.get(f.path))?.hash).toBe(capturedLocal.hash);
		expect.soft(new TextDecoder().decode(await f.stateStore.getContent(f.path))).toBe(uploaded);
		const next = await f.observe();
		expect.soft(next.executable.actions.map((action) => action.action)).toEqual(["push"]);
		const replay = await executePlan(next.executable, f.context);
		expect(replay.blocked).toEqual([]);
		expect.soft(replay.conflicts).toHaveLength(0);
		expect.soft(readText(f.localFs, f.path)).toBe(latest);
		expect.soft(readText(f.remoteFs, f.path)).toBe(latest);
	});
});
