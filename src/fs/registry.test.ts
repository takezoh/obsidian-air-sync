import { describe, it, expect, beforeAll, vi } from "vitest";
import { initRegistry, getAllBackendProviders } from "./registry";
import type { ISecretStore } from "./secret-store";
import type { AirSyncSettings } from "../settings";
import type { App } from "obsidian";
import type { Logger } from "../logging/logger";
import { ManagedRemoteFs } from "./managed/managed-remote-fs";
import { MANAGED_REMOTE_BACKEND_FAMILIES } from "../../tests/fs/contracts/remote-backend-family";

vi.mock("obsidian");

// A secret store that satisfies every module's token lookup, so each provider's
// `isConnected`/`prepare` can build its managed FS.
const connectedSecretStore: ISecretStore = {
	getSecret: (id: string) =>
		id.includes("refresh") ? "RT" : id.includes("access") ? "AT" : null,
	setSecret: () => {},
};

function connectedSettings(): AirSyncSettings {
	return {
		vaultId: "vault-1",
		backendType: "googledrive",
		backendData: { remoteVaultFolderId: "FID", authMode: "default" },
	} as unknown as AirSyncSettings;
}

const mockApp = {} as App;
const platform = { mobile: false };
const settings = connectedSettings();

describe("backend module registry composition", () => {
	beforeAll(() => {
		initRegistry(connectedSecretStore, {
			getSettings: () => settings,
			saveSettings: () => Promise.resolve(),
			getApp: () => mockApp,
			getLogger: () => ({}) as unknown as Logger,
			getVaultName: () => "Vault",
			platform,
			sink: () => undefined,
		});
	});

	it("registers exactly the three canonical module ids and no legacy alias", () => {
		const types = getAllBackendProviders().map((p) => p.type).sort();
		expect(types).toEqual([...MANAGED_REMOTE_BACKEND_FAMILIES].sort());
		for (const alias of ["googledrive-custom", "onedrive-custom", "dropbox-custom"]) {
			expect(getAllBackendProviders().some((p) => p.type === alias)).toBe(false);
		}
	});

	// The FS-side incremental checkpoint (`fs.checkpoint`) and the provider-side
	// `clearCheckpointStore` are two halves of one durable store: the live FS clears it
	// via resetCheckpoint, but the disconnect/switch path with NO live FS (expired auth)
	// falls back to `provider.clearCheckpointStore(settings)`. They live on different
	// types joined only at runtime, so TS can't enforce that a checkpoint-bearing
	// backend also ships the by-key clear. Pin it here.
	it("a module provider ships clearCheckpointStore iff its FS carries a checkpoint", async () => {
		const providers = getAllBackendProviders();
		expect(providers.length).toBe(MANAGED_REMOTE_BACKEND_FAMILIES.length);

		for (const provider of providers) {
			expect(provider.isConnected(settings), `isConnected false for "${provider.type}"`).toBe(true);
			await provider.prepare?.(mockApp, settings, undefined);
			const fs = provider.createFs(mockApp, settings, undefined);
			expect(fs, `createFs returned null for "${provider.type}"`).toBeInstanceOf(ManagedRemoteFs);

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

	it("maps every provider to a managed contract family through ManagedRemoteFs", async () => {
		for (const provider of getAllBackendProviders()) {
			expect(MANAGED_REMOTE_BACKEND_FAMILIES).toContain(
				provider.type as (typeof MANAGED_REMOTE_BACKEND_FAMILIES)[number],
			);
			await provider.prepare?.(mockApp, settings, undefined);
			const fs = provider.createFs(mockApp, settings, undefined);
			expect(
				fs && fs instanceof ManagedRemoteFs,
				`Backend "${provider.type}" does not expose the managed remote filesystem`,
			).toBe(true);
			void fs?.close?.();
		}
	});

});
