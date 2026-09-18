import "fake-indexeddb/auto";
import { describe, it, expect, vi } from "vitest";
import type { GoogleDriveClient } from "../../../src/fs/googledrive/client";
import type { GoogleDriveFile, GoogleDriveChange } from "../../../src/fs/googledrive/types";
import { FOLDER_MIME } from "../../../src/fs/googledrive/types";
import type { RemoteDelta } from "../../../src/fs/caching/remote-fs";
import type { FileEntity } from "../../../src/fs/types";
import { MetadataStore } from "../../../src/store/metadata-store";
import { GoogleDriveFs } from "../../../src/fs/googledrive";
import { runCachingRemoteFsContract } from "../contracts/caching-remote-fs.contract";
import type {
	CachingRemoteFsHarness, CollisionClaimant, CollisionRoute,
} from "../contracts/caching-remote-fs.contract";

vi.mock("obsidian");

/** A parent id the bound root never reaches — the fake's "somewhere else in the Drive". */
const OUTSIDE_ID = "outside";

/**
 * A parent id that is in a file's `parents` but in nobody's listing.
 *
 * `listAllFiles` walks folder by folder and its result is explicitly NOT a
 * point-in-time snapshot (`googledrive/list-all.ts`), so a file listed under a
 * folder whose own entry left the root during the same walk arrives carrying a
 * parent id the result set does not contain. That is the case the production
 * bare-name fallback exists for, and the only way this family produces a claim
 * whose spelling is a guess rather than provider topology.
 */
const VANISHED_PARENT_ID = "vanished";

const MODIFIED_TIME = "2024-01-01T00:00:00.000Z";

/** One baseline item: `name` is its path segment, `parentId` places it in the tree. */
function gdFile(id: string, name: string, parentId: string): GoogleDriveFile {
	return { id, name, mimeType: "text/plain", parents: [parentId], modifiedTime: MODIFIED_TIME };
}

function gdFolder(id: string, name: string, parentId: string): GoogleDriveFile {
	return { id, name, mimeType: FOLDER_MIME, parents: [parentId], modifiedTime: MODIFIED_TIME };
}

// Run the shared base crash-safety contract against the REAL GoogleDriveFs (not the
// mock backend), via a minimal GoogleDriveClient stub over an in-memory remote — a baseline
// of Google Drive files plus an append-only changes.list log. This proves the A1 lift kept
// Google Drive's ADR 0001 path-1 behaviour intact through the new seams, and answers
// "the contract is only ever run by the mock". The same shared lifecycle covers
// restart and same-process abort/reload.
function makeGoogleDriveHarness(): CachingRemoteFsHarness<GoogleDriveFile> {
	const baseline = new Map<string, GoogleDriveFile>();
	const events: GoogleDriveChange[] = [];
	/** Folder path → id, for folders seeded outside the bound root. */
	const outsideFolders = new Map<string, string>();
	/** Ids whose parent is not in any listing — see {@link VANISHED_PARENT_ID}. */
	const vanishedParentIds = new Set<string>();
	let idSeq = 0;
	let failAfterFirstPage = false;
	let expireNextDelta = false;
	const head = () => `c${events.length}`;

	/**
	 * The real `listAllFiles(folderId)` walks that folder's subtree and returns its
	 * DESCENDANTS (not the folder itself), parents before children. Honouring the
	 * argument is what makes the fake faithful in both directions: a root listing
	 * excludes anything parented outside the root, and the incremental re-listing of
	 * an entered folder sees that folder's subtree rather than the whole Drive.
	 */
	const listSubtree = (folderId: string): GoogleDriveFile[] => {
		const descendants: GoogleDriveFile[] = [];
		const folderIds = [folderId];
		for (let i = 0; i < folderIds.length; i++) {
			const parentId = folderIds[i]!;
			for (const file of baseline.values()) {
				if (!file.parents?.includes(parentId)) continue;
				descendants.push(file);
				if (file.mimeType === FOLDER_MIME) folderIds.push(file.id);
			}
		}
		// A file whose listed parent left the root mid-walk still comes back from the
		// folder query that returned it; only its parent's entry is missing.
		for (const id of vanishedParentIds) {
			const file = baseline.get(id);
			if (file) descendants.push(file);
		}
		return descendants;
	};

	const client = {
		listAllFiles: (folderId: string) => Promise.resolve(listSubtree(folderId)),
		getFile: (id: string) => Promise.resolve({
			id, name: "root", mimeType: FOLDER_MIME, parents: [],
			modifiedTime: "2024-01-01T00:00:00.000Z",
		}),
		getChangesStartToken: () => Promise.resolve(head()),
		updateFileMetadata: (fileId: string, metadata: { name?: string }) => {
			const current = baseline.get(fileId);
			if (!current) return Promise.reject(new Error(`updateFileMetadata: no such file "${fileId}"`));
			// Only the final segment moves; the object keeps the parent it already has.
			const updated: GoogleDriveFile = { ...current, name: metadata.name ?? current.name };
			baseline.set(fileId, updated);
			events.push({ type: "file", fileId, removed: false, file: updated });
			return Promise.resolve(updated);
		},
		listChanges: (from: string, pageToken?: string) => {
			if (expireNextDelta) {
				// Drive answers a changes token it no longer recognizes with a 410, which
				// is what sends the filesystem down the full-scan-and-diff-by-id route.
				expireNextDelta = false;
				return Promise.reject(Object.assign(new Error("Gone"), { status: 410 }));
			}
			if (pageToken === "contract-second-page") {
				failAfterFirstPage = false;
				return Promise.reject(new Error("injected later page failure"));
			}
			const idx = from.startsWith("c") ? Number(from.slice(1)) : 0;
			if (failAfterFirstPage) {
				return Promise.resolve({
					changes: events.slice(idx, idx + 1),
					nextPageToken: "contract-second-page",
				});
			}
			return Promise.resolve({ changes: events.slice(idx), newStartPageToken: head() });
		},
	} as unknown as GoogleDriveClient;

	/**
	 * Place claimants on the Drive in array order. A Drive path is DERIVED — a name
	 * composed onto a parent chain — so two live ids reach one address whenever two
	 * objects compose the same spelling, which is exactly what this stages.
	 */
	const stageCollision = (claimants: readonly CollisionClaimant[], route: CollisionRoute): void => {
		if (route === "expired") expireNextDelta = true;
		for (const claimant of claimants) {
			const parents = claimant.orphaned
				? [VANISHED_PARENT_ID]
				: [...(claimant.alsoParentedBy ?? []), claimant.parentId ?? "root"];
			const file: GoogleDriveFile = {
				id: claimant.id,
				name: claimant.name,
				mimeType: claimant.isFolder ? FOLDER_MIME : "text/plain",
				parents,
				modifiedTime: MODIFIED_TIME,
			};
			baseline.set(claimant.id, file);
			if (claimant.orphaned) vanishedParentIds.add(claimant.id);
			// `changes.list` reports one change per changed item, so a claim reaches the
			// working view through the delta exactly in the order it is staged.
			if (route === "delta") events.push({ type: "file", fileId: claimant.id, removed: false, file });
		}
	};

	return {
		collision: { kind: "stages", stage: stageCollision },
		makeStore: (id) => new MetadataStore<GoogleDriveFile>(id, { dbNamePrefix: "air-sync-googledrive-contract", version: 1 }),
		makeFs: (store) => new GoogleDriveFs(client, "root", undefined, store),
		seedFile: (path) => {
			const id = `f${++idSeq}`;
			baseline.set(id, gdFile(id, path, "root"));
		},
		seedFolderWithChild: (folderPath, childName) => {
			const folderId = `d${++idSeq}`;
			const childId = `f${++idSeq}`;
			baseline.set(folderId, gdFolder(folderId, folderPath, "root"));
			baseline.set(childId, gdFile(childId, childName, folderId));
		},
		// The subtree exists in the Drive but hangs off a parent the bound root never
		// reaches, so the scoped listing above cannot see it and changes.list — driven
		// only by `events` — reports nothing about it.
		seedFolderOutsideRoot: (folderPath) => {
			const folderId = `d${++idSeq}`;
			const subId = `d${++idSeq}`;
			const aId = `f${++idSeq}`;
			const bId = `f${++idSeq}`;
			baseline.set(folderId, gdFolder(folderId, folderPath, OUTSIDE_ID));
			baseline.set(aId, gdFile(aId, "a.md", folderId));
			baseline.set(subId, gdFolder(subId, "sub", folderId));
			baseline.set(bId, gdFile(bId, "b.md", subId));
			outsideFolders.set(folderPath, folderId);
		},
		// live-probe-googledrive: an account-wide changes.list drain reports EXACTLY ONE
		// change for a folder moved into the root — the folder itself, re-parented. Its
		// descendants keep their own parents, so Drive emits nothing for them.
		stageMoveIntoRoot: (folderPath) => {
			const folderId = outsideFolders.get(folderPath);
			if (!folderId) throw new Error(`stageMoveIntoRoot: no folder seeded outside the root at "${folderPath}"`);
			outsideFolders.delete(folderPath);
			const moved: GoogleDriveFile = { ...baseline.get(folderId)!, parents: ["root"] };
			baseline.set(folderId, moved);
			events.push({ type: "file", fileId: folderId, removed: false, file: moved });
		},
		stageRemoteDelete: (path) => {
			const entry = [...baseline.values()].find((f) => f.name === path);
			if (!entry) throw new Error(`stageRemoteDelete: no such file "${path}"`);
			baseline.delete(entry.id);
			events.push({ type: "file", fileId: entry.id, removed: true });
		},
		failNextDeltaAfterFirstPage: () => { failAfterFirstPage = true; },
		// Google Drive is id-addressed: a rename is a SINGLE change carrying the file's new
		// name. A folder's children keep their parent id (their paths are derived), so they
		// are NOT re-emitted — the cache reparents them from the one folder change.
		stageRemoteRename: (oldPath, newPath, opts) => {
			const match = opts?.isFolder
				? (f: GoogleDriveFile) => f.name === oldPath && f.mimeType === FOLDER_MIME
				: (f: GoogleDriveFile) => f.name === oldPath;
			const entry = [...baseline.values()].find(match);
			if (!entry) throw new Error(`stageRemoteRename: no such path "${oldPath}"`);
			const renamed: GoogleDriveFile = { ...entry, name: newPath };
			baseline.set(entry.id, renamed);
			events.push({ type: "file", fileId: entry.id, removed: false, file: renamed });
		},
	};
}


/**
 * The shapes only Google Drive has: a `/` inside a provider NAME, a claim whose
 * spelling is a bare-name guess, and a legacy multi-parent entry. They are
 * Drive-specific by construction, so they stay out of the backend-agnostic contract
 * and are asserted here through the same vocabulary — `list`, `stat`, `listDir` and
 * the delta result.
 */
function registerGoogleDriveCollisionShapes(): void {
	const announced = (delta: RemoteDelta | null) =>
		(delta?.contended ?? []).map((fact) => ({
			path: fact.path,
			admittedId: fact.admittedId,
			withheldId: fact.withheldId,
			displacedPaths: [...fact.displacedPaths],
			reason: fact.reason,
			owesRemediation: fact.owesRemediation,
		}));
	const paths = (entries: readonly FileEntity[]): string[] =>
		entries.map((entry) => entry.path).sort();
	const stageWith = (h: CachingRemoteFsHarness<GoogleDriveFile>) => {
		if (h.collision.kind !== "stages") throw new Error("Google Drive must stage collisions");
		return h.collision.stage;
	};

	describe("Google Drive collision shapes", () => {
		it("settles a name containing a slash against the folder it spells its way into", async () => {
			// Drive names may contain "/", and a cache path is composed with "/" — so a
			// root file NAMED "x/y.md" derives the same address as y.md inside folder x.
			const h = makeGoogleDriveHarness();
			const stage = stageWith(h);
			stage([
				{ id: "fx", name: "x", isFolder: true },
				{ id: "fy", name: "y.md", parentId: "fx" },
			], "baseline");
			const store = h.makeStore("gd-collision-slash-in-name");
			const fs = h.makeFs(store);
			await fs.list();
			await fs.commitCheckpoint();

			stage([{ id: "z1", name: "x/y.md" }], "delta");
			const delta = await fs.getChangedPaths();

			expect((await fs.stat("x/y.md"))?.identityKey).toBe("fy");
			expect(announced(delta)).toEqual([{
				path: "x/y.md", admittedId: "fy", withheldId: "z1",
				displacedPaths: [], reason: "lowest_stable_id", owesRemediation: true,
			}]);
			// The folder's real child is still where it was; nothing was deleted.
			expect(paths(await fs.listDir("x"))).toEqual(["x/y.md"]);
			expect(delta?.deleted).toEqual([]);
			await store.close();
		});

		it("collapses a bare-name guess under its resolved twin and owes the provider nothing", async () => {
			const h = makeGoogleDriveHarness();
			const stage = stageWith(h);
			stage([{ id: "k1", name: "keep.md" }], "baseline");
			const store = h.makeStore("gd-collision-orphan");
			const fs = h.makeFs(store);
			await fs.list();
			await fs.commitCheckpoint();

			// "aaa" would win the lowest-id tier; it loses on authority instead, because
			// its spelling is a guess rather than provider topology.
			stage([
				{ id: "zzz", name: "orphan.md" },
				{ id: "aaa", name: "orphan.md", orphaned: true },
			], "expired");
			const delta = await fs.getChangedPaths();

			expect(announced(delta)).toEqual([{
				path: "orphan.md", admittedId: "zzz", withheldId: "aaa",
				displacedPaths: [], reason: "path_authority",
				// The fact that stops a repair being planned at all: the guess addresses
				// an object outside the working area, so there is nothing there to move.
				owesRemediation: false,
			}]);
			expect(delta?.deleted).toEqual([]);

			// No provider mutation: a cold scan through a store that has never seen any
			// of this finds the same namespace, with no conflict-suffixed address in it.
			const fresh = h.makeStore("gd-collision-orphan-provider");
			const provider = h.makeFs(fresh);
			const providerPaths = paths(await provider.list());
			expect(providerPaths).toEqual(["keep.md", "orphan.md"]);
			expect(providerPaths.some((path) => path.includes(".conflict-"))).toBe(false);
			await fresh.close();
			await store.close();
		});

		it("reads a legacy multi-parent entry the same whatever order its parents are in", async () => {
			// `findRelevantParentId` prefers the bound root wherever it sits in the
			// array, so a legacy entry parented both inside and outside the root must
			// give one answer — including when it is the one holding a contended address.
			async function observe(extraParentFirst: boolean, storeId: string) {
				const h = makeGoogleDriveHarness();
				const stage = stageWith(h);
				stage([{ id: "k1", name: "keep.md" }], "baseline");
				const store = h.makeStore(storeId);
				const fs = h.makeFs(store);
				await fs.list();
				await fs.commitCheckpoint();

				stage([
					{ id: "fx", name: "x", isFolder: true },
					{ id: "m1", name: "shared.md", parentId: "fx",
						alsoParentedBy: extraParentFirst ? [OUTSIDE_ID] : [] },
					{ id: "m2", name: "shared.md", parentId: "fx" },
				], "expired");
				const delta = await fs.getChangedPaths();
				const observed = {
					listed: paths(await fs.list()),
					addressable: (await fs.stat("x/shared.md"))?.identityKey,
					announced: announced(delta),
					deleted: [...(delta?.deleted ?? [])].sort(),
				};
				await store.close();
				return observed;
			}

			const varied = await observe(true, "gd-collision-multiparent-varied");
			const plain = await observe(false, "gd-collision-multiparent-plain");

			expect(varied).toEqual(plain);
			expect(plain.listed).toEqual(["keep.md", "x", "x/shared.md"]);
			expect(plain.addressable).toBe("m1");
			expect(plain.announced).toEqual([{
				path: "x/shared.md", admittedId: "m1", withheldId: "m2",
				displacedPaths: [], reason: "lowest_stable_id", owesRemediation: true,
			}]);
			expect(plain.deleted).toEqual([]);
		});
	});
}

export function registerGoogleDriveCachingContract(): void {
	runCachingRemoteFsContract("GoogleDriveFs", makeGoogleDriveHarness);
	registerGoogleDriveCollisionShapes();
}
