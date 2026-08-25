import { describe, expect, it } from "vitest";
import {
	applyRenameDebtScope,
	collectLocalRenameDebts,
	mergeRenameDebtEvidence,
	renameDebtsBoundToEvidence,
	unreleasedIdentityEvidence,
} from "./rename-debt";
import type { RenameDebt } from "./state";
import type { RenameEvidence, ScopeProjection } from "./types";

function debt(overrides: Partial<RenameDebt> = {}): RenameDebt {
	return {
		namespace: "onedrive:root", side: "local", oldPath: "A.md", newPath: "a.md",
		isFolder: false, oldDisposition: "included", newDisposition: "included", ...overrides,
	};
}

function rename(): RenameEvidence {
	return {
		kind: "rename", side: "local", oldPath: "A.md", newPath: "a.md",
		isFolder: false, authority: "reported",
	};
}

function projection(entries: Record<string, "included" | "policy_out" | "mobile_deferred" | "unknown">): ScopeProjection {
	return { byEndpoint: new Map(Object.entries(entries)) };
}

describe("rename debt orchestration helpers", () => {
	it("unions persisted debt with fresh evidence without duplicating the same edge", () => {
		const merged = mergeRenameDebtEvidence([rename()], [debt()]);

		expect(merged).toEqual([rename()]);
	});

	it("restores stored endpoint dispositions only where fresh projection is unknown", () => {
		const restored = applyRenameDebtScope(
			projection({ "A.md": "unknown", "a.md": "policy_out" }),
			[debt({ oldDisposition: "included", newDisposition: "included" })],
		);

		expect([...restored.byEndpoint]).toEqual([
			["A.md", "included"], ["a.md", "policy_out"],
		]);
	});

	it("keeps unknown when persisted edges disagree about one endpoint", () => {
		const restored = applyRenameDebtScope(projection({ "A.md": "unknown" }), [
			debt({ oldDisposition: "included" }),
			debt({ newPath: "B.md", oldDisposition: "policy_out" }),
		]);

		expect(restored.byEndpoint.get("A.md")).toBe("unknown");
	});

	it("persists local rename constraints except an explicit out-to-out no-op", () => {
		expect(collectLocalRenameDebts(
			"onedrive:root", [rename()], projection({ "A.md": "included", "a.md": "included" }),
		)).toEqual([debt()]);
		expect(collectLocalRenameDebts(
			"onedrive:root", [rename()], projection({ "A.md": "policy_out", "a.md": "policy_out" }),
		)).toEqual([]);
	});

	it("selects only namespace-local debts bound to released evidence", () => {
		expect(renameDebtsBoundToEvidence(
			[debt(), debt({ namespace: "other:root" })], [rename()], "onedrive:root",
		)).toEqual([debt()]);
		expect(renameDebtsBoundToEvidence([debt()], [], "onedrive:root")).toEqual([]);
	});

	it("retains session evidence outside released membership", () => {
		const edge = { ...rename(), side: "remote" as const };

		expect(unreleasedIdentityEvidence([edge], [])).toEqual([edge]);
		expect(unreleasedIdentityEvidence([edge], [edge])).toEqual([]);
		expect(unreleasedIdentityEvidence(
			[edge], [{ ...edge, identityKey: "remote-id" }],
		)).toEqual([]);
	});
});
