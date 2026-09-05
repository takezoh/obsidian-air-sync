import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockSecretStore, mockRes, spyRequestUrl } from "./test-helpers";
import { DropboxAuthProvider } from "./auth";
import { DropboxCustomAuthProvider } from "./provider-custom";
import { DropboxProvider } from "./provider";
import { DROPBOX_AUTH } from "../auth-config";

vi.mock("obsidian");
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const pending = {
	pendingAuthState: "audit-state",
	pendingCodeVerifier: "audit-verifier",
	customClientId: "audit-client",
	customClientSecret: "audit-secret",
	customAuthority: "consumers",
};
const callback = "obsidian://air-sync-auth?code=audit-code&state=audit-state";

describe.each([["dropbox", DropboxAuthProvider], ["dropbox-custom", DropboxCustomAuthProvider]] as const)("%s durable completion audit", (type, Provider) => {
	const attempt = {
		...pending,
		pendingAuthIdentity: {
			backendType: type,
			clientId: type === "dropbox" ? DROPBOX_AUTH.clientId : pending.customClientId,
		},
	};
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

describe("Dropbox rotating refresh publication audit", () => {
	const oldSecrets = {
		"air-sync-dropbox-refresh-token": "old-refresh",
		"air-sync-dropbox-access-token": "old-access",
	};
	const rotated = { access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 };

	function dropRefreshWrites(store: ReturnType<typeof createMockSecretStore>): void {
		const original = store.setSecret.bind(store);
		vi.spyOn(store, "setSecret").mockImplementation((key, value) => {
			if (key !== "air-sync-dropbox-refresh-token") original(key, value);
		});
	}

	it("does not lose a rotated refresh token at shared-cycle publication", async () => {
		(await spyRequestUrl()).mockResolvedValue(mockRes(rotated));
		const store = createMockSecretStore(oldSecrets);
		const provider = new DropboxProvider(store);
		const shared = provider.auth.getOrCreateAuth({});
		shared.setTokens("old-refresh", "old-access", 0);
		dropRefreshWrites(store);

		await expect(shared.getAccessToken()).rejects.toThrow("Secret credential could not be saved securely");
		provider.readBackendState();

		expect(store.getSecret("air-sync-dropbox-refresh-token")).toBe("old-refresh");
		expect(shared.getTokenState()).toMatchObject({ refreshToken: "old-refresh", accessToken: "old-access" });
		await expect(shared.getAccessToken()).rejects.toThrow("Secret credential could not be saved securely");
	});

	it("does not lose a rotated refresh token from a detached manager", async () => {
		(await spyRequestUrl()).mockResolvedValue(mockRes(rotated));
		const store = createMockSecretStore(oldSecrets);
		const auth = new DropboxAuthProvider(store, "audit-client");
		const detached = auth.createDetachedAuth({});
		detached.setTokens("old-refresh", "old-access", 0);
		dropRefreshWrites(store);

		await expect(detached.getAccessToken()).rejects.toThrow("Secret credential could not be saved securely");

		expect(store.getSecret("air-sync-dropbox-refresh-token")).toBe("old-refresh");
		expect(detached.getTokenState()).toMatchObject({ refreshToken: "old-refresh", accessToken: "old-access" });
	});
});

describe("Dropbox custom cached-manager identity audit", () => {
	const customPending = {
		...pending,
		pendingAuthIdentity: { backendType: "dropbox-custom", clientId: pending.customClientId },
	};
	it("uses the edited client id when the prior failure happened before manager creation", async () => {
		const request = (await spyRequestUrl()).mockResolvedValue(
			mockRes({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }),
		);
		const auth = new DropboxCustomAuthProvider(createMockSecretStore());
		await expect(auth.completeAuth(
			"obsidian://air-sync-auth?code=audit-code&state=wrong-state",
			customPending,
		)).rejects.toThrow(/state mismatch/i);

		vi.stubGlobal("window", { open: vi.fn(), location: { href: "" } });
		const edited = { ...customPending, customClientId: "edited-client" };
		const next = await auth.startAuth(edited);
		await auth.completeAuth(
			`obsidian://air-sync-auth?code=retry-code&state=${String(next.pendingAuthState)}`,
			{ ...edited, ...next },
		);

		const exchange = request.mock.calls[0]![0] as { body?: string };
		expect(new URLSearchParams(exchange.body).get("client_id")).toBe("edited-client");
	});

	it("uses the edited client id when retrying after a failed exchange created the manager", async () => {
		const request = await spyRequestUrl();
		request
			.mockResolvedValueOnce(mockRes({ error: "invalid_grant" }, { status: 400 }))
			.mockResolvedValueOnce(mockRes({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }));
		const store = createMockSecretStore();
		const auth = new DropboxCustomAuthProvider(store);
		await expect(auth.completeAuth(callback, customPending)).rejects.toThrow();

		vi.stubGlobal("window", { open: vi.fn(), location: { href: "" } });
		const edited = { ...customPending, customClientId: "edited-client" };
		const next = await auth.startAuth(edited);
		await auth.completeAuth(
			`obsidian://air-sync-auth?code=retry-code&state=${String(next.pendingAuthState)}`,
			{ ...edited, ...next },
		);

		const second = request.mock.calls[1]![0] as { body?: string };
		expect(new URLSearchParams(second.body).get("client_id")).toBe("edited-client");
	});

	it("keeps the start-time client id when settings change before callback", async () => {
		const request = (await spyRequestUrl()).mockResolvedValue(
			mockRes({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }),
		);
		vi.stubGlobal("window", { open: vi.fn(), location: { href: "" } });
		const auth = new DropboxCustomAuthProvider(createMockSecretStore());
		const started = await auth.startAuth({ customClientId: "started-client" });

		await auth.completeAuth(
			`obsidian://air-sync-auth?code=code&state=${String(started.pendingAuthState)}`,
			{ ...started, customClientId: "edited-client" },
		);

		const exchange = request.mock.calls[0]![0] as { body?: string };
		expect(new URLSearchParams(exchange.body).get("client_id")).toBe("started-client");
	});

	it("rejects a missing attempt identity before token exchange", async () => {
		const request = await spyRequestUrl();
		const auth = new DropboxCustomAuthProvider(createMockSecretStore());
		await expect(auth.completeAuth(callback, pending)).rejects.toThrow(/attempt identity/i);
		expect(request).not.toHaveBeenCalled();
	});
});
