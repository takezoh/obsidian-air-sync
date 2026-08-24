import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { METADATA_CACHE_VERSION, MetadataStore } from "./metadata-store";

interface TestFile {
	id: string;
	name: string;
	mimeType: string;
}

const CONFIG = { dbNamePrefix: "test-metadata", version: 1 };

describe("MetadataStore", () => {

	it("round-trip: saveAll then loadAll returns same data", async () => {
		const store = new MetadataStore<TestFile>("test-vault", CONFIG);
		await store.open();

		const files = [
			{ path: "notes/a.md", file: { id: "1", name: "a.md", mimeType: "text/plain" }, isFolder: false, pathAuthority: "actual_resolved" as const },
			{ path: "notes", file: { id: "2", name: "notes", mimeType: "application/vnd.google-apps.folder" }, isFolder: true },
		];
		const meta = new Map([
			["rootFolderId", "root123"],
			["changesStartPageToken", "token456"],
		]);

		await store.saveAll(files, meta);
		const loaded = await store.loadAll();

		expect(loaded.files).toHaveLength(2);
		expect(loaded.files.map((f) => f.path).sort()).toEqual(["notes", "notes/a.md"]);
		expect(loaded.files.find((f) => f.path === "notes/a.md")?.pathAuthority).toBe("actual_resolved");
		expect(loaded.meta.get("rootFolderId")).toBe("root123");
		expect(loaded.meta.get("changesStartPageToken")).toBe("token456");

		await store.close();
	});

	it("commitIncremental upserts, deletes, and writes meta in one transaction", async () => {
		const store = new MetadataStore<TestFile>("test-vault-2", CONFIG);
		await store.open();

		await store.saveAll(
			[{ path: "a.md", file: { id: "1", name: "a.md", mimeType: "text/plain" }, isFolder: false }],
			new Map(),
		);

		// Upsert b.md, delete a.md, and write the cursor — atomically.
		await store.commitIncremental(
			[{ path: "b.md", file: { id: "2", name: "b.md", mimeType: "text/plain" }, isFolder: false }],
			["a.md"],
			new Map([["changesStartPageToken", "tok-1"]]),
		);

		const loaded = await store.loadAll();
		expect(loaded.files).toHaveLength(1);
		expect(loaded.files[0]!.path).toBe("b.md");
		expect(loaded.meta.get("changesStartPageToken")).toBe("tok-1");
		expect(await store.getMeta("changesStartPageToken")).toBe("tok-1");

		await store.close();
	});

	it("clear removes all data", async () => {
		const store = new MetadataStore<TestFile>("test-vault-3", CONFIG);
		await store.open();

		await store.saveAll(
			[{ path: "x.md", file: { id: "1", name: "x.md", mimeType: "text/plain" }, isFolder: false }],
			new Map([["key", "val"]]),
		);

		await store.clear();
		const loaded = await store.loadAll();
		expect(loaded.files).toHaveLength(0);
		expect(loaded.meta.size).toBe(0);

		await store.close();
	});

	it("sets and deletes one durable operation marker without replacing cache metadata", async () => {
		const store = new MetadataStore<TestFile>("test-vault-operation", CONFIG);
		await store.open();
		await store.saveAll([], new Map([["changesStartPageToken", "cursor"]]));

		await store.setMeta("pendingOperation", "payload");
		expect(await store.getMeta("pendingOperation")).toBe("payload");
		expect(await store.getMeta("changesStartPageToken")).toBe("cursor");

		await store.deleteMeta("pendingOperation");
		expect(await store.getMeta("pendingOperation")).toBeUndefined();
		expect(await store.getMeta("changesStartPageToken")).toBe("cursor");
		await store.close();
	});

	it("uses config for db name prefix", async () => {
		const store = new MetadataStore<TestFile>("my-vault", { dbNamePrefix: "custom-prefix", version: 1 });
		await store.open();

		await store.saveAll(
			[{ path: "test.md", file: { id: "1", name: "test.md", mimeType: "text/plain" }, isFolder: false }],
			new Map(),
		);

		const loaded = await store.loadAll();
		expect(loaded.files).toHaveLength(1);

		await store.close();
	});

	it("cold-starts when persisted record semantics bump the cache version", async () => {
		const legacy = new MetadataStore<TestFile>("upgrade-vault", {
			dbNamePrefix: "test-metadata-upgrade",
			version: METADATA_CACHE_VERSION - 1,
		});
		await legacy.open();
		await legacy.saveAll(
			[{ path: "legacy.md", file: { id: "1", name: "legacy.md", mimeType: "text/plain" }, isFolder: false }],
			new Map([["changesStartPageToken", "legacy-cursor"]]),
		);
		await legacy.close();

		const current = new MetadataStore<TestFile>("upgrade-vault", {
			dbNamePrefix: "test-metadata-upgrade",
			version: METADATA_CACHE_VERSION,
		});
		await current.open();
		const loaded = await current.loadAll();

		expect(loaded.files).toEqual([]);
		expect(loaded.meta.size).toBe(0);
		await current.close();
	});
});
