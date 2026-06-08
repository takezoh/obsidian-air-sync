import { Notice, Platform, requestUrl } from "obsidian";
import type { IAuthProvider } from "../auth";
import type { ISecretStore } from "../secret-store";
import type { Logger } from "../../logging/logger";
import { AuthError } from "../errors";
import { setBackendSecret, hasBackendSecret } from "../token-store";
import { BaseOAuthTokenManager, buildOAuthState, computeS256Challenge, generateRandomString } from "../oauth-pkce";
import { assertDropboxTokenResponse } from "./types";

const AUTHORIZE_URL = "https://www.dropbox.com/oauth2/authorize";
const TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";
const REVOKE_URL = "https://api.dropboxapi.com/2/auth/token/revoke";
/** Existing no-secret client-side relay (airsync.takezo.dev/callback → obsidian://). */
const REDIRECT_URI = "https://airsync.takezo.dev/callback";
const SCOPES = "files.metadata.read files.content.read files.content.write";
const BACKEND_TYPE = "dropbox";

/**
 * Sentinel meaning "no real app key is embedded yet". While {@link DROPBOX_CLIENT_ID}
 * holds this, the Dropbox backend is in Preview: the user must supply their own app
 * key via the settings field ({@link DropboxBackendData.appKey}) and {@link startAuth}
 * refuses to run with the placeholder. PREVIEW: delete this, the settings field, and
 * the appKey override path once the real key is embedded at official release.
 */
const PLACEHOLDER_APP_KEY = "REPLACE_WITH_DROPBOX_APP_KEY";

/**
 * Public OAuth app key for the Air Sync Dropbox app (App folder permission).
 *
 * PKCE means there is NO client secret anywhere — the `code_verifier` is the
 * ephemeral proof. Register the app at https://www.dropbox.com/developers/apps,
 * add `https://airsync.takezo.dev/callback` as a redirect URI, and embed the key here.
 */
export const DROPBOX_CLIENT_ID = PLACEHOLDER_APP_KEY;

interface DropboxCallbackParams {
	code: string;
	state: string | undefined;
}

/** Parse the `obsidian://air-sync-auth?code=…&state=…` PKCE callback. */
function parseDropboxCallback(input: string): DropboxCallbackParams {
	const trimmed = input.trim();
	if (!trimmed) throw new Error("Auth callback is empty");
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw new Error("Invalid auth callback URL");
	}
	const code = url.searchParams.get("code");
	if (!code) throw new Error("Missing code in auth callback");
	return { code, state: url.searchParams.get("state") ?? undefined };
}

/**
 * Dropbox token manager: holds the short-lived access token + long-lived refresh
 * token, refreshes on demand (PKCE refresh needs only `client_id` — no secret).
 * The token lifecycle (expiry-skew reuse, concurrent-refresh dedup, post-failure
 * cooldown, rotation hook) is inherited from {@link BaseOAuthTokenManager}; this
 * class supplies only Dropbox's wire protocol. One instance per FS lifetime.
 */
export class DropboxAuth extends BaseOAuthTokenManager {
	constructor(private clientId: string, logger?: Logger) {
		super();
		this.logger = logger;
	}

	/** PREVIEW: apply a settings-supplied app key to a token manager created earlier. */
	setClientId(clientId: string): void {
		this.clientId = clientId;
	}

	protected notAuthenticatedMessage(): string {
		return "Not authenticated. Please connect to Dropbox first.";
	}

	protected sessionExpiredMessage(): string {
		return "Dropbox session expired. Please reconnect in settings.";
	}

	/** Exchange an authorization code for tokens (PKCE — no client secret). */
	async exchangeCode(code: string, codeVerifier: string): Promise<void> {
		const res = await requestUrl({
			url: TOKEN_URL,
			method: "POST",
			throw: false,
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "authorization_code",
				code,
				code_verifier: codeVerifier,
				client_id: this.clientId,
				redirect_uri: REDIRECT_URI,
			}).toString(),
		});
		if (res.status < 200 || res.status >= 300) {
			throw new Error(`Token exchange failed: ${res.status} ${tokenErrorDetail(res)}`);
		}
		assertDropboxTokenResponse(res.json);
		this.storeTokenResponse(res.json);
	}

	protected async performRefresh(): Promise<string> {
		this.logger?.info("Refreshing Dropbox access token");
		let res;
		try {
			res = await requestUrl({
				url: TOKEN_URL,
				method: "POST",
				throw: false,
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					grant_type: "refresh_token",
					refresh_token: this.refreshToken,
					client_id: this.clientId,
				}).toString(),
			});
		} catch (err) {
			this.logger?.error("Token refresh failed", { error: err instanceof Error ? err.message : String(err) });
			throw err;
		}
		if (res.status === 400 || res.status === 401) {
			this.authFailedAt = Date.now();
			throw new AuthError(`Token refresh failed: ${res.status} ${tokenErrorDetail(res)}`, res.status);
		}
		if (res.status < 200 || res.status >= 300) {
			throw new Error(`Token refresh failed: ${res.status} ${tokenErrorDetail(res)}`);
		}
		assertDropboxTokenResponse(res.json);
		this.storeTokenResponse(res.json);
		return this.accessToken;
	}

	async revokeToken(): Promise<void> {
		if (!this.accessToken) return;
		try {
			await requestUrl({
				url: REVOKE_URL,
				method: "POST",
				throw: false,
				headers: { Authorization: `Bearer ${this.accessToken}` },
			});
		} catch {
			this.logger?.warn("Failed to revoke Dropbox token (non-fatal)");
		}
	}
}

/** Extract a readable error detail from a Dropbox token-endpoint error response. */
function tokenErrorDetail(res: { json?: unknown; text?: string }): string {
	try {
		const json = res.json as { error_description?: string; error?: string } | undefined;
		if (json?.error_description) return json.error_description;
		if (json?.error) return json.error;
	} catch {
		// fall through to text
	}
	return typeof res.text === "string" ? res.text : "";
}

/**
 * Dropbox authentication provider — in-plugin Authorization Code + PKCE, fully
 * worker-less. The authorization code returns via the existing no-secret
 * `callback` relay page (hosted in the air-sync-auth repo); this plugin exchanges
 * it for tokens directly with Dropbox using the ephemeral `code_verifier`.
 */
export class DropboxAuthProvider implements IAuthProvider {
	private tokenAuth: DropboxAuth | null = null;

	constructor(
		private secretStore: ISecretStore,
		private clientId: string = DROPBOX_CLIENT_ID,
		private logger?: Logger,
	) {}

	/**
	 * Effective app key: the user-supplied Preview key (`backendData.appKey`) wins,
	 * else the embedded {@link DROPBOX_CLIENT_ID}. PREVIEW: remove this override (and
	 * the settings field) once the real key is embedded at official release.
	 */
	private effectiveClientId(appKey?: string): string {
		return appKey && appKey.trim() ? appKey.trim() : this.clientId;
	}

	/** Get or lazily create the shared token manager (so refreshed tokens are persistable). */
	getOrCreateAuth(appKey?: string, logger?: Logger): DropboxAuth {
		const clientId = this.effectiveClientId(appKey);
		if (!this.tokenAuth) this.tokenAuth = new DropboxAuth(clientId, logger ?? this.logger);
		else this.tokenAuth.setClientId(clientId);
		return this.tokenAuth;
	}

	/**
	 * A throwaway token manager, independent of the shared (FS-bound) instance. Use
	 * for one-off read calls (e.g. resolving the folder path for the settings UI)
	 * so they don't clobber the live sync's in-memory tokens / failure cooldown.
	 */
	createDetachedAuth(appKey?: string, logger?: Logger): DropboxAuth {
		const auth = new DropboxAuth(this.effectiveClientId(appKey), logger ?? this.logger);
		// Persist a rotated refresh token from a detached refresh to SecretStorage —
		// otherwise it would be discarded with this throwaway instance, leaving the
		// stored (and shared) token stale so the next real sync's refresh fails. The
		// shared instance instead persists via the provider's readBackendState.
		auth.setRefreshTokenRotatedHook((rt) => setBackendSecret(this.secretStore, BACKEND_TYPE, "refresh", rt));
		return auth;
	}

	getTokenState(): { refreshToken: string; accessToken: string; accessTokenExpiry: number } | null {
		return this.tokenAuth?.getTokenState() ?? null;
	}

	async revokeAuth(): Promise<void> {
		if (this.tokenAuth) await this.tokenAuth.revokeToken();
		this.tokenAuth = null;
	}

	isAuthenticated(_backendData: Record<string, unknown>): boolean {
		return hasBackendSecret(this.secretStore, BACKEND_TYPE, "refresh");
	}

	async startAuth(backendData: Record<string, unknown>): Promise<Record<string, unknown>> {
		const appKey = typeof backendData.appKey === "string" ? backendData.appKey : undefined;
		const clientId = this.effectiveClientId(appKey);
		// PREVIEW: no key embedded and none entered — refuse rather than open a broken
		// authorize URL. Removed once the real key is embedded (the fallback always wins).
		if (clientId === PLACEHOLDER_APP_KEY) {
			throw new Error("Enter your Dropbox app key in settings first.");
		}
		const codeVerifier = generateRandomString(64);
		const codeChallenge = await computeS256Challenge(codeVerifier);
		// base64url state (URL-transit safe) via the shared builder; the callback
		// relay page (air-sync-auth) decodes both base64url and legacy base64.
		const state = buildOAuthState();
		const params = new URLSearchParams({
			client_id: clientId,
			response_type: "code",
			token_access_type: "offline",
			code_challenge: codeChallenge,
			code_challenge_method: "S256",
			scope: SCOPES,
			redirect_uri: REDIRECT_URI,
			state,
		});
		const url = `${AUTHORIZE_URL}?${params.toString()}`;
		if (Platform.isMobile) {
			window.location.href = url;
		} else {
			window.open(url);
		}
		new Notice("Complete authorization in your browser");
		return { pendingAuthState: state, pendingCodeVerifier: codeVerifier };
	}

	async completeAuth(input: string, backendData: Record<string, unknown>): Promise<Record<string, unknown>> {
		const params = parseDropboxCallback(input);
		const expectedState = backendData.pendingAuthState;
		if (typeof expectedState !== "string" || !expectedState || params.state !== expectedState) {
			throw new Error("State mismatch - possible CSRF attack");
		}
		const codeVerifier = backendData.pendingCodeVerifier;
		if (typeof codeVerifier !== "string" || !codeVerifier) {
			throw new Error("PKCE code verifier is missing. Please restart the authorization flow.");
		}

		const appKey = typeof backendData.appKey === "string" ? backendData.appKey : undefined;
		const auth = this.getOrCreateAuth(appKey);
		await auth.exchangeCode(params.code, codeVerifier);
		const tokens = auth.getTokenState();
		setBackendSecret(this.secretStore, BACKEND_TYPE, "refresh", tokens.refreshToken);
		setBackendSecret(this.secretStore, BACKEND_TYPE, "access", tokens.accessToken);

		return { accessTokenExpiry: tokens.accessTokenExpiry, pendingAuthState: "", pendingCodeVerifier: "" };
	}
}
