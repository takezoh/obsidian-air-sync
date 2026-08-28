import type { IdentityEvidence, PathObservation, ScopeProjection, SyncAction } from "./types";

const authorizedSyncPlanBrand: unique symbol = Symbol("AuthorizedSyncPlan");

export interface CycleAdmissionSnapshot {
	readonly plan: { readonly actions: readonly SyncAction[] };
	readonly identityEvidence: readonly IdentityEvidence[];
	readonly observations: readonly PathObservation[];
	readonly scope: ScopeProjection;
	readonly namespace: string;
	readonly frozenDeltaWitness: string;
}

export interface AuthorizedMemberObligation {
	readonly id: string;
	readonly componentId: string;
	readonly admissionEpoch: number;
	readonly path: string;
	readonly paths: readonly string[];
	/** Complete Admission-owned component path set held while this member is decided/effected. */
	readonly componentPaths: readonly string[];
	/** Frozen remote identity (or authoritative absence) for every proved component path. */
	readonly componentRemoteIdentities: Readonly<Record<string, string | null>>;
	/** Request-local frozen batch/delta witness. It is never persisted. */
	readonly frozenDeltaWitness: string;
}

export interface AuthorizedExecutionComponent {
	readonly id: string;
	readonly admissionEpoch: number;
	readonly paths: readonly string[];
	readonly memberObligations: readonly AuthorizedMemberObligation[];
}

export interface AuthorizedSyncPlan {
	readonly components: readonly AuthorizedExecutionComponent[];
	/** Directional scheduler hints only; never completion authority. */
	readonly actions: readonly SyncAction[];
	readonly [authorizedSyncPlanBrand]: {
		readonly snapshot: CycleAdmissionSnapshot;
		readonly memberByProposal: ReadonlyMap<SyncAction, AuthorizedMemberObligation>;
	};
}

export type AdmissionDeferralReason =
	| "alias_target_mutation"
	| "conflicting_identity"
	| "identity_postcondition_unproven"
	| "incomplete_folder_mapping"
	| "opposing_deletes"
	| "present_unresolved"
	| "rename_mismatch"
	| "unknown_observation"
	| "unknown_scope";

interface AdmissionComponentDisposition {
	componentId: string;
	admissionEpoch: number;
	memberObligationIds: string[];
	paths: string[];
	actions: SyncAction[];
	evidence: IdentityEvidence[];
}

export interface AuthorizedComponent extends AdmissionComponentDisposition { kind: "authorized" }
export interface ResolvedNoActionComponent extends AdmissionComponentDisposition { kind: "resolved_no_action" }
export interface DeferredComponent extends AdmissionComponentDisposition {
	kind: "deferred";
	reasons: AdmissionDeferralReason[];
}
export type AdmissionDisposition = AuthorizedComponent | ResolvedNoActionComponent | DeferredComponent;

export function createAuthorizedSyncPlan(
	snapshot: CycleAdmissionSnapshot,
	components: readonly AuthorizedExecutionComponent[],
	actions: readonly SyncAction[],
	memberByProposal: ReadonlyMap<SyncAction, AuthorizedMemberObligation>,
): AuthorizedSyncPlan {
	return Object.freeze({
		components: Object.freeze([...components]),
		actions: Object.freeze([...actions]),
		[authorizedSyncPlanBrand]: Object.freeze({ snapshot, memberByProposal }),
	});
}

export function memberObligationFor(
	plan: AuthorizedSyncPlan,
	proposal: SyncAction,
): AuthorizedMemberObligation {
	const member = plan[authorizedSyncPlanBrand].memberByProposal.get(proposal);
	if (!member) throw new Error(`Execution proposal is outside Admission authority: ${proposal.path}`);
	return member;
}

export function proposalPaths(action: SyncAction): string[] {
	if (action.action !== "rename_local" && action.action !== "rename_remote") return [action.path];
	return [action.oldPath, action.path,
		...(action.descendants?.flatMap((pair) => [pair.oldPath, pair.newPath]) ?? [])]
		.filter((path, index, all) => all.indexOf(path) === index).sort();
}

export function authorityId(kind: "component" | "member" | "delta", namespace: string, parts: readonly string[]): string {
	let hash = 0x811c9dc5;
	for (const char of `${kind}\0${namespace}\0${parts.join("\0")}`) {
		hash ^= char.charCodeAt(0);
		hash = Math.imul(hash, 0x01000193);
	}
	return `${kind}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function compareEvidence(left: IdentityEvidence, right: IdentityEvidence): number {
	return JSON.stringify(left).localeCompare(JSON.stringify(right));
}
