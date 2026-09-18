import type { ExecutionResult } from "./plan-executor";
import type { AdmissionFailureComponent } from "./plan-admission";
import type { SyncCycleCompletion } from "./sync-cycle-finalization";
import type { SyncStatus } from "./types";

/** One complete cycle outcome across the Admission and execution boundaries. */
export interface SyncCycleOutcome {
	execution: ExecutionResult;
	admissionFailures: AdmissionFailureComponent[];
	completion: SyncCycleCompletion;
	/**
	 * How many distinct addresses this cycle observed claimed by two live ids.
	 *
	 * A fact about the cycle, not a failure: it is stated beside the error count and
	 * never inside it, and it is derived from the cycle's own contention report and
	 * from nothing else. Zero for a cycle that observed no delta at all, which is
	 * the only case in which nothing is said.
	 */
	contended: number;
}

/**
 * What the status bar needs about a cycle beyond the status itself.
 *
 * Cycle-local like everything else about a contention: handed to `onStatusChange`,
 * rendered, and discarded. `errors` travels with it so the contended clause can
 * stand aside for a real failure without asking anyone else what happened.
 */
export interface SyncStatusDetail {
	/** Distinct contended addresses this cycle observed. Never an error count. */
	readonly contended: number;
	/** This cycle's errors, which a contended clause must never displace. */
	readonly errors: number;
}

/**
 * The contended count in the counts-only idiom the summary already speaks.
 *
 * "Contended" names what happened to the *address* — two objects claimed it and
 * only one could hold it. Both objects are still on the provider, so the wording
 * must not suggest anything was removed; the path and the two ids stay in the log.
 */
function contendedClause(contended: number): string {
	return `${contended} contended address${contended === 1 ? "" : "es"}`;
}

/** The status bar's text for every status, before any cycle detail is considered. */
const STATUS_BAR_TEXT: Readonly<Record<SyncStatus, string>> = {
	idle: "Synced",
	syncing: "Syncing...",
	error: "Sync error",
	partial_error: "Synced (with errors)",
	not_connected: "Not connected",
};

/**
 * The status bar line for a status and the cycle that produced it.
 *
 * The status bar is the only per-cycle surface no setting gates — `enableLogging`
 * and `showSyncNotifications` are both false by default — so it is where a user
 * who changed nothing can see that an address was contended. With no errors to
 * report, the contended clause takes the line ahead of the generic partial-cycle
 * text, because it names the reason the cycle is incomplete instead of leaving the
 * user with "with errors" for something that is not an error. A cycle with errors
 * keeps its error text: a contention never displaces a failure.
 */
export function buildStatusBarText(status: SyncStatus, detail?: SyncStatusDetail): string {
	const stateable = status === "idle" || status === "partial_error";
	if (detail && detail.contended > 0 && detail.errors === 0 && stateable) {
		return `Synced (${contendedClause(detail.contended)})`;
	}
	return STATUS_BAR_TEXT[status];
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
	for (const { action } of execution.superseded) count(action);
	const parts: string[] = [];
	if (counts.pushed > 0) parts.push(`${counts.pushed} pushed`);
	if (counts.pulled > 0) parts.push(`${counts.pulled} pulled`);
	if (counts.matched > 0) parts.push(`${counts.matched} matched`);
	if (counts.deleted > 0) parts.push(`${counts.deleted} deleted`);
	if (counts.renamed > 0) parts.push(`${counts.renamed} renamed`);
	if (execution.conflicts.length > 0) parts.push(`${execution.conflicts.length} conflicts`);
	// Its own clause, before the errors it is not part of: a contended address is
	// counted here and never added to `errors` below.
	if (outcome.contended > 0) parts.push(contendedClause(outcome.contended));
	const errors = execution.failed.length + outcome.admissionFailures.length;
	if (errors > 0) parts.push(`${errors} ${errors === 1 ? "error" : "errors"}`);
	if (execution.blocked.length > 0) parts.push(`${execution.blocked.length} blocked`);
	// "incomplete" is the clause for an incompleteness with no stated reason. A
	// contention is a stated reason, so it replaces it rather than doubling it.
	if (outcome.completion.kind === "incomplete" && errors === 0 &&
		execution.blocked.length === 0 && outcome.contended === 0) parts.push("incomplete");
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
		completion: { kind: "clean" },
		contended: 0,
	};

	add(cycle: SyncCycleOutcome): void {
		if (cycle.completion.kind === "incomplete") this.merged.completion = cycle.completion;
		// The largest count any cycle in the burst saw, not their sum: a contention
		// stands until it is repaired, so every cycle of a burst re-observes the same
		// addresses and adding them up would multiply one standing condition.
		this.merged.contended = Math.max(this.merged.contended, cycle.contended);
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
