import { describe, expect, it } from "vitest";
import type { BackendModule, BackendRuntimeContext, JsonObject } from "../../src/backend-api";
import { DROPBOX_AUTH, GOOGLE_DRIVE_AUTH, ONEDRIVE_AUTH } from "../../src/backends/shared/auth-config";
import { DEFAULT_ONEDRIVE_AUTHORITY } from "../../src/backends/onedrive/auth";
import { dropboxModule } from "../../src/backends/dropbox/module";
import { oneDriveModule } from "../../src/backends/onedrive/module";
import { googleDriveModule } from "../../src/backends/googledrive/module";

/**
 * These tests run the REAL modules' `auth.start` and inspect the authorization URL
 * that reaches `context.auth.openExternal`. They assert on the concrete client id
 * (and, for OneDrive, the authority segment), so an `isCustom` that is wrongly always
 * `false` cannot pass by merely producing a different URL: the custom case would then
 * carry the shipped built-in client id and fail the exact-value assertion.
 */

const DROPBOX_CUSTOM_CLIENT_ID = "custom-dropbox-app-key";
const ONEDRIVE_CUSTOM_CLIENT_ID = "11111111-2222-3333-4444-555555555555";
const ONEDRIVE_CUSTOM_AUTHORITY = "organizations";
const GOOGLE_CUSTOM_CLIENT_ID = "custom-google-client-id.apps.googleusercontent.com";

interface FakeRuntime {
	readonly context: BackendRuntimeContext;
	/** Every URL handed to `context.auth.openExternal`, in order. */
	readonly opened: string[];
}

/**
 * Minimal {@link BackendRuntimeContext}: `auth.start` must not perform network I/O,
 * so `http.request` rejects if touched; secrets resolve the given logical keys.
 */
function makeRuntime(secretValues: Readonly<Record<string, string>> = {}): FakeRuntime {
	const opened: string[] = [];
	const context: BackendRuntimeContext = {
		http: { request: () => Promise.reject(new Error("auth.start must not perform network I/O")) },
		secrets: {
			get: (logicalKey) => Promise.resolve(secretValues[logicalKey] ?? null),
			set: () => Promise.resolve(),
			delete: () => Promise.resolve(),
		},
		logger: {
			debug: () => undefined,
			info: () => undefined,
			warn: () => undefined,
			error: () => undefined,
		},
		auth: {
			openExternal: (url) => {
				opened.push(url);
				return Promise.resolve();
			},
		},
	};
	return { context, opened };
}

async function startedUrl(
	module: BackendModule,
	config: JsonObject,
	secretValues?: Readonly<Record<string, string>>,
): Promise<URL> {
	const { context, opened } = makeRuntime(secretValues);
	await module.auth.start(context, config);
	expect(opened).toHaveLength(1);
	const raw = opened[0];
	if (!raw) throw new Error(`${module.id} auth.start opened no authorization URL`);
	return new URL(raw);
}

function clientId(url: URL): string | null {
	return url.searchParams.get("client_id");
}

describe("Dropbox auth.start client-id selection", () => {
	it("built-in mode opens the shipped Dropbox app key", async () => {
		const url = await startedUrl(dropboxModule, { authMode: false });
		expect(clientId(url)).toBe(DROPBOX_AUTH.clientId);
		expect(url.toString()).not.toContain(DROPBOX_CUSTOM_CLIENT_ID);
	});

	it("custom mode opens the user-provided app key, not the shipped one", async () => {
		const url = await startedUrl(dropboxModule, {
			authMode: true,
			customClientId: DROPBOX_CUSTOM_CLIENT_ID,
		});
		expect(clientId(url)).toBe(DROPBOX_CUSTOM_CLIENT_ID);
		expect(url.toString()).not.toContain(DROPBOX_AUTH.clientId);
	});
});

describe("OneDrive auth.start client-id and authority selection", () => {
	it("built-in mode opens the shipped client id at the built-in authority", async () => {
		const url = await startedUrl(oneDriveModule, { authMode: false });
		expect(clientId(url)).toBe(ONEDRIVE_AUTH.clientId);
		expect(url.pathname).toContain(`/${DEFAULT_ONEDRIVE_AUTHORITY}/oauth2/v2.0/authorize`);
		expect(url.toString()).not.toContain(ONEDRIVE_CUSTOM_CLIENT_ID);
	});

	it("custom mode opens the user-provided client id at the configured authority", async () => {
		const url = await startedUrl(oneDriveModule, {
			authMode: true,
			customClientId: ONEDRIVE_CUSTOM_CLIENT_ID,
			customAuthority: ONEDRIVE_CUSTOM_AUTHORITY,
		});
		expect(clientId(url)).toBe(ONEDRIVE_CUSTOM_CLIENT_ID);
		expect(url.pathname).toContain(`/${ONEDRIVE_CUSTOM_AUTHORITY}/oauth2/v2.0/authorize`);
		expect(url.toString()).not.toContain(ONEDRIVE_AUTH.clientId);
	});
});

describe("Google Drive auth.start client-id selection", () => {
	it("built-in mode opens the shipped Google app client id", async () => {
		const url = await startedUrl(googleDriveModule, { authMode: false });
		expect(clientId(url)).toBe(GOOGLE_DRIVE_AUTH.clientId);
		expect(url.toString()).not.toContain(GOOGLE_CUSTOM_CLIENT_ID);
	});

	it("custom mode opens the custom client id resolved from SecretStorage", async () => {
		const url = await startedUrl(
			googleDriveModule,
			{ authMode: true, customClientId: "GoogleClientIdSecret" },
			{ customClientId: GOOGLE_CUSTOM_CLIENT_ID, customClientSecret: "custom-google-secret" },
		);
		expect(clientId(url)).toBe(GOOGLE_CUSTOM_CLIENT_ID);
		expect(clientId(url)).not.toBe(GOOGLE_DRIVE_AUTH.clientId);
		expect(url.toString()).not.toContain(GOOGLE_DRIVE_AUTH.clientId);
	});
});
