import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../logging/logger";
import { describeErrorBody, logBackendErrorResponse, MAX_LOGGED_BODY_CHARS } from "./backend-error-log";

function fakeLogger(): { logger: Logger; error: ReturnType<typeof vi.fn> } {
	const error = vi.fn();
	return { logger: { error } as unknown as Logger, error };
}

describe("describeErrorBody", () => {
	it("serializes the whole JSON body including nested innerError", () => {
		// The live issue-#42 shape: the outer code is generic, the inner one names the cause.
		const body = describeErrorBody({
			status: 403,
			json: { error: { code: "accessDenied", message: "Access denied", innerError: { code: "serviceReadOnly" } } },
		});
		expect(body).toContain("accessDenied");
		expect(body).toContain("Access denied");
		expect(body).toContain("serviceReadOnly");
	});

	it("falls back to raw text when the body is not JSON", () => {
		expect(describeErrorBody({ status: 502, text: "<html>proxy blocked</html>" })).toBe("<html>proxy blocked</html>");
	});

	it("reports an empty body rather than returning an empty string", () => {
		expect(describeErrorBody({ status: 500 })).toBe("(empty body)");
	});

	it("announces truncation instead of silently clipping", () => {
		const huge = "x".repeat(MAX_LOGGED_BODY_CHARS + 500);
		const body = describeErrorBody({ status: 500, text: huge });
		expect(body).toContain("[truncated 500 more chars]");
		expect(body.length).toBeLessThan(huge.length);
	});

	it("still describes a body that cannot be serialized", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(describeErrorBody({ status: 500, json: cyclic, text: "fallback" })).toBe("fallback");
	});
});

describe("logBackendErrorResponse", () => {
	it("logs status, operation, and the full body at error level", () => {
		const { logger, error } = fakeLogger();
		logBackendErrorResponse(logger, "OneDrive", "getAppRoot", {
			status: 403,
			json: { error: { code: "accessDenied", innerError: { code: "serviceReadOnly" } } },
		});
		expect(error).toHaveBeenCalledTimes(1);
		const [message, context] = error.mock.calls[0] as [string, Record<string, unknown>];
		expect(message).toContain("OneDrive");
		expect(context).toMatchObject({ operation: "getAppRoot", status: 403 });
		expect(context.body).toContain("serviceReadOnly");
	});

	it("keeps response headers but drops set-cookie", () => {
		const { logger, error } = fakeLogger();
		logBackendErrorResponse(logger, "Dropbox", "listFolder", {
			status: 429,
			json: {},
			headers: { "retry-after": "30", "Set-Cookie": "session=secret" },
		});
		const [, context] = error.mock.calls[0] as [string, Record<string, unknown>];
		expect(context.headers).toEqual({ "retry-after": "30" });
	});

	it("is a no-op without a logger", () => {
		expect(() => logBackendErrorResponse(undefined, "OneDrive", "op", { status: 500 })).not.toThrow();
	});
});
