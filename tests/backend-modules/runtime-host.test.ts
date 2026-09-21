import { describe, expect, it } from "vitest";
import { createRuntimeHost, redactSecrets } from "../../src/fs/modules/runtime-host";
import type { RuntimeLogLevel } from "../../src/fs/modules/runtime-host";
import type { BackendAuthHost } from "../../src/backend-api";
import type { ISecretStore } from "../../src/fs/secret-store";

interface MemoryStore extends ISecretStore {
	readonly map: Map<string, string>;
}

function memoryStore(initial: Record<string, string> = {}): MemoryStore {
	const map = new Map(Object.entries(initial));
	return {
		map,
		getSecret: (key) => map.get(key) ?? null,
		setSecret: (key, value) => {
			map.set(key, value);
		},
	};
}

const AUTH_HOST: BackendAuthHost = {
	openExternal: () => Promise.resolve(),
};

function host(moduleId: string, secrets: ISecretStore, sink?: (level: RuntimeLogLevel, message: string, id: string) => void) {
	return createRuntimeHost({
		moduleId,
		generation: 3,
		secrets,
		sink: sink ?? (() => undefined),
		auth: AUTH_HOST,
	});
}

describe("createRuntimeHost", () => {
	it("namespaces secrets per module using the existing physical key format", async () => {
		const store = memoryStore();
		const alpha = host("alpha", store);
		await alpha.context.secrets.set("access", "A");
		expect(store.map.get("air-sync-alpha-access-token")).toBe("A");

		const beta = host("beta", store);
		expect(await beta.context.secrets.get("access")).toBeNull();
		expect(await alpha.context.secrets.get("access")).toBe("A");
	});

	it("clears a secret by writing an empty value (SecretStorage has no delete)", async () => {
		const store = memoryStore({ "air-sync-alpha-access-token": "A" });
		const alpha = host("alpha", store);
		await alpha.context.secrets.delete("access");
		expect(store.map.get("air-sync-alpha-access-token")).toBe("");
	});

	it("attributes logs to the module and redacts credentials", () => {
		const seen: Array<{ level: string; message: string; id: string }> = [];
		const h = host("alpha", memoryStore(), (level, message, id) => {
			seen.push({ level, message, id });
		});
		h.context.logger.warn("failed at https://x.test/t?access_token=secret123&x=1 Bearer abc.def");
		expect(seen).toHaveLength(1);
		expect(seen[0]?.id).toBe("alpha");
		expect(seen[0]?.message).not.toContain("secret123");
		expect(seen[0]?.message).not.toContain("abc.def");
		expect(seen[0]?.message).toContain("access_token=[redacted]");
	});

	it("carries structured context to the sink so module-client error bodies survive", () => {
		const seen: Array<{ level: string; message: string; id: string }> = [];
		const h = host("alpha", memoryStore(), (level, message, id) => {
			seen.push({ level, message, id });
		});
		h.context.logger.error("Google Drive API returned an error response", {
			operation: "uploadFile",
			status: 403,
			body: '{"error":{"code":403}}',
		});
		expect(seen).toHaveLength(1);
		expect(seen[0]?.message).toContain("Google Drive API returned an error response");
		expect(seen[0]?.message).toContain('"status":403');
		expect(seen[0]?.message).toContain('"body"');
	});

	it("reports generation currency and disposes idempotently", async () => {
		const h = host("alpha", memoryStore());
		expect(h.isCurrent(3)).toBe(true);
		expect(h.isCurrent(2)).toBe(false);
		await h.dispose();
		expect(h.isCurrent(3)).toBe(false);
		await expect(h.dispose()).resolves.toBeUndefined();
	});

	it("exposes the http client without network I/O", () => {
		const h = host("alpha", memoryStore());
		expect(typeof h.context.http.request).toBe("function");
	});
});

describe("redactSecrets", () => {
	it("redacts bearer tokens and sensitive query parameters", () => {
		const redacted = redactSecrets("GET /x?code=abc&refresh_token=def Authorization: Bearer tok.en");
		expect(redacted).not.toContain("abc");
		expect(redacted).not.toContain("def");
		expect(redacted).not.toContain("tok.en");
	});
});
