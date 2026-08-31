import type { Logger } from "../logging/logger";
import type { ChangeSet } from "./change-detector";
import { planSync } from "./decision-engine";
import type { AdmissionResult } from "./plan-admission";
import { captureCycleAdmissionSnapshot } from "./plan-admission";
import { mergeRenameDebtEvidence, renameDebtEvidence } from "./rename-debt";
import { renameEvidenceKey } from "./identity-evidence";
import { projectScope, type ScopeProjectionPolicy } from "./scope-projection";
import type { RenameDebt } from "./state";

export function logChangeDetection(
	changeSet: ChangeSet,
	renamePairs: ReadonlyMap<string, string>,
	logger?: Logger,
): void {
	const remoteOnlyPaths = changeSet.entries.filter((entry) => !entry.local && entry.remote)
		.map((entry) => entry.path);
	logger?.info("Change detection completed", {
		temperature: changeSet.temperature,
		entries: changeSet.entries.length,
		localOnly: changeSet.entries.filter((entry) => entry.local && !entry.remote).length,
		remoteOnly: remoteOnlyPaths.length,
		both: changeSet.entries.filter((entry) => entry.local && entry.remote).length,
		enriched: changeSet.entries.filter((entry) => entry.local?.hash && !entry.prevSync).length,
		hashEnrichmentCandidates: changeSet.hashEnrichment?.candidates ?? 0,
		hashEnrichmentMatches: changeSet.hashEnrichment?.matches ?? 0,
		renamePairs: renamePairs.size,
	});
	if (remoteOnlyPaths.length > 0) logger?.debug("Remote-only paths", { paths: remoteOnlyPaths });
	if (renamePairs.size === 0) return;

	const paths = new Set([...renamePairs.keys(), ...renamePairs.values()]);
	logger?.debug("Rename entry details", {
		entries: changeSet.entries.filter((entry) => paths.has(entry.path)).map((entry) => ({
			path: entry.path,
			local: !!entry.local,
			remote: !!entry.remote,
			prevSync: !!entry.prevSync,
			hash: (entry.local?.hash || entry.prevSync?.hash || "").substring(0, 8) || undefined,
		})),
	});
}

/** Pure cycle planning plus structured diagnostics; no state or filesystem writes. */
export function prepareSyncCycleSnapshot(
	changeSet: ChangeSet,
	persistedDebts: readonly RenameDebt[],
	namespace: string,
	policy: ScopeProjectionPolicy,
	logger?: Logger,
) {
	const completeChangeSet: ChangeSet = {
		...changeSet,
		identityEvidence: mergeRenameDebtEvidence(changeSet.identityEvidence, persistedDebts),
	};
	const scopeProjection = projectScope(completeChangeSet, policy);
	const filtered = completeChangeSet.entries.filter((entry) =>
		scopeProjection.byEndpoint.get(entry.path) === "included");
	if (filtered.length !== completeChangeSet.entries.length) {
		logger?.debug("Files filtered", {
			total: completeChangeSet.entries.length,
			afterFilter: filtered.length,
			excluded: completeChangeSet.entries.length - filtered.length,
		});
	}
	const plan = planSync(filtered);
	const snapshot = captureCycleAdmissionSnapshot(
		plan,
		completeChangeSet.identityEvidence,
		completeChangeSet.observations,
		scopeProjection,
		namespace,
		completeChangeSet.entries.flatMap((entry) => entry.prevSync ? [entry.path] : []),
		persistedDebts.map((debt) => renameEvidenceKey(renameDebtEvidence(debt))),
	);
	return { snapshot };
}

export function logSyncCyclePlan(
	logger: Logger | undefined,
	admission: AdmissionResult,
): void {
	const actionBreakdown: Record<string, number> = {};
	for (const { action } of admission.executable.actions) {
		actionBreakdown[action] = (actionBreakdown[action] ?? 0) + 1;
	}
	logger?.info("Sync plan created", {
		total: admission.executable.actions.length,
		proposed: admission.snapshot.plan.actions.length,
		localRenameCandidates: admission.snapshot.localRenameCandidates.length,
		freshLocalRenameCandidates: admission.snapshot.localRenameCandidates.filter((candidate) =>
			!admission.snapshot.replayedLocalRenameKeys.has(renameEvidenceKey(candidate))).length,
		replayedLocalRenameCandidates: admission.snapshot.replayedLocalRenameKeys.size,
		persistedLocalRenameConstraints: admission.localRenameLifecycle.persistBeforeExecution.length,
		nonBindingLocalRenameCandidates: admission.snapshot.localRenameCandidates.length -
			admission.localRenameLifecycle.persistBeforeExecution.length,
		releasableLocalRenameCandidates: admission.localRenameLifecycle.releaseAfterSafeCheckpoint.length,
		...actionBreakdown,
	});
	for (const component of admission.deferred) {
		logger?.warn("Sync plan component deferred", {
			reasons: component.reasons,
			paths: component.paths,
			evidence: component.evidence.map((item) => ({
				kind: item.kind,
				side: item.side,
				authority: item.kind === "rename" ? item.authority : undefined,
			})),
			scope: component.paths.map((path) => ({
				path,
				disposition: admission.snapshot.scope.byEndpoint.get(path) ?? "unknown",
			})),
		});
	}
}
