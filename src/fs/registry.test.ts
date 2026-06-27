import { describe, it, expect, beforeAll, vi } from "vitest";
import { initRegistry, getAllBackendProviders } from "./registry";
import type { ISecretStore } from "./secret-store";
import type { AirSyncSettings } from "../settings";
import type { App } from "obsidian";

vi.mock("obsidian");

// A secret store that satisfies any backend's token lookup, so each provider's
// createFs() can build its FS for the pairing check below (createFs returns null
// without a refresh token).
const connectedSecretStore: ISecretStore = {
	getSecret: (id: string) =>
		id.includes("refresh") ? "RT" : id.includes("access") ? "AT" : null,
	setSecret: () => {},
};

// A "connected" settings: a bound folder + a future token expiry, plus custom-OAuth
// fields so the custom backend builds too. Generic enough for every Google Drive-family
// backend; extend it when a backend needs more to produce a non-null createFs().
function connectedSettings(): AirSyncSettings {
	return {
		vaultId: "vault-1",
		backendData: {
			remoteVaultFolderId: "FID",
			accessTokenExpiry: Date.now() + 3_600_000,
			customClientId: "CID",
			customClientSecret: "CS",
		},
	} as unknown as AirSyncSettings;
}

const mockApp = {} as App;

describe("backend registry ↔ checkpoint-store pairing", () => {
	beforeAll(() => {
		initRegistry(connectedSecretStore);
	});

	// The FS-side incremental checkpoint (`fs.checkpoint`) and the provider-side
	// `clearCheckpointStore` are two halves of one durable store: the live FS clears it
	// via resetCheckpoint, but the disconnect/switch path with NO live FS (expired auth)
	// falls back to `provider.clearCheckpointStore(settings)`. They live on different
	// types joined only at runtime (provider.createFs), so TS can't enforce that a
	// checkpoint-bearing backend also ships the by-key clear. Pin it here: a backend that
	// forgets clearCheckpointStore would silently orphan its store on a no-live-FS
	// disconnect, leaving a stale checkpoint to mislead a later reconnect.
	it("registers the built-in and custom-app variants of every backend", () => {
		const types = getAllBackendProviders().map((p) => p.type);
		expect(types).toEqual(
			expect.arrayContaining([
				"googledrive", "googledrive-custom",
				"onedrive", "onedrive-custom",
				"dropbox", "dropbox-custom",
			]),
		);
	});

	it("a backend ships clearCheckpointStore iff its FS carries a checkpoint", () => {
		const providers = getAllBackendProviders();
		expect(providers.length).toBeGreaterThan(0);

		for (const provider of providers) {
			const fs = provider.createFs(mockApp, connectedSettings(), undefined);
			expect(
				fs,
				`createFs returned null for "${provider.type}" — extend connectedSettings() ` +
					`so this backend builds an FS and the pairing can be checked.`,
			).not.toBeNull();

			const hasCheckpoint = !!fs?.checkpoint;
			const hasClear = !!provider.clearCheckpointStore;
			expect(
				hasClear,
				`Backend "${provider.type}": fs.checkpoint=${hasCheckpoint} but ` +
					`clearCheckpointStore=${hasClear}. A checkpoint-bearing backend MUST implement ` +
					`clearCheckpointStore (the no-live-FS disconnect clears the per-target store by ` +
					`key); a backend without a checkpoint must not declare it.`,
			).toBe(hasCheckpoint);

			void fs?.close?.();
		}
	});
});
