import { describe, it, expect, vi } from "vitest";
import type { MetadataStore } from "../../../src/store/metadata-store";
import type { CachingRemoteFs, RemoteDelta } from "../../../src/fs/caching/remote-fs";
import type { FileEntity } from "../../../src/fs/types";
import type { IFileSystem } from "../../../src/fs/interface";
import { insertConflictSuffix } from "../../../src/sync/conflict";

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
	/**
	 * How this family puts two live provider objects at one derived cache address —
	 * or why it cannot. Required, so the question cannot be left unanswered.
	 */
	collision: CollisionStaging;
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

/** One live provider object staged for a collision, in the provider's own terms. */
export interface CollisionClaimant {
	/** The stable id the provider reports for it. */
	readonly id: string;
	/** The name the provider gives it — its last path segment. */
	readonly name: string;
	/** True when the object is a folder, so other claimants can hang off it. */
	readonly isFolder?: boolean;
	/**
	 * The staged claimant this one hangs off, by id; absent means the bound root.
	 * Parenting by id rather than by path is what lets a child be staged under a
	 * claimant that is about to lose its address.
	 */
	readonly parentId?: string;
	/**
	 * Additional provider parent ids recorded alongside {@link parentId}, listed
	 * BEFORE it — a legacy multi-parent entry whose array order must not matter.
	 */
	readonly alsoParentedBy?: readonly string[];
	/**
	 * The object's only parent is one the bound root does not reach, so the path
	 * resolver falls back to its bare name and its spelling stays a guess.
	 */
	readonly orphaned?: boolean;
}

/**
 * How the working view reaches a staged collision: `"baseline"` only a full listing
 * sees it, `"delta"` the next delta reports it in array order, and `"expired"` the
 * next delta reports its cursor gone so the filesystem full-scans and diffs by id.
 */
export type CollisionRoute = "baseline" | "delta" | "expired";

/**
 * A family's answer to "can two live stable ids claim one derived cache address?".
 *
 * A closed union and a required harness member, so a caching family must answer it:
 * either it stages the shape, or it names the reason and the unsettled unknown the
 * gap rests on. Silence does not compile, and a declared gap carries its citation.
 */
export type CollisionStaging =
	| {
		readonly kind: "stages";
		/**
		 * Put `claimants` on the remote in array order, reached by `route`. A property
		 * rather than a method, so a case can lift it off the harness and drive it.
		 */
		readonly stage: (claimants: readonly CollisionClaimant[], route: CollisionRoute) => void;
	}
	| {
		readonly kind: "cannot";
		/** Why this family's namespace cannot hold two live ids at one address. */
		readonly reason: string;
		/** The unsettled unknown this gap rests on, by its id in `docs/`. */
		readonly unknown: string;
	};

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

		// ── Two live ids at one derived cache address ──
		// A cache address is DERIVED for an id-addressed family: composed from a
		// provider name plus a parent chain, so two live objects can compose the same
		// one. Everything below is asserted through `list`, `stat`, `listDir` and the
		// delta result only — never through the cache, which is exactly the surface a
		// regression would hide behind.

		describe("two live ids at one derived address", () => {
			const declaration = makeHarness().collision;
			if (declaration.kind === "cannot") {
				// Not silence, and not a fabricated fixture: the reason this family's
				// namespace cannot produce the shape, plus the unsettled unknown that
				// would have to be settled before the claim could be made stronger.
				it(`cannot be produced by this family: ${declaration.reason} (${declaration.unknown})`, () => {
					expect(declaration.reason.length).toBeGreaterThan(0);
					expect(declaration.unknown).toMatch(/^unknown-[a-z0-9-]+$/);
				});
				return;
			}

			/** The staging seam, already narrowed to the producing branch. */
			function staged(h: CachingRemoteFsHarness<TFile>) {
				if (h.collision.kind !== "stages") throw new Error("collision staging vanished");
				return h.collision;
			}

			const paths = (entries: readonly FileEntity[]): string[] =>
				entries.map((entry) => entry.path).sort();

			/** The delta's own contention report, as plain comparable rows. */
			const announced = (delta: RemoteDelta | null) =>
				(delta?.contended ?? []).map((fact) => ({
					path: fact.path,
					admittedId: fact.admittedId,
					withheldId: fact.withheldId,
					displacedPaths: [...fact.displacedPaths],
					reason: fact.reason,
					owesRemediation: fact.owesRemediation,
				}));

			/**
			 * The decision inside an announced fact, without the evidence that
			 * legitimately differs between acquisition routes.
			 */
			const decided = (observed: { announced: ReturnType<typeof announced> }) =>
				observed.announced.map(({ displacedPaths: _displaced, ...decision }) => decision);

			/**
			 * A committed baseline holding `first` at `Test.md`, then `second` arriving
			 * at the same address by the given route. The two orderings of one claim
			 * set are the same fixture with the two ids swapped.
			 */
			async function twoIdsAtOneAddress(
				first: string, second: string, route: "delta" | "expired", storeId: string,
			) {
				const h = makeHarness();
				const collision = staged(h);
				collision.stage([{ id: first, name: "Test.md" }], "baseline");
				const store = h.makeStore(storeId);
				const fs = h.makeFs(store);
				await fs.list();
				await fs.commitCheckpoint();

				collision.stage([{ id: second, name: "Test.md" }], route);
				const delta = await fs.getChangedPaths();
				const observed = {
					addressable: (await fs.stat("Test.md"))?.identityKey,
					listed: paths(await fs.list()),
					announced: announced(delta),
					deleted: [...(delta?.deleted ?? [])].sort(),
				};
				await store.close();
				return observed;
			}

			it("keeps one addressable id and names the other in the delta result", async () => {
				const observed = await twoIdsAtOneAddress("A1", "B2", "delta", "contract-collision-one");

				expect(observed.addressable).toBe("A1");
				expect(observed.announced).toEqual([{
					path: "Test.md", admittedId: "A1", withheldId: "B2",
					displacedPaths: [], reason: "lowest_stable_id", owesRemediation: true,
				}]);
				// The withheld object is still on the provider, so its address is absent
				// for a reason that is not a deletion.
				expect(observed.deleted).toEqual([]);
			});

			it("reaches the same assignment when the provider enumerates the pair in reverse", async () => {
				const forward = await twoIdsAtOneAddress("A1", "B2", "delta", "contract-collision-fwd");
				const reverse = await twoIdsAtOneAddress("B2", "A1", "delta", "contract-collision-rev");

				// Order-independence is a claim about the DECISION: whichever of the two
				// the provider happened to show first, the same id holds the address, the
				// same pair is named and nothing is reported deleted.
				expect(decided(reverse)).toEqual(decided(forward));
				expect(reverse.addressable).toBe(forward.addressable);
				expect(reverse.listed).toEqual(forward.listed);
				expect(reverse.deleted).toEqual(forward.deleted);
				expect(forward.addressable).toBe("A1");

				// The EVIDENCE legitimately differs and is checked for what it is FOR,
				// not for a fixed spelling: arriving second the loser never held the
				// address, while arriving first it held it and vacated it. Whatever a
				// family names there is an absence caused by the contention, so it is
				// precisely what must never also be reported as a deletion.
				for (const observed of [forward, reverse]) {
					for (const fact of observed.announced) {
						for (const absent of fact.displacedPaths) {
							expect(observed.deleted).not.toContain(absent);
						}
					}
				}
			});

			/**
			 * Two provider folders named `docs`, in both orders, arriving as one complete
			 * listing. They are one vault folder: both contents under one address, and a
			 * contention only where two of THOSE collide.
			 */
			async function sameNamedFolders(
				d1First: boolean, storeId: string, secondChildren: readonly string[] = ["x.md"],
			) {
				const h = makeHarness();
				const collision = staged(h);
				collision.stage([{ id: "keep", name: "keep.md" }], "baseline");
				const store = h.makeStore(storeId);
				const fs = h.makeFs(store);
				await fs.list();
				await fs.commitCheckpoint();

				const first: CollisionClaimant[] = [
					{ id: "d1", name: "docs", isFolder: true },
					{ id: "c1", name: "a.md", parentId: "d1" },
					{ id: "c2", name: "b.md", parentId: "d1" },
				];
				const second: CollisionClaimant[] = [
					{ id: "d2", name: "docs", isFolder: true },
					...secondChildren.map((name, index): CollisionClaimant => ({ id: `c${index + 3}`, name, parentId: "d2" })),
				];
				collision.stage(d1First ? [...first, ...second] : [...second, ...first], "expired");
				const delta = await fs.getChangedPaths();
				const observed = {
					listed: paths(await fs.list()),
					underDocs: paths(await fs.listDir("docs")),
					folder: (await fs.stat("docs"))?.identityKey,
					announced: announced(delta),
					deleted: [...(delta?.deleted ?? [])].sort(),
				};
				await store.close();
				return observed;
			}

			it("holds both same-named folders' contents under one address, in either order", async () => {
				const d1First = await sameNamedFolders(true, "contract-collision-nested-a");
				const d2First = await sameNamedFolders(false, "contract-collision-nested-b");

				expect(d2First).toEqual(d1First);
				expect(d1First.listed).toEqual(["docs", "docs/a.md", "docs/b.md", "docs/x.md", "keep.md"]);
				expect(d1First.underDocs).toEqual(["docs/a.md", "docs/b.md", "docs/x.md"]);
				// One vault folder, represented by the smallest id.
				expect(d1First.folder).toBe("d1");
				expect(d1First.announced).toEqual([]);
				expect(d1First.deleted).toEqual([]);
			});

			it("contends only a colliding file inside same-named folders, in either order", async () => {
				// The owner's example: docs(d1)/{a.md, b.md} and docs(d2)/{a.md}.
				const d1First = await sameNamedFolders(true, "contract-collision-child-a", ["a.md"]);
				const d2First = await sameNamedFolders(false, "contract-collision-child-b", ["a.md"]);

				expect(d2First).toEqual(d1First);
				expect(d1First.listed).toEqual(["docs", "docs/a.md", "docs/b.md", "keep.md"]);
				expect(d1First.announced).toEqual([{
					path: "docs/a.md", admittedId: "c1", withheldId: "c3",
					displacedPaths: [], reason: "lowest_stable_id", owesRemediation: true,
				}]);
				expect(d1First.deleted).toEqual([]);
			});

			it("decides the same collision outcome whether it is reached cold or by delta", async () => {
				const byDelta = await twoIdsAtOneAddress("A1", "B2", "delta", "contract-collision-parity-d");
				const cold = await twoIdsAtOneAddress("A1", "B2", "expired", "contract-collision-parity-c");

				// The OUTCOME, not the entry set: a cold scan and a delta legitimately
				// hold different entries, because the two path resolvers place a
				// bare-name orphan differently. What must not differ is who holds the
				// address and what the cycle announced about the loss.
				expect(cold.addressable).toBe(byDelta.addressable);
				expect(cold.announced).toEqual(byDelta.announced);
				expect(cold.deleted).toEqual([]);
				expect(byDelta.deleted).toEqual([]);
			});

			it("reports no contested path as deleted after a cursor expiry", async () => {
				// The measured data-loss route: a committed folder loses its address to a
				// newly-listed claimant, and the vanished-id sweep has to tell that apart
				// from the provider dropping the folder. Reporting it would authorize
				// deleting a live file out of the vault. The claimant is a FILE, because a
				// second folder would be merged beside the first and lose nothing.
				const h = makeHarness();
				const collision = staged(h);
				collision.stage([
					{ id: "d2", name: "docs", isFolder: true },
					{ id: "c3", name: "x.md", parentId: "d2" },
				], "baseline");
				const store = h.makeStore("contract-collision-expiry");
				const fs = h.makeFs(store);
				expect(paths(await fs.list())).toEqual(["docs", "docs/x.md"]);
				await fs.commitCheckpoint();

				collision.stage([{ id: "d1", name: "docs" }], "expired");
				const delta = await fs.getChangedPaths();

				expect(delta?.deleted).toEqual([]);
				expect(announced(delta)).toEqual([{
					path: "docs", admittedId: "d1", withheldId: "d2",
					displacedPaths: ["docs/x.md"], reason: "lowest_stable_id", owesRemediation: true,
				}]);
				expect((await fs.stat("docs"))?.identityKey).toBe("d1");
				expect(await fs.stat("docs/x.md")).toBeNull();
				await store.close();
			});

			it("leaves both objects present after the repair, the keeper at the plain address", async () => {
				const h = makeHarness();
				const collision = staged(h);
				collision.stage([{ id: "A1", name: "Test.md" }], "baseline");
				const store = h.makeStore("contract-collision-survival");
				const fs = h.makeFs(store);
				await fs.list();
				await fs.commitCheckpoint();
				collision.stage([{ id: "B2", name: "Test.md" }], "delta");
				expect(announced(await fs.getChangedPaths())[0]?.withheldId).toBe("B2");

				const target = insertConflictSuffix("Test.md", "id-B2");
				const capability: IFileSystem["identityRename"] = (fs as IFileSystem).identityRename;
				if (!capability) {
					// No way to move an object off a contended address, so nothing is done
					// to the provider at all. What must still hold is that nothing was
					// lost: the namespace a cold scan finds is exactly what it was, with
					// no conflict-suffixed address invented on the way.
					const untouched = h.makeStore("contract-collision-survival-untouched");
					const provider = h.makeFs(untouched);
					expect(paths(await provider.list())).toEqual(["Test.md"]);
					await untouched.close();
					await store.close();
					return;
				}
				await capability.renameById("B2", target);

				// In the vault: both reachable, the keeper still at the plain address.
				expect(paths(await fs.list())).toEqual([target, "Test.md"].sort());
				expect((await fs.stat("Test.md"))?.identityKey).toBe("A1");
				expect((await fs.stat(target))?.identityKey).toBe("B2");

				// On the provider: a cold scan through a store that has never seen any of
				// this finds the same two objects, so nothing was lost to repair it.
				const fresh = h.makeStore("contract-collision-survival-provider");
				const provider = h.makeFs(fresh);
				expect(paths(await provider.list())).toEqual([target, "Test.md"].sort());
				await fresh.close();
				await store.close();
			});

			it("does not advance the committed cursor while a claimant is withheld", async () => {
				const h = makeHarness();
				const collision = staged(h);
				collision.stage([{ id: "A1", name: "Test.md" }], "baseline");
				const store = h.makeStore("contract-collision-no-commit");
				const fs = h.makeFs(store);
				await fs.list();
				await fs.commitCheckpoint();

				collision.stage([{ id: "B2", name: "Test.md" }], "delta");
				const first = announced(await fs.getChangedPaths());
				expect(first).toHaveLength(1);

				// The cycle owed a repair, so it aborted instead of committing. The next
				// cycle replays from the same committed cursor and re-observes the same
				// contention — which is what makes the repair idempotently retryable.
				await fs.abortWorkingView();
				const replay = await fs.getChangedPaths();

				expect(announced(replay)).toEqual(first);
				expect(replay?.deleted).toEqual([]);
				await store.close();
			});
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
