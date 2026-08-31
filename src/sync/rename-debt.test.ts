import { describe, expect, it } from "vitest";
import {
	mergeRenameDebtEvidence,
	renameDebtsBoundToEvidence,
	serializeLocalRenameDebts,
	unreleasedIdentityEvidence,
} from "./rename-debt";
import type { RenameDebt } from "./state";
import type { LocalRenameEvidence, ScopeProjection } from "./types";

function debt(overrides: Partial<RenameDebt> = {}): RenameDebt {
	return {
		namespace: "onedrive:root", side: "local", oldPath: "A.md", newPath: "a.md",
		isFolder: false, oldDisposition: "included", newDisposition: "included", ...overrides,
	};
}

function rename(): LocalRenameEvidence {
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

	it("serializes only the local rename membership selected by Admission", () => {
		expect(serializeLocalRenameDebts(
			"onedrive:root", [rename()], projection({ "A.md": "included", "a.md": "included" }),
		)).toEqual([debt()]);
		expect(serializeLocalRenameDebts("onedrive:root", [], projection({}))).toEqual([]);
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
