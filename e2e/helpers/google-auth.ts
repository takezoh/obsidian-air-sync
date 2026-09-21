import type { IGoogleAuth } from "../../src/fs/googledrive/auth";
import { GoogleAuth, GoogleAuthDirect } from "../../src/fs/googledrive/auth";
import { createPlatformTransport } from "../../src/fs/platform-http-transport";
import type { BackendCreds } from "./env";
import { loadDotEnvE2e, readCreds } from "./env";

export const GOOGLE_E2E_REFRESH_TOKEN_ENV = "AIRSYNC_E2E_GOOGLE_REFRESH_TOKEN";

/** Read the shared Google refresh token produced by the existing e2e bootstrap. */
export function readGoogleE2ECreds(): BackendCreds | null {
	return readCreds(GOOGLE_E2E_REFRESH_TOKEN_ENV);
}

/**
 * Construct the auth implementation matching the OAuth client that issued the
 * shared refresh token. A partial custom-client pair intentionally retains the
 * established built-in fallback behavior.
 */
export function createGoogleE2EAuth(refreshToken: string): IGoogleAuth {
	loadDotEnvE2e();
	const clientId = process.env.AIRSYNC_E2E_GOOGLE_CLIENT_ID;
	const clientSecret = process.env.AIRSYNC_E2E_GOOGLE_CLIENT_SECRET;
	const auth: IGoogleAuth =
		clientId && clientSecret
			? new GoogleAuthDirect({ clientId, clientSecret, transport: createPlatformTransport() })
			: new GoogleAuth(createPlatformTransport());
	auth.setTokens(refreshToken, "", 0);
	return auth;
}
