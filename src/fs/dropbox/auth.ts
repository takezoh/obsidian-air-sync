import { requestUrl } from "obsidian";
import type { ISecretStore } from "../secret-store";
import type { Logger } from "../../logging/logger";
import { AuthError } from "../errors";
import { BaseOAuthTokenManager, extractTokenErrorDetail } from "../oauth-pkce";
import { PkceAuthProvider } from "../pkce-auth-provider";
import { DROPBOX_AUTH } from "../auth-config";
import { assertDropboxTokenResponse } from "./types";

const AUTHORIZE_URL = "https://www.dropbox.com/oauth2/authorize";
const TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";
const REVOKE_URL = "https://api.dropboxapi.com/2/auth/token/revoke";
const SCOPES = "files.metadata.read files.content.read files.content.write";
const BACKEND_TYPE = "dropbox";

/**
 * Build the Dropbox authorization-code + PKCE authorize URL. The single source of
 * the authorize params for both the in-plugin flow ({@link DropboxAuthProvider.startAuth})
 * and the opt-in e2e token bootstrap (ADR 0003), which passes a `http://localhost`
 * loopback `redirectUri` — so the two can never drift on scope/PKCE params.
 */
export function buildDropboxAuthorizeUrl(opts: {
	clientId: string;
	codeChallenge: string;
	state: string;
	redirectUri?: string;
}): string {
	const params = new URLSearchParams({
		client_id: opts.clientId,
		response_type: "code",
		token_access_type: "offline",
		code_challenge: opts.codeChallenge,
		code_challenge_method: "S256",
		scope: SCOPES,
		redirect_uri: opts.redirectUri ?? DROPBOX_AUTH.redirectUri,
		state: opts.state,
	});
	return `${AUTHORIZE_URL}?${params.toString()}`;
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

	protected notAuthenticatedMessage(): string {
		return "Not authenticated. Please connect to Dropbox first.";
	}

	protected sessionExpiredMessage(): string {
		return "Dropbox session expired. Please reconnect in settings.";
	}

	/**
	 * Exchange an authorization code for tokens (PKCE — no client secret).
	 *
	 * `redirectUri` must match the one used in the authorize request and defaults
	 * to the shipped in-plugin redirect ({@link DROPBOX_AUTH}.redirectUri). The
	 * opt-in e2e bootstrap (ADR 0003) overrides it with a `http://localhost:<port>`
	 * loopback so a headless CLI can capture the redirect directly.
	 */
	async exchangeCode(code: string, codeVerifier: string, redirectUri: string = DROPBOX_AUTH.redirectUri): Promise<void> {
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
			}).toString(),
		});
		if (res.status < 200 || res.status >= 300) {
			throw new Error(`Token exchange failed: ${res.status} ${extractTokenErrorDetail(res)}`);
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
			throw new AuthError(`Token refresh failed: ${res.status} ${extractTokenErrorDetail(res)}`, res.status);
		}
		if (res.status < 200 || res.status >= 300) {
			throw new Error(`Token refresh failed: ${res.status} ${extractTokenErrorDetail(res)}`);
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

/**
 * Dropbox authentication provider — in-plugin Authorization Code + PKCE, fully
 * worker-less. The shared {@link PkceAuthProvider} owns the flow; this supplies only
 * Dropbox's token manager and authorize URL.
 */
export class DropboxAuthProvider extends PkceAuthProvider<DropboxAuth> {
	constructor(secretStore: ISecretStore, clientId: string = DROPBOX_AUTH.clientId, logger?: Logger) {
		super(secretStore, BACKEND_TYPE, clientId, logger);
	}

	protected createAuth(clientId: string, _backendData: Record<string, unknown>, logger?: Logger): DropboxAuth {
		return new DropboxAuth(clientId, logger);
	}

	protected buildAuthorizeUrl(
		opts: { clientId: string; codeChallenge: string; state: string },
		_backendData: Record<string, unknown>,
	): string {
		return buildDropboxAuthorizeUrl(opts);
	}
}
