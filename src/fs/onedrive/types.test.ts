import { describe, it, expect, vi } from "vitest";
import type { Logger } from "../../logging/logger";
import {
	assertOk,
	assertMicrosoftTokenResponse,
	GraphApiError,
	isGraphResyncError,
	parseGraphTime,
	itemMtime,
	toRemoteChecksum,
	oneDriveItemToEntity,
} from "./types";
import { AuthError } from "../errors";
import { odFile, odFolder } from "./test-helpers";

describe("assertOk", () => {
	it("passes a 2xx response", () => {
		expect(() => assertOk({ status: 200, json: {} }, "op")).not.toThrow();
	});

	it("maps 401 to AuthError", () => {
		expect(() =>
			assertOk({ status: 401, json: { error: { code: "InvalidAuthenticationToken", message: "bad" } } }, "download"),
		).toThrow(AuthError);
	});

	it("maps an auth-class code to AuthError even off a non-401", () => {
		expect(() =>
			assertOk({ status: 403, json: { error: { code: "InvalidAuthenticationToken" } } }, "op"),
		).toThrow(AuthError);
	});

	it("throws a GraphApiError carrying status + code for a 409", () => {
		try {
			assertOk({ status: 409, json: { error: { code: "nameAlreadyExists", message: "conflict" } } }, "createFolder");
			throw new Error("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(GraphApiError);
			expect((err as GraphApiError).status).toBe(409);
			expect((err as GraphApiError).code).toBe("nameAlreadyExists");
		}
	});

	// RED (issue #42): Graph's `error.message` is the only field that distinguishes a
	// missing App Folder from an insufficient grant, and `suffix = code || detail`
	// (types.ts:134) drops it whenever a code is present — which it always is for 403.
	it("keeps the Graph error.message alongside the code for a 403 accessDenied", () => {
		expect(() =>
			assertOk(
				{
					status: 403,
					json: {
						error: {
							code: "accessDenied",
							message: "Access denied. You do not have permission to perform this action or access this resource.",
						},
					},
				},
				"getAppRoot",
			),
		).toThrow(/Access denied\. You do not have permission/);
	});

	// The live issue-#42 shape: Graph kept the actionable condition in `innerError.code`
	// while the outer code stayed the generic `accessDenied`. Nothing the backend sent
	// may be dropped — including fields this codebase does not model.
	it("carries the whole Graph error body, innerError and unmodelled fields included", () => {
		let thrown: unknown;
		try {
			assertOk(
				{
					status: 403,
					json: {
						error: {
							code: "accessDenied",
							message: "Access denied",
							innerError: { code: "serviceReadOnly", "request-id": "33575d37", date: "2026-08-20T02:16:12" },
							suberror: "a_field_this_codebase_does_not_model",
						},
					},
				},
				"getAppRoot",
			);
		} catch (err) {
			thrown = err;
		}
		const message = (thrown as Error).message;
		expect(message).toContain("403");
		expect(message).toContain("accessDenied");
		expect(message).toContain("serviceReadOnly");
		expect(message).toContain("33575d37");
		expect(message).toContain("a_field_this_codebase_does_not_model");
		// `code` is still exposed for callers that branch on it.
		expect((thrown as GraphApiError).code).toBe("accessDenied");
	});

	it("logs the whole error response before throwing", () => {
		const error = vi.fn();
		const logger = { error } as unknown as Logger;
		expect(() =>
			assertOk({ status: 500, json: { error: { code: "internalError" } } }, "fullList", logger),
		).toThrow(GraphApiError);
		expect(error).toHaveBeenCalledTimes(1);
		const [, context] = error.mock.calls[0] as [string, Record<string, unknown>];
		expect(context).toMatchObject({ operation: "fullList", status: 500 });
		expect(context.body).toContain("internalError");
	});

	it("still reports a non-JSON error body verbatim", () => {
		expect(() => assertOk({ status: 502, text: "<html>proxy blocked</html>" }, "download")).toThrow(
			/<html>proxy blocked<\/html>/,
		);
	});

	it("throws a GraphApiError for a 410 resync", () => {
		try {
			assertOk({ status: 410, json: { error: { code: "resyncRequired" } } }, "fetchDelta");
			throw new Error("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(GraphApiError);
			expect((err as GraphApiError).status).toBe(410);
		}
	});
});

describe("assertMicrosoftTokenResponse", () => {
	it("accepts a well-formed token response", () => {
		expect(() => assertMicrosoftTokenResponse({ access_token: "AT", expires_in: 3600 })).not.toThrow();
		expect(() => assertMicrosoftTokenResponse({ access_token: "AT", refresh_token: "RT", expires_in: 3600 })).not.toThrow();
	});

	it("rejects a missing or non-numeric expires_in (would make accessTokenExpiry NaN)", () => {
		expect(() => assertMicrosoftTokenResponse({ access_token: "AT" })).toThrow(/Invalid Microsoft token response/);
		expect(() => assertMicrosoftTokenResponse({ access_token: "AT", expires_in: "3600" })).toThrow(/Invalid Microsoft token response/);
		expect(() => assertMicrosoftTokenResponse({ access_token: "AT", expires_in: 0 })).toThrow(/Invalid Microsoft token response/);
		expect(() => assertMicrosoftTokenResponse({ access_token: "AT", expires_in: Number.NaN })).toThrow(/Invalid Microsoft token response/);
	});

	it("rejects a missing access_token and non-objects", () => {
		expect(() => assertMicrosoftTokenResponse({ expires_in: 3600 })).toThrow(/Invalid Microsoft token response/);
		expect(() => assertMicrosoftTokenResponse(null)).toThrow(/Invalid Microsoft token response/);
		expect(() => assertMicrosoftTokenResponse("nope")).toThrow(/Invalid Microsoft token response/);
	});
});

describe("isGraphResyncError", () => {
	it("is true only for a 410 GraphApiError", () => {
		expect(isGraphResyncError(new GraphApiError("x", 410, "resyncRequired"))).toBe(true);
		expect(isGraphResyncError(new GraphApiError("x", 409, "nameAlreadyExists"))).toBe(false);
		expect(isGraphResyncError(new Error("410"))).toBe(false);
	});
});

describe("parseGraphTime", () => {
	it("parses an ISO8601 timestamp", () => {
		expect(parseGraphTime("2024-01-01T00:00:00Z")).toBe(Date.parse("2024-01-01T00:00:00Z"));
	});
	it("returns 0 for absent/invalid input", () => {
		expect(parseGraphTime(undefined)).toBe(0);
		expect(parseGraphTime("not-a-date")).toBe(0);
	});
});

describe("itemMtime", () => {
	it("prefers fileSystemInfo.lastModifiedDateTime over the item's own time", () => {
		const item = odFile("1", "a.md", "root", {
			fileSystemInfo: { lastModifiedDateTime: "2024-02-02T00:00:00Z" },
			lastModifiedDateTime: "2099-01-01T00:00:00Z",
		});
		expect(itemMtime(item)).toBe(Date.parse("2024-02-02T00:00:00Z"));
	});

	it("falls back to lastModifiedDateTime when fileSystemInfo is absent", () => {
		const item = odFile("1", "a.md", "root", { fileSystemInfo: undefined, lastModifiedDateTime: "2024-03-03T00:00:00Z" });
		expect(itemMtime(item)).toBe(Date.parse("2024-03-03T00:00:00Z"));
	});
});

describe("toRemoteChecksum", () => {
	it("prefers quickXorHash (the only hash personal OneDrive returns), locally computable", () => {
		const item = odFile("1", "a.md", "root", { file: { hashes: { quickXorHash: "QXR=", sha1Hash: "ignored" } } });
		expect(toRemoteChecksum(item)).toEqual({ algo: "quickxor", value: "QXR=" });
	});

	it("falls back to sha256Hash/sha1Hash (Business/SharePoint), lowercased", () => {
		const s256 = odFile("1", "a.md", "root", { file: { hashes: { sha256Hash: "ABCDEF" } } });
		expect(toRemoteChecksum(s256)).toEqual({ algo: "sha256", value: "abcdef" });
		const s1 = odFile("2", "b.md", "root", { file: { hashes: { sha1Hash: "ABC" } } });
		expect(toRemoteChecksum(s1)).toEqual({ algo: "sha1", value: "abc" });
	});

	it("returns undefined when no hash is present", () => {
		expect(toRemoteChecksum(odFolder("9", "dir", "root"))).toBeUndefined();
	});
});

describe("oneDriveItemToEntity", () => {
	it("maps a file to a checksum-bearing entity (hash:'' , quickxor algo)", () => {
		const entity = oneDriveItemToEntity("notes/a.md", odFile("1", "a.md", "p", {
			size: 7,
			file: { hashes: { quickXorHash: "QXR=" } },
			fileSystemInfo: { lastModifiedDateTime: "2024-02-02T00:00:00Z" },
		}));
		expect(entity).toMatchObject({
			path: "notes/a.md",
			pathAuthority: "requested_echo",
			identityKey: "1",
			isDirectory: false,
			size: 7,
			hash: "",
			remoteChecksum: { algo: "quickxor", value: "QXR=" },
		});
		expect(entity.mtime).toBe(Date.parse("2024-02-02T00:00:00Z"));
		expect(entity.backendMeta).toMatchObject({ oneDriveId: "1" });
	});

	it("maps a folder to a directory entity with no checksum", () => {
		const entity = oneDriveItemToEntity("notes", odFolder("9", "notes", "p"));
		expect(entity).toMatchObject({
			path: "notes",
			pathAuthority: "requested_echo",
			identityKey: "9",
			isDirectory: true,
			size: 0,
			mtime: 0,
			hash: "",
		});
		expect(entity.remoteChecksum).toBeUndefined();
	});
});
