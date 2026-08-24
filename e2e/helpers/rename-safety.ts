import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { createMockLocalFs } from "../../src/__mocks__/sync-test-helpers";
import type { IFileSystem } from "../../src/fs/interface";
import type { FileEntity } from "../../src/fs/types";
import { DEFAULT_SETTINGS } from "../../src/settings";
import { LocalChangeTracker } from "../../src/sync/local-tracker";
import { SyncOrchestrator } from "../../src/sync/orchestrator";
import { bytes } from "../../src/fs/ifilesystem-contract.test";

interface RenameSafetyBackend {
	fs: IFileSystem;
	renameOutOfBand: (file: FileEntity, newPath: string) => Promise<void>;
}

interface RenameSafetyOptions {
	backendType: string;
	makeBackend: () => Promise<RenameSafetyBackend>;
}

/**
 * Register the same live, orchestrator-composed rename-safety scenario for every
 * backend. The backend seam is deliberately below IFileSystem: it models a rename
 * performed by another device/web UI so only the remote delta can reveal it.
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
				expect((await remoteFs.stat("Drafts"))?.pathAuthority).toBe("requested_echo");
				expect((await remoteFs.stat("Drafts/nested/note.md"))?.pathAuthority)
					.toBe("requested_echo");

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
				expect(moved!.identityKey).toBeTruthy();
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
