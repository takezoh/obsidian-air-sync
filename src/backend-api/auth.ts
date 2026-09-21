import type { JsonObject } from "./json";
import type { BackendRuntimeContext } from "./runtime";
import type { JsonPatch } from "./binding";

/**
 * A module's authentication lifecycle (API v1).
 *
 * `isAuthenticated` receives the runtime context because SecretStorage presence
 * cannot be checked from `config` alone — persisting a `hasToken` flag into
 * config to fake it would create a second truth. A module must not store mutable
 * auth state on the process-global module object; `context.secrets` is the
 * per-connection store.
 *
 * `start`/`complete` return config patches, not mutations: core applies them to
 * the latest backendData with the issuing connection generation, so a callback
 * from a connection that has since switched away is never applied.
 */
export interface BackendAuth {
	isAuthenticated(context: BackendRuntimeContext, config: Readonly<JsonObject>): boolean;

	/** Begin authentication; returns config to persist (e.g. a state/verifier). */
	start(context: BackendRuntimeContext, config: Readonly<JsonObject>): Promise<JsonPatch>;

	/** Complete authentication from a callback URL or manual input. */
	complete(
		context: BackendRuntimeContext,
		input: string,
		config: Readonly<JsonObject>,
	): Promise<JsonPatch>;

	/** Best-effort provider revocation before core clears local state. */
	revoke?(context: BackendRuntimeContext, config: Readonly<JsonObject>): Promise<void>;
}
