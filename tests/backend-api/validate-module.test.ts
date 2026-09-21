import { describe, expect, it } from "vitest";
import { validateAdapterCapabilities, validateBackendModule } from "../../src/fs/modules/validate-module";
import type { ModuleValidationResult } from "../../src/fs/modules/validate-module";
import { createFakeModule } from "./fake-module";

function codes(result: ModuleValidationResult): string[] {
	return result.ok ? [] : result.issues.map((issue) => issue.code);
}

function asRecord(overrides?: Record<string, unknown>): Record<string, unknown> {
	return { ...createFakeModule(), ...overrides };
}

describe("validateBackendModule", () => {
	it("accepts a module built only from the public API", () => {
		expect(validateBackendModule(createFakeModule())).toEqual({ ok: true });
	});

	it("rejects a candidate that is not a plain object", () => {
		expect(validateBackendModule(null).ok).toBe(false);
		expect(validateBackendModule("module").ok).toBe(false);
		expect(codes(validateBackendModule([1, 2]))).toContain("invalid_module");
	});

	it("rejects a legacy alias as a module id", () => {
		const result = validateBackendModule(asRecord({ id: "dropbox-custom" }));
		expect(result.ok).toBe(false);
		expect(codes(result)).toContain("alias_id");
	});

	it("rejects an unsupported API version", () => {
		const result = validateBackendModule(asRecord({ apiVersion: 3 }));
		expect(codes(result)).toContain("unsupported_api_version");
	});

	it("rejects missing required functions", () => {
		const noAdapter = asRecord();
		delete noAdapter.createAdapter;
		expect(codes(validateBackendModule(noAdapter))).toContain("missing_function");

		const noGetTarget = asRecord();
		delete noGetTarget.getTarget;
		expect(codes(validateBackendModule(noGetTarget))).toContain("missing_function");
	});

	it("rejects malformed identity and version fields", () => {
		expect(codes(validateBackendModule(asRecord({ id: "Bad ID" })))).toContain("invalid_string");
		expect(codes(validateBackendModule(asRecord({ version: "not-semver" })))).toContain("invalid_string");
	});

	it("rejects an unpaired folder picker", () => {
		const result = validateBackendModule(
			asRecord({
				binding: {
					resolveDefault: () => Promise.resolve({ patch: {}, target: { id: "x" } }),
					beginPick: () => Promise.resolve({}),
				},
			}),
		);
		expect(codes(result)).toContain("unpaired_picker");
	});

	it("rejects duplicate settings keys", () => {
		const duplicateSettings = validateBackendModule(
			asRecord({
				settings: {
					fields: [
						{ key: "rootId", label: "A", type: "text" },
						{ key: "rootId", label: "B", type: "text" },
					],
				},
			}),
		);
		expect(codes(duplicateSettings)).toContain("duplicate_field");
	});

	it("requires options for a select field and a valid field type", () => {
		const result = validateBackendModule(
			asRecord({
				settings: { fields: [{ key: "mode", label: "Mode", type: "select" }] },
			}),
		);
		expect(codes(result)).toContain("missing_options");
	});
});

describe("validateAdapterCapabilities", () => {
	const valid = {
		capabilities: {
			exclusiveCreate: true,
			conditionalContentUpdate: "none",
			conditionalMetadataMutation: true,
			versionBoundRead: "reobserve",
		},
	};

	it("accepts a v2 capability declaration", () => {
		expect(validateAdapterCapabilities(valid).ok).toBe(true);
	});

	it("rejects an adapter with no capabilities", () => {
		expect(codes(validateAdapterCapabilities({}))).toContain("missing_capabilities");
	});

	it("rejects a content-update value outside the declared enum", () => {
		const result = validateAdapterCapabilities({
			capabilities: { ...valid.capabilities, conditionalContentUpdate: "sometimes" },
		});
		expect(codes(result)).toContain("invalid_capability");
	});

	it("rejects an unknown enum value", () => {
		const result = validateAdapterCapabilities({
			capabilities: { ...valid.capabilities, versionBoundRead: "revision-pinned" },
		});
		expect(codes(result)).toContain("invalid_capability");
	});
});
