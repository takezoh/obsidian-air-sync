import type {
	BackendAuth,
	BackendBinding,
	BackendModule,
	BackendRuntimeContext,
	BindingResult,
	CreateDirectoryInput,
	CreateFileInput,
	DeleteInput,
	MoveInput,
	RemoteBackendAdapter,
	RemoteChangeResult,
	RemoteObject,
	UpdateFileInput,
	VersionBoundReadResult,
} from "../../src/backend-api";
import { BACKEND_MODULE_API_VERSION } from "../../src/backend-api";

/**
 * A static fake backend module built with ONLY the public Backend Module API.
 *
 * This is a compile fixture: if the public entry point ever requires an
 * `App`, `AirSyncSettings`, a store, or `IFileSystem` to construct a module,
 * this file stops type-checking. T01's completion condition.
 */
function fakeAdapter(): RemoteBackendAdapter {
	const unsupported = (): never => {
		throw new Error("fake adapter method is not implemented");
	};
	return {
		capabilities: {
			exclusiveCreate: false,
			conditionalContentUpdate: "none",
			conditionalMetadataMutation: false,
			versionBoundRead: "reobserve",
		},
		getStartCursor: () => Promise.resolve("fake-start"),
		listAll: () => Promise.resolve([]),
		assertRootAlive: () => Promise.resolve(),
		getChanges: (): Promise<RemoteChangeResult> => Promise.resolve({ kind: "cursor_invalid" }),
		getById: () => Promise.resolve(null as RemoteObject | null),
		getByPath: () => Promise.resolve([]),
		read: (): Promise<VersionBoundReadResult> =>
			Promise.resolve({ kind: "unverifiable", reason: "fake" }),
		createFile: (_input: CreateFileInput) => unsupported(),
		updateFile: (_input: UpdateFileInput) => unsupported(),
		createDirectory: (_input: CreateDirectoryInput) => unsupported(),
		move: (_input: MoveInput) => unsupported(),
		delete: (_input: DeleteInput) => Promise.resolve(),
	};
}

const FAKE_AUTH: BackendAuth = {
	isAuthenticated: () => true,
	start: () => Promise.resolve({ set: { authMode: false } }),
	complete: () => Promise.resolve({}),
};

const FAKE_BINDING: BackendBinding = {
	resolveDefault: (): Promise<BindingResult> =>
		Promise.resolve({ patch: { set: { rootId: "fake-root" } }, target: { id: "fake-root" } }),
};

/** Construct a valid fake module, optionally overriding top-level fields. */
export function createFakeModule(overrides?: Partial<BackendModule>): BackendModule {
	const base: BackendModule = {
		id: "fakebackend",
		displayName: "Fake Backend",
		version: "1.0.0",
		apiVersion: BACKEND_MODULE_API_VERSION,
		auth: FAKE_AUTH,
		settings: {
			fields: [{ key: "rootId", label: "Root folder", type: "text" }],
		},
		binding: FAKE_BINDING,
		getTarget: (config) =>
			typeof config.rootId === "string" ? { id: config.rootId } : null,
		createAdapter: (_context: BackendRuntimeContext) => Promise.resolve(fakeAdapter()),
	};
	return { ...base, ...overrides };
}
