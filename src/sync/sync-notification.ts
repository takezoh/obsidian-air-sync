import type { ExecutionResult } from "./plan-executor";

/** Outcome counts for one completed sync cycle. */
export interface SyncCycleResult {
	result: ExecutionResult;
	succeeded: number;
	failed: number;
	conflicts: number;
}

/** Build the human-readable summary shown after a sync cycle completes. */
export function buildNotificationMessage(result: ExecutionResult): string {
	const counts = { pushed: 0, pulled: 0, matched: 0, deleted: 0, renamed: 0 };
	for (const a of result.succeeded) {
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
	if (result.conflicts.length > 0) parts.push(`${result.conflicts.length} conflicts`);
	if (result.failed.length > 0) parts.push(`${result.failed.length} errors`);
	return parts.length === 0 ? "Everything up to date" : `Sync: ${parts.join(", ")}`;
}

/**
 * Coalesces the outcomes of one or more sync cycles into a single notice. When a
 * trigger arrives mid-sync (e.g. a mobile resume firing focus + visibilitychange
 * back-to-back), the orchestrator runs another cycle in the same burst; merging —
 * rather than notifying per cycle — keeps an earlier cycle's real work visible
 * while collapsing repeated "Everything up to date" cycles into one message.
 */
export class CycleSummary {
	private readonly merged: ExecutionResult = { succeeded: [], failed: [], conflicts: [] };

	add(cycle: ExecutionResult): void {
		// Append element-by-element, not `push(...arr)`: a cold full-scan cycle can
		// carry tens of thousands of actions, and spreading that many arguments can
		// overflow the engine's argument limit (RangeError) on mobile.
		for (const a of cycle.succeeded) this.merged.succeeded.push(a);
		for (const f of cycle.failed) this.merged.failed.push(f);
		for (const c of cycle.conflicts) this.merged.conflicts.push(c);
	}

	get message(): string {
		return buildNotificationMessage(this.merged);
	}
}
