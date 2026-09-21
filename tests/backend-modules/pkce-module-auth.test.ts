import { describe, expect, it, vi } from "vitest";
import type {
	BackendHttpClient,
	BackendHttpResponse,
	BackendRuntimeContext,
	JsonObject,
	JsonValue,
} from "../../src/backend-api";
import { dropboxModule } from "../../src/backends/dropbox/module";
import { oneDriveModule } from "../../src/backends/onedrive/module";
import {
	ACCESS_SECRET,
	REFRESH_SECRET,
	buildPkceTokenGetter,
} from "../../src/backends/shared/pkce-module-auth";
import type { PkceModuleSpec, PkceTokenManager } from "../../src/backends/shared/pkce-module-auth";
import { DROPBOX_AUTH, ONEDRIVE_AUTH } from "../../src/backends/shared/auth-config";
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

interface CapturedRequest {
	url: string;
	method?: string;
	headers?: Readonly<Record<string, string>>;
	body?: ArrayBuffer | string;
}

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

function capturingHttp(body: unknown, requests: CapturedRequest[]): BackendHttpClient {
	const text = JSON.stringify(body);
	const bytes = new TextEncoder().encode(text);
	return {
		request: (req): Promise<BackendHttpResponse> => {
			requests.push({ url: req.url, method: req.method, headers: req.headers, body: req.body });
			return Promise.resolve({
				status: 200,
				headers: {},
				arrayBuffer: () => Promise.resolve(bytes.buffer),
				text: () => Promise.resolve(text),
				json: () => Promise.resolve(body as JsonValue),
			});
		},
	};
}

function contextFor(store: ISecretStore, requests: CapturedRequest[]): BackendRuntimeContext {
	return {
		http: capturingHttp({ access_token: "AT", refresh_token: "RT", expires_in: 3600 }, requests),
		secrets: createSecretHost(store, "dropbox"),
		logger: noopLogger,
		auth: { openExternal: () => Promise.resolve() },
	};
}

const CONFIG: JsonObject = {
	pendingAuthState: "state-1",
	pendingCodeVerifier: "verifier-1",
	remoteVaultFolderId: "folder-1",
};

const CALLBACK = "obsidian://air-sync-auth?code=THECODE&state=state-1";

function formOf(request: CapturedRequest): URLSearchParams {
	const body = request.body;
	if (typeof body === "string") return new URLSearchParams(body);
	if (body instanceof ArrayBuffer) return new URLSearchParams(new TextDecoder().decode(body));
	return new URLSearchParams();
}

describe("createPkceBackendAuth completion — Dropbox", () => {
	it("POSTs the PKCE code exchange to Dropbox with no client secret and publishes both credentials", async () => {
		const store = memoryStore();
		const requests: CapturedRequest[] = [];
		const patch = await dropboxModule.auth.complete(contextFor(store, requests), CALLBACK, CONFIG);

		expect(requests).toHaveLength(1);
		expect(requests[0]!.url).toBe("https://api.dropboxapi.com/oauth2/token");
		expect(requests[0]!.method).toBe("POST");
		const body = formOf(requests[0]!);
		expect(body.get("grant_type")).toBe("authorization_code");
		expect(body.get("code")).toBe("THECODE");
		expect(body.get("code_verifier")).toBe("verifier-1");
		expect(body.get("client_id")).toBe(DROPBOX_AUTH.clientId);
		expect(body.has("client_secret")).toBe(false);

		expect(store.map.get(defaultPhysicalKey("dropbox", "refresh"))).toBe("RT");
		expect(store.map.get(defaultPhysicalKey("dropbox", "access"))).toBe("AT");
		expect(patch.set?.pendingAuthState).toBe("");
		expect(patch.set?.pendingCodeVerifier).toBe("");
	});

	it("rejects when the response omits the required refresh credential", async () => {
		const store = memoryStore();
		const requests: CapturedRequest[] = [];
		const context: BackendRuntimeContext = {
			...contextFor(store, requests),
			http: capturingHttp({ access_token: "AT", expires_in: 3600 }, requests),
		};

		await expect(dropboxModule.auth.complete(context, CALLBACK, CONFIG)).rejects.toThrow(
			"did not return a refresh token",
		);
	});

	it("fails closed when the refresh credential cannot be read back", async () => {
		const store = memoryStore();
		store.dropWrites = true;

		await expect(
			dropboxModule.auth.complete(contextFor(store, []), CALLBACK, CONFIG),
		).rejects.toThrow("Secret credential could not be saved securely");
		expect(store.map.has(defaultPhysicalKey("dropbox", "access"))).toBe(false);
	});

	it("rejects a CSRF state mismatch", async () => {
		const store = memoryStore();
		await expect(
			dropboxModule.auth.complete(
				contextFor(store, []),
				"obsidian://air-sync-auth?code=C&state=evil",
				CONFIG,
			),
		).rejects.toThrow("State mismatch");
	});

	it("rejects a missing PKCE verifier", async () => {
		const store = memoryStore();
		await expect(
			dropboxModule.auth.complete(
				contextFor(store, []),
				CALLBACK,
				{ pendingAuthState: "state-1" },
			),
		).rejects.toThrow("code verifier is missing");
	});
});

describe("createPkceBackendAuth completion — OneDrive", () => {
	it("POSTs to the consumer token endpoint with PKCE, no client secret, and publishes both credentials", async () => {
		const store = memoryStore();
		const requests: CapturedRequest[] = [];
		const context: BackendRuntimeContext = {
			...contextFor(store, requests),
			secrets: createSecretHost(store, "onedrive"),
		};

		await oneDriveModule.auth.complete(context, CALLBACK, CONFIG);

		expect(requests).toHaveLength(1);
		expect(requests[0]!.url).toBe(
			"https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
		);
		expect(requests[0]!.method).toBe("POST");
		const body = formOf(requests[0]!);
		expect(body.get("grant_type")).toBe("authorization_code");
		expect(body.get("code")).toBe("THECODE");
		expect(body.get("code_verifier")).toBe("verifier-1");
		expect(body.get("client_id")).toBe(ONEDRIVE_AUTH.clientId);
		expect(body.get("scope")).toBe("Files.ReadWrite.AppFolder offline_access");
		expect(body.has("client_secret")).toBe(false);

		expect(store.map.get(defaultPhysicalKey("onedrive", "refresh"))).toBe("RT");
		expect(store.map.get(defaultPhysicalKey("onedrive", "access"))).toBe("AT");
	});

	it("rejects when the response omits the required refresh credential", async () => {
		const store = memoryStore();
		const requests: CapturedRequest[] = [];
		const context: BackendRuntimeContext = {
			...contextFor(store, requests),
			http: capturingHttp({ access_token: "AT", expires_in: 3600 }, requests),
			secrets: createSecretHost(store, "onedrive"),
		};

		await expect(oneDriveModule.auth.complete(context, CALLBACK, CONFIG)).rejects.toThrow(
			"did not return a refresh token",
		);
	});
});

describe("buildPkceTokenGetter refresh lifecycle", () => {
	function fakeManager(): {
		manager: PkceTokenManager;
		setTokens: ReturnType<typeof vi.fn>;
		fireRotation: (token: string) => Promise<void>;
	} {
		let hook: ((refreshToken: string) => void | Promise<void>) | undefined;
		const setTokens = vi.fn();
		const manager: PkceTokenManager = {
			setTokens,
			getAccessToken: () => Promise.resolve("A0"),
			getTokenState: () => ({ refreshToken: "R0", accessToken: "A0", accessTokenExpiry: 5000 }),
			setRefreshTokenRotatedHook: (cb) => {
				hook = cb;
			},
		};
		return {
			manager,
			setTokens,
			fireRotation: async (token) => {
				await hook?.(token);
			},
		};
	}

	function specFor(manager: PkceTokenManager): PkceModuleSpec {
		return {
			displayName: "Fake",
			defaultClientId: "client-id",
			isCustom: () => false,
			customClientId: () => "",
			createManager: () => manager,
			authorizeUrl: () => "https://example.test/auth",
			exchangeCode: () => Promise.resolve(),
		};
	}

	it("seeds the manager from stored secrets, persists a rotated refresh token, and exposes expiry", async () => {
		const store = memoryStore();
		const secrets = createSecretHost(store, "fake");
		await secrets.set(REFRESH_SECRET, "R0");
		await secrets.set(ACCESS_SECRET, "A0");
		const { manager, setTokens, fireRotation } = fakeManager();
		const context: BackendRuntimeContext = {
			http: capturingHttp({}, []),
			secrets,
			logger: noopLogger,
			auth: { openExternal: () => Promise.resolve() },
		};

		const getter = await buildPkceTokenGetter(specFor(manager), context, { accessTokenExpiry: 1234 });

		expect(setTokens).toHaveBeenCalledWith("R0", "A0", 1234);
		expect(getter.readExpiry()).toBe(5000);

		await fireRotation("R1");
		expect(await secrets.get(REFRESH_SECRET)).toBe("R1");
	});
});
