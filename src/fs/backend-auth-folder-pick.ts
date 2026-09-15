import type { AirSyncSettings } from "../settings";
import type { Logger } from "../logging/logger";
import type { IAuthProvider } from "./auth";
import type { WebFolderPicker } from "./backend";

export interface BackendAuthFolderPickContext {
	input: string;
	params: Record<string, string | undefined>;
	settings: AirSyncSettings;
	auth: IAuthProvider;
	picker: WebFolderPicker;
	logger: Logger;
	saveSettings: () => Promise<void>;
	resetAll: () => Promise<void>;
	closeRemoteFs: () => void;
	notify: (message: string) => void;
}

/**
 * Validate and persist the two halves of Google's top-level Picker callback.
 * The caller holds BackendManager's connecting gate, so no filesystem can be exposed
 * between authorization and folder binding.
 */
export async function completeAuthFolderPick(
	context: BackendAuthFolderPickContext,
): Promise<boolean> {
	let authCompleted = false;
	try {
		const authUpdates = await context.auth.completeAuth(context.input, context.settings.backendData);
		context.settings.backendData = { ...context.settings.backendData, ...authUpdates };
		await context.saveSettings();
		authCompleted = true;

		await context.resetAll();
		const result = await context.picker.completeWebFolderPick(
			context.params, context.settings, context.logger,
		);
		context.settings.backendData = {
			...context.settings.backendData,
			...result.backendUpdates,
		};
		await context.saveSettings();
		context.closeRemoteFs();
		context.notify("Remote folder updated");
		return true;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		const prefix = authCompleted ? "Folder selection failed" : "Authorization failed";
		context.logger.error(prefix, { message: msg });
		// A failure here happens before any sync cycle ever runs, so nothing else
		// would flush this line to .airsync/logs/ -- it would otherwise sit only
		// in the in-memory buffer (see BackendManager.logError() for the same
		// pattern at its own pre-sync-cycle error sites).
		await context.logger.flush();
		context.notify(`${prefix}: ${msg}`);
		return false;
	}
}
