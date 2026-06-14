import type { Logger } from "../logging/logger";
import { AuthError } from "./errors";

/**
 * Shared OAuth/PKCE primitives used by every cloud backend that speaks OAuth 2.0
 * (Google Drive, Dropbox, …). Keeping the RNG, the S256 challenge, the CSRF
 * state shape, and the token-refresh lifecycle in one place stops a fix in one
 * backend's copy from silently drifting away from the others'.
 */

/** Refresh this many ms before the real expiry so a token isn't used mid-flight. */
const TOKEN_SKEW_MS = 60_000;
/** After a 400/401 refresh failure, fail fast for this long instead of hammering. */
const AUTH_FAILED_COOLDOWN_MS = 60_000;

const RANDOM_CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** The app identifier embedded in the OAuth `state` (matched by the auth relays). */
const STATE_APP_ID = "obsidian-plugin";

/** Convert a standard base64 string to base64url (URL-safe, unpadded, RFC 7636 §A). */
export function base64ToBase64Url(b64: string): string {
	return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Generate a cryptographically random string of the given length. */
export function generateRandomString(length: number): string {
	const limit = 256 - (256 % RANDOM_CHARSET.length);
	const result: string[] = [];
	while (result.length < length) {
		const array = new Uint8Array(length - result.length);
		crypto.getRandomValues(array);
		for (const b of array) {
			if (b < limit && result.length < length) {
				result.push(RANDOM_CHARSET[b % RANDOM_CHARSET.length]!);
			}
		}
	}
	return result.join("");
}

/** Compute the S256 PKCE code challenge: base64url(SHA-256(verifier)). */
export async function computeS256Challenge(verifier: string): Promise<string> {
	const data = new TextEncoder().encode(verifier);
	const hash = await crypto.subtle.digest("SHA-256", data);
	let base64 = "";
	const bytes = new Uint8Array(hash);
	for (const b of bytes) {
		base64 += String.fromCharCode(b);
	}
	return base64ToBase64Url(btoa(base64));
}

/**
 * Build an OAuth CSRF `state` value: a base64url-encoded JSON payload carrying
 * the app id, a random nonce, and any extra fields (e.g. `{ custom: true }`).
 * base64url keeps it URL-safe so no redirect hop mangles a `+`/`/`/`=` and breaks
 * the strict comparison on return.
 */
export function buildOAuthState(extra: Record<string, unknown> = {}): string {
	const json = JSON.stringify({
		app: STATE_APP_ID,
		...extra,
		nonce: generateRandomString(32),
	});
	return base64ToBase64Url(btoa(json));
}

/** Parsed PKCE redirect callback: the authorization code and CSRF state. */
export interface PkceCallbackParams {
	code: string;
	state: string | undefined;
}

/**
 * Parse the `obsidian://air-sync-auth?code=…&state=…` PKCE redirect callback.
 * Shared by every in-plugin PKCE backend so the parse (and its error messages)
 * can't drift between them.
 */
export function parsePkceCallback(input: string): PkceCallbackParams {
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

interface OAuthTokenState {
	refreshToken: string;
	accessToken: string;
	accessTokenExpiry: number;
}

/** The fields every OAuth token/refresh response is required to carry. */
export interface OAuthTokenResponse {
	access_token: string;
	refresh_token?: string;
	expires_in: number;
}

/**
 * Extract a readable error detail from an OAuth token-endpoint error response,
 * preferring `error_description`, then `error`, then the raw text. Shared by the
 * worker-less PKCE backends (Dropbox, OneDrive) whose token endpoints return the
 * same RFC 6749 error shape, so the message format can't drift between them.
 */
export function extractTokenErrorDetail(res: { json?: unknown; text?: string }): string {
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
 * Shared OAuth access-token lifecycle: in-memory token state, expiry-skew reuse,
 * concurrent-refresh dedup, post-failure cooldown, and refresh-token-rotation
 * notification. Subclasses implement {@link performRefresh} with the provider's
 * wire protocol and {@link notAuthenticatedMessage} with its display name.
 */
export abstract class BaseOAuthTokenManager {
	protected accessToken = "";
	protected accessTokenExpiry = 0;
	protected refreshToken = "";
	private refreshPromise: Promise<string> | null = null;
	protected authFailedAt = 0;
	protected logger?: Logger;
	private onRefreshTokenRotated?: (refreshToken: string) => void;

	setTokens(refreshToken: string, accessToken: string, expiry: number): void {
		this.refreshToken = refreshToken;
		this.accessToken = accessToken;
		this.accessTokenExpiry = expiry;
		this.authFailedAt = 0;
	}

	setRefreshTokenRotatedHook(cb: (refreshToken: string) => void): void {
		this.onRefreshTokenRotated = cb;
	}

	get isAuthenticated(): boolean {
		return this.refreshToken.length > 0;
	}

	getTokenState(): OAuthTokenState {
		return {
			refreshToken: this.refreshToken,
			accessToken: this.accessToken,
			accessTokenExpiry: this.accessTokenExpiry,
		};
	}

	async getAccessToken(forceRefresh = false): Promise<string> {
		if (!this.refreshToken && !this.accessToken) {
			throw new AuthError(this.notAuthenticatedMessage(), 401);
		}
		if (this.authFailedAt > 0 && Date.now() - this.authFailedAt < AUTH_FAILED_COOLDOWN_MS) {
			throw new AuthError("Authentication expired. Please reconnect in settings.", 401);
		}
		if (!forceRefresh && this.accessToken && Date.now() < this.accessTokenExpiry - TOKEN_SKEW_MS) {
			return this.accessToken;
		}
		// A refresh is required (forced, or the access token is missing/stale) but there
		// is no refresh token to perform it — surface a reconnect prompt rather than
		// pretending we can refresh.
		if (!this.refreshToken) {
			throw new AuthError(this.sessionExpiredMessage(), 401);
		}
		if (this.refreshPromise) {
			return this.refreshPromise;
		}
		this.refreshPromise = this.performRefresh();
		try {
			return await this.refreshPromise;
		} finally {
			this.refreshPromise = null;
		}
	}

	/** Perform the provider-specific token refresh and return the new access token. */
	protected abstract performRefresh(): Promise<string>;

	/** AuthError message for the "no tokens at all" case (names the service). */
	protected abstract notAuthenticatedMessage(): string;

	/** AuthError message when a refresh is needed but no refresh token is available. */
	protected sessionExpiredMessage(): string {
		return "Authentication expired. Please reconnect in settings.";
	}

	/** Handle token refresh errors: set authFailedAt and throw AuthError for 400/401. */
	protected handleRefreshError(err: unknown): never {
		const status = (err as { status?: number }).status;
		if (status === 400 || status === 401) {
			this.authFailedAt = Date.now();
		}
		const msg = err instanceof Error ? err.message : String(err);
		this.logger?.error("Token refresh failed", { error: msg });
		if (status === 400 || status === 401) {
			throw new AuthError(`Token refresh failed: ${msg}`, status);
		}
		throw err as Error;
	}

	/** Store tokens from a validated token response, notifying on rotation. */
	protected storeTokenResponse(token: OAuthTokenResponse): void {
		this.accessToken = token.access_token;
		this.accessTokenExpiry = Date.now() + token.expires_in * 1000;
		if (token.refresh_token) {
			// Detect rotation: the provider returned a refresh token different from the
			// one we held. Fire the hook so a detached auth can persist it (a shared
			// auth leaves the hook unset and persists via its own checkpoint path).
			const rotated = !!this.refreshToken && token.refresh_token !== this.refreshToken;
			this.refreshToken = token.refresh_token;
			if (rotated) this.onRefreshTokenRotated?.(token.refresh_token);
		}
		this.authFailedAt = 0;
	}
}
