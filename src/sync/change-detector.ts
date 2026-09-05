import type { IFileSystem } from "../fs/interface";
import type { FileEntity } from "../fs/types";
import type { IdentityEvidence, MixedEntity, PathObservation, SyncRecord } from "./types";
import type { SyncStateStore } from "./state";
import type { TrackerSnapshot } from "./local-tracker";
import { hasChanged } from "./change-compare";
import {
	enrichHashesForInitialMatch,
	enrichHashesForLocalCaseAliases,
	enrichHashesForRenames,
	type HashEnrichmentResult,
} from "./change-hash-enrichment";
import { collectLocalRenameEvidence, completeIdentityEvidence } from "./identity-evidence";
import {
	getRemoteChanges,
	hasFolderRename,
	remoteSnapshotAfterDelta,
	type RemoteChanges,
} from "./remote-change-source";
import {
	confirmEntryAbsences,
	confirmCaseAliasParentEndpoints,
	confirmRenameOppositeEndpoints,
	confirmUnknownRenameEndpoints,
	ensureRenameEndpointObservations,
	exactEntity,
	observePath,
} from "./path-observation";

export interface ChangeSet {
	entries: MixedEntity[];
	observations: PathObservation[];
	identityEvidence: IdentityEvidence[];
	temperature: "hot" | "warm" | "cold";
	/** Acquisition diagnostics; production collection always supplies this after enrichment. */
	hashEnrichment?: HashEnrichmentResult;
}

export interface ChangeDetectorDeps {
	localFs: IFileSystem;
	remoteFs: IFileSystem;
	stateStore: SyncStateStore;
	changes: TrackerSnapshot;
	onRemoteIdentityEvidence?: (evidence: readonly IdentityEvidence[]) => void;
}

export interface CollectChangesOptions {
	/**
	 * Force a COLD full join regardless of tracker/store state. This is selected
	 * from durable facts such as a missing checkpoint or changed scope, never from
	 * a prior failure or persisted recovery instruction.
	 */
	forceFullScan?: boolean;
}

/**
 * Collect changes using the appropriate temperature mode.
 *
 * hot  (O(delta)): tracker initialized + dirty paths → stat() + cache + getMany()
 * warm (O(n) local + O(delta) remote): list() + getAll() diff + remote delta
 * cold (O(n)): both list() + full join (equivalent to buildMixedEntities)
 *
 * `forceFullScan` overrides the hot/warm choice and always runs COLD.
 */
export async function collectChanges(
	deps: ChangeDetectorDeps,
	opts: CollectChangesOptions = {},
): Promise<ChangeSet> {
	const { changes, stateStore } = deps;

	let changeSet: ChangeSet;
	// Determine temperature
	if (!opts.forceFullScan && changes.initialized && changes.dirtyPaths.size > 0 &&
		changes.folderRenamePairs.size === 0) {
		const remoteChanges = await getRemoteChanges(deps.remoteFs, deps.onRemoteIdentityEvidence);
		if (hasFolderRename(remoteChanges)) {
			changeSet = await collectCold(
				deps,
				await stateStore.getAll(),
				remoteChanges,
				undefined,
				await remoteSnapshotAfterDelta(deps.remoteFs),
			);
		} else {
			changeSet = await collectHot(deps, remoteChanges);
		}
	} else {
		const allRecords = await stateStore.getAll();
		changeSet = opts.forceFullScan || allRecords.length === 0
			? await collectCold(deps, allRecords)
			: await collectWarm(deps, allRecords);
	}
	changeSet.identityEvidence.unshift(...collectLocalRenameEvidence(changes));
	ensureRenameEndpointObservations(changeSet.observations, changeSet.identityEvidence);
	await confirmUnknownRenameEndpoints(changeSet, deps.localFs, deps.remoteFs);
	await confirmRenameOppositeEndpoints(
		changeSet.observations,
		changeSet.identityEvidence,
		deps.localFs,
		deps.remoteFs,
	);

	// WARM/COLD listings can under-report. Confirm every baseline path whose current
	// side is missing before planning; a thrown stat aborts rather than becoming absence.
	if (changeSet.temperature !== "hot") {
		await confirmEntryAbsences(changeSet, deps.localFs, deps.remoteFs);
	}
	await confirmCaseAliasParentEndpoints(
		changeSet.observations, deps.localFs, deps.remoteFs,
	);
	await enrichHashesForLocalCaseAliases(
		changeSet.entries, changeSet.observations, changeSet.identityEvidence,
		deps.localFs, deps.remoteFs,
	);
	// Hash enrichment operates only on exact entries and cannot upgrade observations.
	changeSet.hashEnrichment = await enrichHashesForInitialMatch(changeSet.entries, deps.localFs);
	await enrichHashesForRenames(
		changeSet.entries, changeSet.observations, deps.localFs, deps.remoteFs, changeSet.identityEvidence,
	);
	changeSet.identityEvidence = completeIdentityEvidence(
		changeSet.identityEvidence,
		changeSet.observations,
		changeSet.entries,
	);

	return changeSet;
}

async function collectHot(
	deps: ChangeDetectorDeps,
	remoteChanges: RemoteChanges,
): Promise<ChangeSet> {
	const { localFs, remoteFs, stateStore, changes } = deps;

	const dirtyPaths = changes.dirtyPaths;

	// Union of local dirty and remote changed paths
	const changedPaths = new Set<string>(dirtyPaths);
	for (const p of remoteChanges.paths) {
		changedPaths.add(p);
	}

	const pathArray = Array.from(changedPaths);

	// Fetch local stats, remote stats, and sync records in parallel
	const [localStats, remoteStats, syncRecords] = await Promise.all([
		Promise.all(pathArray.map((p) => localFs.stat(p))),
		Promise.all(pathArray.map((p) => remoteFs.stat(p))),
		stateStore.getMany(pathArray),
	]);
	const observations: PathObservation[] = [];

	const entries: MixedEntity[] = pathArray.map((path, i) => {
		const localStat = localStats[i] ?? undefined;
		const localObservation = observePath(
			"local",
			path,
			localStat,
		);
		const remoteObservation = observePath(
			"remote", path, remoteStats[i],
			remoteChanges.deletedPaths.has(path) ? "checkpoint_deleted" : "stat",
		);
		observations.push(localObservation, remoteObservation);
		const prevSync = syncRecords.get(path);
		return {
			path,
			local: exactEntity(localObservation),
			remote: exactEntity(remoteObservation),
			prevSync,
		};
	});

	// Acquisition retains all facts it obtained. Admission owns no-change and
	// deletion decisions, including whether stat absence has deletion authority.
	return { entries, observations, identityEvidence: remoteChanges.renameEvidence, temperature: "hot" };
}

async function collectWarm(deps: ChangeDetectorDeps, allRecords: SyncRecord[]): Promise<ChangeSet> {
	const { localFs, remoteFs } = deps;

	const [localFiles, remoteChanges] = await Promise.all([
		localFs.list(),
		getRemoteChanges(remoteFs, deps.onRemoteIdentityEvidence),
	]);
	if (hasFolderRename(remoteChanges)) {
		return collectCold(
			deps,
			allRecords,
			remoteChanges,
			localFiles,
			await remoteSnapshotAfterDelta(remoteFs),
		);
	}

	const recordMap = new Map(allRecords.map((r) => [r.path, r]));
	const changedPaths = new Set<string>();

	// Compare local listing against sync records
	for (const file of localFiles) {
		if (file.isDirectory) continue;
		const record = recordMap.get(file.path);
		if (!record || hasChanged(file, record)) {
			changedPaths.add(file.path);
		}
	}

	// Include paths that existed in records but are no longer in local listing (local deletions)
	const localPathSet = new Set(localFiles.filter((f) => !f.isDirectory).map((f) => f.path));
	for (const record of allRecords) {
		if (!localPathSet.has(record.path)) {
			changedPaths.add(record.path);
		}
	}

	// Add remote changed paths
	for (const p of remoteChanges.paths) {
		changedPaths.add(p);
	}

	// Include rename pair paths so warm mode can optimize renames
	const renamePairs = deps.changes.renamePairs;
	for (const [newPath, oldPath] of renamePairs) {
		changedPaths.add(newPath);
		changedPaths.add(oldPath);
	}

	const pathArray = Array.from(changedPaths);
	const remoteStats = await Promise.all(pathArray.map((p) => remoteFs.stat(p)));

	const observations: PathObservation[] = localFiles.map((file) =>
		observePath("local", file.path, file, "stat", "list"));
	const localFileMap = new Map(observations.flatMap((observation) => {
		const entity = exactEntity(observation);
		return entity ? [[entity.path, entity] as const] : [];
	}));

	const entries: MixedEntity[] = pathArray.map((path, i) => {
		const remoteObservation = observePath(
			"remote", path, remoteStats[i],
			remoteChanges.deletedPaths.has(path) ? "checkpoint_deleted" : "stat",
		);
		observations.push(remoteObservation);
		if (!observations.some((observation) =>
			observation.side === "local" && observation.requestedPath === path)) {
			observations.push({ kind: "unknown", side: "local", requestedPath: path, reason: "not_observed" });
		}
		return {
			path,
			local: localFileMap.get(path),
			remote: exactEntity(remoteObservation),
			prevSync: recordMap.get(path),
		};
	});

	return { entries, observations, identityEvidence: remoteChanges.renameEvidence, temperature: "warm" };
}

async function collectCold(
	deps: ChangeDetectorDeps,
	allRecords: SyncRecord[],
	remoteChanges?: RemoteChanges,
	prefetchedLocalFiles?: FileEntity[],
	prefetchedRemoteFiles?: FileEntity[],
): Promise<ChangeSet> {
	const { localFs, remoteFs } = deps;

	const [localFiles, remoteFiles] = await Promise.all([
		prefetchedLocalFiles ?? localFs.list(),
		prefetchedRemoteFiles ?? remoteFs.list(),
	]);
	const syncRecords = allRecords;

	const pathMap = new Map<string, MixedEntity>();
	const observations: PathObservation[] = [];

	const getOrCreate = (path: string): MixedEntity => {
		let entity = pathMap.get(path);
		if (!entity) {
			entity = { path };
			pathMap.set(path, entity);
		}
		return entity;
	};

	for (const file of localFiles) {
		const observation = observePath("local", file.path, file, "stat", "list");
		observations.push(observation);
		const entity = exactEntity(observation);
		if (entity) getOrCreate(entity.path).local = entity;
	}

	for (const file of remoteFiles) {
		const observation = observePath("remote", file.path, file, "stat", "list");
		observations.push(observation);
		const entity = exactEntity(observation);
		if (entity) getOrCreate(entity.path).remote = entity;
	}

	for (const record of syncRecords) {
		getOrCreate(record.path).prevSync = record;
	}

	return {
		entries: Array.from(pathMap.values()),
		observations,
		identityEvidence: remoteChanges?.renameEvidence ?? [],
		temperature: "cold",
	};
}
