import { requestUrl } from "obsidian";
import type { Logger } from "../../logging/logger";
import { assertTokenResponse } from "./types";
import { BaseOAuthTokenManager, buildOAuthState, computeS256Challenge, generateRandomString } from "../oauth-pkce";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_SERVER_URL = "https://auth-airsync.takezo.dev";
const SCOPES = "https://www.googleapis.com/auth/drive.file";
export const DEFAULT_CUSTOM_SCOPE = SCOPES;
export const DEFAULT_CUSTOM_REDIRECT_URI = "https://airsync.takezo.dev/callback";
const REDIRECT_URI = `${AUTH_SERVER_URL}/google/callback`;

const GOOGLE_CLIENT_ID = "135801498656-lfjor2ml3v26t9l63mkoka0bndgl9eue.apps.googleusercontent.com";

/** Shared interface for GoogleAuth and GoogleAuthDirect */
export interface IGoogleAuth {
	setTokens(refreshToken: string, accessToken: string, expiry: number): void;
	/**
	 * Register a hook fired when a refresh rotates the refresh token to a new
	 * value. Lets a detached (throwaway) auth persist a rotated token that would
	 * otherwise be discarded with the instance — leaving the shared/stored token
	 * stale and failing the next real refresh.
	 */
	setRefreshTokenRotatedHook(cb: (refreshToken: string) => void): void;
	readonly isAuthenticated: boolean;
	getAuthorizationUrl(): Promise<string>;
	getAuthState(): string | null;
	setAuthState(authState: string): void;
	getCodeVerifier(): string | null;
	setCodeVerifier(verifier: string): void;
	handleAuthCallback(params: Record<string, string | undefined>): Promise<void>;
	getAccessToken(forceRefresh?: boolean): Promise<string>;
	getTokenState(): { refreshToken: string; accessToken: string; accessTokenExpiry: number };
	revokeToken(): Promise<void>;
}

/**
 * Base class for Google OAuth implementations. Inherits the OAuth token
 * lifecycle (skew/cooldown/dedup/rotation) from {@link BaseOAuthTokenManager}
 * and adds Google's CSRF state, PKCE verifier, and token revocation. Subclasses
 * provide the auth URL, callback handling, and refresh strategy.
 */
abstract class GoogleAuthBase extends BaseOAuthTokenManager implements IGoogleAuth {
	private authState: string | null = null;
	private codeVerifier: string | null = null;

	protected notAuthenticatedMessage(): string {
		return "Not authenticated. Please connect to Google Drive first.";
	}

	abstract getAuthorizationUrl(): Promise<string>;

	getAuthState(): string | null {
		return this.authState;
	}

	setAuthState(authState: string): void {
		this.authState = authState;
	}

	getCodeVerifier(): string | null {
		return this.codeVerifier;
	}

	setCodeVerifier(verifier: string): void {
		this.codeVerifier = verifier;
	}

	abstract handleAuthCallback(params: Record<string, string | undefined>): Promise<void>;

	async revokeToken(): Promise<void> {
		const token = this.refreshToken || this.accessToken;
		if (!token) return;

		try {
			await requestUrl({
				url: `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`,
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
			});
		} catch {
			this.logger?.warn("Failed to revoke Google token (non-fatal)");
		}
	}

	/** Verify CSRF state and clear it. Returns the validated state. */
	protected verifyAndClearState(state: string | undefined): void {
		if (!this.authState) {
			throw new Error("OAuth state is missing. Please restart the authorization flow.");
		}
		if (!state || state !== this.authState) {
			throw new Error("State mismatch - possible CSRF attack");
		}
	}

	protected clearAuthState(): void {
		this.authState = null;
	}

	/** Generate (and store as the pending CSRF state) a base64url OAuth state value. */
	protected generateState(extra: Record<string, unknown> = {}): string {
		this.authState = buildOAuthState(extra);
		return this.authState;
	}
}

/**
 * Handles OAuth 2.0 authentication for Google Drive.
 * Token exchange is handled server-side by auth-airsync.takezo.dev
 * (confidential client with client_secret). The plugin only manages
 * CSRF state verification and token storage.
 */
export class GoogleAuth extends GoogleAuthBase {
	constructor(logger?: Logger) {
		super();
		this.logger = logger;
	}

	getAuthorizationUrl(): Promise<string> {
		const state = this.generateState();

		const params = new URLSearchParams({
			client_id: GOOGLE_CLIENT_ID,
			redirect_uri: REDIRECT_URI,
			response_type: "code",
			scope: SCOPES,
			access_type: "offline",
			prompt: "consent",
			state,
		});
		return Promise.resolve(`${GOOGLE_AUTH_URL}?${params.toString()}`);
	}

	/**
	 * Accept tokens returned by the auth server callback.
	 * The auth server already exchanged the authorization code for tokens;
	 * we just verify the CSRF state and store the tokens.
	 */
	handleAuthCallback(params: Record<string, string | undefined>): Promise<void> {
		try {
			this.verifyAndClearState(params.state);
			if (!params.access_token) {
				throw new Error("Access token is missing from auth callback");
			}

			const expiresIn = parseInt(params.expires_in ?? "3600", 10);
			if (isNaN(expiresIn) || expiresIn <= 0) {
				throw new Error("Invalid expires_in from auth callback");
			}

			this.accessToken = params.access_token;
			this.accessTokenExpiry = Date.now() + expiresIn * 1000;
			if (params.refresh_token) {
				this.refreshToken = params.refresh_token;
			}

			this.clearAuthState();
			return Promise.resolve();
		} catch (err: unknown) {
			return Promise.reject(err instanceof Error ? err : new Error(String(err)));
		}
	}

	protected async performRefresh(): Promise<string> {
		this.logger?.info("Refreshing access token");
		try {
			const response = await requestUrl({
				url: `${AUTH_SERVER_URL}/google/token/refresh`,
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ refresh_token: this.refreshToken }),
			});

			const token: unknown = response.json;
			assertTokenResponse(token);
			this.storeTokenResponse(token);
			return this.accessToken;
		} catch (err) {
			this.handleRefreshError(err);
		}
	}
}

/**
 * Direct OAuth 2.0 authentication using user-provided client credentials.
 * The auth server relays the authorization code back without exchanging it;
 * this class exchanges the code and refreshes tokens directly with Google.
 */
export interface GoogleAuthDirectOptions {
	clientId: string;
	clientSecret: string;
	logger?: Logger;
	scope?: string;
	redirectUri?: string;
	includeGrantedScopes?: boolean;
}

export class GoogleAuthDirect extends GoogleAuthBase {
	private clientId: string;
	private clientSecret: string;
	private scope: string;
	private redirectUri: string;
	private includeGrantedScopes: boolean;

	constructor(options: GoogleAuthDirectOptions) {
		super();
		this.clientId = options.clientId;
		this.clientSecret = options.clientSecret;
		this.scope = options.scope || SCOPES;
		this.redirectUri = options.redirectUri || DEFAULT_CUSTOM_REDIRECT_URI;
		this.includeGrantedScopes = options.includeGrantedScopes ?? false;
		this.logger = options.logger;
	}

	async getAuthorizationUrl(): Promise<string> {
		const state = this.generateState({ custom: true });
		const codeVerifier = generateRandomString(64);
		this.setCodeVerifier(codeVerifier);
		const codeChallenge = await computeS256Challenge(codeVerifier);

		const params = new URLSearchParams({
			client_id: this.clientId,
			redirect_uri: this.redirectUri,
			response_type: "code",
			scope: this.scope,
			access_type: "offline",
			prompt: "consent",
			state,
			code_challenge: codeChallenge,
			code_challenge_method: "S256",
		});
		if (this.includeGrantedScopes) {
			params.set("include_granted_scopes", "true");
		}
		return `${GOOGLE_AUTH_URL}?${params.toString()}`;
	}

	/**
	 * Exchange the authorization code for tokens directly with Google.
	 * The auth server passes back code + state without exchanging them.
	 * Sends code_verifier for PKCE verification.
	 */
	async handleAuthCallback(params: Record<string, string | undefined>): Promise<void> {
		this.verifyAndClearState(params.state);
		if (!params.code) {
			throw new Error("Authorization code is missing from auth callback");
		}
		const codeVerifier = this.getCodeVerifier();
		if (!codeVerifier) {
			throw new Error("PKCE code verifier is missing. Please restart the authorization flow.");
		}

		this.logger?.debug("Exchanging authorization code", {
			redirectUri: this.redirectUri,
			codeLength: params.code.length,
		});

		try {
			const response = await requestUrl({
				url: GOOGLE_TOKEN_URL,
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					code: params.code,
					client_id: this.clientId,
					client_secret: this.clientSecret,
					redirect_uri: this.redirectUri,
					grant_type: "authorization_code",
					code_verifier: codeVerifier,
				}).toString(),
			});

			const token: unknown = response.json;
			assertTokenResponse(token);
			this.storeTokenResponse(token);
			this.clearAuthState();
			this.logger?.debug("Token exchange successful");
		} catch (err) {
			const detail = extractGoogleErrorDetail(err);
			this.logger?.error("Token exchange failed", { error: detail });
			throw new Error(`Token exchange failed: ${detail}`);
		}
	}

	protected async performRefresh(): Promise<string> {
		this.logger?.info("Refreshing access token (direct)");
		try {
			const response = await requestUrl({
				url: GOOGLE_TOKEN_URL,
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					client_id: this.clientId,
					client_secret: this.clientSecret,
					refresh_token: this.refreshToken,
					grant_type: "refresh_token",
				}).toString(),
			});

			const token: unknown = response.json;
			assertTokenResponse(token);
			this.storeTokenResponse(token);
			return this.accessToken;
		} catch (err) {
			this.handleRefreshError(err);
		}
	}
}

/** Extract error detail from a Google OAuth error response */
function extractGoogleErrorDetail(err: unknown): string {
	const json = (err as { json?: unknown }).json;
	if (json && typeof json === "object") {
		const obj = json as Record<string, unknown>;
		if (typeof obj.error === "string") {
			const desc = typeof obj.error_description === "string" ? obj.error_description : "";
			return desc ? `${obj.error}: ${desc}` : obj.error;
		}
	}
	return err instanceof Error ? err.message : String(err);
}
