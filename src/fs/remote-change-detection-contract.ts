import { describe, it, expect } from "vitest";
import type { FileEntity } from "./types";
import { hasRemoteChanged } from "../sync/change-compare";
import { buildSyncRecord } from "../sync/state-committer";

/** Encode text as an ArrayBuffer (shared test helper). */
export function bytes(text: string): ArrayBuffer {
	return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

/** stat() the path and assert it exists, returning the entity. */
export async function statOrThrow(
	fs: { stat(path: string): Promise<FileEntity | null> },
	path: string,
): Promise<FileEntity> {
	const entity = await fs.stat(path);
	if (!entity) throw new Error(`stat returned null for ${path}`);
	return entity;
}

/**
 * Shared change-detection contract for any remote `IFileSystem` backend.
 *
 * `remote` is the only Decision-table column whose correctness is backend-specific:
 * `hasRemoteChanged()` consumes `mtime`, `size` and `backendMeta.contentChecksum`,
 * each of which every backend populates differently (Drive uses md5Checksum and a
 * server-assigned modifiedTime; a mock uses local mtime + sha256). A backend that
 * gets this wrong causes either an infinite re-sync loop (always "changed") or
 * silent staleness (never "changed").
 *
 * The `checksumBased` opt is important: the write→unchanged and write→edit cases
 * are decided by mtime+size alone (they move in lockstep with content), so on their
 * own they do NOT prove the contentChecksum plumbing works. For checksum-based
 * backends the `metadata-only touch` case makes the checksum load-bearing — it is
 * the ONLY signal that distinguishes "unchanged" from "changed" when mtime drifts
 * but content is identical. Without it a dropped/garbled md5 ships undetected.
 *
 * Note: this exercises the plumbing through mocked transport. Properties needing a
 * live backend (e.g. whether Drive's modifiedTime is truly stable) are out of scope.
 */
export interface RemoteChangeHarness {
	/** Observe the remote entity for a freshly written file, as the sync cycle would (via stat/list). */
	observeWritten(): Promise<FileEntity>;
	/** Re-observe the same, unchanged file on a later cycle. The backend's view must be stable. */
	observeUnchanged(): Promise<FileEntity>;
	/** Apply a genuine remote content edit and observe the new remote entity. */
	observeAfterEdit(): Promise<FileEntity>;
	/**
	 * Required for `checksumBased` backends: observe the entity after a METADATA-ONLY
	 * touch — mtime bumped, but content/size/checksum identical. Must be reported
	 * UNCHANGED, which is only possible if hasRemoteChanged consults the checksum.
	 */
	observeTouchedSameContent?(): Promise<FileEntity>;
}

export function runRemoteChangeDetectionContract(
	name: string,
	makeHarness: () => Promise<RemoteChangeHarness>,
	opts: { checksumBased?: boolean } = {},
): void {
	describe(`remote change-detection contract — ${name}`, () => {
		it("reports a just-written file as UNCHANGED on the next cycle (no infinite re-sync)", async () => {
			const harness = await makeHarness();
			const written = await harness.observeWritten();
			const baseline = buildSyncRecord(undefined, written, written.path);

			const reobserved = await harness.observeUnchanged();

			expect(hasRemoteChanged(reobserved, baseline)).toBe(false);
		});

		it("reports a remote content edit as CHANGED (no missed update)", async () => {
			const harness = await makeHarness();
			const written = await harness.observeWritten();
			const baseline = buildSyncRecord(undefined, written, written.path);

			const edited = await harness.observeAfterEdit();

			expect(hasRemoteChanged(edited, baseline)).toBe(true);
		});

		if (opts.checksumBased) {
			it("reports a metadata-only touch (identical content) as UNCHANGED — checksum is load-bearing", async () => {
				const harness = await makeHarness();
				if (!harness.observeTouchedSameContent) {
					throw new Error(
						"checksumBased harness must implement observeTouchedSameContent()",
					);
				}
				const written = await harness.observeWritten();
				const baseline = buildSyncRecord(
					undefined,
					written,
					written.path,
				);

				const touched = await harness.observeTouchedSameContent();

				// mtime drifts but content/checksum are identical → the only way this is
				// "unchanged" is if hasRemoteChanged compares contentChecksum. If the md5
				// plumbing regresses, this flips to true (infinite re-sync) and fails.
				expect(hasRemoteChanged(touched, baseline)).toBe(false);
			});
		}
	});
}
