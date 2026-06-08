import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveGDriveRemoteVault } from "./remote-vault";
import { REMOTE_VAULT_ROOT } from "../remote-vault-contract";
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
	getFile: ReturnType<typeof vi.fn>;
} {
	const findChildByName = vi.fn();
	const createFolder = vi.fn();
	const getFile = vi.fn();

	const client = {
		findChildByName,
		createFolder,
		getFile,
	} as unknown as DriveClient;

	return { client, findChildByName, createFolder, getFile };
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
			// Named folder absent → created.
			mock.findChildByName.mockResolvedValueOnce(null);
			mock.createFolder.mockResolvedValueOnce(makeFolder("new-vault-id", "My Vault"));

			const result = await resolveGDriveRemoteVault(mock.client, "My Vault", undefined);

			expect(result.backendUpdates).toEqual({ remoteVaultFolderId: "new-vault-id" });
			expect(mock.createFolder).toHaveBeenCalledWith(REMOTE_VAULT_ROOT, "root");
			expect(mock.createFolder).toHaveBeenCalledWith("My Vault", "root-folder-id");
		});

		it("reuses an existing obsidian-air-sync/<Vault Name> folder", async () => {
			// Root exists.
			mock.findChildByName.mockResolvedValueOnce(makeFolder("root-folder-id", REMOTE_VAULT_ROOT));
			// resolveByName: found by name.
			mock.findChildByName.mockResolvedValueOnce(makeFolder("named-id", "My Vault"));

			const result = await resolveGDriveRemoteVault(mock.client, "My Vault", undefined);

			expect(result.backendUpdates).toEqual({ remoteVaultFolderId: "named-id" });
			expect(mock.createFolder).not.toHaveBeenCalled();
		});
	});
});
