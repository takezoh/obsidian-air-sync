import { describe, it, expect } from "vitest";
import { checkSafety } from "./safety-check";
import { planSync } from "./decision-engine";
import type { SyncAction, MixedEntity, SyncRecord } from "./types";
import type { FileEntity } from "../fs/types";

/**
 * RED tests pinning the §2-1 data-loss defect: checkSafety() hard-aborts whenever
 * the deletion ratio is 100%, with NO lower count floor. A single legitimate
 * deletion (the only change in a cycle) is therefore treated like a catastrophic
 * full-wipe — the plan is aborted, the deletion never propagates, and the user is
 * told the sync succeeded. The intended behaviour is keyed on read-validity, not
 * deletion volume, so a lone deletion must be allowed through.
 *
 * These assert the INTENDED behaviour and currently FAIL. They are marked
 * `it.fails` so the suite stays green while the defect is pinned: when the guard
 * gains a count-floor / read-validity basis, `it.fails` flips RED — delete the
 * marker and keep the assertions as the new contract.
 */

function del(path: string): SyncAction {
	return { path, action: "delete_remote" };
}

/** Plan for the canonical "lone local deletion" cycle: local missing, remote unchanged, baseline present. */
function lonelyLocalDeletionPlan() {
	const baseline: SyncRecord = {
		path: "note.md",
		hash: "h",
		localMtime: 1000,
		remoteMtime: 1000,
		localSize: 10,
		remoteSize: 10,
		syncedAt: 900,
	};
	const remote: FileEntity = {
		path: "note.md",
		isDirectory: false,
		size: 10,
		mtime: 1000,
		hash: "h",
	};
	const entry: MixedEntity = { path: "note.md", remote, prevSync: baseline };
	return planSync([entry]);
}

describe("§2-1 safety-check: no deletion-count floor (data loss)", () => {
	it.fails(
		"a single genuine deletion should NOT hard-abort the whole sync",
		() => {
			expect(checkSafety([del("a.md")]).shouldAbort).toBe(false);
		},
	);

	it.fails("a small all-deletion batch should NOT hard-abort", () => {
		expect(
			checkSafety([del("a.md"), del("b.md"), del("c.md")]).shouldAbort,
		).toBe(false);
	});

	// Precondition (GREEN): the deletion is planned correctly. Kept as a separate,
	// always-passing test so it does not prop up the it.fails pin below — if this
	// regressed, this test (not the pin) goes red.
	it("a lone local deletion is planned as delete_remote", () => {
		expect(lonelyLocalDeletionPlan().actions[0]!.action).toBe(
			"delete_remote",
		);
	});

	// The pin (currently RED): that correctly-planned deletion is flagged shouldAbort,
	// so executePlan no-ops and the file is never deleted while the orchestrator
	// reports success. This it.fails isolates exactly the shouldAbort defect.
	it.fails(
		"a lone local deletion must NOT be silently aborted by safety-check",
		() => {
			expect(lonelyLocalDeletionPlan().safetyCheck.shouldAbort).toBe(
				false,
			);
		},
	);
});
