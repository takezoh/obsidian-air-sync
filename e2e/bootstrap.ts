import { stdout } from "node:process";
import { GoogleAuthDirect } from "../src/fs/googledrive/auth";
import { buildDropboxAuthorizeUrl, DropboxAuth } from "../src/fs/dropbox/auth";
import { DROPBOX_AUTH } from "../src/fs/auth-config";
import { buildOneDriveAuthorizeUrl, OneDriveAuth } from "../src/fs/onedrive/auth";
import { buildOAuthState, computeS256Challenge, generateRandomString } from "../src/fs/oauth-pkce";
import { loadDotEnvE2e } from "./helpers/env";
import { loopbackPort, startLoopback, writeEnvE2e } from "./helpers/loopback";

/**
 * One-time helper to mint a refresh token for the e2e suite (ADR 0003) WITHOUT a
 * copy-paste step: it starts a localhost server, prints an authorize URL, and
 * captures the redirect automatically once you approve in the browser. It reuses
 * the shipped auth code paths (`GoogleAuthDirect`, `DropboxAuth`, `OneDriveAuth`, and
 * the shared `build*AuthorizeUrl`) so the e2e exercises the production token exchange.
 *
 * Run via `npm run e2e:bootstrap -- <google|dropbox|onedrive>` (the wrapper bundles
 * this with the `obsidian` alias so `requestUrl` is real). The captured token is
 * written to `.env.e2e`. See docs/e2e-testing.md for the one-time OAuth-app setup
 * (a loopback redirect URI must be registered).
 */

function requireEnv(name: string): string {
	const v = process.env[name];
	if (!v) throw new Error(`Missing ${name} (set it in .env.e2e or the environment).`);
	return v;
}

async function bootstrapGoogle(): Promise<void> {
	// Built-in GoogleAuth refreshes via the auth server, which returns tokens to
	// obsidian:// — not capturable by a loopback. So loopback capture uses your
	// own GCP OAuth client (GoogleAuthDirect) with a localhost redirect.
	const loopback = await startLoopback(loopbackPort());
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
	const loopback = await startLoopback(loopbackPort());
	try {
		// startAuth() uses window.open (no window here), so build the authorize URL
		// via the shared builder with the loopback redirect (same params as production).
		const codeVerifier = generateRandomString(64);
		const codeChallenge = await computeS256Challenge(codeVerifier);
		const state = buildOAuthState();
		const url = buildDropboxAuthorizeUrl({
			clientId: DROPBOX_AUTH.clientId,
			codeChallenge,
			state,
			redirectUri: loopback.redirectUri,
		});
		stdout.write(`\nOpen this URL and authorize Dropbox:\n${url}\n\nWaiting for the redirect...\n`);
		const params = await loopback.waitForCallback();
		if (params.state !== state) throw new Error("State mismatch — possible CSRF; aborting.");
		if (!params.code) throw new Error("No authorization code in the callback.");
		const auth = new DropboxAuth(DROPBOX_AUTH.clientId);
		await auth.exchangeCode(params.code, codeVerifier, loopback.redirectUri);
		const path = writeEnvE2e("AIRSYNC_E2E_DROPBOX_REFRESH_TOKEN", auth.getTokenState().refreshToken);
		stdout.write(`\n✓ Dropbox refresh token written to ${path}\n`);
	} finally {
		loopback.close();
	}
}

async function bootstrapOnedrive(): Promise<void> {
	// OneDrive's shipped client id is a placeholder (REPLACE_ME) and its in-plugin
	// flow returns to obsidian:// — not capturable by a loopback. So, like Google, the
	// bootstrap uses the developer's OWN Entra app client id with a localhost redirect.
	const loopback = await startLoopback(loopbackPort());
	try {
		const clientId = requireEnv("AIRSYNC_E2E_ONEDRIVE_CLIENT_ID");
		// startAuth() uses window.open (no window here), so build the authorize URL via
		// the shared builder with the loopback redirect (same scope/PKCE params as production).
		const codeVerifier = generateRandomString(64);
		const codeChallenge = await computeS256Challenge(codeVerifier);
		const state = buildOAuthState();
		const url = buildOneDriveAuthorizeUrl({
			clientId,
			codeChallenge,
			state,
			redirectUri: loopback.redirectUri,
		});
		stdout.write(`\nOpen this URL and authorize OneDrive:\n${url}\n\nWaiting for the redirect...\n`);
		const params = await loopback.waitForCallback();
		if (params.state !== state) throw new Error("State mismatch — possible CSRF; aborting.");
		if (!params.code) throw new Error("No authorization code in the callback.");
		const auth = new OneDriveAuth(clientId);
		await auth.exchangeCode(params.code, codeVerifier, loopback.redirectUri);
		const path = writeEnvE2e("AIRSYNC_E2E_ONEDRIVE_REFRESH_TOKEN", auth.getTokenState().refreshToken);
		stdout.write(`\n✓ OneDrive refresh token written to ${path}\n`);
	} finally {
		loopback.close();
	}
}

async function main(): Promise<void> {
	loadDotEnvE2e(); // pick up AIRSYNC_E2E_*_CLIENT_ID/_SECRET from .env.e2e
	const which = process.argv[2];
	if (which === "google") await bootstrapGoogle();
	else if (which === "dropbox") await bootstrapDropbox();
	else if (which === "onedrive") await bootstrapOnedrive();
	else {
		stdout.write("Usage: npm run e2e:bootstrap -- <google|dropbox|onedrive>\n");
		process.exitCode = 1; // an unknown/typo'd subcommand must not look like success
	}
}

void main().catch((err: unknown) => {
	stdout.write(`\n✗ ${err instanceof Error ? err.message : String(err)}\n`);
	process.exitCode = 1;
});
