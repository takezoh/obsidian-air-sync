import { describe, expect, it } from "vitest";
import { buildNotificationMessage, buildStatusBarText, CycleSummary } from "./sync-notification";
import type { SyncCycleOutcome } from "./sync-notification";

function outcome(admissionFailures = 0, contended = 0): SyncCycleOutcome {
	return {
		completion: { kind: admissionFailures > 0 || contended > 0 ? "incomplete" : "clean" },
		execution: { succeeded: [], superseded: [], failed: [], blocked: [], conflicts: [] },
		admissionFailures: Array.from({ length: admissionFailures }, (_, index) => ({
			kind: "failed", paths: [`path-${index}.md`], actions: [], evidence: [],
			reasons: ["rename_mismatch"],
		})),
		contended,
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

describe("contended addresses are stated as a fact, not as an error", () => {
	it("states the count in its own clause and leaves the error count alone", () => {
		expect(buildNotificationMessage(outcome(0, 1))).toBe("Sync: 1 contended address");
		expect(buildNotificationMessage(outcome(0, 2))).toBe("Sync: 2 contended addresses");
	});

	it("keeps the two clauses separate when a cycle has both", () => {
		// Adversarial: the contended count must not be folded into "3 errors".
		expect(buildNotificationMessage(outcome(2, 1)))
			.toBe("Sync: 1 contended address, 2 errors");
	});

	it("names the reason instead of the generic incomplete clause", () => {
		// "incomplete" is what an unexplained partial cycle says. A contention is an
		// explanation, so it replaces that clause rather than appearing beside it.
		expect(buildNotificationMessage(outcome(0, 1))).not.toContain("incomplete");
		expect(buildNotificationMessage(outcome())).toBe("Everything up to date");
	});

	it("does not multiply one standing contention across a burst of cycles", () => {
		// The same address is re-observed every cycle until it is repaired, so a
		// burst of three cycles is still one contended address.
		const summary = new CycleSummary();
		summary.add(outcome(0, 1));
		summary.add(outcome(0, 1));
		summary.add(outcome(0, 1));

		expect(summary.message).toBe("Sync: 1 contended address");
	});
});

describe("the status bar states a contention a default user would not otherwise see", () => {
	it("states the count in place of the generic partial-cycle text", () => {
		expect(buildStatusBarText("partial_error", { contended: 1, errors: 0 }))
			.toBe("Synced (1 contended address)");
		expect(buildStatusBarText("idle", { contended: 2, errors: 0 }))
			.toBe("Synced (2 contended addresses)");
	});

	it("stands aside for a real failure", () => {
		// A contention never displaces an error: the user is told about the failure.
		expect(buildStatusBarText("partial_error", { contended: 1, errors: 1 }))
			.toBe("Synced (with errors)");
		expect(buildStatusBarText("error", { contended: 1, errors: 0 })).toBe("Sync error");
	});

	it("is unchanged for every cycle that observed no contention", () => {
		expect(buildStatusBarText("idle")).toBe("Synced");
		expect(buildStatusBarText("partial_error")).toBe("Synced (with errors)");
		expect(buildStatusBarText("partial_error", { contended: 0, errors: 0 }))
			.toBe("Synced (with errors)");
		expect(buildStatusBarText("syncing")).toBe("Syncing...");
		expect(buildStatusBarText("not_connected")).toBe("Not connected");
	});
});
