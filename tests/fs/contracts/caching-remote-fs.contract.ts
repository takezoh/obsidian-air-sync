import { describe, it, expect, vi } from "vitest";
import type { MetadataStore } from "../../../src/store/metadata-store";
import type { CachingRemoteFs } from "../../../src/fs/caching/remote-fs";

/**
 * What a backend provides so the shared crash-safety contract can drive it without
 * knowing its file shape. The harness owns a single in-memory "remote" that every
 * FS it builds reads from, plus a real (fake-indexeddb) persistent store.
 */
export interface CachingRemoteFsHarness<TFile> {
	/** A fresh persistent store keyed by `id`. Use a unique id per case. */
	makeStore(id: string): MetadataStore<TFile>;
	/** Build an FS bound to `store`, reading the shared remote. */
	makeFs(store: MetadataStore<TFile>): CachingRemoteFs<TFile>;
	/** Add a file to the remote baseline (visible to a full list). */
	seedFile(path: string): void;
	/** Add a folder containing one child file to the remote baseline (visible to a full list). */
	seedFolderWithChild(folderPath: string, childName: string): void;
	/** Stage a remote deletion of `path` that the next delta will report. */
	stageRemoteDelete(path: string): void;
	/** Make the next delta fail on page two after the first page has been fetched. */
	failNextDeltaAfterFirstPage(): void;
	/**
	 * Stage a remote rename of a previously-seeded path that the next delta will report.
	 * For a folder (`opts.isFolder`), descendants move with it. Each backend emits its
	 * own faithful delta shape — notably Dropbox emits a delete+add pair and lists the
	 * `deleted(old)` FIRST (the adversarial ordering ADR 0006 makes safe), while the
	 * id-addressed backends emit a single id-keyed change.
	 */
	stageRemoteRename(oldPath: string, newPath: string, opts?: { isFolder?: boolean }): void;
}

/**
 * The crash-safety / convergence contract for {@link CachingRemoteFs}, parameterized
 * over a backend harness. It pins the ADR 0001 invariants at the *base* level so any
 * backend that inherits the base inherits the guarantees too (and a new backend
 * verifies them in one line).
 *
 * The same lifecycle covers process restart and same-process retry: committed state
 * is the only reload source, while an incomplete attempt discards its live working
 * view with `abortWorkingView()`. The contract therefore verifies both replay paths
 * at the FS boundary; the orchestrator only decides whether an attempt completed
 * cleanly enough to commit or must abort.
 */
export function runCachingRemoteFsContract<TFile>(
	name: string,
	makeHarness: () => CachingRemoteFsHarness<TFile>,
): void {
	describe(`CachingRemoteFs crash-safety contract — ${name}`, () => {
		it("a fresh store is no checkpoint: full-scans and warrants no replay", async () => {
			const h = makeHarness();
			h.seedFile("a.md");
			const store = h.makeStore("contract-fresh");
			const fs = h.makeFs(store);

			expect(await fs.hasCheckpoint()).toBe(false);
			// Initial sync: a fresh full scan captured "now", so there is no delta.
			expect(await fs.getChangedPaths()).toBeNull();
			// The fresh scan acquired a live cursor, but only a successful durable
			// checkpoint may make the committed-state query true.
			expect(await fs.hasCheckpoint()).toBe(false);
			await store.close();
		});

		it("a committed checkpoint survives a restart (cursor co-located with the cache)", async () => {
			const h = makeHarness();
			h.seedFile("a.md");
			const store = h.makeStore("contract-restart");

			const fs1 = h.makeFs(store);
			await fs1.list();
			await fs1.commitCheckpoint();

			// A brand-new FS over the same store sees the committed checkpoint with no
			// network re-list — the cursor was persisted in the same transaction as the cache.
			const fs2 = h.makeFs(store);
			expect(await fs2.hasCheckpoint()).toBe(true);
			await store.close();
		});

		it("re-reports an un-pulled remote DELETION after a crash", async () => {
			const h = makeHarness();
			h.seedFile("a.md");
			const store = h.makeStore("contract-crash-del");

			// Session 1: baseline committed at the initial cursor.
			const fs1 = h.makeFs(store);
			await fs1.list();
			await fs1.commitCheckpoint();

			// A remote deletion advances the IN-MEMORY cursor — but the cycle is "killed"
			// before commitCheckpoint, so the committed cache still holds a.md.
			h.stageRemoteDelete("a.md");
			const d1 = await fs1.getChangedPaths();
			expect(d1?.deleted).toContain("a.md");

			// Session 2 (restart) over the same store: the replay restarts from the
			// COMMITTED cursor, so the deletion is re-detected. Under eager cache persist
			// it would be lost — the cache would already have dropped a.md and the replay
			// would early-return on the now-absent path.
			const fs2 = h.makeFs(store);
			const d2 = await fs2.getChangedPaths();
			expect(d2?.deleted).toContain("a.md");
			await store.close();
		});

		it("replays an uncommitted change in-session after aborting the working view", async () => {
			const h = makeHarness();
			h.seedFile("a.md");
			const store = h.makeStore("contract-no-self-heal");

			const fs = h.makeFs(store);
			await fs.list();
			await fs.commitCheckpoint();

			h.stageRemoteDelete("a.md");
			const first = await fs.getChangedPaths();
			expect(first?.deleted).toContain("a.md"); // detected once; in-memory cursor advanced

			await fs.abortWorkingView();

			// Abort invalidates only the live view. The same FS reloads the durable
			// checkpoint and replays the uncommitted deletion from its cursor.
			const second = await fs.getChangedPaths();
			expect(second?.deleted).toContain("a.md");
			expect(await fs.hasCheckpoint()).toBe(true);
			await store.close();
		});

		it("replays a paginated delta after a later page fails", async () => {
			const h = makeHarness();
			h.seedFile("a.md");
			h.seedFile("b.md");
			const store = h.makeStore("contract-abort-page-failure");
			const fs = h.makeFs(store);
			await fs.list();
			await fs.commitCheckpoint();

			h.stageRemoteDelete("a.md");
			h.stageRemoteDelete("b.md");
			h.failNextDeltaAfterFirstPage();
			await expect(fs.getChangedPaths()).rejects.toThrow("injected later page failure");

			await fs.abortWorkingView();
			const replay = await fs.getChangedPaths();
			expect(new Set(replay?.deleted)).toEqual(new Set(["a.md", "b.md"]));
			await store.close();
		});

		it("aborts a fresh working view without creating or clearing a durable checkpoint", async () => {
			const h = makeHarness();
			h.seedFile("a.md");
			const store = h.makeStore("contract-abort-fresh");
			const clear = vi.spyOn(store, "clear");
			const fs = h.makeFs(store);

			await fs.list();
			expect(await fs.hasCheckpoint()).toBe(false);
			h.stageRemoteDelete("a.md");
			// The acquired first-scan view is intentionally stale until its attempt is
			// closed. This makes abort load-bearing rather than a no-op assertion.
			expect(await fs.stat("a.md")).not.toBeNull();
			await fs.abortWorkingView();

			expect(clear).not.toHaveBeenCalled();
			expect(await fs.hasCheckpoint()).toBe(false);
			expect(await fs.stat("a.md")).toBeNull();
			await store.close();
		});

		it("restores committed scope and replay after a checkpoint write fails", async () => {
			const h = makeHarness();
			h.seedFile("a.md");
			const store = h.makeStore("contract-commit-failure-abort");
			const fs = h.makeFs(store);

			await fs.list();
			await fs.commitCheckpoint({ scopeFingerprint: "scope-1" });
			h.stageRemoteDelete("a.md");
			expect((await fs.getChangedPaths())?.deleted).toContain("a.md");
			vi.spyOn(store, "saveAll").mockRejectedValueOnce(new Error("persist failed"));

			await expect(fs.commitCheckpoint({ scopeFingerprint: "scope-2" }))
				.rejects.toThrow("persist failed");
			await fs.abortWorkingView();

			expect(await fs.getScopeFingerprint()).toBe("scope-1");
			expect((await fs.getChangedPaths())?.deleted).toContain("a.md");
			await store.close();
		});

		it("resetCheckpoint discards the committed checkpoint", async () => {
			const h = makeHarness();
			h.seedFile("a.md");
			const store = h.makeStore("contract-reset");

			const fs = h.makeFs(store);
			await fs.list();
			await fs.commitCheckpoint();
			expect(await fs.hasCheckpoint()).toBe(true);

			await fs.resetCheckpoint();
			expect(await fs.hasCheckpoint()).toBe(false);
			await store.close();
		});

		// ── Scope fingerprint (see src/sync/scope-fingerprint.ts) ──
		// Persisted alongside the delta cursor so the orchestrator can force one cold
		// reconcile when a settings change widens sync scope past what the cursor
		// already skipped over.

		it("a fresh checkpoint has no committed scope fingerprint", async () => {
			const h = makeHarness();
			h.seedFile("a.md");
			const store = h.makeStore("contract-scope-fresh");
			const fs = h.makeFs(store);

			expect(await fs.getScopeFingerprint?.()).toBeNull();
			await store.close();
		});

		it("commitCheckpoint persists a given scope fingerprint alongside the cursor", async () => {
			const h = makeHarness();
			h.seedFile("a.md");
			const store = h.makeStore("contract-scope-commit");

			const fs1 = h.makeFs(store);
			await fs1.list();
			await fs1.commitCheckpoint({ scopeFingerprint: "fp-1" });
			expect(await fs1.getScopeFingerprint?.()).toBe("fp-1");

			// Survives a restart — same transaction as the cursor (co-located, ADR 0001).
			const fs2 = h.makeFs(store);
			expect(await fs2.getScopeFingerprint?.()).toBe("fp-1");
			await store.close();
		});

		it("commitCheckpoint without a scope fingerprint keeps the previously-committed one", async () => {
			const h = makeHarness();
			h.seedFile("a.md");
			const store = h.makeStore("contract-scope-keep");

			const fs = h.makeFs(store);
			await fs.list();
			await fs.commitCheckpoint({ scopeFingerprint: "fp-1" });

			h.stageRemoteDelete("a.md");
			await fs.getChangedPaths();
			await fs.commitCheckpoint(); // no scopeFingerprint given

			expect(await fs.getScopeFingerprint?.()).toBe("fp-1");
			await store.close();
		});

		it("resetCheckpoint discards the committed scope fingerprint", async () => {
			const h = makeHarness();
			h.seedFile("a.md");
			const store = h.makeStore("contract-scope-reset");

			const fs = h.makeFs(store);
			await fs.list();
			await fs.commitCheckpoint({ scopeFingerprint: "fp-1" });
			expect(await fs.getScopeFingerprint?.()).toBe("fp-1");

			await fs.resetCheckpoint();
			expect(await fs.getScopeFingerprint?.()).toBeNull();
			await store.close();
		});

		it("treats an unreadable durable checkpoint as absent", async () => {
			const h = makeHarness();
			h.seedFile("a.md");
			const store = h.makeStore("contract-unreadable-checkpoint");
			const fs = h.makeFs(store);
			await fs.list();
			await fs.commitCheckpoint({ scopeFingerprint: "fp-1" });
			vi.spyOn(store, "getMeta").mockRejectedValue(new Error("read failed"));

			expect(await fs.hasCheckpoint()).toBe(false);
			expect(await fs.getScopeFingerprint()).toBeNull();
			await store.close();
		});

		// ── Remote rename detection (ADR 0006) ──
		// A remote rename must surface as a single `renamed` pair, not a delete+add the
		// engine can't coalesce. Each backend's harness emits its own faithful delta;
		// the Dropbox harness lists deleted(old) BEFORE the moved entry, the ordering
		// that previously degraded a folder rename to a file-by-file delete+pull.

		it("reports a remote FILE rename as a single renamed pair (not delete+add)", async () => {
			const h = makeHarness();
			h.seedFile("note.md");
			const store = h.makeStore("contract-rename-file");

			const fs = h.makeFs(store);
			await fs.list();
			await fs.commitCheckpoint();

			h.stageRemoteRename("note.md", "renamed.md");
			const d = await fs.getChangedPaths();
			expect(d?.renamed ?? []).toContainEqual({ oldPath: "note.md", newPath: "renamed.md", isFolder: undefined });
			expect(d?.modified).toContain("renamed.md");
			expect(d?.deleted).toContain("note.md");
			await store.close();
		});

		it("reports a remote FOLDER rename as a single renamed pair, children reparented", async () => {
			const h = makeHarness();
			h.seedFolderWithChild("dir", "b.md");
			const store = h.makeStore("contract-rename-folder");

			const fs = h.makeFs(store);
			await fs.list();
			await fs.commitCheckpoint();

			h.stageRemoteRename("dir", "papers", { isFolder: true });
			const d = await fs.getChangedPaths();

			// Exactly one pair — the folder — NOT a per-child rename and NOT a subtree delete+add.
			expect(d?.renamed).toEqual([{ oldPath: "dir", newPath: "papers", isFolder: true }]);
			expect(d?.deleted).toContain("dir");
			// The folder moved as a unit: the child now lives under the new path.
			expect((await fs.stat("papers"))?.isDirectory).toBe(true);
			expect(await fs.stat("papers/b.md")).not.toBeNull();
			expect(await fs.stat("dir/b.md")).toBeNull();
			await store.close();
		});

		it("replays a folder rename and descendant snapshot after working-view abort", async () => {
			const h = makeHarness();
			h.seedFolderWithChild("dir", "b.md");
			const store = h.makeStore("contract-abort-folder-rename");
			const fs = h.makeFs(store);
			await fs.list();
			await fs.commitCheckpoint();

			h.stageRemoteRename("dir", "papers", { isFolder: true });
			expect((await fs.getChangedPaths())?.renamed).toEqual([
				{ oldPath: "dir", newPath: "papers", isFolder: true },
			]);
			await fs.abortWorkingView();

			expect((await fs.getChangedPaths())?.renamed).toEqual([
				{ oldPath: "dir", newPath: "papers", isFolder: true },
			]);
			expect(await fs.stat("papers/b.md")).not.toBeNull();
			expect(await fs.stat("dir/b.md")).toBeNull();
			await store.close();
		});

		it("reads the post-delta snapshot without consuming the next delta", async () => {
			const h = makeHarness();
			h.seedFolderWithChild("dir", "b.md");
			const store = h.makeStore("contract-snapshot-no-replay");
			const fs = h.makeFs(store);
			await fs.list();
			await fs.commitCheckpoint();

			h.stageRemoteRename("dir", "papers", { isFolder: true });
			const first = await fs.getChangedPaths();
			expect(first?.renamed).toContainEqual({
				oldPath: "dir", newPath: "papers", isFolder: true,
			});

			h.stageRemoteRename("papers", "archive", { isFolder: true });
			const snapshot = await fs.listCurrentSnapshot();
			expect(snapshot.some((entry) => entry.path === "papers/b.md")).toBe(true);
			expect(snapshot.some((entry) => entry.path === "archive/b.md")).toBe(false);

			const second = await fs.getChangedPaths();
			expect(second?.renamed).toContainEqual({
				oldPath: "papers", newPath: "archive", isFolder: true,
			});
			await store.close();
		});
	});
}
