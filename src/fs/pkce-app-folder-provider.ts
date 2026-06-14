import type { App } from "obsidian";
import { getBackendData } from "./backend";
import type { IBackendProvider } from "./backend";
import type { ISecretStore } from "./secret-store";
import type { IFileSystem } from "./interface";
import type { IBackendSettingsRenderer } from "./settings-renderer";
import type { AirSyncSettings } from "../settings";
import type { Logger } from "../logging/logger";
import type { RemoteVaultResolution } from "./remote-vault-contract";
import { MetadataStore } from "../store/metadata-store";
import { getBackendSecret, setBackendSecret, hasBackendSecret, clearBackendSecrets } from "./token-store";
import type { PkceAuthProvider, PkceTokenManager } from "./pkce-auth-provider";

/**
 * The `backendData` shape every in-plugin PKCE App-Folder backend stores: the bound
 * folder id (the sole remote address), the non-secret access-token expiry, and the
 * transient PKCE flow fields. Tokens themselves live in SecretStorage.
 */
export interface PkceAppFolderData {
	remoteVaultFolderId: string;
	accessTokenExpiry: number;
	pendingCodeVerifier: string;
	pendingAuthState: string;
	pendingPickedFolderPath: string;
}

/**
 * Shared backend provider for an in-plugin PKCE, App-Folder-scoped cloud (Dropbox,
 * OneDrive). Owns every part that is identical across them: data defaulting,
 * shared/detached client construction off the auth manager, the per-target checkpoint
 * store, token presence + connection + identity, refreshed-token write-back, checkpoint
 * clearing, and disconnect/secret-clear. The delta cursor is NOT in settings — it
 * co-commits with the file-map cache in the backend's IndexedDB store (ADR 0001).
 *
 * A concrete backend supplies its seams: the client/FS constructors, the store db
 * prefix, the default data, and the two genuinely backend-specific operations
 * (`resolveRemoteVault`, `getRemoteVaultDisplayPath`) plus its settings renderer.
 */
export abstract class PkceAppFolderProvider<
	TData extends PkceAppFolderData,
	TFile,
	TClient,
	TAuth extends PkceTokenManager,
> implements IBackendProvider {
	abstract readonly type: string;
	abstract readonly displayName: string;
	abstract readonly auth: PkceAuthProvider<TAuth>;

	constructor(protected secretStore: ISecretStore) {}

	// ── Per-backend seams ──
	protected abstract readonly defaultData: TData;
	protected abstract readonly dbNamePrefix: string;
	/** Build the backend's API client from a token getter. */
	protected abstract createClient(getToken: (forceRefresh?: boolean) => Promise<string>, logger?: Logger): TClient;
	/** Build the backend's IFileSystem from a client + bound folder id + checkpoint store. */
	protected abstract createFsInstance(
		client: TClient,
		folderId: string,
		logger: Logger | undefined,
		store: MetadataStore<TFile> | undefined,
	): IFileSystem;

	abstract createSettingsRenderer(): IBackendSettingsRenderer;
	abstract resolveRemoteVault(
		app: App,
		settings: AirSyncSettings,
		vaultName: string,
		logger?: Logger,
	): Promise<RemoteVaultResolution>;
	abstract getRemoteVaultDisplayPath(settings: AirSyncSettings, logger?: Logger): Promise<string | null>;

	// ── Shared plumbing ──

	protected getData(settings: AirSyncSettings): TData {
		return { ...this.defaultData, ...getBackendData<TData>(settings) };
	}

	/** Build a token-bearing client from the stored secrets + expiry (shared auth). */
	protected makeClient(data: TData, logger?: Logger): TClient {
		return this.clientFromAuth(this.auth.getOrCreateAuth(logger), data, logger);
	}

	/** A client on a throwaway auth — for one-off settings reads that must not reset the
	 *  live sync's shared in-memory tokens. */
	protected makeDetachedClient(data: TData, logger?: Logger): TClient {
		return this.clientFromAuth(this.auth.createDetachedAuth(logger), data, logger);
	}

	private clientFromAuth(auth: TAuth, data: TData, logger?: Logger): TClient {
		auth.setTokens(
			getBackendSecret(this.secretStore, this.type, "refresh"),
			getBackendSecret(this.secretStore, this.type, "access"),
			data.accessTokenExpiry,
		);
		return this.createClient((force) => auth.getAccessToken(force), logger);
	}

	/** A client usable from the settings UI / folder modal, detached so it can't clobber
	 *  a concurrently-running sync's tokens. */
	createUiClient(settings: AirSyncSettings, logger?: Logger): TClient {
		return this.makeDetachedClient(this.getData(settings), logger);
	}

	/** The per-target checkpoint store (file-map cache + delta cursor), keyed by id. */
	protected metadataStoreFor(settings: AirSyncSettings): MetadataStore<TFile> | null {
		const id = this.getData(settings).remoteVaultFolderId;
		if (!id) return null;
		return new MetadataStore<TFile>(`${settings.vaultId}-${id}`, { dbNamePrefix: this.dbNamePrefix, version: 1 });
	}

	/** A usable token exists if either secret is present (a refresh OR a live access token). */
	protected hasAnyToken(): boolean {
		return (
			hasBackendSecret(this.secretStore, this.type, "refresh") ||
			hasBackendSecret(this.secretStore, this.type, "access")
		);
	}

	createFs(_app: App, settings: AirSyncSettings, logger?: Logger): IFileSystem | null {
		const data = this.getData(settings);
		// The folder id is the sole remote address; the FS resolves any path from it.
		if (!this.hasAnyToken() || !data.remoteVaultFolderId) return null;
		const client = this.makeClient(data, logger);
		return this.createFsInstance(client, data.remoteVaultFolderId, logger, this.metadataStoreFor(settings) ?? undefined);
	}

	isConnected(settings: AirSyncSettings): boolean {
		return this.hasAnyToken() && !!this.getData(settings).remoteVaultFolderId;
	}

	getIdentity(settings: AirSyncSettings): string | null {
		const id = this.getData(settings).remoteVaultFolderId;
		return id ? `${this.type}:${id}` : null;
	}

	readBackendState(): Record<string, unknown> {
		const result: Record<string, unknown> = {};
		// The delta cursor commits atomically with the file map in the metadata store
		// (ADR 0001). Here we only persist refreshed tokens (access may have rotated) and
		// the non-secret expiry; the tokens go to SecretStorage. Saved every cycle, clean
		// or not: a refresh that already succeeded should not be discarded if a later file
		// op failed.
		const tokens = this.auth.getTokenState();
		if (tokens && (tokens.refreshToken || tokens.accessToken)) {
			setBackendSecret(this.secretStore, this.type, "refresh", tokens.refreshToken);
			setBackendSecret(this.secretStore, this.type, "access", tokens.accessToken);
			result.accessTokenExpiry = tokens.accessTokenExpiry;
		}
		return result;
	}

	/**
	 * Clear the per-target checkpoint store by its settings key, without a live FS (used
	 * by disconnect when the backend had no live FS — e.g. expired auth — so no stale
	 * checkpoint survives). Best-effort.
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
		return { ...this.defaultData } as Record<string, unknown>;
	}

	clearPluginSecrets(): void {
		clearBackendSecrets(this.secretStore, this.type, ["access", "refresh"]);
	}
}
