import { Notice, Platform } from "obsidian";
import type { IAuthProvider } from "./auth";
import type { ISecretStore } from "./secret-store";
import type { Logger } from "../logging/logger";
import { setBackendSecret, hasBackendSecret } from "./token-store";
import {
	BaseOAuthTokenManager,
	buildOAuthState,
	computeS256Challenge,
	generateRandomString,
	parsePkceCallback,
} from "./oauth-pkce";

/** The token-manager capabilities the shared auth-provider scaffolding drives. */
export interface PkceTokenManager extends BaseOAuthTokenManager {
	/** Exchange an authorization code (+ PKCE verifier) for tokens. */
	exchangeCode(code: string, codeVerifier: string, redirectUri?: string): Promise<void>;
	/** Revoke the active token, if the provider supports it (Microsoft does not). */
	revokeToken?(): Promise<void>;
}

/**
 * Shared in-plugin Authorization-Code + PKCE auth provider, worker-less: the code
 * returns directly via the `obsidian://air-sync-auth` deep link and is exchanged for
 * tokens with the ephemeral `code_verifier`. Every part that is identical across the
 * App-Folder PKCE backends (Dropbox, OneDrive) lives here — the lazy/shared and
 * detached token managers, CSRF-state generation and strict validation, the
 * authorize-and-notify `startAuth`, and the `completeAuth` exchange + secret writes.
 *
 * A concrete backend supplies only its wire seams: how to build a token manager and
 * its authorize URL. Refresh-token rotation on a detached manager is persisted to
 * SecretStorage so the shared (stored) token never goes stale.
 */
export abstract class PkceAuthProvider<TAuth extends PkceTokenManager> implements IAuthProvider {
	protected tokenAuth: TAuth | null = null;

	constructor(
		protected secretStore: ISecretStore,
		protected backendType: string,
		protected clientId: string,
		protected logger?: Logger,
	) {}

	/** Build the provider's token manager (one instance per FS lifetime). */
	protected abstract createAuth(clientId: string, logger?: Logger): TAuth;
	/** Build the provider's authorize URL for the in-plugin redirect. */
	protected abstract buildAuthorizeUrl(opts: { clientId: string; codeChallenge: string; state: string }): string;

	/** Get or lazily create the shared token manager (so refreshed tokens are persistable). */
	getOrCreateAuth(logger?: Logger): TAuth {
		if (!this.tokenAuth) this.tokenAuth = this.createAuth(this.clientId, logger ?? this.logger);
		return this.tokenAuth;
	}

	/**
	 * A throwaway token manager, independent of the shared (FS-bound) instance. Use for
	 * one-off read calls (e.g. resolving the folder path for the settings UI) so they
	 * don't clobber the live sync's in-memory tokens / failure cooldown. A rotated
	 * refresh token from a detached refresh is persisted to SecretStorage — otherwise it
	 * would be discarded with this instance, leaving the stored token stale.
	 */
	createDetachedAuth(logger?: Logger): TAuth {
		const auth = this.createAuth(this.clientId, logger ?? this.logger);
		auth.setRefreshTokenRotatedHook((rt) => setBackendSecret(this.secretStore, this.backendType, "refresh", rt));
		return auth;
	}

	getTokenState(): { refreshToken: string; accessToken: string; accessTokenExpiry: number } | null {
		return this.tokenAuth?.getTokenState() ?? null;
	}

	async revokeAuth(): Promise<void> {
		// Drop the in-memory manager; revoke the token first if the provider supports it.
		if (this.tokenAuth) await this.tokenAuth.revokeToken?.();
		this.tokenAuth = null;
	}

	isAuthenticated(_backendData: Record<string, unknown>): boolean {
		return hasBackendSecret(this.secretStore, this.backendType, "refresh");
	}

	async startAuth(_backendData: Record<string, unknown>): Promise<Record<string, unknown>> {
		const codeVerifier = generateRandomString(64);
		const codeChallenge = await computeS256Challenge(codeVerifier);
		// base64url state (URL-transit safe); it returns through the
		// obsidian://air-sync-auth deep link and is validated in completeAuth.
		const state = buildOAuthState();
		const url = this.buildAuthorizeUrl({ clientId: this.clientId, codeChallenge, state });
		if (Platform.isMobile) {
			window.location.href = url;
		} else {
			window.open(url);
		}
		new Notice("Complete authorization in your browser");
		return { pendingAuthState: state, pendingCodeVerifier: codeVerifier };
	}

	async completeAuth(input: string, backendData: Record<string, unknown>): Promise<Record<string, unknown>> {
		const params = parsePkceCallback(input);
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
		setBackendSecret(this.secretStore, this.backendType, "refresh", tokens.refreshToken);
		setBackendSecret(this.secretStore, this.backendType, "access", tokens.accessToken);

		return { accessTokenExpiry: tokens.accessTokenExpiry, pendingAuthState: "", pendingCodeVerifier: "" };
	}
}
