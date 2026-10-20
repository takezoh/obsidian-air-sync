import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { ManagedRemoteFs } from "../../../src/fs/managed/managed-remote-fs";
import { SyncOrchestrator } from "../../../src/sync/orchestrator";
import { LocalChangeTracker } from "../../../src/sync/local-tracker";
import { createChecksumRegistry } from "../../../src/fs/modules/checksum-registry";
import { addFile, createMockLocalFs, mockSettings } from "../../../src/__mocks__/sync-test-helpers";
import type { RemoteChange, RemoteObject, UpdateFileInput } from "../../../src/backend-api";
import { backendError } from "../../../src/backend-api";
import { toBackendError } from "../../../src/backends/shared/error-shape";
import { FaithfulCollisionAdapter } from "./faithful-collision-adapter";

// Sync retries sleep through window.setTimeout; give the node test environment one.
vi.stubGlobal("window", { setTimeout, clearTimeout });
const checksumRegistry = createChecksumRegistry();
const STORE = { dbNamePrefix: "air-sync-stale-push-version", version: 1 };
const enc = (text: string) => new TextEncoder().encode(text).buffer;

/**
 * The faithful fake, plus the two Google Drive facts the stale-version case depends on:
 * every file carries an MD5 content checksum, and a refused conditional update is the
 * typed `target_changed` backend error (as `failBackend` throws it).
 */
class ChecksummedAdapter extends FaithfulCollisionAdapter {
	private get internals() {
		return this as unknown as { nodes: Map<string, { content: ArrayBuffer }>; log: RemoteChange[] };
	}

	private async withChecksum<T extends RemoteObject | null>(object: T): Promise<T> {
		if (object === null || object.kind !== "file") return object;
		const content = this.internals.nodes.get(object.id)!.content;
		return { ...object, checksum: { algorithm: "md5", value: await checksumRegistry.compute(content, "md5") } };
	}

	override async listAll(): Promise<readonly RemoteObject[]> {
		return Promise.all((await super.listAll()).map((object) => this.withChecksum(object)));
	}

	override async getById(id: string): Promise<RemoteObject | null> {
		return this.withChecksum(await super.getById(id));
	}

	override async getByPath(path: string): Promise<readonly RemoteObject[]> {
		return Promise.all((await super.getByPath(path)).map((object) => this.withChecksum(object)));
	}

	override async updateFile(input: UpdateFileInput): Promise<RemoteObject> {
		let object: RemoteObject;
		try {
			object = await super.updateFile(input);
		} catch (error) {
			throw toBackendError(backendError("target_changed", (error as Error).message));
		}
		const withSum = await this.withChecksum(object);
		const log = this.internals.log;
		log[log.length - 1] = { kind: "upsert", object: withSum };
		return withSum;
	}
}

/** Real orchestrator + ManagedRemoteFs over a versioned fake provider, with both files synced. */
async function setup(adapter: FaithfulCollisionAdapter = new FaithfulCollisionAdapter()) {
	const vaultId = `stale-push-${Math.random()}`;
	const noteId = adapter.seedFile("Note.md", "original");
	const otherId = adapter.seedFile("Other.md", "other");
	const fs = new ManagedRemoteFs({ adapter, name: "faithful", rootFolderId: adapter.rootId, vaultId, store: STORE });
	const localFs = createMockLocalFs();
	addFile(localFs, "Note.md", "original", 1000);
	addFile(localFs, "Other.md", "other", 1000);
	const tracker = new LocalChangeTracker();
	const statuses: string[] = [];
	const errors: string[] = [];
	const orchestrator = new SyncOrchestrator({
		getSettings: () => mockSettings({ vaultId, backendType: "googledrive" }),
		saveSettings: vi.fn().mockResolvedValue(undefined),
		configDir: () => ".cfg",
		pluginId: () => "test-plugin",
		localFs: () => localFs,
		remoteFs: () => fs,
		backendProvider: () => null,
		checksumRegistry,
		onStatusChange: (status) => statuses.push(status),
		onProgress: vi.fn(),
		notify: vi.fn(),
		isMobile: () => false,
		isLayoutReady: () => true,
		localTracker: tracker,
		logger: {
			debug: () => {}, info: () => {}, warn: () => {},
			error: (message: string, data?: unknown) => errors.push(`${message} ${JSON.stringify(data)}`),
			flush: () => Promise.resolve(),
			enabled: () => false,
		} as never,
	});
	await orchestrator.runSync();
	expect({ status: statuses.at(-1), errors }).toEqual({ status: "idle", errors: [] });
	const edit = async (path: string, text: string, mtime: number) => {
		await localFs.write(path, enc(text), mtime);
		tracker.markDirty(path);
	};
	const sync = async () => {
		statuses.length = 0;
		errors.length = 0;
		await orchestrator.runSync();
		return { status: statuses.at(-1), errors: [...errors] };
	};
	const close = async () => { await orchestrator.close(); await fs.close(); };
	return { adapter, fs, localFs, noteId, otherId, edit, sync, close };
}

describe("Google Drive version token advances without a content change", () => {
	it("re-conditions a push when only the version token moved (no change-feed entry)", async () => {
		const t = await setup(new ChecksummedAdapter());
		const nodes = (t.adapter as unknown as { nodes: Map<string, { version: number }> }).nodes;
		const update = t.adapter.updateFile.bind(t.adapter);
		let bumped = false;
		t.adapter.updateFile = async (input: UpdateFileInput) => {
			const result = await update(input);
			if (input.id === t.noteId && !bumped) {
				bumped = true;
				nodes.get(t.noteId)!.version++; // server-side bump, content unchanged, nothing in the feed
			}
			return result;
		};
		await t.edit("Note.md", "A", 2000);
		expect((await t.sync()).status).toBe("idle");
		await t.edit("Note.md", "B", 3000);
		const results = [await t.sync(), await t.sync(), await t.sync()];
		expect(results.map((r) => r.errors)).toEqual([[], [], []]);
		const head = (await t.adapter.getById(t.noteId))!;
		const remote = await t.adapter.read({ id: t.noteId, versionToken: head.versionToken! });
		expect(remote.kind === "content" && new TextDecoder().decode(remote.content)).toBe("B");
		await t.close();
	}, 120_000);

	// "modified" has the same byte length as the seeded "original", so only the checksum
	// comparison can tell it apart; "changed elsewhere" also differs in size.
	it.each(["modified", "changed elsewhere"])(
		"never overwrites a real remote content change the feed did not report (%s)",
		async (remoteText) => {
			const t = await setup(new ChecksummedAdapter());
			const nodes = (t.adapter as unknown as { nodes: Map<string, { version: number; content: ArrayBuffer }> }).nodes;
			// Someone else changes the content on the provider, and the feed never reports it.
			const node = nodes.get(t.noteId)!;
			node.content = enc(remoteText);
			node.version++;
			await t.edit("Note.md", "B", 3000);
			await t.sync();
			const head = (await t.adapter.getById(t.noteId))!;
			const remote = await t.adapter.read({ id: t.noteId, versionToken: head.versionToken! });
			expect(remote.kind === "content" && new TextDecoder().decode(remote.content)).toBe(remoteText);
			await t.close();
		},
	);
});
