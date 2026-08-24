import type { IFileSystem } from "../fs/interface";
import type { FileEntity } from "../fs/types";
import type { IdentityEvidence, MixedEntity, PathObservation, SyncRecord } from "./types";
import type { SyncStateStore } from "./state";
import type { TrackerSnapshot } from "./local-tracker";
import { hasChanged, hasRemoteChanged } from "./change-compare";
import { enrichHashesForInitialMatch, enrichHashesForRenames } from "./change-hash-enrichment";
import { collectLocalRenameEvidence, completeIdentityEvidence, renameOptimizerView } from "./identity-evidence";
import {
	getRemoteChanges,
	hasFolderRename,
	remoteSnapshotAfterDelta,
	type RemoteChanges,
} from "./remote-change-source";
import {
	confirmEntryAbsences,
	confirmCarriedRenameOppositeEndpoints,
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
	 * Force a COLD full join regardless of tracker/store state. Used for crash
	 * recovery: after an interrupted or partial sync the delta-based hot/warm
	 * path can't rediscover remote files that were reported but never baselined
	 * (the cursor has moved past them). A full remote list vs records can.
	 */
	forceFullScan?: boolean;
	/** Durable local rename evidence replayed before endpoint confirmation/hash enrichment. */
	carriedIdentityEvidence?: readonly IdentityEvidence[];
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
	changeSet.identityEvidence.unshift(...(opts.carriedIdentityEvidence ?? []),
		...collectLocalRenameEvidence(changes));
	ensureRenameEndpointObservations(changeSet.observations, changeSet.identityEvidence);
	await confirmUnknownRenameEndpoints(changeSet, deps.localFs, deps.remoteFs);
	await confirmCarriedRenameOppositeEndpoints(
		changeSet.observations,
		opts.carriedIdentityEvidence ?? [],
		deps.localFs,
		deps.remoteFs,
	);

	// WARM/COLD listings can under-report. Confirm every baseline path whose current
	// side is missing before planning; a thrown stat aborts rather than becoming absence.
	if (changeSet.temperature !== "hot") {
		await confirmEntryAbsences(changeSet, deps.localFs, deps.remoteFs);
	}
	// Hash enrichment operates only on exact entries and cannot upgrade observations.
	await enrichHashesForInitialMatch(changeSet.entries, deps.localFs);
	const renameView = renameOptimizerView(changeSet.identityEvidence);
	await enrichHashesForRenames(
		changeSet.entries, changeSet.observations, deps.localFs,
		renameView.localFiles, renameView.localFolders,
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
	const renameSourcePaths = new Set(changes.renamePairs.values());
	const observations: PathObservation[] = [];

	const entries: MixedEntity[] = pathArray.map((path, i) => {
		const localStat = localStats[i] ?? undefined;
		// A case-insensitive filesystem can resolve a recorded rename source to
		// the destination file. The tracker is authoritative for the logical
		// rename: only accept the source as still present when stat() returns that
		// exact path (for example, the user recreated the source before syncing).
		const isRenameSourceAlias =
			renameSourcePaths.has(path) &&
			localStat?.path !== path;
		const localObservation = observePath(
			"local",
			path,
			isRenameSourceAlias ? undefined : localStat,
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

	// Keep only entries that actually changed vs baseline (prune no-ops). This also
	// subsumes the "has any side" existence check: an entry with neither local nor
	// remote nor a prevSync can't have changed, so the predicate's branches drop it
	// (the first branch returns `!!prev` === false for the all-absent case).
	const changed = entries.filter((e) => {
		const prev = e.prevSync;
		// Both deleted — include if previously synced (cleanup)
		if (!e.local && !e.remote) return !!prev;
		// New file: no prev record
		if (!prev) return true;
		// Local deleted but remote still exists (e.g. rename source)
		if (!e.local && e.remote) return true;
		// A checkpoint tombstone is authoritative remote absence. Preserve it even
		// when the surviving local file is unchanged so the decision engine can
		// propagate the deletion. Do not infer this from remote stat() absence alone:
		// locally dirty paths also pass through HOT without a remote change signal.
		if (e.local && !e.remote && remoteChanges.deletedPaths.has(e.path)) return true;
		// Local changed
		if (e.local && hasChanged(e.local, prev)) return true;
		// Remote changed
		if (e.remote && hasRemoteChanged(e.remote, prev)) return true;
		return false;
	});

	return { entries: changed, observations, identityEvidence: remoteChanges.renameEvidence, temperature: "hot" };
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
