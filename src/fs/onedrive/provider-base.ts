import type { App } from "obsidian";
import type { IFileSystem } from "../interface";
import type { AirSyncSettings } from "../../settings";
import type { Logger } from "../../logging/logger";
import type { ErrorClassification } from "../errors";
import type { RemoteVaultResolution } from "../remote-vault-contract";
import { MetadataStore } from "../../store/metadata-store";
import { PkceAppFolderProvider, type PkceAppFolderData } from "../pkce-app-folder-provider";
import { OneDriveClient } from "./client";
import { OneDriveFs } from "./index";
import type { OneDriveAuth } from "./auth";
import type { OneDriveItem } from "./types";
import { classifyOneDriveError } from "./errors";
import { findOrCreateAppRootFolder } from "./remote-vault";

/** OneDrive's slice of the active-backend `backendData` bag (tokens live in SecretStorage). */
export interface OneDriveBackendData extends PkceAppFolderData {
	/**
	 * Stable driveItem id of the remote vault folder — the SOLE remote address. The
	 * FS addresses everything by this id; a remote move/rename of the folder needs no
	 * migration (the id is the binding).
	 */
	remoteVaultFolderId: string;
	accessTokenExpiry: number;
	pendingCodeVerifier: string;
	pendingAuthState: string;
	/**
	 * A folder name chosen in the in-app folder modal, awaiting bind. On the next
	 * `resolveRemoteVault` it is find-or-created under the App Folder root and bound;
	 * cleared afterward. Empty ⇒ bind the default (`approot:/<vaultName>`).
	 */
	pendingPickedFolderPath: string;
}

export const DEFAULT_ONEDRIVE_DATA: OneDriveBackendData = {
	remoteVaultFolderId: "",
	accessTokenExpiry: 0,
	pendingCodeVerifier: "",
	pendingAuthState: "",
	pendingPickedFolderPath: "",
};

/**
 * Shared OneDrive backend logic — in-plugin PKCE (worker-less), App Folder scope. Holds
 * everything common to the built-in and the custom-app variant: the client/FS seams,
 * error classification, and the two backend-specific operations (folder binding + display
 * path). A concrete subclass supplies the `type`/`displayName`/`auth`/`defaultData`/
 * `dbNamePrefix`/`createSettingsRenderer` identity. This base imports NO settings renderer,
 * so the concrete providers (which do) can be subclassed without a `provider → ui →
 * registry → provider-custom → provider` import cycle (mirrors `googledrive/provider-base`).
 *
 * Folder binding is an IN-APP modal (no web picker), so this provider has no `picker`.
 */
export abstract class OneDriveProviderBase extends PkceAppFolderProvider<OneDriveBackendData, OneDriveItem, OneDriveClient, OneDriveAuth> {
	protected createClient(getToken: (forceRefresh?: boolean) => Promise<string>, logger?: Logger): OneDriveClient {
		return new OneDriveClient(getToken, logger);
	}

	protected createFsInstance(
		client: OneDriveClient,
		folderId: string,
		logger: Logger | undefined,
		store: MetadataStore<OneDriveItem> | undefined,
	): IFileSystem {
		return new OneDriveFs(client, folderId, logger, store);
	}

	classifyError(err: unknown): ErrorClassification {
		return classifyOneDriveError(err);
	}

	/**
	 * Bind the remote vault folder under the App Folder root. If already bound, keep
	 * the id (a local vault rename doesn't move the remote folder). Else find-or-create
	 * `approot:/<pendingPickedFolderPath>` if the modal queued one, otherwise
	 * `approot:/<vaultName>`, and clear the pending field.
	 */
	async resolveRemoteVault(
		_app: App,
		settings: AirSyncSettings,
		vaultName: string,
		logger?: Logger,
	): Promise<RemoteVaultResolution> {
		const data = this.getData(settings);
		let folderId = data.remoteVaultFolderId;

		if (!folderId) {
			const picked = data.pendingPickedFolderPath.trim();
			const name = picked || vaultName;
			if (!name.trim()) {
				throw new Error("Cannot resolve the OneDrive remote vault: the vault name is empty.");
			}
			const client = this.makeClient(data, logger);
			const folder = await findOrCreateAppRootFolder(client, name, logger);
			folderId = folder.id;
		}

		return { backendUpdates: { remoteVaultFolderId: folderId, pendingPickedFolderPath: "" } };
	}

	/**
	 * Resolve the bound folder's current display path from its id, for settings. The
	 * path is not stored — this reflects the folder's live location. Returns the
	 * parent path + name, or just the name, or null if not bound.
	 */
	async getRemoteVaultDisplayPath(settings: AirSyncSettings, logger?: Logger): Promise<string | null> {
		const data = this.getData(settings);
		if (!data.remoteVaultFolderId) return null;
		const client = this.makeDetachedClient(data, logger);
		const item = await client.getItem(data.remoteVaultFolderId);
		const parentPath = item.parentReference?.path;
		if (parentPath) {
			// e.g. "/drive/root:/Apps/Air Sync" → strip the Graph prefix, append the name.
			const after = parentPath.split(":").pop() ?? "";
			return `${after}/${item.name}`;
		}
		return item.name;
	}
}
