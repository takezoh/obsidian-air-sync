import { describe, it, expect } from "vitest";
import { createMockSecretStore } from "./googledrive/test-helpers.test";
import {
	setBackendSecret,
	publishBackendSecret,
	getBackendSecret,
	hasBackendSecret,
	clearBackendSecrets,
} from "./token-store";

describe("backend secret store", () => {
	it("stores and reads a named secret", () => {
		const store = createMockSecretStore();
		setBackendSecret(store, "pcloud", "access", "tok");
		expect(getBackendSecret(store, "pcloud", "access")).toBe("tok");
	});

	it("returns '' for an absent secret", () => {
		const store = createMockSecretStore();
		expect(getBackendSecret(store, "pcloud", "access")).toBe("");
	});

	it("reports presence via hasBackendSecret", () => {
		const store = createMockSecretStore();
		expect(hasBackendSecret(store, "pcloud", "access")).toBe(false);
		setBackendSecret(store, "pcloud", "access", "tok");
		expect(hasBackendSecret(store, "pcloud", "access")).toBe(true);
	});

	it("skips empty values (use clear to remove)", () => {
		const store = createMockSecretStore();
		setBackendSecret(store, "pcloud", "access", "");
		expect(hasBackendSecret(store, "pcloud", "access")).toBe(false);
	});

	it("clears the named secrets", () => {
		const store = createMockSecretStore();
		setBackendSecret(store, "googledrive", "refresh", "r");
		setBackendSecret(store, "googledrive", "access", "a");
		clearBackendSecrets(store, "googledrive", ["refresh", "access"]);
		expect(hasBackendSecret(store, "googledrive", "refresh")).toBe(false);
		expect(getBackendSecret(store, "googledrive", "access")).toBe("");
	});

	it("uses the stable air-sync-<type>-<name>-token key (backward compatible)", () => {
		// A secret written by an earlier version must remain readable.
		const store = createMockSecretStore({ "air-sync-googledrive-refresh-token": "legacy" });
		expect(getBackendSecret(store, "googledrive", "refresh")).toBe("legacy");
		expect(hasBackendSecret(store, "googledrive", "refresh")).toBe(true);
	});

	it("publishes a required secret only after exact immediate readback", () => {
		const store = createMockSecretStore();
		publishBackendSecret(store, "dropbox", "refresh", "candidate");
		expect(getBackendSecret(store, "dropbox", "refresh")).toBe("candidate");
	});

	it.each(["", "stale"])("fails when required publication reads back %j", (readback) => {
		const store = createMockSecretStore();
		store.getSecret = () => readback || null;
		expect(() => publishBackendSecret(store, "dropbox", "refresh", "candidate"))
			.toThrow("Secret credential could not be saved securely");
	});

	it("fails with bounded text when SecretStorage throws", () => {
		const store = createMockSecretStore();
		store.setSecret = () => { throw new Error("secret sentinel"); };
		expect(() => publishBackendSecret(store, "dropbox", "refresh", "candidate"))
			.toThrow("Secret credential could not be saved securely. Please try connecting again.");
	});

	it("rejects an empty required candidate", () => {
		const store = createMockSecretStore();
		expect(() => publishBackendSecret(store, "dropbox", "refresh", ""))
			.toThrow("Required refresh token is missing");
	});
});
