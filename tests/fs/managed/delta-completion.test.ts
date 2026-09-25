import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import type {
	RemoteChange,
	RemoteChangeResult,
	RemoteObject,
	SubtreeReadResult,
} from "../../../src/backend-api";
import { ManagedRemoteFs } from "../../../src/fs/managed/managed-remote-fs";
import { RemoteObjectValidationError } from "../../../src/fs/managed/remote-object-validation";
import { FakeRemoteAdapter } from "./fake-adapter";

const STORE = { dbNamePrefix: "air-sync-delta-completion-test", version: 1 };

/**
 * A Google-Drive-shaped adapter for the delta-completion tests: its `getChanges`
 * reports only the item the provider changed (never a moved folder's unchanged
 * descendants), and it declares `listSubtreeById` to complete them. The entered
 * folder's subtree is created up front but hidden from `listAll` until `showAll`,
 * so the first scan sees an empty root and the folder only exists once the delta
 * announces it.
 */
class EntryOnlyAdapter extends FakeRemoteAdapter {
	readonly subtreeCalls: string[] = [];
	readonly descendants: RemoteObject[];
	readonly enteredId: string;
	private readonly hiddenIds: Set<string>;
	private hide = true;
	private nextChanges: RemoteChange[];
	private subtreeResult: SubtreeReadResult;
	private rejectSubtree = false;

	constructor() {
		super("root", "parent_id");
		this.enteredId = this.seedDirectory("F");
		const a = this.seedFile("F/a.md", "A");
		const sub = this.seedDirectory("F/sub");
		const b = this.seedFile("F/sub/b.md", "B");
		this.hiddenIds = new Set([this.enteredId, a, sub, b]);
		this.descendants = [this.enteredId, a, sub, b].map((id) => this.nodeById(id)!);
		this.nextChanges = [{ kind: "upsert", object: this.nodeById(this.enteredId)! }];
		this.subtreeResult = { kind: "subtree", objects: this.descendants };
	}

	showAll(): void {
		this.hide = false;
	}

	setNextChanges(changes: RemoteChange[]): void {
		this.nextChanges = changes;
	}

	setSubtreeResult(result: SubtreeReadResult): void {
		this.subtreeResult = result;
	}

	failSubtree(): void {
		this.rejectSubtree = true;
	}

	recoverSubtree(): void {
		this.rejectSubtree = false;
	}

	override listAll(): Promise<readonly RemoteObject[]> {
		return super.listAll().then((objects) =>
			this.hide ? objects.filter((object) => !this.hiddenIds.has(object.id)) : objects,
		);
	}

	override async getChanges(cursor: string): Promise<RemoteChangeResult> {
		// Cursor-sensitive: the window is served only to the cursor the provider last
		// handed out. A checkpoint that wrongly advanced past the rejected attempt would
		// send a different cursor on retry and receive an empty window, so the retry
		// assertions below prove the durable cursor did not move.
		const start = await this.getStartCursor();
		if (cursor !== start) return { kind: "changes", nextCursor: cursor, changes: [] };
		return { kind: "changes", nextCursor: "1", changes: this.nextChanges };
	}

	listSubtreeById(id: string): Promise<SubtreeReadResult> {
		this.subtreeCalls.push(id);
		if (this.rejectSubtree) return Promise.reject(new Error("subtree listing failed"));
		return Promise.resolve(this.subtreeResult);
	}
}

function makeFs(adapter: FakeRemoteAdapter, vaultId: string): ManagedRemoteFs {
	return new ManagedRemoteFs({
		adapter,
		name: "entry-only",
		rootFolderId: adapter.rootId,
		vaultId,
		store: STORE,
	});
}

/** A delta that reports two independent entering folders and one nested inside another. */
class MultiEntryAdapter extends FakeRemoteAdapter {
	readonly subtreeCalls: string[] = [];
	readonly fId: string;
	readonly subId: string;
	readonly gId: string;
	private readonly aId: string;
	private readonly xId: string;
	private readonly hiddenIds: Set<string>;
	private readonly nextChanges: RemoteChange[];

	constructor() {
		super("root", "parent_id");
		this.fId = this.seedDirectory("F");
		this.subId = this.seedDirectory("F/sub");
		this.aId = this.seedFile("F/a.md", "A");
		this.gId = this.seedDirectory("G");
		this.xId = this.seedFile("G/x.md", "X");
		this.hiddenIds = new Set([this.fId, this.subId, this.aId, this.gId, this.xId]);
		this.nextChanges = [
			{ kind: "upsert", object: this.nodeById(this.fId)! },
			{ kind: "upsert", object: this.nodeById(this.subId)! },
			{ kind: "upsert", object: this.nodeById(this.gId)! },
		];
	}

	override listAll(): Promise<readonly RemoteObject[]> {
		return super.listAll().then((objects) => objects.filter((object) => !this.hiddenIds.has(object.id)));
	}

	override getChanges(): Promise<RemoteChangeResult> {
		return Promise.resolve({ kind: "changes", nextCursor: "1", changes: this.nextChanges });
	}

	listSubtreeById(id: string): Promise<SubtreeReadResult> {
		this.subtreeCalls.push(id);
		const objects = id === this.fId
			? [this.fId, this.subId, this.aId].map((entry) => this.nodeById(entry)!)
			: [this.gId, this.xId].map((entry) => this.nodeById(entry)!);
		return Promise.resolve({ kind: "subtree", objects });
	}
}

describe("ManagedRemoteFs — core-side delta completion", () => {
	it("list exactly one entered folder and merges its complete subtree", async () => {
		const adapter = new EntryOnlyAdapter();
		const fs = makeFs(adapter, "complete-entered");
		await fs.list();
		await fs.commitCheckpoint();

		const delta = await fs.getChangedPaths();

		expect(adapter.subtreeCalls).toEqual([adapter.enteredId]);
		expect([...(delta?.modified ?? [])].sort()).toEqual(["F", "F/a.md", "F/sub", "F/sub/b.md"]);
		expect(delta?.deleted).toEqual([]);
	});

	it("issues no subtree read when no folder enters the bound root", async () => {
		const adapter = new EntryOnlyAdapter();
		const fs = makeFs(adapter, "steady-state");
		await fs.list();
		await fs.commitCheckpoint();
		adapter.setNextChanges([]);

		const delta = await fs.getChangedPaths();

		expect(adapter.subtreeCalls).toEqual([]);
		expect(delta?.modified).toEqual([]);
	});

	it("does not re-list a changed folder already present in the working view", async () => {
		const adapter = new EntryOnlyAdapter();
		adapter.showAll();
		const fs = makeFs(adapter, "already-cached");
		await fs.list();
		await fs.commitCheckpoint();
		adapter.setNextChanges([{ kind: "upsert", object: adapter.nodeById(adapter.enteredId)! }]);

		const delta = await fs.getChangedPaths();

		expect(adapter.subtreeCalls).toEqual([]);
		expect(delta?.modified).toEqual(["F"]);
	});

	it("diffs a cursor-invalid fallback against the pre-delta view, not the partial apply", async () => {
		const adapter = new EntryOnlyAdapter();
		const fs = makeFs(adapter, "fallback-baseline");
		await fs.list();
		await fs.commitCheckpoint();
		adapter.setNextChanges([{ kind: "upsert", object: adapter.nodeById(adapter.enteredId)! }]);
		// The provider listing now holds the moved subtree, and the completion read
		// expires the cursor: the fallback must still report the entered facts.
		adapter.showAll();
		adapter.setSubtreeResult({ kind: "cursor_invalid" });

		const delta = await fs.getChangedPaths();

		expect(adapter.subtreeCalls).toEqual([adapter.enteredId]);
		expect([...(delta?.modified ?? [])].sort()).toEqual(["F", "F/a.md", "F/sub", "F/sub/b.md"]);
		expect(delta?.deleted).toEqual([]);
	});

	it("rejects an unrecognized subtree result instead of applying a partial subtree", async () => {
		const adapter = new EntryOnlyAdapter();
		const fs = makeFs(adapter, "malformed-result");
		await fs.list();
		await fs.commitCheckpoint();
		adapter.setNextChanges([{ kind: "upsert", object: adapter.nodeById(adapter.enteredId)! }]);
		adapter.setSubtreeResult({ kind: "bogus" } as unknown as SubtreeReadResult);

		await expect(fs.getChangedPaths()).rejects.toBeInstanceOf(RemoteObjectValidationError);
	});

	it("rejects a subtree object whose addressing disagrees with the adapter", async () => {
		const adapter = new EntryOnlyAdapter();
		const fs = makeFs(adapter, "address-mismatch");
		await fs.list();
		await fs.commitCheckpoint();
		adapter.setNextChanges([{ kind: "upsert", object: adapter.nodeById(adapter.enteredId)! }]);
		adapter.setSubtreeResult({
			kind: "subtree",
			objects: [{
				id: "F",
				name: "F",
				kind: "directory",
				location: { addressing: "provider_path", rootId: "root", path: "F" },
				pathAuthority: "provider_resolved",
			}],
		});

		await expect(fs.getChangedPaths()).rejects.toBeInstanceOf(RemoteObjectValidationError);
	});

	it("keeps a same-path content update that the fallback diff cannot re-derive", async () => {
		const adapter = new EntryOnlyAdapter();
		adapter.seedFile("keep.md", "old");
		const fs = makeFs(adapter, "fallback-content-update");
		await fs.list();
		await fs.commitCheckpoint();
		const updated = adapter.simulateUpdate("keep.md", "new");
		adapter.setNextChanges([
			{ kind: "upsert", object: adapter.nodeById(adapter.enteredId)! },
			...updated,
		]);
		adapter.showAll();
		adapter.setSubtreeResult({ kind: "cursor_invalid" });

		const delta = await fs.getChangedPaths();

		expect([...(delta?.modified ?? [])].sort())
			.toEqual(["F", "F/a.md", "F/sub", "F/sub/b.md", "keep.md"]);
	});

	it("aborts on a rejected completion listing and re-derives the same targets on retry", async () => {
		const adapter = new EntryOnlyAdapter();
		const fs = makeFs(adapter, "rejected-completion");
		await fs.list();
		await fs.commitCheckpoint();
		const committedScope = await fs.checkpoint.getScopeFingerprint?.();
		adapter.setNextChanges([{ kind: "upsert", object: adapter.nodeById(adapter.enteredId)! }]);
		adapter.failSubtree();

		await expect(fs.getChangedPaths()).rejects.toThrow(/subtree listing failed/);
		// The durable checkpoint and scope are unchanged, and the cursor-sensitive fake
		// only serves the window to the committed cursor, so the retry below proves the
		// rejected attempt did not advance it.
		expect(await fs.checkpoint.hasCheckpoint()).toBe(true);
		expect(await fs.checkpoint.getScopeFingerprint?.()).toBe(committedScope);

		await fs.abortWorkingView();
		adapter.recoverSubtree();
		const retry = await fs.getChangedPaths();

		expect(adapter.subtreeCalls).toEqual([adapter.enteredId, adapter.enteredId]);
		expect([...(retry?.modified ?? [])].sort()).toEqual(["F", "F/a.md", "F/sub", "F/sub/b.md"]);
	});

	it("deduplicates nested entered targets and reads topmost targets in first-entered order", async () => {
		const adapter = new MultiEntryAdapter();
		const fs = makeFs(adapter, "multi-target");
		await fs.list();
		await fs.commitCheckpoint();

		const delta = await fs.getChangedPaths();

		expect(adapter.subtreeCalls).toEqual([adapter.fId, adapter.gId]);
		expect([...(delta?.modified ?? [])].sort()).toEqual(["F", "F/a.md", "F/sub", "G", "G/x.md"]);
	});

	it("does not read an entered target that left the bound root before the drain closed", async () => {
		const adapter = new EntryOnlyAdapter();
		const fs = makeFs(adapter, "unresolved-target");
		await fs.list();
		await fs.commitCheckpoint();
		const entered = adapter.nodeById(adapter.enteredId)!;
		// The folder enters the root on the first entry, then the same drain moves it to a
		// parent that no longer resolves, so it holds no path by drain end.
		const movedOutside = {
			...entered,
			location: { addressing: "parent_id" as const, parentId: "outside-the-root" },
		};
		adapter.setNextChanges([
			{ kind: "upsert", object: entered },
			{ kind: "upsert", object: movedOutside },
		]);

		const delta = await fs.getChangedPaths();

		expect(adapter.subtreeCalls).toEqual([]);
		expect([...(delta?.modified ?? [])]).not.toContain("F");
		expect([...(delta?.modified ?? [])]).not.toContain("F/a.md");
	});
});
