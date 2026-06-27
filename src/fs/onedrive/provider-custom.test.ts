import { describe, it, expect, vi, afterEach } from "vitest";
import type { RequestUrlParam } from "obsidian";
import { spyRequestUrl, mockRes, createMockSecretStore } from "./test-helpers";
import type { AirSyncSettings } from "../../settings";

vi.mock("obsidian");

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function makeAuth(secrets: Record<string, string> = {}) {
	const { OneDriveCustomAuthProvider } = await import("./provider-custom");
	const store = createMockSecretStore(secrets);
	return { auth: new OneDriveCustomAuthProvider(store), store };
}

async function makeProvider(secrets: Record<string, string> = {}) {
	const { OneDriveCustomProvider } = await import("./provider-custom");
	const store = createMockSecretStore(secrets);
	return { provider: new OneDriveCustomProvider(store), store };
}

function settingsWith(data: Record<string, unknown> = {}): AirSyncSettings {
	return { vaultId: "vault-1", backendData: data } as unknown as AirSyncSettings;
}

const CONNECTED = {
	"air-sync-onedrive-custom-refresh-token": "RT",
	"air-sync-onedrive-custom-access-token": "AT",
};

describe("OneDriveCustomAuthProvider.startAuth", () => {
	it("builds the authorize URL on the chosen authority with the user's client id", async () => {
		let openedUrl = "";
		vi.stubGlobal("window", { open: (u: string) => { openedUrl = u; }, location: { href: "" } });

		const { auth } = await makeAuth();
		await auth.startAuth({ customClientId: "user-cid", customAuthority: "common" });

		const url = new URL(openedUrl);
		// The account-type authority (`common` = work/school + personal) drives the host
		// segment — this is what the built-in `consumers` backend cannot reach.
		expect(url.origin + url.pathname).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
		expect(url.searchParams.get("client_id")).toBe("user-cid");
		expect(url.searchParams.get("scope")).toContain("Files.ReadWrite.AppFolder");
	});

	it("defaults to the consumers authority when none is set", async () => {
		let openedUrl = "";
		vi.stubGlobal("window", { open: (u: string) => { openedUrl = u; }, location: { href: "" } });

		const { auth } = await makeAuth();
		await auth.startAuth({ customClientId: "user-cid" });

		expect(new URL(openedUrl).origin + new URL(openedUrl).pathname)
			.toBe("https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize");
	});

	it("aborts (no URL opened) and notifies when the client id is missing", async () => {
		let opened = false;
		vi.stubGlobal("window", { open: () => { opened = true; }, location: { href: "" } });

		const { auth } = await makeAuth();
		const out = await auth.startAuth({});

		expect(out).toEqual({});
		expect(opened).toBe(false);
	});

	it("fails closed on the empty tenant sentinel — never silently authorizes against consumers", async () => {
		let opened = false;
		vi.stubGlobal("window", { open: () => { opened = true; }, location: { href: "" } });

		// customAuthority === "" means "Specific tenant…" was picked but no GUID typed yet.
		// resolveAuthority would coerce "" → consumers; hasCredentials must block it.
		const { auth } = await makeAuth();
		const out = await auth.startAuth({ customClientId: "user-cid", customAuthority: "" });

		expect(out).toEqual({});
		expect(opened).toBe(false);
	});
});

describe("OneDriveCustomAuthProvider.completeAuth", () => {
	it("exchanges the code on the chosen tenant token URL with the user's client id, under the -custom keys", async () => {
		const spy = (await spyRequestUrl()).mockResolvedValue(
			mockRes({ access_token: "AT", refresh_token: "RT", expires_in: 3600 }),
		);
		const { auth, store } = await makeAuth();
		await auth.completeAuth("obsidian://air-sync-auth?code=THECODE&state=abc", {
			customClientId: "user-cid",
			customAuthority: "organizations",
			pendingAuthState: "abc",
			pendingCodeVerifier: "verifier-xyz",
		});

		const opts = spy.mock.calls[0]![0] as RequestUrlParam;
		expect(opts.url).toBe("https://login.microsoftonline.com/organizations/oauth2/v2.0/token");
		const body = new URLSearchParams(opts.body as string);
		expect(body.get("client_id")).toBe("user-cid");
		expect(body.has("client_secret")).toBe(false); // PKCE — public client, no secret

		expect(store.getSecret("air-sync-onedrive-custom-refresh-token")).toBe("RT");
		expect(store.getSecret("air-sync-onedrive-custom-access-token")).toBe("AT");
	});
});

describe("OneDriveAuth authority refresh", () => {
	it("refreshes against the configured authority's token URL (a tenant GUID)", async () => {
		const { OneDriveAuth } = await import("./auth");
		const spy = (await spyRequestUrl()).mockResolvedValue(mockRes({ access_token: "AT2", expires_in: 3600 }));
		const tenant = "11111111-2222-3333-4444-555555555555";
		const auth = new OneDriveAuth("cid", tenant);
		auth.setTokens("RT", "AT", 0); // expired → forces a refresh

		await auth.getAccessToken(false);

		expect((spy.mock.calls[0]![0] as RequestUrlParam).url)
			.toBe(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`);
	});
});

describe("OneDriveCustomProvider.isConnected / disconnect", () => {
	it("requires a -custom token and a bound folder id", async () => {
		const { provider } = await makeProvider(CONNECTED);
		expect(provider.isConnected(settingsWith({ customClientId: "CID" }))).toBe(false);
		expect(provider.isConnected(settingsWith({ customClientId: "CID", remoteVaultFolderId: "id9" }))).toBe(true);
	});

	it("clears the -custom token secrets and resets data, but preserves the client id and authority", async () => {
		const { provider, store } = await makeProvider(CONNECTED);
		const data = await provider.disconnect(
			settingsWith({ remoteVaultFolderId: "x", customClientId: "CID", customAuthority: "common" }),
		);
		expect(store.getSecret("air-sync-onedrive-custom-refresh-token")).toBe("");
		expect(store.getSecret("air-sync-onedrive-custom-access-token")).toBe("");
		expect(data).toMatchObject({
			remoteVaultFolderId: "",
			customClientId: "CID",
			customAuthority: "common",
		});
	});
});
