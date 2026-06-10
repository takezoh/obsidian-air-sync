import type { DriveClient } from "../../src/fs/googledrive/client";
import type { DropboxClient } from "../../src/fs/dropbox/client";

/**
 * Per-test isolation for the real-cloud contract run.
 *
 * `runIFileSystemContract` rebuilds the FS in `beforeEach` and assumes a CLEAN,
 * EMPTY root each time, but exposes no cleanup hook. So each backend creates ONE
 * throwaway parent folder per run (in `beforeAll`) and a FRESH child folder per
 * test (the `makeFs` factory). The whole tree is removed once in `afterAll` by
 * deleting the parent recursively.
 */

function uniqueName(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Google Drive ──────────────────────────────────────────────────────────

/** Create the per-run parent under "root" (Drive's My Drive alias); returns its id. */
export async function makeDriveParent(client: DriveClient): Promise<string> {
	const folder = await client.createFolder(uniqueName("airsync-e2e"), "root");
	return folder.id;
}

/** Create a fresh empty child folder under the parent; returns its id (per-test root). */
export async function makeDriveChild(
	client: DriveClient,
	parentId: string,
): Promise<string> {
	const folder = await client.createFolder(uniqueName("t"), parentId);
	return folder.id;
}

/** Permanently delete the parent and everything under it (skip trash so reruns stay clean). */
export async function cleanupDriveParent(
	client: DriveClient,
	parentId: string,
): Promise<void> {
	await client.deleteFile(parentId, true);
}

// ── Dropbox ───────────────────────────────────────────────────────────────

/** Create the per-run parent in the app folder; returns its stable id (`id:…`). */
export async function makeDropboxParent(client: DropboxClient): Promise<string> {
	const entry = await client.createFolder(`/${uniqueName("airsync-e2e")}`);
	return entry.id;
}

/**
 * Create a fresh empty child folder under the parent; returns its id (per-test
 * root). Dropbox accepts `id:<folder>/<sub>` addressing for create — the same
 * scheme `DropboxFs` itself uses.
 */
export async function makeDropboxChild(
	client: DropboxClient,
	parentId: string,
): Promise<string> {
	const entry = await client.createFolder(`${parentId}/${uniqueName("t")}`);
	return entry.id;
}

/** Recursively delete the parent (idempotent: an already-gone path is a no-op). */
export async function cleanupDropboxParent(
	client: DropboxClient,
	parentId: string,
): Promise<void> {
	await client.deletePath(parentId);
}
