import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { createMockLocalFs } from "../../src/__mocks__/sync-test-helpers";
import type { IFileSystem } from "../../src/fs/interface";
import { createChecksumRegistry } from "../../src/fs/modules/checksum-registry";
import type { FileEntity, RenamePair } from "../../src/fs/types";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { LocalChangeTracker } from "../../src/sync/local-tracker";
import { SyncOrchestrator } from "../../src/sync/orchestrator";
import { bytes } from "../../tests/fs/contracts/ifilesystem.contract";
import type { MovedObjectIdentity } from "../../tests/fs/contracts/caching-remote-fs.contract";

interface RenameSafetyBackend {
	fs: IFileSystem;
	renameOutOfBand: (file: FileEntity, newPath: string) => Promise<void>;
}

interface RenameSafetyOptions {
	backendType: string;
	makeBackend: () => Promise<RenameSafetyBackend>;
	/**
	 * What this family's own `FileEntity` projection makes of the identity of the object
	 * this scenario moves — declared by the backend file, never inferred here. Required,
	 * for the same reason the unit `RemoteFamilyCachingHarness` makes it required: a
	 * family that forgot to declare it would be a compile error rather than a silently
	 * unchecked live rename.
	 *
	 * `RenamePair.identityKey` is optional BY CONTRACT (ADR 0008's third state: a missing
	 * key is no evidence, not a failure), so `expect(pair.identityKey).toBeTruthy()` would
	 * be wrong in one direction and
	 * `expect(pair.identityKey).toBe((await fs.stat(newPath))?.identityKey)` wrong in the
	 * other — the latter passes when the live provider reported NOTHING on both sides,
	 * because `toBe(undefined)` is satisfied by `undefined`. The declaration closes that:
	 * a family whose projection names every moved object asserts a non-empty provider
	 * identity AND its equality with the live `stat`; a family whose projection
	 * legitimately yields none asserts that ABSENCE explicitly, with its reason. This is
	 * deliberately the same type the unit contract declares (`MovedObjectIdentity`), so a
	 * family cannot claim one disposition against the fake and another against the API.
	 */
	movedObjectIdentity: MovedObjectIdentity;
}

/**
 * The identity a LIVE `stat` of `path` reports, checked against the family's declared
 * disposition before anything is compared against it.
 *
 * The live twin of `movedIdentityOf` in `tests/fs/contracts/caching-remote-fs.contract.ts`:
 * a determinate family must report a non-empty provider identity here, so the carried-key
 * expectation below can never be satisfied vacuously by two absent values; a family that
 * declared no identity must report none, so nothing (least of all a cache-internal
 * address) can quietly stand in for it.
 */
function liveMovedIdentity(
	entity: FileEntity | null,
	path: string,
	declared: MovedObjectIdentity,
): string | undefined {
	expect(entity, `stat("${path}") reports nothing to name the moved object by`).not.toBeNull();
	const identityKey = entity!.identityKey;
	if (declared.determinate) {
		expect(typeof identityKey, declared.reason).toBe("string");
		expect(identityKey, declared.reason).not.toBe("");
	} else {
		expect(identityKey, declared.reason).toBeUndefined();
	}
	return identityKey;
}

/**
 * Assert that every reported pair for one rename NAMES the object it moved, and names it
 * as the live `stat` projection does.
 *
 * `expected` comes from a different production of the same fact than `pairs` do (see the
 * call site), which is what makes this the live form of the cross-source check at
 * `src/sync/identity-component-decision.ts:105-107`. The non-emptiness bound is asserted
 * separately from the equality so a determinate family cannot pass on a pair of absences,
 * and a declared absence is asserted as an absence rather than left unexamined.
 */
function expectPairsNameTheMovedObject(
	pairs: readonly RenamePair[],
	expected: string | undefined,
	declared: MovedObjectIdentity,
	where: string,
): void {
	expect(
		pairs.length,
		`${where}: no delta reported this pair, so its carried identity was never checked`,
	).toBeGreaterThan(0);
	for (const pair of pairs) {
		if (declared.determinate) {
			expect(typeof pair.identityKey, `${where} carries no identity — ${declared.reason}`).toBe("string");
			expect(pair.identityKey, `${where} carries an empty identity — ${declared.reason}`).not.toBe("");
		} else {
			expect(pair.identityKey, `${where} carries an identity — ${declared.reason}`).toBeUndefined();
		}
		expect(
			pair.identityKey,
			`${where}: the producer's carried identity and the live stat projection of the ` +
				"moved object name different objects",
		).toBe(expected);
	}
}

/**
 * Register the same live, orchestrator-composed rename-safety scenario for every
 * backend. The backend seam is deliberately below IFileSystem: it models a rename
 * performed by another device/web UI so only the remote delta can reveal it.
 *
 * That remote-origin leg is also the only live surface on which `RenamePair.identityKey`
 * is produced at all — `checkpoint.getChangedPaths()` is exactly the value the sync
 * engine reads it from — so the identity the pair carries is asserted here, against
 * every family, rather than in one backend's file.
 */
export function runRenameSafetyE2E(label: string, options: RenameSafetyOptions): void {
	describe(`${label} rename safety — composed multi-cycle sync (real)`, () => {
		it("preserves one correctly-cased copy across both rename origins and later COLD", async () => {
			const { fs: remoteFs, renameOutOfBand } = await options.makeBackend();
			if (!remoteFs.checkpoint) throw new Error(`${label} has no incremental checkpoint`);
			const checkpoint = remoteFs.checkpoint;
			const remoteDeltas: Awaited<ReturnType<typeof checkpoint.getChangedPaths>>[] = [];
			const getChangedPaths = checkpoint.getChangedPaths.bind(checkpoint);
			checkpoint.getChangedPaths = async () => {
				const delta = await getChangedPaths();
				remoteDeltas.push(delta);
				return delta;
			};
			const localFs = createMockLocalFs();
			const tracker = new LocalChangeTracker();
			const settings = {
				...DEFAULT_SETTINGS,
				vaultId: `${options.backendType}-e2e-${crypto.randomUUID()}`,
				backendType: options.backendType,
				lastSyncedIdentity: `${options.backendType}:rename-safety`,
			};
			const statuses: string[] = [];
			const orchestrator = new SyncOrchestrator({
				getSettings: () => settings,
				saveSettings: vi.fn().mockResolvedValue(undefined),
				configDir: () => ".obsidian",
				pluginId: () => "air-sync",
				localFs: () => localFs,
				remoteFs: () => remoteFs,
				backendProvider: () => null,
				checksumRegistry: createChecksumRegistry(),
				onStatusChange: (status) => { statuses.push(status); },
				onProgress: vi.fn(),
				notify: vi.fn(),
				isMobile: () => false,
				localTracker: tracker,
			});
			const localDelete = vi.spyOn(localFs, "delete");
			const remoteDelete = vi.spyOn(remoteFs, "delete");
			const localRename = vi.spyOn(localFs, "rename");
			const remoteRename = vi.spyOn(remoteFs, "rename");
			const remoteList = vi.spyOn(remoteFs, "list");
			const observedLocalRename = (oldPath: string, newPath: string): boolean =>
				localRename.mock.calls.some(([old, next]) => old === oldPath && next === newPath);

			try {
				const content = bytes("case-preserved");
				await localFs.write("Case.md", content, 1000);
				await remoteFs.write("Case.md", content, 1000);
				// Re-observe the live backend instead of trusting a mutation echo.
				await checkpoint.resetCheckpoint();
				await orchestrator.runSync();

				const nestedContent = bytes("folder-descendant-preserved");
				await localFs.write("Drafts/nested/note.md", nestedContent, 1000);
				tracker.markDirty("Drafts/nested/note.md");
				await orchestrator.runSync();
				// Live mutation responses include provider-resolved topology. Preserve that
				// stronger exact-slot proof instead of downgrading it to a request echo.
				expect((await remoteFs.stat("Drafts"))?.pathAuthority).toBe("actual_resolved");
				expect((await remoteFs.stat("Drafts/nested/note.md"))?.pathAuthority)
					.toBe("actual_resolved");

				await localFs.rename("Drafts", "Published");
				tracker.markFolderRenamed("Published", "Drafts");
				for (let attempt = 0; attempt < 10 && !remoteRename.mock.calls.some(([old, next]) =>
					old === "Drafts" && next === "Published"); attempt++) {
					await orchestrator.runSync();
					if (!remoteRename.mock.calls.some(([old, next]) =>
						old === "Drafts" && next === "Published")) {
						await new Promise((resolve) => setTimeout(resolve, 1000));
					}
				}
				expect(remoteRename).toHaveBeenCalledWith("Drafts", "Published");
				expect(new TextDecoder().decode(await remoteFs.read("Published/nested/note.md")))
					.toBe("folder-descendant-preserved");

				await localFs.rename("Case.md", "case.md");
				tracker.markRenamed("case.md", "Case.md");
				await orchestrator.runSync();
				expect(remoteRename).toHaveBeenCalledWith("Case.md", "case.md");
				expect((await remoteFs.list()).filter((item) => !item.isDirectory)
					.map((item) => item.path).sort())
					.toEqual(["Published/nested/note.md", "case.md"]);

				const moved = await remoteFs.stat("case.md");
				expect(moved).not.toBeNull();
				// Was `expect(moved!.identityKey).toBeTruthy()`. Same bound, routed through the
				// family's declared disposition so the pair check below can compare against it
				// without a truthiness test that would pass on an absence the family never
				// claimed — and so a family that legitimately projects none says so once, here.
				const movedIdentity = liveMovedIdentity(moved, "case.md", options.movedObjectIdentity);
				await renameOutOfBand(moved!, "CASE.md");
				// Remote APIs may publish mutations to their delta feeds after the mutation
				// response. Poll only through normal WARM cycles; COLD must remain a later,
				// independent convergence check rather than the first repair mechanism.
				for (let attempt = 0; attempt < 10 && !observedLocalRename("case.md", "CASE.md"); attempt++) {
					await orchestrator.runSync();
					if (!observedLocalRename("case.md", "CASE.md")) {
						await new Promise((resolve) => setTimeout(resolve, 1000));
					}
				}
				expect(remoteDeltas.some((delta) => delta?.renamed?.some((pair) =>
					pair.oldPath === "case.md" && pair.newPath === "CASE.md"))).toBe(true);
				// The pair must NAME the object it moved, not merely its two addresses.
				// `pair.identityKey` is `cache.toEntity(newPath, file).identityKey` over the
				// PROVIDER'S OWN delta payload; `movedIdentity` is the live `stat` projection
				// taken before the move — and, for the id-addressed families, the very address
				// `renameOutOfBand` mutated. Two independent productions of one object's
				// identity, so this is the live form of the cross-source check the change
				// under test installed at identity-component-decision.ts:105-107. A
				// post-rename `stat("CASE.md")` would NOT do: it reads the cache this same
				// delta payload just wrote, which is one source wearing two hats.
				//
				// `runIFileSystemContract`'s "native identity survives rename" does not reach
				// this either: it asserts `FileEntity.identityKey` across an FS-INITIATED
				// `fs.rename`, and `CachingRemoteFs.rename` emits no `RenamePair` at all.
				const carriedPairs = remoteDeltas
					.flatMap((delta) => delta?.renamed ?? [])
					.filter((pair) => pair.oldPath === "case.md" && pair.newPath === "CASE.md");
				expectPairsNameTheMovedObject(
					carriedPairs,
					movedIdentity,
					options.movedObjectIdentity,
					`${label} remote-origin rename case.md → CASE.md`,
				);
				expect(localRename).toHaveBeenCalledWith("case.md", "CASE.md");

				const listsBeforeCold = remoteList.mock.calls.length;
				await checkpoint.resetCheckpoint();
				await orchestrator.runSync();
				expect(remoteList).toHaveBeenCalledTimes(listsBeforeCold + 1);
				expect((await localFs.list()).filter((item) => !item.isDirectory)
					.map((item) => item.path).sort())
					.toEqual(["CASE.md", "Published/nested/note.md"]);
				expect((await remoteFs.list()).filter((item) => !item.isDirectory)
					.map((item) => item.path).sort())
					.toEqual(["CASE.md", "Published/nested/note.md"]);
				expect(new TextDecoder().decode(await localFs.read("CASE.md"))).toBe("case-preserved");
				expect(new TextDecoder().decode(await remoteFs.read("CASE.md"))).toBe("case-preserved");
				expect(new TextDecoder().decode(await localFs.read("Published/nested/note.md")))
					.toBe("folder-descendant-preserved");
				expect(new TextDecoder().decode(await remoteFs.read("Published/nested/note.md")))
					.toBe("folder-descendant-preserved");
				expect(localDelete).not.toHaveBeenCalled();
				expect(remoteDelete).not.toHaveBeenCalled();
				expect(statuses.at(-1)).toBe("idle");
			} finally {
				await orchestrator.close();
				await remoteFs.close?.();
			}
		});
	});
}
