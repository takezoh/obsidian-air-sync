import { describe, it, expect, vi, afterEach } from "vitest";
import type { RequestUrlParam } from "obsidian";
import { spyRequestUrl, mockRes, createMockSecretStore } from "./test-helpers";
import { AuthError } from "../errors";

vi.mock("obsidian");

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function makeProvider(secrets: Record<string, string> = {}) {
	const { OneDriveAuthProvider } = await import("./auth");
	const store = createMockSecretStore(secrets);
	return { auth: new OneDriveAuthProvider(store, "test-client-id"), store };
}

const TOKEN_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";

describe("OneDriveAuthProvider.isAuthenticated", () => {
	it("is true only when a refresh secret is stored", async () => {
		const { auth } = await makeProvider();
		expect(auth.isAuthenticated({})).toBe(false);
		const { auth: auth2 } = await makeProvider({ "air-sync-onedrive-refresh-token": "R" });
		expect(auth2.isAuthenticated({})).toBe(true);
	});
});

describe("OneDriveAuthProvider.startAuth", () => {
	it("builds an S256 PKCE authorize URL on the consumers authority with the app-folder scope", async () => {
		let openedUrl = "";
		vi.stubGlobal("window", { open: (u: string) => { openedUrl = u; }, location: { href: "" } });

		const { auth } = await makeProvider();
		const out = await auth.startAuth({});

		const url = new URL(openedUrl);
		expect(url.origin + url.pathname).toBe("https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize");
		expect(url.searchParams.get("client_id")).toBe("test-client-id");
		expect(url.searchParams.get("response_type")).toBe("code");
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(url.searchParams.get("code_challenge")).toBeTruthy();
		expect(url.searchParams.get("redirect_uri")).toBe("obsidian://air-sync-auth");
		expect(url.searchParams.get("scope")).toContain("Files.ReadWrite.AppFolder");
		expect(url.searchParams.get("scope")).toContain("offline_access");

		expect((out.pendingCodeVerifier as string).length).toBe(64);
		expect(url.searchParams.get("state")).toBe(out.pendingAuthState);
	});

	it("derives a code_challenge that is the base64url SHA-256 of the verifier", async () => {
		let openedUrl = "";
		vi.stubGlobal("window", { open: (u: string) => { openedUrl = u; }, location: { href: "" } });
		const { auth } = await makeProvider();
		const out = await auth.startAuth({});

		const verifier = out.pendingCodeVerifier as string;
		const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
		let b64 = "";
		for (const b of new Uint8Array(hash)) b64 += String.fromCharCode(b);
		const expected = btoa(b64).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
		expect(new URL(openedUrl).searchParams.get("code_challenge")).toBe(expected);
	});
});

describe("OneDriveAuthProvider.completeAuth", () => {
	it("verifies CSRF state, exchanges the code with PKCE (no secret), and stores both tokens", async () => {
		const spy = (await spyRequestUrl()).mockResolvedValue(
			mockRes({ access_token: "AT", refresh_token: "RT", expires_in: 3600 }),
		);
		const { auth, store } = await makeProvider();
		const out = await auth.completeAuth("obsidian://air-sync-auth?code=THECODE&state=abc", {
			pendingAuthState: "abc",
			pendingCodeVerifier: "verifier-xyz",
		});

		const opts = spy.mock.calls[0]![0] as RequestUrlParam;
		expect(opts.url).toBe(TOKEN_URL);
		const body = new URLSearchParams(opts.body as string);
		expect(body.get("grant_type")).toBe("authorization_code");
		expect(body.get("code")).toBe("THECODE");
		expect(body.get("code_verifier")).toBe("verifier-xyz");
		expect(body.get("client_id")).toBe("test-client-id");
		expect(body.has("client_secret")).toBe(false); // PKCE — no secret

		expect(store.getSecret("air-sync-onedrive-refresh-token")).toBe("RT");
		expect(store.getSecret("air-sync-onedrive-access-token")).toBe("AT");
		expect(out.pendingAuthState).toBe("");
		expect(out.pendingCodeVerifier).toBe("");
		expect(typeof out.accessTokenExpiry).toBe("number");
	});

	it("rejects on a state mismatch (CSRF)", async () => {
		const { auth } = await makeProvider();
		await expect(
			auth.completeAuth("obsidian://air-sync-auth?code=C&state=evil", { pendingAuthState: "abc", pendingCodeVerifier: "v" }),
		).rejects.toThrow("State mismatch");
	});

	it("rejects when the PKCE verifier is missing", async () => {
		const { auth } = await makeProvider();
		await expect(
			auth.completeAuth("obsidian://air-sync-auth?code=C&state=abc", { pendingAuthState: "abc" }),
		).rejects.toThrow("code verifier is missing");
	});

	it("rejects when the code is missing from the callback", async () => {
		const { auth } = await makeProvider();
		await expect(
			auth.completeAuth("obsidian://air-sync-auth?state=abc", { pendingAuthState: "abc", pendingCodeVerifier: "v" }),
		).rejects.toThrow("Missing code");
	});

	it("rejects a token response missing expires_in (avoids a NaN expiry → refresh-every-call)", async () => {
		(await spyRequestUrl()).mockResolvedValue(mockRes({ access_token: "AT" }));
		const { auth } = await makeProvider();
		await expect(
			auth.completeAuth("obsidian://air-sync-auth?code=THECODE&state=abc", {
				pendingAuthState: "abc",
				pendingCodeVerifier: "verifier-xyz",
			}),
		).rejects.toThrow(/Invalid Microsoft token response/);
	});
});

describe("OneDriveAuth refresh lifecycle", () => {
	it("refreshes on demand using only client_id + refresh_token (no secret)", async () => {
		const { OneDriveAuth } = await import("./auth");
		const spy = (await spyRequestUrl()).mockResolvedValue(mockRes({ access_token: "AT2", expires_in: 3600 }));
		const auth = new OneDriveAuth("test-client-id");
		auth.setTokens("RT", "AT", 0); // expired → forces a refresh

		const token = await auth.getAccessToken(false);

		expect(token).toBe("AT2");
		const body = new URLSearchParams((spy.mock.calls[0]![0] as RequestUrlParam).body as string);
		expect(body.get("grant_type")).toBe("refresh_token");
		expect(body.get("refresh_token")).toBe("RT");
		expect(body.get("client_id")).toBe("test-client-id");
		expect(body.has("client_secret")).toBe(false);
	});

	it("dedups concurrent refreshes into a single token request", async () => {
		const { OneDriveAuth } = await import("./auth");
		const spy = (await spyRequestUrl()).mockResolvedValue(mockRes({ access_token: "AT2", expires_in: 3600 }));
		const auth = new OneDriveAuth("test-client-id");
		auth.setTokens("RT", "AT", 0);

		const [a, b] = await Promise.all([auth.getAccessToken(false), auth.getAccessToken(false)]);
		expect(a).toBe("AT2");
		expect(b).toBe("AT2");
		// One in-flight refresh shared by both callers.
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("enters a cooldown after a 400/401 refresh failure (fails fast without re-hitting the endpoint)", async () => {
		const { OneDriveAuth } = await import("./auth");
		const spy = (await spyRequestUrl()).mockResolvedValue(
			mockRes({ error: "invalid_grant", error_description: "expired" }, { status: 400 }),
		);
		const auth = new OneDriveAuth("test-client-id");
		auth.setTokens("RT", "AT", 0);

		await expect(auth.getAccessToken(false)).rejects.toBeInstanceOf(AuthError);
		// The cooldown short-circuits the second call — the endpoint is not hit again.
		await expect(auth.getAccessToken(false)).rejects.toBeInstanceOf(AuthError);
		expect(spy).toHaveBeenCalledTimes(1);
	});
});

describe("OneDriveAuthProvider detached auth refresh-token rotation", () => {
	const CONNECTED = {
		"air-sync-onedrive-refresh-token": "RT",
		"air-sync-onedrive-access-token": "AT",
	};

	it("persists a rotated refresh token from a detached refresh to SecretStorage", async () => {
		const { auth, store } = await makeProvider(CONNECTED);
		const detached = auth.createDetachedAuth({});
		detached.setTokens("RT", "AT", 0); // expired → must refresh

		(await spyRequestUrl()).mockResolvedValue(
			mockRes({ access_token: "AT2", refresh_token: "RT2", expires_in: 3600 }),
		);

		const token = await detached.getAccessToken(false);

		expect(token).toBe("AT2");
		expect(store.getSecret("air-sync-onedrive-refresh-token")).toBe("RT2");
	});

	it("leaves the stored refresh token untouched when the provider does not rotate it", async () => {
		const { auth, store } = await makeProvider(CONNECTED);
		const detached = auth.createDetachedAuth({});
		detached.setTokens("RT", "AT", 0);

		(await spyRequestUrl()).mockResolvedValue(mockRes({ access_token: "AT2", expires_in: 3600 }));

		await detached.getAccessToken(false);

		expect(store.getSecret("air-sync-onedrive-refresh-token")).toBe("RT");
	});
});
