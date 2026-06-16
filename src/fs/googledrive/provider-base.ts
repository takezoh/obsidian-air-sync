import type { App } from "obsidian";
import { Platform } from "obsidian";
import type { IBackendProvider, WebFolderPicker } from "../backend";
import type { ISecretStore } from "../secret-store";
import type { IFileSystem } from "../interface";
import type { AirSyncSettings } from "../../settings";
import type { Logger } from "../../logging/logger";
import type { RemoteVaultResolution } from "../remote-vault-contract";
import type { IGoogleAuth } from "./auth";
import { GoogleDriveClient } from "./client";
import { GoogleDriveFs } from "./index";
import { MetadataStore } from "../../store/metadata-store";
import { resolveGoogleDriveRemoteVault } from "./remote-vault";
import { resolveFolderPath } from "./folder-path";
import { isHttpError } from "./incremental-sync";
import { classifyGoogleDriveError } from "./errors";
import { FOLDER_MIME } from "./types";
import type { GoogleDriveFile } from "./types";
import type { GoogleDriveBackendData } from "./provider";
import { hasBackendSecret, clearBackendSecrets } from "../token-store";
import {
	GoogleDriveAuthProviderBase,
	readGoogleDriveTokens,
	storeGoogleDriveTokens,
	GOOGLE_DRIVE_SECRET_NAMES,
} from "./auth-provider-base";

/**
 * Web page (on the OAuth relay domain) that hosts the Google Picker. The plugin opens
 * it in the browser (it can't load the remote Picker SDK inside Obsidian); the page
 * bounces the selection back to `obsidian://air-sync-folder?id=…&name=…&state=…` (a
 * backend-agnostic scheme, not the auth one), mirroring the auth relay. The plugin's
 * current access token is passed in the URL fragment so the Picker can render the
 * user's Google Drive — the fragment never reaches the relay host.
 */
const FOLDER_PICKER_URL = "https://airsync.takezo.dev/googledrive-folder";

/**
 * Public Google Picker API key, passed to the host page as `?apiKey=` so the plugin
 * owns it (the page keeps an embedded copy only as a fallback). NOT a secret: locked
 * in Cloud Console to the Picker API + referrer `airsync.takezo.dev/*`.
 */
const PICKER_API_KEY = "AIzaSyDyXTKejmlaTcBIDCx3lJYFhDMmyRKRZwc";

/** Random hex nonce for the folder-pick CSRF `state`. */
function randomState(): string {
	const arr = new Uint8Array(24);
	crypto.getRandomValues(arr);
	let out = "";
	for (const b of arr) out += b.toString(16).padStart(2, "0");
	return out;
}

/** A Google Drive file id is a URL-safe base64 token; reject anything else so a crafted
 *  deep link can't inject path/query segments into the getFile URL. */
const GOOGLE_DRIVE_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Base provider for Google Drive variants.
 * Subclasses define `getData`, `getDefaultData`, and provide the concrete auth provider.
 */
export abstract class GoogleDriveProviderBase implements IBackendProvider {
	abstract readonly type: string;
	abstract readonly displayName: string;
	abstract readonly auth: GoogleDriveAuthProviderBase;
	protected readonly secretStore: ISecretStore;

	constructor(secretStore: ISecretStore) {
		this.secretStore = secretStore;
	}

	/** Build a token-bearing GoogleDriveClient on the given auth, seeded from stored secrets. */
	private clientFor(googleAuth: IGoogleAuth, data: GoogleDriveBackendData, logger?: Logger): GoogleDriveClient {
		const tokens = readGoogleDriveTokens(this.secretStore, this.type);
		googleAuth.setTokens(tokens.refreshToken, tokens.accessToken, data.accessTokenExpiry);
		return new GoogleDriveClient((force) => googleAuth.getAccessToken(force), logger);
	}

	/** A client on the SHARED auth (persists refreshes). Safe during init/rebind, which
	 *  BackendManager gates with `connecting` so no sync runs concurrently. */
	protected makeClient(settings: AirSyncSettings, logger?: Logger): GoogleDriveClient {
		const data = this.getData(settings);
		return this.clientFor(this.auth.getOrCreateGoogleAuth(data, logger), data, logger);
	}

	/** A client on a FRESH, unshared auth — for one-off settings reads that must not
	 *  reset the live sync's in-memory tokens. */
	protected makeDetachedClient(settings: AirSyncSettings, logger?: Logger): GoogleDriveClient {
		const data = this.getData(settings);
		return this.clientFor(this.auth.createDetachedGoogleAuth(data, logger), data, logger);
	}

	/** Open the per-target IndexedDB cache store, or null if no folder is bound. */
	private metadataStoreFor(settings: AirSyncSettings): MetadataStore<GoogleDriveFile> | null {
		const data = this.getData(settings);
		if (!data.remoteVaultFolderId) return null;
		return new MetadataStore<GoogleDriveFile>(`${settings.vaultId}-${data.remoteVaultFolderId}`, {
			dbNamePrefix: "air-sync-googledrive",
			version: 1,
		});
	}

	createFs(app: App, settings: AirSyncSettings, logger?: Logger): IFileSystem | null {
		const data = this.getData(settings);
		const tokens = readGoogleDriveTokens(this.secretStore, this.type);
		if (!tokens.refreshToken || !data.remoteVaultFolderId) return null;

		const client = this.makeClient(settings, logger);
		// The delta cursor is NOT seeded from settings — it lives in the metadata
		// store alongside the file map and is restored together on init (ADR 0001).
		return new GoogleDriveFs(client, data.remoteVaultFolderId, logger, this.metadataStoreFor(settings) ?? undefined);
	}

	isConnected(settings: AirSyncSettings): boolean {
		return hasBackendSecret(this.secretStore, this.type, "refresh") && !!this.getData(settings).remoteVaultFolderId;
	}

	getIdentity(settings: AirSyncSettings): string | null {
		const data = this.getData(settings);
		if (!data.remoteVaultFolderId) return null;
		return `${this.type}:${data.remoteVaultFolderId}`;
	}

	classifyError(err: unknown) { return classifyGoogleDriveError(err); }

	readBackendState(): Record<string, unknown> {
		const result: Record<string, unknown> = {};

		// The delta cursor is no longer persisted in settings — it commits atomically
		// with the file map in the metadata store (ADR 0001, via the FS's
		// commitCheckpoint). Here we only persist the non-secret token expiry; the
		// tokens themselves go to SecretStorage. (Token state is saved on every cycle,
		// clean or not: a refresh that already succeeded should not be discarded just
		// because a later file op failed.)
		const tokens = this.auth.getTokenState();
		if (tokens && tokens.refreshToken) {
			storeGoogleDriveTokens(this.secretStore, this.type, tokens);
			result.accessTokenExpiry = tokens.accessTokenExpiry;
		}

		return result;
	}

	/**
	 * Find or create this vault's default remote folder (obsidian-air-sync/<Vault Name>).
	 * Invoked explicitly when the user binds the default folder — not automatically on
	 * connect.
	 */
	async resolveRemoteVault(
		app: App,
		settings: AirSyncSettings,
		vaultName: string,
		logger?: Logger,
	): Promise<RemoteVaultResolution> {
		const data = this.getData(settings);
		const client = this.makeClient(settings, logger);
		const cachedFolderId = data.remoteVaultFolderId || undefined;
		return resolveGoogleDriveRemoteVault(client, vaultName, cachedFolderId, logger);
	}

	/**
	 * Every Google Drive backend IS its own folder-pick capability — it implements both
	 * halves directly. Exposing `this` (typed down to {@link WebFolderPicker}) lets
	 * BackendManager treat the pair as one all-or-nothing capability (`provider.picker?.…`).
	 */
	get picker(): WebFolderPicker {
		return this;
	}

	/**
	 * Open the Google Picker (hosted on the relay domain) in the browser. The current
	 * access token is passed in the URL fragment (never the query) so the Picker can
	 * render the user's Google Drive without a second sign-in; the selection returns via
	 * `obsidian://air-sync-folder` and is bound by {@link completeWebFolderPick}.
	 * Returns the CSRF state to persist.
	 */
	async startWebFolderPick(settings: AirSyncSettings): Promise<Record<string, unknown>> {
		// Auth-only gate (not isConnected): the picker needs a token, but it is also how
		// a folder gets bound in the first place, so it must be openable before any
		// remoteVaultFolderId exists.
		if (!this.auth.isAuthenticated(settings.backendData ?? {})) {
			throw new Error("Connect to Google Drive first.");
		}
		// Fetch the token on a DETACHED auth so a refresh for the picker doesn't reset
		// the live sync's shared in-memory tokens.
		const data = this.getData(settings);
		const auth = this.auth.createDetachedGoogleAuth(data, undefined);
		const tokens = readGoogleDriveTokens(this.secretStore, this.type);
		auth.setTokens(tokens.refreshToken, tokens.accessToken, data.accessTokenExpiry);
		const token = await auth.getAccessToken(false);

		const state = randomState();
		// apiKey in the query (public, referrer-restricted); token in the fragment so it
		// never reaches the relay host — the fragment must stay last.
		const url = `${FOLDER_PICKER_URL}?state=${encodeURIComponent(state)}&apiKey=${encodeURIComponent(PICKER_API_KEY)}#token=${encodeURIComponent(token)}`;
		if (Platform.isMobile) {
			window.location.href = url;
		} else {
			window.open(url);
		}
		return { pendingFolderPickState: state };
	}

	/**
	 * Bind the vault to a folder picked via the Google Picker. Validates the CSRF
	 * state, then confirms the chosen id is a folder reachable under the current scope
	 * with `getFile`. Under `drive.file`, the Picker selection is what grants the app
	 * access — so a successful `getFile` is the proof the grant landed; a 404 means the
	 * grant didn't apply (re-pick), while auth/rate-limit/server errors surface as-is.
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
		const id = params.id?.trim();
		if (!id) throw new Error("No folder was selected.");
		if (!GOOGLE_DRIVE_ID_RE.test(id)) throw new Error("Invalid folder id.");

		// Detached client (like the other picker reads) so validating the selection
		// can't reset a concurrently-running sync's in-memory tokens.
		const client = this.makeDetachedClient(settings, logger);
		let file: GoogleDriveFile;
		try {
			file = await client.getFile(id);
		} catch (err) {
			// A picked folder whose grant didn't land is unreadable: drive.file usually
			// answers 404 (the app can't see it at all), but 403 (permission denied) is
			// possible for some selections (e.g. shared drives). Both mean "re-pick";
			// anything else (auth/rate-limit/server) surfaces as-is.
			if (isHttpError(err, 404) || isHttpError(err, 403)) {
				logger?.warn("Picked Google Drive folder is not accessible under the granted scope", { id });
				throw new Error(
					"That folder isn't accessible to Air Sync. Re-pick it in the Google Picker so access is granted.",
				);
			}
			throw err;
		}
		if (file.mimeType !== FOLDER_MIME) {
			throw new Error("Please select a folder, not a file.");
		}

		// Bind by id only — the id is the sole binding and the sync engine addresses
		// everything by it, so a picked folder needs no name/metadata recorded.
		return {
			backendUpdates: {
				remoteVaultFolderId: file.id,
				pendingFolderPickState: "",
			},
		};
	}

	/**
	 * Resolve the bound folder's current path from its id, for display in settings.
	 * Nothing is stored — this reflects the folder's live location (so a remote
	 * rename/move shows up). Walks the parent chain up to My Drive; under the
	 * built-in `drive.file` scope ungranted ancestors are unreadable, so the path
	 * may be truncated with a leading "…/" (see resolveFolderPath). Returns null
	 * if not bound.
	 */
	async getRemoteVaultDisplayPath(settings: AirSyncSettings, logger?: Logger): Promise<string | null> {
		const data = this.getData(settings);
		if (!data.remoteVaultFolderId) return null;
		// Detached client so this UI read can't reset the live sync's shared tokens.
		const client = this.makeDetachedClient(settings, logger);
		return resolveFolderPath(client, data.remoteVaultFolderId, logger);
	}

	async disconnect(_settings: AirSyncSettings): Promise<Record<string, unknown>> {
		await this.auth.revokeAuth();
		this.clearPluginSecrets();
		// The per-target IndexedDB cache + cursor is cleared by BackendManager via the
		// live FS's resetCheckpoint() (one connection, no race) — see disconnectBackend.
		return { ...this.getDefaultData() };
	}

	/**
	 * Clear the per-target checkpoint store by its settings key, without a live FS
	 * (used by disconnect when the backend had no live FS — e.g. expired auth — so
	 * no stale checkpoint survives). Best-effort: a failure must not block disconnect.
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

	clearPluginSecrets(): void {
		clearBackendSecrets(this.secretStore, this.type, GOOGLE_DRIVE_SECRET_NAMES);
	}

	protected abstract getData(settings: AirSyncSettings): GoogleDriveBackendData;
	protected abstract getDefaultData(): GoogleDriveBackendData;
}
