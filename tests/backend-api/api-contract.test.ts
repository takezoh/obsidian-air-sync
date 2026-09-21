import { describe, expect, it } from "vitest";
import {
	backendError,
	isBackendErrorShape,
	isJsonObject,
	isRemoteDirectory,
	BACKEND_MODULE_API_VERSION,
} from "../../src/backend-api";
import { isJsonValue } from "../../src/backend-api/json";
import { isRemoteFile } from "../../src/backend-api/remote-object";
import type { RemoteObject } from "../../src/backend-api";

describe("Backend Module API v3 — JSON boundary", () => {
	it("accepts only finite, plain JSON values", () => {
		expect(isJsonValue(null)).toBe(true);
		expect(isJsonValue("x")).toBe(true);
		expect(isJsonValue(0)).toBe(true);
		expect(isJsonValue(false)).toBe(true);
		expect(isJsonValue([1, "a", { b: null }])).toBe(true);
		expect(isJsonValue({ nested: { list: [1, 2] } })).toBe(true);

		expect(isJsonValue(undefined)).toBe(false);
		expect(isJsonValue(Number.NaN)).toBe(false);
		expect(isJsonValue(Number.POSITIVE_INFINITY)).toBe(false);
		expect(isJsonValue(new Date())).toBe(false);
		expect(isJsonValue(() => 0)).toBe(false);
		expect(isJsonValue(new Map())).toBe(false);
	});

	it("rejects prototype-polluting keys", () => {
		const hostile = JSON.parse('{"__proto__": {"polluted": true}}') as unknown;
		expect(isJsonObject(hostile)).toBe(false);
		expect(isJsonValue({ constructor: "x" })).toBe(false);
	});

	it("rejects cycles rather than recursing forever", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(isJsonValue(cyclic)).toBe(false);
	});
});

describe("Backend Module API v3 — error contract", () => {
	it("recognizes a structurally valid boundary error", () => {
		const error = backendError("rate_limit", "slow down", { retryAfterMs: 1000 });
		expect(isBackendErrorShape(error)).toBe(true);
		expect(isBackendErrorShape({ kind: "rate_limit", message: "x", retryAfterMs: 1 })).toBe(true);
	});

	it("rejects unknown kinds and malformed hints", () => {
		expect(isBackendErrorShape({ kind: "nope", message: "x" })).toBe(false);
		expect(isBackendErrorShape({ kind: "auth" })).toBe(false);
		expect(isBackendErrorShape({ kind: "auth", message: "x", retryAfterMs: "soon" })).toBe(false);
		expect(isBackendErrorShape(new Error("x"))).toBe(false);
	});
});

describe("Backend Module API v3 — normalized object helpers", () => {
	const file: RemoteObject = {
		id: "f1",
		name: "a.md",
		kind: "file",
		location: { addressing: "parent_id", parentId: "root" },
		size: 0,
	};
	const dir: RemoteObject = {
		id: "d1",
		name: "notes",
		kind: "directory",
		location: { addressing: "provider_path", rootId: "root", path: "/notes" },
	};

	it("narrows file vs directory variants", () => {
		expect(isRemoteFile(file)).toBe(true);
		expect(isRemoteDirectory(file)).toBe(false);
		expect(isRemoteDirectory(dir)).toBe(true);
		expect(isRemoteFile(dir)).toBe(false);
	});

	it("keeps a real zero size distinct from an unknown size", () => {
		expect(file.size).toBe(0);
		expect(dir.size).toBeUndefined();
	});

	it("versions the API constant", () => {
		expect(BACKEND_MODULE_API_VERSION).toBe(3);
	});
});
