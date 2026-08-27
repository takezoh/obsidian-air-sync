import type { SyncAction, SyncActionType } from "./types";
import type { AdaptivePoolOpts } from "../queue/async-queue";

type Lane = "remote" | "local" | "both" | "none";
type Tier = "transfer" | "rename" | "delete" | "none";

/** Exhaustive scheduler classification for every planner action. */
export const ACTION_CLASS: Record<SyncActionType, { lane: Lane; tier: Tier }> = {
	push: { lane: "remote", tier: "transfer" },
	pull: { lane: "local", tier: "transfer" },
	conflict: { lane: "both", tier: "transfer" },
	match: { lane: "none", tier: "none" },
	cleanup: { lane: "none", tier: "none" },
	rename_remote: { lane: "remote", tier: "rename" },
	rename_local: { lane: "local", tier: "rename" },
	delete_remote: { lane: "remote", tier: "delete" },
	delete_local: { lane: "local", tier: "delete" },
};

export const DESKTOP_TRANSFER_POOL: AdaptivePoolOpts =
	{ min: 2, start: 5, max: 10, rampAfter: 8, byteBudget: 1024 * 1024 * 1024 };
export const MOBILE_TRANSFER_POOL: AdaptivePoolOpts =
	{ min: 1, start: 3, max: 8, rampAfter: 8, byteBudget: 512 * 1024 * 1024 };

/** Declared byte size used by the adaptive transfer pool's memory budget. */
export function transferSize(action: SyncAction): number {
	return (action.action === "push" ? action.local?.size : action.remote?.size) ?? 0;
}

/**
 * A late-selected effect may run only when the proposal's scheduled barrier is at
 * identical. Transfer direction may swap or collapse to state-only; conflict may only
 * remain conflict or collapse to state-only. Every effect-bearing phase change requires
 * the next cycle to schedule the member in its current phase, so correctness never
 * depends on a later phase being "stricter".
 */
export function canRunInScheduledRoute(proposal: SyncAction, current: SyncAction): boolean {
	const proposalClass = ACTION_CLASS[proposal.action];
	const currentClass = ACTION_CLASS[current.action];
	if (current.action === "conflict") return proposal.action === "conflict";
	if (proposal.action === "conflict") {
		return currentClass.tier === "none";
	}
	if (proposalClass.tier === "transfer") {
		return currentClass.tier === "transfer" || currentClass.tier === "none";
	}
	return proposalClass.tier === currentClass.tier && proposalClass.lane === currentClass.lane;
}
