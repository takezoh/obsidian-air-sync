import { describe, it, expect, vi, afterEach } from "vitest";
import type { RequestUrlParam } from "obsidian";
import { spyRequestUrl, mockRes, createMockSecretStore } from "./test-helpers";

vi.mock("obsidian");

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function makeProvider(secrets: Record<string, string> = {}) {
	const { DropboxAuthProvider } = await import("./auth");
	const store = createMockSecretStore(secrets);
	return { auth: new DropboxAuthProvider(store, "test-client-id"), store };
}

describe("DropboxAuthProvider.isAuthenticated", () => {
	it("is true only when a refresh secret is stored", async () => {
		const { auth } = await makeProvider();
		expect(auth.isAuthenticated({})).toBe(false);
		const { auth: auth2 } = await makeProvider({ "air-sync-dropbox-refresh-token": "R" });
		expect(auth2.isAuthenticated({})).toBe(true);
	});
});

describe("DropboxAuthProvider.startAuth", () => {
	it("builds an S256 PKCE offline authorize URL and returns the pending verifier/state", async () => {
		let openedUrl = "";
		vi.stubGlobal("window", { open: (u: string) => { openedUrl = u; }, location: { href: "" } });

		const { auth } = await makeProvider();
		const out = await auth.startAuth({});

		const url = new URL(openedUrl);
		expect(url.origin + url.pathname).toBe("https://www.dropbox.com/oauth2/authorize");
		expect(url.searchParams.get("client_id")).toBe("test-client-id");
		expect(url.searchParams.get("response_type")).toBe("code");
		expect(url.searchParams.get("token_access_type")).toBe("offline");
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(url.searchParams.get("code_challenge")).toBeTruthy();
		expect(url.searchParams.get("redirect_uri")).toBe("https://airsync.takezo.dev/callback");
		expect(url.searchParams.get("scope")).toContain("files.content.write");

		expect(typeof out.pendingCodeVerifier).toBe("string");
		expect((out.pendingCodeVerifier as string).length).toBe(64);
		// The CSRF state is the relay-compatible {app, nonce} blob, now base64url
		// (URL-transit safe); normalize back to standard base64 to decode.
		const raw = out.pendingAuthState as string;
		expect(raw).not.toMatch(/[+/=]/);
		const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
		const state = JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4))) as { app: string };
		expect(state.app).toBe("obsidian-plugin");
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

describe("DropboxAuthProvider.completeAuth", () => {
	it("verifies CSRF state, exchanges the code with PKCE, and stores both tokens", async () => {
		const spy = (await spyRequestUrl()).mockResolvedValue(
			mockRes({ access_token: "AT", refresh_token: "RT", expires_in: 14400 }),
		);
		const { auth, store } = await makeProvider();
		const out = await auth.completeAuth("obsidian://air-sync-auth?code=THECODE&state=abc", {
			pendingAuthState: "abc",
			pendingCodeVerifier: "verifier-xyz",
		});

		const opts = spy.mock.calls[0]![0] as RequestUrlParam;
		expect(opts.url).toBe("https://api.dropboxapi.com/oauth2/token");
		const body = new URLSearchParams(opts.body as string);
		expect(body.get("grant_type")).toBe("authorization_code");
		expect(body.get("code")).toBe("THECODE");
		expect(body.get("code_verifier")).toBe("verifier-xyz");
		expect(body.get("client_id")).toBe("test-client-id");
		expect(body.has("client_secret")).toBe(false); // PKCE — no secret

		expect(store.getSecret("air-sync-dropbox-refresh-token")).toBe("RT");
		expect(store.getSecret("air-sync-dropbox-access-token")).toBe("AT");
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
});
