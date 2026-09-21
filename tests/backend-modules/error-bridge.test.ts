import { describe, expect, it } from "vitest";
import { backendError } from "../../src/backend-api";
import { classifyBackendError } from "../../src/fs/modules/error-bridge";
import { decideRetry } from "../../src/backend-api/error-classification";

describe("classifyBackendError", () => {
	it("maps the public taxonomy to internal kinds", () => {
		expect(classifyBackendError(backendError("auth", "x"))?.kind).toBe("auth");
		expect(classifyBackendError(backendError("permission", "x"))?.kind).toBe("permission");
		expect(classifyBackendError(backendError("rate_limit", "x"))?.kind).toBe("rateLimit");
		expect(classifyBackendError(backendError("not_found", "x"))?.kind).toBe("notFound");
		expect(classifyBackendError(backendError("transient", "x"))?.kind).toBe("transient");
		expect(classifyBackendError(backendError("permanent", "x"))?.kind).toBe("permanent");
	});

	it("fails closed for target_changed and unverifiable", () => {
		expect(classifyBackendError(backendError("target_changed", "x"))?.kind).toBe("permanent");
		expect(classifyBackendError(backendError("unverifiable", "x"))?.kind).toBe("permanent");
	});

	it("preserves a bounded retry hint", () => {
		const classification = classifyBackendError(backendError("rate_limit", "x", { retryAfterMs: 1500 }));
		expect(classification?.retryAfterMs).toBe(1500);
	});

	it("preserves a stable permanentCode for quarantine policy", () => {
		const classification = classifyBackendError(
			backendError("permanent", "x", { permanentCode: "backend.protocol.bad_response" }),
		);
		expect(classification).toEqual({ kind: "permanent", permanentCode: "backend.protocol.bad_response" });
	});

	it("returns null for a non-boundary error so the caller can fall back", () => {
		expect(classifyBackendError(new Error("socket"))).toBeNull();
		expect(classifyBackendError({ status: 429 })).toBeNull();
	});

	it("feeds the retry policy without a second backoff owner", () => {
		const classification = classifyBackendError(backendError("rate_limit", "x", { retryAfterMs: 1500 }));
		expect(classification).not.toBeNull();
		if (!classification) return;
		expect(decideRetry(classification, 1, 3, () => 0.5)).toEqual({ action: "retry", delayMs: 1500 });
	});
});
