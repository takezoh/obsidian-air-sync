import { describe, expect, it } from "vitest";
import type { ExecutionResult } from "./execution-result";
import {
	applyRenameDebtScope,
	collectLocalRenameDebts,
	mergeRenameDebtEvidence,
	resolvedRenameDebts,
	unresolvedRenameEvidence,
} from "./rename-debt";
import type { RenameDebt } from "./state";
import type { IdentityEvidence, ScopeProjection, SyncAction } from "./types";

function debt(overrides: Partial<RenameDebt> = {}): RenameDebt {
	return {
		namespace: "onedrive:root", side: "local", oldPath: "A.md", newPath: "a.md",
		isFolder: false, oldDisposition: "included", newDisposition: "included", ...overrides,
	};
}

function rename(): IdentityEvidence {
	return {
		kind: "rename", side: "local", oldPath: "A.md", newPath: "a.md",
		isFolder: false, authority: "reported",
	};
}

function projection(entries: Record<string, "included" | "policy_out" | "mobile_deferred" | "unknown">): ScopeProjection {
	return { byEndpoint: new Map(Object.entries(entries)) };
}

function result(overrides: Partial<ExecutionResult> = {}): ExecutionResult {
	return { succeeded: [], failed: [], blocked: [], conflicts: [], deferred: [], ...overrides };
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

	it("deletes debt only after its admitted action succeeds or it projects to no-op", () => {
		const action: SyncAction = { path: "a.md", oldPath: "A.md", action: "rename_remote" };

		expect(resolvedRenameDebts(
			[debt()], result({ succeeded: [{ action }] }),
			projection({ "A.md": "included", "a.md": "included" }),
		)).toEqual([debt()]);
		expect(resolvedRenameDebts(
			[debt()], result(), projection({ "A.md": "policy_out", "a.md": "policy_out" }),
		)).toEqual([debt()]);
	});

	it("retains debt for deferred, failed, or blocked actions", () => {
		const action: SyncAction = { path: "a.md", oldPath: "A.md", action: "rename_remote" };
		const scope = projection({ "A.md": "included", "a.md": "included" });
		const deferred = {
			paths: ["A.md", "a.md"], actions: [action], evidence: [rename()], reasons: ["rename_mismatch" as const],
		};

		expect(resolvedRenameDebts([debt()], result({ deferred: [deferred] }), scope)).toEqual([]);
		expect(resolvedRenameDebts(
			[debt()], result({ failed: [{ action, error: new Error("failed") }] }), scope,
		)).toEqual([]);
		expect(resolvedRenameDebts(
			[debt()], result({ blocked: [{ action, reason: "blocked" }] }), scope,
		)).toEqual([]);
	});

	it("retains session evidence when its connected action is blocked", () => {
		const edge = { ...rename(), side: "remote" as const };
		const action: SyncAction = { path: "a.md", oldPath: "A.md", action: "rename_local" };

		expect(unresolvedRenameEvidence(
			[edge], result({ blocked: [{ action, reason: "blocked" }] }),
			projection({ "A.md": "included", "a.md": "included" }),
		)).toEqual([edge]);
	});
});
