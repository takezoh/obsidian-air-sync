import type { DriveClient } from "./client";
import type { Logger } from "../../logging/logger";
import type { RemoteVaultResolution } from "../remote-vault-contract";
import { REMOTE_VAULT_ROOT } from "../remote-vault-contract";
import { FOLDER_MIME } from "./types";

/**
 * Resolve or create this vault's remote folder in Google Drive, by convention.
 *
 * Layout: Drive root / obsidian-air-sync / <Vault Name>
 *
 * The folder name IS the vault name — there is no `.airsync/metadata.json`. Called
 * explicitly when the user binds the default folder (not automatically on connect).
 *
 * Order:
 *  1. cached id present → verify it still exists, keep it.
 *  2. otherwise find-or-create obsidian-air-sync/<Vault Name> and bind it.
 */
export async function resolveGDriveRemoteVault(
	client: DriveClient,
	vaultName: string,
	cachedFolderId: string | undefined,
	logger?: Logger,
): Promise<RemoteVaultResolution> {
	if (cachedFolderId) {
		return resolveLinked(client, cachedFolderId);
	}

	const rootFolder = await findOrCreateFolder(client, "root", REMOTE_VAULT_ROOT);
	logger?.debug("Remote vault root folder", { id: rootFolder.id });

	return resolveByName(client, rootFolder.id, vaultName, logger);
}

async function resolveLinked(
	client: DriveClient,
	cachedFolderId: string,
): Promise<RemoteVaultResolution> {
	// Verify the cached folder still exists and is accessible.
	try {
		await client.getFile(cachedFolderId);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to access remote vault folder: ${msg}`);
	}
	return { backendUpdates: { remoteVaultFolderId: cachedFolderId } };
}

async function resolveByName(
	client: DriveClient,
	rootFolderId: string,
	vaultName: string,
	logger?: Logger,
): Promise<RemoteVaultResolution> {
	const folder = await findOrCreateFolder(client, rootFolderId, vaultName);
	logger?.info("Bound remote vault by name", { folderId: folder.id, vaultName });
	return { backendUpdates: { remoteVaultFolderId: folder.id } };
}

async function findOrCreateFolder(
	client: DriveClient,
	parentId: string,
	name: string,
): Promise<{ id: string }> {
	const existing = await client.findChildByName(parentId, name, FOLDER_MIME);
	if (existing) return existing;
	return client.createFolder(name, parentId);
}
