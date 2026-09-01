import type { AdmissionResult } from "./plan-admission";
import type { SyncAction } from "./types";

export type BatchPhase = "transfer" | "conflict" | "structural" | "finalizing" | "aborting";
export type PriorityBatchTarget =
	| { kind: "independent" }
	| { kind: "superseding"; action: SyncAction }
	| { kind: "defer" };

/** Cycle-local exact-object scheduling state. It owns no action policy or durable state. */
export class PriorityBatchState {
	private readonly pending: Set<SyncAction>;
	private readonly superseded = new Set<SyncAction>();
	private readonly invalidated = new Set<SyncAction>();
	private phase: BatchPhase = "transfer";
	private checkpointBlocked = false;

	constructor(private readonly admission: AdmissionResult) {
		this.pending = new Set(admission.executable.actions);
	}

	setPhase(phase: BatchPhase): void {
		this.phase = phase;
	}

	abort(): void {
		this.phase = "aborting";
	}

	blockCheckpoint(): void {
		this.checkpointBlocked = true;
	}

	get isCheckpointBlocked(): boolean {
		return this.checkpointBlocked;
	}

	priorityTarget(path: string): PriorityBatchTarget {
		if (this.phase !== "transfer") return { kind: "defer" };
		const disposition = this.admission.dispositions.find((item) => item.paths.includes(path));
		if (!disposition) return { kind: "independent" };
		if (disposition.kind !== "authorized" || !disposition.priorityPullAction ||
			disposition.priorityPullAction.path !== path ||
			!this.pending.has(disposition.priorityPullAction)) return { kind: "defer" };
		return { kind: "superseding", action: disposition.priorityPullAction };
	}

	beginAction(action: SyncAction): "run" | "superseded" | "invalidated" {
		if (this.superseded.has(action)) return "superseded";
		if (this.invalidated.has(action)) return "invalidated";
		return this.pending.delete(action) ? "run" : "invalidated";
	}

	removeBlocked(action: SyncAction): void {
		this.pending.delete(action);
	}

	supersede(action: SyncAction): boolean {
		if (!this.pending.delete(action)) return false;
		this.superseded.add(action);
		return true;
	}

	invalidate(action: SyncAction): boolean {
		if (!this.pending.delete(action)) return false;
		this.invalidated.add(action);
		return true;
	}
}
