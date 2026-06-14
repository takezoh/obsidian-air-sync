import { Notice, Platform } from "obsidian";
import type { IAuthProvider } from "../auth";
import type { ISecretStore } from "../secret-store";
import type { Logger } from "../../logging/logger";
import type { IGoogleAuth } from "./auth";
import type { GoogleDriveBackendData } from "./provider";
import { setBackendSecret, getBackendSecret, hasBackendSecret } from "../token-store";

interface GoogleDriveTokens {
	refreshToken: string;
	accessToken: string;
}

/** Read the Google Drive refresh+access tokens from SecretStorage. */
export function readGoogleDriveTokens(store: ISecretStore, type: string): GoogleDriveTokens {
	return {
		refreshToken: getBackendSecret(store, type, "refresh"),
		accessToken: getBackendSecret(store, type, "access"),
	};
}

/** Persist the Google Drive refresh+access tokens to SecretStorage (empty values are skipped). */
export function storeGoogleDriveTokens(store: ISecretStore, type: string, tokens: GoogleDriveTokens): void {
	setBackendSecret(store, type, "refresh", tokens.refreshToken);
	setBackendSecret(store, type, "access", tokens.accessToken);
}

/** Plugin-owned secret names every Google Drive backend stores under air-sync-<type>-<name>-token. */
export const GOOGLE_DRIVE_SECRET_NAMES = ["refresh", "access"];

/**
 * Parse auth callback input (URL from auth server containing tokens or code).
 * Built-in flow: obsidian://air-sync-auth?access_token=...&refresh_token=...&expires_in=...&state=...
 * Custom flow: obsidian://air-sync-auth?code=...&state=...
 */
export function parseAuthCallbackParams(input: string): Record<string, string | undefined> {
	const trimmed = input.trim();
	if (!trimmed) {
		throw new Error("Auth callback is empty");
	}

	try {
		const url = new URL(trimmed);
		const accessToken = url.searchParams.get("access_token");
		const code = url.searchParams.get("code");
		if (!accessToken && !code) {
			throw new Error("Missing access_token or code in auth callback");
		}
		const result: Record<string, string | undefined> = {
			state: url.searchParams.get("state") ?? undefined,
		};
		if (accessToken) {
			result.access_token = accessToken;
			result.refresh_token = url.searchParams.get("refresh_token") ?? undefined;
			result.expires_in = url.searchParams.get("expires_in") ?? "3600";
		}
		if (code) {
			result.code = code;
		}
		return result;
	} catch (e) {
		if (e instanceof Error && (e.message.includes("access_token") || e.message.includes("code"))) {
			throw e;
		}
		throw new Error("Invalid auth callback URL");
	}
}

/**
 * Base auth provider for Google Drive variants. Owns the auth-instance lifecycle
 * (force-new for start, get-or-create for complete/FS, detached for one-off reads);
 * subclasses supply only `buildAuth` (construct their GoogleAuth/GoogleAuthDirect) and,
 * for custom, the `hasCredentials` / `onMissingCredentials` policy.
 */
export abstract class GoogleDriveAuthProviderBase implements IAuthProvider {
	protected googleAuth: IGoogleAuth | null = null;
	protected readonly secretStore: ISecretStore;

	/** The backend type used for SecretStorage key generation. Set by subclass provider. */
	abstract readonly backendType: string;

	constructor(secretStore: ISecretStore) {
		this.secretStore = secretStore;
	}

	isAuthenticated(_backendData: Record<string, unknown>): boolean {
		return hasBackendSecret(this.secretStore, this.backendType, "refresh");
	}

	async startAuth(_backendData: Record<string, unknown>): Promise<Record<string, unknown>> {
		try {
			const auth = this.createAuth(_backendData);
			if (!auth) return {};

			const url = await auth.getAuthorizationUrl();
			const pendingAuthState = auth.getAuthState() ?? "";
			const pendingCodeVerifier = auth.getCodeVerifier() ?? "";

			if (Platform.isMobile) {
				window.location.href = url;
			} else {
				window.open(url);
			}
			new Notice("Complete authorization in your browser");

			return { pendingAuthState, pendingCodeVerifier };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(`Failed to start authorization: ${msg}`);
		}
	}

	async completeAuth(
		input: string,
		backendData: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		const data = backendData as Partial<GoogleDriveBackendData & { pendingCodeVerifier?: string }>;
		const auth = this.createAuthIfNeeded(backendData);
		if (!auth) {
			throw new Error("OAuth credentials are missing");
		}
		// Restore CSRF state and PKCE verifier if auth lacks them (survives plugin reload)
		if (!auth.getAuthState() && data.pendingAuthState) {
			auth.setAuthState(data.pendingAuthState);
		}
		if (!auth.getCodeVerifier() && data.pendingCodeVerifier) {
			auth.setCodeVerifier(data.pendingCodeVerifier);
		}

		const params = parseAuthCallbackParams(input);
		await auth.handleAuthCallback(params);
		const tokens = auth.getTokenState();

		// Store tokens in SecretStorage instead of returning them for backendData
		storeGoogleDriveTokens(this.secretStore, this.backendType, tokens);

		return {
			accessTokenExpiry: tokens.accessTokenExpiry,
			pendingAuthState: "",
			pendingCodeVerifier: "",
		};
	}

	/** Return the current in-memory token state (for persistence after refresh). */
	getTokenState(): { refreshToken: string; accessToken: string; accessTokenExpiry: number } | null {
		return this.googleAuth?.getTokenState() ?? null;
	}

	/** Revoke the current token (called by provider.disconnect) */
	async revokeAuth(): Promise<void> {
		if (this.googleAuth) {
			await this.googleAuth.revokeToken();
		}
		this.googleAuth = null;
	}

	/**
	 * Construct a backend-specific auth instance from the stored data. ALWAYS returns an
	 * instance — the missing-credentials policy lives in {@link hasCredentials} /
	 * {@link onMissingCredentials} and gates only the user-initiated start/complete
	 * paths, so FS-creation and detached reads build unconditionally (as before). The
	 * one factory replaces the four near-identical per-variant create methods.
	 */
	protected abstract buildAuth(data: Record<string, unknown>, logger?: Logger): IGoogleAuth;

	/**
	 * Whether `data` carries usable OAuth credentials. Built-in always does (it ships its
	 * own client); custom requires both client id and secret to resolve. Gates only the
	 * start/complete flow — not FS creation, which builds unconditionally.
	 */
	protected hasCredentials(_data: Record<string, unknown>): boolean {
		return true;
	}

	/** Called on the start-auth path when credentials are missing (custom shows a Notice). */
	protected onMissingCredentials(): void {}

	/**
	 * Force-create a fresh auth instance for STARTING the flow (resets any prior PKCE
	 * state). Returns null — after notifying — when credentials are missing.
	 */
	protected createAuth(backendData: Record<string, unknown>): IGoogleAuth | null {
		if (!this.hasCredentials(backendData)) {
			this.onMissingCredentials();
			return null;
		}
		this.googleAuth = this.buildAuth(backendData);
		return this.googleAuth;
	}

	/** Get-or-create for COMPLETING the flow. Returns null (silently) if creds are missing. */
	protected createAuthIfNeeded(backendData: Record<string, unknown>): IGoogleAuth | null {
		if (this.googleAuth) return this.googleAuth;
		if (!this.hasCredentials(backendData)) return null;
		this.googleAuth = this.buildAuth(backendData);
		return this.googleAuth;
	}

	/** Get or create the SHARED GoogleAuth instance for FS creation. */
	getOrCreateGoogleAuth(data: GoogleDriveBackendData, logger?: Logger): IGoogleAuth {
		if (!this.googleAuth) {
			this.googleAuth = this.buildAuth(data as unknown as Record<string, unknown>, logger);
		}
		return this.googleAuth;
	}

	/**
	 * Create a fresh, UNSHARED auth instance for one-off reads (settings folder-path
	 * display, folder pick) that must not reset the live sync's shared in-memory tokens.
	 */
	createDetachedGoogleAuth(data: GoogleDriveBackendData, logger?: Logger): IGoogleAuth {
		return this.wireDetachedRefreshPersistence(
			this.buildAuth(data as unknown as Record<string, unknown>, logger),
		);
	}

	/**
	 * Wire a detached auth so a refresh that ROTATES the refresh token persists the
	 * new value to SecretStorage. Without this, a rotated token would live only on
	 * the throwaway instance and be discarded, leaving the stored (and shared
	 * in-memory) token stale so the next real sync's refresh fails. Subclasses call
	 * this on the instance they return from {@link createDetachedGoogleAuth}.
	 */
	protected wireDetachedRefreshPersistence(auth: IGoogleAuth): IGoogleAuth {
		auth.setRefreshTokenRotatedHook((refreshToken) => {
			setBackendSecret(this.secretStore, this.backendType, "refresh", refreshToken);
		});
		return auth;
	}
}
