import type {
	BackendModule,
	BackendTarget,
	JsonObject,
	RemoteBackendAdapter,
} from "../../backend-api";
import type { App } from "../../platform/obsidian";
import type { AirSyncSettings } from "../../settings";
import type { Logger } from "../../logging/logger";
import type { IFileSystem } from "../interface";
import type { IAuthProvider } from "../auth";
import type { ISecretStore } from "../secret-store";
import type { ErrorClassification } from "../errors";
import { classifyHttpError } from "../errors";
import type { BackendPlatformInfo, IBackendProvider, RemoteVaultDisplay, WebFolderPicker } from "../backend";
import type { IBackendSettingsRenderer } from "../settings-renderer";
import type { RemoteVaultResolution } from "../remote-vault-contract";
import { METADATA_CACHE_VERSION } from "../../store/metadata-store";
import { clearManagedCheckpointStore, ManagedRemoteFs } from "../managed/managed-remote-fs";
import type { RemoteAddressing } from "../managed/mutation-bridge";
import { createModuleConnection } from "./connection-host";
import type { ModuleConfigStore, ModuleConnection } from "./connection-host";
import type { RuntimeLogSink } from "./runtime-host";
import type { PhysicalKeyResolver } from "./secret-host";
import { BackendModuleSettingsRenderer } from "../../ui/backend-module-provider-settings";
import { classifyBackendError } from "./error-bridge";
import {
	createLegacyPhysicalKeyResolver,
	legacyDbNamePrefix,
} from "./compatibility/legacy-storage-profiles";
import type { LegacyAuthMode } from "./compatibility/legacy-backend-aliases";

/**
 * The core composition that turns a validated {@link BackendModule} into the
 * production backend contract `IBackendProvider`. It owns the per-connection
 * {@link ModuleConnection} (auth/binding/config through the connection host) and
 * the single {@link ManagedRemoteFs} the sync engine consumes; a module never
 * sees `App`, settings, a store, or `IFileSystem`.
 *
 * The legacy `IBackendProvider.createFs` is synchronous, while
 * `BackendModule.createAdapter` is async. The composition resolves that at the
 * connect boundary: `prepare()` awaits adapter creation and caches the managed
 * filesystem, and `createFs()` then hands back the already-built instance. No
 * adapter is ever created synchronously.
 */
export interface BackendModuleProviderDeps {
	getSettings: () => AirSyncSettings;
	saveSettings: () => Promise<void>;
	getApp: () => App;
	getLogger: () => Logger;
	getVaultName: () => string;
	secretStore: ISecretStore;
	platform: BackendPlatformInfo;
	sink: RuntimeLogSink;
}

/**
 * The ONE boundary deriving the legacy physical-profile name from the persisted
 * boolean `authMode`: `true` = the user's own OAuth app, `false` = the built-in app.
 */
function authModeOf(config: Readonly<JsonObject>): LegacyAuthMode {
	return config.authMode === true ? "custom" : "default";
}

function addressingOf(moduleId: string): RemoteAddressing {
	return moduleId === "dropbox" ? "provider_path" : "parent_id";
}

function stringParams(params: Record<string, string | undefined>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(params)) {
		if (typeof value === "string") out[key] = value;
	}
	return out;
}

export class BackendModuleProvider implements IBackendProvider {
	readonly type: string;
	readonly displayName: string;
	readonly auth: IAuthProvider;

	private readonly module: BackendModule;
	private readonly deps: BackendModuleProviderDeps;
	private generation = 0;
	private connection: ModuleConnection | null = null;
	private connectionAuthMode: LegacyAuthMode | null = null;
	private preparedFs: IFileSystem | null = null;
	private preparedAdapter: RemoteBackendAdapter | null = null;
	private readonly configStore: ModuleConfigStore;

	constructor(module: BackendModule, deps: BackendModuleProviderDeps) {
		this.module = module;
		this.deps = deps;
		this.type = module.id;
		this.displayName = module.displayName;
		this.configStore = {
			read: () => this.deps.getSettings().backendData as JsonObject,
			write: async (next) => {
				this.deps.getSettings().backendData = next;
				await this.deps.saveSettings();
			},
			clear: async () => {
				this.deps.getSettings().backendData = this.disconnectedBag();
				await this.deps.saveSettings();
			},
		};
		// The connection host is the single owner of config patch application and
		// persistence (generation-gated). These methods therefore return `{}`: the
		// caller's merge is a no-op and the live bag is authoritative.
		this.auth = {
			isAuthenticated: () => this.isAuthenticated(),
			startAuth: async () => {
				this.ensureConnection();
				await this.connection!.startAuth();
				return {};
			},
			completeAuth: async (input) => {
				this.ensureConnection();
				await this.connection!.completeAuth(input);
				return {};
			},
		};
	}

	getModule(): BackendModule {
		return this.module;
	}

	// ── Config/secret profiles (bounded compatibility) ──

	private referenceFieldKeys(): ReadonlySet<string> {
		return new Set(
			(this.module.settings?.fields ?? [])
				.filter((field) => field.type === "secret_reference")
				.map((field) => field.key),
		);
	}

	/**
	 * Resolve a module logical secret key to its physical SecretStorage key. A
	 * declared `secret_reference` field holds a user-owned secret *name* in config,
	 * so the physical key is that name (never a plugin-owned `-token` key). Every
	 * other key keeps the legacy `air-sync-<service>[<authMode>]-<key>-token` name.
	 */
	private physicalKeyResolver(authMode: LegacyAuthMode): PhysicalKeyResolver {
		const legacy = createLegacyPhysicalKeyResolver(authMode);
		const references = this.referenceFieldKeys();
		return (moduleId, logicalKey) => {
			if (references.has(logicalKey)) {
				const reference = this.configStore.read()[logicalKey];
				return typeof reference === "string" ? reference : "";
			}
			return legacy(moduleId, logicalKey);
		};
	}

	private target(): BackendTarget | null {
		return this.module.getTarget(this.configStore.read());
	}

	private hasToken(authMode: LegacyAuthMode): boolean {
		const physical = createLegacyPhysicalKeyResolver(authMode);
		return Boolean(
			this.deps.secretStore.getSecret(physical(this.module.id, "refresh")) ||
			this.deps.secretStore.getSecret(physical(this.module.id, "access")),
		);
	}

	// ── Connection/FS preparation ──

	private ensureConnection(): ModuleConnection {
		const authMode = authModeOf(this.configStore.read());
		if (this.connection && this.connectionAuthMode === authMode) return this.connection;
		return this.rebuildConnection(authMode);
	}

	private rebuildConnection(authMode: LegacyAuthMode): ModuleConnection {
		this.connection?.dispose().catch(() => undefined);
		const generation = ++this.generation;
		this.connection = createModuleConnection({
			module: this.module,
			generation,
			isCurrentGeneration: (candidate) => candidate === this.generation,
			secrets: this.deps.secretStore,
			sink: this.deps.sink,
			config: this.configStore,
			resolvePhysicalKey: this.physicalKeyResolver(authMode),
			openUrl: (url) => {
				if (this.deps.platform.mobile) {
					window.location.href = url;
				} else {
					window.open(url, "_blank", "noopener");
				}
			},
		});
		this.connectionAuthMode = authMode;
		return this.connection;
	}

	/** Await adapter creation at the connect boundary; caches the managed FS. */
	async prepare(): Promise<void> {
		const config = this.configStore.read();
		const authMode = authModeOf(config);
		const connection = this.ensureConnection();
		this.closePrepared();
		const target = this.module.getTarget(config);
		if (!target) return;
		const adapter = await this.module.createAdapter(connection.context, config, target);
		this.preparedAdapter = adapter;
		this.preparedFs = new ManagedRemoteFs({
			adapter,
			name: this.module.id,
			rootFolderId: target.id,
			vaultId: `${this.deps.getSettings().vaultId}-${target.id}`,
			store: { dbNamePrefix: legacyDbNamePrefix(this.module.id, authMode), version: METADATA_CACHE_VERSION },
			addressing: addressingOf(this.module.id),
			logger: this.deps.getLogger(),
		});
	}

	private closePrepared(): void {
		const fs = this.preparedFs;
		this.preparedFs = null;
		this.preparedAdapter = null;
		fs?.close?.()?.catch(() => undefined);
	}

	// ── IBackendProvider ──

	createFs(_app: App, _settings: AirSyncSettings, _logger?: Logger): IFileSystem | null {
		return this.preparedFs;
	}

	isConnected(_settings: AirSyncSettings): boolean {
		if (!this.target()) return false;
		return this.hasToken(authModeOf(this.configStore.read()));
	}

	/** Whether a plugin-owned token exists for the current auth mode (auth gate). */
	hasCredentials(): boolean {
		return this.hasToken(authModeOf(this.configStore.read()));
	}

	isAuthenticated(): boolean {
		const config = this.configStore.read();
		if (!this.module.auth.isAuthenticated(this.ensureConnection().context, config)) return false;
		return this.hasToken(authModeOf(config));
	}

	getIdentity(_settings: AirSyncSettings): string | null {
		const target = this.target();
		return target ? `${this.module.id}:${target.id}` : null;
	}

	/** Persist non-authoritative auth state (e.g. refreshed `accessTokenExpiry`) after a clean cycle. */
	readBackendState(): Record<string, unknown> {
		return { ...(this.preparedAdapter?.readState?.() ?? {}) };
	}

	createSettingsRenderer(): IBackendSettingsRenderer {
		return new BackendModuleSettingsRenderer(this);
	}

	/** The minimal list client the core in-app folder picker needs. */
	createUiClient(_settings?: AirSyncSettings): { listAppRootFolders(): Promise<{ name: string }[]> } {
		return {
			listAppRootFolders: async () =>
				(await this.ensureConnection().listAppRootFolders()).map((name) => ({ name })),
		};
	}

	classifyError(err: unknown): ErrorClassification {
		return classifyBackendError(err) ?? classifyHttpError(err);
	}

	async resolveRemoteVault(
		_app: App,
		_settings: AirSyncSettings,
		vaultName: string,
		_logger?: Logger,
	): Promise<RemoteVaultResolution> {
		const connection = this.ensureConnection();
		const target = await connection.resolveDefaultFolder(vaultName);
		if (!target) throw new Error("Failed to resolve the remote folder.");
		return { backendUpdates: {} };
	}

	get picker(): WebFolderPicker | undefined {
		const config = this.configStore.read();
		if (!this.module.binding.beginPick || !this.module.binding.completePick) return undefined;
		// Custom Google OAuth has no Picker: the user types a folder id instead.
		if (authModeOf(config) !== "default") return undefined;
		return {
			startWebFolderPick: async () => {
				const connection = this.ensureConnection();
				await connection.beginPick();
				return {};
			},
			completeWebFolderPick: async (params) => {
				const connection = this.ensureConnection();
				const target = await connection.completePick(stringParams(params));
				if (!target) throw new Error("Folder selection failed.");
				return { backendUpdates: {} };
			},
		};
	}

	async getRemoteVaultDisplayPath(
		_settings: AirSyncSettings,
		_logger?: Logger,
	): Promise<RemoteVaultDisplay | null> {
		const config = this.configStore.read();
		const target = this.module.getTarget(config);
		if (!target || !this.module.binding.getDisplayPath) return null;
		const connection = this.ensureConnection();
		const resolved = await this.module.binding.getDisplayPath(connection.context, config, target);
		if (!resolved?.displayPath) return null;
		return resolved.warning
			? { path: resolved.displayPath, warning: resolved.warning }
			: { path: resolved.displayPath };
	}

	/**
	 * Confirm an already-bound target is usable before exposing the FS. `assertRootAlive`
	 * is the provider's own verdict; a transport/auth/rate-limit failure fails open so a
	 * correct binding is never rejected because the provider was momentarily unreachable.
	 */
	async validateRemoteVault(_settings: AirSyncSettings, logger?: Logger): Promise<void> {
		const adapter = this.preparedAdapter;
		if (!adapter) return;
		try {
			await adapter.assertRootAlive();
		} catch (err) {
			const classification = classifyBackendError(err);
			if (
				classification === null ||
				classification.kind === "auth" ||
				classification.kind === "rateLimit" ||
				classification.kind === "transient"
			) {
				logger?.warn("Could not validate the bound remote folder; continuing", {
					message: err instanceof Error ? err.message : String(err),
				});
				return;
			}
			throw err instanceof Error ? err : new Error(String(err));
		}
	}

	async clearCheckpointStore(settings: AirSyncSettings): Promise<void> {
		const target = this.target();
		if (!target) return;
		await clearManagedCheckpointStore(`${settings.vaultId}-${target.id}`, {
			dbNamePrefix: legacyDbNamePrefix(this.module.id, authModeOf(this.configStore.read())),
			version: METADATA_CACHE_VERSION,
		});
	}

	async disconnect(_settings: AirSyncSettings): Promise<Record<string, unknown>> {
		this.ensureConnection();
		await this.connection!.disconnect();
		this.closePrepared();
		return { ...this.configStore.read() };
	}

	/** Sweep this module's plugin-owned tokens under every auth-mode profile. */
	clearPluginSecrets(): void {
		for (const authMode of ["default", "custom"] as const) {
			const physical = createLegacyPhysicalKeyResolver(authMode);
			for (const key of ["refresh", "access"]) {
				this.deps.secretStore.setSecret(physical(this.module.id, key), "");
			}
		}
	}

	close(): void {
		this.connection?.dispose().catch(() => undefined);
		this.closePrepared();
	}

	/**
	 * The disconnected config bag: preserve `authMode` (boolean) plus the user's
	 * custom-OAuth fields so a reconnect need not re-enter them. Google custom
	 * additionally keeps its hand-typed folder id (it has no Picker). A built-in
	 * selection keeps only `authMode`, matching the legacy reset.
	 */
	private disconnectedBag(): Record<string, unknown> {
		const config = this.configStore.read();
		const authMode = authModeOf(config);
		const bag: Record<string, unknown> = { authMode: authMode === "custom" };
		for (const field of this.module.settings?.fields ?? []) {
			if (field.key === "authMode" || field.key === "remoteVaultFolderId") continue;
			if (!field.key.startsWith("custom")) continue;
			if (config[field.key] !== undefined) bag[field.key] = config[field.key];
		}
		if (authMode === "custom" && this.module.id === "googledrive" && typeof config.remoteVaultFolderId === "string") {
			bag.remoteVaultFolderId = config.remoteVaultFolderId;
		}
		return bag;
	}
}
