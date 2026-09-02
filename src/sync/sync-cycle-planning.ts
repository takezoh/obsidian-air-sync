import type { Logger } from "../logging/logger";
import type { ChangeSet } from "./change-detector";
import { planSync } from "./decision-engine";
import type { AdmissionResult } from "./plan-admission";
import { mergeRenameDebtEvidence, renameDebtEvidence } from "./rename-debt";
import { renameEvidenceKey } from "./identity-evidence";
import { projectScope, type ScopeProjectionPolicy } from "./scope-projection";
import type { RenameDebt } from "./state";
import type {
	IdentityEvidence,
	LocalRenameEvidence,
	PathObservation,
	ScopeProjection,
	SyncAction,
	SyncPlan,
} from "./types";

export type CycleEvidenceItem =
	| { readonly role: "local_rename_candidate"; readonly evidence: LocalRenameEvidence }
	| { readonly role: "identity"; readonly evidence: IdentityEvidence };

/** Planning's single, runtime-immutable handoff to Admission. */
export interface CycleEvidence {
	readonly plan: { readonly actions: readonly SyncAction[] };
	readonly evidence: readonly CycleEvidenceItem[];
	readonly replayedLocalRenameKeys: ReadonlySet<string>;
	readonly baselinePaths: ReadonlySet<string>;
	readonly observations: readonly PathObservation[];
	readonly scope: ScopeProjection;
	readonly namespace: string;
}

/** Capture and classify each evidence item once at the planning boundary. */
export function captureCycleAdmissionSnapshot(
	plan: SyncPlan,
	identityEvidence: readonly IdentityEvidence[],
	observations: readonly PathObservation[],
	scope: ScopeProjection,
	namespace: string,
	baselinePaths: readonly string[] = plan.actions.flatMap((action) =>
		action.baseline ? [action.baseline.path] : []),
	replayedLocalRenameKeys: readonly string[] = [],
): CycleEvidence {
	const evidence = identityEvidence.map((item): CycleEvidenceItem =>
		isLocalRenameEvidence(item)
			? { role: "local_rename_candidate", evidence: item }
			: { role: "identity", evidence: item });
	return immutableClone({
		plan: { actions: [...plan.actions] },
		evidence,
		replayedLocalRenameKeys: new Set(replayedLocalRenameKeys),
		baselinePaths: new Set(baselinePaths),
		observations: [...observations],
		scope: { byEndpoint: new Map(scope.byEndpoint) },
		namespace,
	});
}

function isLocalRenameEvidence(evidence: IdentityEvidence): evidence is LocalRenameEvidence {
	return evidence.kind === "rename" && evidence.side === "local";
}

function immutableClone<T>(value: T): T {
	return cloneValue(value, new WeakMap<object, unknown>()) as T;
}

function cloneValue(value: unknown, seen: WeakMap<object, unknown>): unknown {
	if (value === null || typeof value !== "object") return value;
	const prior = seen.get(value);
	if (prior) return prior;
	if (value instanceof ArrayBuffer) return value.slice(0);
	if (Array.isArray(value)) {
		const source: unknown[] = value;
		const copy: unknown[] = source.map((item) => cloneValue(item, seen));
		seen.set(value, copy);
		return Object.freeze(copy);
	}
	if (value instanceof Map) {
		const source: Map<unknown, unknown> = value;
		const entries = [...source].map(([key, item]) => [
			cloneValue(key, seen), cloneValue(item, seen),
		] as const);
		const copy = immutableMap(entries);
		seen.set(value, copy);
		return copy;
	}
	if (value instanceof Set) {
		const source: Set<unknown> = value;
		const copy = immutableSet([...source].map((item) => cloneValue(item, seen)));
		seen.set(value, copy);
		return copy;
	}
	const copy: Record<PropertyKey, unknown> = {};
	seen.set(value, copy);
	for (const key of Reflect.ownKeys(value)) {
		copy[key] = cloneValue((value as Record<PropertyKey, unknown>)[key], seen);
	}
	return Object.freeze(copy);
}

function immutableMap<K, V>(entries: readonly (readonly [K, V])[]): ReadonlyMap<K, V> {
	const target = new Map(entries);
	const view: ReadonlyMap<K, V> = {
		get size() { return target.size; },
		entries: () => target.entries(),
		forEach: (callback, thisArg) => target.forEach((item, key) =>
			callback.call(thisArg, item, key, view)),
		get: (key) => target.get(key),
		has: (key) => target.has(key),
		keys: () => target.keys(),
		values: () => target.values(),
		[Symbol.iterator]: () => target[Symbol.iterator](),
	};
	return Object.freeze(view);
}

function immutableSet<T>(values: readonly T[]): ReadonlySet<T> {
	const target = new Set(values);
	const view: ReadonlySet<T> = {
		get size() { return target.size; },
		entries: () => target.entries(),
		forEach: (callback, thisArg) => target.forEach((item) =>
			callback.call(thisArg, item, item, view)),
		has: (item) => target.has(item),
		keys: () => target.keys(),
		values: () => target.values(),
		[Symbol.iterator]: () => target[Symbol.iterator](),
	};
	return Object.freeze(view);
}

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
	const renameCandidates = localRenameCandidates(admission.snapshot);
	const actionBreakdown: Record<string, number> = {};
	for (const { action } of admission.executable.actions) {
		actionBreakdown[action] = (actionBreakdown[action] ?? 0) + 1;
	}
	logger?.info("Sync plan created", {
		total: admission.executable.actions.length,
		proposed: admission.snapshot.plan.actions.length,
		localRenameCandidates: renameCandidates.length,
		freshLocalRenameCandidates: renameCandidates.filter((candidate) =>
			!admission.snapshot.replayedLocalRenameKeys.has(renameEvidenceKey(candidate))).length,
		replayedLocalRenameCandidates: admission.snapshot.replayedLocalRenameKeys.size,
		persistedLocalRenameConstraints: admission.localRenameLifecycle.persistBeforeExecution.length,
		nonBindingLocalRenameCandidates: renameCandidates.length -
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

function localRenameCandidates(evidence: CycleEvidence): readonly LocalRenameEvidence[] {
	return evidence.evidence.flatMap((item) =>
		item.role === "local_rename_candidate" ? [item.evidence] : []);
}
