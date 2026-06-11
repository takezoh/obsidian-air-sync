import { stdout } from "node:process";
import { GoogleAuthDirect } from "../src/fs/googledrive/auth";
import { DROPBOX_CLIENT_ID, DropboxAuth } from "../src/fs/dropbox/auth";
import {
	buildOAuthState,
	computeS256Challenge,
	generateRandomString,
} from "../src/fs/oauth-pkce";
import { loopbackPort, startLoopback, writeEnvE2e } from "./helpers/loopback";

/**
 * One-time helper to mint a refresh token for the e2e suite (ADR 0003) WITHOUT a
 * copy-paste step: it starts a localhost server, prints an authorize URL, and
 * captures the redirect automatically once you approve in the browser. It reuses
 * the shipped auth code paths (`GoogleAuthDirect`, `DropboxAuth`) so the e2e
 * exercises the production token exchange.
 *
 * Run via `npm run e2e:bootstrap -- <google|dropbox>` (the wrapper bundles this
 * with the `obsidian` alias so `requestUrl` is real). The captured token is
 * written to `.env.e2e`. See docs/e2e-testing.md for the one-time OAuth-app setup
 * (a loopback redirect URI must be registered).
 */

const DBX_AUTHORIZE = "https://www.dropbox.com/oauth2/authorize";
const DBX_SCOPES = "files.metadata.read files.content.read files.content.write";

function requireEnv(name: string): string {
	const v = process.env[name];
	if (!v) throw new Error(`Missing ${name} (set it in .env.e2e or the environment).`);
	return v;
}

async function bootstrapGoogle(): Promise<void> {
	// Built-in GoogleAuth refreshes via the auth server, which returns tokens to
	// obsidian:// — not capturable by a loopback. So loopback capture uses your
	// own GCP OAuth client (GoogleAuthDirect) with a localhost redirect.
	const loopback = startLoopback(loopbackPort());
	try {
		const auth = new GoogleAuthDirect({
			clientId: requireEnv("AIRSYNC_E2E_GOOGLE_CLIENT_ID"),
			clientSecret: requireEnv("AIRSYNC_E2E_GOOGLE_CLIENT_SECRET"),
			redirectUri: loopback.redirectUri,
		});
		const url = await auth.getAuthorizationUrl();
		stdout.write(`\nOpen this URL and authorize Google Drive:\n${url}\n\nWaiting for the redirect...\n`);
		const params = await loopback.waitForCallback();
		await auth.handleAuthCallback(params);
		const path = writeEnvE2e("AIRSYNC_E2E_GOOGLE_REFRESH_TOKEN", auth.getTokenState().refreshToken);
		stdout.write(`\n✓ Google refresh token written to ${path}\n`);
	} finally {
		loopback.close();
	}
}

async function bootstrapDropbox(): Promise<void> {
	const loopback = startLoopback(loopbackPort());
	try {
		// DropboxAuthProvider.startAuth uses window.open (no window here), so build
		// the authorize URL ourselves with the shared PKCE helpers + loopback redirect.
		const codeVerifier = generateRandomString(64);
		const codeChallenge = await computeS256Challenge(codeVerifier);
		const state = buildOAuthState();
		const url =
			`${DBX_AUTHORIZE}?` +
			new URLSearchParams({
				client_id: DROPBOX_CLIENT_ID,
				response_type: "code",
				token_access_type: "offline",
				code_challenge: codeChallenge,
				code_challenge_method: "S256",
				scope: DBX_SCOPES,
				redirect_uri: loopback.redirectUri,
				state,
			}).toString();
		stdout.write(`\nOpen this URL and authorize Dropbox:\n${url}\n\nWaiting for the redirect...\n`);
		const params = await loopback.waitForCallback();
		if (params.state !== state) throw new Error("State mismatch — possible CSRF; aborting.");
		const auth = new DropboxAuth(DROPBOX_CLIENT_ID);
		await auth.exchangeCode(params.code!, codeVerifier, loopback.redirectUri);
		const path = writeEnvE2e("AIRSYNC_E2E_DROPBOX_REFRESH_TOKEN", auth.getTokenState().refreshToken);
		stdout.write(`\n✓ Dropbox refresh token written to ${path}\n`);
	} finally {
		loopback.close();
	}
}

async function main(): Promise<void> {
	const which = process.argv[2];
	if (which === "google") await bootstrapGoogle();
	else if (which === "dropbox") await bootstrapDropbox();
	else stdout.write("Usage: npm run e2e:bootstrap -- <google|dropbox>\n");
}

void main().catch((err: unknown) => {
	stdout.write(`\n✗ ${err instanceof Error ? err.message : String(err)}\n`);
	process.exitCode = 1;
});
