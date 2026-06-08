import { describe, it, expect } from "vitest";
import {
	assertOk,
	assertDropboxTokenResponse,
	DropboxApiError,
	isDropboxResetError,
	parseDropboxTime,
	dropboxEntryToEntity,
} from "./types";
import { AuthError } from "../errors";
import { dbxFile, dbxFolder } from "./test-helpers";

describe("assertOk", () => {
	it("passes a 2xx response", () => {
		expect(() => assertOk({ status: 200, json: {} }, "op")).not.toThrow();
	});

	it("maps 401 to AuthError", () => {
		expect(() =>
			assertOk({ status: 401, json: { error_summary: "expired_access_token/..", error: { ".tag": "expired_access_token" } } }, "download"),
		).toThrow(AuthError);
	});

	it("maps an auth-class .tag to AuthError even off a 409", () => {
		expect(() =>
			assertOk({ status: 409, json: { error_summary: "invalid_access_token/..", error: { ".tag": "invalid_access_token" } } }, "op"),
		).toThrow(AuthError);
	});

	it("throws a DropboxApiError carrying status + summary for a 409", () => {
		try {
			assertOk({ status: 409, json: { error_summary: "path/not_found/.", error: { ".tag": "path" } } }, "getMetadata");
			throw new Error("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(DropboxApiError);
			expect((err as DropboxApiError).status).toBe(409);
			expect((err as DropboxApiError).summary).toBe("path/not_found/.");
		}
	});

	it("throws a DropboxApiError for a 429 rate limit", () => {
		try {
			assertOk({ status: 429, json: { error_summary: "too_many_requests/.." }, text: "" }, "listFolder");
			throw new Error("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(DropboxApiError);
			expect((err as DropboxApiError).status).toBe(429);
		}
	});
});

describe("assertDropboxTokenResponse", () => {
	it("accepts a well-formed token response", () => {
		expect(() => assertDropboxTokenResponse({ access_token: "AT", expires_in: 14400 })).not.toThrow();
		expect(() => assertDropboxTokenResponse({ access_token: "AT", refresh_token: "RT", expires_in: 14400 })).not.toThrow();
	});

	it("rejects a missing or non-numeric expires_in (would make accessTokenExpiry NaN)", () => {
		expect(() => assertDropboxTokenResponse({ access_token: "AT" })).toThrow(/Invalid Dropbox token response/);
		expect(() => assertDropboxTokenResponse({ access_token: "AT", expires_in: "14400" })).toThrow(/Invalid Dropbox token response/);
		expect(() => assertDropboxTokenResponse({ access_token: "AT", expires_in: 0 })).toThrow(/Invalid Dropbox token response/);
		expect(() => assertDropboxTokenResponse({ access_token: "AT", expires_in: Number.NaN })).toThrow(/Invalid Dropbox token response/);
	});

	it("rejects a missing access_token and non-objects", () => {
		expect(() => assertDropboxTokenResponse({ expires_in: 14400 })).toThrow(/Invalid Dropbox token response/);
		expect(() => assertDropboxTokenResponse(null)).toThrow(/Invalid Dropbox token response/);
		expect(() => assertDropboxTokenResponse("nope")).toThrow(/Invalid Dropbox token response/);
	});
});

describe("isDropboxResetError", () => {
	it("is true only for a reset-summary DropboxApiError", () => {
		expect(isDropboxResetError(new DropboxApiError("x", 409, "reset/..."))).toBe(true);
		expect(isDropboxResetError(new DropboxApiError("x", 409, "path/not_found"))).toBe(false);
		expect(isDropboxResetError(new Error("reset"))).toBe(false);
	});
});

describe("parseDropboxTime", () => {
	it("parses an ISO8601 second-precision UTC timestamp", () => {
		expect(parseDropboxTime("2024-01-01T00:00:00Z")).toBe(Date.parse("2024-01-01T00:00:00Z"));
	});
	it("returns 0 for absent/invalid input", () => {
		expect(parseDropboxTime(undefined)).toBe(0);
		expect(parseDropboxTime("not-a-date")).toBe(0);
	});
});

describe("dropboxEntryToEntity", () => {
	it("maps a file to a checksum-bearing entity (hash:'' , dropbox algo)", () => {
		const entity = dropboxEntryToEntity("notes/a.md", dbxFile("1", "/root/notes/a.md", { content_hash: "abc", size: 7, server_modified: "2024-02-02T00:00:00Z" }));
		expect(entity).toMatchObject({
			path: "notes/a.md",
			isDirectory: false,
			size: 7,
			hash: "",
			remoteChecksum: { algo: "dropbox", value: "abc" },
		});
		expect(entity.mtime).toBe(Date.parse("2024-02-02T00:00:00Z"));
		expect(entity.backendMeta).toMatchObject({ dropboxId: "id:1" });
	});

	it("maps a folder to a directory entity with no checksum", () => {
		const entity = dropboxEntryToEntity("notes", dbxFolder("9", "/root/notes"));
		expect(entity).toMatchObject({ path: "notes", isDirectory: true, size: 0, mtime: 0, hash: "" });
		expect(entity.remoteChecksum).toBeUndefined();
	});
});
