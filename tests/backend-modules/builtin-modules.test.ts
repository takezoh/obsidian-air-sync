import { describe, expect, it } from "vitest";
import { BackendModuleRegistry } from "../../src/fs/modules/registry";
import { validateBackendModule } from "../../src/fs/modules/validate-module";
import { BUILTIN_BACKEND_MODULES } from "../../src/fs/modules/builtin-modules";
import { CORE_CHECKSUM_IDS, createChecksumRegistry } from "../../src/fs/modules/checksum-registry";

describe("built-in backend modules", () => {
	it("exports exactly the three canonical modules", () => {
		expect(BUILTIN_BACKEND_MODULES.map((module) => module.id).sort()).toEqual([
			"dropbox",
			"googledrive",
			"onedrive",
		]);
	});

	it("every built-in module passes runtime validation", () => {
		for (const module of BUILTIN_BACKEND_MODULES) {
			expect(validateBackendModule(module), module.id).toEqual({ ok: true });
		}
	});

	it("registers all three through the validate→register path", () => {
		const registry = new BackendModuleRegistry();
		for (const module of BUILTIN_BACKEND_MODULES) {
			expect(registry.register(module).ok, module.id).toBe(true);
		}
		expect([...registry.ids()].sort()).toEqual(["dropbox", "googledrive", "onedrive"]);
	});

	it("never declares a legacy `-custom` alias as its id", () => {
		for (const module of BUILTIN_BACKEND_MODULES) {
			expect(module.id.endsWith("-custom")).toBe(false);
		}
	});

	it("core pre-registers the standard checksum ids", () => {
		const registry = createChecksumRegistry();
		for (const id of CORE_CHECKSUM_IDS) expect(registry.has(id), id).toBe(true);
	});

	it("resolves a target from its bound folder id without any network call", () => {
		for (const module of BUILTIN_BACKEND_MODULES) {
			expect(module.getTarget({ remoteVaultFolderId: "folder-1" })).toEqual({ id: "folder-1" });
			expect(module.getTarget({})).toBeNull();
		}
	});
});
