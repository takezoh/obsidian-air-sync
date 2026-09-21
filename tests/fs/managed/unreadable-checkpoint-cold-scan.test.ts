import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ManagedRemoteFs } from "../../../src/fs/managed/managed-remote-fs";
import { METADATA_CACHE_VERSION, MetadataStore } from "../../../src/store/metadata-store";
import { FakeRemoteAdapter } from "./fake-adapter";

const ROOT = "root";
const STORE = { dbNamePrefix: "air-sync-googledrive", version: METADATA_CACHE_VERSION };
const CURSOR_KEY = "changesStartPageToken";
const MODIFIED = "2024-01-01T00:00:00.000Z";

const openStores: MetadataStore<unknown>[] = [];

afterEach(async () => {
	for (const store of openStores.splice(0)) await store.close();
});

/**
 * Seed a committed generation at `version`, in the pre-normalization encoding: a
 * `FileRecord` whose `file` is the provider-native DTO rather than a `RemoteObject`,
 * committed with the delta cursor. On the current generation that record has no
 * codec to interpret it; on an older generation the store is dropped and recreated
 * before it can be read at all. Neither may be read as a usable checkpoint.
 */
async function seedProviderNativeGeneration(vaultId: string, version: number): Promise<void> {
	const store = new MetadataStore<unknown>(vaultId, { ...STORE, version });
	openStores.push(store);
	await store.open();
	await store.saveAll(
		[
			{
				path: "note.md",
				file: {
					id: "legacy-1",
					name: "note.md",
					mimeType: "text/plain",
					size: "3",
					modifiedTime: MODIFIED,
					parents: [ROOT],
					md5Checksum: "abc",
				},
				isFolder: false,
				pathAuthority: "actual_resolved",
			},
		],
		new Map([[CURSOR_KEY, "0"]]),
	);
	await store.close();
	openStores.length = 0;
}

/**
 * Build an FS over a seeded store and assert it cold full-scans: no checkpoint, a
 * complete listing, and the current provider facts (not the stale record) seated.
 */
async function expectColdScan(vaultId: string): Promise<void> {
	const adapter = new FakeRemoteAdapter(ROOT);
	adapter.seedFile("other.md", "other");
	const freshId = adapter.seedFile("note.md", "fresh", { algorithm: "md5", value: "fresh-hash" });
	const listAll = vi.spyOn(adapter, "listAll");
	const getStartCursor = vi.spyOn(adapter, "getStartCursor");

	const fs = new ManagedRemoteFs({
		adapter,
		name: "googledrive",
		rootFolderId: ROOT,
		vaultId,
		store: STORE,
	});

	expect(await fs.hasCheckpoint()).toBe(false);

	const listed = await fs.list();
	expect(listAll).toHaveBeenCalled();
	expect(getStartCursor).toHaveBeenCalled();
	expect(listed.map((entry) => entry.path).sort()).toEqual(["note.md", "other.md"]);

	const note = listed.find((entry) => entry.path === "note.md")!;
	expect(note.identityKey).toBe(freshId);
	expect(note.identityKey).not.toBe("legacy-1");
	expect(note.remoteChecksum).toEqual({ algo: "md5", value: "fresh-hash" });

	await fs.close();
}

describe("an old-generation store is no usable checkpoint", () => {
	it("drops and recreates the store, then cold full-scans", async () => {
		await seedProviderNativeGeneration("unreadable-checkpoint-old-vault", METADATA_CACHE_VERSION - 1);
		await expectColdScan("unreadable-checkpoint-old-vault");
	});
});

describe("a same-generation checkpoint in an unrecognized encoding is no usable checkpoint", () => {
	it("cold full-scans instead of seating stale records, without throwing or partial-applying", async () => {
		await seedProviderNativeGeneration("unreadable-checkpoint-same-vault", METADATA_CACHE_VERSION);
		await expectColdScan("unreadable-checkpoint-same-vault");
	});
});
