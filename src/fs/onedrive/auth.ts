import { Notice, Platform, requestUrl } from "obsidian";
import type { IAuthProvider } from "../auth";
import type { ISecretStore } from "../secret-store";
import type { Logger } from "../../logging/logger";
import { AuthError } from "../errors";
import { setBackendSecret, hasBackendSecret } from "../token-store";
import { BaseOAuthTokenManager, buildOAuthState, computeS256Challenge, generateRandomString } from "../oauth-pkce";
import { assertMicrosoftTokenResponse } from "./types";

/** Personal Microsoft accounts only — the `consumers` authority host. */
const AUTHORIZE_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize";
const TOKEN_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
/** Reuse the existing in-plugin protocol handler — NO new scheme, no relay page. */
export const REDIRECT_URI = "obsidian://air-sync-auth";
/** App Folder scope: the vault lives under /me/drive/special/approot; offline_access enables refresh. */
const SCOPES = "Files.ReadWrite.AppFolder offline_access";
const BACKEND_TYPE = "onedrive";

/**
 * Public OAuth client id for the Air Sync OneDrive app (Files.ReadWrite.AppFolder).
 *
 * The real Entra (Azure AD) application (client) id, registered at
 * https://entra.microsoft.com with `obsidian://air-sync-auth` as a redirect URI and
 * "Personal Microsoft accounts only" as the supported account type. PKCE means there
 * is NO client secret anywhere — the `code_verifier` is the ephemeral proof. The
 * contract tests pass a fake client id, so they are green regardless of this value.
 */
export const ONEDRIVE_CLIENT_ID = "71cd9a2a-a701-4ec2-b7d0-2352e0e84e9f";

/**
 * Build the OneDrive authorization-code + PKCE authorize URL. The single source of
 * the authorize params for both the in-plugin flow ({@link OneDriveAuthProvider.startAuth})
 * and the opt-in e2e token bootstrap (ADR 0003), which passes a `http://localhost`
 * loopback `redirectUri` — so the two can never drift on scope/PKCE params.
 */
export function buildOneDriveAuthorizeUrl(opts: {
	clientId: string;
	codeChallenge: string;
	state: string;
	redirectUri?: string;
}): string {
	const params = new URLSearchParams({
		client_id: opts.clientId,
		response_type: "code",
		code_challenge: opts.codeChallenge,
		code_challenge_method: "S256",
		scope: SCOPES,
		redirect_uri: opts.redirectUri ?? REDIRECT_URI,
		state: opts.state,
	});
	return `${AUTHORIZE_URL}?${params.toString()}`;
}

interface OneDriveCallbackParams {
	code: string;
	state: string | undefined;
}

/** Parse the `obsidian://air-sync-auth?code=…&state=…` PKCE callback. */
function parseOneDriveCallback(input: string): OneDriveCallbackParams {
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

/** Extract a readable error detail from a Microsoft token-endpoint error response. */
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
 * OneDrive token manager: holds the short-lived access token + long-lived refresh
 * token, refreshes on demand (PKCE refresh needs only `client_id` — no secret).
 * The token lifecycle (expiry-skew reuse, concurrent-refresh dedup, post-failure
 * cooldown, rotation hook) is inherited from {@link BaseOAuthTokenManager}; this
 * class supplies only Microsoft's wire protocol. One instance per FS lifetime.
 */
export class OneDriveAuth extends BaseOAuthTokenManager {
	constructor(private clientId: string, logger?: Logger) {
		super();
		this.logger = logger;
	}

	protected notAuthenticatedMessage(): string {
		return "Not authenticated. Please connect to OneDrive first.";
	}

	protected sessionExpiredMessage(): string {
		return "OneDrive session expired. Please reconnect in settings.";
	}

	/**
	 * Exchange an authorization code for tokens (PKCE — no client secret).
	 *
	 * `redirectUri` must match the one used in the authorize request and defaults to
	 * the in-plugin {@link REDIRECT_URI}. The opt-in e2e bootstrap (ADR 0003) overrides
	 * it with a `http://localhost:<port>` loopback so a headless CLI can capture the
	 * redirect directly.
	 */
	async exchangeCode(code: string, codeVerifier: string, redirectUri: string = REDIRECT_URI): Promise<void> {
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
				redirect_uri: redirectUri,
				scope: SCOPES,
			}).toString(),
		});
		if (res.status < 200 || res.status >= 300) {
			throw new Error(`Token exchange failed: ${res.status} ${tokenErrorDetail(res)}`);
		}
		assertMicrosoftTokenResponse(res.json);
		this.storeTokenResponse(res.json);
	}

	protected async performRefresh(): Promise<string> {
		this.logger?.info("Refreshing OneDrive access token");
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
					scope: SCOPES,
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
		assertMicrosoftTokenResponse(res.json);
		this.storeTokenResponse(res.json);
		return this.accessToken;
	}
}

/**
 * OneDrive authentication provider — in-plugin Authorization Code + PKCE, fully
 * worker-less (no client secret, no relay server). The authorization code returns
 * directly via the existing `obsidian://air-sync-auth` protocol handler; this
 * plugin exchanges it for tokens directly with Microsoft using the ephemeral
 * `code_verifier`.
 */
export class OneDriveAuthProvider implements IAuthProvider {
	private tokenAuth: OneDriveAuth | null = null;

	constructor(
		private secretStore: ISecretStore,
		private clientId: string = ONEDRIVE_CLIENT_ID,
		private logger?: Logger,
	) {}

	/** Get or lazily create the shared token manager (so refreshed tokens are persistable). */
	getOrCreateAuth(logger?: Logger): OneDriveAuth {
		if (!this.tokenAuth) this.tokenAuth = new OneDriveAuth(this.clientId, logger ?? this.logger);
		return this.tokenAuth;
	}

	/**
	 * A throwaway token manager, independent of the shared (FS-bound) instance. Use
	 * for one-off read calls (e.g. resolving the folder path for the settings UI)
	 * so they don't clobber the live sync's in-memory tokens / failure cooldown.
	 */
	createDetachedAuth(logger?: Logger): OneDriveAuth {
		const auth = new OneDriveAuth(this.clientId, logger ?? this.logger);
		// Persist a rotated refresh token from a detached refresh to SecretStorage —
		// otherwise it would be discarded with this throwaway instance, leaving the
		// stored (and shared) token stale so the next real sync's refresh fails.
		auth.setRefreshTokenRotatedHook((rt) => setBackendSecret(this.secretStore, BACKEND_TYPE, "refresh", rt));
		return auth;
	}

	getTokenState(): { refreshToken: string; accessToken: string; accessTokenExpiry: number } | null {
		return this.tokenAuth?.getTokenState() ?? null;
	}

	async revokeAuth(): Promise<void> {
		// Microsoft's consumer endpoint has no programmatic token-revoke; dropping the
		// in-memory manager and clearing secrets (provider.disconnect) is sufficient.
		this.tokenAuth = null;
		await Promise.resolve();
	}

	isAuthenticated(_backendData: Record<string, unknown>): boolean {
		return hasBackendSecret(this.secretStore, BACKEND_TYPE, "refresh");
	}

	async startAuth(_backendData: Record<string, unknown>): Promise<Record<string, unknown>> {
		const codeVerifier = generateRandomString(64);
		const codeChallenge = await computeS256Challenge(codeVerifier);
		const state = buildOAuthState();
		const url = buildOneDriveAuthorizeUrl({ clientId: this.clientId, codeChallenge, state });
		if (Platform.isMobile) {
			window.location.href = url;
		} else {
			window.open(url);
		}
		new Notice("Complete authorization in your browser");
		return { pendingAuthState: state, pendingCodeVerifier: codeVerifier };
	}

	async completeAuth(input: string, backendData: Record<string, unknown>): Promise<Record<string, unknown>> {
		const params = parseOneDriveCallback(input);
		const expectedState = backendData.pendingAuthState;
		if (typeof expectedState !== "string" || !expectedState || params.state !== expectedState) {
			throw new Error("State mismatch - possible CSRF attack");
		}
		const codeVerifier = backendData.pendingCodeVerifier;
		if (typeof codeVerifier !== "string" || !codeVerifier) {
			throw new Error("PKCE code verifier is missing. Please restart the authorization flow.");
		}

		const auth = this.getOrCreateAuth();
		await auth.exchangeCode(params.code, codeVerifier);
		const tokens = auth.getTokenState();
		setBackendSecret(this.secretStore, BACKEND_TYPE, "refresh", tokens.refreshToken);
		setBackendSecret(this.secretStore, BACKEND_TYPE, "access", tokens.accessToken);

		return { accessTokenExpiry: tokens.accessTokenExpiry, pendingAuthState: "", pendingCodeVerifier: "" };
	}
}
