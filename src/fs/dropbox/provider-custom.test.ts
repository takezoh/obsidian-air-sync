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
	const { DropboxCustomAuthProvider } = await import("./provider-custom");
	const store = createMockSecretStore(secrets);
	return { auth: new DropboxCustomAuthProvider(store), store };
}

async function makeProvider(secrets: Record<string, string> = {}) {
	const { DropboxCustomProvider } = await import("./provider-custom");
	const store = createMockSecretStore(secrets);
	return { provider: new DropboxCustomProvider(store), store };
}

function settingsWith(data: Record<string, unknown> = {}): AirSyncSettings {
	return { vaultId: "vault-1", backendData: data } as unknown as AirSyncSettings;
}

const CONNECTED = {
	"air-sync-dropbox-custom-refresh-token": "RT",
	"air-sync-dropbox-custom-access-token": "AT",
};

describe("DropboxCustomAuthProvider.startAuth", () => {
	it("builds the Dropbox authorize URL with the user's app key", async () => {
		let openedUrl = "";
		vi.stubGlobal("window", { open: (u: string) => { openedUrl = u; }, location: { href: "" } });

		const { auth } = await makeAuth();
		await auth.startAuth({ customClientId: "user-appkey" });

		const url = new URL(openedUrl);
		expect(url.origin + url.pathname).toBe("https://www.dropbox.com/oauth2/authorize");
		expect(url.searchParams.get("client_id")).toBe("user-appkey");
		expect(url.searchParams.get("token_access_type")).toBe("offline");
	});

	it("aborts (no URL opened) when the app key is missing", async () => {
		let opened = false;
		vi.stubGlobal("window", { open: () => { opened = true; }, location: { href: "" } });

		const { auth } = await makeAuth();
		const out = await auth.startAuth({});

		expect(out).toEqual({});
		expect(opened).toBe(false);
	});
});

describe("DropboxCustomAuthProvider.completeAuth", () => {
	it("exchanges the code with the user's app key, storing tokens under the -custom keys", async () => {
		const spy = (await spyRequestUrl()).mockResolvedValue(
			mockRes({ access_token: "AT", refresh_token: "RT", expires_in: 14400 }),
		);
		const { auth, store } = await makeAuth();
		await auth.completeAuth("obsidian://air-sync-auth?code=THECODE&state=abc", {
			customClientId: "user-appkey",
			pendingAuthState: "abc",
			pendingCodeVerifier: "verifier-xyz",
		});

		const body = new URLSearchParams((spy.mock.calls[0]![0] as RequestUrlParam).body as string);
		expect(body.get("client_id")).toBe("user-appkey");
		expect(body.has("client_secret")).toBe(false); // PKCE — public client, no secret

		expect(store.getSecret("air-sync-dropbox-custom-refresh-token")).toBe("RT");
		expect(store.getSecret("air-sync-dropbox-custom-access-token")).toBe("AT");
	});
});

describe("DropboxCustomProvider.isConnected / disconnect", () => {
	it("requires a -custom token and a bound folder id", async () => {
		const { provider } = await makeProvider(CONNECTED);
		expect(provider.isConnected(settingsWith({ customClientId: "AK" }))).toBe(false);
		expect(provider.isConnected(settingsWith({ customClientId: "AK", remoteVaultFolderId: "id:9" }))).toBe(true);
	});

	it("clears the -custom token secrets and resets data, but preserves the app key", async () => {
		const { provider, store } = await makeProvider(CONNECTED);
		const data = await provider.disconnect(settingsWith({ remoteVaultFolderId: "id:x", customClientId: "AK" }));
		expect(store.getSecret("air-sync-dropbox-custom-refresh-token")).toBe("");
		expect(store.getSecret("air-sync-dropbox-custom-access-token")).toBe("");
		expect(data).toMatchObject({ remoteVaultFolderId: "", customClientId: "AK" });
	});
});
