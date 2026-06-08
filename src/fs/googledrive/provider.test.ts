import { describe, it, expect, vi, afterEach } from "vitest";
import { spyRequestUrl, mockRes, createMockSecretStore } from "./test-helpers";
import { FOLDER_MIME } from "./types";
import type { AirSyncSettings } from "../../settings";

vi.mock("obsidian");

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function makeProvider(secrets: Record<string, string> = {}) {
	const { GoogleDriveProvider } = await import("./provider");
	const store = createMockSecretStore(secrets);
	return { provider: new GoogleDriveProvider(store), store };
}

function settingsWith(googledrive: Record<string, unknown> = {}): AirSyncSettings {
	return { vaultId: "vault-1", backendData: googledrive } as unknown as AirSyncSettings;
}

const CONNECTED = {
	"air-sync-googledrive-refresh-token": "RT",
	"air-sync-googledrive-access-token": "AT",
};
// Future expiry → getAccessToken returns the cached token without a refresh round-trip,
// so the mocked requestUrl only ever serves the getFile request under test.
const FRESH = { accessTokenExpiry: Date.now() + 3_600_000 };

describe("GoogleDriveProvider.isConnected / getIdentity", () => {
	it("requires a token and a resolved remote vault folder id", async () => {
		const { provider } = await makeProvider(CONNECTED);
		expect(provider.isConnected(settingsWith({}))).toBe(false);
		expect(provider.isConnected(settingsWith({ remoteVaultFolderId: "FID" }))).toBe(true);
	});

	it("derives identity from the folder id", async () => {
		const { provider } = await makeProvider(CONNECTED);
		expect(provider.getIdentity(settingsWith({ remoteVaultFolderId: "FID" }))).toBe("googledrive:FID");
		expect(provider.getIdentity(settingsWith({}))).toBeNull();
	});
});

describe("GoogleDriveProvider.startWebFolderPick", () => {
	it("opens the picker with the state + apiKey in the query and the token in the fragment only", async () => {
		const openSpy = vi.fn();
		vi.stubGlobal("window", { open: openSpy, location: { href: "" } });
		const { provider } = await makeProvider(CONNECTED);

		const res = await provider.startWebFolderPick(settingsWith({ remoteVaultFolderId: "FID", ...FRESH }));

		// CSRF nonce: 24 random bytes → 48 hex chars.
		expect(res.pendingFolderPickState).toMatch(/^[0-9a-f]{48}$/);

		expect(openSpy).toHaveBeenCalledTimes(1);
		const url = String(openSpy.mock.calls[0]![0]);
		const hashIndex = url.indexOf("#");
		const query = url.slice(0, hashIndex);
		const fragment = url.slice(hashIndex + 1);
		// The access token rides the fragment (never the query → never sent to the relay host).
		expect(fragment).toBe("token=AT");
		expect(query).toContain(`state=${String(res.pendingFolderPickState)}`);
		// The public, referrer-restricted Picker API key is supplied by the plugin (the
		// host page falls back to its embedded copy only when this is absent).
		expect(query).toMatch(/&apiKey=AIza[A-Za-z0-9_-]+/);
		expect(query).not.toContain("token");
		expect(query.startsWith("https://airsync.takezo.dev/googledrive-folder?")).toBe(true);
	});

	it("opens the picker after auth even before any folder is bound", async () => {
		// The picker is how the first folder gets bound, so auth alone must suffice —
		// no remoteVaultFolderId required.
		const openSpy = vi.fn();
		vi.stubGlobal("window", { open: openSpy, location: { href: "" } });
		const { provider } = await makeProvider(CONNECTED);

		const res = await provider.startWebFolderPick(settingsWith({ ...FRESH }));

		expect(res.pendingFolderPickState).toMatch(/^[0-9a-f]{48}$/);
		expect(openSpy).toHaveBeenCalledTimes(1);
	});

	it("refuses to open the picker when not authenticated", async () => {
		const openSpy = vi.fn();
		vi.stubGlobal("window", { open: openSpy, location: { href: "" } });
		const { provider } = await makeProvider({});
		await expect(provider.startWebFolderPick(settingsWith({}))).rejects.toThrow(/Connect to Google Drive/);
		expect(openSpy).not.toHaveBeenCalled();
	});
});

describe("GoogleDriveProvider.picker (capability accessor)", () => {
	it("exposes the folder-pick flow via provider.picker — the path BackendManager uses", async () => {
		// BackendManager reaches the flow through `provider.picker?.…`, never the methods
		// at the provider root. The other tests call them directly on the concrete class,
		// so this is the only coverage that the `get picker()` accessor itself is wired up.
		const { provider } = await makeProvider(CONNECTED);
		expect(provider.picker).toBeDefined();
		expect(typeof provider.picker?.startWebFolderPick).toBe("function");
		expect(typeof provider.picker?.completeWebFolderPick).toBe("function");
	});
});

describe("GoogleDriveProvider.completeWebFolderPick", () => {
	const PENDING = { pendingFolderPickState: "STATE-1", ...FRESH };

	it("binds a folder reachable under the granted scope and clears the state", async () => {
		const spy = (await spyRequestUrl()).mockResolvedValue(
			mockRes({ id: "FID", name: "MyVault", mimeType: FOLDER_MIME }),
		);
		const { provider } = await makeProvider(CONNECTED);
		const res = await provider.completeWebFolderPick(
			{ id: "FID", name: "MyVault", state: "STATE-1" },
			settingsWith(PENDING),
		);

		expect(res.backendUpdates).toMatchObject({
			remoteVaultFolderId: "FID",
			pendingFolderPickState: "",
		});
		// Binding is pure validate — it must not create .airsync metadata (no upload/create).
		const writes = spy.mock.calls.filter((c) => {
			const opts = c[0] as { method?: string };
			return typeof opts === "object" && opts.method && opts.method !== "GET";
		});
		expect(writes.length).toBe(0);
	});

	it("rejects a CSRF state mismatch before any network call", async () => {
		const spy = await spyRequestUrl();
		const { provider } = await makeProvider(CONNECTED);
		await expect(
			provider.completeWebFolderPick({ id: "FID", state: "WRONG" }, settingsWith(PENDING)),
		).rejects.toThrow(/State mismatch/);
		expect(spy).not.toHaveBeenCalled();
	});

	it("explains an inaccessible folder (getFile 404) by asking the user to re-pick", async () => {
		(await spyRequestUrl()).mockRejectedValue(Object.assign(new Error("not found"), { status: 404 }));
		const { provider } = await makeProvider(CONNECTED);
		await expect(
			provider.completeWebFolderPick({ id: "FID", state: "STATE-1" }, settingsWith(PENDING)),
		).rejects.toThrow(/Re-pick it in the Google Picker/);
	});

	it("explains an inaccessible folder (getFile 403) by asking the user to re-pick", async () => {
		(await spyRequestUrl()).mockRejectedValue(Object.assign(new Error("forbidden"), { status: 403 }));
		const { provider } = await makeProvider(CONNECTED);
		await expect(
			provider.completeWebFolderPick({ id: "FID", state: "STATE-1" }, settingsWith(PENDING)),
		).rejects.toThrow(/Re-pick it in the Google Picker/);
	});

	it("rethrows a transient/server error instead of the re-pick message", async () => {
		// A 500 must surface as itself, not be misreported as a scope/grant problem
		// (which would send the user re-picking a perfectly valid folder).
		(await spyRequestUrl()).mockRejectedValue(Object.assign(new Error("server"), { status: 500 }));
		const { provider } = await makeProvider(CONNECTED);
		const call = provider.completeWebFolderPick({ id: "FID", state: "STATE-1" }, settingsWith(PENDING));
		await expect(call).rejects.toThrow(/getFile failed|server/);
		await expect(call).rejects.not.toThrow(/Re-pick it/);
	});

	it("rejects when the selected item is a file, not a folder", async () => {
		(await spyRequestUrl()).mockResolvedValue(
			mockRes({ id: "FID", name: "note.pdf", mimeType: "application/pdf" }),
		);
		const { provider } = await makeProvider(CONNECTED);
		await expect(
			provider.completeWebFolderPick({ id: "FID", state: "STATE-1" }, settingsWith(PENDING)),
		).rejects.toThrow(/select a folder/);
	});

	it("rejects when no folder id is provided", async () => {
		const spy = await spyRequestUrl();
		const { provider } = await makeProvider(CONNECTED);
		await expect(
			provider.completeWebFolderPick({ state: "STATE-1" }, settingsWith(PENDING)),
		).rejects.toThrow(/No folder/);
		expect(spy).not.toHaveBeenCalled();
	});

	it("rejects a folder id with URL-unsafe characters before any network call", async () => {
		// A crafted deep link could otherwise inject query/path segments into the getFile URL.
		const spy = await spyRequestUrl();
		const { provider } = await makeProvider(CONNECTED);
		await expect(
			provider.completeWebFolderPick(
				{ id: "FID?supportsAllDrives=true", state: "STATE-1" },
				settingsWith(PENDING),
			),
		).rejects.toThrow(/Invalid folder id/);
		expect(spy).not.toHaveBeenCalled();
	});
});

describe("GoogleDriveProvider detached auth refresh-token rotation", () => {
	const expiredData = {
		remoteVaultFolderId: "FID",
		accessTokenExpiry: 0, // expired → the detached auth must refresh
		pendingAuthState: "",
		pendingFolderPickState: "",
	};

	it("persists a rotated refresh token from a detached refresh to SecretStorage", async () => {
		const { provider, store } = await makeProvider(CONNECTED); // stored RT/AT
		const detached = provider.auth.createDetachedGoogleAuth(expiredData);
		detached.setTokens("RT", "AT", 0); // seeded from the stored (now-expired) tokens

		// The refresh endpoint rotates the refresh token (returns a NEW one).
		(await spyRequestUrl()).mockResolvedValue(
			mockRes({ access_token: "AT2", refresh_token: "RT2", expires_in: 3600, token_type: "Bearer" }),
		);

		const token = await detached.getAccessToken(false);

		expect(token).toBe("AT2");
		// The rotated refresh token was persisted — not discarded with the throwaway
		// instance, which would have left the stored token stale.
		expect(store.getSecret("air-sync-googledrive-refresh-token")).toBe("RT2");
	});

	it("leaves the stored refresh token untouched when the provider does not rotate it", async () => {
		const { provider, store } = await makeProvider(CONNECTED);
		const detached = provider.auth.createDetachedGoogleAuth(expiredData);
		detached.setTokens("RT", "AT", 0);

		// A normal refresh returns only a new access token (no refresh_token).
		(await spyRequestUrl()).mockResolvedValue(
			mockRes({ access_token: "AT2", expires_in: 3600, token_type: "Bearer" }),
		);

		await detached.getAccessToken(false);

		expect(store.getSecret("air-sync-googledrive-refresh-token")).toBe("RT");
	});
});

describe("GoogleDriveProvider.getRemoteVaultDisplayPath", () => {
	/** Route getFile(id) responses by the folder id in the request URL. Missing ids 404. */
	function routeGetFile(byId: Record<string, { name: string; parents?: string[] }>) {
		return (req: unknown) => {
			const url = typeof req === "string" ? req : (req as { url: string }).url;
			const m = url.match(/\/files\/([^?]+)/);
			const id = m ? decodeURIComponent(m[1]!) : "";
			const f = byId[id];
			if (!f) return Promise.reject(Object.assign(new Error("Not Found"), { status: 404 }));
			return Promise.resolve(mockRes({ id, name: f.name, mimeType: FOLDER_MIME, parents: f.parents }));
		};
	}

	it("resolves a nested folder path by walking the parent chain up to My Drive", async () => {
		(await spyRequestUrl()).mockImplementation(
			routeGetFile({
				root: { name: "My Drive" }, // getFile("root") resolves the root id
				FID: { name: "Notes", parents: ["P1"] },
				P1: { name: "Projects", parents: ["P2"] },
				P2: { name: "Work", parents: ["root"] },
			}),
		);
		const { provider } = await makeProvider(CONNECTED);
		const path = await provider.getRemoteVaultDisplayPath(
			settingsWith({ remoteVaultFolderId: "FID", ...FRESH }),
		);
		expect(path).toBe("Work/Projects/Notes"); // root reached cleanly → no marker
	});

	it("returns a clean path (no marker) for a folder directly under My Drive", async () => {
		(await spyRequestUrl()).mockImplementation(
			routeGetFile({
				root: { name: "My Drive" },
				FID: { name: "test", parents: ["AS"] },
				AS: { name: "obsidian-air-sync", parents: ["root"] },
			}),
		);
		const { provider } = await makeProvider(CONNECTED);
		const path = await provider.getRemoteVaultDisplayPath(
			settingsWith({ remoteVaultFolderId: "FID", ...FRESH }),
		);
		expect(path).toBe("obsidian-air-sync/test");
	});

	it("marks the path partial with a leading …/ only when a non-root ancestor is unreadable", async () => {
		// Root is resolvable, so a 404 on a different ancestor is genuine truncation.
		(await spyRequestUrl()).mockImplementation(
			routeGetFile({
				root: { name: "My Drive" },
				FID: { name: "Notes", parents: ["P1"] }, // P1 not granted → 404
			}),
		);
		const { provider } = await makeProvider(CONNECTED);
		const path = await provider.getRemoteVaultDisplayPath(
			settingsWith({ remoteVaultFolderId: "FID", ...FRESH }),
		);
		expect(path).toBe("…/Notes");
	});

	it("omits the marker when the root can't be identified (can't distinguish root from a real ancestor)", async () => {
		// getFile("root") 404s → we can't tell root from an ungranted ancestor, so we
		// show the clean partial path rather than a misleading marker.
		(await spyRequestUrl()).mockImplementation(
			routeGetFile({ FID: { name: "Notes", parents: ["P1"] } }),
		);
		const { provider } = await makeProvider(CONNECTED);
		const path = await provider.getRemoteVaultDisplayPath(
			settingsWith({ remoteVaultFolderId: "FID", ...FRESH }),
		);
		expect(path).toBe("Notes");
	});

	it("returns null when no folder is bound, without a network call", async () => {
		const spy = await spyRequestUrl();
		const { provider } = await makeProvider(CONNECTED);
		expect(await provider.getRemoteVaultDisplayPath(settingsWith({}))).toBeNull();
		expect(spy).not.toHaveBeenCalled();
	});
});
