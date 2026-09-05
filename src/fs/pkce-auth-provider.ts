import { Notice, Platform } from "../platform/obsidian";
import type { IAuthProvider } from "./auth";
import type { ISecretStore } from "./secret-store";
import type { Logger } from "../logging/logger";
import { getBackendSecret, hasBackendSecret, publishBackendSecret, setBackendSecret } from "./token-store";
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

/** Nonsecret identity bound to one pending PKCE authorization attempt. */
export interface PendingPkceAuthIdentity {
	backendType: string;
	clientId: string;
	authority?: string;
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

	/**
	 * Build the provider's token manager (one instance per FS lifetime). The active
	 * `backendData` is passed so a custom-app variant can read per-vault config (e.g. the
	 * OneDrive authority); the built-ins ignore it and use the ctor `clientId`.
	 */
	protected abstract createAuth(clientId: string, backendData: Record<string, unknown>, logger?: Logger): TAuth;
	/** Build the provider's authorize URL for the in-plugin redirect. */
	protected abstract buildAuthorizeUrl(
		opts: { clientId: string; codeChallenge: string; state: string },
		backendData: Record<string, unknown>,
	): string;

	/**
	 * Resolve the effective client id from the active `backendData`. The built-ins use the
	 * ctor `clientId`; a custom-app variant overrides this to read the user-entered id.
	 */
	protected resolveClientId(_backendData: Record<string, unknown>): string {
		return this.clientId;
	}

	/** Whether the active `backendData` carries usable credentials (custom variants override). */
	protected hasCredentials(_backendData: Record<string, unknown>): boolean {
		return true;
	}

	/** Notify the user on the start path when credentials are missing (custom variants override). */
	protected onMissingCredentials(): void {}

	/** Optional provider identity segment (OneDrive custom authority). */
	protected resolveAttemptAuthority(_backendData: Record<string, unknown>): string | undefined {
		return undefined;
	}

	/** Whether this provider requires a nonempty authority in the pending snapshot. */
	protected requiresAttemptAuthority(): boolean {
		return false;
	}

	private createAttemptIdentity(backendData: Record<string, unknown>): PendingPkceAuthIdentity {
		const authority = this.resolveAttemptAuthority(backendData);
		return {
			backendType: this.backendType,
			clientId: this.resolveClientId(backendData),
			...(authority === undefined ? {} : { authority }),
		};
	}

	private readAttemptIdentity(value: unknown): PendingPkceAuthIdentity {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new Error("OAuth attempt identity is missing. Please restart the authorization flow.");
		}
		const identity = value as Record<string, unknown>;
		if (
			identity.backendType !== this.backendType ||
			typeof identity.clientId !== "string" ||
			!identity.clientId ||
			(this.clientId !== "" && identity.clientId !== this.clientId) ||
			(this.requiresAttemptAuthority() && (typeof identity.authority !== "string" || !identity.authority)) ||
			(identity.authority !== undefined && typeof identity.authority !== "string")
		) {
			throw new Error("OAuth attempt identity is invalid. Please restart the authorization flow.");
		}
		return {
			backendType: identity.backendType,
			clientId: identity.clientId,
			...(typeof identity.authority === "string" ? { authority: identity.authority } : {}),
		};
	}

	private applyAttemptIdentity(
		backendData: Record<string, unknown>,
		identity: PendingPkceAuthIdentity,
	): Record<string, unknown> {
		return {
			...backendData,
			customClientId: identity.clientId,
			...(identity.authority === undefined ? {} : { customAuthority: identity.authority }),
		};
	}

	/** Get or lazily create the shared token manager (so refreshed tokens are persistable). */
	getOrCreateAuth(backendData: Record<string, unknown>, logger?: Logger): TAuth {
		if (!this.tokenAuth) {
			this.tokenAuth = this.wireRefreshPersistence(
				this.createAuth(this.resolveClientId(backendData), backendData, logger ?? this.logger),
			);
		}
		return this.tokenAuth;
	}

	/**
	 * A throwaway token manager, independent of the shared (FS-bound) instance. Use for
	 * one-off read calls (e.g. resolving the folder path for the settings UI) so they
	 * don't clobber the live sync's in-memory tokens / failure cooldown. A rotated
	 * refresh token from a detached refresh is persisted to SecretStorage — otherwise it
	 * would be discarded with this instance, leaving the stored token stale.
	 */
	createDetachedAuth(backendData: Record<string, unknown>, logger?: Logger): TAuth {
		return this.wireRefreshPersistence(
			this.createAuth(this.resolveClientId(backendData), backendData, logger ?? this.logger),
		);
	}

	private wireRefreshPersistence(auth: TAuth): TAuth {
		auth.setRefreshTokenRotatedHook((refreshToken) => {
			publishBackendSecret(this.secretStore, this.backendType, "refresh", refreshToken);
		});
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

	async startAuth(backendData: Record<string, unknown>): Promise<Record<string, unknown>> {
		if (!this.hasCredentials(backendData)) {
			this.onMissingCredentials();
			return {};
		}
		const identity = this.createAttemptIdentity(backendData);
		const attemptData = this.applyAttemptIdentity(backendData, identity);
		const codeVerifier = generateRandomString(64);
		const codeChallenge = await computeS256Challenge(codeVerifier);
		// base64url state (URL-transit safe); it returns through the
		// obsidian://air-sync-auth deep link and is validated in completeAuth.
		const state = buildOAuthState();
		this.tokenAuth = null;
		const url = this.buildAuthorizeUrl({ clientId: identity.clientId, codeChallenge, state }, attemptData);
		if (Platform.isMobile) {
			window.location.href = url;
		} else {
			window.open(url);
		}
		new Notice("Complete authorization in your browser");
		return { pendingAuthState: state, pendingCodeVerifier: codeVerifier, pendingAuthIdentity: identity };
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
		const identity = this.readAttemptIdentity(backendData.pendingAuthIdentity);
		const attemptData = this.applyAttemptIdentity(backendData, identity);

		const auth = this.wireRefreshPersistence(
			this.createAuth(identity.clientId, attemptData, this.logger),
		);
		await auth.exchangeCode(params.code, codeVerifier);
		const tokens = auth.getTokenState();
		const requiredRefresh = tokens.refreshToken || getBackendSecret(this.secretStore, this.backendType, "refresh");
		publishBackendSecret(this.secretStore, this.backendType, "refresh", requiredRefresh);
		setBackendSecret(this.secretStore, this.backendType, "access", tokens.accessToken);
		if (!tokens.refreshToken) {
			auth.setTokens(requiredRefresh, tokens.accessToken, tokens.accessTokenExpiry);
		}
		this.tokenAuth = auth;

		return {
			accessTokenExpiry: tokens.accessTokenExpiry,
			pendingAuthState: "",
			pendingCodeVerifier: "",
			pendingAuthIdentity: null,
		};
	}
}
