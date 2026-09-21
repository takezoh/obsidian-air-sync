import { errorMessage } from "../../backend-api";
import type { GoogleDriveClient } from "./client";
import type { BackendLogger } from "../../backend-api";
import type { RemoteVaultResolution } from "../../backend-api/remote-vault-contract";
import { REMOTE_VAULT_ROOT } from "../../backend-api/remote-vault-contract";
import { FOLDER_MIME } from "./types";
import { inspectGoogleDriveFolder } from "./folder-usability";

/**
 * Resolve or create this vault's remote folder in Google Drive, by convention.
 *
 * Layout: Google Drive root / obsidian-air-sync / <Vault Name>
 *
 * The folder name IS the vault name — there is no `.airsync/metadata.json`. Called
 * explicitly when the user binds the default folder (not automatically on connect).
 *
 * Order:
 *  1. cached id present → verify it still exists, keep it.
 *  2. otherwise find-or-create obsidian-air-sync/<Vault Name> and bind it.
 */
export async function resolveGoogleDriveRemoteVault(
	client: GoogleDriveClient,
	vaultName: string,
	cachedFolderId: string | undefined,
	logger?: BackendLogger,
): Promise<RemoteVaultResolution> {
	if (cachedFolderId) {
		return resolveLinked(client, cachedFolderId);
	}

	const rootFolder = await findOrCreateFolder(client, "root", REMOTE_VAULT_ROOT);
	logger?.debug("Remote vault root folder", { id: rootFolder.id });

	return resolveByName(client, rootFolder.id, vaultName, logger);
}

async function resolveLinked(
	client: GoogleDriveClient,
	cachedFolderId: string,
): Promise<RemoteVaultResolution> {
	// Verify the cached folder is still bindable through the shared seam. A folder
	// moved to Trash still resolves via getFile (HTTP 200, not 404) — Drive's normal
	// single-click delete trashes rather than erases — so without this a stale link
	// would silently keep operating against a folder the user can no longer see or
	// add content to. Treat any non-usable outcome like a folder that no longer
	// exists.
	let inspection;
	try {
		inspection = await inspectGoogleDriveFolder(client, cachedFolderId);
	} catch (err) {
		// Auth/rate-limit/server failures surface with the original detail wrapped,
		// matching the previous getFile behaviour.
		const msg = errorMessage(err);
		throw new Error(`Failed to access remote vault folder: ${msg}`);
	}
	if (inspection.usable) {
		return { backendUpdates: { remoteVaultFolderId: cachedFolderId } };
	}
	switch (inspection.problem) {
		case "trashed":
			throw new Error(`Failed to access remote vault folder: folder ${cachedFolderId} is in Trash`);
		case "not_folder":
			throw new Error("Failed to access remote vault folder: folder id does not name a folder");
		case "not_found":
		case "inaccessible": {
			const detail = inspection.cause instanceof Error
				? inspection.cause.message
				: String(inspection.cause);
			throw new Error(`Failed to access remote vault folder: ${detail}`);
		}
		default: {
			const exhaustive: never = inspection;
			throw new Error(`Failed to access remote vault folder: ${String(exhaustive)}`);
		}
	}
}

async function resolveByName(
	client: GoogleDriveClient,
	rootFolderId: string,
	vaultName: string,
	logger?: BackendLogger,
): Promise<RemoteVaultResolution> {
	const folder = await findOrCreateFolder(client, rootFolderId, vaultName);
	logger?.info("Bound remote vault by name", { folderId: folder.id, vaultName });
	return { backendUpdates: { remoteVaultFolderId: folder.id } };
}

async function findOrCreateFolder(
	client: GoogleDriveClient,
	parentId: string,
	name: string,
): Promise<{ id: string }> {
	const existing = await client.findChildByName(parentId, name, FOLDER_MIME);
	if (existing) return existing;
	return client.createFolder(name, parentId);
}
