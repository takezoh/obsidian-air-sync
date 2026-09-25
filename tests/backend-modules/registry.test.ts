import { describe, expect, it } from "vitest";
import { BackendModuleRegistry } from "../../src/fs/modules/registry";
import { createFakeModule } from "../backend-api/fake-module";

describe("BackendModuleRegistry", () => {
	it("registers a validated module and lists it in order", () => {
		const registry = new BackendModuleRegistry();
		const first = createFakeModule({ id: "alpha" });
		const second = createFakeModule({ id: "beta" });
		expect(registry.register(first)).toEqual({ ok: true, module: first });
		expect(registry.register(second).ok).toBe(true);
		expect(registry.ids()).toEqual(["alpha", "beta"]);
		expect(registry.get("alpha")).toBe(first);
		expect(registry.get("missing")).toBeUndefined();
	});

	it("rejects a duplicate id without replacing the first module", () => {
		const registry = new BackendModuleRegistry();
		const first = createFakeModule({ id: "alpha" });
		registry.register(first);
		const result = registry.register(createFakeModule({ id: "alpha" }));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.issues.map((issue) => issue.code)).toContain("duplicate_id");
		expect(registry.get("alpha")).toBe(first);
		expect(registry.list()).toHaveLength(1);
	});

	it("rejects an invalid module before it can be registered", () => {
		const registry = new BackendModuleRegistry();
		const result = registry.register({ id: "broken" });
		expect(result.ok).toBe(false);
		expect(registry.list()).toHaveLength(0);
	});

	it("rejects a legacy alias", () => {
		const registry = new BackendModuleRegistry();
		const result = registry.register(createFakeModule({ id: "dropbox-custom" }));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.issues.map((issue) => issue.code)).toContain("alias_id");
	});

	it("does not share state between two registries", () => {
		const first = new BackendModuleRegistry();
		const second = new BackendModuleRegistry();
		first.register(createFakeModule({ id: "alpha" }));
		expect(first.get("alpha")).toBeDefined();
		expect(second.get("alpha")).toBeUndefined();
		// Registering the same module in the second registry must succeed: they are independent.
		expect(second.register(createFakeModule({ id: "alpha" })).ok).toBe(true);
	});
});
