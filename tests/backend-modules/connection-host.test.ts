import { describe, expect, it } from "vitest";
import {
	createModuleConnection,
	disconnectModule,
} from "../../src/fs/modules/connection-host";
import type { ModuleConfigStore, ModuleDisconnectSteps } from "../../src/fs/modules/connection-host";
import type { ISecretStore } from "../../src/fs/secret-store";
import { BACKEND_MODULE_API_VERSION } from "../../src/backend-api";
import type {
	BackendModule,
	JsonObject,
} from "../../src/backend-api";

const SERVICES = ["googledrive", "onedrive", "dropbox"] as const;
const MODES = [
	["built-in", false],
	["custom", true],
] as const;

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

function memoryConfig(initial: JsonObject = {}) {
	let bag: JsonObject = initial;
	const store: ModuleConfigStore = {
		read: () => bag,
		write: (next) => {
			bag = next;
			return Promise.resolve();
		},
		clear: () => {
			bag = {};
			return Promise.resolve();
		},
	};
	return { store, read: () => bag };
}

function serviceModule(service: string, mode: boolean, revoked: string[]): BackendModule {
	const state = `${service}-${mode}-state`;
	return {
		id: service,
		displayName: service,
		version: "1.0.0",
		apiVersion: BACKEND_MODULE_API_VERSION,
		auth: {
			isAuthenticated: (_context, config) => typeof config.accessToken === "string",
			start: async (context) => {
				await context.auth.openExternal(`https://auth.test/${service}?state=${state}`);
				return { set: { pendingAuthState: state, authMode: mode } };
			},
			complete: (_context, _input, _config) =>
				Promise.resolve({ set: { accessToken: `token-${service}-${mode}`, pendingAuthState: "" } }),
			revoke: (context) => {
				expect(context.secrets).toBeDefined();
				revoked.push(service);
				return Promise.resolve();
			},
		},
		settings: {
			fields: [
				{
					key: "authMode",
					label: "Mode",
					type: "toggle",
					defaultValue: false,
				},
				{
					key: "clientSecret",
					label: "Client secret",
					type: "secret_reference",
					visibleWhen: { field: "authMode", equals: true },
				},
			],
		},
		binding: {
			resolveDefault: (_context, _config, vaultName) =>
				Promise.resolve({
					patch: { set: { rootId: `${service}:${vaultName}` } },
					target: { id: `${service}:${vaultName}` },
				}),
		},
		getTarget: (config) => (typeof config.rootId === "string" ? { id: config.rootId } : null),
		createAdapter: () => Promise.reject(new Error("createAdapter is not used by the connection host")),
	};
}

function connectionFor(module: BackendModule, isCurrent: () => boolean = () => true) {
	const opened: string[] = [];
	const { store, read } = memoryConfig();
	const secrets = memoryStore();
	const connection = createModuleConnection({
		module,
		generation: 1,
		isCurrentGeneration: () => isCurrent(),
		secrets,
		sink: () => undefined,
		config: store,
		openUrl: (url) => {
			opened.push(url);
		},
	});
	return { connection, opened, read, secrets };
}

describe("createModuleConnection — declarative auth across services", () => {
	describe.each(SERVICES)("%s auth", (service) => {
		it.each(MODES)("connects in %s mode", async (_label, mode) => {
			const revoked: string[] = [];
			const { connection, opened, read } = connectionFor(serviceModule(service, mode, revoked));

			expect(connection.context.auth).toBe(connection.auth);
			expect(connection.isAuthenticated()).toBe(false);

			expect(await connection.startAuth()).toBe(true);
			expect(opened).toEqual([`https://auth.test/${service}?state=${service}-${mode}-state`]);
			expect(read()).toMatchObject({
				pendingAuthState: `${service}-${mode}-state`,
				authMode: mode,
			});

			expect(await connection.completeAuth("code")).toBe(true);
			expect(read().accessToken).toBe(`token-${service}-${mode}`);
			expect(connection.isAuthenticated()).toBe(true);
		});
	});
});

describe("createModuleConnection — generation safety", () => {
	it("does not persist a patch once the connection is no longer current", async () => {
		const revoked: string[] = [];
		let current = true;
		const { connection, read } = connectionFor(
			serviceModule("dropbox", false, revoked),
			() => current,
		);
		current = false;
		expect(await connection.completeAuth("late-code")).toBe(false);
		expect(read().accessToken).toBeUndefined();
	});

	it("does not begin an auth attempt on a stale connection", async () => {
		const revoked: string[] = [];
		let current = true;
		const { connection, opened, read } = connectionFor(
			serviceModule("dropbox", false, revoked),
			() => current,
		);
		current = false;
		expect(await connection.startAuth()).toBe(false);
		expect(opened).toEqual([]);
		expect(read().pendingAuthState).toBeUndefined();
	});

	it("treats a disposed connection as stale", async () => {
		const revoked: string[] = [];
		const { connection, read } = connectionFor(serviceModule("dropbox", false, revoked));
		await connection.dispose();
		expect(connection.isCurrent()).toBe(false);
		expect(await connection.completeAuth("late-code")).toBe(false);
		expect(read().accessToken).toBeUndefined();
	});

	it("binds the real auth host to the connection generation and cancels it on teardown", async () => {
		const revoked: string[] = [];
		const { connection } = connectionFor(serviceModule("googledrive", false, revoked));
		// `context.auth` is the connection's own generation-bound host, not a stub.
		expect(connection.context.auth).toBe(connection.auth);
		expect(connection.auth.generation).toBe(1);
		await expect(connection.context.auth.openExternal("https://auth.example/")).resolves.toBeUndefined();
		await connection.dispose();
		await expect(connection.context.auth.openExternal("https://auth.example/")).rejects.toMatchObject({
			name: "AuthCancelledError",
		});
	});

	it("binds the default folder only while current", async () => {
		const revoked: string[] = [];
		const { connection, read } = connectionFor(serviceModule("onedrive", false, revoked));
		await expect(connection.resolveDefaultFolder("MyVault")).resolves.toEqual({
			id: "onedrive:MyVault",
		});
		expect(read().rootId).toBe("onedrive:MyVault");
	});
});

describe("disconnectModule", () => {
	it("runs the ADR sequence in order", async () => {
		const order: string[] = [];
		const step = (name: string) => () => {
			order.push(name);
			return Promise.resolve();
		};
		const steps: ModuleDisconnectSteps = {
			revoke: step("revoke"),
			clearSecrets: step("clearSecrets"),
			clearConfig: step("clearConfig"),
			releaseAdapter: step("releaseAdapter"),
		};
		await disconnectModule(steps);
		expect(order).toEqual([
			"revoke",
			"clearSecrets",
			"clearConfig",
			"releaseAdapter",
		]);
	});

	it("continues local teardown when revoke fails", async () => {
		const order: string[] = [];
		await disconnectModule({
			revoke: () => Promise.reject(new Error("provider unreachable")),
			clearSecrets: () => {
				order.push("clearSecrets");
				return Promise.resolve();
			},
			clearConfig: () => Promise.resolve(),
			releaseAdapter: () => {
				order.push("releaseAdapter");
				return Promise.resolve();
			},
		});
		expect(order).toEqual(["clearSecrets", "releaseAdapter"]);
	});
});

describe("ModuleConnection.disconnect", () => {
	it("revokes, clears the module secret namespace and config, then disposes", async () => {
		const revoked: string[] = [];
		const { store, read } = memoryConfig({ rootId: "root" });
		const secrets = memoryStore({ "air-sync-googledrive-access-token": "A" });
		const connection = createModuleConnection({
			module: serviceModule("googledrive", true, revoked),
			generation: 1,
			isCurrentGeneration: () => true,
			secrets,
			sink: () => undefined,
			config: store,
		});

		await connection.context.secrets.set("refresh-token", "R");
		await connection.context.secrets.set("clientSecret", "S");

		await connection.disconnect();

		expect(revoked).toEqual(["googledrive"]);
		// A plugin-owned (non-reference) touched key is cleared via the stable
		// physical format. A declared `secret_reference` is a USER-OWNED secret name
		// and must never be deleted by the disconnect sequence.
		expect(secrets.map.get("air-sync-googledrive-refresh-token-token")).toBe("");
		expect(secrets.map.get("air-sync-googledrive-clientSecret-token")).toBe("S");
		expect(read()).toEqual({});
		// The production release step is the connection's own dispose; it must leave
		// the generation stale so no late work can publish against a torn-down host.
		expect(connection.isCurrent()).toBe(false);
	});

	it("leaves another module's physical secret untouched", async () => {
		const revoked: string[] = [];
		const secrets = memoryStore({ "air-sync-dropbox-access-token": "OTHER" });
		const connection = createModuleConnection({
			module: serviceModule("googledrive", false, revoked),
			generation: 1,
			isCurrentGeneration: () => true,
			secrets,
			sink: () => undefined,
			config: memoryConfig().store,
		});
		await connection.context.secrets.set("access", "A");
		await connection.disconnect();
		expect(secrets.map.get("air-sync-dropbox-access-token")).toBe("OTHER");
		expect(secrets.map.get("air-sync-googledrive-access-token")).toBe("");
	});

	it("clears a credential the module only read in a later session", async () => {
		const revoked: string[] = [];
		const secrets = memoryStore({ "air-sync-googledrive-refresh-token-token": "STORED" });
		const connection = createModuleConnection({
			module: serviceModule("googledrive", false, revoked),
			generation: 1,
			isCurrentGeneration: () => true,
			secrets,
			sink: () => undefined,
			config: memoryConfig().store,
		});
		expect(await connection.context.secrets.get("refresh-token")).toBe("STORED");
		await connection.disconnect();
		expect(secrets.map.get("air-sync-googledrive-refresh-token-token")).toBe("");
	});

	it("is idempotent when disposed twice", async () => {
		const revoked: string[] = [];
		const { connection } = connectionFor(serviceModule("dropbox", false, revoked));
		await connection.dispose();
		await expect(connection.dispose()).resolves.toBeUndefined();
	});
});
