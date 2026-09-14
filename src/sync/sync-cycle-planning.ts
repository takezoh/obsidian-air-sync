import type { Logger } from "../logging/logger";
import type { IFileSystem } from "../fs/interface";
import type { ChangeSet } from "./change-detector";
import type { AdmissionResult } from "./plan-admission";
import { applyScope, type ScopeProjectionPolicy } from "./scope-projection";
import type {
	IdentityEvidence,
	LocalRenameEvidence,
	MixedEntity,
	PathObservation,
	CandidateFact,
	ConflictStrategy,
	ScopeProjection,
} from "./types";
import { enrichHashesForPreferLocal } from "./change-hash-enrichment";

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
	readonly baselinePaths: ReadonlySet<string>;
	readonly observations: DeepReadonly<readonly PathObservation[]>;
	readonly candidateFacts: DeepReadonly<readonly CandidateFact[]>;
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
		entry.prevSync ? [entry.prevSync.path] : []),
	candidateFacts: readonly CandidateFact[] = [],
): BatchObservation {
	const evidence = identityEvidence.map((item): CycleEvidenceItem =>
		isLocalRenameEvidence(item)
			? { role: "local_rename_candidate", evidence: item }
			: { role: "identity", evidence: item });
	return immutableSnapshot({
		entries: [...entries],
		evidence,
		baselinePaths: new Set(baselinePaths),
		observations: [...observations],
		candidateFacts: [...candidateFacts],
		scope: {
			byEndpoint: new Map(scope.byEndpoint),
			isConfiguredScopeCompatible: scope.isConfiguredScopeCompatible,
		},
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
	namespace: string,
	policy: ScopeProjectionPolicy,
	logger?: Logger,
) {
	const { scopedChangeSet, projection, baselinePaths } = scopeSyncCycle(changeSet, policy, logger);
	return captureScopedSnapshot(scopedChangeSet, projection, namespace, baselinePaths);
}

/** Production preparation: scope first, then acquire Prefer-local-only content facts. */
export async function prepareSyncCycleSnapshotForExecution(
	changeSet: ChangeSet,
	namespace: string,
	policy: ScopeProjectionPolicy,
	strategy: ConflictStrategy,
	localFs: IFileSystem,
	remoteFs: IFileSystem,
	logger?: Logger,
) {
	const { scopedChangeSet, projection, baselinePaths } = scopeSyncCycle(changeSet, policy, logger);
	if (requiresConflictHashEnrichment(strategy)) {
		await enrichHashesForPreferLocal(
			scopedChangeSet.entries, scopedChangeSet.observations,
			scopedChangeSet.identityEvidence, localFs, remoteFs,
		);
	}
	return captureScopedSnapshot(scopedChangeSet, projection, namespace, baselinePaths);
}

/** Observation-local acquisition policy; it never authorizes a sync action. */
function requiresConflictHashEnrichment(strategy: ConflictStrategy): boolean {
	return strategy === "prefer_local";
}

function scopeSyncCycle(
	changeSet: ChangeSet,
	policy: ScopeProjectionPolicy,
	logger?: Logger,
): { scopedChangeSet: ChangeSet; projection: ScopeProjection; baselinePaths: string[] } {
	const { changeSet: scopedChangeSet, projection } = applyScope(changeSet, policy);
	const baselinePaths = scopedChangeSet.entries.flatMap((entry) =>
		entry.prevSync ? [entry.prevSync.path] : []);
	const admittedEntries = scopedChangeSet.entries.filter((entry) =>
		projection.byEndpoint.get(entry.path) === "included");
	if (admittedEntries.length !== changeSet.entries.length) {
		logger?.debug("Files filtered", {
			total: changeSet.entries.length,
			afterFilter: admittedEntries.length,
			excluded: changeSet.entries.length - admittedEntries.length,
		});
		// Two independent gates can drop a raw entry: applyScope's own
		// ignore-pattern/dot-path/wholly-ignored-directory check (the entry never
		// makes it into scopedChangeSet.entries at all), and the byEndpoint
		// disposition check just above (the entry survives applyScope but its
		// scope disposition resolves to "unknown" or "mobile_deferred" rather than
		// "included"). Logging each dropped path with which of the two happened --
		// and, for the second case, the actual disposition -- turns "why isn't
		// this syncing" from count arithmetic into a direct answer.
		const admittedPaths = new Set(admittedEntries.map((entry) => entry.path));
		const scopedPaths = new Set(scopedChangeSet.entries.map((entry) => entry.path));
		const droppedPaths = changeSet.entries
			.filter((entry) => !admittedPaths.has(entry.path))
			.map((entry) => ({
				path: entry.path,
				reason: scopedPaths.has(entry.path)
					? `disposition:${projection.byEndpoint.get(entry.path) ?? "unknown"}`
					: "excluded_from_scope",
			}));
		logger?.debug("Excluded paths", { paths: droppedPaths.slice(0, 25) });
	}
	scopedChangeSet.entries = admittedEntries;
	return { scopedChangeSet, projection, baselinePaths };
}

function captureScopedSnapshot(
	scopedChangeSet: ChangeSet,
	projection: ScopeProjection,
	namespace: string,
	baselinePaths: readonly string[],
) {
	const snapshot = captureBatchObservation(
		scopedChangeSet.entries,
		scopedChangeSet.identityEvidence,
		scopedChangeSet.observations,
		projection,
		namespace,
		baselinePaths,
		scopedChangeSet.candidateFacts,
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
		localRenameCandidates: renameCandidates.length,
		freshLocalRenameCandidates: renameCandidates.length,
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
