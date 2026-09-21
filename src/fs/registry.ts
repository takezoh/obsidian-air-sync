import type { App } from "../platform/obsidian";
import type { AirSyncSettings } from "../settings";
import type { Logger } from "../logging/logger";
import type { BackendPlatformInfo, IBackendProvider } from "./backend";
import type { ISecretStore } from "./secret-store";
import { BackendModuleRegistry } from "./modules/registry";
import { BUILTIN_BACKEND_MODULES } from "./modules/builtin-modules";
import { BackendModuleProvider } from "./modules/backend-module-provider";
import type { BackendModuleProviderDeps } from "./modules/backend-module-provider";
import type { RuntimeLogLevel } from "./modules/runtime-host";

/**
 * Production backend composition.
 *
 * The three canonical backend modules (`googledrive` / `onedrive` / `dropbox`)
 * are validated and registered through the public `BackendModuleRegistry` and
 * wrapped in the core `BackendModuleProvider`, which owns the connection host and
 * the single `ManagedRemoteFs`. The legacy `IBackendProvider` registrations are
 * gone; only the three module-backed providers exist.
 *
 * The `*-custom` ids are settings aliases, never registered here.
 */
export interface BackendRegistryDeps {
	getSettings: () => AirSyncSettings;
	saveSettings: () => Promise<void>;
	getApp: () => App;
	getLogger: () => Logger;
	getVaultName: () => string;
	platform: BackendPlatformInfo;
	sink: (level: RuntimeLogLevel, message: string, moduleId: string) => void;
}

let providers: IBackendProvider[] = [];
let providerMap = new Map<string, IBackendProvider>();

/**
 * Validate and register the built-in modules, then build their production
 * providers. Called once during plugin load. Every dependency is required — the
 * production composition root must never fall back to a test stub (`{} as App`,
 * a no-op `saveSettings`, a no-op logger), which would silently break a real vault.
 */
export function initRegistry(secretStore: ISecretStore, deps: BackendRegistryDeps): void {
	const registry = new BackendModuleRegistry();
	for (const module of BUILTIN_BACKEND_MODULES) {
		const result = registry.register(module);
		if (!result.ok) {
			throw new Error(
				`Built-in backend module "${module.id}" failed registration: ` +
					result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
			);
		}
	}

	const resolved: BackendModuleProviderDeps = {
		secretStore,
		getSettings: deps.getSettings,
		saveSettings: deps.saveSettings,
		getApp: deps.getApp,
		getLogger: deps.getLogger,
		getVaultName: deps.getVaultName,
		platform: deps.platform,
		sink: deps.sink,
	};

	providers = registry.list().map((module) => new BackendModuleProvider(module, resolved));
	providerMap = new Map(providers.map((provider) => [provider.type, provider]));
}

/** Get a backend provider by canonical module id, or undefined if unknown. */
export function getBackendProvider(type: string): IBackendProvider | undefined {
	return providerMap.get(type);
}

/** Get all registered backend providers (returns a copy). */
export function getAllBackendProviders(): readonly IBackendProvider[] {
	return [...providers];
}
