import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { GoogleAuth } from "../src/fs/googledrive/auth";
import { DROPBOX_CLIENT_ID, DropboxAuth } from "../src/fs/dropbox/auth";
import {
	buildOAuthState,
	computeS256Challenge,
	generateRandomString,
} from "../src/fs/oauth-pkce";

/**
 * One-time helper to mint a refresh token for the e2e suite (ADR 0003). It reuses
 * the shipped auth code paths — `GoogleAuth` (built-in, via the auth server) and
 * `DropboxAuth` (PKCE) — so the e2e exercises exactly the production auth.
 *
 * Run via `npm run e2e:bootstrap -- <google|dropbox>` (the wrapper bundles this
 * with the `obsidian` alias so `requestUrl` is real). Paste the printed token
 * into `.env.e2e`. See docs/e2e-testing.md.
 */

const DBX_AUTHORIZE = "https://www.dropbox.com/oauth2/authorize";
const DBX_REDIRECT = "https://airsync.takezo.dev/callback";
const DBX_SCOPES = "files.metadata.read files.content.read files.content.write";

/** Extract OAuth params from a pasted redirect/callback URL (query or hash). */
function parseParams(input: string): Record<string, string | undefined> {
	try {
		const u = new URL(input.trim());
		const src = u.hash ? new URLSearchParams(u.hash.slice(1)) : u.searchParams;
		return Object.fromEntries(src.entries());
	} catch {
		return {};
	}
}

async function bootstrapGoogle(rl: readline.Interface): Promise<void> {
	const auth = new GoogleAuth();
	const url = await auth.getAuthorizationUrl();
	stdout.write(`\nOpen this URL and authorize Google Drive:\n${url}\n\n`);
	const pasted = await rl.question(
		"Paste the full redirect URL you land on (or its token fragment): ",
	);
	// The auth server already exchanged the code; the callback carries the tokens
	// directly, so handleAuthCallback does no network here.
	await auth.handleAuthCallback(parseParams(pasted));
	stdout.write(
		`\nAdd to .env.e2e:\nAIRSYNC_E2E_GOOGLE_REFRESH_TOKEN=${auth.getTokenState().refreshToken}\n`,
	);
}

async function bootstrapDropbox(rl: readline.Interface): Promise<void> {
	// DropboxAuthProvider.startAuth uses window.open (no window here), so build the
	// authorize URL ourselves with the shared PKCE helpers.
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
			redirect_uri: DBX_REDIRECT,
			state,
		}).toString();
	stdout.write(`\nOpen this URL and authorize Dropbox:\n${url}\n\n`);
	const pasted = await rl.question(
		"Paste the full callback URL you land on (or just the code): ",
	);
	const code = parseParams(pasted).code ?? pasted.trim();
	const auth = new DropboxAuth(DROPBOX_CLIENT_ID);
	await auth.exchangeCode(code, codeVerifier); // hits Dropbox token endpoint
	stdout.write(
		`\nAdd to .env.e2e:\nAIRSYNC_E2E_DROPBOX_REFRESH_TOKEN=${auth.getTokenState().refreshToken}\n`,
	);
}

async function main(): Promise<void> {
	const which = process.argv[2];
	const rl = readline.createInterface({ input: stdin, output: stdout });
	try {
		if (which === "google") await bootstrapGoogle(rl);
		else if (which === "dropbox") await bootstrapDropbox(rl);
		else stdout.write("Usage: npm run e2e:bootstrap -- <google|dropbox>\n");
	} finally {
		rl.close();
	}
}

void main();
