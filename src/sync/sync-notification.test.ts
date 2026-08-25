import { describe, expect, it } from "vitest";
import { buildNotificationMessage, CycleSummary } from "./sync-notification";
import type { ExecutionResult } from "./execution-result";

function result(deferred = 0): ExecutionResult {
	return {
		succeeded: [], failed: [], blocked: [], conflicts: [],
		deferred: Array.from({ length: deferred }, (_, index) => ({
			kind: "deferred", paths: [`path-${index}.md`], actions: [], evidence: [],
			reasons: ["rename_mismatch"],
		})),
	};
}

describe("sync notification deferred visibility", () => {
	it("includes the number of deferred components", () => {
		expect(buildNotificationMessage(result(2))).toBe("Sync: 2 deferred");
	});

	it("coalesces deferred components across cycles", () => {
		const summary = new CycleSummary();
		summary.add(result(1));
		summary.add(result(2));

		expect(summary.message).toBe("Sync: 3 deferred");
	});
});
