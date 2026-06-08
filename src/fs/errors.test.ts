import { describe, it, expect } from "vitest";
import { AuthError, getErrorInfo, classifyHttpError } from "./errors";

describe("getErrorInfo", () => {
	it("returns nulls for a non-object", () => {
		expect(getErrorInfo("boom")).toEqual({ status: null, retryAfter: null });
		expect(getErrorInfo(null)).toEqual({ status: null, retryAfter: null });
	});

	it("extracts a numeric status", () => {
		expect(getErrorInfo({ status: 429 }).status).toBe(429);
	});

	it("reads Retry-After (seconds) from a Headers-like object", () => {
		const headers = new Headers({ "retry-after": "30" });
		expect(getErrorInfo({ status: 429, headers }).retryAfter).toBe(30);
	});

	it("reads Retry-After from a plain headers record (either casing)", () => {
		expect(getErrorInfo({ status: 429, headers: { "retry-after": "12" } }).retryAfter).toBe(12);
		expect(getErrorInfo({ status: 429, headers: { "Retry-After": "7" } }).retryAfter).toBe(7);
	});

	it("parses an HTTP-date Retry-After into a non-negative seconds delay", () => {
		const past = new Date(Date.now() - 60_000).toUTCString();
		expect(getErrorInfo({ status: 503, headers: { "retry-after": past } }).retryAfter).toBe(0);
	});

	it("leaves retryAfter null when there is no header", () => {
		expect(getErrorInfo({ status: 500 }).retryAfter).toBeNull();
	});
});

describe("classifyHttpError", () => {
	it("maps an AuthError to auth regardless of its status", () => {
		expect(classifyHttpError(new AuthError("nope", 403))).toEqual({ kind: "auth" });
	});

	it("treats a RAW 401 (not an AuthError) as auth — abort, do not retry", () => {
		// Intentional behaviour shift from the pre-refactor loop, which only special-cased
		// `instanceof AuthError` and would have retried a bare 401 with backoff. A 401 is
		// never worth retrying, so the classifier aborts on it directly.
		expect(classifyHttpError({ status: 401 })).toEqual({ kind: "auth" });
	});

	it.each([
		[401, "auth"],
		[403, "permission"],
		[404, "notFound"],
		[429, "rateLimit"],
		[500, "transient"],
		[undefined, "transient"],
	])("maps status %s to %s", (status, kind) => {
		expect(classifyHttpError(status === undefined ? {} : { status }).kind).toBe(kind);
	});

	it("surfaces retryAfterMs (ms) for 429/403 but not for transient", () => {
		const headers = { "retry-after": "5" };
		expect(classifyHttpError({ status: 429, headers }).retryAfterMs).toBe(5000);
		expect(classifyHttpError({ status: 403, headers }).retryAfterMs).toBe(5000);
		expect(classifyHttpError({ status: 500, headers }).retryAfterMs).toBeUndefined();
	});
});
