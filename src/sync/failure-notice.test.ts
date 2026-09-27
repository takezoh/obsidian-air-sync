import { describe, expect, it } from "vitest";
import { formatFailureClause, formatSyncAbortNotice, UNCLASSIFIED } from "./failure-notice";
import type { FailureFact } from "./failure-facts";
import type { ErrorKind } from "../backend-api/error-classification";

function fact(operation: FailureFact["operation"], status: number | null, classification: ErrorKind | null): FailureFact {
	return { operation, status, classification };
}

describe("failure notice clause", () => {
	it("renders the exact clause for every classified status and a provider re-tag", () => {
		expect(formatFailureClause(fact("pull", 403, "permission"))).toBe("Pull failed (403, permission)");
		expect(formatFailureClause(fact("delete", 404, "notFound"))).toBe("Delete failed (404, notFound)");
		expect(formatFailureClause(fact("push", 429, "rateLimit"))).toBe("Push failed (429, rateLimit)");
		expect(formatFailureClause(fact("rename", 500, "transient"))).toBe("Rename failed (500, transient)");
		// A provider-translated 403 keeps the applied rateLimit kind.
		expect(formatFailureClause(fact("push", 403, "rateLimit"))).toBe("Push failed (403, rateLimit)");
	});

	it("names the reconnect action for an authentication failure only", () => {
		expect(formatFailureClause(fact("cycle abort", 401, "auth")))
			.toBe("Cycle abort failed (401, auth). Please reconnect in settings.");
		expect(formatFailureClause(fact("cycle abort", null, "auth")))
			.toBe("Cycle abort failed (unclassified). Please reconnect in settings.");
	});

	it("renders the unclassified marker when there is no status or no recognized kind", () => {
		expect(formatFailureClause(fact("push", null, "transient"))).toBe("Push failed (unclassified)");
		expect(formatFailureClause(fact("admission", null, null))).toBe("Admission failed (unclassified)");
		expect(formatFailureClause(fact("cycle abort", null, null))).toBe("Cycle abort failed (unclassified)");
		expect(formatFailureClause(fact("push", 429, null))).toBe("Push failed (429, unclassified)");
		expect(formatFailureClause(fact("push", 429, "path/not_found" as unknown as ErrorKind)))
			.toBe("Push failed (429, unclassified)");
	});

	it("never renders a path, token, provider message, or instruction", () => {
		const hostile: FailureFact = {
			operation: "sync" as unknown as FailureFact["operation"],
			status: Number.NaN,
			classification: "Bearer access-token /vault/notes/private.md" as unknown as ErrorKind,
		};
		const clause = formatFailureClause(hostile);
		expect(clause).toBe(`Sync failed (${UNCLASSIFIED})`);
		for (const secret of ["/vault/", "private.md", "access-token", "Bearer", "path/not_found"]) {
			expect(clause).not.toContain(secret);
		}
		expect(clause).not.toMatch(/please|reconnect|check |retry|try again|action/i);
	});

	it("composes the sync abort notice from an error the unhandled-error catch caught", () => {
		const authError = Object.assign(new Error("credentials expired"), { status: 401 });
		expect(formatSyncAbortNotice(authError))
			.toBe("Cycle abort failed (401, auth). Please reconnect in settings.");
		expect(formatSyncAbortNotice(new Error("opaque"))).toBe("Cycle abort failed (unclassified)");
		// A backend classifier overrides the neutral one, preserving a provider re-tag.
		expect(formatSyncAbortNotice(Object.assign(new Error("denied"), { status: 403 }), () => ({ kind: "rateLimit" })))
			.toBe("Cycle abort failed (403, rateLimit)");
	});
});
