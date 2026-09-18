import { describe, expect, it, vi } from "vitest";
import { applyIdDeltaPage, createIdDeltaResult } from "./id-delta";
import type { IdDeltaEntry } from "./id-delta";
import type { AbstractMetadataCache } from "./metadata-cache";
import { GoogleDriveMetadataCache } from "../googledrive/metadata-cache";
import type { GoogleDriveFile } from "../googledrive/types";
import { FOLDER_MIME } from "../googledrive/types";
import { OneDriveMetadataCache } from "../onedrive/metadata-cache";
import type { OneDriveItem } from "../onedrive/types";
import { odFile, odFolder } from "../onedrive/test-helpers";

vi.mock("obsidian");

const ROOT = "root";

function gdFile(id: string, name: string, parentId: string): GoogleDriveFile {
	return { id, name, mimeType: "text/plain", trashed: false, parents: [parentId] };
}

function gdFolder(id: string, name: string, parentId: string): GoogleDriveFile {
	return { id, name, mimeType: FOLDER_MIME, trashed: false, parents: [parentId] };
}

/** One upsert entry, as each backend's raw→IdDeltaEntry mapping produces it. */
function upsert<TFile>(id: string, file: TFile, isFolder = false): IdDeltaEntry<TFile> {
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

// applyIdDeltaPage is the shared move/rename classifier behind Google Drive's
// `changes.list` and OneDrive's `/delta`. These fixtures drive it through each
// backend's OWN cache subclass, so the projection under test is the real one.

describe("applyIdDeltaPage — the pair names the moved object", () => {
	describe("Google Drive", () => {
		const seeded = (...files: GoogleDriveFile[]): GoogleDriveMetadataCache => {
			const cache = new GoogleDriveMetadataCache(ROOT);
			cache.buildFromFiles(files);
			return cache;
		};

		it("carries the delta entry's own id as the moved FILE's identity", () => {
			const cache = seeded(gdFile("gd-1", "note.md", ROOT));
			const acc = createIdDeltaResult();

			applyIdDeltaPage(cache, acc, [upsert("gd-1", gdFile("gd-1", "renamed.md", ROOT))]);

			expect(acc.renamedPaths).toEqual([{
				oldPath: "note.md",
				newPath: "renamed.md",
				isFolder: undefined,
				identityKey: projectedIdentity(cache, "renamed.md"),
			}]);
			expect(acc.renamedPaths[0]?.identityKey).toBe("gd-1");
		});

		it("carries the delta entry's own id as the moved FOLDER's identity", () => {
			const cache = seeded(
				gdFolder("gd-dir", "dir", ROOT),
				gdFile("gd-child", "b.md", "gd-dir"),
			);
			const acc = createIdDeltaResult();

			applyIdDeltaPage(cache, acc, [upsert("gd-dir", gdFolder("gd-dir", "papers", ROOT), true)]);

			expect(acc.renamedPaths).toEqual([{
				oldPath: "dir",
				newPath: "papers",
				isFolder: true,
				identityKey: projectedIdentity(cache, "papers"),
			}]);
			expect(acc.renamedPaths[0]?.identityKey).toBe("gd-dir");
			// The reparented child is reported as changed, not as a second rename pair.
			expect(cache.hasFile("papers/b.md")).toBe(true);
			expect(acc.changedPaths).toContain("papers/b.md");
		});
	});

	describe("OneDrive", () => {
		const seeded = (...items: OneDriveItem[]): OneDriveMetadataCache => {
			const cache = new OneDriveMetadataCache(ROOT);
			cache.buildFromFiles(items);
			return cache;
		};

		it("carries the delta entry's own id as the moved FILE's identity", () => {
			const cache = seeded(odFile("od-1", "a.md", ROOT));
			const acc = createIdDeltaResult();

			applyIdDeltaPage(cache, acc, [upsert("od-1", odFile("od-1", "renamed.md", ROOT))]);

			expect(acc.renamedPaths).toEqual([{
				oldPath: "a.md",
				newPath: "renamed.md",
				isFolder: undefined,
				identityKey: projectedIdentity(cache, "renamed.md"),
			}]);
			expect(acc.renamedPaths[0]?.identityKey).toBe("od-1");
		});

		it("carries the delta entry's own id as the moved FOLDER's identity", () => {
			const cache = seeded(
				odFolder("od-dir", "dir", ROOT),
				odFile("od-child", "b.md", "od-dir"),
			);
			const acc = createIdDeltaResult();

			applyIdDeltaPage(cache, acc, [upsert("od-dir", odFolder("od-dir", "papers", ROOT), true)]);

			expect(acc.renamedPaths).toEqual([{
				oldPath: "dir",
				newPath: "papers",
				isFolder: true,
				identityKey: projectedIdentity(cache, "papers"),
			}]);
			expect(acc.renamedPaths[0]?.identityKey).toBe("od-dir");
			expect(cache.hasFile("papers/b.md")).toBe(true);
			expect(acc.changedPaths).toContain("papers/b.md");
		});
	});

	// An in-place modify and a tombstone report no pair at all, so there is no path
	// on which a producer could attach an identity to something that did not move.
	it("reports no pair — and so no identity — for an in-place modify", () => {
		const cache = new GoogleDriveMetadataCache(ROOT);
		cache.buildFromFiles([gdFile("gd-1", "note.md", ROOT)]);
		const acc = createIdDeltaResult();

		applyIdDeltaPage(cache, acc, [upsert("gd-1", gdFile("gd-1", "note.md", ROOT))]);

		expect(acc.renamedPaths).toEqual([]);
		expect(acc.changedPaths).toContain("note.md");
	});
});
