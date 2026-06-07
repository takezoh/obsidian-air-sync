import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveGDriveRemoteVault } from "./remote-vault";
import { REMOTE_VAULT_ROOT } from "../../sync/remote-vault";
import { FOLDER_MIME } from "./types";
import type { DriveFile } from "./types";
import type { DriveClient } from "./client";

vi.mock("obsidian");

function makeDriveFile(overrides: Partial<DriveFile> & { id: string; name: string }): DriveFile {
	return { mimeType: "application/octet-stream", ...overrides };
}

function makeFolder(id: string, name: string): DriveFile {
	return makeDriveFile({ id, name, mimeType: FOLDER_MIME });
}

function createMockClient(): {
	client: DriveClient;
	findChildByName: ReturnType<typeof vi.fn>;
	createFolder: ReturnType<typeof vi.fn>;
	listFiles: ReturnType<typeof vi.fn>;
	downloadFile: ReturnType<typeof vi.fn>;
	updateFileMetadata: ReturnType<typeof vi.fn>;
	deleteFile: ReturnType<typeof vi.fn>;
	getFile: ReturnType<typeof vi.fn>;
} {
	const findChildByName = vi.fn();
	const createFolder = vi.fn();
	const listFiles = vi.fn();
	const downloadFile = vi.fn();
	const updateFileMetadata = vi.fn();
	const deleteFile = vi.fn();
	const getFile = vi.fn();

	const client = {
		findChildByName,
		createFolder,
		listFiles,
		downloadFile,
		updateFileMetadata,
		deleteFile,
		getFile,
	} as unknown as DriveClient;

	return { client, findChildByName, createFolder, listFiles, downloadFile, updateFileMetadata, deleteFile, getFile };
}

function metaBuffer(vaultName: string): ArrayBuffer {
	return new TextEncoder().encode(JSON.stringify({ vaultName })).buffer;
}

describe("resolveGDriveRemoteVault", () => {
	let mock: ReturnType<typeof createMockClient>;

	beforeEach(() => {
		mock = createMockClient();
	});

	describe("reconnect with cached folder ID", () => {
		it("reuses the cached folder after verifying it exists, without touching the root", async () => {
			mock.getFile.mockResolvedValueOnce(makeFolder("vault-folder-id", "My Vault"));

			const result = await resolveGDriveRemoteVault(mock.client, "My Vault", "vault-folder-id");

			expect(result.backendUpdates).toEqual({ remoteVaultFolderId: "vault-folder-id" });
			// Cached path goes straight to getFile — no discovery, no metadata writes.
			expect(mock.findChildByName).not.toHaveBeenCalled();
			expect(mock.createFolder).not.toHaveBeenCalled();
		});

		it("throws with original error detail when getFile fails", async () => {
			mock.getFile.mockRejectedValueOnce(new Error("Drive API getFile failed: File not found"));

			await expect(
				resolveGDriveRemoteVault(mock.client, "My Vault", "deleted-folder-id"),
			).rejects.toThrow("Failed to access remote vault folder: Drive API getFile failed: File not found");
		});
	});

	describe("new binding by folder name", () => {
		it("creates obsidian-air-sync/<Vault Name> when nothing exists", async () => {
			// Root absent → created.
			mock.findChildByName.mockResolvedValueOnce(null);
			mock.createFolder.mockResolvedValueOnce(makeFolder("root-folder-id", REMOTE_VAULT_ROOT));
			// No children → no legacy migration.
			mock.listFiles.mockResolvedValueOnce({ files: [] });
			// Named folder absent → created.
			mock.findChildByName.mockResolvedValueOnce(null);
			mock.createFolder.mockResolvedValueOnce(makeFolder("new-vault-id", "My Vault"));

			const result = await resolveGDriveRemoteVault(mock.client, "My Vault", undefined);

			expect(result.backendUpdates).toEqual({ remoteVaultFolderId: "new-vault-id" });
			expect(mock.createFolder).toHaveBeenCalledWith(REMOTE_VAULT_ROOT, "root");
			expect(mock.createFolder).toHaveBeenCalledWith("My Vault", "root-folder-id");
			// No metadata.json is ever written.
			expect(mock.updateFileMetadata).not.toHaveBeenCalled();
		});

		it("reuses an existing obsidian-air-sync/<Vault Name> folder", async () => {
			// Root exists.
			mock.findChildByName.mockResolvedValueOnce(makeFolder("root-folder-id", REMOTE_VAULT_ROOT));
			// A folder already named like the vault (no .airsync → not a legacy vault).
			mock.listFiles.mockResolvedValueOnce({ files: [makeFolder("named-id", "My Vault")] });
			// Migration scan: that folder has no .airsync.
			mock.findChildByName.mockResolvedValueOnce(null);
			// resolveByName: found by name.
			mock.findChildByName.mockResolvedValueOnce(makeFolder("named-id", "My Vault"));

			const result = await resolveGDriveRemoteVault(mock.client, "My Vault", undefined);

			expect(result.backendUpdates).toEqual({ remoteVaultFolderId: "named-id" });
			expect(mock.createFolder).not.toHaveBeenCalled();
		});
	});

	describe("legacy migration", () => {
		it("renames the legacy uuid folder to the vault name, deletes metadata.json, and binds it", async () => {
			// Root exists.
			mock.findChildByName.mockResolvedValueOnce(makeFolder("root-folder-id", REMOTE_VAULT_ROOT));
			// One legacy child folder.
			mock.listFiles.mockResolvedValueOnce({ files: [makeFolder("legacy-id", "old-uuid")] });
			// Legacy metadata: .airsync → metadata.json → { vaultName: "My Vault" }.
			mock.findChildByName.mockResolvedValueOnce(makeFolder("airsync-id", ".airsync"));
			mock.findChildByName.mockResolvedValueOnce(makeDriveFile({ id: "meta-id", name: "metadata.json" }));
			mock.downloadFile.mockResolvedValueOnce(metaBuffer("My Vault"));
			mock.updateFileMetadata.mockResolvedValueOnce(makeFolder("legacy-id", "My Vault"));
			mock.deleteFile.mockResolvedValueOnce(undefined);

			const result = await resolveGDriveRemoteVault(mock.client, "My Vault", undefined);

			expect(result.backendUpdates).toEqual({ remoteVaultFolderId: "legacy-id" });
			expect(mock.updateFileMetadata).toHaveBeenCalledWith("legacy-id", { name: "My Vault" });
			expect(mock.deleteFile).toHaveBeenCalledWith("meta-id");
			// Migration short-circuits before find-or-create-by-name.
			expect(mock.createFolder).not.toHaveBeenCalled();
		});

		it("ignores a legacy folder whose metadata names a different vault, then creates by name", async () => {
			mock.findChildByName.mockResolvedValueOnce(makeFolder("root-folder-id", REMOTE_VAULT_ROOT));
			mock.listFiles.mockResolvedValueOnce({ files: [makeFolder("legacy-id", "old-uuid")] });
			// Legacy metadata names a different vault → no migration.
			mock.findChildByName.mockResolvedValueOnce(makeFolder("airsync-id", ".airsync"));
			mock.findChildByName.mockResolvedValueOnce(makeDriveFile({ id: "meta-id", name: "metadata.json" }));
			mock.downloadFile.mockResolvedValueOnce(metaBuffer("Other Vault"));
			// Fall through to find-or-create by name.
			mock.findChildByName.mockResolvedValueOnce(null);
			mock.createFolder.mockResolvedValueOnce(makeFolder("new-id", "My Vault"));

			const result = await resolveGDriveRemoteVault(mock.client, "My Vault", undefined);

			expect(result.backendUpdates).toEqual({ remoteVaultFolderId: "new-id" });
			expect(mock.updateFileMetadata).not.toHaveBeenCalled();
			expect(mock.deleteFile).not.toHaveBeenCalled();
			expect(mock.createFolder).toHaveBeenCalledWith("My Vault", "root-folder-id");
		});

		it("skips a legacy folder with corrupt metadata.json instead of throwing, then creates by name", async () => {
			mock.findChildByName.mockResolvedValueOnce(makeFolder("root-folder-id", REMOTE_VAULT_ROOT));
			mock.listFiles.mockResolvedValueOnce({ files: [makeFolder("legacy-id", "old-uuid")] });
			mock.findChildByName.mockResolvedValueOnce(makeFolder("airsync-id", ".airsync"));
			mock.findChildByName.mockResolvedValueOnce(makeDriveFile({ id: "meta-id", name: "metadata.json" }));
			// Truncated/invalid JSON — must not abort the whole bind.
			mock.downloadFile.mockResolvedValueOnce(new TextEncoder().encode("{ not valid").buffer);
			// Fall through to find-or-create by name.
			mock.findChildByName.mockResolvedValueOnce(null);
			mock.createFolder.mockResolvedValueOnce(makeFolder("new-id", "My Vault"));

			const result = await resolveGDriveRemoteVault(mock.client, "My Vault", undefined);

			expect(result.backendUpdates).toEqual({ remoteVaultFolderId: "new-id" });
			expect(mock.updateFileMetadata).not.toHaveBeenCalled();
			expect(mock.createFolder).toHaveBeenCalledWith("My Vault", "root-folder-id");
		});
	});
});
