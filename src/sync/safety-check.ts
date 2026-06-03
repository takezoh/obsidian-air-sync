import type { SyncAction, SafetyCheckResult } from "./types";

export function checkSafety(actions: SyncAction[]): SafetyCheckResult {
	const deletions = actions.filter(
		(a) => a.action === "delete_local" || a.action === "delete_remote"
	).length;

	const total = actions.filter(
		(a) => a.action !== "match" && a.action !== "cleanup"
	).length;

	if (total === 0) {
		return { shouldAbort: false };
	}

	const ratio = deletions / total;

	if (ratio === 1) {
		return {
			shouldAbort: true,
			deletionRatio: ratio,
			deletionCount: deletions,
		};
	}

	return {
		shouldAbort: false,
		deletionRatio: ratio,
		deletionCount: deletions,
	};
}
