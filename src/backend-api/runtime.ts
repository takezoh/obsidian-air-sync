import type { JsonValue } from "./json";

/**
 * The narrow runtime capabilities core injects into a module (API v3).
 *
 * Deliberately absent: `App`, `AirSyncSettings`, the internal `Logger`, any
 * metadata/checkpoint store, and `IFileSystem`. A module sees only what it
 * needs to talk to its provider.
 */
export interface BackendRuntimeContext {
	readonly http: BackendHttpClient;
	readonly secrets: BackendSecretStore;
	readonly logger: BackendLogger;
	readonly auth: BackendAuthHost;
}

export type BackendHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface BackendHttpRequest {
	readonly url: string;
	readonly method?: BackendHttpMethod;
	readonly headers?: Readonly<Record<string, string>>;
	/** Query parameters; core appends them so a module never hand-builds a URL. */
	readonly query?: Readonly<Record<string, string>>;
	readonly body?: ArrayBuffer | string;
}

/**
 * A provider response. A module inspects status/headers/body itself and
 * translates provider-specific failures into the public error taxonomy.
 */
export interface BackendHttpResponse {
	readonly status: number;
	readonly headers: Readonly<Record<string, string>>;
	text(): Promise<string>;
	arrayBuffer(): Promise<ArrayBuffer>;
	json(): Promise<JsonValue>;
}

/** The only HTTP surface a module may use (Obsidian transport under the hood). */
export interface BackendHttpClient {
	request(request: BackendHttpRequest): Promise<BackendHttpResponse>;
}

/**
 * A module's secret access, namespaced by module id. Logical keys are declared
 * by the module (e.g. `refresh-token`); core maps them to physical keys. There
 * is no enumeration and no access to another module's namespace.
 */
export interface BackendSecretStore {
	get(logicalKey: string): Promise<string | null>;
	set(logicalKey: string, value: string): Promise<void>;
	delete(logicalKey: string): Promise<void>;
}

/** Small logging surface; core applies module attribution and redaction. */
export interface BackendLogger {
	debug(message: string, context?: Record<string, unknown>): void;
	info(message: string, context?: Record<string, unknown>): void;
	warn(message: string, context?: Record<string, unknown>): void;
	error(message: string, context?: Record<string, unknown>): void;
}

/**
 * The auth-side host surface: open an external auth screen. Modules complete the
 * flow from the callback the user pastes/redirects back into the core connect
 * flow; there is no module-facing "await a callback" push channel (core's protocol
 * handler is the only ingress).
 */
export interface BackendAuthHost {
	/** Open an external authorization URL in the user's browser. */
	openExternal(url: string): Promise<void>;
}
