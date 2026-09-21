import type { JsonObject } from "./json";
import type { BackendRuntimeContext } from "./runtime";
import type { JsonPatch } from "./binding";

/**
 * A module's authentication lifecycle (API v3).
 *
 * A module DECLARES the logical secret keys it owns as provider credentials
 * (`credentialKeys`); core derives credential readiness from their presence and
 * clears exactly those keys on disconnect. Core never guesses a key name, and a
 * module's `isAuthenticated` is gone because provider credential presence cannot
 * be proven synchronously from `config` alone — persisting a `hasToken` flag
 * would create a second truth. A module must not store mutable auth state on the
 * process-global module object; `context.secrets` is the per-connection store.
 *
 * `start`/`complete` return config patches, not mutations: core applies them to
 * the latest backendData with the issuing connection generation, so a callback
 * from a connection that has since switched away is never applied.
 */
export interface BackendAuth {
	/**
	 * Logical keys the module writes as plugin-owned credentials (e.g.
	 * `["refresh", "access"]`). At least one present = credential ready; core
	 * clears exactly these keys on disconnect. Declare `[]` for a backend with no
	 * plugin-owned secret (readiness then follows the bound target alone).
	 */
	readonly credentialKeys: readonly string[];

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
