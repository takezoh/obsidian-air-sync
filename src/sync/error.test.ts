import { describe, it, expect } from "vitest";
import { decideRetry } from "./error";
import type { ErrorClassification } from "../fs/errors";

const MAX = 3;
// Fixed rng so backoff is deterministic: base * (0.5 + 0.5) = base.
const halfRng = () => 0.5;

describe("decideRetry", () => {
	it.each<[ErrorClassification, "auth" | "permission"]>([
		[{ kind: "auth" }, "auth"],
		[{ kind: "permission" }, "permission"],
	])("aborts immediately on %s", (classification, kind) => {
		expect(decideRetry(classification, 1, MAX, halfRng)).toEqual({ action: "abort", kind });
	});

	it("stops (no backoff) on notFound", () => {
		expect(decideRetry({ kind: "notFound" }, 1, MAX, halfRng)).toEqual({ action: "stop" });
	});

	it("stops (no backoff) on permanent backend/protocol failures", () => {
		expect(decideRetry({ kind: "permanent" }, 1, MAX, halfRng)).toEqual({ action: "stop" });
	});

	it("retries transient/rateLimit while attempts remain", () => {
		expect(decideRetry({ kind: "transient" }, 1, MAX, halfRng).action).toBe("retry");
		expect(decideRetry({ kind: "rateLimit" }, 2, MAX, halfRng).action).toBe("retry");
	});

	it("reports exhausted on the final attempt instead of retrying", () => {
		expect(decideRetry({ kind: "transient" }, MAX, MAX, halfRng)).toEqual({ action: "exhausted" });
	});

	it("honours a server retryAfterMs over computed backoff", () => {
		const d = decideRetry({ kind: "rateLimit", retryAfterMs: 4200 }, 1, MAX, halfRng);
		expect(d).toEqual({ action: "retry", delayMs: 4200 });
	});

	it("caps an excessive retryAfterMs at 64s so one retry can't hang the sync", () => {
		const d = decideRetry({ kind: "rateLimit", retryAfterMs: 3_600_000 }, 1, MAX, halfRng);
		expect(d).toEqual({ action: "retry", delayMs: 64_000 });
	});

	it("uses full-jitter exponential backoff when no retryAfterMs is set", () => {
		// base 2^(attempt-1) s, scaled by (0.5 + rng()); rng=0.5 ⇒ exactly base.
		expect(decideRetry({ kind: "transient" }, 1, MAX, halfRng)).toEqual({ action: "retry", delayMs: 1000 });
		expect(decideRetry({ kind: "transient" }, 2, MAX, halfRng)).toEqual({ action: "retry", delayMs: 2000 });
	});

	it("scales backoff by the injected rng (jitter floor at 0.5×base)", () => {
		const zero = decideRetry({ kind: "transient" }, 2, MAX, () => 0);
		// attempt 2 ⇒ base 2000; (0.5 + 0) ⇒ 1000.
		expect(zero).toEqual({ action: "retry", delayMs: 1000 });
	});
});
