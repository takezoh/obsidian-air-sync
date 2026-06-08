import { describe, it, expect } from "vitest";
import { classifyDriveError } from "./errors";

/** A Drive 403 whose body carries a rate-limit reason. */
function driveRateLimit403(reason: string) {
	return { status: 403, json: { error: { errors: [{ reason }] } } };
}

describe("classifyDriveError", () => {
	it("re-tags a 403 rate-limit as rateLimit (retryable), not permission", () => {
		for (const reason of ["rateLimitExceeded", "userRateLimitExceeded", "dailyLimitExceeded"]) {
			expect(classifyDriveError(driveRateLimit403(reason)).kind).toBe("rateLimit");
		}
	});

	it("keeps a genuine 403 (no rate-limit reason) as permission (abort)", () => {
		expect(classifyDriveError({ status: 403, json: { error: { errors: [{ reason: "insufficientPermissions" }] } } }).kind)
			.toBe("permission");
		expect(classifyDriveError({ status: 403 }).kind).toBe("permission");
	});

	it("preserves a Retry-After on a re-tagged rate-limit", () => {
		const err = { status: 403, headers: { "retry-after": "9" }, json: { error: { errors: [{ reason: "rateLimitExceeded" }] } } };
		expect(classifyDriveError(err)).toEqual({ kind: "rateLimit", retryAfterMs: 9000 });
	});

	it("defers to the neutral classifier for non-403 statuses", () => {
		expect(classifyDriveError({ status: 429 }).kind).toBe("rateLimit");
		expect(classifyDriveError({ status: 404 }).kind).toBe("notFound");
		expect(classifyDriveError({ status: 500 }).kind).toBe("transient");
	});

	it("does not misread a malformed body as a rate-limit", () => {
		expect(classifyDriveError({ status: 403, json: "garbage" }).kind).toBe("permission");
		expect(classifyDriveError({ status: 403, json: { error: {} } }).kind).toBe("permission");
	});
});
