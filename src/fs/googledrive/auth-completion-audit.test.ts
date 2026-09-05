import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockSecretStore, mockRes, spyRequestUrl } from "./test-helpers.test";
import { GoogleDriveCustomAuthProvider } from "./provider-custom";
import { GoogleDriveProvider } from "./provider";

vi.mock("obsidian");
afterEach(() => { vi.restoreAllMocks(); });

const pending = {
	pendingAuthState: "audit-state",
	pendingCodeVerifier: "audit-verifier",
	customClientId: "audit-client",
	customClientSecret: "audit-secret",
	customAuthority: "consumers",
};
const callback = "obsidian://air-sync-auth?code=audit-code&state=audit-state";

describe.each([["googledrive-custom", GoogleDriveCustomAuthProvider]] as const)("%s durable completion audit", (type, Provider) => {
	function setup(existing = "") {
		const store = createMockSecretStore({
			"audit-client": "client-value",
			"audit-secret": "secret-value",
			...(existing ? { [`air-sync-${type}-refresh-token`]: existing } : {}),
		});
		return { store, auth: new Provider(store) };
	}

	it("rejects initial completion when the response omits a durable refresh credential", async () => {
		(await spyRequestUrl()).mockResolvedValue(mockRes({ access_token: "new-access", expires_in: 3600 }));
		const { auth } = setup();
		await expect(auth.completeAuth(callback, pending)).rejects.toThrow();
		expect(auth.isAuthenticated(pending)).toBe(false);
	});

	it("rejects completion when the fresh refresh write cannot be read back", async () => {
		(await spyRequestUrl()).mockResolvedValue(mockRes({
			access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600,
		}));
		const { auth, store } = setup();
		const original = store.setSecret.bind(store);
		vi.spyOn(store, "setSecret").mockImplementation((key, value) => {
			if (key !== `air-sync-${type}-refresh-token`) original(key, value);
		});
		await expect(auth.completeAuth(callback, pending)).rejects.toThrow();
		expect(auth.isAuthenticated(pending)).toBe(false);
	});

	it("preserves a stored refresh credential when the response omits its replacement", async () => {
		(await spyRequestUrl()).mockResolvedValue(mockRes({ access_token: "new-access", expires_in: 3600 }));
		const { auth, store } = setup("existing-refresh");
		await auth.completeAuth(callback, pending);
		expect(store.getSecret(`air-sync-${type}-refresh-token`)).toBe("existing-refresh");
		expect(auth.isAuthenticated(pending)).toBe(true);
	});

	it("completes normally when a fresh refresh credential is readable", async () => {
		(await spyRequestUrl()).mockResolvedValue(mockRes({
			access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600,
		}));
		const { auth, store } = setup();
		const result = await auth.completeAuth(callback, pending);
		expect(store.getSecret(`air-sync-${type}-refresh-token`)).toBe("new-refresh");
		expect(auth.isAuthenticated(pending)).toBe(true);
		expect(result.pendingAuthState).toBe("");
	});
});

describe("Google Drive rotating refresh publication audit", () => {
	const oldSecrets = {
		"air-sync-googledrive-refresh-token": "old-refresh",
		"air-sync-googledrive-access-token": "old-access",
	};
	const rotated = {
		access_token: "new-access",
		refresh_token: "new-refresh",
		expires_in: 3600,
		token_type: "Bearer",
	};

	function dropRefreshWrites(store: ReturnType<typeof createMockSecretStore>): void {
		const original = store.setSecret.bind(store);
		vi.spyOn(store, "setSecret").mockImplementation((key, value) => {
			if (key !== "air-sync-googledrive-refresh-token") original(key, value);
		});
	}

	it("does not lose a rotated refresh token at shared-cycle publication", async () => {
		(await spyRequestUrl()).mockResolvedValue(mockRes(rotated));
		const store = createMockSecretStore(oldSecrets);
		const provider = new GoogleDriveProvider(store);
		const shared = provider.auth.getOrCreateGoogleAuth({} as never);
		shared.setTokens("old-refresh", "old-access", 0);
		dropRefreshWrites(store);

		await expect(shared.getAccessToken()).rejects.toThrow("Secret credential could not be saved securely");
		provider.readBackendState();

		expect(store.getSecret("air-sync-googledrive-refresh-token")).toBe("old-refresh");
		expect(shared.getTokenState()).toMatchObject({ refreshToken: "old-refresh", accessToken: "old-access" });
		await expect(shared.getAccessToken()).rejects.toThrow("Secret credential could not be saved securely");
	});

	it("does not lose a rotated refresh token from a detached manager", async () => {
		(await spyRequestUrl()).mockResolvedValue(mockRes(rotated));
		const store = createMockSecretStore(oldSecrets);
		const provider = new GoogleDriveProvider(store);
		const detached = provider.auth.createDetachedGoogleAuth({} as never);
		detached.setTokens("old-refresh", "old-access", 0);
		dropRefreshWrites(store);

		await expect(detached.getAccessToken()).rejects.toThrow("Secret credential could not be saved securely");

		expect(store.getSecret("air-sync-googledrive-refresh-token")).toBe("old-refresh");
		expect(detached.getTokenState()).toMatchObject({ refreshToken: "old-refresh", accessToken: "old-access" });
	});
});
