import type { DriveClient } from "../../src/fs/googledrive/client";
import type { DropboxClient } from "../../src/fs/dropbox/client";
import type { OneDriveClient } from "../../src/fs/onedrive/client";

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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

/** Trash the parent and everything under it. */
export async function cleanupDriveParent(
	client: DriveClient,
	parentId: string,
): Promise<void> {
	// Trash, not permanent-delete: the drive.file scope can't hard-delete (403).
	// The per-run unique names keep reruns clean despite trashed leftovers.
	await client.deleteFile(parentId, false);
}

// ── Dropbox ───────────────────────────────────────────────────────────────
//
// Parent and child are created by ABSOLUTE path: `create_folder_v2` rejects an
// `id:<folder>/<sub>` path (it requires `/path` or `ns:<n>`). DropboxFs itself
// addresses by id, and a FRESHLY-created folder's id can transiently 400
// ("did not match pattern") on an id-relative create until it propagates — so the
// child id is warmed up (see warmUpDropboxId) before it's handed to the contract.

/** Create the per-run parent in the app folder; returns its absolute path. */
export async function makeDropboxParent(client: DropboxClient): Promise<string> {
	const path = `/${uniqueName("airsync-e2e")}`;
	await client.createFolder(path);
	return path;
}

/** Create a fresh empty child folder (absolute path) and return its warmed-up id. */
export async function makeDropboxChild(
	client: DropboxClient,
	parentPath: string,
): Promise<string> {
	const entry = await client.createFolder(`${parentPath}/${uniqueName("t")}`);
	await warmUpDropboxId(client, entry.id);
	return entry.id;
}

const WARMUP_ATTEMPTS = 12;

/**
 * Make a freshly-created folder id safe for DropboxFs to use: probe id-relative
 * `create_folder_v2` (which transiently 400s "did not match pattern" on a brand-new
 * id until it propagates), retrying until it succeeds, then remove the probe.
 *
 * The probe is created and deleted inside the child; Dropbox gives the deleting
 * client read-after-write consistency, so the cold scan that follows sees an empty
 * child (confirmed across runs). We deliberately do NOT then poll
 * `listFolderAll(childId)` to "confirm empty" — on a still-propagating id that list
 * transiently resolves to the PARENT and never empties, which is a false failure.
 */
async function warmUpDropboxId(client: DropboxClient, id: string): Promise<void> {
	for (let attempt = 0; attempt < WARMUP_ATTEMPTS; attempt++) {
		try {
			const probe = await client.createFolder(`${id}/__warmup`);
			await client.deletePath(probe.id);
			return;
		} catch (err) {
			if (attempt === WARMUP_ATTEMPTS - 1) throw err;
			await sleep(500);
		}
	}
}

/** Recursively delete the parent (idempotent: an already-gone path is a no-op). */
export async function cleanupDropboxParent(
	client: DropboxClient,
	parentPath: string,
): Promise<void> {
	await client.deletePath(parentPath);
}

// ── OneDrive ────────────────────────────────────────────────────────────────
//
// The App Folder scope (Files.ReadWrite.AppFolder) confines everything under
// /me/drive/special/approot, so the per-run parent is created directly inside that
// app-root item. OneDrive addresses items by their stable driveItem id (like Drive,
// unlike Dropbox's id warm-up dance), so a freshly-created folder id is usable at once.

/** Create the per-run parent under the App Folder root; returns its id. */
export async function makeOneDriveParent(client: OneDriveClient): Promise<string> {
	// Touching `special/approot` provisions the app folder on first access, then we
	// anchor the throwaway tree under its id.
	const appRoot = await client.getAppRoot();
	const folder = await client.createFolder(appRoot.id, uniqueName("airsync-e2e"));
	return folder.id;
}

/** Create a fresh empty child folder under the parent; returns its id (per-test root). */
export async function makeOneDriveChild(
	client: OneDriveClient,
	parentId: string,
): Promise<string> {
	const folder = await client.createFolder(parentId, uniqueName("t"));
	return folder.id;
}

/** Delete the parent and its whole subtree (idempotent: deleteItem no-ops on a 404). */
export async function cleanupOneDriveParent(
	client: OneDriveClient,
	parentId: string,
): Promise<void> {
	await client.deleteItem(parentId);
}
