import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveGoogleDriveRemoteVault } from "./remote-vault";
import { REMOTE_VAULT_ROOT } from "../remote-vault-contract";
import { FOLDER_MIME } from "./types";
import type { GoogleDriveFile } from "./types";
import type { GoogleDriveClient } from "./client";

vi.mock("obsidian");

function makeGoogleDriveFile(overrides: Partial<GoogleDriveFile> & { id: string; name: string }): GoogleDriveFile {
	return { mimeType: "application/octet-stream", ...overrides };
}

function makeFolder(id: string, name: string): GoogleDriveFile {
	return makeGoogleDriveFile({ id, name, mimeType: FOLDER_MIME });
}

function createMockClient(): {
	client: GoogleDriveClient;
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
	} as unknown as GoogleDriveClient;

	return { client, findChildByName, createFolder, getFile };
}

describe("resolveGoogleDriveRemoteVault", () => {
	let mock: ReturnType<typeof createMockClient>;

	beforeEach(() => {
		mock = createMockClient();
	});

	describe("reconnect with cached folder ID", () => {
		it("reuses the cached folder after verifying it exists, without touching the root", async () => {
			mock.getFile.mockResolvedValueOnce(makeFolder("vault-folder-id", "My Vault"));

			const result = await resolveGoogleDriveRemoteVault(mock.client, "My Vault", "vault-folder-id");

			expect(result.backendUpdates).toEqual({ remoteVaultFolderId: "vault-folder-id" });
			// Cached path goes straight to getFile — no discovery, no metadata writes.
			expect(mock.findChildByName).not.toHaveBeenCalled();
			expect(mock.createFolder).not.toHaveBeenCalled();
		});

		it("throws with original error detail when getFile fails", async () => {
			mock.getFile.mockRejectedValueOnce(new Error("Google Drive API getFile failed: File not found"));

			await expect(
				resolveGoogleDriveRemoteVault(mock.client, "My Vault", "deleted-folder-id"),
			).rejects.toThrow("Failed to access remote vault folder: Google Drive API getFile failed: File not found");
		});

		it("throws instead of silently keeping a cached folder that has been moved to Trash", async () => {
			// Drive's normal single-click delete trashes rather than erases, so
			// getFile still succeeds (HTTP 200) for a folder the user considers
			// gone — without this check, every subsequent list()/stat() would
			// keep operating against a folder invisible to the user in Drive's
			// own UI, with no error and no way to add content to it.
			mock.getFile.mockResolvedValueOnce({
				id: "trashed-folder-id", name: "My Vault", mimeType: FOLDER_MIME, trashed: true,
			});

			await expect(
				resolveGoogleDriveRemoteVault(mock.client, "My Vault", "trashed-folder-id"),
			).rejects.toThrow("Failed to access remote vault folder: folder trashed-folder-id is in Trash");
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

			const result = await resolveGoogleDriveRemoteVault(mock.client, "My Vault", undefined);

			expect(result.backendUpdates).toEqual({ remoteVaultFolderId: "new-vault-id" });
			expect(mock.createFolder).toHaveBeenCalledWith(REMOTE_VAULT_ROOT, "root");
			expect(mock.createFolder).toHaveBeenCalledWith("My Vault", "root-folder-id");
		});

		it("reuses an existing obsidian-air-sync/<Vault Name> folder", async () => {
			// Root exists.
			mock.findChildByName.mockResolvedValueOnce(makeFolder("root-folder-id", REMOTE_VAULT_ROOT));
			// resolveByName: found by name.
			mock.findChildByName.mockResolvedValueOnce(makeFolder("named-id", "My Vault"));

			const result = await resolveGoogleDriveRemoteVault(mock.client, "My Vault", undefined);

			expect(result.backendUpdates).toEqual({ remoteVaultFolderId: "named-id" });
			expect(mock.createFolder).not.toHaveBeenCalled();
		});
	});
});
