import type { ExecutionResult } from "./plan-executor";
import type { AdmissionFailureComponent } from "./plan-admission";

/** One complete cycle outcome across the Admission and execution boundaries. */
export interface SyncCycleOutcome {
	execution: ExecutionResult;
	admissionFailures: AdmissionFailureComponent[];
}

/** Outcome counts for one completed sync cycle. */
export interface SyncCycleResult {
	outcome: SyncCycleOutcome;
	succeeded: number;
	failed: number;
	blocked: number;
	conflicts: number;
}

/** Build the human-readable summary shown after a sync cycle completes. */
export function buildNotificationMessage(outcome: SyncCycleOutcome): string {
	const { execution } = outcome;
	const counts = { pushed: 0, pulled: 0, matched: 0, deleted: 0, renamed: 0 };
	const count = (action: ExecutionResult["succeeded"][number]["action"]) => {
		if (action.action === "push") counts.pushed++;
		else if (action.action === "pull") counts.pulled++;
		else if (action.action === "match") counts.matched++;
		else if (action.action === "delete_local" || action.action === "delete_remote") counts.deleted++;
		else if (action.action === "rename_remote" || action.action === "rename_local") counts.renamed++;
	};
	for (const { action } of execution.succeeded) count(action);
	for (const action of execution.superseded) count(action);
	const parts: string[] = [];
	if (counts.pushed > 0) parts.push(`${counts.pushed} pushed`);
	if (counts.pulled > 0) parts.push(`${counts.pulled} pulled`);
	if (counts.matched > 0) parts.push(`${counts.matched} matched`);
	if (counts.deleted > 0) parts.push(`${counts.deleted} deleted`);
	if (counts.renamed > 0) parts.push(`${counts.renamed} renamed`);
	if (execution.conflicts.length > 0) parts.push(`${execution.conflicts.length} conflicts`);
	const errors = execution.failed.length + outcome.admissionFailures.length;
	if (errors > 0) parts.push(`${errors} ${errors === 1 ? "error" : "errors"}`);
	if (execution.blocked.length > 0) parts.push(`${execution.blocked.length} blocked`);
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
	private readonly merged: SyncCycleOutcome = {
		execution: { succeeded: [], superseded: [], failed: [], blocked: [], conflicts: [] },
		admissionFailures: [],
	};

	add(cycle: SyncCycleOutcome): void {
		// Append element-by-element, not `push(...arr)`: a cold full-scan cycle can
		// carry tens of thousands of actions, and spreading that many arguments can
		// overflow the engine's argument limit (RangeError) on mobile.
		for (const a of cycle.execution.succeeded) this.merged.execution.succeeded.push(a);
		for (const a of cycle.execution.superseded) this.merged.execution.superseded.push(a);
		for (const f of cycle.execution.failed) this.merged.execution.failed.push(f);
		for (const b of cycle.execution.blocked) this.merged.execution.blocked.push(b);
		for (const c of cycle.execution.conflicts) this.merged.execution.conflicts.push(c);
		for (const failure of cycle.admissionFailures) this.merged.admissionFailures.push(failure);
	}

	get message(): string {
		return buildNotificationMessage(this.merged);
	}
}
