import type { AdmissionComponent } from "./plan-admission-graph";
import type { AdmissionDeferralReason } from "./identity-component-decision";
import type { IdentityEvidence, PathObservation, ScopeProjection, SyncAction } from "./types";

export const INCOMPLETE_LOCAL_FOLDER_FALLBACK = "incomplete_local_folder_mapping" as const;

/**
 * Fall back from one unprovable native local folder rename to the path-local
 * proposal only when every proposed consequence is independently authoritative.
 * Transfers execute before structural deletes, so the fallback never removes the
 * old remote copy before any replacement/additive content has been uploaded.
 */
export function ordinaryLocalFolderFallback(
	component: AdmissionComponent,
	evidence: readonly IdentityEvidence[],
	reasons: readonly AdmissionDeferralReason[],
	scope: ScopeProjection,
): SyncAction[] | undefined {
	if (reasons.length !== 1 || reasons[0] !== "incomplete_folder_mapping") return undefined;
	const renames = evidence.filter((item) => item.kind === "rename");
	if (renames.length === 0 || !renames.some((item) => item.isFolder) ||
		evidence.length !== renames.length ||
		renames.some((item) => item.side !== "local")) return undefined;
	if ([...component.paths].some((path) => scope.byEndpoint.get(path) !== "included")) {
		return undefined;
	}
	if (component.actions.length === 0 ||
		component.actions.some((action) => !ordinaryActionProven(action, component.observations))) {
		return undefined;
	}
	return [...component.actions];
}

function ordinaryActionProven(
	action: SyncAction,
	observations: readonly PathObservation[],
): boolean {
	if (action.action === "push") {
		return !!action.local && observedExact(observations, "local", action.path) &&
			(action.remote
				? !!action.baseline && observedExact(observations, "remote", action.path)
				: observedAbsent(observations, "remote", action.path));
	}
	if (action.action === "delete_remote") {
		return !!action.baseline && !!action.remote &&
			observedAbsent(observations, "local", action.path) &&
			observedExact(observations, "remote", action.path);
	}
	if (action.action === "match") {
		return !!action.local && !!action.remote &&
			observedExact(observations, "local", action.path) &&
			observedExact(observations, "remote", action.path);
	}
	if (action.action === "cleanup") {
		return !!action.baseline && observedAbsent(observations, "local", action.path) &&
			observedAbsent(observations, "remote", action.path);
	}
	return false;
}

function observedExact(
	observations: readonly PathObservation[],
	side: "local" | "remote",
	path: string,
): boolean {
	return observations.some((item) =>
		item.kind === "exact" && item.side === side && item.requestedPath === path);
}

function observedAbsent(
	observations: readonly PathObservation[],
	side: "local" | "remote",
	path: string,
): boolean {
	return observations.some((item) =>
		item.kind === "absent" && item.side === side && item.requestedPath === path &&
		item.authority === "stat");
}
