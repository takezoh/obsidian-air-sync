import { errorMessage } from "../../backend-api";
import type { BackendLogger } from "../../backend-api";
import type { HttpTransport } from "../../backend-api/http-transport";
import { AuthError } from "../../backend-api/error-classification";
import { logBackendErrorResponse } from "../../backend-api/backend-error-log";
import { BaseOAuthTokenManager, extractTokenErrorDetail } from "../../backend-api/oauth-pkce";
import { ONEDRIVE_AUTH } from "../shared/auth-config";
import { assertMicrosoftTokenResponse } from "./types";

/**
 * The Microsoft identity-platform host. The authority *segment* that follows selects the
 * account set: `consumers` (personal MSA only — the built-in default), `common` (work/school
 * + personal), `organizations` (work/school only), or a tenant GUID (a single Entra tenant).
 * The built-in backend is `consumers`; the custom-app backend lets the user pick.
 */
const AUTHORITY_BASE = "https://login.microsoftonline.com";
/** The built-in OneDrive backend's authority: personal Microsoft accounts only. */
export const DEFAULT_ONEDRIVE_AUTHORITY = "consumers";
export function authorizeUrlFor(authority: string): string {
	return `${AUTHORITY_BASE}/${authority}/oauth2/v2.0/authorize`;
}
export function tokenUrlFor(authority: string): string {
	return `${AUTHORITY_BASE}/${authority}/oauth2/v2.0/token`;
}
/** App Folder scope: the vault lives under /me/drive/special/approot; offline_access enables refresh. */
const SCOPES = "Files.ReadWrite.AppFolder offline_access";
/**
 * Build the OneDrive authorization-code + PKCE authorize URL. The single source of
 * the authorize params for the in-plugin PKCE auth (`createPkceBackendAuth`) and
 * the opt-in e2e token bootstrap (ADR 0003), which passes a `http://localhost`
 * loopback `redirectUri` — so the two can never drift on scope/PKCE params.
 */
export function buildOneDriveAuthorizeUrl(opts: {
	clientId: string;
	codeChallenge: string;
	state: string;
	redirectUri?: string;
	authority?: string;
}): string {
	const params = new URLSearchParams({
		client_id: opts.clientId,
		response_type: "code",
		code_challenge: opts.codeChallenge,
		code_challenge_method: "S256",
		scope: SCOPES,
		redirect_uri: opts.redirectUri ?? ONEDRIVE_AUTH.redirectUri,
		state: opts.state,
	});
	return `${authorizeUrlFor(opts.authority ?? DEFAULT_ONEDRIVE_AUTHORITY)}?${params.toString()}`;
}

/**
 * OneDrive token manager: holds the short-lived access token + long-lived refresh
 * token, refreshes on demand (PKCE refresh needs only `client_id` — no secret).
 * The token lifecycle (expiry-skew reuse, concurrent-refresh dedup, post-failure
 * cooldown, rotation hook) is inherited from {@link BaseOAuthTokenManager}; this
 * class supplies only Microsoft's wire protocol. One instance per FS lifetime.
 */
export class OneDriveAuth extends BaseOAuthTokenManager {
	constructor(
		private clientId: string,
		private transport: HttpTransport,
		private authority: string = DEFAULT_ONEDRIVE_AUTHORITY,
		logger?: BackendLogger,
	) {
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
	 * the in-plugin {@link ONEDRIVE_AUTH}.redirectUri. The opt-in e2e bootstrap (ADR
	 * 0003) overrides it with a `http://localhost:<port>` loopback so a headless CLI
	 * can capture the redirect directly.
	 */
	async exchangeCode(code: string, codeVerifier: string, redirectUri: string = ONEDRIVE_AUTH.redirectUri): Promise<void> {
		const res = await this.transport.request({
			url: tokenUrlFor(this.authority),
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
			logBackendErrorResponse(this.logger, "OneDrive token", "exchangeCode", res);
			throw new Error(`Token exchange failed: ${res.status} ${extractTokenErrorDetail(res)}`);
		}
		assertMicrosoftTokenResponse(res.json);
		await this.storeTokenResponse(res.json);
	}

	protected async performRefresh(): Promise<string> {
		this.logger?.info("Refreshing OneDrive access token");
		let res;
		try {
			res = await this.transport.request({
				url: tokenUrlFor(this.authority),
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
			this.logger?.error("Token refresh failed", { error: errorMessage(err) });
			throw err;
		}
		if (res.status === 400 || res.status === 401) {
			logBackendErrorResponse(this.logger, "OneDrive token", "performRefresh", res);
			this.authFailedAt = Date.now();
			throw new AuthError(`Token refresh failed: ${res.status} ${extractTokenErrorDetail(res)}`, res.status);
		}
		if (res.status < 200 || res.status >= 300) {
			logBackendErrorResponse(this.logger, "OneDrive token", "performRefresh", res);
			throw new Error(`Token refresh failed: ${res.status} ${extractTokenErrorDetail(res)}`);
		}
		assertMicrosoftTokenResponse(res.json);
		await this.storeTokenResponse(res.json);
		return this.accessToken;
	}
}
