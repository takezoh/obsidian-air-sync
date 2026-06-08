import type { App } from "obsidian";
import { Platform } from "obsidian";
import { getBackendData } from "../backend";
import type { IBackendProvider, WebFolderPicker } from "../backend";
import type { ISecretStore } from "../secret-store";
import type { IFileSystem } from "../interface";
import type { IBackendSettingsRenderer } from "../settings-renderer";
import type { AirSyncSettings } from "../../settings";
import type { Logger } from "../../logging/logger";
import type { RemoteVaultResolution } from "../remote-vault-contract";
import { MetadataStore } from "../../store/metadata-store";
import { DropboxClient } from "./client";
import { DropboxFs } from "./index";
import { DropboxAuthProvider, DropboxAuth } from "./auth";
import type { DropboxEntry } from "./types";
import { DropboxApiError } from "./types";
import { DropboxSettingsRenderer } from "../../ui/dropbox-settings";
import { getBackendSecret, setBackendSecret, hasBackendSecret, clearBackendSecrets } from "../token-store";

// Note: the shared REMOTE_VAULT_ROOT wrapper folder is intentionally NOT used —
// Dropbox's App Folder scope already namespaces the app, so the vault lives at
// /<vault> directly (see resolveRemoteVault).

const BACKEND_TYPE = "dropbox";

/** Dropbox's slice of the active-backend `backendData` bag (tokens live in SecretStorage). */
export interface DropboxBackendData {
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
	/** CSRF nonce for an in-flight web folder pick (Dropbox Chooser); cleared on completion. */
	pendingFolderPickState: string;
}

const DEFAULT_DROPBOX_DATA: DropboxBackendData = {
	remoteVaultFolderId: "",
	accessTokenExpiry: 0,
	pendingCodeVerifier: "",
	pendingAuthState: "",
	pendingFolderPickState: "",
};

/**
 * Web page (on the OAuth relay domain) that hosts the Dropbox Chooser. The plugin
 * opens it in the browser; the page bounces the selection back to
 * `obsidian://air-sync-folder?id=…&name=…&state=…` (a backend-agnostic scheme,
 * not the auth one), mirroring the auth relay. The page's domain must be
 * whitelisted in the Dropbox app's Chooser settings, or it shows "App is misconfigured".
 */
const FOLDER_PICKER_URL = "https://airsync.takezo.dev/dropbox-folder";

/** Random hex nonce for the folder-pick CSRF `state`. */
function randomState(): string {
	const arr = new Uint8Array(24);
	crypto.getRandomValues(arr);
	let out = "";
	for (const b of arr) out += b.toString(16).padStart(2, "0");
	return out;
}

/**
 * Dropbox backend provider — in-plugin PKCE (worker-less), App Folder scope.
 *
 * Addressing is path-based: the remote vault is `/<vault>` directly under the
 * App Folder root (the App Folder scope already namespaces the app, so no
 * obsidian-air-sync/ wrapper is needed). The delta cursor is committed only on a
 * fully-successful sync — but now co-located with the file-map cache in the
 * backend's IndexedDB store (ADR 0001, via the FS's commitCheckpoint), not in
 * settings. Refreshed tokens are written back to SecretStorage.
 */
export class DropboxProvider implements IBackendProvider {
	readonly type = BACKEND_TYPE;
	readonly displayName = "Dropbox";
	readonly auth: DropboxAuthProvider;

	constructor(private secretStore: ISecretStore) {
		this.auth = new DropboxAuthProvider(secretStore);
	}

	private getData(settings: AirSyncSettings): DropboxBackendData {
		return { ...DEFAULT_DROPBOX_DATA, ...getBackendData<DropboxBackendData>(settings) };
	}

	/** Build a token-bearing client from the stored secrets + expiry. */
	private makeClient(data: DropboxBackendData, logger?: Logger): DropboxClient {
		return this.clientFromAuth(this.auth.getOrCreateAuth(logger), data, logger);
	}

	/**
	 * A client backed by a throwaway auth, isolated from the shared FS-bound token
	 * manager — for one-off reads (settings folder-path display) that may run
	 * concurrently with a live sync and must not reset its in-memory tokens.
	 */
	private makeDetachedClient(data: DropboxBackendData, logger?: Logger): DropboxClient {
		return this.clientFromAuth(this.auth.createDetachedAuth(logger), data, logger);
	}

	private clientFromAuth(auth: DropboxAuth, data: DropboxBackendData, logger?: Logger): DropboxClient {
		auth.setTokens(
			getBackendSecret(this.secretStore, BACKEND_TYPE, "refresh"),
			getBackendSecret(this.secretStore, BACKEND_TYPE, "access"),
			data.accessTokenExpiry,
		);
		return new DropboxClient((force) => auth.getAccessToken(force), logger);
	}

	/** The per-target checkpoint store (file-map cache + delta cursor), keyed by id. */
	private metadataStoreFor(settings: AirSyncSettings): MetadataStore<DropboxEntry> | null {
		const id = this.getData(settings).remoteVaultFolderId;
		if (!id) return null;
		return new MetadataStore<DropboxEntry>(
			`${settings.vaultId}-${id}`,
			{ dbNamePrefix: "air-sync-dropbox", version: 1 },
		);
	}

	createFs(_app: App, settings: AirSyncSettings, logger?: Logger): IFileSystem | null {
		const data = this.getData(settings);
		const hasToken =
			hasBackendSecret(this.secretStore, BACKEND_TYPE, "refresh") ||
			hasBackendSecret(this.secretStore, BACKEND_TYPE, "access");
		// The folder id is the sole remote address; the FS resolves any path it needs
		// from it on demand.
		if (!hasToken || !data.remoteVaultFolderId) return null;

		const client = this.makeClient(data, logger);
		// The delta cursor is restored from this store (co-located with the cache),
		// not from settings.
		return new DropboxFs(client, data.remoteVaultFolderId, logger, this.metadataStoreFor(settings) ?? undefined);
	}

	isConnected(settings: AirSyncSettings): boolean {
		const hasToken =
			hasBackendSecret(this.secretStore, BACKEND_TYPE, "refresh") ||
			hasBackendSecret(this.secretStore, BACKEND_TYPE, "access");
		return hasToken && !!this.getData(settings).remoteVaultFolderId;
	}

	getIdentity(settings: AirSyncSettings): string | null {
		const id = this.getData(settings).remoteVaultFolderId;
		return id ? `${BACKEND_TYPE}:${id}` : null;
	}

	createSettingsRenderer(): IBackendSettingsRenderer {
		return new DropboxSettingsRenderer();
	}

	readBackendState(): Record<string, unknown> {
		const result: Record<string, unknown> = {};
		// The delta cursor is no longer persisted in settings — it commits atomically
		// with the file map in the metadata store (ADR 0001, via the FS's
		// commitCheckpoint). Here we only persist refreshed tokens (access may have
		// rotated; refresh usually stable) and the non-secret expiry; the tokens
		// themselves go to SecretStorage. Saved every cycle, clean or not: a refresh
		// that already succeeded should not be discarded because a later file op failed.
		const tokens = this.auth.getTokenState();
		if (tokens && (tokens.refreshToken || tokens.accessToken)) {
			setBackendSecret(this.secretStore, BACKEND_TYPE, "refresh", tokens.refreshToken);
			setBackendSecret(this.secretStore, BACKEND_TYPE, "access", tokens.accessToken);
			result.accessTokenExpiry = tokens.accessTokenExpiry;
		}
		return result;
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
			// First connect: create `/<vault>` directly under the App Folder root (the
			// App Folder scope already namespaces the app, so no wrapper folder). An
			// empty name is refused rather than collapsing the root to "/".
			if (!vaultName.trim()) {
				throw new Error("Cannot resolve the Dropbox remote vault: the vault name is empty.");
			}
			const client = this.makeClient(data, logger);
			const vault = await client.createFolder(`/${vaultName}`);
			folderId = vault.id ?? "";
		}
		// Already bound: the folder is tracked by its stable id, so a LOCAL vault rename
		// does NOT rename/move the remote folder — the existing binding is kept as-is.

		return {
			backendUpdates: { remoteVaultFolderId: folderId },
		};
	}

	/**
	 * Every Dropbox backend IS its own folder-pick capability — it implements both
	 * halves directly. Exposing `this` (typed down to {@link WebFolderPicker}) lets
	 * BackendManager treat the pair as one all-or-nothing capability (`provider.picker?.…`).
	 */
	get picker(): WebFolderPicker {
		return this;
	}

	/**
	 * Open the Dropbox Chooser (hosted on the relay domain) in the browser. The
	 * selection returns via `obsidian://air-sync-folder` and is bound by
	 * {@link completeWebFolderPick}. Returns the CSRF state to persist.
	 */
	startWebFolderPick(_settings: AirSyncSettings): Promise<Record<string, unknown>> {
		const state = randomState();
		const url = `${FOLDER_PICKER_URL}?state=${encodeURIComponent(state)}`;
		if (Platform.isMobile) {
			window.location.href = url;
		} else {
			window.open(url);
		}
		return Promise.resolve({ pendingFolderPickState: state });
	}

	/**
	 * Bind the vault to a folder picked via the Chooser. Validates the CSRF state,
	 * then confirms the chosen id is reachable with the App Folder token via
	 * `get_metadata` — the Chooser browses the whole Dropbox, but an App Folder
	 * token can only address ids inside `/Apps/<App>/`, so a folder picked outside
	 * it is rejected with a clear message rather than silently failing to sync.
	 */
	async completeWebFolderPick(
		params: Record<string, string | undefined>,
		settings: AirSyncSettings,
		logger?: Logger,
	): Promise<RemoteVaultResolution> {
		const data = this.getData(settings);
		const expectedState = data.pendingFolderPickState;
		if (!expectedState || params.state !== expectedState) {
			throw new Error("State mismatch - possible CSRF attack");
		}
		const rawId = params.id?.trim();
		if (!rawId) throw new Error("No folder was selected.");
		const id = rawId.startsWith("id:") ? rawId : `id:${rawId}`;

		const client = this.makeClient(data, logger);
		let entry: DropboxEntry;
		try {
			entry = await client.getMetadata(id);
		} catch (err) {
			// Only a genuine not_found means the folder is outside the app folder (an
			// App Folder token sees inaccessible paths as missing). Transient/auth/
			// rate-limit errors must surface as themselves so the user reconnects or
			// retries instead of being told to re-pick a perfectly valid folder.
			if (err instanceof DropboxApiError && err.summary.includes("not_found")) {
				logger?.warn("Picked Dropbox folder is outside the app folder", { id });
				throw new Error(
					"That folder isn't inside the Air Sync app folder, so it can't be synced. Pick a folder under Apps/Air Sync/.",
				);
			}
			throw err;
		}
		if (entry[".tag"] !== "folder") {
			throw new Error("Please select a folder, not a file.");
		}

		// Bind by id only — the id is the sole remote address and the sync engine
		// addresses everything by it, so a picked folder needs no name recorded.
		return {
			backendUpdates: {
				remoteVaultFolderId: entry.id ?? id,
				pendingFolderPickState: "",
			},
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

	/**
	 * Clear the per-target checkpoint store (file-map cache + delta cursor) by its
	 * settings key, without a live FS (used by disconnect when the backend had no live
	 * FS — e.g. expired auth — so no stale checkpoint survives). Best-effort.
	 */
	async clearCheckpointStore(settings: AirSyncSettings): Promise<void> {
		const store = this.metadataStoreFor(settings);
		if (!store) return;
		try {
			await store.open();
			await store.clear();
			await store.close();
		} catch {
			/* non-fatal: an orphaned store is keyed by the old target and never reused */
		}
	}

	async disconnect(_settings: AirSyncSettings): Promise<Record<string, unknown>> {
		await this.auth.revokeAuth();
		this.clearPluginSecrets();
		// The per-target IndexedDB cache + cursor is cleared by BackendManager via the
		// live FS's resetCheckpoint() (one connection, no race) — see disconnectBackend.
		return { ...DEFAULT_DROPBOX_DATA };
	}

	clearPluginSecrets(): void {
		clearBackendSecrets(this.secretStore, BACKEND_TYPE, ["access", "refresh"]);
	}
}
