import type { AdmissionComponent } from "./plan-admission-graph";
import { renameEvidenceKey } from "./identity-evidence";
import { hasRemoteChanged } from "./change-compare";
import { contentKey, sameContent } from "./content-identity";
import type { FileEntity } from "../fs/types";
import type { LocalRenameEvidence, ScopeProjection, SyncAction, SyncRecord } from "./types";

type VersionRelation = "unchanged" | "changed";
type ContentRelation = "same" | "different" | "unproven";
type ExactRemote = { readonly path: string; readonly entity: FileEntity };
type ForeignRemote = ExactRemote & { readonly identityKey: string };
export type EvidenceUnknownReason =
	| "local_candidate_incomplete"
	| "scope_or_authority_missing"
	| "remote_endpoint_unobserved"
	| "remote_identity_missing";
export type EvidenceContradictionReason =
	| "tracked_identity_multiple_occurrences"
	| "tracked_identity_observation_conflict";

interface NormalizedRenameBase {
	readonly candidate: LocalRenameEvidence;
	readonly baseline: SyncRecord;
	readonly local: FileEntity;
}

export type NormalizedRenameState = NormalizedRenameBase & (
	| { readonly kind: "baseline_at_old_vacant_target"; readonly source: ExactRemote; readonly relation: VersionRelation }
	| { readonly kind: "baseline_at_new"; readonly target: ExactRemote; readonly relation: VersionRelation; readonly localRelation: ContentRelation }
	| { readonly kind: "baseline_at_third_vacant_target"; readonly source: ExactRemote; readonly relation: VersionRelation }
	| { readonly kind: "baseline_at_third_foreign_target"; readonly primary: ExactRemote; readonly additional: ForeignRemote; readonly relation: VersionRelation }
	| { readonly kind: "baseline_absent_foreign_target"; readonly additional: ForeignRemote }
	| { readonly kind: "baseline_absent_vacant_target" }
	| { readonly kind: "evidence_unknown"; readonly reason: EvidenceUnknownReason }
	| { readonly kind: "evidence_contradicted"; readonly reason: EvidenceContradictionReason }
);

export type DeterminateNormalizedRenameState = Exclude<NormalizedRenameState,
	{ kind: "evidence_unknown" | "evidence_contradicted" }>;

/** Ignore rename hints that cannot constrain an already-synchronized identity. */
export function classifyNonBindingLocalRenames(
	components: readonly AdmissionComponent[],
	baselinePaths: ReadonlySet<string>,
	scope: ScopeProjection,
): ReadonlySet<string> {
	const nonBinding = new Set<string>();
	for (const component of components) {
		const candidates = component.evidence.filter((item): item is LocalRenameEvidence =>
			item.kind === "rename" && item.side === "local");
		if (candidates.length === 0 || !isNonBindingComponent(
			component, candidates, baselinePaths, scope,
		)) continue;
		for (const candidate of candidates) nonBinding.add(renameEvidenceKey(candidate));
	}
	return nonBinding;
}

/**
 * Replace the ordinary no-baseline pull+push proposal only when the current
 * snapshot independently proves one local case-only rename. This is recovery
 * from a COLD observation, not a stored intermediate sync state.
 */
export function shapeBaselineFreeCaseRename(
	component: AdmissionComponent,
	scope: ScopeProjection,
): SyncAction | undefined {
	const candidates = component.evidence.filter((item): item is LocalRenameEvidence =>
		item.kind === "rename" && item.side === "local" && !item.isFolder &&
		item.authority === "current_state");
	if (candidates.length !== 1 || component.actions.length !== 2 ||
		component.actions.some((action) => action.baseline !== undefined)) return undefined;
	const candidate = candidates[0]!;
	if (candidate.oldPath === candidate.newPath ||
		candidate.oldPath.toLowerCase() !== candidate.newPath.toLowerCase() ||
		scope.byEndpoint.get(candidate.oldPath) !== "included" ||
		scope.byEndpoint.get(candidate.newPath) !== "included") return undefined;

	const pull = component.actions.find((action) =>
		action.action === "pull" && action.path === candidate.oldPath);
	const push = component.actions.find((action) =>
		action.action === "push" && action.path === candidate.newPath);
	if (!pull?.remote || !push?.local || pull.local || push.remote ||
		pull.remote.path !== candidate.oldPath || push.local.path !== candidate.newPath ||
		!pull.remote.identityKey || pull.remote.size !== push.local.size ||
		!sameContent(pull.remote, push.local)) return undefined;

	const localOld = observations(component, "local", candidate.oldPath);
	const localNew = observations(component, "local", candidate.newPath);
	const remoteOld = observations(component, "remote", candidate.oldPath);
	const remoteNew = observations(component, "remote", candidate.newPath);
	if (localOld.length === 0 || !localOld.every((item) =>
		item.kind === "alias" && item.resolvedPath === candidate.newPath) ||
		localNew.length === 0 || !localNew.every((item) =>
			item.kind === "exact" && item.entity.path === candidate.newPath &&
			item.entity.size === push.local!.size && sameContent(item.entity, push.local!)) ||
		remoteOld.length === 0 || !remoteOld.every((item) =>
			item.kind === "exact" && item.entity.path === candidate.oldPath &&
			item.entity.identityKey === pull.remote!.identityKey &&
			item.entity.size === pull.remote!.size && sameContent(item.entity, pull.remote!)) ||
		remoteNew.length === 0 || !remoteNew.every((item) =>
			item.kind === "absent" && item.authority === "stat")) return undefined;

	const identityPaths = new Set(component.observations.flatMap((item) =>
		item.side === "remote" && (item.kind === "exact" || item.kind === "alias") &&
		item.entity.identityKey === pull.remote!.identityKey
			? [item.kind === "alias" ? item.resolvedPath : item.requestedPath]
			: []));
	if (identityPaths.size !== 1 || !identityPaths.has(candidate.oldPath) ||
		component.evidence.some((item) => item.kind === "stable_identity" &&
			item.identityKey === pull.remote!.identityKey &&
			new Set(item.occurrences.filter((entry) => entry.phase === "current")
				.map((entry) => entry.path)).size > 1)) return undefined;

	return {
		action: "rename_remote",
		oldPath: candidate.oldPath,
		path: candidate.newPath,
		local: push.local,
		remote: pull.remote,
	};
}

function observations(
	component: AdmissionComponent,
	side: "local" | "remote",
	path: string,
) {
	return component.observations.filter((item) =>
		item.side === side && item.requestedPath === path);
}

function isNonBindingComponent(
	component: AdmissionComponent,
	candidates: readonly LocalRenameEvidence[],
	baselinePaths: ReadonlySet<string>,
	scope: ScopeProjection,
): boolean {
	if (component.evidence.length !== candidates.length) return false;
	if (candidates.some((candidate) => candidate.isFolder)) return false;
	if ([...component.paths].some((path) => baselinePaths.has(path) ||
		scope.byEndpoint.get(path) !== "included")) return false;

	const oldPaths = new Set(candidates.map((candidate) => candidate.oldPath));
	const newPaths = new Set(candidates.map((candidate) => candidate.newPath));
	const terminalPaths = new Set([...newPaths].filter((path) => !oldPaths.has(path)));
	if (terminalPaths.size === 0 || component.actions.length !== terminalPaths.size ||
		component.actions.some((action) => action.action !== "push" || action.baseline !== undefined ||
			!terminalPaths.has(action.path))) return false;

	for (const path of new Set([...oldPaths, ...newPaths])) {
		if (!hasOnlyObservation(component, "remote", path, "absent")) return false;
		const expectedLocal = terminalPaths.has(path) ? "exact" : "absent";
		if (!hasOnlyObservation(component, "local", path, expectedLocal)) return false;
	}
	return true;
}

function hasOnlyObservation(
	component: AdmissionComponent,
	side: "local" | "remote",
	path: string,
	kind: "absent" | "exact",
): boolean {
	const observations = component.observations.filter((item) =>
		item.side === side && item.requestedPath === path);
	return observations.length > 0 && observations.every((item) => item.kind === kind);
}

/** Sole legal-state producer for one fresh local file rename candidate. */
export function normalizeFreshLocalRename(
	component: AdmissionComponent,
	scope: ScopeProjection,
): NormalizedRenameState | undefined {
	const candidates = component.evidence.filter((item): item is LocalRenameEvidence =>
		item.kind === "rename" && item.side === "local" && !item.isFolder);
	if (candidates.length !== 1) return undefined;
	const candidate = candidates[0]!;
	const baseline = component.actions.find((action) => action.baseline?.path === candidate.oldPath)?.baseline;
	if (!baseline) return undefined;
	const localOld = observation(component, "local", candidate.oldPath);
	const localNew = observation(component, "local", candidate.newPath);
	if (!localNew) return undefined;
	const local = localNew.kind === "exact"
		? actionEntity(component, "local", candidate.newPath) ?? localNew.entity
		: undefined;
	if (!baseline.hash || !local?.hash) {
		return local
			? { kind: "evidence_unknown", reason: "local_candidate_incomplete", candidate, baseline, local }
			: undefined;
	}
	if (local.hash === baseline.hash) return undefined;
	if (localOld?.kind !== "absent" || scope.byEndpoint.get(candidate.oldPath) !== "included" ||
		scope.byEndpoint.get(candidate.newPath) !== "included" || !baseline.remoteIdentityKey) {
		return { kind: "evidence_unknown", reason: "scope_or_authority_missing", candidate, baseline, local };
	}
	const remoteOld = observation(component, "remote", candidate.oldPath);
	const remoteNew = observation(component, "remote", candidate.newPath);
	if (!isExactOrAbsent(remoteOld) || !isExactOrAbsent(remoteNew)) {
		return { kind: "evidence_unknown", reason: "remote_endpoint_unobserved", candidate, baseline, local };
	}
	const oldEntity = remoteOld.kind === "exact"
		? actionEntity(component, "remote", candidate.oldPath) ?? remoteOld.entity : undefined;
	const newEntity = remoteNew.kind === "exact"
		? actionEntity(component, "remote", candidate.newPath) ?? remoteNew.entity : undefined;
	const baselineId = baseline.remoteIdentityKey;
	if ((oldEntity && !oldEntity.identityKey) || (newEntity && !newEntity.identityKey)) {
		return { kind: "evidence_unknown", reason: "remote_identity_missing", candidate, baseline, local };
	}
	const tracked = trackedRemoteOccurrences(component, baselineId);
	if (tracked.kind === "contradicted") {
		return { kind: "evidence_contradicted", reason: tracked.reason, candidate, baseline, local };
	}
	const targetIsForeign = newEntity?.identityKey !== undefined && newEntity.identityKey !== baselineId;
	const additional = targetIsForeign && newEntity
		? foreignRemote(candidate.newPath, newEntity)
		: undefined;
	const primary = tracked.occurrence;
	if (primary && additional) {
		if (scope.byEndpoint.get(primary.path) !== "included") {
			return { kind: "evidence_unknown", reason: "scope_or_authority_missing", candidate, baseline, local };
		}
		return {
			kind: "baseline_at_third_foreign_target", candidate, baseline, local,
			primary, additional, relation: versionRelation(primary.entity, baseline),
		};
	}
	if (primary?.path === candidate.oldPath && !newEntity) {
		return {
			kind: "baseline_at_old_vacant_target", candidate, baseline, local,
			source: primary, relation: versionRelation(primary.entity, baseline),
		};
	}
	if (primary?.path === candidate.newPath && newEntity) {
		return {
			kind: "baseline_at_new", candidate, baseline, local,
			target: primary, relation: versionRelation(primary.entity, baseline),
			localRelation: contentRelation(local, primary.entity),
		};
	}
	if (primary && !newEntity) {
		if (scope.byEndpoint.get(primary.path) !== "included") {
			return { kind: "evidence_unknown", reason: "scope_or_authority_missing", candidate, baseline, local };
		}
		return {
			kind: "baseline_at_third_vacant_target", candidate, baseline, local,
			source: primary, relation: versionRelation(primary.entity, baseline),
		};
	}
	if (!primary && additional) {
		return { kind: "baseline_absent_foreign_target", candidate, baseline, local, additional };
	}
	if (!primary && !newEntity) {
		return { kind: "baseline_absent_vacant_target", candidate, baseline, local };
	}
	return {
		kind: "evidence_contradicted", reason: "tracked_identity_observation_conflict",
		candidate, baseline, local,
	};
}

type TrackedOccurrences =
	| { kind: "ok"; occurrence?: ExactRemote }
	| { kind: "contradicted"; reason: EvidenceContradictionReason };

function trackedRemoteOccurrences(component: AdmissionComponent, identityKey: string): TrackedOccurrences {
	const byPath = new Map<string, FileEntity>();
	for (const item of component.observations) {
		if (item.side !== "remote" || item.kind !== "exact" || item.entity.identityKey !== identityKey) continue;
		const current = byPath.get(item.requestedPath);
		if (current && (current.identityKey !== item.entity.identityKey ||
			contentRelation(current, item.entity) === "different")) {
			return { kind: "contradicted", reason: "tracked_identity_observation_conflict" };
		}
		byPath.set(item.requestedPath,
			actionEntity(component, "remote", item.requestedPath) ?? item.entity);
	}
	const stableIdentityConflict = component.evidence.some((item) =>
		item.kind === "stable_identity" && item.identityKey === identityKey &&
		new Set(item.occurrences.filter((entry) => entry.phase === "current")
			.map((entry) => entry.path)).size > 1);
	if (byPath.size > 1 || stableIdentityConflict) {
		return { kind: "contradicted", reason: "tracked_identity_multiple_occurrences" };
	}
	const occurrence = [...byPath].map(([path, entity]) => ({ path, entity }))[0];
	return occurrence ? { kind: "ok", occurrence } : { kind: "ok" };
}

function observation(component: AdmissionComponent, side: "local" | "remote", path: string) {
	return component.observations.find((item) => item.side === side && item.requestedPath === path);
}

function actionEntity(component: AdmissionComponent, side: "local" | "remote", path: string) {
	return component.actions.map((action) => action[side]).find((entity) => entity?.path === path);
}

function isExactOrAbsent(value: ReturnType<typeof observation>): value is Exclude<NonNullable<typeof value>,
	{ kind: "alias" | "present_unresolved" | "unknown" }> {
	return value?.kind === "exact" || value?.kind === "absent";
}

function foreignRemote(path: string, entity: FileEntity): ForeignRemote {
	return { path, entity, identityKey: entity.identityKey! };
}

function versionRelation(entity: FileEntity, baseline: SyncRecord): VersionRelation {
	return hasRemoteChanged(entity, baseline) ? "changed" : "unchanged";
}

function contentRelation(left: FileEntity, right: FileEntity): ContentRelation {
	if (sameContent(left, right)) return "same";
	const leftKey = contentKey(left);
	const rightKey = contentKey(right);
	return leftKey && rightKey && leftKey.algo === rightKey.algo ? "different" : "unproven";
}
