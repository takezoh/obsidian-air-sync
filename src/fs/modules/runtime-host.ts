import type {
	BackendAuthHost,
	BackendLogger,
	BackendRuntimeContext,
	BackendSecretStore,
} from "../../backend-api";
import type { ISecretStore } from "../secret-store";
import { createHttpClient } from "./http-host";
import { createSecretHost } from "./secret-host";
import type { PhysicalKeyResolver } from "./secret-host";

export type RuntimeLogLevel = "debug" | "info" | "warn" | "error";
export type RuntimeLogSink = (level: RuntimeLogLevel, message: string, moduleId: string) => void;

const SENSITIVE_QUERY =
	/([?&](?:access_token|refresh_token|code|client_secret|id_token|api_key)=)[^&\s]+/gi;
const BEARER_TOKEN = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;

/** Strip credentials from a diagnostic message before it reaches a shared sink. */
export function redactSecrets(message: string): string {
	return message.replace(SENSITIVE_QUERY, "$1[redacted]").replace(BEARER_TOKEN, "$1[redacted]");
}

export interface RuntimeHostOptions {
	readonly moduleId: string;
	/** Connection generation; bumped on every (re)connect so stale work is rejected. */
	readonly generation: number;
	readonly secrets: ISecretStore;
	/**
	 * Pre-built module-scoped secret store. When core needs to observe which
	 * logical keys a module touched (for the disconnect sequence), it builds a
	 * tracked host and injects it here instead of letting the runtime construct a
	 * plain one. Omit to get the plain namespaced store.
	 */
	readonly secretsHost?: BackendSecretStore;
	readonly sink: RuntimeLogSink;
	readonly auth: BackendAuthHost;
	readonly resolvePhysicalKey?: PhysicalKeyResolver;
}

/**
 * A per-connection runtime host: the only place mutable auth/connection state
 * lives. It builds the module's `BackendRuntimeContext` with module attribution
 * and redaction applied at the sink, and can be disposed exactly once.
 */
export interface BackendRuntimeHost {
	readonly moduleId: string;
	readonly generation: number;
	readonly context: BackendRuntimeContext;
	/** Whether `generation` is still the active one and the host is not disposed. */
	isCurrent(generation: number): boolean;
	/** Deactivate the host; idempotent and safe to call twice. */
	dispose(): Promise<void>;
}

function createLogger(moduleId: string, sink: RuntimeLogSink): BackendLogger {
	const emit =
		(level: RuntimeLogLevel) =>
		(message: string, context?: Record<string, unknown>): void => {
			const rendered = context === undefined ? message : `${message} ${JSON.stringify(context)}`;
			sink(level, redactSecrets(rendered), moduleId);
		};
	return { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error") };
}

/** Build a runtime host for one module connection. Performs no network I/O. */
export function createRuntimeHost(options: RuntimeHostOptions): BackendRuntimeHost {
	let disposed = false;
	const secrets =
		options.secretsHost ??
		(options.resolvePhysicalKey
			? createSecretHost(options.secrets, options.moduleId, options.resolvePhysicalKey)
			: createSecretHost(options.secrets, options.moduleId));
	const context: BackendRuntimeContext = {
		http: createHttpClient(),
		secrets,
		logger: createLogger(options.moduleId, options.sink),
		auth: options.auth,
	};
	return {
		moduleId: options.moduleId,
		generation: options.generation,
		context,
		isCurrent: (generation) => !disposed && generation === options.generation,
		dispose: () => {
			disposed = true;
			return Promise.resolve();
		},
	};
}
