import { stdout } from "node:process";
import { GoogleAuthDirect } from "../src/fs/googledrive/auth";
import { buildDropboxAuthorizeUrl, DropboxAuth } from "../src/fs/dropbox/auth";
import { DROPBOX_AUTH } from "../src/fs/auth-config";
import { buildOneDriveAuthorizeUrl, OneDriveAuth } from "../src/fs/onedrive/auth";
import { buildOAuthState, computeS256Challenge, generateRandomString } from "../src/fs/oauth-pkce";
import { requestUrl } from "obsidian";
import { assertOk, type PCloudTokenResponse } from "../src/fs/pcloud/types";
import { loadDotEnvE2e } from "./helpers/env";
import { loopbackPort, startLoopback, writeEnvE2e } from "./helpers/loopback";

/**
 * One-time helper to mint an e2e credential (ADR 0003) WITHOUT a copy-paste step:
 * it starts a localhost server, prints an authorize URL, and captures the redirect
 * automatically once you approve in the browser. Google/Dropbox/OneDrive reuse the
 * shipped auth code paths (`GoogleAuthDirect`, `DropboxAuth`, `OneDriveAuth`, and the
 * shared `build*AuthorizeUrl`) and mint a REFRESH token.
 *
 * pCloud is different: its production flow exchanges the code in the auth worker
 * (which holds the client secret) and returns a LONG-LIVED access token to
 * obsidian://, so there is no shipped exchange to reuse. The bootstrap instead
 * talks to pCloud directly with a dev OAuth client and runs the `oauth2_token`
 * exchange inline (the one piece the worker normally owns), reusing only the
 * shipped `assertOk` to validate the response.
 *
 * Run via `npm run e2e:bootstrap -- <google|dropbox|onedrive|pcloud>` (the wrapper
 * bundles this with the `obsidian` alias so `requestUrl` is real). The captured
 * credential is written to `.env.e2e`. See docs/e2e-testing.md for the one-time
 * OAuth-app setup (a loopback redirect URI must be registered).
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

/**
 * Map the pCloud authorize-redirect params to the region API host for the token
 * exchange (and for `AIRSYNC_E2E_PCLOUD_API_HOST`). pCloud returns `hostname`
 * (and/or `locationid`: 1 = US api.pcloud.com, 2 = EU eapi.pcloud.com); fall back
 * to the US host if neither is present.
 */
function pcloudApiHostFromCallback(params: Record<string, string>): string {
	if (params.hostname) return params.hostname;
	if (params.locationid === "2") return "eapi.pcloud.com";
	return "api.pcloud.com";
}

async function bootstrapPcloud(): Promise<void> {
	// No shipped exchange to reuse (the worker owns it in production), so talk to
	// pCloud directly: a dev OAuth client (your own id/secret, with the loopback
	// redirect registered) + an inline `oauth2_token` exchange. The result is a
	// long-lived access token — no refresh token, so it is written verbatim.
	const clientId = requireEnv("AIRSYNC_E2E_PCLOUD_CLIENT_ID");
	const clientSecret = requireEnv("AIRSYNC_E2E_PCLOUD_CLIENT_SECRET");
	const loopback = await startLoopback(loopbackPort());
	try {
		const url = `https://my.pcloud.com/oauth2/authorize?${new URLSearchParams({
			client_id: clientId,
			response_type: "code",
			redirect_uri: loopback.redirectUri,
		}).toString()}`;
		stdout.write(`\nOpen this URL and authorize pCloud:\n${url}\n\nWaiting for the redirect...\n`);
		const params = await loopback.waitForCallback();
		if (!params.code) throw new Error("No authorization code in the callback.");
		// The pCloud authorization code is region-bound — exchange it on the host the
		// callback names (`hostname` / `locationid`). (Don't let a stale env override pick
		// the host: it would send the code to the wrong region and pCloud would reject it.)
		const host = pcloudApiHostFromCallback(params);
		const res = await requestUrl({
			url: `https://${host}/oauth2_token?${new URLSearchParams({
				client_id: clientId,
				client_secret: clientSecret,
				code: params.code,
			}).toString()}`,
		});
		const json: unknown = res.json;
		assertOk(json, "oauth2_token");
		const accessToken = (json as PCloudTokenResponse).access_token;
		if (!accessToken) throw new Error("No access_token in the oauth2_token response.");
		const path = writeEnvE2e("AIRSYNC_E2E_PCLOUD_ACCESS_TOKEN", accessToken);
		writeEnvE2e("AIRSYNC_E2E_PCLOUD_API_HOST", host);
		stdout.write(`\n✓ pCloud access token (+ API host ${host}) written to ${path}\n`);
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
	else if (which === "pcloud") await bootstrapPcloud();
	else {
		stdout.write("Usage: npm run e2e:bootstrap -- <google|dropbox|onedrive|pcloud>\n");
		process.exitCode = 1; // an unknown/typo'd subcommand must not look like success
	}
}

void main().catch((err: unknown) => {
	stdout.write(`\n✗ ${err instanceof Error ? err.message : String(err)}\n`);
	process.exitCode = 1;
});
