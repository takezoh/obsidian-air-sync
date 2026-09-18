import { describe, it, expect, vi } from "vitest";
import type { FileEntity, PathAuthority } from "../types";
import type { Logger } from "../../logging/logger";
import { AbstractMetadataCache, type AddressDisplacement } from "./metadata-cache";

const ROOT = "root";

/**
 * The minimal concrete cache. `AbstractMetadataCache` is abstract and its five
 * seams are the only backend-specific parts, so a fixture shaped like an
 * id-addressed provider entry (stable id, name, parent ids, folder flag) exercises
 * the shared algorithms directly — no backend, no client, no provider request.
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

/**
 * Asserts the bijection AFTER EVERY MUTATION rather than only at the end: each
 * writer is wrapped, and `bulkLoad`/`buildFromFiles` route through the wrapped
 * `setFile`, so an intermediate state that maps one path to two ids (or one id to
 * two paths) fails on the call that produced it.
 */
class BijectiveCache extends TestMetadataCache {
	private readonly seen = new Set<string>();

	override setFile(path: string, file: TestFile, pathAuthority?: PathAuthority): AddressDisplacement | null {
		this.seen.add(file.id);
		const result = super.setFile(path, file, pathAuthority);
		this.check();
		return result;
	}

	override bulkLoad(items: Iterable<[string, TestFile, PathAuthority?]>): readonly AddressDisplacement[] {
		const result = super.bulkLoad(items);
		this.check();
		return result;
	}

	override buildFromFiles(files: TestFile[]): readonly AddressDisplacement[] {
		for (const file of files) this.seen.add(file.id);
		const result = super.buildFromFiles(files);
		this.check();
		return result;
	}

	override applyFileChange(file: TestFile): ReturnType<TestMetadataCache["applyFileChange"]> {
		this.seen.add(file.id);
		const result = super.applyFileChange(file);
		this.check();
		return result;
	}

	private check(): void {
		const rows = this.exportRecords();
		expect(rows.length).toBe(this.size);
		// path → id is injective: distinct paths never collapse onto one id.
		expect(this.snapshotPathsById().size).toBe(this.size);
		for (const row of rows) {
			const id = this.idAt(row.path);
			expect(id).toBeDefined();
			expect(this.getPathById(id!)).toBe(row.path);
		}
		// id → path is injective too, and no id lingers on a path that no longer holds it.
		for (const id of this.seen) {
			const path = this.getPathById(id);
			if (path !== undefined) expect(this.idAt(path)).toBe(id);
		}
	}
}

function makeCache(logger?: Logger): BijectiveCache {
	return new BijectiveCache(ROOT, logger);
}

/** A logger double whose `warn` spy is handed back separately, so assertions never
 * reference a class method off the `Logger` type. */
function fakeLogger(): { logger: Logger; warn: ReturnType<typeof vi.fn> } {
	const warn = vi.fn();
	return {
		logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger,
		warn,
	};
}

const file = (id: string, name: string, ...parents: string[]): TestFile => ({ id, name, parents });
const folder = (id: string, name: string, ...parents: string[]): TestFile =>
	({ id, name, parents, folder: true });

/** Every permutation, so order-independence is driven exhaustively rather than sampled. */
function permutations<T>(items: readonly T[]): T[][] {
	if (items.length <= 1) return [[...items]];
	const out: T[][] = [];
	for (let i = 0; i < items.length; i++) {
		const rest = [...items.slice(0, i), ...items.slice(i + 1)];
		for (const tail of permutations(rest)) out.push([items[i]!, ...tail]);
	}
	return out;
}

/**
 * The cache-level source of `list()`: every tracked path with the id that holds it,
 * its folder flag and its projected authority, order-normalized.
 */
function listing(cache: TestMetadataCache): string[] {
	return cache.exportRecords()
		.map((row) =>
			`${row.path}|${cache.idAt(row.path)}|${row.isFolder}|${cache.getPathAuthority(row.path)}`)
		.sort();
}

/** The cache-level source of `stat()`: the projected entity for every tracked path. */
function stats(cache: TestMetadataCache): FileEntity[] {
	return [...cache.entries()]
		.map(([path, entry]) => cache.toEntity(path, entry))
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

describe("AbstractMetadataCache claim-set assignment", () => {
	describe("buildFromFiles announces every contended address", () => {
		it("returns the displacement instead of losing a sibling silently", () => {
			const cache = makeCache();

			const displacements = cache.buildFromFiles([
				file("f1", "Test.md", ROOT),
				file("f2", "Test.md", ROOT),
			]);

			expect(displacements).toEqual([{
				path: "Test.md",
				admittedId: "f1",
				withheldId: "f2",
				displacedPaths: [],
				reason: "lowest_stable_id",
				owesRemediation: true,
			}]);
			expect(cache.idAt("Test.md")).toBe("f1");
			expect(cache.getPathById("f2")).toBeUndefined();
		});

		it("admits the same id in either listing order", () => {
			const both = [file("f1", "Test.md", ROOT), file("f2", "Test.md", ROOT)];

			for (const order of permutations(both)) {
				const cache = makeCache();
				const displacements = cache.buildFromFiles(order);

				expect(cache.idAt("Test.md")).toBe("f1");
				expect(displacements.map((d) => d.withheldId)).toEqual(["f2"]);
			}
		});

		it("demotes a bare-name guess under a provider-resolved sibling in either order", () => {
			// The orphan-collapse pair: "aaa" would win the lowest-id tier, so this
			// also pins that the authority tier is applied first.
			const orphan = file("aaa", "orphan.md", "missing-parent");
			const child = file("zzz", "orphan.md", ROOT);

			for (const order of permutations([orphan, child])) {
				const cache = makeCache();
				const displacements = cache.buildFromFiles(order);

				expect(cache.idAt("orphan.md")).toBe("zzz");
				expect(displacements).toEqual([{
					path: "orphan.md",
					admittedId: "zzz",
					withheldId: "aaa",
					displacedPaths: [],
					reason: "path_authority",
					// An out-of-root guess, not a genuine duplicate: nothing to rename.
					owesRemediation: false,
				}]);
			}
		});

		it("names every loser at an address three ids claimed, in a stable order", () => {
			const cache = makeCache();

			const displacements = cache.buildFromFiles([
				file("c", "Test.md", ROOT),
				file("a", "Test.md", ROOT),
				file("b", "Test.md", ROOT),
			]);

			expect(cache.idAt("Test.md")).toBe("a");
			expect(displacements.map((d) => d.withheldId)).toEqual(["b", "c"]);
		});

		it("announces two contended addresses in one stable order", () => {
			const cache = makeCache();

			const displacements = cache.buildFromFiles([
				file("f1", "a.md", ROOT),
				file("f2", "a.md", ROOT),
				file("g1", "b.md", ROOT),
				file("g2", "b.md", ROOT),
			]);

			expect(displacements.map((d) => `${d.path}/${d.withheldId}`))
				.toEqual(["a.md/f2", "b.md/g2"]);
		});

		it("terminates on a cyclic parent chain and displaces nothing for it", () => {
			const cache = makeCache();

			const displacements = cache.buildFromFiles([
				folder("d1", "docs", ROOT),
				folder("d2", "docs", ROOT),
				folder("cyc1", "A", "cyc2"),
				folder("cyc2", "B", "cyc1"),
			]);

			expect(displacements.map((d) => d.withheldId)).toEqual(["d2"]);
			expect(cache.getPathById("cyc1")).toBeDefined();
			expect(cache.getPathById("cyc2")).toBeDefined();
		});

		it("emits one warn per contended address", () => {
			const { logger, warn } = fakeLogger();
			const cache = makeCache(logger);

			cache.buildFromFiles([file("f1", "Test.md", ROOT), file("f2", "Test.md", ROOT)]);

			expect(warn).toHaveBeenCalledWith("Contended cache address", expect.objectContaining({
				path: "Test.md",
				admittedId: "f1",
				withheldId: "f2",
			}));
		});
	});

	describe("the loss propagates down resolved parent-id ancestry", () => {
		// docs=d1{a.md,b.md} vs docs=d2{x.md}: the permutation both earlier drafts fail.
		const nestedCollision = [
			folder("d1", "docs", ROOT),
			file("c1", "a.md", "d1"),
			file("c2", "b.md", "d1"),
			folder("d2", "docs", ROOT),
			file("c3", "x.md", "d2"),
		];

		it("yields identical contents and displacements for every permutation", () => {
			const orders = permutations(nestedCollision);
			const reference = makeCache();
			const referenceDisplacements = reference.buildFromFiles(orders[0]!);

			expect(listing(reference)).toEqual([
				"docs/a.md|c1|false|actual_resolved",
				"docs/b.md|c2|false|actual_resolved",
				"docs|d1|true|actual_resolved",
			]);
			expect(referenceDisplacements).toEqual([{
				path: "docs",
				admittedId: "d1",
				withheldId: "d2",
				displacedPaths: ["docs/x.md"],
				reason: "lowest_stable_id",
				owesRemediation: true,
			}]);

			for (const order of orders) {
				const cache = makeCache();
				const displacements = cache.buildFromFiles(order);

				expect({ order: order.map((f) => f.id), listing: listing(cache) })
					.toEqual({ order: order.map((f) => f.id), listing: listing(reference) });
				expect(stats(cache)).toEqual(stats(reference));
				expect(displacements).toEqual(referenceDisplacements);
				// The loser's child never reaches the winner's folder, in ANY order —
				// including the ones where it was listed before its parent lost.
				expect(cache.getPathById("c3")).toBeUndefined();
				expect(cache.hasFile("docs/x.md")).toBe(false);
			}
		});

		it("propagates through a chain of folders, not just one level", () => {
			const cache = makeCache();

			const displacements = cache.buildFromFiles([
				folder("d1", "docs", ROOT),
				folder("d2", "docs", ROOT),
				folder("s2", "sub", "d2"),
				file("leaf", "deep.md", "s2"),
			]);

			expect(displacements).toEqual([{
				path: "docs",
				admittedId: "d1",
				withheldId: "d2",
				displacedPaths: ["docs/sub", "docs/sub/deep.md"],
				reason: "lowest_stable_id",
				owesRemediation: true,
			}]);
			expect(listing(cache)).toEqual(["docs|d1|true|actual_resolved"]);
		});

		it("does NOT displace an entry that merely spells its way under the contended path", () => {
			// A root-level object whose provider NAME contains a separator resolves to a
			// path under "docs/" without ever having "docs" as a parent. A string-prefix
			// cascade would wrongly evict it with d2; ancestry keeps it.
			const cache = makeCache();

			cache.buildFromFiles([
				folder("d1", "docs", ROOT),
				folder("d2", "docs", ROOT),
				file("c3", "x.md", "d2"),
				file("spoof", "docs/spoof.md", ROOT),
			]);

			expect(cache.idAt("docs/spoof.md")).toBe("spoof");
			expect(cache.getPathById("c3")).toBeUndefined();
		});

		it("keeps a legacy multi-parent entry identical for both orders of its parents", () => {
			// findRelevantParentId prefers rootFolderId, so both orders resolve through
			// the root — including when the OTHER in-scope parent is the withheld folder.
			const base = [folder("d1", "docs", ROOT), folder("d2", "docs", ROOT)];
			const rootFirst = { id: "m1", name: "m.md", parents: [ROOT, "d2"] };
			const rootSecond = { id: "m1", name: "m.md", parents: ["d2", ROOT] };

			const first = makeCache();
			const firstDisplacements = first.buildFromFiles([...base, rootFirst]);
			const second = makeCache();
			const secondDisplacements = second.buildFromFiles([...base, rootSecond]);

			expect(listing(second)).toEqual(listing(first));
			expect(secondDisplacements).toEqual(firstDisplacements);
			expect(first.idAt("m.md")).toBe("m1");
		});
	});

	describe("bulkLoad", () => {
		it("keeps the duplicate-stable-id throw's exact message", () => {
			const cache = makeCache();

			expect(() => cache.bulkLoad([
				["a.md", file("f1", "a.md", ROOT)],
				["b.md", file("f1", "b.md", ROOT)],
			])).toThrow('Metadata cache contains duplicate stable id "f1" at "a.md" and "b.md"');
		});

		it("keeps that throw's breadth: two claims at one path are loaded, not rejected", () => {
			const cache = makeCache();

			const displacements = cache.bulkLoad([
				["a.md", file("f1", "a.md", ROOT), "actual_resolved"],
				["a.md", file("f2", "a.md", ROOT), "actual_resolved"],
			]);

			expect(cache.idAt("a.md")).toBe("f2");
			expect(displacements).toEqual([{
				path: "a.md",
				admittedId: "f2",
				withheldId: "f1",
				displacedPaths: [],
				reason: "upsert_rekey",
				owesRemediation: false,
			}]);
		});

		it("lets buildFromFiles keep the duplicate-stable-id throw for a repeated id at one path", () => {
			const cache = makeCache();
			const twice = file("f1", "Test.md", ROOT);

			expect(() => cache.buildFromFiles([twice, twice]))
				.toThrow('Metadata cache contains duplicate stable id "f1" at "Test.md" and "Test.md"');
		});
	});

	describe("setFile's occupant branch", () => {
		it("returns the path, both ids and every removed descendant path", () => {
			const { logger, warn } = fakeLogger();
			const cache = makeCache(logger);
			cache.setFile("docs", folder("d1", "docs", ROOT), "actual_resolved");
			cache.setFile("docs/a.md", file("c1", "a.md", "d1"), "actual_resolved");
			cache.setFile("docs/sub", folder("s1", "sub", "d1"), "actual_resolved");
			cache.setFile("docs/sub/deep.md", file("c2", "deep.md", "s1"), "actual_resolved");

			const displacement = cache.setFile("docs", folder("d2", "docs", ROOT), "actual_resolved");

			expect(displacement).toEqual({
				path: "docs",
				admittedId: "d2",
				withheldId: "d1",
				displacedPaths: ["docs/a.md", "docs/sub", "docs/sub/deep.md"],
				reason: "upsert_rekey",
				owesRemediation: false,
			});
			expect(warn).toHaveBeenCalledWith("Contended cache address", expect.objectContaining({
				path: "docs",
				displacedPaths: ["docs/a.md", "docs/sub", "docs/sub/deep.md"],
			}));
		});

		it("is otherwise behaviourally unchanged: the occupant's subtree is gone", () => {
			const cache = makeCache();
			cache.setFile("docs", folder("d1", "docs", ROOT), "actual_resolved");
			cache.setFile("docs/a.md", file("c1", "a.md", "d1"), "actual_resolved");

			cache.setFile("docs", folder("d2", "docs", ROOT), "actual_resolved");

			expect(cache.idAt("docs")).toBe("d2");
			expect(cache.hasFile("docs/a.md")).toBe(false);
			expect(cache.getPathById("d1")).toBeUndefined();
			expect(cache.getPathById("c1")).toBeUndefined();
		});

		it("reports nothing when the same id is upserted at its own path", () => {
			const cache = makeCache();
			cache.setFile("a.md", file("f1", "a.md", ROOT), "actual_resolved");

			expect(cache.setFile("a.md", file("f1", "a.md", ROOT), "actual_resolved")).toBeNull();
		});

		it("still refuses to move an identity on a requested_echo re-key", () => {
			const cache = makeCache();
			cache.setFile("real.md", file("f1", "real.md", ROOT), "actual_resolved");

			expect(cache.setFile("guessed.md", file("f1", "real.md", ROOT))).toBeNull();
			expect(cache.getPathById("f1")).toBe("real.md");
			expect(cache.hasFile("guessed.md")).toBe(false);
		});
	});

	describe("applyFileChange", () => {
		it("withholds the arriving claim when the incumbent is admitted", () => {
			const cache = makeCache();
			cache.setFile("Test.md", file("f1", "Test.md", ROOT), "actual_resolved");
			cache.setFile("Old.md", file("f2", "Old.md", ROOT), "actual_resolved");

			const applied = cache.applyFileChange(file("f2", "Test.md", ROOT));

			expect(applied).toEqual({
				path: null,
				displacement: null,
				withheld: {
					path: "Test.md",
					admittedId: "f1",
					withheldId: "f2",
					displacedPaths: [],
					reason: "lowest_stable_id",
					owesRemediation: true,
					vacatedPath: "Old.md",
				},
			});
			expect(cache.idAt("Test.md")).toBe("f1");
			// The provider says f2 is no longer at Old.md, so the cache does not claim it is.
			expect(cache.hasFile("Old.md")).toBe(false);
			expect(cache.getPathById("f2")).toBeUndefined();
		});

		it("names the withheld claimant's own displaced descendants", () => {
			const cache = makeCache();
			cache.setFile("docs", folder("d1", "docs", ROOT), "actual_resolved");
			cache.setFile("old", folder("d2", "old", ROOT), "actual_resolved");
			cache.setFile("old/a.md", file("c1", "a.md", "d2"), "actual_resolved");

			const applied = cache.applyFileChange(folder("d2", "docs", ROOT));

			expect(applied?.withheld?.vacatedPath).toBe("old");
			expect(applied?.withheld?.displacedPaths).toEqual(["old/a.md"]);
			expect(cache.getPathById("c1")).toBeUndefined();
		});

		it("returns the displacement when the arriving claim is admitted", () => {
			const cache = makeCache();
			cache.setFile("docs", folder("d2", "docs", ROOT), "actual_resolved");
			cache.setFile("docs/a.md", file("c1", "a.md", "d2"), "actual_resolved");

			const applied = cache.applyFileChange(folder("d1", "docs", ROOT));

			expect(applied).toEqual({
				path: "docs",
				withheld: null,
				displacement: {
					path: "docs",
					admittedId: "d1",
					withheldId: "d2",
					displacedPaths: ["docs/a.md"],
					reason: "lowest_stable_id",
					owesRemediation: true,
				},
			});
			expect(cache.idAt("docs")).toBe("d1");
		});

		it("admits a provider-resolved delta over a stored guess and owes no remediation for it", () => {
			const cache = makeCache();
			// Stored as a request echo — the addressing guess, not provider topology.
			cache.setFile("a.md", file("zzz", "a.md", ROOT));

			const applied = cache.applyFileChange(file("aaa", "a.md", ROOT));

			expect(applied?.path).toBe("a.md");
			expect(applied?.displacement).toEqual({
				path: "a.md",
				admittedId: "aaa",
				withheldId: "zzz",
				displacedPaths: [],
				reason: "path_authority",
				owesRemediation: false,
			});
		});

		it("reaches the same decision from both arrival orders of one pair", () => {
			const pair = [file("f1", "Test.md", ROOT), file("f2", "Test.md", ROOT)];

			for (const [first, second] of permutations(pair)) {
				const cache = makeCache();
				cache.applyFileChange(first!);
				cache.applyFileChange(second!);

				expect(cache.idAt("Test.md")).toBe("f1");
				expect(cache.getPathById("f2")).toBeUndefined();
			}
		});

		it("returns null, not a withholding, for a path it cannot resolve", () => {
			const cache = makeCache();
			cache.setFile("a.md", file("f1", "a.md", ROOT), "actual_resolved");

			expect(cache.applyFileChange(file("f1", "a.md", "gone-from-root"))).toBeNull();
			expect(cache.getPathById("f1")).toBeUndefined();
		});

		it("reports the same upsert for an unchanged entry without a contention", () => {
			const cache = makeCache();

			const applied = cache.applyFileChange(file("f1", "a.md", ROOT));

			expect(applied).toEqual({ path: "a.md", displacement: null, withheld: null });
		});
	});

	describe("nothing about a contention is kept", () => {
		it("gains no instance field, whatever the writers observe", () => {
			const cache = new TestMetadataCache(ROOT);
			const before = Object.getOwnPropertyNames(cache).sort();

			cache.buildFromFiles([
				folder("d1", "docs", ROOT),
				folder("d2", "docs", ROOT),
				file("c3", "x.md", "d2"),
			]);
			cache.applyFileChange(file("f2", "docs", ROOT));
			cache.setFile("docs", folder("d3", "docs", ROOT), "actual_resolved");

			expect(Object.getOwnPropertyNames(cache).sort()).toEqual(before);
			expect(before).toEqual([
				"children", "folders", "idToPath", "logger", "pathAuthorities", "pathToFile", "rootFolderId",
			]);
		});

		it("re-derives the same facts from the same files rather than remembering them", () => {
			const cache = makeCache();
			const files = [file("f1", "Test.md", ROOT), file("f2", "Test.md", ROOT)];

			const first = cache.buildFromFiles(files);
			cache.clear();
			const second = cache.buildFromFiles(files);

			expect(second).toEqual(first);
		});

		it("does not let a past displacement change a later, uncontended answer", () => {
			const cache = makeCache();
			cache.buildFromFiles([file("f1", "Test.md", ROOT), file("f2", "Test.md", ROOT)]);
			cache.clear();

			// f2 alone now: the earlier loss is not a reason to withhold it again.
			expect(cache.buildFromFiles([file("f2", "Test.md", ROOT)])).toEqual([]);
			expect(cache.idAt("Test.md")).toBe("f2");
		});
	});

	describe("the bijection survives any sequence of writers", () => {
		it("holds after setFile, bulkLoad and buildFromFiles interleaved", () => {
			const cache = makeCache();

			cache.setFile("docs", folder("d1", "docs", ROOT), "actual_resolved");
			cache.setFile("docs/a.md", file("c1", "a.md", "d1"), "actual_resolved");
			cache.bulkLoad([
				["docs", folder("d2", "docs", ROOT), "actual_resolved"],
				["notes.md", file("n1", "notes.md", ROOT), "actual_resolved"],
			]);
			cache.applyFileChange(file("n1", "renamed.md", ROOT));
			cache.buildFromFiles([
				folder("d3", "docs", ROOT),
				folder("d4", "docs", ROOT),
				file("c4", "y.md", "d4"),
			]);
			cache.setFile("docs", file("d5", "docs", ROOT), "actual_resolved");

			// buildFromFiles does not clear, so what survives is the union of the writers.
			expect(cache.snapshotPathsById().size).toBe(cache.size);
			expect(cache.idAt("docs")).toBe("d5");
			expect(cache.getPathById("d5")).toBe("docs");
		});
	});
});
