import { vi } from "vitest";
import type { RequestUrlResponse } from "obsidian";
import type { ISecretStore } from "../secret-store";

/** Simplified requestUrl type for test mocks (avoids RequestUrlResponsePromise complexity) */
type MockableRequestUrl = (request: string | import("obsidian").RequestUrlParam) => Promise<RequestUrlResponse>;

/** Helper to spy on the mocked obsidian.requestUrl with proper typing */
export async function spyRequestUrl() {
	const obsidian = await import("obsidian");
	return vi.spyOn(obsidian as unknown as { requestUrl: MockableRequestUrl }, "requestUrl");
}

/** Shorthand to build a partial RequestUrlResponse for mocks */
export function mockRes(json: unknown, extra?: Partial<RequestUrlResponse>): RequestUrlResponse {
	return { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), text: "", json, ...extra } as RequestUrlResponse;
}

/** Type for accessing private fields on GoogleDriveFs in tests */
export interface GoogleDriveFsInternal {
	initialized: boolean;
}

/** Type for accessing private fields on GoogleDriveAuthProvider in tests */
export interface GoogleDriveAuthProviderInternal {
	googleAuth: import("./auth").GoogleAuth;
}

/** Type for accessing private fields on GoogleDriveCustomAuthProvider in tests */
export interface GoogleDriveCustomAuthProviderInternal {
	googleAuth: import("./auth").GoogleAuthDirect;
}

/** Type for accessing private resumableUploader on DriveClient in tests */
export interface DriveClientInternal {
	resumableUploader: {
		resumeCache: Map<string, { uploadUrl: string; totalSize: number; createdAt: number }>;
	};
}

/** Create a mock ISecretStore for tests */
export function createMockSecretStore(secrets: Record<string, string> = {}): ISecretStore {
	const store = new Map(Object.entries(secrets));
	return {
		getSecret: (id: string) => store.get(id) ?? null,
		setSecret: (id: string, secret: string) => { store.set(id, secret); },
	};
}

/** Create a mock App with SecretStorage for tests (for UI components that need App) */
export function mockApp(secrets: Record<string, string> = {}): import("obsidian").App {
	const store = new Map(Object.entries(secrets));
	return {
		secretStorage: {
			getSecret: (id: string) => store.get(id) ?? null,
			setSecret: (id: string, secret: string) => { store.set(id, secret); },
			listSecrets: () => [...store.keys()],
		},
	} as unknown as import("obsidian").App;
}

/** Type for accessing the cache on GoogleDriveFs in tests */
export interface GoogleDriveFsCacheInternal {
	cache: { getChildren(path: string): ReadonlySet<string> | undefined };
}
