import type { Logger } from "../../logging/logger";
import type { OneDriveClient } from "./client";
import type { OneDriveItem } from "./types";
import { GraphApiError } from "./types";

/**
 * Find-or-create a single-level folder named `name` directly under the App Folder
 * root, returning its driveItem. The App Folder scope already namespaces the app,
 * so the vault lives at `approot:/{name}` — no extra wrapper folder. Idempotent:
 * `createFolder` resolves a 409 name conflict to the existing folder.
 */
export async function findOrCreateAppRootFolder(
	client: OneDriveClient,
	name: string,
	logger?: Logger,
): Promise<OneDriveItem> {
	const trimmed = name.trim();
	if (!trimmed) {
		throw new Error("Cannot resolve the OneDrive remote vault: the folder name is empty.");
	}
	const appRoot = await client.getAppRoot();
	try {
		// Prefer an existing folder of this name (path-relative GET under approot).
		const existing = await client.getChildByName(appRoot.id, trimmed);
		if (existing.folder) return existing;
		throw new Error(`A file named "${trimmed}" already exists in the app folder; choose a different name.`);
	} catch (err) {
		if (err instanceof GraphApiError && err.status === 404) {
			logger?.info("Creating OneDrive vault folder under the app folder", { name: trimmed });
			return client.createFolder(appRoot.id, trimmed);
		}
		throw err;
	}
}
