import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockSecretStore, mockRes, spyRequestUrl } from "./test-helpers";
import { DEFAULT_ONEDRIVE_AUTHORITY, OneDriveAuthProvider } from "./auth";
import { OneDriveCustomAuthProvider } from "./provider-custom";
import { ONEDRIVE_AUTH } from "../auth-config";

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

describe.each([["onedrive", OneDriveAuthProvider], ["onedrive-custom", OneDriveCustomAuthProvider]] as const)("%s durable completion audit", (type, Provider) => {
	const attempt = {
		...pending,
		pendingAuthIdentity: {
			backendType: type,
			clientId: type === "onedrive" ? ONEDRIVE_AUTH.clientId : pending.customClientId,
			authority: type === "onedrive" ? DEFAULT_ONEDRIVE_AUTHORITY : pending.customAuthority,
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

describe("OneDrive custom cached-manager identity audit", () => {
	const customPending = {
		...pending,
		pendingAuthIdentity: {
			backendType: "onedrive-custom",
			clientId: pending.customClientId,
			authority: pending.customAuthority,
		},
	};
	it("uses edited identity when the prior failure happened before manager creation", async () => {
		const request = (await spyRequestUrl()).mockResolvedValue(
			mockRes({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }),
		);
		const auth = new OneDriveCustomAuthProvider(createMockSecretStore());
		await expect(auth.completeAuth(
			"obsidian://air-sync-auth?code=audit-code&state=wrong-state",
			customPending,
		)).rejects.toThrow(/state mismatch/i);

		vi.stubGlobal("window", { open: vi.fn(), location: { href: "" } });
		const edited = { ...customPending, customClientId: "edited-client", customAuthority: "organizations" };
		const next = await auth.startAuth(edited);
		await auth.completeAuth(
			`obsidian://air-sync-auth?code=retry-code&state=${String(next.pendingAuthState)}`,
			{ ...edited, ...next },
		);

		const exchange = request.mock.calls[0]![0] as { url: string; body?: string };
		expect(exchange.url).toContain("/organizations/");
		expect(new URLSearchParams(exchange.body).get("client_id")).toBe("edited-client");
	});

	it("uses the edited client id and authority when retrying after a failed exchange created the manager", async () => {
		const request = await spyRequestUrl();
		request
			.mockResolvedValueOnce(mockRes({ error: "invalid_grant" }, { status: 400 }))
			.mockResolvedValueOnce(mockRes({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }));
		const store = createMockSecretStore();
		const auth = new OneDriveCustomAuthProvider(store);
		await expect(auth.completeAuth(callback, customPending)).rejects.toThrow();

		vi.stubGlobal("window", { open: vi.fn(), location: { href: "" } });
		const edited = { ...customPending, customClientId: "edited-client", customAuthority: "organizations" };
		const next = await auth.startAuth(edited);
		await auth.completeAuth(
			`obsidian://air-sync-auth?code=retry-code&state=${String(next.pendingAuthState)}`,
			{ ...edited, ...next },
		);

		const second = request.mock.calls[1]![0] as { url: string; body?: string };
		expect(second.url).toContain("/organizations/");
		expect(new URLSearchParams(second.body).get("client_id")).toBe("edited-client");
	});

	it("keeps the start-time client id and authority when settings change before callback", async () => {
		const request = (await spyRequestUrl()).mockResolvedValue(
			mockRes({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }),
		);
		vi.stubGlobal("window", { open: vi.fn(), location: { href: "" } });
		const auth = new OneDriveCustomAuthProvider(createMockSecretStore());
		const started = await auth.startAuth({ customClientId: "started-client", customAuthority: "common" });

		await auth.completeAuth(
			`obsidian://air-sync-auth?code=code&state=${String(started.pendingAuthState)}`,
			{ ...started, customClientId: "edited-client", customAuthority: "organizations" },
		);

		const exchange = request.mock.calls[0]![0] as { url: string; body?: string };
		expect(exchange.url).toContain("/common/");
		expect(new URLSearchParams(exchange.body).get("client_id")).toBe("started-client");
	});

	it("rejects a missing attempt identity before token exchange", async () => {
		const request = await spyRequestUrl();
		const auth = new OneDriveCustomAuthProvider(createMockSecretStore());
		await expect(auth.completeAuth(callback, pending)).rejects.toThrow(/attempt identity/i);
		expect(request).not.toHaveBeenCalled();
	});
});
