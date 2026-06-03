import { describe, it, expect } from "vitest";
import { checkSafety } from "./safety-check";
import type { SyncAction, SyncActionType } from "./types";

function makeActions(counts: Partial<Record<SyncActionType, number>>): SyncAction[] {
	const actions: SyncAction[] = [];
	for (const [type, count] of Object.entries(counts) as [SyncActionType, number][]) {
		for (let i = 0; i < count; i++) {
			const path = `file-${type}-${i}.md`;
			if (type === "rename_remote" || type === "rename_local") {
				actions.push({ path, action: type, oldPath: `old-${path}` });
			} else {
				actions.push({ path, action: type });
			}
		}
	}
	return actions;
}

describe("checkSafety", () => {
	it("returns safe result for empty actions", () => {
		const result = checkSafety([]);
		expect(result.shouldAbort).toBe(false);
	});

	it("returns safe result when no deletions", () => {
		const actions = makeActions({ push: 5, pull: 3 });
		const result = checkSafety(actions);
		expect(result.shouldAbort).toBe(false);
	});

	it("ignores match and cleanup when computing total", () => {
		const actions = makeActions({ match: 10, cleanup: 5 });
		const result = checkSafety(actions);
		expect(result.shouldAbort).toBe(false);
	});

	it("returns shouldAbort when 100% are deletions", () => {
		const actions = makeActions({ delete_local: 5, delete_remote: 5 });
		const result = checkSafety(actions);
		expect(result.shouldAbort).toBe(true);
		expect(result.deletionRatio).toBe(1);
		expect(result.deletionCount).toBe(10);
	});

	it("returns shouldAbort when all non-trivial are deletions (with match/cleanup ignored)", () => {
		const actions = makeActions({ delete_local: 3, match: 20, cleanup: 5 });
		const result = checkSafety(actions);
		expect(result.shouldAbort).toBe(true);
		expect(result.deletionCount).toBe(3);
	});

	it("does not abort when deletions are a high but not total share", () => {
		const actions = makeActions({ delete_local: 11, push: 5 });
		const result = checkSafety(actions);
		expect(result.shouldAbort).toBe(false);
		expect(result.deletionCount).toBe(11);
	});

	it("counts both delete_local and delete_remote as deletions", () => {
		const actions = makeActions({ delete_local: 6, delete_remote: 6, push: 5 });
		const result = checkSafety(actions);
		expect(result.deletionCount).toBe(12);
		expect(result.shouldAbort).toBe(false);
	});

	it("returns deletionRatio for non-abort cases", () => {
		const actions = makeActions({ delete_local: 2, push: 8 });
		const result = checkSafety(actions);
		expect(result.deletionRatio).toBeCloseTo(0.2);
		expect(result.deletionCount).toBe(2);
	});
});
