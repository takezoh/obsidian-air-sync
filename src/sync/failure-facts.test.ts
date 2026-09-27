import { describe, expect, it } from "vitest";
import { projectAbortFact, projectFailureFacts, projectUnclassifiedAbortFact } from "./failure-facts";
import type { FailureSourceOutcome } from "./failure-facts";
import type { FailedAction } from "./execution-result";
import type { SyncAction } from "./types";

function failed(action: SyncAction, error: Error, classification?: FailedAction["classification"]): FailedAction {
	const result: FailedAction = { action, error };
	if (classification !== undefined) result.classification = classification;
	return result;
}

function outcome(execution: FailureSourceOutcome["execution"], admissionCount = 0): FailureSourceOutcome {
	return {
		execution,
		admissionFailures: Array.from({ length: admissionCount }, (_, index) => ({
			kind: "failed", paths: [`path-${index}.md`], actions: [], evidence: [],
			reasons: ["rename_mismatch"],
		})),
	};
}

describe("failure fact projection", () => {
	it("projects a failed pull as operation, status, and neutral kind only", () => {
		const error = Object.assign(new Error("gone"), { status: 404 });
		const projection = projectFailureFacts(outcome({
			failed: [failed({ action: "pull", path: "a.md" }, error)], blocked: [],
		}));
		expect(projection.totalErrors).toBe(1);
		expect(projection.representative).toEqual({ operation: "pull", status: 404, classification: "notFound" });
		const serialized = JSON.stringify(projection);
		expect(serialized).not.toContain("a.md");
		expect(serialized).not.toContain("gone");
	});

	it("carries the applied provider re-tag instead of the neutral 403 default", () => {
		const retagged = Object.assign(new Error("rate limited"), { status: 403 });
		const projection = projectFailureFacts(outcome({
			failed: [failed({ action: "push", path: "note.md" }, retagged, "rateLimit")],
			blocked: [],
		}, 1));
		// The carried kind wins over classifyHttpError's 403 permission default.
		expect(projection.representative).toEqual({ operation: "push", status: 403, classification: "rateLimit" });
		expect(projection.totalErrors).toBe(2);
	});

	it("selects the representative by severity then keeps first-observed order", () => {
		const authError = Object.assign(new Error("auth"), { status: 401 });
		const transientError = new Error("network");
		const projection = projectFailureFacts(outcome({
			failed: [
				failed({ action: "push", path: "a.md" }, transientError),
				failed({ action: "pull", path: "b.md" }, authError),
			],
			blocked: [],
		}));
		expect(projection.representative?.classification).toBe("auth");
		// Equal severity keeps the first observed fact.
		const first = projectFailureFacts(outcome({
			failed: [
				failed({ action: "push", path: "a.md" }, new Error("one")),
				failed({ action: "pull", path: "b.md" }, new Error("two")),
			],
			blocked: [],
		}));
		expect(first.representative?.operation).toBe("push");
	});

	it("projects an actionless Admission failure with the unclassified marker", () => {
		const projection = projectFailureFacts(outcome({ failed: [], blocked: [] }, 1));
		expect(projection.representative).toEqual({ operation: "admission", status: null, classification: null });
		expect(projection.totalErrors).toBe(1);
	});

	it("projects a cycle abort with the applied classification", () => {
		const error = Object.assign(new Error("expired"), { status: 401 });
		expect(projectAbortFact(error, "auth")).toEqual({ operation: "cycle abort", status: 401, classification: "auth" });
		expect(projectUnclassifiedAbortFact(new Error("opaque"))).toEqual({
			operation: "cycle abort", status: null, classification: null,
		});
	});
});
