import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../settings";
import { GoogleDriveProvider } from "./googledrive/provider";
import { GoogleDriveCustomProvider } from "./googledrive/provider-custom";
import { DropboxProvider } from "./dropbox/provider";
import { DropboxCustomProvider } from "./dropbox/provider-custom";
import { OneDriveProvider } from "./onedrive/provider";
import { OneDriveCustomProvider } from "./onedrive/provider-custom";
import { createMockSecretStore, mockRes, spyRequestUrl } from "./googledrive/test-helpers.test";
import { getBackendSecret, setBackendSecret } from "./token-store";

vi.mock("obsidian");
afterEach(() => vi.restoreAllMocks());

const providerClasses = [
	GoogleDriveProvider, GoogleDriveCustomProvider,
	DropboxProvider, DropboxCustomProvider,
	OneDriveProvider, OneDriveCustomProvider,
].map((Provider) => ({
	name: Provider.name,
	Provider,
	revokes: Provider !== OneDriveProvider && Provider !== OneDriveCustomProvider,
}));

describe("OAuth disconnect vault-local secret isolation", () => {
	it.each(providerClasses)("$name clears only B's local secrets and follows its current revocation contract", async ({ Provider, revokes }) => {
		// Obsidian SecretStorage is vault-keyed: two stores model the actual host boundary.
		// Equal token values deliberately cover vaults sharing the same provider grant.
		const storeA = createMockSecretStore();
		const storeB = createMockSecretStore();
		const providerA = new Provider(storeA);
		const providerB = new Provider(storeB);
		for (const store of [storeA, storeB]) {
			setBackendSecret(store, providerB.type, "refresh", "shared-refresh");
			setBackendSecret(store, providerB.type, "access", "shared-access");
		}
		const backendData = {
			remoteVaultFolderId: "folder-b", accessTokenExpiry: Date.now() + 3_600_000,
			pendingAuthState: "", pendingFolderPickState: "", customClientId: "client-ref",
			customClientSecret: "secret-ref", customAuthority: "consumers",
		};
		const auth = "getOrCreateGoogleAuth" in providerB.auth
			? providerB.auth.getOrCreateGoogleAuth(backendData)
			: providerB.auth.getOrCreateAuth(backendData);
		auth.setTokens("shared-refresh", "shared-access", backendData.accessTokenExpiry);
		const request = await spyRequestUrl();
		request.mockResolvedValue(mockRes({}));

		await providerB.disconnect({ ...DEFAULT_SETTINGS, vaultId: "vault-b", backendType: providerB.type, backendData });
		expect(providerB.auth.isAuthenticated(backendData)).toBe(false);
		expect(getBackendSecret(storeB, providerB.type, "access")).toBe("");
		expect(providerA.auth.isAuthenticated(backendData)).toBe(true);
		expect(getBackendSecret(storeA, providerA.type, "refresh")).toBe("shared-refresh");
		// This characterizes the existing contract; it does not simulate the provider
		// grant or prove whether a subsequent operation from vault A succeeds.
		expect(request).toHaveBeenCalledTimes(revokes ? 1 : 0);
	});

	it("built-in Google disconnect leaves another vault's custom OAuth secrets intact", async () => {
		const storeA = createMockSecretStore();
		const storeB = createMockSecretStore();
		const custom = new GoogleDriveCustomProvider(storeA);
		const builtin = new GoogleDriveProvider(storeB);
		setBackendSecret(storeA, custom.type, "refresh", "custom-refresh");
		setBackendSecret(storeB, builtin.type, "refresh", "builtin-refresh");

		await builtin.disconnect({ ...DEFAULT_SETTINGS, vaultId: "vault-b" });

		expect(custom.auth.isAuthenticated({})).toBe(true);
		expect(getBackendSecret(storeA, custom.type, "refresh")).toBe("custom-refresh");
	});
});
