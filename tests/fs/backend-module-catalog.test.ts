import { describe, expect, it } from "vitest";
import {
	MANAGED_REMOTE_BACKEND_FAMILIES,
	REMOTE_BACKEND_AUTH_CASES,
	REMOTE_BACKEND_CONTRACT_KINDS,
	REMOTE_BACKEND_MODULES,
	validateRemoteBackendCatalog,
	type RemoteBackendCatalog,
} from "./contracts/remote-backend-family";
import { BackendModuleRegistry } from "../../src/fs/modules/registry";

/** A valid cell whose contracts are opaque registrations (the guard only checks shape). */
function cell(moduleId: string): { moduleId: string; contracts: Record<string, unknown> } {
	const contracts = Object.fromEntries(REMOTE_BACKEND_CONTRACT_KINDS.map((kind) => [kind, () => undefined]));
	return { moduleId, contracts };
}

function validCatalog(): RemoteBackendCatalog {
	return Object.fromEntries(
		MANAGED_REMOTE_BACKEND_FAMILIES.map((family) => [family, cell(family)]),
	) as unknown as RemoteBackendCatalog;
}

describe("validateRemoteBackendCatalog", () => {
	it("passes for the real 3-module × 4-contract catalog", () => {
		expect(validateRemoteBackendCatalog(validCatalog())).toEqual([]);
	});

	it("goes RED when an adapter is mis-registered in another module's cell", () => {
		const catalog = validCatalog();
		const mutated = {
			...catalog,
			dropbox: { ...catalog.dropbox, moduleId: "googledrive" },
		} as RemoteBackendCatalog;
		expect(validateRemoteBackendCatalog(mutated)).toEqual(
			expect.arrayContaining([expect.stringContaining('cell "dropbox" exercises module "googledrive"')]),
		);
	});

	it("goes RED when a harness registration is missing", () => {
		const catalog = validCatalog();
		const incomplete = { ...catalog.dropbox.contracts } as Record<string, unknown>;
		delete incomplete.priorityObservation;
		const mutated = {
			...catalog,
			dropbox: { moduleId: "dropbox", contracts: incomplete },
		} as unknown as RemoteBackendCatalog;
		expect(validateRemoteBackendCatalog(mutated)).toEqual(
			expect.arrayContaining([expect.stringContaining('cell "dropbox" is missing the "priorityObservation" contract')]),
		);
	});

	it("goes RED when a required module is absent", () => {
		const catalog = validCatalog();
		const { onedrive: _omitted, ...rest } = catalog;
		expect(validateRemoteBackendCatalog(rest as unknown as RemoteBackendCatalog)).not.toEqual([]);
	});

	it("refuses to register a legacy alias as a module", () => {
		const registry = new BackendModuleRegistry();
		const alias = { ...REMOTE_BACKEND_MODULES.dropbox, id: "dropbox-custom" };
		const result = registry.register(alias);
		expect(result.ok).toBe(false);
	});
});

describe("backend module auth matrix", () => {
	it("covers three modules × built-in/custom = six cases", () => {
		expect(REMOTE_BACKEND_AUTH_CASES).toHaveLength(6);
		for (const moduleId of MANAGED_REMOTE_BACKEND_FAMILIES) {
			for (const authMode of ["default", "custom"] as const) {
				expect(REMOTE_BACKEND_AUTH_CASES).toContainEqual({ moduleId, authMode });
			}
		}
	});

	it("each module declares an authMode toggle defaulting to off", () => {
		for (const moduleId of MANAGED_REMOTE_BACKEND_FAMILIES) {
			const field = REMOTE_BACKEND_MODULES[moduleId].settings?.fields.find((f) => f.key === "authMode");
			expect(field, `${moduleId} declares authMode`).toBeDefined();
			expect(field?.type).toBe("toggle");
			expect(field?.defaultValue).toBe(false);
		}
	});
});
