import type { App } from "obsidian";
import { Notice, Platform } from "obsidian";
import type { IBackendProvider } from "../backend";
import type { IAuthProvider } from "../auth";
import type { ISecretStore } from "../secret-store";
import type { IFileSystem } from "../interface";
import type { AirSyncSettings } from "../../settings";
import type { Logger } from "../../logging/logger";
import type { RemoteVaultResolution } from "../../sync/remote-vault";
import type { IGoogleAuth } from "./auth";
import { DriveClient } from "./client";
import { GoogleDriveFs } from "./index";
import { MetadataStore } from "../../store/metadata-store";
import { resolveGDriveRemoteVault } from "./remote-vault";
import { resolveFolderPath } from "./folder-path";
import { isHttpError } from "./incremental-sync";
import { FOLDER_MIME } from "./types";
import type { DriveFile } from "./types";
import type { GoogleDriveBackendData } from "./provider";
import { setBackendSecret, getBackendSecret, hasBackendSecret, clearBackendSecrets } from "../token-store";

interface DriveTokens {
	refreshToken: string;
	accessToken: string;
}

/** Read the Drive refresh+access tokens from SecretStorage. */
function readDriveTokens(store: ISecretStore, type: string): DriveTokens {
	return {
		refreshToken: getBackendSecret(store, type, "refresh"),
		accessToken: getBackendSecret(store, type, "access"),
	};
}

/** Persist the Drive refresh+access tokens to SecretStorage (empty values are skipped). */
function storeDriveTokens(store: ISecretStore, type: string, tokens: DriveTokens): void {
	setBackendSecret(store, type, "refresh", tokens.refreshToken);
	setBackendSecret(store, type, "access", tokens.accessToken);
}

/** Plugin-owned secret names every Drive backend stores under air-sync-<type>-<name>-token. */
const DRIVE_SECRET_NAMES = ["refresh", "access"];

/**
 * Web page (on the OAuth relay domain) that hosts the Google Picker. The plugin opens
 * it in the browser (it can't load the remote Picker SDK inside Obsidian); the page
 * bounces the selection back to `obsidian://air-sync-folder?id=…&name=…&state=…` (a
 * backend-agnostic scheme, not the auth one), mirroring the auth relay. The plugin's
 * current access token is passed in the URL fragment so the Picker can render the
 * user's Drive — the fragment never reaches the relay host.
 */
const FOLDER_PICKER_URL = "https://airsync.takezo.dev/googledrive-folder";

/** Random hex nonce for the folder-pick CSRF `state`. */
function randomState(): string {
	const arr = new Uint8Array(24);
	crypto.getRandomValues(arr);
	let out = "";
	for (const b of arr) out += b.toString(16).padStart(2, "0");
	return out;
}

/** A Drive file id is a URL-safe base64 token; reject anything else so a crafted
 *  deep link can't inject path/query segments into the getFile URL. */
const DRIVE_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Parse auth callback input (URL from auth server containing tokens or code).
 * Built-in flow: obsidian://air-sync-auth?access_token=...&refresh_token=...&expires_in=...&state=...
 * Custom flow: obsidian://air-sync-auth?code=...&state=...
 */
export function parseAuthCallbackParams(input: string): Record<string, string | undefined> {
	const trimmed = input.trim();
	if (!trimmed) {
		throw new Error("Auth callback is empty");
	}

	try {
		const url = new URL(trimmed);
		const accessToken = url.searchParams.get("access_token");
		const code = url.searchParams.get("code");
		if (!accessToken && !code) {
			throw new Error("Missing access_token or code in auth callback");
		}
		const result: Record<string, string | undefined> = {
			state: url.searchParams.get("state") ?? undefined,
		};
		if (accessToken) {
			result.access_token = accessToken;
			result.refresh_token = url.searchParams.get("refresh_token") ?? undefined;
			result.expires_in = url.searchParams.get("expires_in") ?? "3600";
		}
		if (code) {
			result.code = code;
		}
		return result;
	} catch (e) {
		if (e instanceof Error && (e.message.includes("access_token") || e.message.includes("code"))) {
			throw e;
		}
		throw new Error("Invalid auth callback URL");
	}
}

/**
 * Base auth provider for Google Drive variants.
 * Subclasses implement `createAuth` and `createAuthIfNeeded` for their specific GoogleAuth type.
 */
export abstract class GoogleDriveAuthProviderBase implements IAuthProvider {
	protected googleAuth: IGoogleAuth | null = null;
	protected readonly secretStore: ISecretStore;

	/** The backend type used for SecretStorage key generation. Set by subclass provider. */
	abstract readonly backendType: string;

	constructor(secretStore: ISecretStore) {
		this.secretStore = secretStore;
	}

	isAuthenticated(_backendData: Record<string, unknown>): boolean {
		return hasBackendSecret(this.secretStore, this.backendType, "refresh");
	}

	async startAuth(_backendData: Record<string, unknown>): Promise<Record<string, unknown>> {
		try {
			const auth = this.createAuth(_backendData);
			if (!auth) return {};

			const url = await auth.getAuthorizationUrl();
			const pendingAuthState = auth.getAuthState() ?? "";
			const pendingCodeVerifier = auth.getCodeVerifier() ?? "";

			if (Platform.isMobile) {
				window.location.href = url;
			} else {
				window.open(url);
			}
			new Notice("Complete authorization in your browser");

			return { pendingAuthState, pendingCodeVerifier };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(`Failed to start authorization: ${msg}`);
		}
	}

	async completeAuth(
		input: string,
		backendData: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		const data = backendData as Partial<GoogleDriveBackendData & { pendingCodeVerifier?: string }>;
		const auth = this.createAuthIfNeeded(backendData);
		if (!auth) {
			throw new Error("OAuth credentials are missing");
		}
		// Restore CSRF state and PKCE verifier if auth lacks them (survives plugin reload)
		if (!auth.getAuthState() && data.pendingAuthState) {
			auth.setAuthState(data.pendingAuthState);
		}
		if (!auth.getCodeVerifier() && data.pendingCodeVerifier) {
			auth.setCodeVerifier(data.pendingCodeVerifier);
		}

		const params = parseAuthCallbackParams(input);
		await auth.handleAuthCallback(params);
		const tokens = auth.getTokenState();

		// Store tokens in SecretStorage instead of returning them for backendData
		storeDriveTokens(this.secretStore, this.backendType, tokens);

		return {
			accessTokenExpiry: tokens.accessTokenExpiry,
			pendingAuthState: "",
			pendingCodeVerifier: "",
		};
	}

	/** Return the current in-memory token state (for persistence after refresh). */
	getTokenState(): { refreshToken: string; accessToken: string; accessTokenExpiry: number } | null {
		return this.googleAuth?.getTokenState() ?? null;
	}

	/** Revoke the current token (called by provider.disconnect) */
	async revokeAuth(): Promise<void> {
		if (this.googleAuth) {
			await this.googleAuth.revokeToken();
		}
		this.googleAuth = null;
	}

	/**
	 * Create a new auth instance for starting the auth flow.
	 * Returns null if preconditions are not met (e.g. missing credentials for custom).
	 */
	protected abstract createAuth(backendData: Record<string, unknown>): IGoogleAuth | null;

	/**
	 * Create an auth instance if one doesn't exist (for completeAuth).
	 * Returns null if credentials are missing.
	 */
	protected abstract createAuthIfNeeded(backendData: Record<string, unknown>): IGoogleAuth | null;

	/** Get or create a GoogleAuth instance for FS creation. */
	abstract getOrCreateGoogleAuth(data: GoogleDriveBackendData, logger: Logger | undefined): IGoogleAuth;

	/**
	 * Create a fresh, UNSHARED auth instance for one-off reads (settings folder-path
	 * display, folder pick) that must not reset the live sync's shared in-memory tokens.
	 */
	abstract createDetachedGoogleAuth(data: GoogleDriveBackendData, logger: Logger | undefined): IGoogleAuth;
}

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

	/** Build a token-bearing DriveClient on the given auth, seeded from stored secrets. */
	private clientFor(googleAuth: IGoogleAuth, data: GoogleDriveBackendData, logger?: Logger): DriveClient {
		const tokens = readDriveTokens(this.secretStore, this.type);
		googleAuth.setTokens(tokens.refreshToken, tokens.accessToken, data.accessTokenExpiry);
		return new DriveClient((force) => googleAuth.getAccessToken(force), logger);
	}

	/** A client on the SHARED auth (persists refreshes). Safe during init/rebind, which
	 *  BackendManager gates with `connecting` so no sync runs concurrently. */
	protected makeClient(settings: AirSyncSettings, logger?: Logger): DriveClient {
		const data = this.getData(settings);
		return this.clientFor(this.auth.getOrCreateGoogleAuth(data, logger), data, logger);
	}

	/** A client on a FRESH, unshared auth — for one-off settings reads that must not
	 *  reset the live sync's in-memory tokens. */
	protected makeDetachedClient(settings: AirSyncSettings, logger?: Logger): DriveClient {
		const data = this.getData(settings);
		return this.clientFor(this.auth.createDetachedGoogleAuth(data, logger), data, logger);
	}

	createFs(app: App, settings: AirSyncSettings, logger?: Logger): IFileSystem | null {
		const data = this.getData(settings);
		const tokens = readDriveTokens(this.secretStore, this.type);
		if (!tokens.refreshToken || !data.remoteVaultFolderId) return null;

		const client = this.makeClient(settings, logger);
		const metadataStore = new MetadataStore<DriveFile>(`${settings.vaultId}-${data.remoteVaultFolderId}`, {
			dbNamePrefix: "air-sync-drive",
			version: 1,
		});
		const fs = new GoogleDriveFs(client, data.remoteVaultFolderId, logger, metadataStore);

		if (data.changesStartPageToken) {
			fs.changesPageToken = data.changesStartPageToken;
		}

		return fs;
	}

	isConnected(settings: AirSyncSettings): boolean {
		return hasBackendSecret(this.secretStore, this.type, "refresh") && !!this.getData(settings).remoteVaultFolderId;
	}

	getIdentity(settings: AirSyncSettings): string | null {
		const data = this.getData(settings);
		if (!data.remoteVaultFolderId) return null;
		return `${this.type}:${data.remoteVaultFolderId}`;
	}

	resetTargetState(settings: AirSyncSettings): void {
		// backendData is the active backend's single bag, so its cursor lives at the top level.
		delete settings.backendData.changesStartPageToken;
	}

	hasCheckpoint(settings: AirSyncSettings): boolean {
		return !!this.getData(settings).changesStartPageToken;
	}

	readBackendState(fs: IFileSystem, commitCheckpoint: boolean): Record<string, unknown> {
		if (!(fs instanceof GoogleDriveFs)) return {};
		const result: Record<string, unknown> = {};

		// Advance the persisted cursor only on full success; on a partial/interrupted
		// cycle leave it at the last committed value so the next run re-detects the gap.
		const pageToken = fs.changesPageToken;
		if (commitCheckpoint && pageToken) result.changesStartPageToken = pageToken;

		// Store refreshed tokens in SecretStorage (not in backendData)
		const tokens = this.auth.getTokenState();
		if (tokens && tokens.refreshToken) {
			storeDriveTokens(this.secretStore, this.type, tokens);
			result.accessTokenExpiry = tokens.accessTokenExpiry;
		}

		return result;
	}

	/**
	 * Flush the metadata cache to IndexedDB after a clean cycle, before the cursor
	 * commits in {@link readBackendState} — so a crash can't leave the cache ahead
	 * of the committed cursor (which would drop a remote deletion the replay can't
	 * re-detect).
	 */
	async commitCheckpoint(fs: IFileSystem): Promise<void> {
		if (fs instanceof GoogleDriveFs) await fs.commitCheckpoint();
	}

	/**
	 * Find or create this vault's default remote folder (obsidian-air-sync/<Vault Name>),
	 * migrating a legacy obsidian-air-sync/<uuid>/.airsync/metadata.json vault if one
	 * matches. Invoked explicitly when the user binds the default folder — not
	 * automatically on connect.
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
		return resolveGDriveRemoteVault(client, vaultName, cachedFolderId, logger);
	}

	/**
	 * Open the Google Picker (hosted on the relay domain) in the browser. The current
	 * access token is passed in the URL fragment (never the query) so the Picker can
	 * render the user's Drive without a second sign-in; the selection returns via
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
		const tokens = readDriveTokens(this.secretStore, this.type);
		auth.setTokens(tokens.refreshToken, tokens.accessToken, data.accessTokenExpiry);
		const token = await auth.getAccessToken(false);

		const state = randomState();
		const url = `${FOLDER_PICKER_URL}?state=${encodeURIComponent(state)}#token=${encodeURIComponent(token)}`;
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
		if (!DRIVE_ID_RE.test(id)) throw new Error("Invalid folder id.");

		// Detached client (like the other picker reads) so validating the selection
		// can't reset a concurrently-running sync's in-memory tokens.
		const client = this.makeDetachedClient(settings, logger);
		let file: DriveFile;
		try {
			file = await client.getFile(id);
		} catch (err) {
			// A picked folder whose grant didn't land is unreadable: drive.file usually
			// answers 404 (the app can't see it at all), but 403 (permission denied) is
			// possible for some selections (e.g. shared drives). Both mean "re-pick";
			// anything else (auth/rate-limit/server) surfaces as-is.
			if (isHttpError(err, 404) || isHttpError(err, 403)) {
				logger?.warn("Picked Drive folder is not accessible under the granted scope", { id });
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
		return { ...this.getDefaultData() };
	}

	clearPluginSecrets(): void {
		clearBackendSecrets(this.secretStore, this.type, DRIVE_SECRET_NAMES);
	}

	protected abstract getData(settings: AirSyncSettings): GoogleDriveBackendData;
	protected abstract getDefaultData(): GoogleDriveBackendData;
}
