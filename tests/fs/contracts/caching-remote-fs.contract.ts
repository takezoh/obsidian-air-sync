import { describe, it, expect, vi } from "vitest";
import type { MetadataStore } from "../../../src/store/metadata-store";
import type { FileEntity } from "../../../src/fs/types";
import type { CachingRemoteFs } from "../../../src/fs/caching/remote-fs";

/**
 * What a backend family's OWN `FileEntity` projection makes of the identity of an
 * object this contract moves — declared by the harness, never inferred by the case.
 *
 * `RenamePair.identityKey` is optional by contract (ADR 0008's third state: a missing
 * key is no evidence), so an expectation built straight out of
 * `(await fs.stat(newPath))?.identityKey` would still be satisfied if the family
 * reported no identity AND the producer carried none — `toEqual` ignores an
 * `undefined` expectation. The declaration closes that: a family whose projection
 * names every moved object asserts a non-empty provider identity, and a family whose
 * projection legitimately yields none asserts that ABSENCE explicitly, with its
 * reason. There is no third answer and no way to leave the question unanswered.
 */
export interface MovedObjectIdentity {
	/** True when the family's projection names every object this contract moves. */
	determinate: boolean;
	/**
	 * Why — cited against the family's own projection, not the cache's address
	 * functions. Asserted non-empty by the conformance cases, so it cannot decay
	 * into decoration.
	 */
	reason: string;
}

/**
 * The delta orderings a family's provider can faithfully emit for ONE rename.
 *
 * ADR 0006's order-independence, extended to the identity the pair now carries: an
 * id-addressed family encodes a rename as a single id-keyed change and has no second
 * ordering at all, while Dropbox encodes it as `deleted(old)` + `file/folder(new)`
 * sharing an id and may window the two either way round.
 */
export type RenameOrderings =
	| {
		/**
		 * The delta carries ONE entry per rename, so no ordering of it exists to vary.
		 * A positive claim, not a bare absence: dropping to this from `orderable-pair`
		 * is an explicit change of what the family says its provider does.
		 */
		encoding: "single-entry";
		/** Why. Asserted non-empty, so the claim can never decay into decoration. */
		reason: string;
	}
	| {
		/** The delta carries a tombstone AND the moved entry, in either order. */
		encoding: "orderable-pair";
		/** Why. Asserted non-empty, so the claim can never decay into decoration. */
		reason: string;
		/**
		 * Stage the same rename in the reverse of
		 * {@link CachingRemoteFsHarness.stageRemoteRename}'s ordering.
		 */
		stageReversed: (oldPath: string, newPath: string, opts?: { isFolder?: boolean }) => void;
	};

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
	/**
	 * Create, OUTSIDE the bound root, a folder at `folderPath` already holding `a.md`
	 * and `sub/b.md`. None of it is visible to a full root listing or to any delta
	 * until {@link stageMoveIntoRoot} moves it in.
	 */
	seedFolderOutsideRoot(folderPath: string): void;
	/**
	 * Move a folder seeded by {@link seedFolderOutsideRoot} under the bound root, keeping
	 * its name. The next delta reports the move in the backend's own recorded live shape —
	 * Google Drive's `changes.list` reports ONLY the folder, while OneDrive's and Dropbox's
	 * deltas carry the folder plus every pre-existing descendant.
	 */
	stageMoveIntoRoot(folderPath: string): void;
	/**
	 * What this family's entity projection makes of a moved object's identity.
	 *
	 * Optional HERE because the base machinery's own driver
	 * (`src/fs/caching/remote-fs.contract.test.ts`) is not a provider family and has no
	 * family projection to declare; every registered backend family supplies it, because
	 * {@link RemoteFamilyCachingHarness} re-declares it as required and each family's
	 * harness factory is annotated with that type — a family that omits it is a compile
	 * error, not a skipped case.
	 */
	movedObjectIdentity?: MovedObjectIdentity;
}

/**
 * What a REGISTERED BACKEND FAMILY supplies on top of the base harness, so the carried
 * rename identity can be asserted across every family in one shared place.
 *
 * The three members are required, so the cross-family cases cannot be silently skipped
 * by a family that forgets to stage them. The base driver in
 * `src/fs/caching/remote-fs.contract.test.ts` keeps implementing only
 * {@link CachingRemoteFsHarness}: it drives the base machinery, and cross-family
 * conformance is by construction a per-family obligation registered through the sole
 * composition root (`tests/fs/remote-backend-contracts.test.ts`).
 */
export interface RemoteFamilyCachingHarness<TFile> extends CachingRemoteFsHarness<TFile> {
	movedObjectIdentity: MovedObjectIdentity;
	renameOrderings: RenameOrderings;
	/**
	 * Delete whatever the remote currently holds at `path` and create a DIFFERENT
	 * provider object at that same address. The next delta reports it in the family's
	 * own faithful shape, tombstone first — for Dropbox that is exactly the path-keyed
	 * `upsertedPaths` reclaim shape ADR 0006 guards.
	 *
	 * This is what makes a stale-cache-keyed identity observable: the address outlives
	 * the object that used to occupy it.
	 */
	stageRemoteRecreateWithNewId(path: string): void;
}

/**
 * The identity a `stat` of `path` reports, checked against the family's declared
 * disposition before any case uses it as an expectation.
 *
 * A determinate family must report a non-empty provider identity here, so a rename
 * cell's `identityKey:` expectation can never be satisfied vacuously by two absent
 * values; a family that declared no identity must report none, so nothing (least of all
 * a cache-internal address) can quietly stand in for it. A base driver that declares
 * nothing is still held to "the destination exists".
 */
function movedIdentityOf(
	entity: FileEntity | null,
	path: string,
	declared: MovedObjectIdentity | undefined,
): string | undefined {
	expect(entity, `stat("${path}") reports nothing to name the moved object by`).not.toBeNull();
	const identityKey = entity!.identityKey;
	if (declared?.determinate) {
		expect(typeof identityKey, declared.reason).toBe("string");
		expect(identityKey, declared.reason).not.toBe("");
	} else if (declared) {
		expect(identityKey, declared.reason).toBeUndefined();
	}
	return identityKey;
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
			// The pair names the moved object by the identity a `stat` of the destination
			// reports — read through the public surface only, never off the cache, and
			// held to the family's declared disposition so the expectation is never vacuous.
			const identityKey = movedIdentityOf(await fs.stat("renamed.md"), "renamed.md", h.movedObjectIdentity);
			expect(d?.renamed ?? []).toContainEqual({ oldPath: "note.md", newPath: "renamed.md", isFolder: undefined, identityKey });
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
			const moved = await fs.stat("papers");
			const identityKey = movedIdentityOf(moved, "papers", h.movedObjectIdentity);
			expect(d?.renamed).toEqual([{ oldPath: "dir", newPath: "papers", isFolder: true, identityKey }]);
			expect(d?.deleted).toContain("dir");
			// The folder moved as a unit: the child now lives under the new path.
			expect(moved?.isDirectory).toBe(true);
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
			const beforeAbort = (await fs.getChangedPaths())?.renamed;
			const identityKey = movedIdentityOf(await fs.stat("papers"), "papers", h.movedObjectIdentity);
			expect(beforeAbort).toEqual([
				{ oldPath: "dir", newPath: "papers", isFolder: true, identityKey },
			]);
			await fs.abortWorkingView();

			// The replayed pair names the same object, identity included.
			expect((await fs.getChangedPaths())?.renamed).toEqual([
				{ oldPath: "dir", newPath: "papers", isFolder: true, identityKey },
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
			const identityKey = movedIdentityOf(await fs.stat("papers"), "papers", h.movedObjectIdentity);
			expect(first?.renamed).toContainEqual({
				oldPath: "dir", newPath: "papers", isFolder: true, identityKey,
			});

			h.stageRemoteRename("papers", "archive", { isFolder: true });
			const snapshot = await fs.listCurrentSnapshot();
			expect(snapshot.some((entry) => entry.path === "papers/b.md")).toBe(true);
			expect(snapshot.some((entry) => entry.path === "archive/b.md")).toBe(false);

			const second = await fs.getChangedPaths();
			expect(second?.renamed).toContainEqual({
				oldPath: "papers", newPath: "archive", isFolder: true,
				identityKey: movedIdentityOf(await fs.stat("archive"), "archive", h.movedObjectIdentity),
			});
			await store.close();
		});

		// ── Scope entry: a folder with pre-existing descendants moves INTO the root ──
		// The required fact is the same for every family — the working view must end up
		// holding what a cold scan would — while the deltas that carry it differ: Google
		// Drive reports only the moved folder (its unchanged descendants produce no
		// change at all), OneDrive and Dropbox report the whole subtree. Each harness
		// emits its family's recorded live shape, so a backend that leaves the
		// descendants unenumerated reports only "F" here and fails.

		it("reports a folder entering the bound root with its whole pre-existing subtree", async () => {
			const h = makeHarness();
			h.seedFile("keep.md");
			h.seedFolderOutsideRoot("F");
			const store = h.makeStore("contract-scope-entry");
			const fs = h.makeFs(store);

			// Scope consistency: the full listing and the delta must agree on what is
			// inside the root. Without this, a fake that leaks outside items into the
			// baseline would satisfy the exact-set assertion below for the wrong reason.
			const before = (await fs.list()).map((entry) => entry.path);
			expect(before).toContain("keep.md");
			for (const path of ["F", "F/a.md", "F/sub", "F/sub/b.md", "a.md", "sub", "b.md"]) {
				expect(before).not.toContain(path);
			}
			await fs.commitCheckpoint();

			h.stageMoveIntoRoot("F");
			const d = await fs.getChangedPaths();

			// Exact set: the folder AND every descendant, none of them as a deletion and
			// none of them as a rename (nothing moved WITHIN the root).
			expect([...(d?.modified ?? [])].sort()).toEqual(["F", "F/a.md", "F/sub", "F/sub/b.md"]);
			expect(d?.deleted).toEqual([]);
			expect(d?.renamed ?? []).toEqual([]);
			expect(await fs.stat("F/sub/b.md")).not.toBeNull();

			// The uncommitted attempt is discarded and replayed from committed state
			// alone: re-observing the same remote must yield the same complete subtree.
			await fs.abortWorkingView();
			const replay = await fs.getChangedPaths();
			expect([...(replay?.modified ?? [])].sort()).toEqual(["F", "F/a.md", "F/sub", "F/sub/b.md"]);
			await store.close();
		});
	});
}

/**
 * Everything {@link runCachingRemoteFsContract} pins, plus the cross-family conformance
 * of the identity a `RenamePair` now carries. Every registered backend family runs this
 * one; the base machinery's own driver runs only the base contract.
 *
 * The obligation is cross-family by nature — three families project identity from three
 * different provider shapes, and Dropbox alone reports a rename as an orderable pair of
 * entries — so it is stated once here, in the observable vocabulary the harnesses
 * already use, and asserted through the public `IFileSystem` surface only. No case
 * reads a cache, a private field, or a backend type.
 */
export function runRemoteFamilyCachingContract<TFile>(
	name: string,
	makeHarness: () => RemoteFamilyCachingHarness<TFile>,
): void {
	runCachingRemoteFsContract(name, makeHarness);

	describe(`CachingRemoteFs carried rename identity — ${name}`, () => {
		it("names the moved object by its own projection, or records that it has none", async () => {
			const h = makeHarness();
			h.seedFile("note.md");
			const store = h.makeStore("contract-identity-disposition");
			const fs = h.makeFs(store);
			await fs.list();
			await fs.commitCheckpoint();

			// Every family answers here, and the answer is its own: none may leave the
			// question open, because the declaration is required on the harness and its
			// reason is asserted.
			const declared = h.movedObjectIdentity;
			expect(declared.reason, "cite why this family's projection does or does not name a moved object").not.toBe("");

			h.stageRemoteRename("note.md", "renamed.md");
			const pair = ((await fs.getChangedPaths())?.renamed ?? []).find((p) => p.newPath === "renamed.md");
			expect(pair, "the rename must surface as a pair at all").toBeDefined();

			const observed = await fs.stat("renamed.md");
			expect(observed).not.toBeNull();
			if (declared.determinate) {
				// Determinate: a non-empty provider identity, equal to the one a `stat` of
				// the destination reports.
				expect(typeof observed!.identityKey, declared.reason).toBe("string");
				expect(observed!.identityKey, declared.reason).not.toBe("");
				expect(pair!.identityKey, declared.reason).toBe(observed!.identityKey);
			} else {
				// Unknown: an asserted ABSENCE with the reason cited, never a silent skip
				// and never a substitute — no synthetic or cache-internal address may
				// stand in for a provider identity the projection does not have.
				expect(observed!.identityKey, declared.reason).toBeUndefined();
				expect(pair!.identityKey, declared.reason).toBeUndefined();
			}
			await store.close();
		});

		it("carries one FILE's identity under either faithful provider ordering", async () => {
			const h = makeHarness();
			h.seedFile("note.md");
			const store = h.makeStore("contract-identity-ordering-file");
			const fs = h.makeFs(store);
			await fs.list();
			await fs.commitCheckpoint();

			const identity = movedIdentityOf(await fs.stat("note.md"), "note.md", h.movedObjectIdentity);
			expect(h.renameOrderings.reason, "cite the rename orderings this provider can emit").not.toBe("");

			// Ordering A — the family's own default. Dropbox's harness lists the
			// deleted(old) tombstone FIRST, the ordering ADR 0006 makes safe.
			h.stageRemoteRename("note.md", "renamed.md");
			expect((await fs.getChangedPaths())?.renamed ?? []).toContainEqual({
				oldPath: "note.md", newPath: "renamed.md", isFolder: undefined, identityKey: identity,
			});
			expect(movedIdentityOf(await fs.stat("renamed.md"), "renamed.md", h.movedObjectIdentity)).toBe(identity);
			await fs.commitCheckpoint();

			// Ordering B — the SAME object moved back under the provider's other faithful
			// ordering. An id-addressed family has none (ADR 0006: a single id-keyed
			// change is inherently order-independent) and repeats its only one; the
			// reason asserted above is what records that rather than hiding it.
			stageOtherOrdering(h)("renamed.md", "note.md");
			expect((await fs.getChangedPaths())?.renamed ?? []).toContainEqual({
				oldPath: "renamed.md", newPath: "note.md", isFolder: undefined, identityKey: identity,
			});
			expect(movedIdentityOf(await fs.stat("note.md"), "note.md", h.movedObjectIdentity)).toBe(identity);
			await store.close();
		});

		it("carries one FOLDER's identity under either faithful provider ordering", async () => {
			const h = makeHarness();
			h.seedFolderWithChild("dir", "b.md");
			const store = h.makeStore("contract-identity-ordering-folder");
			const fs = h.makeFs(store);
			await fs.list();
			await fs.commitCheckpoint();

			const identity = movedIdentityOf(await fs.stat("dir"), "dir", h.movedObjectIdentity);

			// The shape ADR 0006 was written about: for Dropbox the folder AND every
			// descendant produce a tombstone and a moved entry, so the two orderings
			// interleave differently — and the folder's carried identity must not care.
			h.stageRemoteRename("dir", "papers", { isFolder: true });
			expect((await fs.getChangedPaths())?.renamed).toEqual([
				{ oldPath: "dir", newPath: "papers", isFolder: true, identityKey: identity },
			]);
			expect(await fs.stat("papers/b.md")).not.toBeNull();
			await fs.commitCheckpoint();

			stageOtherOrdering(h)("papers", "dir", { isFolder: true });
			expect((await fs.getChangedPaths())?.renamed).toEqual([
				{ oldPath: "papers", newPath: "dir", isFolder: true, identityKey: identity },
			]);
			expect(movedIdentityOf(await fs.stat("dir"), "dir", h.movedObjectIdentity)).toBe(identity);
			expect(await fs.stat("dir/b.md")).not.toBeNull();
			await store.close();
		});

		it("never carries the identity of a different object seen earlier at the old path", async () => {
			const h = makeHarness();
			h.seedFile("note.md");
			const store = h.makeStore("contract-identity-reclaimed-address");
			const fs = h.makeFs(store);
			await fs.list();
			await fs.commitCheckpoint();

			// The object this FS has already observed at "note.md" — the one a producer
			// that keyed the carried identity off cache state left over from an earlier
			// observation would still be naming two deltas later.
			const firstOccupant = movedIdentityOf(await fs.stat("note.md"), "note.md", h.movedObjectIdentity);

			// The address is reclaimed by a DIFFERENT provider object: a tombstone and a
			// new id at the same path, in one delta.
			h.stageRemoteRecreateWithNewId("note.md");
			await fs.getChangedPaths();
			await fs.commitCheckpoint();
			const secondOccupant = movedIdentityOf(await fs.stat("note.md"), "note.md", h.movedObjectIdentity);
			if (h.movedObjectIdentity.determinate) {
				expect(secondOccupant, "the recreate must install a genuinely different object").not.toBe(firstOccupant);
			}

			// Moving the CURRENT occupant names the current occupant. `oldPath` is an
			// address the pair reports, never a place an identity is looked up from.
			h.stageRemoteRename("note.md", "renamed.md");
			const pair = ((await fs.getChangedPaths())?.renamed ?? []).find((p) => p.newPath === "renamed.md");
			expect(pair, "the rename must surface as a pair at all").toBeDefined();
			expect(pair!.identityKey)
				.toBe(movedIdentityOf(await fs.stat("renamed.md"), "renamed.md", h.movedObjectIdentity));
			expect(pair!.identityKey).toBe(secondOccupant);
			if (h.movedObjectIdentity.determinate) {
				expect(
					pair!.identityKey,
					"the pair carries the identity of the object that USED to hold this address",
				).not.toBe(firstOccupant);
			}
			await store.close();
		});
	});
}

/**
 * The provider's other faithful ordering for one rename, or its only one when its delta
 * carries a single entry. Read from the harness per call, so the declared
 * `stageReversed` is never captured at registration time.
 */
function stageOtherOrdering<TFile>(
	h: RemoteFamilyCachingHarness<TFile>,
): (oldPath: string, newPath: string, opts?: { isFolder?: boolean }) => void {
	return (oldPath, newPath, opts) =>
		h.renameOrderings.encoding === "orderable-pair"
			? h.renameOrderings.stageReversed(oldPath, newPath, opts)
			: h.stageRemoteRename(oldPath, newPath, opts);
}
