import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import type { RemoteChange, RemoteObject } from "../../../src/backend-api";
import { ManagedRemoteFs } from "../../../src/fs/managed/managed-remote-fs";
import { RemoteObjectValidationError } from "../../../src/fs/managed/remote-object-validation";
import type { RemoteAddressing } from "../../../src/fs/managed/mutation-bridge";
import { MetadataStore } from "../../../src/store/metadata-store";
import { FakeRemoteAdapter } from "./fake-adapter";

const STORE = { dbNamePrefix: "air-sync-managed-test", version: 1 };
const bytes = (value: string): ArrayBuffer => new TextEncoder().encode(value).buffer;
const decode = (value: ArrayBuffer): string => new TextDecoder().decode(value);

function makeFs(adapter: FakeRemoteAdapter, vaultId: string, addressing?: RemoteAddressing): ManagedRemoteFs {
	return new ManagedRemoteFs({
		adapter,
		name: "fake",
		rootFolderId: adapter.rootId,
		vaultId,
		store: STORE,
		addressing,
	});
}

/** Seed the same baseline the planner used, so provider ids line up per test. */
function seedPermutationBaseline(adapter: FakeRemoteAdapter): void {
	adapter.seedFile("a.md", "A");
	adapter.seedFile("b.md", "B");
	adapter.seedFile("c.md", "C");
	adapter.seedDirectory("docs");
	adapter.seedFile("docs/x.md", "X");
}

function normalizeDelta(delta: Awaited<ReturnType<ManagedRemoteFs["getChangedPaths"]>>) {
	return {
		modified: [...(delta?.modified ?? [])].sort(),
		deleted: [...(delta?.deleted ?? [])].sort(),
		renamed: [...(delta?.renamed ?? [])].sort((a, b) => a.newPath.localeCompare(b.newPath)),
	};
}

describe("ManagedRemoteFs — complete snapshot", () => {
	it("lists a parent_id tree with identity, checksum, size and mtime", async () => {
		const adapter = new FakeRemoteAdapter("root", "parent_id");
		adapter.seedDirectory("docs");
		adapter.seedFile("docs/a.md", "A", { algorithm: "md5", value: "mA" }, 5_000);
		adapter.seedFile("top.md", "T");
		const fs = makeFs(adapter, "snapshot-parent");

		const entries = await fs.list();
		expect(entries.map((entry) => entry.path).sort()).toEqual(["docs", "docs/a.md", "top.md"]);

		const file = await fs.stat("docs/a.md");
		expect(file).toMatchObject({
			identityKey: adapter.idAtPath("docs/a.md"),
			isDirectory: false,
			size: 1,
			mtime: 5_000,
			remoteChecksum: { algo: "md5", value: "mA" },
		});
		expect((await fs.stat("docs"))?.isDirectory).toBe(true);
		expect(await fs.stat("missing.md")).toBeNull();
	});

	it("lists a provider_path tree resolved by the provider's own paths", async () => {
		const adapter = new FakeRemoteAdapter("root", "provider_path");
		adapter.seedDirectory("docs");
		adapter.seedDirectory("docs/sub");
		adapter.seedFile("docs/sub/a.md", "A");
		const fs = makeFs(adapter, "snapshot-pp", "provider_path");

		expect((await fs.list()).map((entry) => entry.path).sort())
			.toEqual(["docs", "docs/sub", "docs/sub/a.md"]);
		expect((await fs.listDir("docs/sub")).map((entry) => entry.path)).toEqual(["docs/sub/a.md"]);
	});

	it("downloads file bytes and refuses to read a directory", async () => {
		const adapter = new FakeRemoteAdapter("root", "parent_id");
		adapter.seedFile("a.md", "hello");
		const fs = makeFs(adapter, "read-bytes");
		await fs.list();

		expect(decode(await fs.read("a.md"))).toBe("hello");
		await expect(fs.read("missing.md")).rejects.toThrow(/not found/i);

		const adapterDir = new FakeRemoteAdapter("root", "parent_id");
		adapterDir.seedDirectory("docs");
		const fsDir = makeFs(adapterDir, "read-dir");
		await fsDir.list();
		await expect(fsDir.read("docs")).rejects.toThrow(/directory/i);
	});
});

describe("ManagedRemoteFs — delta convergence", () => {
	it("converges on one outcome whatever order the adapter reports upsert/delete/rename", async () => {
		const planner = new FakeRemoteAdapter("root", "parent_id");
		seedPermutationBaseline(planner);
		const plannerFs = makeFs(planner, "perm-planner");
		await plannerFs.list();
		await plannerFs.commitCheckpoint();

		// Provider truth for the batch; `simulate*` mutates without logging, so the
		// same set of changes can be replayed in any order.
		const changes: RemoteChange[] = [
			...planner.simulateDelete("a.md"),
			...planner.simulateUpdate("b.md", "B2"),
			...planner.simulateRename("c.md", "c2.md"),
			...planner.simulateCreate("d.md", "D"),
		];
		planner.enqueueChanges(changes);
		const forward = normalizeDelta(await plannerFs.getChangedPaths());
		const forwardPaths = (await plannerFs.list()).map((entry) => entry.path).sort();

		const reversedAdapter = new FakeRemoteAdapter("root", "parent_id");
		seedPermutationBaseline(reversedAdapter);
		const reversedFs = makeFs(reversedAdapter, "perm-reversed");
		await reversedFs.list();
		await reversedFs.commitCheckpoint();
		reversedAdapter.enqueueChanges([...changes].reverse());
		const reversed = normalizeDelta(await reversedFs.getChangedPaths());
		const reversedPaths = (await reversedFs.list()).map((entry) => entry.path).sort();

		expect(reversed).toEqual(forward);
		expect(reversedPaths).toEqual(forwardPaths);
		expect(forward.deleted).toEqual(["a.md", "c.md"]);
		expect(forward.renamed.map((pair) => pair.newPath)).toEqual(["c2.md"]);
		expect(forwardPaths).toEqual(["b.md", "c2.md", "d.md", "docs", "docs/x.md"]);
	});

	it("applies a path-addressed tombstone by its real cache id and never invents one", async () => {
		const adapter = new FakeRemoteAdapter("root", "provider_path");
		adapter.seedFile("a.md", "A");
		adapter.seedFile("keep.md", "K");
		const fs = makeFs(adapter, "path-delete", "provider_path");
		await fs.list();
		await fs.commitCheckpoint();

		adapter.enqueueChanges(adapter.simulateDelete("a.md"));
		const delta = await fs.getChangedPaths();
		expect(delta?.deleted).toEqual(["a.md"]);
		expect(await fs.stat("a.md")).toBeNull();
		expect(await fs.stat("keep.md")).not.toBeNull();
	});

	it("treats a same-path recreate as a modification, not a deletion", async () => {
		const adapter = new FakeRemoteAdapter("root", "provider_path");
		adapter.seedFile("a.md", "old");
		const fs = makeFs(adapter, "recreate", "provider_path");
		await fs.list();
		await fs.commitCheckpoint();

		adapter.simulateRecreate("a.md");
		const delta = await fs.getChangedPaths();
		expect(delta?.modified).toContain("a.md");
		expect(delta?.deleted).toEqual([]);
		expect(await fs.stat("a.md")).not.toBeNull();
	});
});

describe("ManagedRemoteFs — root liveness", () => {
	it("accepts a genuinely empty root", async () => {
		const adapter = new FakeRemoteAdapter("root", "parent_id");
		const fs = makeFs(adapter, "empty-root");
		expect(await fs.list()).toEqual([]);
		await fs.commitCheckpoint();
		expect(await fs.hasCheckpoint()).toBe(true);
	});

	it("aborts rather than mass-deleting when the root is gone", async () => {
		const adapter = new FakeRemoteAdapter("root", "parent_id");
		adapter.killRoot();
		const fs = makeFs(adapter, "dead-root");
		await expect(fs.list()).rejects.toThrow(/deleted/);
		expect(await fs.hasCheckpoint()).toBe(false);
	});
});

describe("ManagedRemoteFs — cursor expiry", () => {
	it("full-scans and diffs by id, then continues incrementally from the new cursor", async () => {
		const adapter = new FakeRemoteAdapter("root", "parent_id");
		adapter.seedFile("a.md", "A");
		adapter.seedFile("b.md", "B");
		const fs = makeFs(adapter, "cursor-expiry");
		await fs.list();
		await fs.commitCheckpoint();

		adapter.simulateDelete("a.md");
		adapter.expireNextCursor();
		const expired = await fs.getChangedPaths();
		expect(expired?.deleted).toContain("a.md");
		expect(await fs.stat("a.md")).toBeNull();
		await fs.commitCheckpoint();

		// The full scan captured a fresh cursor; a later change is a normal delta.
		adapter.enqueueChanges(adapter.simulateRename("b.md", "b2.md"));
		const incremental = await fs.getChangedPaths();
		expect(incremental?.renamed?.map((pair) => pair.newPath)).toEqual(["b2.md"]);
		expect(incremental?.deleted).toEqual(["b.md"]);
	});
});

describe("ManagedRemoteFs — checkpoint durability", () => {
	it("commits cursor and cache together so a restart never re-lists", async () => {
		const adapter = new FakeRemoteAdapter("root", "parent_id");
		adapter.seedFile("a.md", "A");
		const fs1 = makeFs(adapter, "restart-no-scan");
		await fs1.list();
		await fs1.commitCheckpoint();

		const listAll = vi.spyOn(adapter, "listAll");
		const fs2 = makeFs(adapter, "restart-no-scan");
		expect(await fs2.hasCheckpoint()).toBe(true);
		expect((await fs2.list()).map((entry) => entry.path)).toEqual(["a.md"]);
		expect(listAll).not.toHaveBeenCalled();
	});

	it("keeps the durable checkpoint across an abort and re-detects the un-pulled deletion", async () => {
		const adapter = new FakeRemoteAdapter("root", "parent_id");
		adapter.seedFile("a.md", "A");
		const fs1 = makeFs(adapter, "abort-replay");
		await fs1.list();
		await fs1.commitCheckpoint();

		adapter.enqueueChanges(adapter.simulateDelete("a.md"));
		expect((await fs1.getChangedPaths())?.deleted).toContain("a.md");
		await fs1.abortWorkingView();

		const fs2 = makeFs(adapter, "abort-replay");
		expect(await fs2.hasCheckpoint()).toBe(true);
		expect((await fs2.getChangedPaths())?.deleted).toContain("a.md");
	});

	it("carries the committed scope fingerprint across a restart and discards it on reset", async () => {
		const adapter = new FakeRemoteAdapter("root", "parent_id");
		adapter.seedFile("a.md", "A");
		const fs1 = makeFs(adapter, "scope-fingerprint");
		await fs1.list();
		await fs1.commitCheckpoint({ scopeFingerprint: "fp-1" });
		expect(await fs1.getScopeFingerprint()).toBe("fp-1");

		const fs2 = makeFs(adapter, "scope-fingerprint");
		expect(await fs2.getScopeFingerprint()).toBe("fp-1");
		await fs2.resetCheckpoint();
		expect(await fs2.getScopeFingerprint()).toBeNull();
		expect(await fs2.hasCheckpoint()).toBe(false);
	});
});

describe("ManagedRemoteFs — mutations through the bridge", () => {
	it("creates folders and files, overwrites in place, renames and deletes", async () => {
		const adapter = new FakeRemoteAdapter("root", "parent_id");
		const fs = makeFs(adapter, "mutations-parent");
		await fs.list();

		const dir = await fs.mkdir("docs");
		expect(dir).toMatchObject({ path: "docs", isDirectory: true, pathAuthority: "requested_echo" });

		const written = await fs.write("docs/a.md", bytes("hello"), 123);
		expect(written).toMatchObject({ path: "docs/a.md", isDirectory: false, size: 5 });
		expect(written.hash).not.toBe("");
		expect(decode(await fs.read("docs/a.md"))).toBe("hello");
		expect(adapter.hasPath("docs/a.md")).toBe(true);

		const overwritten = await fs.write("docs/a.md", bytes("hello world"), 321);
		expect(overwritten.size).toBe(11);
		expect(decode(await fs.read("docs/a.md"))).toBe("hello world");

		await fs.rename("docs/a.md", "docs/b.md");
		expect(await fs.stat("docs/a.md")).toBeNull();
		expect(decode(await fs.read("docs/b.md"))).toBe("hello world");

		await fs.delete("docs");
		expect(await fs.stat("docs")).toBeNull();
		expect(adapter.hasPath("docs")).toBe(false);
	});

	it("deletes each member of a merged folder with its OWN version, not the representative's", async () => {
		// provider_path addressing: two same-named provider folders resolve to one
		// vault path and merge, each keeping its own provider identity and version.
		const adapter = new FakeRemoteAdapter("root", "provider_path");
		const first = adapter.seedDirectory("docs");
		const second = adapter.seedDirectory("docs");
		adapter.bumpVersion(second);
		const fs = makeFs(adapter, "merged-folder-delete", "provider_path");
		await fs.list();

		const firstToken = adapter.nodeById(first)!.versionToken;
		const secondToken = adapter.nodeById(second)!.versionToken;
		expect(firstToken).not.toBe(secondToken);

		const del = vi.spyOn(adapter, "delete");
		await fs.delete("docs");

		expect(del).toHaveBeenCalledTimes(2);
		const tokens = del.mock.calls.map(([input]) => input.expected.versionToken).sort();
		// Before the fix, the merged member carried the representative's token and the
		// provider CAS rejected the delete as `target_changed`.
		expect(tokens).toEqual([firstToken, secondToken].sort());
		expect(await fs.stat("docs")).toBeNull();
		expect(adapter.hasPath("docs")).toBe(false);
	});

	it("creates and renames through provider_path destinations", async () => {
		const adapter = new FakeRemoteAdapter("root", "provider_path");
		adapter.seedFile("seed.md", "S");
		const fs = makeFs(adapter, "mutations-pp", "provider_path");
		await fs.list();

		await fs.mkdir("docs/nested");
		await fs.write("docs/nested/a.md", bytes("hi"), 1);
		expect(adapter.hasPath("docs/nested/a.md")).toBe(true);
		await fs.rename("seed.md", "docs/renamed.md");
		expect(adapter.hasPath("seed.md")).toBe(false);
		expect(adapter.hasPath("docs/renamed.md")).toBe(true);
	});

	it("refuses to clobber an existing rename destination", async () => {
		const adapter = new FakeRemoteAdapter("root", "parent_id");
		adapter.seedFile("a.md");
		adapter.seedFile("b.md");
		const fs = makeFs(adapter, "rename-clobber");
		await fs.list();
		await expect(fs.rename("a.md", "b.md")).rejects.toThrow(/already exists/i);
	});

	it("refuses the reserved metadata path", async () => {
		const adapter = new FakeRemoteAdapter("root", "parent_id");
		const fs = makeFs(adapter, "reserved-path");
		await fs.list();
		await expect(fs.write(".airsync/metadata.json", bytes("x"), 1)).rejects.toThrow(/reserved/i);
		await expect(fs.mkdir(".airsync/metadata.json")).rejects.toThrow(/reserved/i);
	});
});

describe("ManagedRemoteFs — validated boundaries", () => {
	it("rejects a malformed object in an adapter delta before it reaches the cache", async () => {
		const adapter = new FakeRemoteAdapter("root", "parent_id");
		adapter.seedFile("a.md", "A");
		const fs = makeFs(adapter, "delta-validation");
		await fs.list();
		await fs.commitCheckpoint();

		adapter.enqueueChanges([
			{ kind: "upsert", object: { id: "bad", kind: "file" } as never },
		]);
		await expect(fs.getChangedPaths()).rejects.toThrow(RemoteObjectValidationError);
	});

	it("rejects a malformed object returned by an identity-addressed rename", async () => {
		const adapter = new FakeRemoteAdapter("root", "parent_id");
		const id = adapter.seedFile("a.md", "A");
		const fs = makeFs(adapter, "identity-rename-validation");
		await fs.list();

		vi.spyOn(adapter, "move").mockResolvedValue({ id: "bad" } as never);
		await expect(fs.identityRename.renameById(id, "a.md", "renamed.md")).rejects.toThrow(RemoteObjectValidationError);
	});

	it("validates and applies an identity-addressed rename of a cached object, carrying the expected version", async () => {
		const adapter = new FakeRemoteAdapter("root", "parent_id");
		const id = adapter.seedFile("a.md", "A");
		const fs = makeFs(adapter, "identity-rename-ok");
		await fs.list();

		const move = vi.spyOn(adapter, "move");
		await fs.identityRename.renameById(id, "a.md", "renamed.md");
		expect(move).toHaveBeenCalledTimes(1);
		expect(move.mock.calls[0]![0].expected).toEqual({ id, versionToken: "v1" });
		expect(adapter.hasPath("a.md")).toBe(false);
		expect(adapter.hasPath("renamed.md")).toBe(true);
		expect(await fs.stat("renamed.md")).not.toBeNull();
	});

	it("fails closed without a provider mutation when the object moved after Admission", async () => {
		const adapter = new FakeRemoteAdapter("root", "parent_id");
		const id = adapter.seedFile("a.md", "A");
		const fs = makeFs(adapter, "identity-rename-moved");
		await fs.list();
		// The object Admission observed at a.md has since moved to b.md.
		adapter.simulateRename("a.md", "b.md");

		const move = vi.spyOn(adapter, "move");
		await expect(fs.identityRename.renameById(id, "a.md", "renamed.md")).rejects.toThrow(/admitted path/);
		expect(move).not.toHaveBeenCalled();
		expect(adapter.hasPath("b.md")).toBe(true);
		expect(adapter.hasPath("renamed.md")).toBe(false);
	});

	it("passes the re-observed version to the provider CAS when the version advanced at the same path", async () => {
		const adapter = new FakeRemoteAdapter("root", "parent_id");
		const id = adapter.seedFile("a.md", "A");
		const fs = makeFs(adapter, "identity-rename-advanced");
		await fs.list();
		// Same address, newer version: the repair must CAS the version it re-observes.
		adapter.simulateUpdate("a.md", "A2");

		const move = vi.spyOn(adapter, "move");
		await fs.identityRename.renameById(id, "a.md", "renamed.md");
		expect(move).toHaveBeenCalledTimes(1);
		expect(move.mock.calls[0]![0].expected).toEqual({ id, versionToken: "v2" });
		expect(adapter.hasPath("renamed.md")).toBe(true);
	});
});

describe("ManagedRemoteFs — priority observation", () => {
	it("observes and reads a current identity without consuming the delta", async () => {
		const adapter = new FakeRemoteAdapter("root", "parent_id");
		const id = adapter.seedFile("a.md", "hi");
		const fs = makeFs(adapter, "priority");
		await fs.list();

		const observation = await fs.priority.observe({ path: "a.md", identityKey: id });
		expect(observation.kind).toBe("current");
		if (observation.kind !== "current") throw new Error("expected current");
		const read = await fs.priority.read(observation);
		expect(read.kind).toBe("content");
		if (read.kind === "content") expect(decode(read.content)).toBe("hi");

		adapter.enqueueChanges(adapter.simulateUpdate("a.md", "changed"));
		await fs.getChangedPaths();
		const after = await fs.priority.observe({ path: "a.md", identityKey: id });
		expect(after.kind).toBe("current");
	});

	it("reports a missing path as missing", async () => {
		const adapter = new FakeRemoteAdapter("root", "parent_id");
		const fs = makeFs(adapter, "priority-missing");
		await fs.list();
		expect((await fs.priority.observe({ path: "gone.md" })).kind).toBe("missing");
	});

	it("resolves a provider_path identity through the provider's own path", async () => {
		const adapter = new FakeRemoteAdapter("root", "provider_path");
		adapter.seedDirectory("docs");
		const id = adapter.seedFile("docs/a.md", "pp");
		const fs = makeFs(adapter, "priority-pp", "provider_path");
		await fs.list();
		const observation = await fs.priority.observe({ path: "docs/a.md", identityKey: id });
		expect(observation.kind).toBe("current");
		if (observation.kind !== "current") throw new Error("expected current");
		const read = await fs.priority.read(observation);
		expect(read.kind).toBe("content");
	});

	it("fails a read closed when the provider cannot prove the version", async () => {
		const adapter = new FakeRemoteAdapter("root", "parent_id");
		adapter.seedFile("a.md", "hi");
		const fs = makeFs(adapter, "read-unverifiable");
		await fs.list();
		adapter.makeReadUnverifiable();
		await expect(fs.read("a.md")).rejects.toThrow(/could not be verified/i);
	});
});

describe("ManagedRemoteFs — adapter boundary hygiene", () => {
	it("never hands a persistent store to the adapter", async () => {
		const adapter = new FakeRemoteAdapter("root", "parent_id");
		adapter.seedFile("a.md", "A");
		const fs = makeFs(adapter, "no-store-to-adapter");
		const methods = [
			"getStartCursor", "listAll", "assertRootAlive", "getChanges", "getById",
			"getByPath", "read", "createFile", "updateFile", "createDirectory", "move", "delete",
		] as const;
		const spies = methods.map((method) => vi.spyOn(adapter, method));

		await fs.list();
		await fs.commitCheckpoint();
		await fs.mkdir("docs");
		await fs.write("docs/a.md", bytes("x"), 1);
		await fs.read("docs/a.md");
		await fs.rename("docs/a.md", "docs/b.md");
		await fs.delete("docs/b.md");

		const leaked = spies.flatMap((spy) => spy.mock.calls.flat()).filter((argument) =>
			typeof argument === "object" && argument !== null &&
			typeof (argument as { saveAll?: unknown }).saveAll === "function");
		expect(leaked).toEqual([]);
	});
});

describe("ManagedRemoteFs — resource release", () => {
	it("closes the checkpoint store it owns on close", async () => {
		const adapter = new FakeRemoteAdapter("root", "parent_id");
		const store = new MetadataStore<RemoteObject>("close-release", STORE);
		const closeSpy = vi.spyOn(store, "close");
		const fs = new ManagedRemoteFs({
			adapter,
			name: "fake",
			rootFolderId: adapter.rootId,
			vaultId: "close-release",
			store: STORE,
			metadataStore: store,
		});

		await fs.close();

		expect(closeSpy).toHaveBeenCalledTimes(1);
	});
});
