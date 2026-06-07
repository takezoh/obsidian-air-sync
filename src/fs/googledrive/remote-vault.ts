import type { DriveClient } from "./client";
import type { Logger } from "../../logging/logger";
import type { RemoteVaultResolution, RemoteVaultMetadata } from "../../sync/remote-vault";
import { REMOTE_VAULT_ROOT } from "../../sync/remote-vault";
import { FOLDER_MIME } from "./types";

// Legacy layout only — read during migration of pre-existing vaults, never written.
const AIRSYNC_DIR = ".airsync";
const METADATA_FILE = "metadata.json";

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
 *  2. migration: an older vault stored under obsidian-air-sync/<uuid> with
 *     `.airsync/metadata.json` whose vaultName matches → rename that folder to the
 *     vault name, drop its metadata.json, and bind it (preserves the synced data).
 *  3. otherwise find-or-create obsidian-air-sync/<Vault Name> and bind it.
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

	const migrated = await migrateLegacyVault(client, rootFolder.id, vaultName, logger);
	if (migrated) return migrated;

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

/**
 * Migration of the legacy obsidian-air-sync/<uuid>/.airsync/metadata.json layout:
 * find the child folder whose metadata.json names this vault, rename it to the vault
 * name, trash its metadata.json, and bind it. Returns null when no legacy folder
 * matches (a fresh install, or already migrated — migrated folders have no metadata).
 */
async function migrateLegacyVault(
	client: DriveClient,
	rootFolderId: string,
	vaultName: string,
	logger?: Logger,
): Promise<RemoteVaultResolution | null> {
	const children = await client.listFiles(rootFolderId);
	const folders = children.files.filter((f) => f.mimeType === FOLDER_MIME);

	for (const folder of folders) {
		const legacy = await readLegacyMetadata(client, folder.id);
		if (!legacy || legacy.meta.vaultName !== vaultName) continue;

		// Rename <uuid> → <Vault Name> and drop the now-obsolete metadata.json. The
		// folder id is unchanged, so any device already bound to it keeps working.
		await client.updateFileMetadata(folder.id, { name: vaultName });
		await client.deleteFile(legacy.metaFileId);
		logger?.info("Migrated legacy remote vault to named folder", { folderId: folder.id, vaultName });
		return { backendUpdates: { remoteVaultFolderId: folder.id } };
	}
	return null;
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

/**
 * Read the legacy `.airsync/metadata.json` for a candidate vault folder, returning
 * both the parsed metadata and the metadata file's id (so the caller can delete it
 * during migration). Returns null if the legacy file is absent or unparseable.
 */
async function readLegacyMetadata(
	client: DriveClient,
	vaultFolderId: string,
): Promise<{ meta: RemoteVaultMetadata; metaFileId: string } | null> {
	const airsyncFolder = await client.findChildByName(vaultFolderId, AIRSYNC_DIR, FOLDER_MIME);
	if (!airsyncFolder) return null;

	const metaFile = await client.findChildByName(airsyncFolder.id, METADATA_FILE);
	if (!metaFile) return null;

	const content = await client.downloadFile(metaFile.id);
	const text = new TextDecoder().decode(content);
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || !("vaultName" in parsed)) return null;
	return { meta: parsed as RemoteVaultMetadata, metaFileId: metaFile.id };
}
