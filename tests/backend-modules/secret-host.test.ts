import { describe, expect, it } from "vitest";
import { createSecretHost, defaultPhysicalKey } from "../../src/fs/modules/secret-host";
import type { ISecretStore } from "../../src/fs/secret-store";

interface MemoryStore extends ISecretStore {
	readonly map: Map<string, string>;
	dropWrites: boolean;
}

function memoryStore(): MemoryStore {
	return {
		map: new Map(),
		dropWrites: false,
		getSecret(key) {
			return this.map.get(key) ?? null;
		},
		setSecret(key, value) {
			if (this.dropWrites) return;
			this.map.set(key, value);
		},
	};
}

describe("createSecretHost durable publication", () => {
	it("writes a value under the stable physical key and reads it back", async () => {
		const store = memoryStore();
		const secrets = createSecretHost(store, "dropbox");

		await secrets.set("refresh", "RT");

		expect(store.map.get(defaultPhysicalKey("dropbox", "refresh"))).toBe("RT");
		expect(await secrets.get("refresh")).toBe("RT");
	});

	it("fails closed when the non-empty write cannot be read back", async () => {
		const store = memoryStore();
		store.dropWrites = true;
		const secrets = createSecretHost(store, "dropbox");

		await expect(secrets.set("refresh", "RT")).rejects.toThrow(
			"Secret credential could not be saved securely",
		);
		// The host exposes nothing: no partial success, no stored value.
		expect(await secrets.get("refresh")).toBeNull();
	});

	it("fails closed when the write reads back a stale non-empty value", async () => {
		const store = memoryStore();
		const key = defaultPhysicalKey("dropbox", "refresh");
		store.map.set(key, "STALE");
		store.dropWrites = true;
		const secrets = createSecretHost(store, "dropbox");

		// Presence-only readback would accept this (the key is non-empty); exact
		// readback must reject because the candidate was not published.
		await expect(secrets.set("refresh", "FRESH")).rejects.toThrow(
			"Secret credential could not be saved securely",
		);
		expect(await secrets.get("refresh")).toBe("STALE");
	});

	it("does not require readback for an empty (delete) write", async () => {
		const store = memoryStore();
		const secrets = createSecretHost(store, "dropbox");
		store.map.set(defaultPhysicalKey("dropbox", "refresh"), "old");

		await secrets.delete("refresh");

		expect(store.map.get(defaultPhysicalKey("dropbox", "refresh"))).toBe("");
	});
});
