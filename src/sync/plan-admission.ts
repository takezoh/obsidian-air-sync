import { buildFactComponents, type IdentityComponent } from "./plan-admission-graph";
import {
	immutableSnapshot,
	type BatchObservation,
} from "./sync-cycle-planning";
import {
	decideIdentityComponent,
	type AdmissionFailureReason as IdentityAdmissionFailureReason,
} from "./identity-component-decision";
import {
	planAddressContentionRemediation,
	type AddressContentionFacts,
} from "./plan-admission-address-contention";
import type {
	IdentityEvidence,
	ConflictStrategy,
	SyncAction,
} from "./types";

const authorizedSyncPlanBrand: unique symbol = Symbol("AuthorizedSyncPlan");

/** The executor input that only Admission can construct. */
export interface AuthorizedSyncPlan {
	readonly actions: readonly SyncAction[];
	readonly components: readonly AuthorizedComponent[];
	readonly [authorizedSyncPlanBrand]: BatchObservation;
}

interface AdmissionComponentDisposition {
	paths: string[];
	actions: SyncAction[];
	evidence: IdentityEvidence[];
}

export interface AuthorizedComponent extends AdmissionComponentDisposition {
	kind: "authorized";
	/** Exact action object that a detached priority pull may replace in this cycle. */
	priorityPullAction?: SyncAction;
}

export interface ResolvedNoActionComponent extends AdmissionComponentDisposition {
	kind: "resolved_no_action";
}

export type AdmissionFailureReason = IdentityAdmissionFailureReason;

export interface AdmissionFailureComponent extends AdmissionComponentDisposition {
	kind: "failed";
	reasons: AdmissionFailureReason[];
}

export type AdmissionDisposition =
	| AuthorizedComponent
	| ResolvedNoActionComponent
	| AdmissionFailureComponent;

export interface AdmissionResult {
	snapshot: BatchObservation;
	executable: AuthorizedSyncPlan;
	dispositions: AdmissionDisposition[];
	failures: AdmissionFailureComponent[];
	/**
	 * Whether this cycle owes a provider repair for a contended address and must
	 * therefore not commit its checkpoint. A cycle-local fact about the plan, never
	 * persisted and never read back — the next cycle re-derives it from its own
	 * observations.
	 */
	checkpointBlocked: boolean;
}

/** Sole production entry: construct, validate, and authorize actions from observed facts. */
export function admitBatchObservation(
	observation: BatchObservation,
	conflictStrategy: ConflictStrategy = "auto_merge",
	contention?: AddressContentionFacts,
): AdmissionResult {
	return authorizeComponents(
		observation, buildFactComponents(observation), conflictStrategy,
		// A cycle whose filesystem announced nothing owes nothing.
		contention ?? { contentions: [], records: new Map(), renameByIdentity: false },
	);
}

function authorizeComponents(
	snapshot: BatchObservation,
	components: readonly IdentityComponent[],
	conflictStrategy: ConflictStrategy,
	contention: AddressContentionFacts,
): AdmissionResult {
	// Decided before the components, not after: the owner's rule for a contended address
	// is "sync the object whose id matches the SyncRecord, rename the one that does not",
	// so which object an address syncs is an input to every ordinary decision at that
	// address — not a repair appended once they have all been made.
	const remediation = planAddressContentionRemediation(contention);
	const dispositions: AdmissionDisposition[] = [];
	for (const observedComponent of components) {
		const decision = decideIdentityComponent(
			observedComponent, snapshot.scope, snapshot.baselinePaths, conflictStrategy,
			remediation.unresolvedAddresses,
		);
		const decidedComponent = decision.component;
		const shared = {
			paths: [...observedComponent.paths].sort(),
			actions: [...decidedComponent.actions],
			evidence: [...observedComponent.evidence].sort(compareEvidence),
		};
		const reasons = [...decision.reasons];
		if (reasons.length > 0) {
			const failure: AdmissionFailureComponent = {
				kind: "failed",
				...shared,
				reasons,
			};
			dispositions.push(failure);
		} else if (decidedComponent.actions.length === 0) {
			dispositions.push({ kind: "resolved_no_action", ...shared });
		} else {
			dispositions.push({
				kind: "authorized",
				...shared,
				priorityPullAction: priorityPullAction(decidedComponent),
			});
		}
	}
	// A namespace repair is authorized from complete current-cycle facts, exactly as
	// a case-alias parent transition is: one existing-vocabulary `rename_remote` per
	// contended address, in its own single-path component, with no evidence to carry
	// and no record to publish.
	for (const action of remediation.actions) {
		dispositions.push({ kind: "authorized", paths: [action.path], actions: [action], evidence: [] });
	}
	dispositions.sort((left, right) => left.paths.join("\0").localeCompare(right.paths.join("\0")));
	const frozen = immutableSnapshot(dispositions);
	const authorized = frozen.filter((item): item is AuthorizedComponent => item.kind === "authorized");
	const executable = Object.freeze({
		actions: Object.freeze(authorized.flatMap((item) => item.actions)),
		components: Object.freeze(authorized),
		[authorizedSyncPlanBrand]: snapshot,
	});
	return {
		snapshot,
		executable,
		checkpointBlocked: remediation.checkpointBlocked,
		dispositions: frozen,
		failures: frozen.filter((item): item is AdmissionFailureComponent => item.kind === "failed"),
	};
}

function priorityPullAction(component: IdentityComponent & { actions: readonly SyncAction[] }): SyncAction | undefined {
	if (component.paths.size !== 1 || component.actions.length !== 1 ||
		component.evidence.length > 0) return undefined;
	const action = component.actions[0]!;
	if (action.action !== "pull" || action.path !== [...component.paths][0] ||
		!action.baseline || !action.local || action.local.isDirectory ||
		!action.remote || action.remote.isDirectory ||
		action.remote.identityKey !== action.baseline.remoteIdentityKey) return undefined;
	if (component.observations.some((observation) =>
		observation.kind !== "exact" || observation.requestedPath !== action.path ||
		observation.entity.isDirectory)) return undefined;
	return action;
}

function compareEvidence(left: IdentityEvidence, right: IdentityEvidence): number {
	return JSON.stringify(left).localeCompare(JSON.stringify(right));
}
