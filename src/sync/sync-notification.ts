import type { ExecutionResult } from "./plan-executor";

/** Outcome counts for one completed sync cycle. */
export interface SyncCycleResult {
	result: ExecutionResult;
	succeeded: number;
	failed: number;
	conflicts: number;
}

/** Build the human-readable summary shown after a sync cycle completes. */
export function buildNotificationMessage(cycle: SyncCycleResult): string {
	const counts = { pushed: 0, pulled: 0, matched: 0, deleted: 0, renamed: 0 };
	for (const a of cycle.result.succeeded) {
		if (a.action.action === "push") counts.pushed++;
		else if (a.action.action === "pull") counts.pulled++;
		else if (a.action.action === "match") counts.matched++;
		else if (a.action.action === "delete_local" || a.action.action === "delete_remote") counts.deleted++;
		else if (a.action.action === "rename_remote" || a.action.action === "rename_local") counts.renamed++;
	}
	const parts: string[] = [];
	if (counts.pushed > 0) parts.push(`${counts.pushed} pushed`);
	if (counts.pulled > 0) parts.push(`${counts.pulled} pulled`);
	if (counts.matched > 0) parts.push(`${counts.matched} matched`);
	if (counts.deleted > 0) parts.push(`${counts.deleted} deleted`);
	if (counts.renamed > 0) parts.push(`${counts.renamed} renamed`);
	if (cycle.conflicts > 0) parts.push(`${cycle.conflicts} conflicts`);
	if (cycle.failed > 0) parts.push(`${cycle.failed} errors`);
	return parts.length === 0 ? "Everything up to date" : `Sync: ${parts.join(", ")}`;
}
