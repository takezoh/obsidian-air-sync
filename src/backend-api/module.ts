import type { BackendAuth } from "./auth";
import type { BackendBinding, BackendTarget } from "./binding";
import type { JsonObject } from "./json";
import type { RemoteBackendAdapter } from "./remote-adapter";
import type { BackendRuntimeContext } from "./runtime";
import type { BackendSettingsDefinition } from "./settings";

/** The Backend Module API version this core implements. */
export const BACKEND_MODULE_API_VERSION = 1;

export type BackendModuleApiVersion = typeof BACKEND_MODULE_API_VERSION;

/**
 * A statically imported or (future) dynamically loaded backend module — the
 * public extension boundary (version 1).
 *
 * One module represents exactly one backend. The module object is a plain data
 * carrier: it holds no mutable per-connection auth state, performs no I/O during
 * registry enumeration/validation, and cannot register unrelated capabilities.
 *
 * TypeScript compatibility is not sufficient for dynamically loaded JavaScript;
 * core runtime-validates this shape before a module participates in backend
 * initialization (`validateBackendModule`).
 */
export interface BackendModule {
	/** Globally unique; also the persisted `settings.backendType` value. */
	readonly id: string;
	readonly displayName: string;
	/** Module version, independent of {@link apiVersion}. */
	readonly version: string;
	readonly apiVersion: BackendModuleApiVersion;

	readonly auth: BackendAuth;
	readonly settings?: BackendSettingsDefinition;
	readonly binding: BackendBinding;

	/** Return the bound target from config without any network call; `null` if unbound. */
	getTarget(config: Readonly<JsonObject>): BackendTarget | null;

	/** Build the provider adapter for a bound connection. Returns only the adapter. */
	createAdapter(
		context: BackendRuntimeContext,
		config: Readonly<JsonObject>,
		target: BackendTarget,
	): Promise<RemoteBackendAdapter>;
}
