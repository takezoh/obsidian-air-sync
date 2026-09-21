import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockSecretStore, mockRes, spyRequestUrl, testTransport } from "./test-helpers";
import { DEFAULT_ONEDRIVE_AUTHORITY, OneDriveAuthProvider } from "./auth";
import { ONEDRIVE_AUTH } from "../auth-config";

vi.mock("obsidian");
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const pending = {
	pendingAuthState: "audit-state",
	pendingCodeVerifier: "audit-verifier",
};
const callback = "obsidian://air-sync-auth?code=audit-code&state=audit-state";

describe.each([["onedrive", OneDriveAuthProvider]] as const)("%s durable completion audit", (type, Provider) => {
	const attempt = {
		...pending,
		pendingAuthIdentity: {
			backendType: type,
			clientId: ONEDRIVE_AUTH.clientId,
			authority: DEFAULT_ONEDRIVE_AUTHORITY,
		},
	};
	function setup(existing = "") {
		const store = createMockSecretStore(
			existing ? { [`air-sync-${type}-refresh-token`]: existing } : {},
		);
		return { store, auth: new Provider(store, testTransport()) };
	}

	it("rejects initial completion when the response omits a durable refresh credential", async () => {
		(await spyRequestUrl()).mockResolvedValue(mockRes({ access_token: "new-access", expires_in: 3600 }));
		const { auth } = setup();
		await expect(auth.completeAuth(callback, attempt)).rejects.toThrow();
		expect(auth.isAuthenticated(attempt)).toBe(false);
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
		await expect(auth.completeAuth(callback, attempt)).rejects.toThrow();
		expect(auth.isAuthenticated(attempt)).toBe(false);
	});

	it("preserves a stored refresh credential when the response omits its replacement", async () => {
		(await spyRequestUrl()).mockResolvedValue(mockRes({ access_token: "new-access", expires_in: 3600 }));
		const { auth, store } = setup("existing-refresh");
		await auth.completeAuth(callback, attempt);
		expect(store.getSecret(`air-sync-${type}-refresh-token`)).toBe("existing-refresh");
		expect(auth.isAuthenticated(attempt)).toBe(true);
	});

	it("completes normally when a fresh refresh credential is readable", async () => {
		(await spyRequestUrl()).mockResolvedValue(mockRes({
			access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600,
		}));
		const { auth, store } = setup();
		const result = await auth.completeAuth(callback, attempt);
		expect(store.getSecret(`air-sync-${type}-refresh-token`)).toBe("new-refresh");
		expect(auth.isAuthenticated(attempt)).toBe(true);
		expect(result.pendingAuthState).toBe("");
	});
});
