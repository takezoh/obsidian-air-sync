import { describe, expect, it } from "vitest";
import { buildNotificationMessage, CycleSummary } from "./sync-notification";
import type { SyncCycleOutcome } from "./sync-notification";

function outcome(admissionFailures = 0): SyncCycleOutcome {
	return {
		completion: { kind: admissionFailures > 0 ? "incomplete" : "clean" },
		execution: { succeeded: [], superseded: [], failed: [], blocked: [], conflicts: [] },
		admissionFailures: Array.from({ length: admissionFailures }, (_, index) => ({
			kind: "failed", paths: [`path-${index}.md`], actions: [], evidence: [],
			reasons: ["rename_mismatch"],
		})),
	};
}

describe("sync notification Admission failure visibility", () => {
	it("does not present an incomplete actionless cycle as up to date", () => {
		const incomplete = { ...outcome(), completion: { kind: "incomplete" as const } };
		expect(buildNotificationMessage(incomplete)).toBe("Sync: incomplete");
		const summary = new CycleSummary();
		summary.add(incomplete);
		summary.add(outcome());
		expect(summary.message).toBe("Sync: incomplete");
	});
	it("presents rejected components as errors without a retryability claim", () => {
		expect(buildNotificationMessage(outcome(2))).toBe("Sync: 2 errors");
	});

	it("coalesces Admission failures across cycles", () => {
		const summary = new CycleSummary();
		summary.add(outcome(1));
		summary.add(outcome(2));

		expect(summary.message).toBe("Sync: 3 errors");
	});
});
