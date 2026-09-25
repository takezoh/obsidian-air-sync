import type {
	BackendAuth,
	BackendRuntimeContext,
	JsonObject,
	JsonPatch,
} from "../../backend-api";
import {
	buildOAuthState,
	computeS256Challenge,
	generateRandomString,
	parsePkceCallback,
} from "../../backend-api/oauth-pkce";

/**
 * The token-manager surface the in-plugin PKCE backends (OneDrive, Dropbox) expose.
 * `OneDriveAuth`/`DropboxAuth` satisfy it; the module boundary sees only this shape.
 */
export interface PkceTokenManager {
	setTokens(refreshToken: string, accessToken: string, expiry: number): void;
	getAccessToken(forceRefresh?: boolean): Promise<string>;
	getTokenState(): { refreshToken: string; accessToken: string; accessTokenExpiry: number };
	setRefreshTokenRotatedHook(cb: (refreshToken: string) => void | Promise<void>): void;
	revokeToken?(): Promise<void>;
}

export const REFRESH_SECRET = "refresh";
export const ACCESS_SECRET = "access";

/** A module's per-service PKCE auth policy (client id source + wire protocol). */
export interface PkceModuleSpec {
	readonly displayName: string;
	readonly defaultClientId: string;
	/** Whether this connection uses the user's own app (custom) or the built-in app. */
	readonly isCustom: (config: Readonly<JsonObject>) => boolean;
	/** The custom client id, already resolved from config/secrets. */
	readonly customClientId: (config: Readonly<JsonObject>) => string;
	/** Build the per-service token manager, wired to the connection's log sink. */
	readonly createManager: (
		clientId: string,
		config: Readonly<JsonObject>,
		context: BackendRuntimeContext,
	) => PkceTokenManager;
	readonly authorizeUrl: (
		clientId: string,
		codeChallenge: string,
		state: string,
		config: Readonly<JsonObject>,
	) => string;
	readonly exchangeCode: (
		manager: PkceTokenManager,
		code: string,
		codeVerifier: string,
		config: Readonly<JsonObject>,
	) => Promise<void>;
}

function clientIdOf(spec: PkceModuleSpec, config: Readonly<JsonObject>): string {
	return spec.isCustom(config) ? spec.customClientId(config) : spec.defaultClientId;
}

/**
 * The declarative {@link BackendAuth} for an in-plugin PKCE backend. `config` carries
 * only non-secret flow state; tokens live in the module-scoped secret store.
 *
 * The module declares its two credential keys so core derives readiness from their
 * presence and clears exactly them; a stale token still surfaces from
 * `createAdapter`/provider I/O, which classifies it as `auth` for a reconnect.
 */
export function createPkceBackendAuth(spec: PkceModuleSpec): BackendAuth {
	return {
		credentialKeys: [REFRESH_SECRET, ACCESS_SECRET],
		start: async (context, config): Promise<JsonPatch> => {
			const clientId = clientIdOf(spec, config);
			const codeVerifier = generateRandomString(64);
			const codeChallenge = await computeS256Challenge(codeVerifier);
			const state = buildOAuthState();
			await context.auth.openExternal(spec.authorizeUrl(clientId, codeChallenge, state, config));
			return {
				set: {
					authMode: spec.isCustom(config),
					pendingAuthState: state,
					pendingCodeVerifier: codeVerifier,
				},
			};
		},
		complete: async (context, input, config): Promise<JsonPatch> => {
			const { code, state } = parsePkceCallback(input);
			const expectedState = config.pendingAuthState;
			if (typeof expectedState === "string" && expectedState.length > 0 && state !== expectedState) {
				throw new Error("State mismatch - possible CSRF attack");
			}
			const verifier = typeof config.pendingCodeVerifier === "string" ? config.pendingCodeVerifier : "";
			if (!verifier) throw new Error("PKCE code verifier is missing. Please restart the authorization flow.");
			const manager = spec.createManager(clientIdOf(spec, config), config, context);
			await spec.exchangeCode(manager, code, verifier, config);
			const tokens = manager.getTokenState();
			if (!tokens.refreshToken) throw new Error("The provider did not return a refresh token. Reconnect and consent again.");
			await context.secrets.set(REFRESH_SECRET, tokens.refreshToken);
			await context.secrets.set(ACCESS_SECRET, tokens.accessToken);
			return {
				set: { accessTokenExpiry: tokens.accessTokenExpiry, pendingAuthState: "", pendingCodeVerifier: "" },
			};
		},
		revoke: async (context, config): Promise<void> => {
			const refresh = await context.secrets.get(REFRESH_SECRET);
			if (!refresh) return;
			const access = await context.secrets.get(ACCESS_SECRET);
			const manager = spec.createManager(clientIdOf(spec, config), config, context);
			manager.setTokens(refresh, access ?? "", 0);
			await manager.revokeToken?.();
		},
	};
}

/**
 * Build the bearer-token getter a provider client needs, seeding the manager from the
 * stored secrets and persisting a rotated refresh token before it is installed.
 *
 * `readExpiry` exposes the manager's current `accessTokenExpiry` so core can persist
 * it after a clean cycle (the legacy `readBackendState` behavior): a refresh updates
 * the manager's expiry, and without re-persisting it a reload would refresh once more.
 */
export interface PkceTokenGetter {
	readonly getToken: (forceRefresh?: boolean) => Promise<string>;
	readonly readExpiry: () => number;
}

export async function buildPkceTokenGetter(
	spec: PkceModuleSpec,
	context: BackendRuntimeContext,
	config: Readonly<JsonObject>,
): Promise<PkceTokenGetter> {
	const refresh = (await context.secrets.get(REFRESH_SECRET)) ?? "";
	const access = (await context.secrets.get(ACCESS_SECRET)) ?? "";
	const expiry = typeof config.accessTokenExpiry === "number" ? config.accessTokenExpiry : 0;
	const manager = spec.createManager(clientIdOf(spec, config), config, context);
	manager.setRefreshTokenRotatedHook((rotated) => context.secrets.set(REFRESH_SECRET, rotated));
	manager.setTokens(refresh, access, expiry);
	return {
		getToken: (forceRefresh) => manager.getAccessToken(forceRefresh),
		readExpiry: () => manager.getTokenState().accessTokenExpiry,
	};
}
