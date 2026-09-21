import { describe, expect, it, vi } from "vitest";
import { applyIdDeltaPage, createIdDeltaResult } from "./id-delta";
import type { IdDeltaEntry, IdDeltaResult } from "./id-delta";
import type { FileEntity, PathAuthority } from "../types";
import type { RemoteObject } from "../../backend-api";
import { AbstractMetadataCache } from "./metadata-cache";
import { NormalizedMetadataCache } from "../managed/normalized-metadata-cache";

vi.mock("obsidian");

const ROOT = "root";

/**
 * One upsert entry, as each backend's raw→IdDeltaEntry mapping produces it. The one
 * place in this file that builds the normalized shape — every fixture below reaches
 * the applier through it, whichever cache it drives.
 */
function upsertEntry<TFile>(id: string, file: TFile, isFolder = false): IdDeltaEntry<TFile> {
	return { id, isFolder, file };
}

/**
 * The identity a `list()`/`stat()` of `path` would report — the cache's own entity
 * projection. Pairs are asserted against THIS rather than against the raw delta id,
 * so a backend whose projection diverged from its id would fail the case instead of
 * passing on a coincidence.
 */
function projectedIdentity<TFile>(cache: AbstractMetadataCache<TFile>, path: string): string | undefined {
	return cache.toEntity(path, cache.getFile(path)!).identityKey;
}

function managedFile(id: string, name: string, parentId: string): RemoteObject {
	return { kind: "file", id, name, location: { addressing: "parent_id", parentId } };
}

function managedFolder(id: string, name: string, parentId: string): RemoteObject {
	return { kind: "directory", id, name, location: { addressing: "parent_id", parentId } };
}

// applyIdDeltaPage is the shared move/rename classifier behind Google Drive's
// `changes.list` and OneDrive's `/delta`. These fixtures drive it through the
// normalized cache the production managed path uses, so the projection under test
// is the real one.

describe("applyIdDeltaPage — the pair names the moved object", () => {
	const seeded = (...files: RemoteObject[]): NormalizedMetadataCache => {
		const cache = new NormalizedMetadataCache(ROOT);
		cache.buildFromFiles(files);
		return cache;
	};

	it("carries the delta entry's own id as the moved FILE's identity", () => {
		const cache = seeded(managedFile("m-1", "note.md", ROOT));
		const acc = createIdDeltaResult();

		applyIdDeltaPage(cache, acc, [upsertEntry("m-1", managedFile("m-1", "renamed.md", ROOT))]);

		expect(acc.renamedPaths).toEqual([{
			oldPath: "note.md",
			newPath: "renamed.md",
			isFolder: undefined,
			identityKey: projectedIdentity(cache, "renamed.md"),
		}]);
		expect(acc.renamedPaths[0]?.identityKey).toBe("m-1");
	});

	it("carries the delta entry's own id as the moved FOLDER's identity", () => {
		const cache = seeded(
			managedFolder("m-dir", "dir", ROOT),
			managedFile("m-child", "b.md", "m-dir"),
		);
		const acc = createIdDeltaResult();

		applyIdDeltaPage(cache, acc, [upsertEntry("m-dir", managedFolder("m-dir", "papers", ROOT), true)]);

		expect(acc.renamedPaths).toEqual([{
			oldPath: "dir",
			newPath: "papers",
			isFolder: true,
			identityKey: projectedIdentity(cache, "papers"),
		}]);
		expect(acc.renamedPaths[0]?.identityKey).toBe("m-dir");
		// The reparented child is reported as changed, not as a second rename pair.
		expect(cache.hasFile("papers/b.md")).toBe(true);
		expect(acc.changedPaths).toContain("papers/b.md");
	});

	// An in-place modify and a tombstone report no pair at all, so there is no path
	// on which a producer could attach an identity to something that did not move.
	it("reports no pair — and so no identity — for an in-place modify", () => {
		const cache = seeded(managedFile("m-1", "note.md", ROOT));
		const acc = createIdDeltaResult();

		applyIdDeltaPage(cache, acc, [upsertEntry("m-1", managedFile("m-1", "note.md", ROOT))]);

		expect(acc.renamedPaths).toEqual([]);
		expect(acc.changedPaths).toContain("note.md");
	});
});

/**
 * The minimal concrete cache, shaped like an id-addressed provider entry. The
 * applier is backend-agnostic, so driving it through the abstract class exercises
 * the real cache algorithms with no backend, no client and no provider request.
 */
interface TestFile {
	id: string;
	name: string;
	parents: string[];
	folder?: boolean;
}

class TestMetadataCache extends AbstractMetadataCache<TestFile> {
	protected extractId(file: TestFile): string { return file.id; }
	protected extractParentIds(file: TestFile): string[] { return file.parents; }
	protected extractName(file: TestFile): string { return file.name; }
	protected isFolderEntry(file: TestFile): boolean { return file.folder === true; }
	toEntity(path: string, file: TestFile): FileEntity {
		return {
			path,
			pathAuthority: this.getPathAuthority(path),
			identityKey: file.id,
			isDirectory: file.folder === true,
			size: 0,
			mtime: 0,
			hash: "",
		};
	}
}

const file = (id: string, name: string, ...parents: string[]): TestFile => ({ id, name, parents });
const folder = (id: string, name: string, ...parents: string[]): TestFile =>
	({ id, name, parents, folder: true });

/** An upsert entry for `f`, classified exactly as a backend's `toEntries` would. */
const upsert = (f: TestFile): IdDeltaEntry<TestFile> => upsertEntry(f.id, f, f.folder === true);
/** A tombstone entry: the provider says this id is gone. */
const tombstone = (id: string): IdDeltaEntry<TestFile> => ({ id, isFolder: false, file: undefined });

function makeCache(): TestMetadataCache {
	return new TestMetadataCache(ROOT);
}

/** Seed the working view the way a restored checkpoint would. */
function seed(cache: TestMetadataCache, rows: [string, TestFile, PathAuthority?][]): void {
	for (const [path, f, authority = "actual_resolved"] of rows) cache.setFile(path, f, authority);
}

/** Everything one drain publishes, in a shape `toEqual` can compare directly. */
function published(acc: IdDeltaResult): unknown {
	return {
		changedPaths: [...acc.changedPaths].sort(),
		renamedPaths: [...acc.renamedPaths].sort((a, b) => (a.oldPath < b.oldPath ? -1 : 1)),
		count: acc.count,
		enteredFolderIds: [...acc.enteredFolderIds].sort(),
		displacements: acc.displacements,
		withheld: acc.withheld,
	};
}

/** The closing working view, so two drains can be compared on cache state too. */
function contents(cache: TestMetadataCache): [string, string][] {
	return [...cache.entries()].map(([path]): [string, string] => [path, cache.idAt(path)!]).sort();
}

/** Every way one ordered entry stream can be cut into pages (2^(n-1) splits). */
function pageSplits<T>(entries: readonly T[]): T[][][] {
	if (entries.length === 0) return [[]];
	const splits: T[][][] = [];
	const cuts = entries.length - 1;
	for (let mask = 0; mask < 1 << cuts; mask++) {
		const pages: T[][] = [[entries[0]!]];
		for (let i = 0; i < cuts; i++) {
			if (mask & (1 << i)) pages.push([entries[i + 1]!]);
			else pages[pages.length - 1]!.push(entries[i + 1]!);
		}
		splits.push(pages);
	}
	return splits;
}

/** Drive one whole drain: every page through the shared applier, in order. */
function drain(cache: TestMetadataCache, pages: IdDeltaEntry<TestFile>[][]): IdDeltaResult {
	const acc = createIdDeltaResult();
	for (const page of pages) applyIdDeltaPage(cache, acc, [...page]);
	return acc;
}

describe("applyIdDeltaPage", () => {
	describe("the measured folder fixture", () => {
		/**
		 * `docs` is cached as a bare-name guess (`requested_echo`) with two children;
		 * the delta brings a provider-resolved folder of the same name. Before this
		 * unit the drain published `changedPaths = ["docs"]` and the two children were
		 * simply gone from the working view, with nothing naming them.
		 */
		function seedCollision(): { cache: TestMetadataCache; acc: IdDeltaResult } {
			const cache = makeCache();
			seed(cache, [
				["docs", folder("d1", "docs", ROOT), "requested_echo"],
				["docs/a.md", file("c1", "a.md", "d1")],
				["docs/b.md", file("c2", "b.md", "d1")],
			]);
			const acc = drain(cache, [[upsert(folder("d2", "docs", ROOT))]]);
			return { cache, acc };
		}

		it("names the withheld id and both child paths instead of leaving changedPaths=[docs] alone", () => {
			const { acc } = seedCollision();

			expect([...acc.changedPaths]).toEqual(["docs"]);
			expect(acc.withheld).toEqual([{
				path: "docs",
				admittedId: "d2",
				withheldId: "d1",
				displacedPaths: ["docs/a.md", "docs/b.md"],
				reason: "path_authority",
				owesRemediation: false,
				vacatedPath: "docs",
			}]);
		});

		it("publishes the absent addresses flattened, so an absence rule has one set to subtract", () => {
			const { acc } = seedCollision();

			expect(acc.displacements).toEqual([{
				path: "docs",
				admittedId: "d2",
				withheldId: "d1",
				displacedPaths: ["docs", "docs/a.md", "docs/b.md"],
				reason: "path_authority",
				owesRemediation: false,
			}]);
		});

		it("still hands the admitted folder to the working view", () => {
			const { cache } = seedCollision();

			expect(cache.idAt("docs")).toBe("d2");
			expect(cache.getPathById("d1")).toBeUndefined();
		});

		it("settles a tie between two provider-resolved claims on the lowest stable id", () => {
			const cache = makeCache();
			seed(cache, [["docs", folder("d2", "docs", ROOT)], ["docs/a.md", file("c1", "a.md", "d2")]]);

			// A file: a second folder would be merged beside d2, not contend with it.
			const acc = drain(cache, [[upsert(file("d1", "docs", ROOT))]]);

			expect(cache.idAt("docs")).toBe("d1");
			expect(acc.withheld).toEqual([expect.objectContaining({
				withheldId: "d2",
				reason: "lowest_stable_id",
				owesRemediation: true,
				displacedPaths: ["docs/a.md"],
			})]);
		});

		it("merges a provider-resolved folder arriving at a folder's address, contents and all", () => {
			const cache = makeCache();
			seed(cache, [["docs", folder("d2", "docs", ROOT)], ["docs/a.md", file("c1", "a.md", "d2")]]);

			const acc = drain(cache, [[upsert(folder("d1", "docs", ROOT)), upsert(file("c2", "b.md", "d1"))]]);

			expect(acc.withheld).toEqual([]);
			expect(cache.idsAt("docs")).toEqual(["d1", "d2"]);
			expect(cache.idAt("docs/a.md")).toBe("c1");
			expect(cache.idAt("docs/b.md")).toBe("c2");
		});
	});

	describe("a folder moving into a same-named one", () => {
		it("reports its files' moves and its subfolders as changed, with no folder pair", () => {
			const cache = makeCache();
			seed(cache, [
				["docs", folder("d1", "docs", ROOT)],
				["old", folder("d2", "old", ROOT)],
				["old/sub", folder("s2", "sub", "d2")],
				["old/sub/deep.md", file("c3", "deep.md", "s2")],
			]);

			const acc = drain(cache, [[upsert(folder("d2", "docs", ROOT))]]);

			expect(acc.renamedPaths).toEqual([{
				oldPath: "old/sub/deep.md", newPath: "docs/sub/deep.md", identityKey: "c3",
			}]);
			expect([...acc.changedPaths].sort()).toEqual([
				"docs", "docs/sub", "docs/sub/deep.md", "old", "old/sub", "old/sub/deep.md",
			]);
		});
	});

	/**
	 * Every case below is a contention between a FILE holding an address and a claim
	 * on it: two provider-resolved folders are one vault folder and never contend.
	 */
	describe("a contention is not final until the drain ends", () => {
		it("readmits the withheld claimant when a later page tombstones the admitted id", () => {
			const cache = makeCache();
			seed(cache, [["docs", file("d1", "docs", ROOT)]]);

			const acc = drain(cache, [
				[upsert(folder("d2", "docs", ROOT))],
				[tombstone("d1")],
			]);

			expect(cache.idAt("docs")).toBe("d2");
			expect(acc.changedPaths).toEqual(new Set(["docs"]));
		});

		it("withdraws the contention before publication rather than announcing a settled loss", () => {
			const cache = makeCache();
			seed(cache, [["docs", file("d1", "docs", ROOT)]]);

			const acc = drain(cache, [
				[upsert(folder("d2", "docs", ROOT))],
				[tombstone("d1")],
			]);

			expect(acc.withheld).toEqual([]);
			expect(acc.displacements).toEqual([]);
			expect(acc.standing.size).toBe(0);
		});

		it("keeps the contention when the tombstone names the losing id instead", () => {
			const cache = makeCache();
			seed(cache, [["docs", file("d1", "docs", ROOT)]]);

			const acc = drain(cache, [
				[upsert(folder("d2", "docs", ROOT))],
				[tombstone("d2")],
			]);

			// The provider says the losing object is gone, so there is no standing
			// contention left to announce and nothing to readmit.
			expect(cache.idAt("docs")).toBe("d1");
			expect(acc.withheld).toEqual([]);
		});

		it("still announces the loss when nothing in the drain frees the address", () => {
			const cache = makeCache();
			seed(cache, [["docs", file("d1", "docs", ROOT)]]);

			const acc = drain(cache, [
				[upsert(folder("d2", "docs", ROOT))],
				[upsert(file("n1", "note.md", ROOT))],
			]);

			expect(acc.withheld).toEqual([expect.objectContaining({ withheldId: "d2", admittedId: "d1" })]);
			expect(cache.getPathById("d2")).toBeUndefined();
		});
	});

	describe("settlement closes the page before the caller walks its re-listing targets", () => {
		it("puts a folder admitted at settlement into enteredFolderIds", () => {
			const cache = makeCache();
			seed(cache, [["docs", file("d1", "docs", ROOT)]]);

			const acc = drain(cache, [
				[upsert(folder("d2", "docs", ROOT))],
				[tombstone("d1")],
			]);

			// `relistTargets` reads this set after the drain returns, so a folder that
			// only became addressable at settlement still gets its subtree re-listed.
			expect([...acc.enteredFolderIds]).toEqual(["d2"]);
			expect(cache.getPathById("d2")).toBe("docs");
		});

		it("reports a readmission from a vacated address as the move it is", () => {
			const cache = makeCache();
			seed(cache, [
				["docs", file("d1", "docs", ROOT)],
				["old", folder("d2", "old", ROOT)],
				["old/a.md", file("c1", "a.md", "d2")],
			]);

			const acc = drain(cache, [
				[upsert(folder("d2", "docs", ROOT))],
				[tombstone("d1")],
			]);

			expect(cache.idAt("docs")).toBe("d2");
			// A readmitted claimant's pair names the object by the same projection every
			// other pair uses — the move is reported once, identity included.
			expect(acc.renamedPaths).toEqual([{
				oldPath: "old",
				newPath: "docs",
				isFolder: true,
				identityKey: projectedIdentity(cache, "docs"),
			}]);
			expect(acc.renamedPaths[0]?.identityKey).toBe("d2");
			expect([...acc.changedPaths].sort()).toEqual(["docs", "old", "old/a.md"]);
		});
	});

	describe("the two causes of applyFileChange returning no new path", () => {
		it("reports a move outside the tracked root as a deletion, subtree included", () => {
			const cache = makeCache();
			seed(cache, [
				["docs", folder("d1", "docs", ROOT)],
				["docs/a.md", file("c1", "a.md", "d1")],
			]);

			const acc = drain(cache, [[upsert(folder("d1", "docs", "somewhere-else"))]]);

			expect([...acc.changedPaths].sort()).toEqual(["docs", "docs/a.md"]);
			expect(acc.withheld).toEqual([]);
			expect(acc.displacements).toEqual([]);
		});

		it("reports a withheld claimant's vacated address as displaced, never as a deletion", () => {
			const cache = makeCache();
			seed(cache, [
				["docs", file("d1", "docs", ROOT)],
				["old", folder("d2", "old", ROOT)],
				["old/a.md", file("c1", "a.md", "d2")],
			]);

			const acc = drain(cache, [
				[upsert(folder("d2", "docs", ROOT))],
				[upsert(file("n1", "note.md", ROOT))],
			]);

			expect([...acc.changedPaths]).toEqual(["note.md"]);
			expect(acc.withheld).toEqual([{
				path: "docs",
				admittedId: "d1",
				withheldId: "d2",
				displacedPaths: ["old/a.md"],
				reason: "lowest_stable_id",
				owesRemediation: true,
				vacatedPath: "old",
			}]);
			expect(acc.displacements[0]?.displacedPaths).toEqual(["old", "old/a.md"]);
		});

		it("leaves a displaced folder's own child entry with no absence to misreport", () => {
			const cache = makeCache();
			seed(cache, [
				["docs", folder("d1", "docs", ROOT), "requested_echo"],
				["docs/a.md", file("c1", "a.md", "d1")],
			]);

			// The loser's whole subtree goes with it, so the child's own later entry has
			// no old path left — it can never reach the out-of-root branch.
			const acc = drain(cache, [
				[upsert(folder("d2", "docs", ROOT))],
				[upsert(file("c1", "a.md", "d1"))],
			]);

			expect([...acc.changedPaths]).toEqual(["docs"]);
		});
	});

	describe("the published result does not depend on how the drain was paginated", () => {
		const entries = [
			upsert(folder("d2", "docs", ROOT)),
			tombstone("d1"),
			upsert(file("n1", "note.md", ROOT)),
			upsert(file("n2", "memo.md", ROOT)),
		];

		function seeded(): TestMetadataCache {
			const cache = makeCache();
			seed(cache, [
				["docs", folder("d1", "docs", ROOT)],
				["docs/a.md", file("c1", "a.md", "d1")],
			]);
			return cache;
		}

		it("publishes the same result and the same working view for every page split", () => {
			const splits = pageSplits(entries);
			expect(splits.length).toBe(8);

			const reference = seeded();
			const expected = {
				result: published(drain(reference, [entries])),
				contents: contents(reference),
			};

			for (const pages of splits) {
				const cache = seeded();
				const acc = drain(cache, pages);

				expect({ result: published(acc), contents: contents(cache) }).toEqual(expected);
			}
		});

		it("announces two contentions in one order, whichever page carried which", () => {
			const claims = [upsert(folder("d2", "docs", ROOT)), upsert(folder("e2", "notes", ROOT))];

			for (const pages of pageSplits(claims).concat(pageSplits([...claims].reverse()))) {
				const cache = makeCache();
				seed(cache, [["docs", file("d1", "docs", ROOT)], ["notes", file("e1", "notes", ROOT)]]);

				const acc = drain(cache, pages);

				expect(acc.withheld.map((claim) => [claim.path, claim.withheldId]))
					.toEqual([["docs", "d2"], ["notes", "e2"]]);
			}
		});

		it("names the same admitted and withheld id whichever claim the drain saw first", () => {
			const claims = [file("d1", "docs", ROOT), file("d2", "docs", ROOT)];

			for (const [first, second] of [claims, [...claims].reverse()]) {
				const cache = makeCache();
				const acc = drain(cache, [[upsert(first!)], [upsert(second!)]]);

				expect(cache.idAt("docs")).toBe("d1");
				expect(acc.withheld.map((claim) => [claim.admittedId, claim.withheldId]))
					.toEqual([["d1", "d2"]]);
			}
		});
	});

	describe("nothing accumulated survives the drain", () => {
		it("leaves the cache with no instance field of its own", () => {
			const cache = makeCache();
			const before = Object.getOwnPropertyNames(cache).sort();
			seed(cache, [["docs", folder("d1", "docs", ROOT)]]);

			drain(cache, [[upsert(folder("d2", "docs", ROOT))], [tombstone("d1")]]);

			expect(Object.getOwnPropertyNames(cache).sort()).toEqual(before);
			expect(before).toEqual([
				"children", "folders", "idToPath", "logger", "mergedFolders", "pathAuthorities", "pathToFile",
				"rootFolderId",
			]);
		});

		it("re-derives the same contention from the same facts rather than remembering it", () => {
			const cache = makeCache();
			seed(cache, [["docs", folder("d1", "docs", ROOT)]]);

			const first = drain(cache, [[upsert(folder("d2", "docs", ROOT))]]);
			const second = drain(cache, [[upsert(folder("d2", "docs", ROOT))]]);

			expect(second.withheld).toEqual(first.withheld);
			expect(second.displacements).toEqual(first.displacements);
		});

		it("does not let an earlier drain's loss withhold an uncontested claim", () => {
			const cache = makeCache();
			seed(cache, [["docs", folder("d1", "docs", ROOT)]]);
			drain(cache, [[upsert(folder("d2", "docs", ROOT))]]);

			const after = drain(cache, [[tombstone("d1")], [upsert(folder("d2", "docs", ROOT))]]);

			expect(cache.idAt("docs")).toBe("d2");
			expect(after.withheld).toEqual([]);
		});
	});

	describe("the entries that carry no contention behave exactly as before", () => {
		it("reports an upsert, a rename and a tombstone unchanged", () => {
			const cache = makeCache();
			seed(cache, [
				["notes", folder("d1", "notes", ROOT)],
				["notes/a.md", file("c1", "a.md", "d1")],
				["gone.md", file("g1", "gone.md", ROOT)],
			]);

			const acc = drain(cache, [[
				upsert(file("n1", "new.md", ROOT)),
				upsert(folder("d1", "docs", ROOT)),
				tombstone("g1"),
			]]);

			expect([...acc.changedPaths].sort())
				.toEqual(["docs", "docs/a.md", "gone.md", "new.md", "notes", "notes/a.md"]);
			expect(acc.renamedPaths).toEqual([{
				oldPath: "notes",
				newPath: "docs",
				isFolder: true,
				identityKey: projectedIdentity(cache, "docs"),
			}]);
			expect(acc.renamedPaths[0]?.identityKey).toBe("d1");
			expect(acc.count).toBe(3);
			expect(acc.withheld).toEqual([]);
		});
	});
});
