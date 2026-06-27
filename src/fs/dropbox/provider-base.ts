import type { App } from "obsidian";
import type { IFileSystem } from "../interface";
import type { AirSyncSettings } from "../../settings";
import type { Logger } from "../../logging/logger";
import type { RemoteVaultResolution } from "../remote-vault-contract";
import { MetadataStore } from "../../store/metadata-store";
import { PkceAppFolderProvider, type PkceAppFolderData } from "../pkce-app-folder-provider";
import { DropboxClient } from "./client";
import { DropboxFs } from "./index";
import type { DropboxAuth } from "./auth";
import type { DropboxEntry } from "./types";

// Note: the shared REMOTE_VAULT_ROOT wrapper folder is intentionally NOT used —
// Dropbox's App Folder scope already namespaces the app, so the vault lives at
// /<vault> directly (see resolveRemoteVault).

/** Dropbox's slice of the active-backend `backendData` bag (tokens live in SecretStorage). */
export interface DropboxBackendData extends PkceAppFolderData {
	/**
	 * Stable folder id (`id:…`) of the remote vault — the SOLE remote address.
	 * The FS addresses everything by this id (`id:<id>/<subpath>`); the folder's
	 * absolute path is never stored — it's resolved from the id on demand (for the
	 * settings display and to relativize listings), so a remote move/rename needs
	 * no migration.
	 */
	remoteVaultFolderId: string;
	accessTokenExpiry: number;
	pendingCodeVerifier: string;
	pendingAuthState: string;
	/**
	 * A folder name chosen in the in-app folder modal, awaiting bind. On the next
	 * `resolveRemoteVault` it is find-or-created under the App Folder root and bound;
	 * cleared afterward. Empty ⇒ bind the default (`/<vaultName>`).
	 */
	pendingPickedFolderPath: string;
}

export const DEFAULT_DROPBOX_DATA: DropboxBackendData = {
	remoteVaultFolderId: "",
	accessTokenExpiry: 0,
	pendingCodeVerifier: "",
	pendingAuthState: "",
	pendingPickedFolderPath: "",
};

/**
 * Shared Dropbox backend logic — in-plugin PKCE (worker-less), App Folder scope. Holds
 * everything common to the built-in and the custom-app variant: the client/FS seams and
 * the two backend-specific operations (path-based folder binding + display path). A
 * concrete subclass supplies the `type`/`displayName`/`auth`/`defaultData`/`dbNamePrefix`/
 * `createSettingsRenderer` identity. This base imports NO settings renderer, so the
 * concrete providers (which do) can be subclassed without a `provider → ui → registry →
 * provider-custom → provider` import cycle (mirrors `googledrive/provider-base`).
 *
 * Addressing is path-based: the remote vault is `/<vault>` directly under the App Folder
 * root (the scope already namespaces the app, so no wrapper folder is needed). Folder
 * binding is an IN-APP modal (no web picker), so this provider has no `picker`.
 */
export abstract class DropboxProviderBase extends PkceAppFolderProvider<DropboxBackendData, DropboxEntry, DropboxClient, DropboxAuth> {
	protected createClient(getToken: (forceRefresh?: boolean) => Promise<string>, logger?: Logger): DropboxClient {
		return new DropboxClient(getToken, logger);
	}

	protected createFsInstance(
		client: DropboxClient,
		folderId: string,
		logger: Logger | undefined,
		store: MetadataStore<DropboxEntry> | undefined,
	): IFileSystem {
		return new DropboxFs(client, folderId, logger, store);
	}

	async resolveRemoteVault(
		_app: App,
		settings: AirSyncSettings,
		vaultName: string,
		logger?: Logger,
	): Promise<RemoteVaultResolution> {
		const data = this.getData(settings);
		let folderId = data.remoteVaultFolderId;

		if (!folderId) {
			// First connect: find-or-create `/<name>` directly under the App Folder root
			// (the App Folder scope already namespaces the app, so no wrapper folder). The
			// name is the one queued by the in-app folder modal, else the vault name;
			// `create_folder_v2` is idempotent, so a picked existing folder binds as-is. An
			// empty name is refused rather than collapsing the root to "/".
			const name = data.pendingPickedFolderPath.trim() || vaultName.trim();
			if (!name) {
				throw new Error("Cannot resolve the Dropbox remote vault: the vault name is empty.");
			}
			const client = this.makeClient(data, logger);
			const vault = await client.createFolder(`/${name}`);
			// createFolder is idempotent on a path/conflict — but a conflict with an
			// existing FILE resolves to that file's metadata. Binding a file's id as the
			// vault folder would silently break every later sync, so reject it here
			// (mirrors OneDrive's find-or-create, which rejects a file-name collision).
			if (vault[".tag"] !== "folder" || !vault.id) {
				throw new Error(`A file named "${name}" already exists in the app folder; choose a different folder name.`);
			}
			folderId = vault.id;
		}
		// Already bound: the folder is tracked by its stable id, so a LOCAL vault rename
		// does NOT rename/move the remote folder — the existing binding is kept as-is.

		return {
			backendUpdates: { remoteVaultFolderId: folderId, pendingPickedFolderPath: "" },
		};
	}

	/**
	 * Resolve the bound folder's current absolute path from its id, for display in
	 * settings. The path is not stored — this reflects the folder's live location
	 * (so a remote move/rename shows up). Returns null if not bound.
	 */
	async getRemoteVaultDisplayPath(settings: AirSyncSettings, logger?: Logger): Promise<string | null> {
		const data = this.getData(settings);
		if (!data.remoteVaultFolderId) return null;
		// Detached client so this UI read can't reset the live sync's shared tokens.
		const client = this.makeDetachedClient(data, logger);
		const meta = await client.getMetadata(data.remoteVaultFolderId);
		return meta.path_display ?? null;
	}
}
