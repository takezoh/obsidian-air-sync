import { Notice, Platform } from "obsidian";
import type { IAuthProvider } from "../auth";
import type { ISecretStore } from "../secret-store";
import { setBackendSecret, hasBackendSecret } from "../token-store";

const PCLOUD_AUTHORIZE_URL = "https://my.pcloud.com/oauth2/authorize";
const AUTH_SERVER_URL = "https://auth-airsync.takezo.dev";
const REDIRECT_URI = `${AUTH_SERVER_URL}/pcloud/callback`;
const DEFAULT_API_HOST = "api.pcloud.com";
const BACKEND_TYPE = "pcloud";

/**
 * Public OAuth client id for the Air Sync pCloud app.
 *
 * Must match the worker's `PCLOUD_CLIENT_ID` var. Register the app at
 * https://docs.pcloud.com/ and set both this constant and `oauth-worker`'s var.
 */
const PCLOUD_CLIENT_ID = "sx5zHd0QG7X";

interface PCloudCallbackParams {
	access_token: string;
	hostname: string;
	state: string | undefined;
}

const NONCE_CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Generate a cryptographically random string. */
function randomNonce(length: number): string {
	const limit = 256 - (256 % NONCE_CHARSET.length);
	const out: string[] = [];
	while (out.length < length) {
		const arr = new Uint8Array(length - out.length);
		crypto.getRandomValues(arr);
		for (const b of arr) {
			if (b < limit && out.length < length) out.push(NONCE_CHARSET[b % NONCE_CHARSET.length]!);
		}
	}
	return out.join("");
}

/**
 * Build the CSRF `state` parameter. The shape (`{app, nonce}`, base64) matches
 * what the OAuth worker's `parseState` expects, so it routes the callback back
 * to the Obsidian app.
 */
function generateState(): string {
	return btoa(JSON.stringify({ app: "obsidian-plugin", nonce: randomNonce(32) }));
}

/**
 * Parse the `obsidian://air-sync-auth?access_token=…&hostname=…&state=…`
 * callback. pCloud-specific (it carries `hostname` for region pinning), so it is
 * deliberately not the shared Drive `parseAuthCallbackParams`.
 */
function parsePCloudCallback(input: string): PCloudCallbackParams {
	const trimmed = input.trim();
	if (!trimmed) throw new Error("Auth callback is empty");
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw new Error("Invalid auth callback URL");
	}
	const accessToken = url.searchParams.get("access_token");
	if (!accessToken) throw new Error("Missing access_token in auth callback");
	return {
		access_token: accessToken,
		hostname: url.searchParams.get("hostname") ?? DEFAULT_API_HOST,
		state: url.searchParams.get("state") ?? undefined,
	};
}

/**
 * pCloud authentication provider (OAuth code flow via the auth worker).
 *
 * pCloud issues a long-lived access token with no refresh token and no
 * expiry, so only the `access` secret is stored; expiry is handled reactively
 * (an auth-class `result` surfaces as an AuthError → reconnect prompt).
 */
export class PCloudAuthProvider implements IAuthProvider {
	constructor(private secretStore: ISecretStore) {}

	isAuthenticated(_backendData: Record<string, unknown>): boolean {
		return hasBackendSecret(this.secretStore, BACKEND_TYPE, "access");
	}

	startAuth(_backendData: Record<string, unknown>): Promise<Record<string, unknown>> {
		const state = generateState();
		const params = new URLSearchParams({
			client_id: PCLOUD_CLIENT_ID,
			response_type: "code",
			redirect_uri: REDIRECT_URI,
			state,
		});
		const url = `${PCLOUD_AUTHORIZE_URL}?${params.toString()}`;
		if (Platform.isMobile) {
			window.location.href = url;
		} else {
			window.open(url);
		}
		new Notice("Complete authorization in your browser");
		return Promise.resolve({ pendingAuthState: state });
	}

	completeAuth(input: string, backendData: Record<string, unknown>): Promise<Record<string, unknown>> {
		let params: PCloudCallbackParams;
		try {
			params = parsePCloudCallback(input);
		} catch (e) {
			return Promise.reject(e instanceof Error ? e : new Error(String(e)));
		}
		const expected = backendData.pendingAuthState;
		if (typeof expected !== "string" || !expected || params.state !== expected) {
			return Promise.reject(new Error("State mismatch - possible CSRF attack"));
		}
		// pCloud has no refresh token; persist only the long-lived access token.
		setBackendSecret(this.secretStore, BACKEND_TYPE, "access", params.access_token);
		return Promise.resolve({ apiHost: params.hostname, pendingAuthState: "" });
	}
}
