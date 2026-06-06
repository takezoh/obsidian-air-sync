import { describe, it, expect, vi } from "vitest";
import { createMockSecretStore } from "./test-helpers";

vi.mock("obsidian");

async function makeAuth(secrets: Record<string, string> = {}) {
	const { PCloudAuthProvider } = await import("./auth");
	const store = createMockSecretStore(secrets);
	return { auth: new PCloudAuthProvider(store), store };
}

describe("PCloudAuthProvider.isAuthenticated", () => {
	it("is true only when an access secret is stored", async () => {
		const { auth } = await makeAuth();
		expect(auth.isAuthenticated({})).toBe(false);
		const { auth: auth2 } = await makeAuth({ "air-sync-pcloud-access-token": "TOK" });
		expect(auth2.isAuthenticated({})).toBe(true);
	});
});

describe("PCloudAuthProvider.completeAuth", () => {
	it("verifies CSRF state, stores the token, and returns the region host", async () => {
		const { auth, store } = await makeAuth();
		const url = "obsidian://air-sync-auth?access_token=TOK&hostname=eapi.pcloud.com&state=abc";
		const out = await auth.completeAuth(url, { pendingAuthState: "abc" });
		expect(out).toEqual({ apiHost: "eapi.pcloud.com", pendingAuthState: "" });
		expect(store.getSecret("air-sync-pcloud-access-token")).toBe("TOK");
	});

	it("rejects on a state mismatch (CSRF)", async () => {
		const { auth } = await makeAuth();
		const url = "obsidian://air-sync-auth?access_token=TOK&hostname=api.pcloud.com&state=evil";
		await expect(auth.completeAuth(url, { pendingAuthState: "abc" })).rejects.toThrow("State mismatch");
	});

	it("rejects when no pending state was set", async () => {
		const { auth } = await makeAuth();
		const url = "obsidian://air-sync-auth?access_token=TOK&hostname=api.pcloud.com&state=abc";
		await expect(auth.completeAuth(url, {})).rejects.toThrow("State mismatch");
	});

	it("rejects when access_token is missing", async () => {
		const { auth } = await makeAuth();
		await expect(
			auth.completeAuth("obsidian://air-sync-auth?state=abc", { pendingAuthState: "abc" }),
		).rejects.toThrow("Missing access_token");
	});

	it("defaults the host to api.pcloud.com when absent", async () => {
		const { auth } = await makeAuth();
		const out = await auth.completeAuth("obsidian://air-sync-auth?access_token=T&state=abc", {
			pendingAuthState: "abc",
		});
		expect(out.apiHost).toBe("api.pcloud.com");
	});
});
