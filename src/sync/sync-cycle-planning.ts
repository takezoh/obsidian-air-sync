import type { Logger } from "../logging/logger";
import type { ChangeSet } from "./change-detector";
import type { AdmissionResult } from "./plan-admission";
import { mergeRenameDebtEvidence, renameDebtEvidence } from "./rename-debt";
import { renameEvidenceKey } from "./identity-evidence";
import { projectScope, type ScopeProjectionPolicy } from "./scope-projection";
import type { RenameDebt } from "./state";
import type {
	IdentityEvidence,
	LocalRenameEvidence,
	MixedEntity,
	PathObservation,
	ScopeProjection,
} from "./types";

export type CycleEvidenceItem =
	| { readonly role: "local_rename_candidate"; readonly evidence: LocalRenameEvidence }
	| { readonly role: "identity"; readonly evidence: IdentityEvidence };

export type DeepReadonly<T> =
	T extends (...args: never[]) => unknown ? T
		: T extends ArrayBuffer ? T
			: T extends ReadonlyMap<infer K, infer V>
				? ReadonlyMap<DeepReadonly<K>, DeepReadonly<V>>
				: T extends ReadonlySet<infer V> ? ReadonlySet<DeepReadonly<V>>
					: T extends readonly (infer V)[] ? readonly DeepReadonly<V>[]
						: T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
							: T;

/** Observation's runtime-immutable, fact-only handoff to Admission. */
export interface BatchObservation {
	readonly entries: DeepReadonly<readonly MixedEntity[]>;
	readonly evidence: DeepReadonly<readonly CycleEvidenceItem[]>;
	readonly replayedLocalRenameKeys: ReadonlySet<string>;
	readonly baselinePaths: ReadonlySet<string>;
	readonly observations: DeepReadonly<readonly PathObservation[]>;
	readonly scope: DeepReadonly<ScopeProjection>;
	readonly namespace: string;
}

/** Capture observed facts without constructing or authorizing actions. */
export function captureBatchObservation(
	entries: readonly MixedEntity[],
	identityEvidence: readonly IdentityEvidence[],
	observations: readonly PathObservation[],
	scope: ScopeProjection,
	namespace: string,
	baselinePaths: readonly string[] = entries.flatMap((entry) =>
		entry.prevSync ? [entry.path] : []),
	replayedLocalRenameKeys: readonly string[] = [],
): BatchObservation {
	const evidence = identityEvidence.map((item): CycleEvidenceItem =>
		isLocalRenameEvidence(item)
			? { role: "local_rename_candidate", evidence: item }
			: { role: "identity", evidence: item });
	return immutableSnapshot({
		entries: [...entries],
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

export function immutableSnapshot<T>(value: T): T {
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
	visiblePaths?: ReadonlySet<string>,
): void {
	const entries = visiblePaths
		? changeSet.entries.filter((entry) => visiblePaths.has(entry.path))
		: changeSet.entries;
	const remoteOnlyPaths = entries.filter((entry) => !entry.local && entry.remote)
		.map((entry) => entry.path);
	logger?.info("Change detection completed", {
		temperature: changeSet.temperature,
		entries: entries.length,
		localOnly: entries.filter((entry) => entry.local && !entry.remote).length,
		remoteOnly: remoteOnlyPaths.length,
		both: entries.filter((entry) => entry.local && entry.remote).length,
		enriched: entries.filter((entry) => entry.local?.hash && !entry.prevSync).length,
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

/** Pure batch observation plus structured diagnostics; no action construction or I/O. */
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
	const admittedObservations = completeChangeSet.observations.filter((observation) => {
		if (scopeProjection.byEndpoint.has(observation.requestedPath)) return true;
		if (observation.kind === "alias") {
			return scopeProjection.byEndpoint.has(observation.resolvedPath);
		}
		return observation.kind === "present_unresolved" &&
			scopeProjection.byEndpoint.has(observation.returnedPath);
	});
	if (filtered.length !== completeChangeSet.entries.length) {
		logger?.debug("Files filtered", {
			total: completeChangeSet.entries.length,
			afterFilter: filtered.length,
			excluded: completeChangeSet.entries.length - filtered.length,
		});
	}
	const snapshot = captureBatchObservation(
		filtered,
		completeChangeSet.identityEvidence,
		admittedObservations,
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
	for (const component of admission.failures) {
		logger?.warn("Sync plan component failed Admission", {
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

function localRenameCandidates(evidence: AdmissionResult["snapshot"]): readonly LocalRenameEvidence[] {
	return evidence.evidence.flatMap((item) =>
		item.role === "local_rename_candidate" ? [item.evidence] : []);
}
